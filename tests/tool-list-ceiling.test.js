/**
 * The tool list stays installable however many tools the connected extension publishes.
 *
 * Google Antigravity refuses to install a server whose `tools/list` exceeds 100 entries.
 * Extension 1.2.0 — the build every store still serves while 1.3.0 is in review —
 * publishes 100 tools, and the bridge adds `session_install`, so the merged list is 101.
 * Bridge 1.2.1 capped it; that fix was published to npm without being committed, and the
 * 1.3.0 source had lost it, so 1.3.0 paired with any 1.2.0 extension would have been
 * refused again.
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
const PORT = 47963;

/** An extension tool list of `count` tools, ending with the two the cap drops first. */
function extensionTools(count) {
  const named = Array.from({ length: count - 2 }, (_, i) => `browser_fixture_${String(i).padStart(3, "0")}`);
  return [...named, "browser_md_diff", "browser_check_spelling"].map((name) => ({
    name, description: "fixture", inputSchema: { type: "object", properties: {} },
  }));
}

describe("the tool list never exceeds the 100-tool ceiling clients enforce", () => {
  let home;
  let proc;
  let extension;
  let published = [];
  let next = 1;
  const waiting = new Map();
  const notices = [];

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

  const connectExtension = async (tools) => {
    published = tools;
    extension?.close();
    const before = notices.length;
    extension = await connectWebSocket(`ws://127.0.0.1:${PORT}/session`, {
      timeoutMs: 4000,
      onMessage: (text) => {
        const message = JSON.parse(text);
        if (message.method === "tools/list") {
          extension.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: published } }));
        }
      },
    });
    extension.send(JSON.stringify({ type: "t3rnel.bridge.ready" }));
    await until(() => notices.length > before || published.length > 0, "the extension never connected");
    await new Promise((r) => setTimeout(r, 200));
  };

  before(async () => {
    home = mkdtempSync(join(tmpdir(), "t3rnel-ceiling-"));
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
        if (message.method === "notifications/tools/list_changed") notices.push(message);
        if (message.id !== undefined) waiting.get(message.id)?.(message);
      }
    });
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ceiling-test", version: "1" } });
  });

  after(() => {
    extension?.close();
    proc?.kill("SIGTERM");
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("an extension publishing 100 tools (1.2.0) still yields an installable list of at most 100", async () => {
    await connectExtension(extensionTools(100));
    const names = (await call("tools/list")).result.tools.map((t) => t.name);
    assert.ok(names.length <= 100, `tools/list has ${names.length} entries; clients refuse more than 100`);
    assert.ok(names.includes("session_install"), "the bridge's own install tool was dropped instead");
    assert.ok(!names.includes("session_md_diff") && !names.includes("session_check_spelling"),
      "the cap dropped tools other than the two lowest-value ones");
    assert.ok(names.includes("session_fixture_000"), "the extension's other tools are missing");
  });

  test("an extension under the ceiling (1.3.0 publishes 94) loses nothing", async () => {
    await connectExtension(extensionTools(94));
    const names = (await call("tools/list")).result.tools.map((t) => t.name);
    assert.equal(names.length, 96, "a list under the ceiling was trimmed"); // 94 + session_install + session_read_url
    assert.ok(names.includes("session_md_diff") && names.includes("session_check_spelling"));
  });
});
