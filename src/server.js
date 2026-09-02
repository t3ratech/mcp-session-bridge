#!/usr/bin/env node
/**
 * T3rnel MCP Session Bridge
 *
 * A free MCP server that lets Claude Code/Desktop, Cursor, VS Code, Windsurf,
 * Antigravity, IntelliJ, Codex, Grok Build, Kimi Code/Desktop, JCode, Cline,
 * OpenCode, Continue.dev, KiloCode, Roo Code, Aider, OpenClaw, Hermes, OpenFang
 * and any MCP client drive the user's real authenticated browser session. Unlike
 * cloud browser APIs, it uses the browser the user is already logged into, so it
 * can read account pages, intranets, and authenticated dashboards without ever
 * shipping session cookies off the user's machine.
 *
 * Transport: MCP client -> stdio (newline-delimited JSON-RPC) -> this server ->
 * local relay socket -> native host (spawned by Chrome) -> the T3rnel Browser
 * extension, which executes the tool against the live session.
 *
 * Usage:
 *   1. Install the T3rnel Browser extension:
 *        https://t3ratech.github.io/t3rnel-browser-plugin/
 *   2. npm install -g @t3ratech/mcp-session-bridge
 *   3. mcp-session-bridge --install   (registers the native messaging host)
 *   4. Add to your MCP client config:
 *        { "mcpServers": { "t3rnel-session": {
 *            "command": "mcp-session-bridge",
 *            "env": { "T3RNEL_SESSION_MODE": "auto" }
 *        } } }
 */

import { createInterface } from "node:readline";
import net from "node:net";
import { createFrameDecoder, encodeFrame } from "./framing.js";
import { SESSION_TOOLS, SUPPORTED_MCP_CLIENTS, findTool, toWireTool, validateArguments } from "./tools.js";
import { resolveSocketPath } from "./relay.js";
import { defaultHostPath, installHosts, uninstallHosts, printInstallSummary } from "./install.js";
import { StandaloneBrowser, executeStandaloneTool } from "./cdp.js";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "t3rnel-session";
const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json");

const BROWSER_PRODUCT_URL =
  "https://t3ratech.github.io/t3rnel-browser-plugin/";
const BROWSER_HELP_URL = "https://t3ratech.github.io/t3rnel-browser-plugin/";

class McpError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * The MCP result shape, not a bare object.
 *
 * `tools/call` results are `{ content: [...] }` — that is what the extension path
 * returns through the relay and what the standalone path builds in `cdp.js`. This tool
 * answered with a plain object, so a spec-compliant client had nothing to render and the
 * one tool whose whole job is to explain the install showed the user nothing.
 */
function asToolResult(value) {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function installInstructions() {
  return {
    canInstall: true,
    message:
      "The T3rnel Browser extension is not installed or not connected. " +
      "You can install it now, or use the free standalone mode instead.",
    steps: [
      "Install the T3rnel Browser extension from the product site: " + BROWSER_PRODUCT_URL,
      "npm install -g @t3ratech/mcp-session-bridge",
      "mcp-session-bridge --install",
      "Restart your browser and start this MCP server again.",
    ],
    freeStandaloneOption: {
      how: "Set T3RNEL_SESSION_MODE=standalone",
      note:
        "Launches a dedicated automation browser. It cannot see your everyday logged-in tabs, " +
        "but needs no extension and no license.",
    },
    clients: SUPPORTED_MCP_CLIENTS,
    storeUrl: BROWSER_PRODUCT_URL,
    helpUrl: BROWSER_HELP_URL,
  };
}

const EXTENSION_NOT_INSTALLED =
  "T3rnel Browser is not installed or not connected. Install the extension from " +
  BROWSER_PRODUCT_URL +
  ", run `mcp-session-bridge --install`, then restart your browser. " +
  "You can also call the `session_install` tool for setup instructions, " +
  "or set T3RNEL_SESSION_MODE=standalone to launch a free dedicated browser.";

const EXTENSION_DISCONNECTED =
  "T3rnel Browser is installed but is not currently connected to the MCP Session Bridge. " +
  "Open the T3rnel Browser extension and reconnect the MCP session, then retry. " +
  "Documentation: " + BROWSER_HELP_URL;

export function parseTimeoutMs(env = process.env, defaultMs = 30000) {
  const raw = env.T3RNEL_SESSION_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === "") {
    return defaultMs;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`T3RNEL_SESSION_TIMEOUT_MS must be a positive integer, received ${JSON.stringify(raw)}`);
  }
  return value;
}

class RelayClient {
  constructor(socketPath, { log = (line) => process.stderr.write(`${line}\n`), timeoutMs = 30000 } = {}) {
    this.socketPath = socketPath;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.connected = false;
    this.pending = new Map();
    this.nextId = 1;
    this.retryMs = 250;
    this.closed = false;
  }

