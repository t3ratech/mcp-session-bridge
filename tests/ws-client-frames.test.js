/**
 * The WebSocket client against a raw TCP peer that writes exactly the bytes each case
 * needs: every length encoding, the caps, fragmentation, control frames and bad
 * handshakes.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createHash } from "node:crypto";
import { connectWebSocket, headerValue } from "../src/ws.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const servers = [];
const peerSockets = [];
afterEach(() => {
  for (const s of peerSockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) s.close();
});

/** A peer that runs `script(socket, frames)` after answering the handshake with `answer`. */
async function peer({ answer = "ok", script = () => {} } = {}) {
  const received = [];
  const server = net.createServer((socket) => {
    peerSockets.push(socket);
    let head = "";
    let upgraded = false;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (!upgraded) {
        head += chunk.toString("latin1");
        if (!head.includes("\r\n\r\n")) return;
        upgraded = true;
        const key = headerValue(head, "sec-websocket-key");
        const accept = createHash("sha1").update(key + GUID).digest("base64");
        if (answer === "ok") socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        else if (answer === "bad-accept") socket.write("HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: wrong\r\n\r\n");
        else if (answer === "404") socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        else if (answer === "silent") return;
        script(socket);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      // Decode the client's (masked) frames so a case can assert what it sent.
      for (;;) {
        if (buffer.length < 2) break;
        const opcode = buffer[0] & 0x0f;
        let len = buffer[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buffer.length < 4) break; len = buffer.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buffer.length < 10) break; len = Number(buffer.readBigUInt64BE(2)); off = 10; }
        if (buffer.length < off + 4 + len) break;
        const mask = buffer.subarray(off, off + 4);
        const data = Buffer.alloc(len);
        for (let i = 0; i < len; i++) data[i] = buffer[off + 4 + i] ^ mask[i % 4];
        received.push({ opcode, data });
        buffer = buffer.subarray(off + 4 + len);
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { url: `ws://127.0.0.1:${server.address().port}/session?x=1`, received, server };
}

/** A server-to-client frame, unmasked unless `mask` is given. */
function frame(opcode, payload, { fin = true, mask } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  const m = mask ? 0x80 : 0;
  if (data.length < 126) header = Buffer.from([(fin ? 0x80 : 0) | opcode, m | data.length]);
  else if (data.length < 65536) { header = Buffer.alloc(4); header[0] = (fin ? 0x80 : 0) | opcode; header[1] = m | 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[0] = (fin ? 0x80 : 0) | opcode; header[1] = m | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  if (!mask) return Buffer.concat([header, data]);
  const masked = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, Buffer.from(mask), masked]);
}

const until = async (check, ms = 2000) => { for (let t = 0; t < ms && !check(); t += 20) await new Promise((r) => setTimeout(r, 20)); };

describe("the handshake", () => {
  it("refuses a non-ws URL before dialling", () => {
    assert.throws(() => connectWebSocket("http://127.0.0.1:1/"), /Only ws:\/\/ URLs are supported, got http:/);
  });

  it("names the status line when the server does not switch protocols", async () => {
    const p = await peer({ answer: "404" });
    await assert.rejects(connectWebSocket(p.url), /WebSocket handshake refused: HTTP\/1\.1 404 Not Found/);
  });

  it("names the accept header when it does not match the key", async () => {
    const p = await peer({ answer: "bad-accept" });
    await assert.rejects(connectWebSocket(p.url), /did not echo the expected Sec-WebSocket-Accept/);
  });

  it("times out a server that never answers", async () => {
    const p = await peer({ answer: "silent" });
    await assert.rejects(connectWebSocket(p.url, { timeoutMs: 150 }), /handshake with 127\.0\.0\.1:\d+ timed out/);
  });

  it("reports a refused connection as the error", async () => {
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    await assert.rejects(connectWebSocket(`ws://127.0.0.1:${port}/`), /ECONNREFUSED/);
  });

  it("header lookup skips lines without a colon and returns null when absent", () => {
    assert.equal(headerValue("HTTP/1.1 101 X\r\nbroken line\r\nA: b", "a"), "b");
    assert.equal(headerValue("HTTP/1.1 101 X\r\nA: b", "missing"), null);
  });
});

describe("frames from the server", () => {
  it("delivers 7-bit, 16-bit and 64-bit length messages, masked or not, whole", async () => {
    const medium = "m".repeat(300);
    const large = "L".repeat(70_000);
    const p = await peer({ script: (s) => {
      s.write(frame(0x1, "tiny"));
      s.write(frame(0x1, medium, { mask: [1, 2, 3, 4] }));
      const big = frame(0x2, large);
      s.write(big.subarray(0, 3)); // a header split across reads
      setTimeout(() => s.write(big.subarray(3)), 20);
    } });
    const got = [];
    await connectWebSocket(p.url, { onMessage: (m) => got.push(m) });
    await until(() => got.length === 3);
    assert.deepEqual(got.map((m) => m.length), [4, 300, 70_000]);
    assert.equal(got[1], medium);
  });

  it("reassembles a fragmented message and answers a ping with a pong carrying its payload", async () => {
    const p = await peer({ script: (s) => {
      s.write(frame(0x1, "hel", { fin: false }));
      s.write(frame(0x9, "are-you-there"));
      s.write(frame(0xA, "stray-pong"));
      s.write(frame(0x0, "lo"));
    } });
    const got = [];
    await connectWebSocket(p.url, { onMessage: (m) => got.push(m) });
    await until(() => got.length === 1 && p.received.length === 1);
    assert.deepEqual(got, ["hello"]);
    assert.equal(p.received[0].opcode, 0xA);
    assert.equal(p.received[0].data.toString(), "are-you-there");
  });

  it("closes when the server sends a close frame, and reports it once", async () => {
    const p = await peer({ script: (s) => s.write(frame(0x8, "")) });
    let closes = 0;
    const ws = await connectWebSocket(p.url, { onClose: () => closes++ });
    await until(() => closes > 0);
    ws.close();
    ws.send("ignored after close");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closes, 1);
  });

  it("fails a declared 64-bit frame over the 64 MiB cap without buffering it", async () => {
    const p = await peer({ script: (s) => {
      const header = Buffer.alloc(10);
      header[0] = 0x82; header[1] = 127; header.writeBigUInt64BE(BigInt(64 * 1024 * 1024 + 1), 2);
      s.write(header);
    } });
    let closes = 0;
    await connectWebSocket(p.url, { onClose: () => closes++ });
    await until(() => closes > 0);
    assert.equal(closes, 1);
  });

  it("fails a fragmented message whose total passes the cap", async () => {
    const piece = Buffer.alloc(33 * 1024 * 1024, 0x61);
    const p = await peer({ script: (s) => { s.write(frame(0x2, piece, { fin: false })); s.write(frame(0x0, piece, { fin: false })); } });
    let closes = 0;
    const got = [];
    await connectWebSocket(p.url, { onClose: () => closes++, onMessage: (m) => got.push(m) });
    const started = Date.now();
    await until(() => closes > 0, 8000);
    assert.equal(closes, 1);
    assert.deepEqual(got, []);
    // Buffering chunks rather than re-copying the whole buffer on each one keeps this
    // linear: ~1.5s plain and slower under coverage instrumentation, against ~11s for the
    // quadratic version — 6s separates the two with room for a loaded machine.
    assert.ok(Date.now() - started < 6000, `the cap took ${Date.now() - started}ms to trip`);
  });

  it("reports the peer hanging up as a close", async () => {
    const p = await peer({ script: (s) => setTimeout(() => s.destroy(), 20) });
    let closes = 0;
    await connectWebSocket(p.url, { onClose: () => closes++ });
    await until(() => closes > 0);
    assert.equal(closes, 1);
  });
});

