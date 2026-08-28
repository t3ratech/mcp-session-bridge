/**
 * Refs from a snapshot, and the tools that take them.
 *
 * `session_snapshot` describes itself as returning "interactive elements with refs", and
 * every element it returns carries one. Nothing accepted them: `session_click` and
 * `session_fill` took `selector` and rejected anything else, so an agent following the
 * pattern every other browser MCP server uses — snapshot the page, act on a ref — got
 * `Unknown argument: ref` on its first action and no hint about what to use instead.
 *
 * Found by driving this server against a real browser rather than by reading it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { TOOL_DEFINITIONS } = await import(join(root, "src", "tools.js"));

const selectorTools = TOOL_DEFINITIONS.filter((t) => t.inputSchema.properties?.selector);

describe("the tools that take a selector also take a snapshot's ref", () => {
  test("there are selector-taking tools to check, so this is not vacuous", () => {
    assert.ok(selectorTools.length >= 3, `only ${selectorTools.length} tools take a selector`);
  });

  test("every one of them advertises ref", () => {
    for (const tool of selectorTools) {
      assert.ok(
        tool.inputSchema.properties.ref,
        `${tool.name} takes a selector but not a ref, so a snapshot's output cannot drive it`,
      );
      assert.equal(tool.inputSchema.properties.ref.type, "string");
      assert.match(
        tool.inputSchema.properties.ref.description,
        /snapshot/i,
        `${tool.name}'s ref says nothing about where a ref comes from`,
      );
    }
  });

  test("snapshot still promises the refs these tools consume", () => {
    const snapshot = TOOL_DEFINITIONS.find((t) => t.name === "session_snapshot");
    assert.ok(snapshot, "session_snapshot is not offered");
    assert.match(snapshot.description, /ref/i, "snapshot no longer mentions the refs it returns");
  });
});

describe("a ref that cannot be resolved is refused by name", () => {
  /** Speaks MCP to a freshly started server with no browser behind it. */
  const ask = async (frames) => {
    const home = mkdtempSync(join(tmpdir(), "bridge-refs-"));
    const server = spawn("node", [join(root, "src", "server.js")], {
      stdio: ["pipe", "pipe", "pipe"],
      // No relay socket under this HOME, so the bridge cannot reach an extension.
      env: { ...process.env, HOME: home, USERPROFILE: home, T3RNEL_SESSION_MODE: "extension" },
    });
    const replies = [];
    const done = new Promise((resolveDone) => {
      createInterface({ input: server.stdout }).on("line", (line) => {
        try { replies.push(JSON.parse(line)); } catch { /* not a frame */ }
        if (replies.length >= frames.length) resolveDone();
      });
      setTimeout(resolveDone, 15_000);
    });
    server.stdin.write(`${frames.map((f) => JSON.stringify(f)).join("\n")}\n`);
    await done;
    server.kill();
    rmSync(home, { recursive: true, force: true });
    return replies;
  };

  test("says a snapshot is needed first, rather than Unknown argument: ref", async () => {
    const replies = await ask([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "session_click", arguments: { ref: "@e5" } } },
    ]);
    const reply = replies.find((r) => r.id === 2);
    assert.ok(reply, "the server never answered the call");

    const message = reply.error?.message ?? JSON.stringify(reply.result);
    // Whatever it says, it must not be the old refusal — that message sent people looking
    // for an argument that was in the schema all along.
    assert.doesNotMatch(message, /Unknown argument: ref/, "ref is still rejected as an unknown argument");
    assert.match(
      message,
      /snapshot|extension|not installed|disconnected/i,
      `the refusal explains nothing actionable: ${message}`,
    );
  });
});
