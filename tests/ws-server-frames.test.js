/**
 * The bridge's WebSocket endpoint against a scripted extension: frame sizes both ways,
 * the caps and protocol violations, denial, error answers, timeouts, and the HTTP edges.
 */
import { describe, it, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

// The endpoint writes its pairing id and "extension seen" marker under $HOME.
before(() => { process.env.HOME = mkdtempSync(join(tmpdir(), "t3rnel-wsserver-home-")); });

const { startExtensionWebSocket } = await import("../src/ws-server.js");
const { connectWebSocket } = await import("../src/ws.js");

const opened = [];
afterEach(() => { for (const c of opened.splice(0)) c.close(); });

async function bridge(options = {}) {
  const readiness = [];
  const b = await startExtensionWebSocket({ basePort: 0, log: () => {}, onReadyChange: (r) => readiness.push(r), ...options });
  opened.push(b);
  return { b, readiness };
}

/** An extension: connects, optionally sends ready, and answers calls with `answer`. */
async function extension(port, { ready = true, answer } = {}) {
  const inbox = [];
  const early = [];
  let ws;
  const handle = (m) => {
    if (m.type === "t3rnel.bridge.hello" && ready) ws.send(JSON.stringify({ type: "t3rnel.bridge.ready" }));
    else if (m.id && answer) answer(m, ws);
  };
  // The hello can arrive in the same read as the handshake, before `ws` exists.
  ws = await connectWebSocket(`ws://127.0.0.1:${port}/session`, {
    onMessage: (text) => {
      const m = JSON.parse(text);
      inbox.push(m);
      if (ws) handle(m); else early.push(m);
    },
  });
  for (const m of early.splice(0)) handle(m);
  opened.push({ close: () => ws.close() });
  return { ws, inbox };
}

const until = async (check, ms = 3000) => { for (let t = 0; t < ms && !check(); t += 20) await new Promise((r) => setTimeout(r, 20)); };

/** A raw client that completes the handshake and then writes whatever bytes a case needs. */
async function rawClient(port) {
  const socket = net.createConnection({ port, host: "127.0.0.1" });
  const key = randomBytes(16).toString("base64");
  await new Promise((r) => socket.once("connect", r));
  socket.write(`GET /session HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let head = "";
  await new Promise((r) => socket.on("data", function onData(c) { head += c.toString("latin1"); if (head.includes("\r\n\r\n")) { socket.off("data", onData); r(); } }));
  assert.match(head, new RegExp(createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64").replace(/[+/=]/g, "\\$&")));
  const closed = new Promise((r) => socket.once("close", r));
  return { socket, closed };
}

describe("calls through the endpoint", () => {
  it("carries a response too large for a 16-bit length, and a request larger than 64 KiB", async () => {
    const { b } = await bridge();
    const big = "x".repeat(200_000);
    await extension(b.port, { answer: (m, ws) => ws.send(JSON.stringify({ id: m.id, result: { echoed: m.params.text.length, big } })) });
    await until(() => b.isConnected());
    const result = await b.call({ method: "tools/call", params: { text: "y".repeat(70_000) } });
    assert.equal(result.echoed, 70_000);
    assert.equal(result.big.length, 200_000);
  });

  it("turns an error answer into a rejection carrying its message, or a generic one", async () => {
    const { b } = await bridge();
    let n = 0;
    await extension(b.port, { answer: (m, ws) => ws.send(JSON.stringify(n++ === 0 ? { id: m.id, error: { message: "[Pro Required] vault" } } : { id: m.id, error: { code: 1 } })) });
    await until(() => b.isConnected());
    await assert.rejects(b.call({ method: "x" }), /\[Pro Required\] vault/);
    await assert.rejects(b.call({ method: "x" }), /^Error: Tool execution failed$/);
  });

  it("ignores garbage, non-objects and answers to requests it never made", async () => {
    const { b } = await bridge();
    await extension(b.port, { answer: (m, ws) => {
      ws.send("not json");
      ws.send("42");
      ws.send(JSON.stringify({ id: "w-unknown", result: 1 }));
      ws.send(JSON.stringify({ id: m.id, result: "the real one" }));
    } });
    await until(() => b.isConnected());
    assert.equal(await b.call({ method: "x" }), "the real one");
  });

  it("times a call out by name when the browser never answers", async () => {
    const { b } = await bridge();
    await extension(b.port, { answer: () => {} });
    await until(() => b.isConnected());
    await assert.rejects(b.call({ method: "x" }, 60), /Tool call timed out after 60ms waiting for the browser session/);
  });

  it("refuses a call before any extension has approved it", async () => {
    const { b } = await bridge();
    await assert.rejects(b.call({ method: "x" }), /The extension has not approved this bridge yet/);
    assert.equal(b.hasExtensionSocket(), false);
  });

  it("fails every in-flight call when the extension goes away, and reports the disconnect", async () => {
    const { b, readiness } = await bridge();
    let disconnected = 0;
    b.onDisconnect = () => disconnected++;
    assert.equal(typeof b.onDisconnect, "function");
    const ext = await extension(b.port, { answer: () => {} });
    await until(() => b.isConnected());
    const call = b.call({ method: "x" });
    ext.ws.close();
    await assert.rejects(call, /The extension connection closed mid-call/);
    await until(() => disconnected > 0);
    assert.deepEqual(readiness, [true, false]);
    assert.equal(b.extensionExpected(), true);
    b.onDisconnect = undefined;
  });
});

describe("pairing", () => {
  it("closes a connection whose user declined the pairing card", async () => {
    const { b } = await bridge();
    let closes = 0;
    const ws = await connectWebSocket(`ws://127.0.0.1:${b.port}/session`, { onClose: () => closes++ });
    ws.send(JSON.stringify({ type: "t3rnel.bridge.denied" }));
    await until(() => closes > 0);
    assert.equal(closes, 1);
    assert.equal(b.isConnected(), false);
  });

  it("counts a repeated ready frame once", async () => {
    const { b, readiness } = await bridge();
    const ext = await extension(b.port);
    await until(() => b.isConnected());
    ext.ws.send(JSON.stringify({ type: "t3rnel.bridge.ready" }));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(readiness, [true]);
  });
});

