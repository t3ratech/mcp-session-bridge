/**
 * The native host's routing and failure paths, driven in-process: a real Unix socket for
 * the MCP side, and a stream pair standing in for Chrome's stdio.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startNativeHost } from "../src/native-host.js";
import { createFrameDecoder, encodeFrame } from "../src/framing.js";

const hosts = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.shutdown(0);
});

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "t3rnel-host-"));
  const socketPath = join(dir, "bridge.sock");
  const input = new PassThrough();
  const output = new PassThrough();
  const toChrome = [];
  createFrameDecoder((m) => toChrome.push(m));
  const outDecoder = createFrameDecoder((m) => toChrome.push(m));
  output.on("data", (c) => outDecoder.push(c));
  const exits = [];
  let resolveExit;
  const exited = new Promise((r) => { resolveExit = r; });
  const host = startNativeHost({ socketPath, input, output, onExit: (code) => { exits.push(code); resolveExit(code); } });
  hosts.push(host);
  return { dir, socketPath, input, output, toChrome, exits, exited, host };
}

const listening = (server) => new Promise((r) => (server.listening ? r() : server.once("listening", r)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(socketPath) {
  const socket = net.createConnection({ path: socketPath });
  const received = [];
  const decoder = createFrameDecoder((m) => received.push(m));
  socket.on("data", (c) => decoder.push(c));
  return { socket, received, ready: new Promise((r) => socket.once("connect", r)) };
}

describe("routing between MCP clients and Chrome", () => {
  it("answers a non-object request with a JSON-RPC Invalid Request, and forwards nothing", async () => {
    const h = harness();
    await listening(h.host.server);
    const c = client(h.socketPath);
    await c.ready;
    c.socket.write(encodeFrame([1, 2]));
    await wait(100);
    assert.deepEqual(c.received, [{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: body must be a JSON-RPC 2.0 object" } }]);
    assert.deepEqual(h.toChrome, []);
    c.socket.destroy();
  });

  it("forwards a notification to nobody and keeps nothing pending", async () => {
    const h = harness();
    await listening(h.host.server);
    const c = client(h.socketPath);
    await c.ready;
    c.socket.write(encodeFrame({ jsonrpc: "2.0", method: "notifications/initialized" }));
    await wait(100);
    assert.equal(h.host.pending.size, 0);
    assert.deepEqual(h.toChrome, []);
    c.socket.destroy();
  });

  it("ignores a frame from Chrome that is not a response it is waiting for", async () => {
    const h = harness();
    await listening(h.host.server);
    const c = client(h.socketPath);
    await c.ready;
    h.input.write(encodeFrame("not an object"));
    h.input.write(encodeFrame({ id: 5 }));
    h.input.write(encodeFrame({ id: "9:unknown", result: {} }));
    await wait(100);
    assert.deepEqual(c.received, []);
    c.socket.destroy();
  });

  it("drops a response whose client has gone, instead of writing to a dead socket", async () => {
    const h = harness();
    await listening(h.host.server);
    const c = client(h.socketPath);
    await c.ready;
    c.socket.write(encodeFrame({ jsonrpc: "2.0", id: 1, method: "tools/call" }));
    await wait(100);
    const rewritten = h.toChrome[0].id;
    // The connection is dropped from the map but the pending entry is re-added, as a
    // response racing the close would find it.
    h.host.pending.set("99:1", { conn: 99, id: 1 });
    h.input.write(encodeFrame({ id: "99:1", result: {} }));
    await wait(50);
    assert.equal(h.host.pending.has("99:1"), false);
    assert.equal(typeof rewritten, "string");
    c.socket.destroy();
  });

  it("evicts the oldest request past the pending limit and tells its owner why", async () => {
    const h = harness();
    await listening(h.host.server);
    const c = client(h.socketPath);
    await c.ready;
    for (let i = 0; i < 1025; i++) c.socket.write(encodeFrame({ jsonrpc: "2.0", id: i, method: "tools/call" }));
    for (let i = 0; i < 40 && c.received.length === 0; i++) await wait(50);
    assert.deepEqual(c.received[0], { jsonrpc: "2.0", id: 0, error: { code: -32000, message: "Dropped: more than 1024 requests were outstanding" } });
    assert.equal(h.host.pending.size, 1024);
    c.socket.destroy();
  });

  it("evicts silently when the evicted request's client has already gone", async () => {
    const h = harness();
    await listening(h.host.server);
    for (let i = 0; i < 1024; i++) h.host.pending.set(`77:${i}`, { conn: 77, id: i });
    const c = client(h.socketPath);
    await c.ready;
    c.socket.write(encodeFrame({ jsonrpc: "2.0", id: "new", method: "tools/call" }));
    await wait(100);
    assert.equal(h.host.pending.has("77:0"), false);
    assert.deepEqual(c.received, []);
    c.socket.destroy();
  });

  it("disconnects a client that sends a malformed frame", async () => {
    const h = harness();
    await listening(h.host.server);
    const c = client(h.socketPath);
    await c.ready;
    const closed = new Promise((r) => c.socket.once("close", r));
    const bad = Buffer.alloc(4 + 3);
    bad.writeUInt32LE(3, 0);
    bad.write("{{{", 4);
    c.socket.write(bad);
    await closed;
    assert.equal(h.host.connections.size, 0);
  });
});

describe("fatal paths end through onExit", () => {
  it("exits 1 on a malformed frame from Chrome", async () => {
    const h = harness();
    await listening(h.host.server);
    const bad = Buffer.alloc(4 + 2);
    bad.writeUInt32LE(2, 0);
    bad.write("{x", 4);
    h.input.write(bad);
    assert.equal(await h.exited, 1);
  });

  it("refuses to half-serve when another live host owns the socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3rnel-host-live-"));
    const socketPath = join(dir, "bridge.sock");
    const owner = net.createServer(() => {});
    await new Promise((r) => owner.listen(socketPath, r));
    let resolveExit;
    const exited = new Promise((r) => { resolveExit = r; });
    const host = startNativeHost({ socketPath, input: new PassThrough(), output: new PassThrough(), onExit: resolveExit });
    assert.equal(await exited, 1);
    host.shutdown(1);
    await new Promise((r) => owner.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  it("replaces a stale socket file left by a crashed host, then listens", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3rnel-host-stale-"));
    const socketPath = join(dir, "bridge.sock");
    writeFileSync(socketPath, "");
    const host = startNativeHost({ socketPath, input: new PassThrough(), output: new PassThrough(), onExit: () => {} });
    hosts.push(host);
    await listening(host.server);
    assert.ok(existsSync(socketPath));
  });

  it("exits 1 when the socket cannot be listened on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3rnel-host-bad-"));
    // A directory where the socket should be: listen fails with EADDRINUSE/EISDIR-like errors.
    const socketPath = join(dir, "nested", "..", "missing-parent", "x", "bridge.sock");
    let resolveExit;
    const exited = new Promise((r) => { resolveExit = r; });
    const host = startNativeHost({ socketPath: join(dir, "a".repeat(200), "bridge.sock"), input: new PassThrough(), output: new PassThrough(), onExit: resolveExit });
    assert.equal(await exited, 1);
    host.shutdown(1);
    void socketPath;
  });

  it("removes its signal handlers when it shuts down", async () => {
    const before = process.listenerCount("SIGTERM");
    const h = harness();
    await listening(h.host.server);
    assert.equal(process.listenerCount("SIGTERM"), before + 1);
    h.host.shutdown(0);
    assert.equal(process.listenerCount("SIGTERM"), before);
    hosts.splice(hosts.indexOf(h.host), 1);
  });

  it("shuts down with 1 when Chrome's stdin errors, and only once", async () => {
    const h = harness();
    await listening(h.host.server);
    h.input.emit("error", new Error("EPIPE"));
    assert.equal(await h.exited, 1);
    h.host.shutdown(0);
    await wait(50);
    assert.deepEqual(h.exits, [1]);
    hosts.splice(hosts.indexOf(h.host), 1);
  });
});

describe("shutdown's cleanup", () => {
  it("leaves no socket file behind after shutting down", async () => {
    const h = harness();
    await listening(h.host.server);
    assert.ok(existsSync(h.socketPath));
    h.host.shutdown(0);
    assert.equal(await h.exited, 0);
    assert.equal(existsSync(h.socketPath), false, "the relay socket survived shutdown");
    hosts.splice(hosts.indexOf(h.host), 1);
  });

  it("shuts down cleanly when the socket file is already gone", async () => {
    const h = harness();
    await listening(h.host.server);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(h.socketPath);
    h.host.shutdown(0);
    assert.equal(await h.exited, 0);
    hosts.splice(hosts.indexOf(h.host), 1);
  });
});
