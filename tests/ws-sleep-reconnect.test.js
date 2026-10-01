// SPDX-License-Identifier: LicenseRef-Proprietary
// Copyright (c) T3raTech Solutions (Pvt) Ltd. All rights reserved.

/**
 * The MV3 sleep-window race.
 *
 * The extension's service worker sleeps after ~30s of no events and re-dials
 * the bridge on its wake alarm — so a call that lands mid-sleep meets a bridge
 * with no socket at all. waitForExtension used to give up after 250–1000ms,
 * which meant almost every call during the idle hours lost the race and the
 * MCP client reported the bridge itself as dead. Now, when an extension is
 * known to exist — a ready connection this process already had, or a marker
 * file fresh enough that the browser was running moments ago — the wait
 * stretches to just under the call timeout, long enough for the next wake.
 *
 * These tests drive the real server over stdio and a fake extension over the
 * loopback WebSocket, because the thing being proven is the timing, not a
 * stubbed unit.
 */

import { spawn } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, utimesSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectWebSocket } from "../src/ws.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = join(__dirname, "..", "src", "server.js");

const activeProcs = new Set();
const activeSockets = new Set();
const tempDirs = new Set();

afterEach(() => {
  for (const proc of activeProcs) {
    try { proc.kill(); } catch { }
  }
  activeProcs.clear();
  for (const socket of activeSockets) {
    try { socket.close(); } catch { }
  }
  activeSockets.clear();
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  }
  tempDirs.clear();
});

function nextLine(stream, timeoutMs = 20000) {
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

/**
 * Spawns the server on an ephemeral port with an isolated HOME so the marker
 * file under test can be planted or withheld. Resolves with the process and
 * the port the bridge actually bound (parsed from its log line).
 */
function spawnServer({ marker = "absent", markerAgeMs = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "t3rnel-bridge-sleep-"));
  tempDirs.add(dir);

  if (marker !== "absent") {
    const markerDir = join(dir, ".t3rnel", "session-bridge");
    mkdirSync(markerDir, { recursive: true });
    const markerPath = join(markerDir, "extension-seen");
    writeFileSync(markerPath, `${Date.now() - markerAgeMs}\n`);
    if (markerAgeMs > 0) {
      const at = new Date(Date.now() - markerAgeMs);
      utimesSync(markerPath, at, at);
    }
  }

  const proc = spawn("node", [serverPath], {
    cwd: join(__dirname, ".."),
    env: {
      ...process.env,
      HOME: dir,
      T3RNEL_SESSION_SOCKET: join(dir, "bridge.sock"),
      // Bind outside the extension's fixed scan range (17311–17318): a real
      // extension on this machine otherwise discovers the test server and
      // answers its calls, which is exactly the contamination this suite
      // exists to measure without.
      T3RNEL_SESSION_PORT: String(27311 + (process.pid % 1000)),
    },
  });
  activeProcs.add(proc);
  proc.on("exit", () => activeProcs.delete(proc));

  const port = new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString();
      const match = buf.match(/listening for the extension on ws:\/\/127\.0\.0\.1:(\d+)/);
      if (match) {
        proc.stderr.off("data", onData);
        resolve(Number(match[1]));
      }
    };
    proc.stderr.on("data", onData);
    setTimeout(() => reject(new Error("bridge never logged its port")), 8000);
  });
  // Tests that never dial a port leave the promise unawaited; a late rejection
  // there is noise, not a failure.
  port.catch(() => 0);

  return { proc, port };
}

/**
 * A fake extension: connects to the bridge's session socket, answers the hello
 * with the ready frame an approved bridge gets, and replies to tools/list and
 * tools/call with canned results — exactly what the real extension sends.
 */
async function connectFakeExtension(port) {
  /**
   * The bridge can greet during the handshake, inside connectWebSocket's own
   * await window — before `socket` is assigned. Sends made then hit the TDZ and
   * die with `Cannot access 'socket' before initialization`, so replies are
   * buffered until the binding exists.
   */
  let socket;
  const pending = [];
  const send = (payload) => (socket ? socket.send(payload) : pending.push(payload));
  socket = await connectWebSocket(`ws://127.0.0.1:${port}/session`, {
    timeoutMs: 5000,
    onMessage: (text) => {
      let message;
      try { message = JSON.parse(text); } catch { return; }
      if (message?.type === "t3rnel.bridge.hello") {
        send(JSON.stringify({ type: "t3rnel.bridge.ready" }));
        return;
      }
      if (message?.method === "tools/list") {
        send(JSON.stringify({
          id: message.id,
          result: {
            tools: [
              { name: "browser_close_tab", description: "Close a tab", inputSchema: { type: "object", properties: { tabId: { type: "integer" } } } },
            ],
          },
        }));
        return;
      }
      if (message?.method === "tools/call") {
        send(JSON.stringify({
          id: message.id,
          result: { content: [{ type: "text", text: JSON.stringify({ closed: true, tabId: message.params?.arguments?.tabId ?? null }) }] },
        }));
      }
    },
  });
  for (const payload of pending) socket.send(payload);
  activeSockets.add(socket);
  return socket;
}

function call(proc, id, name, args) {
  proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
}

describe("bridge waits through the service-worker sleep window", () => {
  it("holds a mid-sleep call until the extension's next wake, instead of erroring in 250ms", async () => {
    const { proc, port } = spawnServer({ marker: "fresh" });
    const boundPort = await port;

    // The call lands while "the worker is asleep": marker says an extension
    // exists, but nothing is connected yet.
    call(proc, 1, "session_close_tab", { tabId: 123 });
    const started = Date.now();

    // The worker's wake alarm fires ~1.5s later; the extension re-dials.
    setTimeout(() => void connectFakeExtension(boundPort), 1500);

    const response = JSON.parse(await nextLine(proc.stdout, 25000));
    const elapsed = Date.now() - started;

    // It must have waited for the dial — under the old budget this came back
    // as an error in ~250ms.
    assert.ok(elapsed > 1400, `call returned after ${elapsed}ms — it did not wait for the wake`);
    assert.ok(response.result, `expected a result, got ${JSON.stringify(response.error)}`);
    assert.match(response.result.content[0].text, /"closed":true/);
  });

  it("still fails fast when no extension has ever been seen", async () => {
    const { proc } = spawnServer({ marker: "absent" });
    call(proc, 1, "session_close_tab", { tabId: 123 });
    const started = Date.now();
    const response = JSON.parse(await nextLine(proc.stdout));
    assert.ok(Date.now() - started < 5000, "a machine with no extension must not pay the sleep wait");
    assert.ok(response.error, `expected an error, got ${JSON.stringify(response.result)}`);
    assert.match(response.error.message, /not connected/i);
  });

  it("fails fast when the marker is stale — the browser is gone, not asleep", async () => {
    const { proc } = spawnServer({ marker: "fresh", markerAgeMs: 20 * 60 * 1000 });
    call(proc, 1, "session_close_tab", { tabId: 123 });
    const started = Date.now();
    const response = JSON.parse(await nextLine(proc.stdout));
    assert.ok(Date.now() - started < 5000);
    assert.ok(response.error);
  });
});