describe("protocol violations and control frames", () => {
  it("drops a client that sends an unmasked frame, as no browser would", async () => {
    const { b } = await bridge();
    const c = await rawClient(b.port);
    c.socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
    await c.closed;
  });

  it("drops a client that declares a frame over the 64 MiB cap", async () => {
    const { b } = await bridge();
    const c = await rawClient(b.port);
    const header = Buffer.alloc(14);
    header[0] = 0x82; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(64 * 1024 * 1024 + 1), 2);
    c.socket.write(header);
    await c.closed;
  });

  it("drops a fragmented message whose total passes the cap", async () => {
    const { b } = await bridge();
    const c = await rawClient(b.port);
    const piece = Buffer.alloc(33 * 1024 * 1024);
    const frame = (opcode) => {
      const h = Buffer.alloc(14);
      h[0] = opcode; h[1] = 0x80 | 127; h.writeBigUInt64BE(BigInt(piece.length), 2);
      h.fill(0, 10, 14); // zero mask: payload passes through unchanged
      return Buffer.concat([h, piece]);
    };
    c.socket.write(frame(0x02));
    c.socket.write(frame(0x00));
    await c.closed;
  });

  it("answers a ping with a pong, ignores a pong, and ends the session on a close frame", async () => {
    const { b } = await bridge();
    const c = await rawClient(b.port);
    const got = [];
    c.socket.on("data", (d) => got.push(d));
    const masked = (opcode, text) => {
      const p = Buffer.from(text);
      return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | p.length]), Buffer.alloc(4), p]);
    };
    c.socket.write(masked(0x9, "ping!"));
    c.socket.write(masked(0xA, "pong"));
    await until(() => Buffer.concat(got).includes(Buffer.from("ping!")));
    const all = Buffer.concat(got);
    const at = all.indexOf(Buffer.from([0x8A, 5]));
    assert.ok(at >= 0, "no pong frame came back");
    c.socket.write(masked(0x8, ""));
    await c.closed;
  });

  it("drops a peer that half-closes without a close frame", async () => {
    const { b } = await bridge();
    const c = await rawClient(b.port);
    c.socket.end();
    await c.closed;
  });
});

