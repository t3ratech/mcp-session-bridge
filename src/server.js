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
 * Transport (1.3.0+): MCP client -> stdio (newline-delimited JSON-RPC) -> this
 * server -> loopback WebSocket -> the T3rnel Browser extension's service
 * worker, which dials out to it and executes the tool against the live
 * session. The pre-1.3 path — relay socket -> native host spawned by Chrome ->
 * extension — is kept as a fallback for hosts registered by older installs.
 *
 * Usage:
 *   1. Install the T3rnel Browser extension:
 *        https://browser.t3ratech.co.zw/
 *   2. Add to your MCP client config:
 *        { "mcpServers": { "t3rnel-session": {
 *            "command": "npx", "args": ["-y", "@t3ratech/mcp-session-bridge"],
 *            "env": { "T3RNEL_SESSION_MODE": "auto" }
 *        } } }
 *   3. Nothing else — with AI/MCP automation allowed (the default) the
 *      extension pairs the bridge automatically. Only an armed approval gate
 *      shows a one-time pairing card in the side panel.
 */

import { createInterface } from "node:readline";
import net from "node:net";
import { constants as osConstants } from "node:os";
import { createFrameDecoder, encodeFrame } from "./framing.js";
import { filterByProfiles, parseToolProfiles } from "./profiles.js";
import { SESSION_TOOLS, STANDALONE_TOOLS, SUPPORTED_MCP_CLIENTS, findTool, toWireTool, validateArguments } from "./tools.js";
import { resolveSocketPath } from "./relay.js";
import { startExtensionWebSocket } from "./ws-server.js";
import { defaultHostPath, installHosts, uninstallHosts, printInstallSummary } from "./install.js";
import { StandaloneBrowser, executeStandaloneTool } from "./cdp.js";
import { readUrl } from "./read-url.js";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "t3rnel-session";
const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json");

const BROWSER_PRODUCT_URL =
  "https://browser.t3ratech.co.zw/";
const BROWSER_HELP_URL = "https://browser.t3ratech.co.zw/";

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
function asToolResult(text) {
  return { content: [{ type: "text", text }] };
}