  start() {
    this.connect();
  }

  connect() {
    if (this.closed) return;
    const socket = net.createConnection({ path: this.socketPath });
    const decoder = createFrameDecoder((message) => this.onFrame(message));
    socket.on("connect", () => {
      this.socket = socket;
      this.connected = true;
      this.retryMs = 250;
      this.log(`mcp-session-bridge: connected to relay at ${this.socketPath}`);
    });
    socket.on("data", (chunk) => {
      try {
        decoder.push(chunk);
      } catch (error) {
        this.log(`mcp-session-bridge: relay framing error: ${error.message}`);
        socket.destroy();
      }
    });
    socket.on("error", () => {
      // `close` follows every failed connection; all teardown lives there.
    });
    socket.on("close", () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.socket = null;
      this.onDisconnect?.();
      this.failPending(new Error(EXTENSION_DISCONNECTED));
      if (!this.closed) {
        if (wasConnected) this.log("mcp-session-bridge: relay connection lost; retrying");
        setTimeout(() => this.connect(), this.retryMs).unref();
        this.retryMs = Math.min(this.retryMs * 2, 5000);
      }
    });
  }

  onFrame(message) {
    if (message === null || typeof message !== "object" || message.id === undefined) return;
    const entry = this.pending.get(String(message.id));
    if (!entry) return;
    this.pending.delete(String(message.id));
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Tool execution failed"));
    } else {
      entry.resolve(message.result);
    }
  }

  call(payload, timeoutMs = this.timeoutMs) {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error(EXTENSION_DISCONNECTED));
    }
    const id = `s${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tool call timed out after ${timeoutMs}ms waiting for the browser session`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(encodeFrame({ ...payload, id }), (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`Failed to reach the browser session: ${error.message}`));
        }
      });
    });
  }

  failPending(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.closed = true;
    this.failPending(new Error("Server shutting down"));
    if (this.socket) this.socket.destroy();
  }

  isConnected() {
    return this.connected;
  }
}

