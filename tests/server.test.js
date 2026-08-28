import { spawn } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createFrameDecoder, encodeFrame } from "../src/framing.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "src", "server.js");
const hostPath = join(__dirname, "..", "src", "native-host.js");

function nextLine(stream, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    let timer;
    const onData = (data) => {
      const lines = data.toString().split("\n").filter(Boolean);
      if (lines.length > 0) {
        clearTimeout(timer);
        stream.off("data", onData);
        resolve(lines[0]);
      }
    };
    stream.on("data", onData);
    timer = setTimeout(() => {
      stream.off("data", onData);
      reject(new Error("Timeout waiting for server response"));
    }, timeoutMs);
  });
}

function send(proc, message) {
  proc.stdin.write(JSON.stringify(message) + "\n");
}

const activeProcs = new Set();
const activeHosts = new Set();
const tempDirs = new Set();

function trackedSpawn(executable, args, options, set) {
  const proc = spawn(executable, args, options);
  set.add(proc);
  proc.on("exit", () => set.delete(proc));
  return proc;
}

function spawnServer(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "t3rnel-bridge-"));
  tempDirs.add(dir);
  const socketPath = join(dir, "bridge.sock");
  const envWithSocket = env.T3RNEL_SESSION_SOCKET ? env : { ...env, T3RNEL_SESSION_SOCKET: socketPath };
  return trackedSpawn("node", [serverPath], { cwd: join(__dirname, ".."), env: { ...process.env, ...envWithSocket } }, activeProcs);
}

function spawnHost(env = {}) {
  return trackedSpawn("node", [hostPath], { env: { ...process.env, ...env } }, activeHosts);
}

afterEach(() => {
  for (const proc of activeProcs) {
    try { proc.kill(); } catch { }
  }
  activeProcs.clear();
  for (const host of activeHosts) {
    try { host.kill(); } catch { }
  }
  activeHosts.clear();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
  tempDirs.clear();
});

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error("Timed out waiting for condition"));
      } else {
        setTimeout(poll, 25);
      }
    };
    poll();
  });
}

/**
 * Plays the role of Chrome on the native host's stdin/stdout: reads native
 * messaging frames the host forwards and writes responses back.
 */
class FakeChrome {
  constructor(hostProc) {
    this.proc = hostProc;
    this.queue = [];
    this.waiters = [];
    this.decoder = createFrameDecoder((message) => this.onMessage(message));
    hostProc.stdout.on("data", (chunk) => this.decoder.push(chunk));
  }

