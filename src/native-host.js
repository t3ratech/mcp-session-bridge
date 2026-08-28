#!/usr/bin/env node
/**
 * T3rnel MCP Session Bridge — native messaging host.
 *
 * Chrome spawns this process when the T3rnel Browser extension calls
 * `chrome.runtime.connectNative("com.t3rnel.session")`. stdin/stdout carry
 * native messaging frames (4-byte little-endian length + JSON) between this
 * process and the extension.
 *
 * This process also owns the local relay socket that MCP servers
 * (`server.js`, launched by Claude Desktop / Cursor / Windsurf) connect to.
 * The socket therefore exists exactly while a browser session is available.
 *
 * Multiplexing: several MCP servers may connect at once. Their request ids
 * can collide, so every id is rewritten to `<conn>:<id>` on the way to the
 * extension and stripped on the way back.
 */

import net from "node:net";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { platform } from "node:os";
import { createFrameDecoder, encodeFrame } from "./framing.js";
import { ensureSocketDir, resolveSocketPath } from "./relay.js";

const MAX_PENDING = 1024;

const log = (line) => process.stderr.write(`mcp-session-bridge-host: ${line}\n`);

function fail(message) {
  log(message);
  process.exit(1);
}

export function startNativeHost({ socketPath = resolveSocketPath(), input = process.stdin, output = process.stdout, onExit = (code) => process.exit(code) } = {}) {
  const toChrome = (message) => output.write(encodeFrame(message));

  const connections = new Map();
  const pending = new Map();
  let nextConn = 1;

  function routeFromChrome(message) {
    if (message === null || typeof message !== "object" || typeof message.id !== "string") {
      return;
    }
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    const socket = connections.get(entry.conn);
    if (!socket) return;
    /**
     * The id goes back exactly as it arrived, type included. Rebuilding it from the
     * rewritten string turned a request sent as `7` into a response carrying `"7"`,
     * and a client that keys its outstanding requests by the value it sent — which is
     * what JSON-RPC correlation means — never matches the answer and waits forever.
     */
    socket.write(encodeFrame({ ...message, id: entry.id }));
  }

  function routeFromClient(conn, socket, message) {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      socket.write(encodeFrame({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request: body must be a JSON-RPC 2.0 object" } }));
      return;
    }
    if (message.id === undefined || message.id === null) {
      // Notifications have no response to route; nothing downstream needs them.
      return;
    }
    if (pending.size >= MAX_PENDING) {
      // Evicting silently leaves whoever sent that request waiting for an answer that
      // can no longer be routed. Telling them costs one frame and turns an indefinite
      // hang into an error they can retry.
      const oldest = pending.keys().next().value;
      const evicted = pending.get(oldest);
      pending.delete(oldest);
      const owner = evicted && connections.get(evicted.conn);
      if (owner) {
        owner.write(encodeFrame({
          jsonrpc: "2.0",
          id: evicted.id,
          error: { code: -32000, message: `Dropped: more than ${MAX_PENDING} requests were outstanding` }
        }));
      }
    }
    const rewritten = `${conn}:${String(message.id)}`;
    pending.set(rewritten, { conn, id: message.id });
    toChrome({ ...message, id: rewritten });
  }

  function dropConnection(conn) {
    connections.delete(conn);
    for (const [id, entry] of pending) {
      if (entry.conn === conn) pending.delete(id);
    }
  }

  const server = net.createServer((socket) => {
    const conn = nextConn++;
    connections.set(conn, socket);
    const decoder = createFrameDecoder((message) => routeFromClient(conn, socket, message));
    socket.on("data", (chunk) => {
      try {
        decoder.push(chunk);
      } catch (error) {
        log(`client ${conn} framing error: ${error.message}`);
        socket.destroy();
      }
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => dropConnection(conn));
    log(`MCP server connected (conn ${conn})`);
  });

  server.on("error", (error) => {
    fail(`Cannot listen on ${socketPath}: ${error.message}. Is another native host already running?`);
  });

  ensureSocketDir(socketPath);
  if (platform() !== "win32" && existsSync(socketPath)) {
    // A stale socket file survives a crashed host; a live one means a second
    // Chrome profile is racing us, which must not silently half-serve.
    const probe = net.createConnection({ path: socketPath });
    probe.on("connect", () => fail(`Another session bridge already owns ${socketPath}`));
    probe.on("error", () => {
      unlinkSync(socketPath);
      listen();
    });
  } else {
    listen();
  }

  function listen() {
    server.listen(socketPath, () => {
      if (platform() !== "win32") chmodSync(socketPath, 0o600);
      log(`relay listening on ${socketPath}`);
    });
  }

  const chromeDecoder = createFrameDecoder(routeFromChrome);
  input.on("data", (chunk) => {
    try {
      chromeDecoder.push(chunk);
    } catch (error) {
      fail(`Chrome framing error: ${error.message}`);
    }
  });

  let shuttingDown = false;
  function shutdown(code) {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const socket of connections.values()) socket.destroy();
    server.close(() => {
      if (platform() !== "win32" && existsSync(socketPath)) unlinkSync(socketPath);
      onExit(code);
    });
  }

  input.on("end", () => shutdown(0));
  input.on("error", () => shutdown(1));
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));

  return { server, connections, pending, shutdown };
}

if (process.argv[1] && process.argv[1].endsWith("native-host.js")) {
  startNativeHost();
}