describe("the HTTP surface", () => {
  it("answers /health in words and anything else with 404", async () => {
    const { b } = await bridge({ version: "9.9.9" });
    const health = await (await fetch(`http://127.0.0.1:${b.port}/health`)).json();
    assert.deepEqual(health, { ok: true, server: "mcp-session-bridge", version: "9.9.9", extensions: 0 });
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/other`)).status, 404);
  });

  it("destroys an upgrade that is not a WebSocket handshake", async () => {
    const { b } = await bridge();
    for (const headers of ["Upgrade: websocket\r\nConnection: Upgrade", "Upgrade: h2c\r\nConnection: Upgrade\r\nSec-WebSocket-Key: abc"]) {
      const s = net.createConnection({ port: b.port, host: "127.0.0.1" });
      await new Promise((r) => s.once("connect", r));
      s.write(`GET /session HTTP/1.1\r\nHost: x\r\n${headers}\r\n\r\n`);
      await new Promise((r) => s.once("close", r));
    }
  });

  it("names the range when every port in it is taken", async () => {
    const holders = [];
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    let base = probe.address().port;
    await new Promise((r) => probe.close(r));
    base = Math.min(base, 65_000);
    for (let i = 0; i < 8; i++) {
      const h = net.createServer();
      await new Promise((resolve, reject) => { h.once("error", reject); h.listen(base + i, "127.0.0.1", resolve); }).catch(() => {});
      holders.push(h);
    }
    try {
      await assert.rejects(startExtensionWebSocket({ basePort: base, log: () => {} }), new RegExp(`No free loopback port in ${base}–${base + 7}`));
    } finally {
      for (const h of holders) h.close();
    }
  });

  it("surfaces a listen error that is not a port conflict", async () => {
    await assert.rejects(startExtensionWebSocket({ basePort: 70_000, log: () => {} }), /port|range|ERR_SOCKET_BAD_PORT/i);
  });
});

describe("the remaining endpoint edges", () => {
  it("carries on when the pairing id and marker cannot be written", async () => {
    const saved = process.env.HOME;
    process.env.HOME = "/dev/null/not-a-dir";
    try {
      const { b } = await bridge();
      const ext = await extension(b.port);
      await until(() => b.isConnected());
      ext.ws.close();
      await until(() => !b.isConnected());
      assert.equal(b.extensionExpected(), true);
    } finally {
      process.env.HOME = saved;
    }
  });

  it("reads a frame whose extended length header arrives in pieces, and data sent with the upgrade", async () => {
    const { b } = await bridge();
    const socket = net.createConnection({ port: b.port, host: "127.0.0.1" });
    socket.setNoDelay(true);
    await new Promise((r) => socket.once("connect", r));
    const text = JSON.stringify({ type: "t3rnel.bridge.ready", pad: "p".repeat(200) });
    const payload = Buffer.from(text);
    const small = Buffer.from(JSON.stringify({ type: "t3rnel.bridge.ready" }));
    const smallFrame = Buffer.concat([Buffer.from([0x81, 0x80 | small.length]), Buffer.alloc(4), small]);
    // Handshake and a first frame in one write: the frame arrives as the upgrade's `head`.
    socket.write(`GET /session HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    socket.write(smallFrame);
    await until(() => b.isConnected());
    const header16 = Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]);
    socket.write(header16.subarray(0, 2));
    await new Promise((r) => setTimeout(r, 150));
    socket.write(Buffer.concat([header16.subarray(2), Buffer.alloc(4), payload]));
    const header64 = Buffer.alloc(10);
    header64[0] = 0x81; header64[1] = 0x80 | 127; header64.writeBigUInt64BE(BigInt(payload.length), 2);
    socket.write(header64.subarray(0, 4));
    await new Promise((r) => setTimeout(r, 150));
    socket.write(Buffer.concat([header64.subarray(4), Buffer.alloc(4), payload]));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(b.isConnected(), true);
    socket.destroy();
  });
});

describe("the endpoint's default logger", () => {
  it("writes to stderr when none is given", async () => {
    const written = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { written.push(String(chunk)); return original(chunk, ...rest); };
    let b;
    try {
      b = await startExtensionWebSocket({ basePort: 0 });
    } finally {
      process.stderr.write = original;
    }
    b.close();
    assert.ok(written.some((w) => w.includes("listening for the extension")));
  });
});