  onMessage(message) {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      this.queue.push(message);
    }
  }

  nextRequest(timeoutMs = 5000) {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for Chrome-bound message")), timeoutMs);
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  /**
   * The next request of a given method, skipping the rest.
   *
   * The server asks the extension for its tool list as part of coming up, so whether a
   * `tools/call` or that `tools/list` reaches Chrome first is a race. A test about
   * forwarding a call should assert on the call, not on it happening to be first —
   * asserting on arrival order made this fail intermittently for a reason that had
   * nothing to do with forwarding.
   */
  async requestOfMethod(method, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timeout waiting for a ${method} bound for Chrome`);
      const message = await this.nextRequest(remaining);
      if (message.method === method) return message;
      /**
       * Anything else the server needs on the way is answered so it can carry on —
       * with a real answer. Replying to `tools/list` with an empty list made the server
       * treat every tool as unknown and stop before forwarding anything.
       */
      if (message.id === undefined) continue;
      if (message.method === "tools/list") {
        this.respond(message.id, {
          tools: [
            { name: "browser_list_tabs", description: "List tabs", inputSchema: { type: "object", properties: {} } },
          ],
        });
      } else {
        this.respond(message.id, {});
      }
    }
  }

  respond(id, result) {
    this.proc.stdin.write(encodeFrame({ jsonrpc: "2.0", id, result }));
  }

  fail(id, message) {
    this.proc.stdin.write(encodeFrame({ jsonrpc: "2.0", id, error: { code: -32000, message } }));
  }
}

describe("MCP Session Bridge", () => {
  it("responds to initialize", async () => {
    const proc = spawnServer();
    proc.stderr.on("data", () => { });

    send(proc, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const line = await nextLine(proc.stdout);
    const response = JSON.parse(line);
    assert.strictEqual(response.id, 1);
    assert.strictEqual(response.result.serverInfo.name, "t3rnel-session");
    assert.strictEqual(response.result.protocolVersion, "2024-11-05");

    proc.kill();
  });

  it("lists available tools", async () => {
    const proc = spawnServer();
    proc.stderr.on("data", () => { });

    send(proc, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const line = await nextLine(proc.stdout, 10000);
    const response = JSON.parse(line);
    assert.strictEqual(response.id, 2);
    assert.ok(Array.isArray(response.result.tools));
    assert.ok(response.result.tools.some((t) => t.name === "session_read_page"));

    proc.kill();
  });

  it("does not require a license key on the server", async () => {
    const proc = spawnServer({
      T3RNEL_SESSION_MODE: "standalone",
      T3RNEL_SESSION_BROWSER: "/no-such-browser",
    });
    proc.stderr.on("data", () => { });

    send(proc, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "session_read_page", arguments: {} } });
    const line = await nextLine(proc.stdout);
    const response = JSON.parse(line);
    assert.strictEqual(response.id, 3);
    assert.ok(response.error);
    assert.doesNotMatch(response.error.message, /LICENSE_KEY/);

    proc.kill();
  });

  it("validates tool arguments", async () => {
    const proc = spawnServer();
    proc.stderr.on("data", () => { });

    send(proc, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "session_navigate", arguments: {} } });
    const line = await nextLine(proc.stdout);
    const response = JSON.parse(line);
    assert.strictEqual(response.error.code, -32602);
    assert.match(response.error.message, /Missing required argument/);

    proc.kill();
  });

  it("rejects unknown tools", async () => {
    const proc = spawnServer();
    proc.stderr.on("data", () => { });

    send(proc, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "session_foo", arguments: {} } });
    const line = await nextLine(proc.stdout);
    const response = JSON.parse(line);
    assert.strictEqual(response.error.code, -32602);
    assert.match(response.error.message, /Unknown tool/);

    proc.kill();
  });

  it("rejects invalid argument types", async () => {
    const proc = spawnServer();
    proc.stderr.on("data", () => { });

    send(proc, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "session_navigate", arguments: { url: 123 } } });
    const line = await nextLine(proc.stdout);
    const response = JSON.parse(line);
    assert.strictEqual(response.error.code, -32602);
    assert.match(response.error.message, /string/);

    proc.kill();
  });

  it("fails clearly in extension mode when the extension is not connected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3rnel-session-"));
    const proc = spawnServer({
      T3RNEL_SESSION_MODE: "extension",
      T3RNEL_SESSION_SOCKET: join(dir, "bridge.sock"),
    });
    proc.stderr.on("data", () => { });

    send(proc, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "session_navigate", arguments: { url: "https://example.com" } } });
    const line = await nextLine(proc.stdout);
    const response = JSON.parse(line);
    assert.strictEqual(response.id, 9);
    assert.strictEqual(response.error.code, -32000);
    assert.match(response.error.message, /not (connected|installed|currently connected)/);

    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers ping and ignores notifications", async () => {
    const proc = spawnServer();
    proc.stderr.on("data", () => { });

    send(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
    send(proc, { jsonrpc: "2.0", id: 12, method: "ping" });
    const line = await nextLine(proc.stdout);
    const response = JSON.parse(line);
    assert.strictEqual(response.id, 12);
    assert.deepStrictEqual(response.result, {});

    proc.kill();
  });

  it("rejects a malformed envelope as Invalid Request", async () => {
    const proc = spawnServer();
    proc.stderr.on("data", () => { });

    send(proc, { id: 13, method: "tools/list" });
    const line = await nextLine(proc.stdout);
    const response = JSON.parse(line);
    assert.strictEqual(response.error.code, -32600);

    proc.kill();
  });
});

describe("end to end through the native host and relay socket", () => {
  it("forwards a licensed tool call to the extension and returns its result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3rnel-session-e2e-"));
    const socketPath = join(dir, "bridge.sock");
    const host = spawnHost({ T3RNEL_SESSION_SOCKET: socketPath });
    host.stderr.on("data", () => { });
    const chrome = new FakeChrome(host);

    try {
      await waitFor(() => existsSync(socketPath));

      const proc = spawnServer({
        T3RNEL_SESSION_MODE: "extension",
        T3RNEL_SESSION_SOCKET: socketPath,
      });
      proc.stderr.on("data", () => { });

      send(proc, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "session_list_tabs", arguments: {} } });

      const forwarded = await chrome.requestOfMethod("tools/call");
      assert.strictEqual(forwarded.method, "tools/call");
      assert.strictEqual(forwarded.params.name, "browser_list_tabs");
      assert.match(forwarded.id, /^\d+:s\d+$/);

      chrome.respond(forwarded.id, {
        content: [{ type: "text", text: JSON.stringify([{ id: 7, title: "Intranet", url: "https://intranet.example" }]) }],
      });

      const line = await nextLine(proc.stdout);
      const response = JSON.parse(line);
      assert.strictEqual(response.id, 1);
      assert.strictEqual(response.error, undefined);
      assert.match(response.result.content[0].text, /intranet\.example/);

      proc.kill();
    } finally {
      host.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces extension tool errors as MCP errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3rnel-session-e2e-"));
    const socketPath = join(dir, "bridge.sock");
    const host = spawnHost({ T3RNEL_SESSION_SOCKET: socketPath });
    host.stderr.on("data", () => { });
    const chrome = new FakeChrome(host);

    try {
      await waitFor(() => existsSync(socketPath));

      const proc = spawnServer({
        T3RNEL_SESSION_MODE: "extension",
        T3RNEL_SESSION_SOCKET: socketPath,
      });
      proc.stderr.on("data", () => { });

      send(proc, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "session_click", arguments: { selector: "#missing" } } });
      const forwarded = await chrome.nextRequest();
      chrome.fail(forwarded.id, "Element not found: #missing");

      const line = await nextLine(proc.stdout);
      const response = JSON.parse(line);
      assert.strictEqual(response.id, 2);
      assert.match(response.error.message, /Element not found/);

      proc.kill();
    } finally {
      host.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("times out a call the browser never answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3rnel-session-e2e-"));
    const socketPath = join(dir, "bridge.sock");
    const host = spawnHost({ T3RNEL_SESSION_SOCKET: socketPath });
    host.stderr.on("data", () => { });
    const chrome = new FakeChrome(host);

    try {
      await waitFor(() => existsSync(socketPath));

      const proc = spawnServer({
        T3RNEL_SESSION_MODE: "extension",
        T3RNEL_SESSION_SOCKET: socketPath,
        T3RNEL_SESSION_TIMEOUT_MS: "300",
      });
      proc.stderr.on("data", () => { });

      send(proc, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "session_read_page", arguments: {} } });
      await chrome.nextRequest(); // Chrome never responds.

      const line = await nextLine(proc.stdout, 5000);
      const response = JSON.parse(line);
      assert.strictEqual(response.id, 3);
      assert.match(response.error.message, /timed out/);

      proc.kill();
    } finally {
      host.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns installation instructions from session_install without a browser session", async () => {
    const proc = spawnServer({ T3RNEL_SESSION_MODE: "standalone" });
    proc.stderr.on("data", () => { });

    send(proc, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "session_install", arguments: {} } });
    const line = await nextLine(proc.stdout);
    const response = JSON.parse(line);
    assert.strictEqual(response.id, 9);
    assert.ok(response.result);

    /**
     * The shape MCP defines, because that is the only shape a client renders.
     *
     * This assertion previously read the fields off a bare object, which pinned the
     * defect: the server answered `{ canInstall, steps, ... }` with no `content`, so a
     * spec-compliant client showed the user nothing at all — from the one tool whose
     * entire job is to explain how to install.
     */
    assert.ok(Array.isArray(response.result.content), "session_install must return MCP content");
    assert.strictEqual(response.result.content[0].type, "text");
    const text = response.result.content[0].text;

    // And the text has to be something a person can act on, not a status line.
    assert.match(text, /t3ratech\.github\.io/, "names where to get the extension");
    assert.match(text, /mcp-session-bridge --install/, "names the command that registers the host");
    assert.match(text, /T3RNEL_SESSION_MODE=standalone/, "names the no-extension fallback");
    assert.match(text, /Claude Code\/Desktop/, "names the clients it works with");

    // The machine-readable copy travels with it, so an agent can branch on it.
    const details = JSON.parse(text.slice(text.indexOf("{")));
    assert.strictEqual(details.canInstall, true);
    assert.match(details.storeUrl, /t3ratech\.github\.io/);
    assert.match(details.freeStandaloneOption.how, /standalone/);

    proc.kill();
  });

  it("lists session_install in available tools", async () => {
    const proc = spawnServer();
    proc.stderr.on("data", () => { });

    send(proc, { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} });
    const line = await nextLine(proc.stdout, 10000);
    const response = JSON.parse(line);
    assert.strictEqual(response.id, 10);
    assert.ok(Array.isArray(response.result.tools));
    assert.ok(response.result.tools.some((t) => t.name === "session_install"));

    proc.kill();
  });
});