export function startMcpServer({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  timeoutMs = parseTimeoutMs(process.env),
} = {}) {
  const relay = new RelayClient(resolveSocketPath(env), { timeoutMs });
  const standalone = new StandaloneBrowser({ headless: env.T3RNEL_SESSION_HEADLESS === "1" });
  const mode = (env.T3RNEL_SESSION_MODE ?? "auto").toLowerCase();
  let activeToolCalls = 0;
  let shuttingDown = false;
  /**
   * The extension owns the browser-tool registry. Keeping a hand-copied second
   * registry here made the bridge silently expose 19 tools while the product
   * promised 98. This cache is populated from the connected extension and invalidated
   * by a relay disconnect, so schemas and names cannot drift at release time.
   */
  let extensionSessionTools = null;
  relay.onDisconnect = () => { extensionSessionTools = null; };

  function maybeClose() {
    if (shuttingDown && activeToolCalls === 0) {
      relay.close();
      void standalone.close();
    }
  }

  function sendJsonRpc(response) {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }

  function sendError(id, message, code = -32000) {
    sendJsonRpc({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async function waitForRelay(timeoutMs = 1000) {
    if (!existsSync(relay.socketPath)) return;
    const start = Date.now();
    while (!relay.isConnected() && Date.now() - start < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  function asSessionTool(definition) {
    if (!definition || typeof definition.name !== "string" || !definition.name.startsWith("browser_")) return null;
    if (typeof definition.description !== "string" || !definition.inputSchema || typeof definition.inputSchema !== "object") return null;
    return {
      ...definition,
      name: `session_${definition.name.slice("browser_".length)}`,
    };
  }

  async function getExtensionSessionTools() {
    await waitForRelay();
    if (!relay.isConnected()) throw new McpError(-32000, EXTENSION_DISCONNECTED);
    const response = await relay.call({ jsonrpc: "2.0", method: "tools/list", params: {} });
    const browserTools = Array.isArray(response?.tools) ? response.tools : null;
    if (!browserTools) throw new McpError(-32000, "The connected extension returned an invalid tools/list response.");
    const tools = browserTools.map(asSessionTool).filter(Boolean);
    if (tools.length !== browserTools.length || tools.length === 0) {
      throw new McpError(-32000, "The connected extension returned an incomplete browser tool registry.");
    }
    extensionSessionTools = tools;
    return tools;
  }

  async function listedTools() {
    const bridgeOnly = [findTool("session_install")].filter(Boolean);
    let tools;
    if (mode === "extension") {
      tools = await getExtensionSessionTools();
    } else if (mode === "auto") {
      await waitForRelay(250);
      if (relay.isConnected()) tools = await getExtensionSessionTools();
    }
    if (!tools) return SESSION_TOOLS.map(toWireTool);
    const names = new Set(tools.map((t) => t.name));
    return [...tools, ...bridgeOnly.filter((t) => !names.has(t.name))].map(toWireTool);
  }

  async function resolveTool(name) {
    if (name === "session_login" || name === "session_store_login") return findTool(name);
    if (mode === "extension" || (mode === "auto" && relay.isConnected())) {
      const tools = extensionSessionTools ?? await getExtensionSessionTools();
      return tools.find((tool) => tool.name === name) ?? null;
    }
    return findTool(name);
  }

  function browserToolFor(name) {
    if (name === "session_login") return "browser_vault_load";
    if (name === "session_store_login") return "browser_vault_save";
    return name.startsWith("session_") ? `browser_${name.slice("session_".length)}` : null;
  }

  /**
   * What the last snapshot called each element, per tab.
   *
   * `session_snapshot` describes itself as returning "interactive elements with refs"
   * and every element carries one — `@e28` and so on. Nothing accepted them. An agent
   * following the obvious pattern, and the one every other browser MCP server uses —
   * snapshot the page, then act on a ref — got `Unknown argument: ref` on every single
   * action, with no hint that `selector` was the only thing that worked. A ref that
   * nothing consumes is worse than no ref: it is an invitation to a dead end.
   */
  const refsByTab = new Map();

  function rememberRefs(tabId, payload) {
    let parsed;
    try { parsed = typeof payload === "string" ? JSON.parse(payload) : payload; } catch { return; }
    const elements = parsed?.elements;
    if (!Array.isArray(elements)) return;
    const map = new Map();
    for (const element of elements) {
      if (typeof element?.ref === "string" && typeof element?.selector === "string") {
        map.set(element.ref, element.selector);
      }
    }
    if (map.size > 0) refsByTab.set(tabId ?? "active", map);
  }

  /**
   * Turns `ref` into the `selector` the snapshot recorded for it, so the tools keep one
   * addressing scheme on the wire while callers may use either.
   */
  function resolveRef(args) {
    if (typeof args?.ref !== "string") return args;
    const { ref, ...rest } = args;
    const map = refsByTab.get(rest.tabId ?? "active") ?? refsByTab.get("active");
    if (!map || map.size === 0) {
      throw new McpError(
        -32602,
        `No snapshot to resolve ${ref} against. Call session_snapshot first, then pass a ref it returned.`
      );
    }
    const selector = map.get(ref);
    if (!selector) {
      throw new McpError(
        -32602,
        `${ref} is not in the last snapshot of this tab. Snapshots are per page — take a new one after ` +
          "the page changes, and use a ref from it."
      );
    }
    // An explicit selector wins, so a caller passing both is not silently overridden.
    return { ...rest, selector: rest.selector ?? selector };
  }

  async function callTool(id, params) {
    const name = params?.name;
    if (typeof name !== "string") {
      throw new McpError(-32602, `Unknown tool: ${String(name)}. Call tools/list for the available tools.`);
    }
    if (name === "session_install") {
      const tool = findTool(name);
      if (!tool) throw new McpError(-32602, `Unknown tool: ${String(name)}. Call tools/list for the available tools.`);
      const validation = validateArguments(params.arguments ?? {}, tool.inputSchema);
      if (validation) throw new McpError(-32602, validation);
      const details = installInstructions();
      // Readable prose first: the caller is usually an assistant relaying this to a
      // person, and a bare JSON blob is not an instruction anyone can follow.
      const prose = [
        details.message,
        "",
        ...details.steps.map((step, index) => `${index + 1}. ${step}`),
        "",
        `No extension: ${details.freeStandaloneOption.how} — ${details.freeStandaloneOption.note}`,
        `Works with: ${details.clients}`,
      ].join("\n");
      return asToolResult(`${prose}\n\n${JSON.stringify(details, null, 2)}`);
    }
    const tool = await resolveTool(name);
    const browserTool = browserToolFor(name);
    if (!tool || !browserTool) {
      throw new McpError(-32602, `Unknown tool: ${String(name)}. Call tools/list for the available tools.`);
    }
    // Refs resolve to selectors before the schema sees them: the wire protocol keeps one
    // way of addressing an element, and the caller may use either.
    const suppliedArgs = tool.inputSchema.properties?.selector
      ? resolveRef(params.arguments ?? {})
      : (params.arguments ?? {});
    params = { ...params, arguments: suppliedArgs };
    const validation = validateArguments(suppliedArgs, tool.inputSchema);
    if (validation) throw new McpError(-32602, validation);

    if (mode === "standalone") {
      return executeStandaloneTool(standalone, name, params.arguments ?? {});
    }
    if (mode === "extension") {
      await waitForRelay();
      if (!relay.isConnected()) {
        if (existsSync(relay.socketPath)) {
          throw new McpError(-32000, EXTENSION_DISCONNECTED);
        }
        throw new McpError(-32000, EXTENSION_NOT_INSTALLED);
      }
    } else if (existsSync(relay.socketPath)) {
      await waitForRelay(250);
      if (!relay.isConnected()) {
        return executeStandaloneTool(standalone, name, params.arguments ?? {});
      }
    } else {
      return executeStandaloneTool(standalone, name, params.arguments ?? {});
    }
    const result = await relay.call({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: browserTool, arguments: params.arguments ?? {} },
    });
    if (name === "session_snapshot") {
      rememberRefs(params.arguments?.tabId, result?.content?.[0]?.text);
    }
    return result;
  }

  function handleMcpMessage(line) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      sendError(null, "Parse error: request is not valid JSON", -32700);
      return;
    }
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      sendError(null, "Invalid Request: body must be a JSON-RPC 2.0 object", -32600);
      return;
    }
    if (request.jsonrpc !== "2.0") {
      sendError(request.id ?? null, `Invalid Request: expected jsonrpc "2.0", received ${JSON.stringify(request.jsonrpc ?? null)}`, -32600);
      return;
    }
    if (typeof request.method !== "string" || request.method.length === 0) {
      sendError(request.id ?? null, "Invalid Request: method must be a non-empty string", -32600);
      return;
    }
    if (request.method.startsWith("notifications/")) {
      return;
    }

    const id = request.id ?? null;
    switch (request.method) {
      case "initialize":
        sendJsonRpc({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        });
        return;
      case "ping":
        sendJsonRpc({ jsonrpc: "2.0", id, result: {} });
        return;
      case "tools/list":
        void handleToolsList(id);
        return;
      case "tools/call":
        void handleToolCall(id, request.params);
        return;
      default:
        sendError(id, `Method not found: ${request.method}`, -32601);
    }
  }

  async function handleToolsList(id) {
    activeToolCalls += 1;
    try {
      sendJsonRpc({ jsonrpc: "2.0", id, result: { tools: await listedTools() } });
    } catch (error) {
      const code = error instanceof McpError ? error.code : -32000;
      sendError(id, error.message, code);
    } finally {
      activeToolCalls -= 1;
      maybeClose();
    }
  }

  async function handleToolCall(id, params) {
    activeToolCalls += 1;
    try {
      const result = await callTool(id, params);
      sendJsonRpc({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const code = error instanceof McpError ? error.code : -32000;
      sendError(id, error.message, code);
    } finally {
      activeToolCalls -= 1;
      maybeClose();
    }
  }

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", handleMcpMessage);
  rl.on("close", () => {
    shuttingDown = true;
    maybeClose();
  });
  relay.connect();
  return { relay, standalone };
}

function printUsage() {
  console.log(`Usage:
  mcp-session-bridge              Run the MCP server on stdio (what MCP clients launch)
  mcp-session-bridge --install    Register the native messaging host for Chrome, Chromium, Brave and Edge
  mcp-session-bridge --uninstall  Remove the native messaging host registration

Environment:
  T3RNEL_SESSION_MODE         auto (default) | extension | standalone
  T3RNEL_SESSION_SOCKET       override the relay socket path (testing)
  T3RNEL_SESSION_BROWSER      browser binary for standalone mode
  T3RNEL_SESSION_PROFILE      browser profile dir for standalone mode
  T3RNEL_SESSION_HEADLESS     "1" runs the standalone browser headless
  T3RNEL_SESSION_TIMEOUT_MS   per-call timeout (default 30000)

Supported MCP clients:
  ${SUPPORTED_MCP_CLIENTS}

Install the T3rnel Browser extension:
  ${BROWSER_PRODUCT_URL}

Two transports serve the same tool surface:

  extension  — the full path. Calls cross the relay socket to the native
               messaging host and into the T3rnel Browser extension, which
               executes them against the user's real, logged-in browser and
               enforces the Pro entitlement itself (the extension is the
               closed, shipped component, so enforcement lives there).
  standalone — the free path. The server launches and drives its own
               dedicated browser over CDP (persistent profile under
               ~/.t3rnel/session-bridge/browser-profile), the same model
               Playwright MCP uses. No extension, no license, no access to
               the user's everyday browser.`);
}

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printUsage();
} else if (args.includes("--install")) {
  const hostPath = defaultHostPath();
  const written = installHosts({ hostPath });
  printInstallSummary(written, hostPath);
} else if (args.includes("--uninstall")) {
  const removed = uninstallHosts();
  for (const path of removed) console.log(`Removed native messaging host: ${path}`);
  if (removed.length === 0) console.log("No native messaging host registration found.");
} else {
  startMcpServer();
}
