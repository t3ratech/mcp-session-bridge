/**
 * The 1.3.0 transport: a loopback WebSocket server the T3rnel Browser
 * extension's service worker dials out to.
 *
 * It replaces the native-messaging host for new installs: the MCP client spawns
 * this server over stdio (`npx @t3ratech/mcp-session-bridge`), the extension
 * finds it on a fixed loopback port range, and the first connection is paired
 * automatically while AI/MCP automation is allowed — the extension's default —
 * covering every tool the bridge sends, permanently. Only an armed approval
 * gate surfaces a one-time pairing card in the side panel instead.
 *
 * Why the extension dials out rather than the bridge dialing in: a service
 * worker cannot listen, and an extension cannot read a discovery file — so the
 * discoverable side has to be the listener, and the reachable side has to be
 * the one doing the discovering.
 *
 * Security shape, stated plainly because it differs from the unix-socket path
 * it replaces:
 *   - The listener binds 127.0.0.1 only; nothing on the LAN can reach it.
 *   - Under the default policy the extension auto-pairs a connecting bridge —
 *     the install-time automation consent is the approval. With the approval
 *     gate armed, a connection is instead held until the user approves a
 *     pairing card in the side panel; a denied bridge stays denied either way.
 *   - A same-UID rogue process can still squat the port and request access. An
 *     armed gate turns that into a visible card naming an unexpected caller;
 *     under the default it is silently paired — the residual risk the owner
 *     accepted in exchange for a zero-prompt first run, and the honest reason
 *     the gate stays in Settings.
 */

import http from "node:http";
import net from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

/**
 * Where the server listens and the extension probes. The default is a fixed
 * base with a small range so several MCP clients (Claude plus Cursor, say) can
 * each run a bridge at once; `T3RNEL_SESSION_PORT` pins the base for testing.
 */
export const SESSION_WS_BASE_PORT = 17311;
export const SESSION_WS_PORT_SPAN = 8;