describe("frames to the server", () => {
  it("masks and length-encodes every size, and sends a close frame on close()", async () => {
    const p = await peer();
    let closes = 0;
    const ws = await connectWebSocket(p.url, { onClose: () => closes++ });
    ws.send("a");
    ws.send("b".repeat(200));
    ws.send("c".repeat(70_000));
    await until(() => p.received.length === 3, 4000);
    assert.deepEqual(p.received.map((f) => [f.opcode, f.data.length]), [[1, 1], [1, 200], [1, 70_000]]);
    ws.close();
    ws.close();
    await until(() => p.received.length === 4);
    assert.equal(p.received[3].opcode, 0x8);
    assert.equal(closes, 1);
  });
});

describe("the remaining client edges", () => {
  it("dials port 80 when the URL names none", async () => {
    await assert.rejects(connectWebSocket("ws://127.0.0.1/"), /127\.0\.0\.1:80|ECONNREFUSED|EACCES/);
  });

  it("reassembles a handshake answer split across reads, and a 16-bit header split after two bytes", async () => {
    const server = net.createServer((socket) => {
      peerSockets.push(socket);
      let head = "";
      socket.on("data", (c) => {
        head += c.toString("latin1");
        if (!head.includes("\r\n\r\n")) return;
        const key = headerValue(head, "sec-websocket-key");
        const accept = createHash("sha1").update(key + GUID).digest("base64");
        const answer = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
        socket.write(answer.slice(0, 20));
        setTimeout(() => {
          socket.write(answer.slice(20));
          const f = frame(0x1, "z".repeat(300));
          socket.write(f.subarray(0, 2));
          setTimeout(() => socket.write(f.subarray(2)), 20);
        }, 20);
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    servers.push(server);
    const got = [];
    await connectWebSocket(`ws://127.0.0.1:${server.address().port}/`, { onMessage: (m) => got.push(m) });
    await until(() => got.length === 1);
    assert.equal(got[0].length, 300);
  });
});
