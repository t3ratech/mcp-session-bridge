/**
 * The MCP server driven in-process: JSON-RPC in on a stream, answers read back, with a
 * scripted extension on the WebSocket and a scripted legacy relay on a Unix socket.
 */
import { describe, it, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

before(() => { process.env.HOME = mkdtempSync(join(tmpdir(), "t3rnel-server-home-")); });
const { startMcpServer, parseTimeoutMs, RelayClient } = await import("../src/server.js");
const { connectWebSocket } = await import("../src/ws.js");
const { parseToolProfiles } = await import("../src/profiles.js");
const { createFrameDecoder, encodeFrame } = await import("../src/framing.js");

const servers = [];
afterEach(async () => { for (const s of servers.splice(0)) await s(); });

function server({ mode = "auto", socket, timeoutMs = 2000, standalone, extra = {} } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lines = [];
  let buf = "";
  stdout.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const logs = [];
  stderr.on("data", (c) => logs.push(String(c)));
  const env = { T3RNEL_SESSION_MODE: mode, T3RNEL_SESSION_SOCKET: socket ?? join(mkdtempSync(join(tmpdir(), "t3rnel-srv-")), "none.sock") };
  const s = startMcpServer({ env, stdin, stdout, stderr, timeoutMs, wsBasePort: 0, ...(standalone ? { standalone } : {}), ...extra });
  servers.push(async () => { stdin.end(); s.relay.close(); (await s.wsStarted)?.close(); });
  const send = (obj) => stdin.write(`${typeof obj === "string" ? obj : JSON.stringify(obj)}\n`);
  const reply = async (id, ms = 5000) => {
    for (let t = 0; t < ms; t += 20) {
      const found = lines.find((l) => l.id === id);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no reply to ${id}; got ${JSON.stringify(lines)}`);
  };
  const rpc = async (id, method, params) => { send({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }); return reply(id); };
  return { s, stdin, lines, logs, send, reply, rpc };
}

/** A scripted extension: pairs, then answers tools/list and tools/call via `handle`. */
async function extension(port, handle) {
  const early = [];
  let ws;
  const on = (m) => {
    if (m.type === "t3rnel.bridge.hello") { ws.send(JSON.stringify({ type: "t3rnel.bridge.ready" })); return; }
    if (m.id) { const answer = handle(m); if (answer !== undefined) ws.send(JSON.stringify({ id: m.id, ...answer })); }
  };
  ws = await connectWebSocket(`ws://127.0.0.1:${port}/session`, { onMessage: (t) => { const m = JSON.parse(t); if (ws) on(m); else early.push(m); } });
  for (const m of early.splice(0)) on(m);
  servers.push(() => ws.close());
  return ws;
}

const TOOLS = [
  { name: "browser_click", description: "Click", inputSchema: { type: "object", properties: { selector: { type: "string" }, ref: { type: "string" }, tabId: { type: "integer" } }, additionalProperties: false, requireOneOf: ["selector", "ref"] } },
  { name: "browser_snapshot", description: "Snapshot", inputSchema: { type: "object", properties: { tabId: { type: "integer" }, format: { type: "string", enum: ["compact", "json"] } }, additionalProperties: false } },
  { name: "browser_vault_list", description: "Vault", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];

const until = async (check, ms = 3000) => { for (let t = 0; t < ms && !check(); t += 20) await new Promise((r) => setTimeout(r, 20)); };

describe("configuration", () => {
  it("parses the per-call timeout, and refuses a nonsense one by name", () => {
    assert.equal(parseTimeoutMs({}), 30000);
    assert.equal(parseTimeoutMs({ T3RNEL_SESSION_TIMEOUT_MS: "" }, 5), 5);
    assert.equal(parseTimeoutMs({ T3RNEL_SESSION_TIMEOUT_MS: "1500" }), 1500);
    for (const bad of ["0", "-3", "soon"]) {
      assert.throws(() => parseTimeoutMs({ T3RNEL_SESSION_TIMEOUT_MS: bad }), new RegExp(`must be a positive integer, received "${bad}"`));
    }
  });
});

describe("JSON-RPC framing", () => {
  it("answers malformed requests with the matching JSON-RPC error and ignores notifications", async () => {
    const h = server({ mode: "standalone" });
    h.send("not json");
    h.send("[1]");
    h.send({ jsonrpc: "1.0", id: "v" });
    h.send({ jsonrpc: "2.0", id: "m", method: "" });
    h.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await until(() => h.lines.length >= 4);
    assert.deepEqual(h.lines.map((l) => [l.id, l.error.code]), [[null, -32700], [null, -32600], ["v", -32600], ["m", -32600]]);
    assert.match(h.lines[2].error.message, /expected jsonrpc "2\.0", received "1\.0"/);
    assert.deepEqual((await h.rpc("p", "ping")).result, {});
    assert.deepEqual((await h.rpc("u", "resources/list")).error, { code: -32601, message: "Method not found: resources/list" });
  });
});

describe("tools/call without an extension", () => {
  it("names a missing or unknown tool, and validates install's arguments", async () => {
    const h = server({ mode: "standalone" });
    assert.match((await h.rpc(1, "tools/call", {})).error.message, /Unknown tool: undefined/);
    assert.match((await h.rpc(2, "tools/call", { name: "session_nope" })).error.message, /Unknown tool: session_nope/);
    assert.match((await h.rpc(3, "tools/call", { name: "session_install", arguments: { bogus: 1 } })).error.message, /Unknown argument: bogus/);
    assert.match((await h.rpc(4, "tools/call", { name: "session_click", arguments: {} })).error.message, /selector|ref/);
  });

  it("standalone mode runs a standalone tool on the standalone browser", async () => {
    const fake = { profileDir: "/p", ensureStarted: async () => {}, syncTabs: async () => [], httpJson: async () => ({ Browser: "Fake/1" }), close: async () => {} };
    const h = server({ mode: "standalone", standalone: fake });
    const r = await h.rpc(1, "tools/call", { name: "session_health", arguments: {} });
    assert.match(r.result.content[0].text, /Fake\/1/);
  });

  it("extension mode says install only when no extension is around at all", async () => {
    const h = server({ mode: "extension", timeoutMs: 1500 });
    assert.match((await h.rpc(1, "tools/call", { name: "session_click", arguments: { selector: "a" } })).error.message, /install it here/);
    assert.match((await h.rpc(3, "tools/list")).error.message, /install it here/);
  });

  it("extension mode, installed but asleep: not connected, and no install link", async () => {
    const socketDir = mkdtempSync(join(tmpdir(), "t3rnel-srv-asleep-"));
    const socket = join(socketDir, "bridge.sock");
    writeFileSync(socket, "");
    const h = server({ mode: "extension", timeoutMs: 1500, socket });
    const listed = (await h.rpc(1, "tools/list")).error.message;
    assert.match(listed, /installed but not connected right now/);
    assert.doesNotMatch(listed, /install it here/);
  });

  it("auto mode runs a standalone-capable tool standalone, and refuses an extension-only one", async () => {
    const fake = { profileDir: "/p", ensureStarted: async () => {}, syncTabs: async () => [], httpJson: async () => ({ Browser: "Fake/2" }), close: async () => {} };
    const socketDir = mkdtempSync(join(tmpdir(), "t3rnel-srv-present-"));
    const socket = join(socketDir, "bridge.sock");
    writeFileSync(socket, "");
    const h = server({ mode: "auto", standalone: fake, socket });
    assert.match((await h.rpc(1, "tools/call", { name: "session_health", arguments: {} })).result.content[0].text, /Fake\/2/);
    // A relay socket on disk means an extension is around but asleep: not "install it",
    // and no standalone hint for a tool that has no standalone form.
    const asleep = (await h.rpc(2, "tools/call", { name: "session_login", arguments: { domain: "x.com" } })).error.message;
    assert.match(asleep, /installed but not connected right now/);
    assert.doesNotMatch(asleep, /STANDALONE|standalone/);
  });
});

describe("with an extension connected", () => {
  it("lists its tools, forwards calls, and translates snapshot refs into selectors", async () => {
    const calls = [];
    const h = server({ mode: "extension" });
    const ws = await h.s.wsStarted;
    await extension(ws.port, (m) => {
      if (m.method === "tools/list") return { result: { tools: TOOLS } };
      calls.push(m.params);
      if (m.params.name === "browser_snapshot") {
        return { result: { content: [{ type: "text", text: JSON.stringify({ elements: [{ ref: "@e1", selector: "#go" }, { ref: 7 }] }) }] } };
      }
      return { result: { content: [{ type: "text", text: "ok" }] } };
    });
    await until(() => ws.isConnected());
    const listed = (await h.rpc(1, "tools/list")).result.tools.map((t) => t.name);
    assert.deepEqual(listed.sort(), ["session_click", "session_install", "session_read_url", "session_snapshot", "session_vault_list"]);
    assert.match((await h.rpc(2, "tools/call", { name: "session_click", arguments: { ref: "@e1" } })).error.message, /No snapshot to resolve @e1/);
    await h.rpc(3, "tools/call", { name: "session_snapshot", arguments: {} });
    await h.rpc(4, "tools/call", { name: "session_click", arguments: { ref: "@e1" } });
    await h.rpc(5, "tools/call", { name: "session_click", arguments: { ref: "@e1", selector: "#explicit" } });
    assert.match((await h.rpc(6, "tools/call", { name: "session_click", arguments: { ref: "@e9" } })).error.message, /@e9 is not in the last snapshot/);
    await h.rpc(7, "tools/call", { name: "session_vault_list", arguments: {} });
    assert.deepEqual(calls.filter((c) => c.name === "browser_click").map((c) => c.arguments), [{ selector: "#go" }, { selector: "#explicit" }]);
    assert.deepEqual(calls.find((c) => c.name === "browser_vault_list").arguments, {});
  });

  it("lists only the chosen tool profiles, yet still runs a tool that is not listed", async () => {
    const calls = [];
    const h = server({ mode: "extension", extra: { tools: parseToolProfiles("core") } });
    const ws = await h.s.wsStarted;
    await extension(ws.port, (m) => {
      if (m.method === "tools/list") return { result: { tools: TOOLS } };
      calls.push(m.params.name);
      return { result: { content: [{ type: "text", text: "ok" }] } };
    });
    await until(() => ws.isConnected());
    const listed = (await h.rpc(1, "tools/list")).result.tools.map((t) => t.name);
    assert.deepEqual(listed.sort(), ["session_click", "session_install", "session_read_url", "session_snapshot"]);
    const hidden = await h.rpc(2, "tools/call", { name: "session_vault_list", arguments: {} });
    assert.equal(hidden.error, undefined);
    assert.deepEqual(calls, ["browser_vault_list"]);
  });

  it("lists a profile's tools when it is asked for alongside core", async () => {
    const h = server({ mode: "extension", extra: { tools: parseToolProfiles("vault") } });
    const ws = await h.s.wsStarted;
    await extension(ws.port, (m) => (m.method === "tools/list" ? { result: { tools: TOOLS } } : { result: { content: [] } }));
    await until(() => ws.isConnected());
    const listed = (await h.rpc(1, "tools/list")).result.tools.map((t) => t.name);
    assert.deepEqual(listed.sort(), ["session_click", "session_install", "session_read_url", "session_snapshot", "session_vault_list"]);
  });

  it("filters the standalone tool list too, with no extension connected", async () => {
    const h = server({ mode: "standalone", extra: { tools: parseToolProfiles("core") } });
    const listed = (await h.rpc(1, "tools/list")).result.tools.map((t) => t.name);
    assert.ok(listed.includes("session_click"));
    assert.ok(!listed.includes("session_vault_list"), "a vault tool leaked into the core profile");
  });

  it("resolves refs from the extension's compact snapshot, handing the ref on as the selector", async () => {
    const calls = [];
    const h = server({ mode: "extension" });
    const ws = await h.s.wsStarted;
    const compact = ['url: https://shop.test/', 'title: Shop', '- button "Buy" [@e1]', '- textbox "Email" [@e2, type=email]', '- link [@e3, sel="nav > a"]'].join("\n");
    await extension(ws.port, (m) => {
      if (m.method === "tools/list") return { result: { tools: TOOLS } };
      calls.push(m.params);
      return { result: { content: [{ type: "text", text: m.params.name === "browser_snapshot" ? compact : "ok" }] } };
    });
    await until(() => ws.isConnected());
    await h.rpc(1, "tools/call", { name: "session_snapshot", arguments: {} });
    assert.equal((await h.rpc(2, "tools/call", { name: "session_click", arguments: { ref: "@e2" } })).error, undefined);
    assert.equal((await h.rpc(3, "tools/call", { name: "session_click", arguments: { ref: "e3" } })).error, undefined);
    assert.match((await h.rpc(4, "tools/call", { name: "session_click", arguments: { ref: "@e9" } })).error.message, /@e9 is not in the last snapshot/);
    assert.deepEqual(calls.filter((c) => c.name === "browser_click").map((c) => c.arguments), [{ selector: "@e2" }, { selector: "@e3" }]);
  });

  it("passes the snapshot format through to the extension and refuses an unknown one", async () => {
    const seen = [];
    const h = server({ mode: "extension" });
    const ws = await h.s.wsStarted;
    await extension(ws.port, (m) => {
      if (m.method === "tools/list") return { result: { tools: TOOLS } };
      seen.push(m.params.arguments);
      return { result: { content: [{ type: "text", text: "- link [@e1]" }] } };
    });
    await until(() => ws.isConnected());
    await h.rpc(1, "tools/call", { name: "session_snapshot", arguments: { format: "json" } });
    assert.deepEqual(seen, [{ format: "json" }]);
    assert.ok((await h.rpc(2, "tools/call", { name: "session_snapshot", arguments: { format: "xml" } })).error);
  });

  it("ignores a snapshot whose text is not JSON or has no elements", async () => {
    const h = server({ mode: "extension" });
    const ws = await h.s.wsStarted;
    let n = 0;
    await extension(ws.port, (m) => {
      if (m.method === "tools/list") return { result: { tools: TOOLS } };
      return { result: { content: [{ type: "text", text: n++ === 0 ? "not json" : JSON.stringify({ elements: "no" }) }] } };
    });
    await until(() => ws.isConnected());
    await h.rpc(1, "tools/call", { name: "session_snapshot", arguments: {} });
    await h.rpc(2, "tools/call", { name: "session_snapshot", arguments: {} });
    assert.match((await h.rpc(3, "tools/call", { name: "session_click", arguments: { ref: "@e1" } })).error.message, /No snapshot to resolve/);
  });

  it("refuses an extension whose tool list is malformed or incomplete", async () => {
    for (const [answer, message] of [
      [{ result: { nope: true } }, /invalid tools\/list response/],
      [{ result: { tools: [{ name: "not_browser", description: "x", inputSchema: {} }] } }, /incomplete browser tool registry/],
      [{ result: { tools: [] } }, /incomplete browser tool registry/],
      [{ result: { tools: [{ name: "browser_x", description: 3, inputSchema: {} }] } }, /incomplete/],
    ]) {
      const h = server({ mode: "extension" });
      const ws = await h.s.wsStarted;
      await extension(ws.port, () => answer);
      await until(() => ws.isConnected());
      assert.match((await h.rpc(1, "tools/list")).error.message, message);
    }
  });

  it("an extension's error answer becomes the tool call's error", async () => {
    const h = server({ mode: "extension" });
    const ws = await h.s.wsStarted;
    await extension(ws.port, (m) => (m.method === "tools/list" ? { result: { tools: TOOLS } } : { error: { message: "[Pro Required] vault" } }));
    await until(() => ws.isConnected());
    assert.deepEqual((await h.rpc(1, "tools/call", { name: "session_vault_list", arguments: {} })).error, { code: -32000, message: "[Pro Required] vault" });
  });

  it("finishes an in-flight call before closing when stdin ends", async () => {
    const h = server({ mode: "extension" });
    const ws = await h.s.wsStarted;
    let answer;
    await extension(ws.port, (m) => {
      if (m.method === "tools/list") return { result: { tools: TOOLS } };
      return new Promise((r) => { answer = r; }) && undefined;
    });
    await until(() => ws.isConnected());
    h.send({ jsonrpc: "2.0", id: "slow", method: "tools/call", params: { name: "session_vault_list", arguments: {} } });
    await new Promise((r) => setTimeout(r, 150));
    h.stdin.end();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ws.isConnected(), true, "the endpoint closed while a call was still in flight");
    void answer;
  });
});

describe("the WebSocket endpoint cannot bind", () => {
  it("logs why and keeps serving over the legacy relay path", async () => {
    const h = server({ mode: "standalone", extra: { wsBasePort: 70_000 } });
    assert.equal(await h.s.wsStarted, null);
    assert.ok(h.logs.join("").includes("WebSocket endpoint unavailable"));
    assert.deepEqual((await h.rpc("p", "ping")).result, {});
  });
});

describe("the legacy relay client", () => {
  async function relayServer(onRequest) {
    const dir = mkdtempSync(join(tmpdir(), "t3rnel-relay-"));
    const path = join(dir, "bridge.sock");
    const sockets = [];
    const srv = net.createServer((socket) => {
      sockets.push(socket);
      const dec = createFrameDecoder((m) => onRequest(m, socket));
      socket.on("data", (c) => dec.push(c));
      socket.on("error", () => {});
    });
    await new Promise((r) => srv.listen(path, r));
    servers.push(() => { for (const s of sockets) s.destroy(); srv.close(); });
    return { path, sockets };
  }

  it("refuses a call while disconnected, and answers from frames by id", async () => {
    const r = await relayServer((m, socket) => {
      socket.write(encodeFrame(null));
      socket.write(encodeFrame({ id: "unknown", result: 1 }));
      if (m.method === "a") socket.write(encodeFrame({ id: m.id, result: "A" }));
      if (m.method === "b") socket.write(encodeFrame({ id: m.id, error: { message: "B failed" } }));
      if (m.method === "c") socket.write(encodeFrame({ id: m.id, error: {} }));
    });
    const logs = [];
    const client = new RelayClient(r.path, { log: (l) => logs.push(l), timeoutMs: 500 });
    await assert.rejects(client.call({ method: "a" }), /is not connected/);
    client.connect();
    await until(() => client.isConnected());
    assert.equal(await client.call({ method: "a" }), "A");
    await assert.rejects(client.call({ method: "b" }), /^Error: B failed$/);
    await assert.rejects(client.call({ method: "c" }), /^Error: Tool execution failed$/);
    await assert.rejects(client.call({ method: "silent" }, 80), /timed out after 80ms/);
    client.close();
    assert.ok(logs.some((l) => l.includes("connected to relay")));
  });

  it("drops a relay that sends a malformed frame, fails pending calls, and retries", async () => {
    const r = await relayServer((m, socket) => {
      const bad = Buffer.alloc(6);
      bad.writeUInt32LE(2, 0);
      bad.write("{x", 4);
      socket.write(bad);
    });
    const logs = [];
    const client = new RelayClient(r.path, { log: (l) => logs.push(l), timeoutMs: 2000 });
    client.connect();
    await until(() => client.isConnected());
    await assert.rejects(client.call({ method: "x" }), /is not connected/);
    await until(() => logs.some((l) => l.includes("relay connection lost; retrying")));
    assert.ok(logs.some((l) => l.includes("relay framing error")));
    await until(() => client.isConnected());
    client.close();
    await assert.rejects(client.call({ method: "y" }), /is not connected/);
  });

  it("names a write that fails and a shutdown with calls in flight", async () => {
    const r = await relayServer(() => {});
    const client = new RelayClient(r.path, { log: () => {}, timeoutMs: 5000 });
    client.connect();
    await until(() => client.isConnected());
    const inFlight = client.call({ method: "hang" });
    client.close();
    await assert.rejects(inFlight, /Server shutting down/);
    const writer = new RelayClient(r.path, { log: () => {}, timeoutMs: 5000 });
    writer.connected = true;
    writer.socket = { write: (_data, cb) => cb(new Error("EPIPE")) };
    await assert.rejects(writer.call({ method: "x" }), /Failed to reach the browser session: EPIPE/);
  });
});

describe("the remaining server edges", () => {
  it("answers id-less invalid requests with id null, and an id-less call as id null", async () => {
    const h = server({ mode: "standalone" });
    h.send({ jsonrpc: "1.0" });
    h.send({ jsonrpc: "2.0" });
    h.send({ jsonrpc: "2.0", method: "ping" });
    await until(() => h.lines.length >= 3);
    assert.deepEqual(h.lines.map((l) => [l.id, l.error?.code ?? "ok"]), [[null, -32600], [null, -32600], [null, "ok"]]);
  });

  it("runs tools whose arguments were omitted altogether", async () => {
    const fake = { profileDir: "/p", ensureStarted: async () => {}, syncTabs: async () => [], httpJson: async () => ({ Browser: "Fake/3" }), close: async () => {} };
    for (const mode of ["standalone", "auto"]) {
      const h = server({ mode, standalone: fake });
      assert.match((await h.rpc(1, "tools/call", { name: "session_health" })).result.content[0].text, /Fake\/3/);
      assert.match((await h.rpc(2, "tools/call", { name: "session_install" })).result.content[0].text, /npx -y @t3ratech\/mcp-session-bridge/);
    }
  });

  it("forwards an argument-less call, a store_login, and refuses a name the extension does not list", async () => {
    const calls = [];
    const h = server({ mode: "extension" });
    const ws = await h.s.wsStarted;
    const tools = [...TOOLS, { name: "browser_vault_save", description: "Save", inputSchema: { type: "object", properties: { domain: { type: "string" } }, additionalProperties: false } }];
    await extension(ws.port, (m) => {
      if (m.method === "tools/list") return { result: { tools } };
      calls.push(m.params.name);
      return { result: m.params.name === "browser_snapshot" ? {} : { content: [{ type: "text", text: "ok" }] } };
    });
    await until(() => ws.isConnected());
    await h.rpc(1, "tools/call", { name: "session_vault_list" });
    await h.rpc(2, "tools/call", { name: "session_store_login", arguments: { domain: "x.com", username: "u", password: "p" } });
    await h.rpc(3, "tools/call", { name: "session_snapshot" });
    assert.match((await h.rpc(4, "tools/call", { name: "session_unknown_to_extension" })).error.message, /Unknown tool: session_unknown_to_extension/);
    assert.deepEqual(calls, ["browser_vault_list", "browser_vault_save", "browser_snapshot"]);
  });

  it("an extension that fails its tools/list answers the list with -32000", async () => {
    const h = server({ mode: "extension" });
    const ws = await h.s.wsStarted;
    await extension(ws.port, () => ({ error: { message: "worker exploded" } }));
    await until(() => ws.isConnected());
    assert.deepEqual((await h.rpc(1, "tools/list")).error, { code: -32000, message: "worker exploded" });
  });

  it("calls through the legacy relay when that is the transport connected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3rnel-srv-relay-"));
    const path = join(dir, "bridge.sock");
    const srv = net.createServer((socket) => {
      const dec = createFrameDecoder((m) => {
        if (m.method === "tools/list") socket.write(encodeFrame({ id: m.id, result: { tools: TOOLS } }));
        else socket.write(encodeFrame({ id: m.id, result: { content: [{ type: "text", text: `relayed ${m.params.name}` }] } }));
      });
      socket.on("data", (c) => dec.push(c));
    });
    await new Promise((r) => srv.listen(path, r));
    servers.push(() => srv.close());
    const h = server({ mode: "extension", socket: path });
    await until(() => h.s.relay.isConnected());
    assert.equal((await h.rpc(1, "tools/call", { name: "session_vault_list", arguments: {} })).result.content[0].text, "relayed browser_vault_list");
  });
});