function installInstructions() {
  return {
    canInstall: true,
    message:
      "The T3rnel Browser extension is not installed or not connected. " +
      "You can install it now, or use the free standalone mode instead.",
    steps: [
      "Install the T3rnel Browser extension from the product site: " + BROWSER_PRODUCT_URL,
      "Point your MCP client at `npx -y @t3ratech/mcp-session-bridge` — no global install, no --install step.",
      "Nothing to approve while AI/MCP automation is allowed (the default): the extension pairs the bridge automatically. If the approval gate is armed, approve the one-time card in the side panel.",
      "Retry the tool you were calling.",
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

/**
 * The two disconnection messages, split on purpose.
 *
 * `EXTENSION_REQUIRED` is only for tools that genuinely need the extension —
 * a standalone-capable tool getting it would tell the user to install something
 * they do not need, which is exactly the over-promotion this split removes.
 */
const EXTENSION_REQUIRED =
  "The T3rnel Browser extension is not connected — install it here: " +
  BROWSER_PRODUCT_URL +
  " (this tool needs the extension; it has no standalone equivalent). " +
  "If it is already installed, open the browser and retry — pairing is automatic " +
  "unless the approval gate is armed, in which case approve the card in the side panel.";

const EXTENSION_DISCONNECTED =
  "The T3rnel Browser extension is not connected. " +
  "If it is installed, open the browser and retry — pairing is automatic unless the " +
  "approval gate is armed, in which case approve the card in its side panel. " +
  "This tool can also run without it: set T3RNEL_SESSION_MODE=standalone. " +
  "Documentation: " + BROWSER_HELP_URL;

/**
 * Installed, but not answering right now — a sleeping service worker or a closed browser.
 * Telling this user to install the extension would send them to a store page for
 * something they already have, and offering standalone mode for a tool that has no
 * standalone equivalent would be a dead end.
 */
const EXTENSION_ASLEEP =
  "The T3rnel Browser extension is installed but not connected right now. " +
  "Open the browser and retry — pairing is automatic unless the approval gate is armed, " +
  "in which case approve the card in its side panel. Documentation: " + BROWSER_HELP_URL;

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

export class RelayClient {
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

  connect() {
    if (this.closed) return;
    const socket = net.createConnection({ path: this.socketPath });
    const decoder = createFrameDecoder((message) => this.onFrame(message));
    socket.on("connect", () => {
      this.socket = socket;
      this.connected = true;
      this.retryMs = 250;
      this.log(`mcp-session-bridge: connected to relay at ${this.socketPath}`);
      this.onConnect?.();
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
    // A socket torn down for a framing error is dead before its close event arrives.
    if (!this.connected || !this.socket || this.socket.destroyed) {
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
  /** The standalone browser to drive; a caller or a test may supply its own. */
  standalone = new StandaloneBrowser({ headless: env.T3RNEL_SESSION_HEADLESS === "1" }),
  /** Overrides T3RNEL_SESSION_PORT; 0 binds an ephemeral port, for tests. */
  wsBasePort,
  /** The tool profiles to list (see profiles.js); null lists every tool. Unlisted tools stay callable by name. */
  tools: listedProfiles = parseToolProfiles(env.T3RNEL_SESSION_TOOLS),
  /** Which addresses session_read_url may connect to; the default is public addresses only. A test lifts it to reach a loopback server. */
  readUrlPolicy,
} = {}) {
  const log = (line) => stderr.write(`${line}\n`);
  const relay = new RelayClient(resolveSocketPath(env), { timeoutMs, log });
  const mode = (env.T3RNEL_SESSION_MODE ?? "auto").toLowerCase();
  let activeToolCalls = 0;
  let shuttingDown = false;

  /**
   * The 1.3.0 transport: this server listens, the extension dials out. Started
   * eagerly so the endpoint exists before the first tools/list; a failure to
   * bind (every port taken) leaves ws null and the legacy relay path still
   * answers, so an old host registration keeps working.
   */
  let ws = null;
  /**
   * Whether the list this client last received lacked the extension's tools.
   *
   * Clients read `tools/list` once at start-up, usually before the extension has dialled
   * in, and keep that answer. When the extension then arrives the client is told — once:
   * a service worker that sleeps and wakes every few seconds must not make it re-list
   * each time, so a list that already carried the extension's tools is not re-announced.
   */
  let listedWithoutExtension = false;
  let initialized = false;
  function announceExtensionTools() {
    if (!initialized || !listedWithoutExtension) return;
    listedWithoutExtension = false;
    sendJsonRpc({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  const wsStarted = startExtensionWebSocket({
    env,
    basePort: wsBasePort,
    version: SERVER_VERSION,
    log,
    onReadyChange: (connected) => { if (connected) announceExtensionTools(); },
  })
    .then((server) => { ws = server; return server; })
    .catch((error) => {
      log(`mcp-session-bridge: WebSocket endpoint unavailable: ${error.message}`);
      return null;
    });

  function extensionConnected() {
    return (ws !== null && ws.isConnected()) || relay.isConnected();
  }

  /**
   * "Is the extension around at all" — a dialed-in socket still awaiting its
   * pairing approval counts, because telling that user to install is wrong;
   * the pairing card is already on their screen. So does an extension that was
   * connected moments ago: a missing socket then means a sleeping service
   * worker, not a missing install.
   */
  function extensionPresent() {
    return (
      (ws !== null && (ws.hasExtensionSocket() || ws.extensionExpected())) ||
      relay.isConnected() ||
      existsSync(relay.socketPath)
    );
  }

  /** The WebSocket when it is up, else the relay — which refuses by name when it is not. */
  function callExtension(payload, callTimeoutMs = timeoutMs) {
    return ws !== null && ws.isConnected() ? ws.call(payload, callTimeoutMs) : relay.call(payload, callTimeoutMs);
  }

  /**
   * The extension owns the browser-tool registry. Keeping a hand-copied second
   * registry here made the bridge silently expose 19 tools while the product
   * promised 98. This cache is populated from the connected extension and invalidated
   * by a transport disconnect, so schemas and names cannot drift at release time.
   */
  let extensionSessionTools = null;
  const forgetTools = () => { extensionSessionTools = null; };
  relay.onDisconnect = forgetTools;
  relay.onConnect = announceExtensionTools;
  void wsStarted.then((server) => { if (server) server.onDisconnect = forgetTools; });

  function maybeClose() {
    if (shuttingDown && activeToolCalls === 0) {
      relay.close();
      // The endpoint may still be binding when stdin closes — `echo … | mcp-session-bridge`
      // does exactly that — and closing `ws` while it is null left a listening socket
      // that kept the process alive after its client had gone.
      void wsStarted.then((server) => server?.close());
      void standalone.close();
    }
  }

  function sendJsonRpc(response) {
    stdout.write(`${JSON.stringify(response)}\n`);
  }

  function sendError(id, message, code = -32000) {
    sendJsonRpc({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /**
   * Waits for either transport: the WebSocket the extension dials out to (1.3.0+)
   * or the relay socket a pre-1.3 native host still owns.
   *
   * The caller's `ms` is a fast-path budget sized for an already-awake worker.
   * When the extension is expected but not connected — the marker file or a
   * dropped ready connection says its service worker is asleep — the real wait
   * is the worker's next wake alarm (≤ ~30s), so `stretch` callers (tools/call)
   * wait to just under the call timeout. `tools/list` callers keep the fast
   * path: a client treats a multi-second list as a dead server, and the local
   * fallback list is a better answer than silence.
   */
  async function waitForExtension(ms = 1000, { stretch = true } = {}) {
    const start = Date.now();
    // A call that lands while the endpoint is still binding must still see the
    // marker: settle the server promise first, or `expected` is latched false
    // and the sleep-window budget is never applied to it.
    await wsStarted;
    while (!extensionConnected()) {
      const expected = stretch && ws !== null && ws.extensionExpected();
      const budget = expected ? Math.max(ms, timeoutMs - 2000) : ms;
      if (Date.now() - start >= budget) return;
      if (!expected && !existsSync(relay.socketPath) && !(ws && ws.hasExtensionSocket())) {
        // Nothing is even trying to reach us — waiting is dead time. wsStarted
        // settled above, so ws === null here means the endpoint failed to bind.
        return;
      }
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
    await waitForExtension(1000, { stretch: false });
    if (!extensionConnected()) throw new McpError(-32000, extensionPresent() ? EXTENSION_ASLEEP : EXTENSION_REQUIRED);
    const response = await callExtension({ jsonrpc: "2.0", method: "tools/list", params: {} });
    const browserTools = Array.isArray(response?.tools) ? response.tools : null;
    if (!browserTools) throw new McpError(-32000, "The connected extension returned an invalid tools/list response.");
    const tools = browserTools.map(asSessionTool).filter(Boolean);
    if (tools.length !== browserTools.length || tools.length === 0) {
      throw new McpError(-32000, "The connected extension returned an incomplete browser tool registry.");
    }
    extensionSessionTools = tools;
    return tools;
  }

  /**
   * Google Antigravity refuses to install a server whose tools/list exceeds 100
   * entries. Extension builds older than the internal-only filter publish all 100
   * registry names, which with session_install lands at 101 and is rejected. When
   * the merged list would exceed the ceiling, the bridge drops the lowest-value
   * verbs — md_diff and check_spelling are single-purpose QA helpers that have
   * near-siblings (browser_audit, browser_md_view) and lose little. The cap is
   * bridge-side so every extension build, including stale ones, stays installable.
   * Dropped tools still execute if called by name — they are just unlisted.
   */
  const MCP_TOOL_LIST_CEILING = 100;
  const MCP_DROP_WHEN_OVER_CEILING = ["session_md_diff", "session_check_spelling"];

  async function listedTools() {
    const bridgeOnly = [findTool("session_install"), findTool("session_read_url")].filter(Boolean);
    let tools;
    if (mode === "extension") {
      tools = await getExtensionSessionTools();
    } else if (mode === "auto") {
      await waitForExtension(250, { stretch: false });
      if (extensionConnected()) tools = await getExtensionSessionTools();
    }
    if (!tools) {
      // Only "auto" can gain the extension's tools later; "standalone" never will.
      listedWithoutExtension = mode === "auto";
      return filterByProfiles(SESSION_TOOLS, listedProfiles).map(toWireTool);
    }
    listedWithoutExtension = false;
    const names = new Set(tools.map((t) => t.name));
    const merged = [...tools, ...bridgeOnly.filter((t) => !names.has(t.name))];
    const listed = merged.length > MCP_TOOL_LIST_CEILING
      ? merged.filter((t) => !MCP_DROP_WHEN_OVER_CEILING.includes(t.name))
      : merged;
    return filterByProfiles(listed, listedProfiles).map(toWireTool);
  }

  async function resolveTool(name) {
    if (name === "session_login" || name === "session_store_login" || name === "session_read_url") return findTool(name);
    if (mode === "extension" || (mode === "auto" && extensionConnected())) {
      const tools = extensionSessionTools ?? await getExtensionSessionTools();
      return tools.find((tool) => tool.name === name) ?? null;
    }
    return findTool(name);
  }

  /** Every resolvable tool is named session_*; its browser twin swaps the prefix. */
  function browserToolFor(name) {
    if (name === "session_login") return "browser_vault_load";
    if (name === "session_store_login") return "browser_vault_save";
    return `browser_${name.slice("session_".length)}`;
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
    try { parsed = typeof payload === "string" ? JSON.parse(payload) : payload; } catch {
      // The extension's default snapshot is compact text, one `- role "name" [@e3, …]` line per
      // element, with no selectors. The extension resolves an @eN it is handed as a selector,
      // so each ref listed maps to itself.
      const refs = [...String(payload).matchAll(/^- .*?\[@(e\d+)\b/gm)].map((m) => m[1]);
      if (refs.length === 0) return;
      const map = new Map();
      for (const ref of refs) { map.set(`@${ref}`, `@${ref}`); map.set(ref, `@${ref}`); }
      refsByTab.set(tabId ?? "active", map);
      return;
    }
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
    if (typeof args.ref !== "string") return args;
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
    const args = params?.arguments ?? {};
    if (typeof name !== "string") {
      throw new McpError(-32602, `Unknown tool: ${String(name)}. Call tools/list for the available tools.`);
    }
    if (name === "session_install") {
      const tool = findTool(name);
      const validation = validateArguments(args, tool.inputSchema);
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
    if (!tool) {
      throw new McpError(-32602, `Unknown tool: ${String(name)}. Call tools/list for the available tools.`);
    }
    // The schema sees what the caller sent — a ref is a first-class way to name an
    // element. Only the extension path translates it: the standalone browser stamped the
    // ref onto the element itself and resolves it there, and has no selector to hand back.
    const validation = validateArguments(args, tool.inputSchema);
    if (validation) throw new McpError(-32602, validation);
    // Answered here in every mode: it is a plain fetch, so it neither needs the browser nor
    // is made better by one.
    if (name === "session_read_url") {
      try {
        return asToolResult(await readUrl(args, { addressPolicy: readUrlPolicy }));
      } catch (error) {
        throw new McpError(-32000, error.message);
      }
    }
    const forExtension = () => (tool.inputSchema.properties?.selector ? resolveRef(args) : args);

    if (mode === "standalone") {
      return executeStandaloneTool(standalone, name, args);
    }
    /**
     * Only "auto" reaches here unconnected: in "extension" mode `resolveTool` has already
     * refused, because a disconnect clears the extension's tool list with it.
     */
    if (!extensionConnected()) {
      await waitForExtension(250);
    }
    if (!extensionConnected()) {
      /**
       * The error must not promote the extension to a caller whose tool works
       * without it — that is the promotion pattern the hint exists to replace.
       * `requiresExtension` (or a name the standalone list does not carry, i.e.
       * an extension-published browser_* tool) is what earns the install line.
       */
      const standaloneNames = new Set(STANDALONE_TOOLS.map((t) => t.name));
      const needsExtension = tool.requiresExtension === true || !standaloneNames.has(name);
      if (!needsExtension) {
        return executeStandaloneTool(standalone, name, args);
      }
      throw new McpError(-32000, extensionPresent() ? EXTENSION_ASLEEP : EXTENSION_REQUIRED);
    }
    const result = await callExtension({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: browserToolFor(name), arguments: forExtension() },
    });
    if (name === "session_snapshot") {
      rememberRefs(args.tabId, result?.content?.[0]?.text);
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
        initialized = true;
        sendJsonRpc({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: true } },
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

  const rl = createInterface({ input: stdin, terminal: false });
  rl.on("line", handleMcpMessage);
  rl.on("close", () => {
    shuttingDown = true;
    maybeClose();
  });
  relay.connect();
  return { relay, standalone, ws: () => ws, wsStarted };
}

function printUsage() {
  console.log(`Usage:
  mcp-session-bridge              Run the MCP server on stdio (what MCP clients launch)
  mcp-session-bridge --install    Register the native messaging host (legacy pre-1.3 transport only)
  mcp-session-bridge --uninstall  Remove the native messaging host registration
  mcp-session-bridge --tools core,network   List only those tool profiles (see T3RNEL_SESSION_TOOLS)

Environment:
  T3RNEL_SESSION_MODE         auto (default) | extension | standalone
  T3RNEL_SESSION_PORT         base port for the loopback WebSocket (default 17311, range of 8)
  T3RNEL_SESSION_SOCKET       override the legacy relay socket path (testing)
  T3RNEL_SESSION_BROWSER      browser binary for standalone mode
  T3RNEL_SESSION_PROFILE      browser profile dir for standalone mode
  T3RNEL_SESSION_HEADLESS     "1" runs the standalone browser headless
  T3RNEL_SESSION_TIMEOUT_MS   per-call timeout (default 30000)
  T3RNEL_SESSION_TOOLS        which tool profiles to list: all (default), or any of core, network, design,
                              test, vault, page, comma-separated (core is always included). A client reads the
                              whole list into the model's context, so core alone is about a quarter of it;
                              a tool that is not listed can still be called by name. Same as --tools <value>.

Supported MCP clients:
  ${SUPPORTED_MCP_CLIENTS}

Install the T3rnel Browser extension:
  ${BROWSER_PRODUCT_URL}

Two transports serve the same tool surface:

  extension  — the full path. The extension's service worker dials out to this
               server's loopback WebSocket and executes calls against the
               user's real, logged-in browser, enforcing the Pro entitlement
               itself (the extension is the closed, shipped component, so
               enforcement lives there). Bridges and extensions older than
               1.3.0 can still use the relay-socket/native-host path.
  standalone — the free path. The server launches and drives its own
               dedicated browser over CDP (persistent profile under
               ~/.t3rnel/session-bridge/browser-profile), the same model
               Playwright MCP uses. No extension, no license, no access to
               the user's everyday browser.`);
}

/**
 * The command line, run only when this file is the program.
 *
 * It ran at import time, so a test or an embedding caller that merely imported
 * `parseTimeoutMs` started a live bridge on the default ports reading the importer's
 * stdin — which the developer's own browser then found and paired with. The binary is
 * reached through npm's symlink, so the comparison is between real paths.
 */
export function main(argv = process.argv.slice(2)) {
  const args = argv;
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
  } else if (args.includes("--install")) {
    const hostPath = defaultHostPath();
    const written = installHosts({ hostPath });
    printInstallSummary(written);
  } else if (args.includes("--uninstall")) {
    const removed = uninstallHosts();
    for (const path of removed) console.log(`Removed native messaging host: ${path}`);
    if (removed.length === 0) console.log("No native messaging host registration found.");
  } else {
    const toolsFlag = args.indexOf("--tools");
    if (toolsFlag >= 0 && !args[toolsFlag + 1]) throw new Error("--tools needs a value: all, or a comma-separated list of core, network, design, test, vault, page");
    const env = toolsFlag >= 0 ? { ...process.env, T3RNEL_SESSION_TOOLS: args[toolsFlag + 1] } : process.env;
    const server = startMcpServer({ env });
    /**
     * A stdio client stops this server with a signal as often as by closing stdin, and only
     * the stdin path cleaned up — so every SIGTERM left the standalone browser running with
     * no owner. Close everything this process started, then exit with the signal's code.
     */
    const shutdown = (signal) => {
      server.relay.close();
      server.ws()?.close();
      void server.standalone.close();
      process.exit(128 + osConstants.signals[signal]);
    };
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, () => shutdown(signal));
    // Any other exit path — an uncaught error included — still must not orphan the browser.
    process.once("exit", () => { server.standalone.process?.kill(); });
  }
}

function invokedDirectly() {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
