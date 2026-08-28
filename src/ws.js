/**
 * Minimal RFC 6455 WebSocket client over `node:net` — just enough for CDP.
 * Exists so the standalone browser mode adds no npm dependency: frames are
 * masked on send, continuation frames are reassembled, pings are answered, and
 * anything over the message cap fails loudly instead of buffering forever.
 */

import net from "node:net";
import { createHash, randomBytes } from "node:crypto";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

export function connectWebSocket(url, { timeoutMs = 10000, onMessage = () => {}, onClose = () => {} } = {}) {
  const target = new URL(url);
  if (target.protocol !== "ws:") throw new Error(`Only ws:// URLs are supported, got ${target.protocol}`);
  const host = target.hostname;
  const port = Number(target.port) || 80;
  const path = `${target.pathname}${target.search}` || "/";

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const key = randomBytes(16).toString("base64");
    let buffer = Buffer.alloc(0);
    let handshaken = false;
    let closed = false;
    const fragments = [];

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`WebSocket handshake with ${host}:${port} timed out`));
    }, timeoutMs);

    function sendFrame(opcode, payload) {
      if (closed) return;
      const mask = randomBytes(4);
      const length = payload.length;
      let header;
      if (length < 126) {
        header = Buffer.from([0x80 | opcode, 0x80 | length]);
      } else if (length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 126;
        header.writeUInt16BE(length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(length), 2);
      }
      const masked = Buffer.alloc(length);
      for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i % 4];
      socket.write(Buffer.concat([header, mask, masked]));
    }

    function fail(error) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
      onClose();
    }

    function handleFrame(fin, opcode, payload) {
      if (opcode === 0x9) {
        sendFrame(0xA, payload); // ping → pong
        return;
      }
      if (opcode === 0xA) return; // pong
      if (opcode === 0x8) {
        closed = true;
        socket.end();
        onClose();
        return;
      }
      if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
        fragments.push(payload);
        const total = fragments.reduce((sum, chunk) => sum + chunk.length, 0);
        if (total > MAX_MESSAGE_BYTES) {
          fail(new Error("WebSocket message exceeds the 64 MiB cap"));
          return;
        }
        if (fin) {
          onMessage(Buffer.concat(fragments).toString("utf8"));
          fragments.length = 0;
        }
      }
    }

    function parseFrames() {
      for (;;) {
        if (buffer.length < 2) return;
        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const big = buffer.readBigUInt64BE(2);
          if (big > BigInt(MAX_MESSAGE_BYTES)) {
            fail(new Error("WebSocket frame exceeds the 64 MiB cap"));
            return;
          }
          length = Number(big);
          offset = 10;
        }
        const maskOffset = offset;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        let payload = buffer.subarray(offset, offset + length);
        if (masked) {
          const unmasked = Buffer.alloc(length);
          for (let i = 0; i < length; i++) unmasked[i] = payload[i] ^ buffer[maskOffset + (i % 4)];
          payload = unmasked;
        }
        buffer = buffer.subarray(offset + length);
        handleFrame(fin, opcode, payload);
      }
    }

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!handshaken) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(end + 4);
        const status = /^HTTP\/1\.1 101/.test(head);
        const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
        const acceptOk = new RegExp(`Sec-WebSocket-Accept: ${accept}`, "i").test(head);
        if (!status || !acceptOk) {
          fail(new Error(`WebSocket handshake refused: ${head.split("\r\n")[0]}`));
          return;
        }
        handshaken = true;
        clearTimeout(timer);
        resolve({
          send: (text) => sendFrame(0x1, Buffer.from(text, "utf8")),
          close: () => {
            if (closed) return;
            closed = true;
            sendFrame(0x8, Buffer.alloc(0));
            socket.end();
            onClose();
          },
        });
      }
      parseFrames();
    });
    socket.on("error", (error) => fail(error));
    socket.on("close", () => {
      if (!closed) {
        closed = true;
        clearTimeout(timer);
        onClose();
      }
    });

    socket.on("connect", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
      );
    });
  });
}