describe("the last server paths", () => {
  it("maps session_login to the vault, and passes a plain selector through untouched", async () => {
    const calls = [];
    const h = server({ mode: "extension" });
    const ws = await h.s.wsStarted;
    await extension(ws.port, (m) => {
      if (m.method === "tools/list") return { result: { tools: TOOLS } };
      calls.push([m.params.name, m.params.arguments]);
      return { result: { content: [{ type: "text", text: "ok" }] } };
    });
    await until(() => ws.isConnected());
    await h.rpc(1, "tools/call", { name: "session_login", arguments: { domain: "x.com" } });
    await h.rpc(2, "tools/call", { name: "session_click", arguments: { selector: "#plain" } });
    assert.deepEqual(calls, [["browser_vault_load", { domain: "x.com" }], ["browser_click", { selector: "#plain" }]]);
  });

  it("writes relay progress to stderr when no logger is given", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3rnel-relay-log-"));
    const path = join(dir, "bridge.sock");
    const srv = net.createServer(() => {});
    await new Promise((r) => srv.listen(path, r));
    const written = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return original(chunk, ...rest); };
    try {
      const client = new RelayClient(path);
      client.connect();
      await until(() => client.isConnected());
      client.close();
    } finally {
      process.stderr.write = original;
      srv.close();
    }
    assert.ok(written.some((w) => w.includes("connected to relay")));
  });
});

