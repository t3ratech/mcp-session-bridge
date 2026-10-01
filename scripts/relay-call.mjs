#!/usr/bin/env node
/**
 * Direct relay client for the T3rnel session bridge socket.
 * Talks MCP JSON-RPC straight to the native host's unix socket —
 * the same path the MCP server uses, without the stdio shim.
 *
 * Usage: node scripts/relay-call.mjs <browser_tool> '<json-args>'
 *   node scripts/relay-call.mjs browser_evaluate '{"expression":"location.href"}'
 */
import net from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";

const SOCK = join(homedir(), ".t3rnel", "session-bridge", "bridge.sock");
const [tool, argsJson = "{}"] = process.argv.slice(2);
if (!tool) { console.error("usage: relay-call.mjs <browser_tool> '<json>'"); process.exit(2); }

const sock = net.createConnection(SOCK);
let buf = Buffer.alloc(0);
const id = `cli-${Date.now()}`;

function encode(v) {
  const b = Buffer.from(JSON.stringify(v));
  const h = Buffer.alloc(4); h.writeUInt32LE(b.length, 0);
  return Buffer.concat([h, b]);
}

sock.on("connect", () => {
  sock.write(encode({ jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: JSON.parse(argsJson) } }));
});
sock.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
    buf = buf.subarray(4 + len);
    if (msg.id === id) {
      const text = msg.result?.content?.[0]?.text ?? JSON.stringify(msg.error ?? msg.result);
      try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
      sock.end(); process.exit(0);
    }
  }
});
sock.on("error", (e) => { console.error("socket:", e.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 30000);
