/**
 * A client that listed tools before the extension connected is told when it does.
 *
 * MCP clients read `tools/list` once, at start-up. The bridge answers that call with the
 * 22 tools it serves on its own when no extension has dialled in yet — which is the
 * normal state for the first seconds after a client launches it, and for as long as the
 * extension's service worker is asleep. It never sent `notifications/tools/list_changed`
 * and did not declare `listChanged`, so a client that started a moment too early kept the
 * 22-tool list for its whole session and never saw the other 75: found from inside a
 * Claude Code session whose `session_*` list had no viewport, network or console tools
 * while the extension was connected and answering.
 */
import { spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectWebSocket } from "../src/ws.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 47951;

describe("tools/list_changed when the extension arrives", () => {
  let home;
  let proc;
  const messages = [];
  let next = 1;
  const waiting = new Map();
  let extension;

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => reject(new Error(`[timed out after 10000ms] ${method}`)), 10_000);
    waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  const until = async (predicate, what, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`[timed out after ${ms}ms] ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  before(async () => {
    home = mkdtempSync(join(tmpdir(), "t3rnel-listchanged-"));
    proc = spawn(process.execPath, [join(root, "src", "server.js")], {
      env: { ...process.env, HOME: home, T3RNEL_SESSION_MODE: "auto", T3RNEL_SESSION_PORT: String(PORT), T3RNEL_SESSION_HEADLESS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        messages.push(message);
        if (message.id !== undefined) waiting.get(message.id)?.(message);
      }
    });
  });

  after(async () => {
    extension?.close();
    proc?.kill("SIGTERM");
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("initialize declares that the tool list can change", async () => {
    const init = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "list-changed-test", version: "1" } });
    assert.equal(init.result?.capabilities?.tools?.listChanged, true, "the server does not declare tools.listChanged, so no client will re-list");
  });

  test("a list taken before the extension connects is the standalone list", async () => {
    const listed = await call("tools/list");
    assert.ok(!listed.result.tools.some((t) => t.name === "session_viewport_probe_only"), "fixture tool present before the extension connected");
    assert.ok(listed.result.tools.length > 5, "the standalone list is empty");
  });

  test("the extension connecting sends list_changed, and the next list carries its tools", async () => {
    extension = await connectWebSocket(`ws://127.0.0.1:${PORT}/session`, {
      timeoutMs: 4000,
      onMessage: (text) => {
        const message = JSON.parse(text);
        if (message.method === "tools/list") {
          extension.send(JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: [{ name: "browser_viewport_probe_only", description: "fixture", inputSchema: { type: "object", properties: {} } }] },
          }));
        }
      },
    });
    extension.send(JSON.stringify({ type: "t3rnel.bridge.ready" }));
    await until(() => messages.some((m) => m.method === "notifications/tools/list_changed"),
      "no notifications/tools/list_changed after the extension connected");
    const listed = await call("tools/list");
    assert.ok(listed.result.tools.some((t) => t.name === "session_viewport_probe_only"), "the re-list still lacks the extension's tools");
  });

  test("a service worker sleeping and waking again does not make the client re-list", async () => {
    const before = messages.filter((m) => m.method === "notifications/tools/list_changed").length;
    extension.close();
    await new Promise((r) => setTimeout(r, 300));
    extension = await connectWebSocket(`ws://127.0.0.1:${PORT}/session`, { timeoutMs: 4000, onMessage: () => {} });
    extension.send(JSON.stringify({ type: "t3rnel.bridge.ready" }));
    await new Promise((r) => setTimeout(r, 300));
    const afterWake = messages.filter((m) => m.method === "notifications/tools/list_changed").length;
    assert.equal(afterWake, before, "a worker wake notified a client whose list was already the extension's");
  });
});