describe("tool profiles from the environment and the command line", () => {
  const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));
  const run = (args, env = {}) => spawnSync(process.execPath, [serverPath, ...args], {
    env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "t3rnel-cli-home-")), T3RNEL_SESSION_MODE: "standalone", ...env },
    input: "", encoding: "utf8", timeout: 15000,
  });

  it("refuses an unknown profile at startup, naming it", () => {
    const bogus = run(["--tools", "bogus"]);
    assert.notEqual(bogus.status, 0);
    assert.match(bogus.stderr, /unknown tool profile "bogus"/);
    const fromEnv = run([], { T3RNEL_SESSION_TOOLS: "nope" });
    assert.notEqual(fromEnv.status, 0);
    assert.match(fromEnv.stderr, /unknown tool profile "nope"/);
  });

  it("refuses --tools given no value rather than listing everything", () => {
    const result = run(["--tools"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--tools needs a value/);
  });

  it("documents both ways to choose profiles", () => {
    const help = run(["--help"]).stdout;
    assert.match(help, /T3RNEL_SESSION_TOOLS/);
    assert.match(help, /--tools core,network/);
  });
});

describe("session_read_url through the server", () => {
  let page;
  let origin;
  before(async () => {
    const http = await import("node:http");
    page = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/markdown" }); res.end("# Served\n\nbody\n"); });
    await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${page.address().port}`;
  });
  after(() => { page.closeAllConnections(); page.close(); });

  it("is listed and answers with no browser at all", async () => {
    const h = server({ mode: "standalone", extra: { readUrlPolicy: () => true } });
    assert.ok((await h.rpc(1, "tools/list")).result.tools.some((t) => t.name === "session_read_url"));
    const result = await h.rpc(2, "tools/call", { name: "session_read_url", arguments: { url: `${origin}/x` } });
    assert.match(result.result.content[0].text, /source: served as markdown[\s\S]*# Served/);
  });

  it("is listed and answered here when an extension is connected, without asking the extension", async () => {
    const calls = [];
    const h = server({ mode: "extension", extra: { readUrlPolicy: () => true } });
    const ws = await h.s.wsStarted;
    await extension(ws.port, (m) => {
      if (m.method === "tools/list") return { result: { tools: TOOLS } };
      calls.push(m.params.name);
      return { result: { content: [] } };
    });
    await until(() => ws.isConnected());
    assert.ok((await h.rpc(1, "tools/list")).result.tools.some((t) => t.name === "session_read_url"));
    const result = await h.rpc(2, "tools/call", { name: "session_read_url", arguments: { url: origin, outline: true } });
    assert.match(result.result.content[0].text, /\n- Served$/);
    assert.deepEqual(calls, []);
  });

  it("refuses a loopback address under the default policy, as a tool error naming why", async () => {
    const h = server({ mode: "standalone" });
    const result = await h.rpc(1, "tools/call", { name: "session_read_url", arguments: { url: `${origin}/` } });
    assert.match(result.error.message, /not a public address/);
  });

  it("validates its arguments against its schema", async () => {
    const h = server({ mode: "standalone" });
    assert.ok((await h.rpc(1, "tools/call", { name: "session_read_url", arguments: {} })).error);
    assert.ok((await h.rpc(2, "tools/call", { name: "session_read_url", arguments: { url: origin, maxChars: 0 } })).error);
  });
});