export function sessionWsBasePort(env = process.env) {
  const raw = env.T3RNEL_SESSION_PORT;
  if (raw === undefined || raw === null || raw === "") return SESSION_WS_BASE_PORT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`T3RNEL_SESSION_PORT must be a port number, received ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * A stable identity for this user's bridges, so the extension's one-time
 * approval survives restarts of the bridge process. 0600 like the relay
 * socket: it separates users, not same-UID processes — the pairing card is
 * what separates callers.
 */
export function bridgeId(home = homedir()) {
  const dir = join(home, ".t3rnel", "session-bridge");
  const file = join(dir, "bridge-id");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length > 0) return existing;
  } catch { /* absent or unreadable: make one below */ }
  const id = randomUUID();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, `${id}\n`, { mode: 0o600 });
    if (platform() !== "win32") chmodSync(file, 0o600);
  } catch { /* a new id each run only costs the user one extra pairing card */ }
  return id;
}

/**
 * "An extension lives on this machine and dials back in when it wakes."
 *
 * MV3 service workers sleep after ~30s of no events; the extension's wake
 * alarm re-dials the bridge on the next cycle. A bridge process that has never
 * seen an extension cannot tell "asleep" from "not installed" and must fail
 * fast — but once ANY extension has connected, a disconnect is a sleep, and a
 * fresh bridge process needs a persisted breadcrumb to know the same. The
 * marker's mtime is the signal: the extension touches it on every connect and
 * disconnect while the browser runs, so a stale marker means Chrome is gone,
 * not that the gate moved.
 */
const EXTENSION_SEEN_FRESH_MS = 10 * 60 * 1000;

function extensionSeenPath(home) {
  return join(home, ".t3rnel", "session-bridge", "extension-seen");
}

export function markExtensionSeen(home = homedir()) {
  try {
    const dir = join(home, ".t3rnel", "session-bridge");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(extensionSeenPath(home), `${Date.now()}\n`, { mode: 0o600 });
  } catch { /* advisory: a missed marker only costs the slow wait */ }
}

export function extensionSeenRecently(home = homedir()) {
  try {
    return Date.now() - statSync(extensionSeenPath(home)).mtimeMs < EXTENSION_SEEN_FRESH_MS;
  } catch {
    return false;
  }
}

/** One upgraded connection: parses masked client frames, sends unmasked ones. */
function attachSession(socket, { onMessage, onClose }) {
  let buffer = Buffer.alloc(0);
  // Chunks wait here until the parser has enough for its next step: joining every chunk
  // onto the whole buffer made a multi-megabyte screenshot response quadratic to receive.
  const waiting = [];
  let waitingBytes = 0;
  let needed = 2;
  const fragments = [];
  let closed = false;

  function sendFrame(opcode, payload) {
    if (closed) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  }

  function close() {
    if (closed) return;
    closed = true;
    // A write to a socket that has gone emits "error" rather than throwing; that path
    // lands back here and the `closed` flag makes it a no-op.
    sendFrame(0x8, Buffer.alloc(0));
    socket.end();
    onClose();
  }

  function handleFrame(fin, opcode, payload) {
    if (opcode === 0x9) { sendFrame(0xA, payload); return; }
    if (opcode === 0xA) return;
    if (opcode === 0x8) { closed = true; socket.end(); onClose(); return; }
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      fragments.push(payload);
      if (fragments.reduce((sum, chunk) => sum + chunk.length, 0) > MAX_MESSAGE_BYTES) {
        close();
        return;
      }
      if (fin) {
        const text = Buffer.concat(fragments).toString("utf8");
        fragments.length = 0;
        onMessage(text);
      }
    }
  }

  socket.on("data", (chunk) => {
    waiting.push(chunk);
    waitingBytes += chunk.length;
    if (buffer.length + waitingBytes < needed) return;
    buffer = Buffer.concat([buffer, ...waiting]);
    waiting.length = 0;
    waitingBytes = 0;
    for (;;) {
      if (buffer.length < 2) { needed = 2; return; }
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) { needed = 4; return; }
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) { needed = 10; return; }
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) { close(); return; }
        length = Number(big);
        offset = 10;
      }
      // A client frame that arrives unmasked is a protocol violation; a browser
      // WebSocket always masks, so treat it as a non-browser and drop it.
      if (!masked) { close(); return; }
      if (buffer.length < offset + 4 + length) { needed = offset + 4 + length; return; }
      const mask = buffer.subarray(offset, offset + 4);
      const raw = buffer.subarray(offset + 4, offset + 4 + length);
      const payload = Buffer.alloc(length);
      for (let i = 0; i < length; i++) payload[i] = raw[i] ^ mask[i % 4];
      buffer = buffer.subarray(offset + 4 + length);
      handleFrame(fin, opcode, payload);
    }
  });
  socket.on("error", () => close());
  socket.on("close", () => { if (!closed) { closed = true; onClose(); } });
  // A peer that half-closes without a close frame (FIN only) still has to drop
  // the session — "close" alone only fires once our own end has also finished.
  socket.on("end", () => close());

  return {
    send: (text) => sendFrame(0x1, Buffer.from(text, "utf8")),
    close,
  };
}

/**
 * Starts the loopback endpoint. Resolves with an object shaped like the
 * RelayClient it replaces — `call(payload)`, `isConnected()`, `close()`,
 * `onDisconnect` — plus `port`, the port actually bound.
 *
 * `clientName` is whatever the MCP client told us over initialize (a bridge
 * spawned by Claude says so), so the pairing card can name its caller.
 */
export async function startExtensionWebSocket({
  env = process.env,
  basePort,
  version = "0.0.0",
  clientName = "an MCP client",
  log = (line) => process.stderr.write(`${line}\n`),
  onReadyChange = () => {},
  probeTimeoutMs = 8000,
} = {}) {
  const id = bridgeId();
  const pending = new Map();
  /** conn id -> live session handle, ready or still awaiting pairing. */
  const sessions = new Map();
  /** conn ids whose extension side has sent its post-approval ready frame. */
  const ready = new Set();
  /** Once true, a disconnect is a service-worker sleep, not an uninstall. */
  let everReady = false;
  let nextId = 1;
  let server;
  let boundPort = 0;
  let onDisconnect = () => {};
  /** Conn pinned after proving it can enumerate real tabs. */
  let preferred = 0;

  /**
   * Which connected browser a call goes to.
   *
   * Several browsers can carry the extension at once — Chrome and Brave both do on a
   * machine that uses both, and a copy that only runs in private windows connects but
   * sees no windows at all. Sending every call to whichever connected first meant a
   * browser that could see nothing could win for good. So the first call probes each ready
   * connection once with `browser_list_tabs` (a browser-control tool: never counted, no
   * account needed) and pins the first that reports real tabs. The pin holds until that
   * browser goes away, then the probe runs again. When none reports a tab, the first
   * connection is used, as before. With one browser connected there is nothing to choose
   * and nothing is probed, so a single browser, or an extension that predates the probe,
   * never waits on it. Only a count is logged, never a tab title or address.
   */
  async function pickConn() {
    if (preferred && ready.has(preferred)) return preferred;
    if (ready.size === 1) return ready.values().next().value;
    for (const conn of ready) {
      const target = sessions.get(conn);
      const requestId = `w${nextId++}`;
      try {
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("probe timeout"));
          }, probeTimeoutMs);
          pending.set(requestId, { conn, resolve, reject, timer });
          target.send(JSON.stringify({
            jsonrpc: "2.0", method: "tools/call",
            params: { name: "browser_list_tabs", arguments: {} },
            id: requestId,
          }));
        });
        const text = result?.content?.[0]?.text;
        let tabs;
        try { tabs = typeof text === "string" ? JSON.parse(text) : result; } catch { tabs = null; }
        log(`mcp-session-bridge: probe conn ${conn} -> ${Array.isArray(tabs) ? tabs.length : "non-array"} tabs`);
        if (Array.isArray(tabs) && tabs.length > 0) {
          preferred = conn;
          return conn;
        }
      } catch (e) { log(`mcp-session-bridge: probe conn ${conn} failed: ${e.message}`); }
    }
    preferred = 0;
    return ready.values().next().value;
  }

  function dropConnection(conn) {
    const wasReady = ready.delete(conn);
    sessions.delete(conn);
    for (const [requestId, entry] of pending) {
      if (entry.conn === conn) {
        pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.reject(new Error("The extension connection closed mid-call"));
      }
    }
    if (wasReady) {
      markExtensionSeen();
      onReadyChange(ready.size > 0);
      if (ready.size === 0) onDisconnect();
    }
  }

  function routeMessage(conn, session, text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message === null || typeof message !== "object") return;
    if (message.type === "t3rnel.bridge.ready") {
      if (!ready.has(conn)) {
        ready.add(conn);
        everReady = true;
        markExtensionSeen();
        log(`mcp-session-bridge: extension connected and approved (port ${boundPort})`);
        onReadyChange(true);
      }
      return;
    }
    if (message.type === "t3rnel.bridge.denied") {
      // The user declined the pairing card. Hold the connection closed; the
      // extension will not send a ready frame, and its retry backoff keeps it
      // from re-asking constantly.
      session.close();
      return;
    }
    const entry = pending.get(String(message.id));
    if (!entry || entry.conn !== conn) return;
    pending.delete(String(message.id));
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Tool execution failed"));
    } else {
      entry.resolve(message.result);
    }
  }

  const upgraded = new Set();
  server = http.createServer((request, response) => {
    // The only plain-HTTP answer this endpoint gives: a health probe so a human
    // debugging "is the bridge up" gets words instead of a hung curl.
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, server: "mcp-session-bridge", version, extensions: ready.size }));
      return;
    }
    response.writeHead(404).end();
  });

  server.on("upgrade", (request, socket, head) => {
    if (head && head.length > 0) socket.unshift(head);
    const key = request.headers["sec-websocket-key"];
    if (!key || request.headers.upgrade?.toLowerCase() !== "websocket") {
      socket.destroy();
      return;
    }
    upgraded.add(socket);
    socket.on("close", () => upgraded.delete(socket));
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const conn = nextId++;
    const session = attachSession(socket, {
      onMessage: (text) => routeMessage(conn, session, text),
      onClose: () => dropConnection(conn),
    });
    sessions.set(conn, session);
    // The greeting is what the extension reads to decide whether to show a
    // pairing card: it names who is asking before a single tool call can flow.
    session.send(JSON.stringify({
      type: "t3rnel.bridge.hello",
      server: "mcp-session-bridge",
      version,
      bridgeId: id,
      client: clientName,
      port: boundPort,
    }));
  });

  const base = basePort ?? sessionWsBasePort(env);
  for (let offset = 0; offset < SESSION_WS_PORT_SPAN; offset++) {
    const candidate = base === 0 ? 0 : base + offset; // 0 = ephemeral, for tests
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(candidate, "127.0.0.1", resolve);
      });
      boundPort = server.address().port;
      break;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
    }
  }
  if (!boundPort) {
    server.close();
    throw new Error(
      `No free loopback port in ${base}–${base + SESSION_WS_PORT_SPAN - 1}. ` +
        "Another bridge instance may already be running for every slot."
    );
  }
  log(`mcp-session-bridge: listening for the extension on ws://127.0.0.1:${boundPort}`);

  return {
    port: boundPort,
    bridgeId: id,
    /** True once an extension connection has sent its post-approval ready frame. */
    isConnected: () => ready.size > 0,
    /** True while any extension socket is open, even one still awaiting pairing. */
    hasExtensionSocket: () => sessions.size > 0,
    /**
     * True when an extension is known to exist but is probably between wake
     * cycles — a dropped ready connection, or a marker fresh enough that the
     * browser was running moments ago. Callers should wait through the sleep
     * window instead of failing fast.
     */
    extensionExpected: () => everReady || extensionSeenRecently(),
    set onDisconnect(callback) { onDisconnect = callback ?? (() => {}); },
    get onDisconnect() { return onDisconnect; },
    async call(payload, timeoutMs = 30000) {
      const conn = await pickConn();
      const target = conn === undefined ? undefined : sessions.get(conn);
      if (!target) {
        return Promise.reject(new Error("The extension has not approved this bridge yet"));
      }
      const requestId = `w${nextId++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Tool call timed out after ${timeoutMs}ms waiting for the browser session`));
        }, timeoutMs);
        pending.set(requestId, { conn, resolve, reject, timer });
        target.send(JSON.stringify({ ...payload, id: requestId }));
      });
    },
    close() {
      for (const socket of upgraded) socket.destroy();
      server.close();
    },
  };
}
