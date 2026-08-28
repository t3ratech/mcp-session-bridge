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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

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

/**
 * Arguments the extension honours must be arguments the boundary accepts.
 *
 * `session_screenshot` resolved a `tabId` in its implementation and advertised one
 * nowhere, so validation rejected the single argument the code wanted. Working in a
 * named tab is the whole point of this server — the skill's own safety rule is "stay on
 * the tab you were given" — and screenshotting that tab was the one thing you could not
 * do. The same shape as the snapshot refs: supported everywhere, offered nowhere.
 */
describe("tools that act on a tab accept a tabId", () => {
  const actsOnATab = TOOL_DEFINITIONS.filter((tool) =>
    /screenshot|snapshot|read_page|click|fill|type|press|navigate|wait|evaluate/.test(tool.name));

  test("there are such tools, so this is not vacuous", () => {
    assert.ok(actsOnATab.length >= 8, `only ${actsOnATab.length} tools act on a tab`);
  });

  test("every one of them takes a tabId", () => {
    for (const tool of actsOnATab) {
      assert.ok(
        tool.inputSchema.properties?.tabId,
        `${tool.name} acts on a tab but will reject a tabId, so it can only ever use the active one`,
      );
      assert.equal(tool.inputSchema.properties.tabId.type, "integer", `${tool.name}.tabId is not an integer`);
    }
  });
});

/**
 * Choosing from a dropdown, in both modes.
 *
 * `session_select` existed only when the extension relay was connected, and the standalone
 * fill path sets values through `HTMLInputElement.prototype`'s setter — which does nothing
 * to a `<select>`. So standalone mode could fill every text field on a submission form and
 * still never submit it, because the one required control was a dropdown. Found by a real
 * form that did exactly that.
 */
describe("a dropdown can be chosen in standalone mode, not only through the extension", () => {
  const select = TOOL_DEFINITIONS.find((tool) => tool.name === "session_select");

  test("is one of the tools the bridge serves on its own", () => {
    assert.ok(select, "session_select is not in the base tool set, so standalone mode cannot pick an option");
  });

  test("accepts each of the three ways a page makes an option addressable", () => {
    for (const key of ["value", "text", "index"]) {
      assert.ok(select.inputSchema.properties[key], `session_select cannot choose by ${key}`);
    }
    assert.ok(select.inputSchema.properties.ref, "session_select does not take a snapshot ref");
    assert.ok(select.inputSchema.properties.tabId, "session_select cannot be aimed at a tab");
    assert.deepEqual(select.inputSchema.required, ["selector"]);
  });

  test("says plainly that filling a select does not work, which is the mistake it prevents", () => {
    assert.match(select.description, /select|dropdown/i);
    assert.match(
      select.description,
      /does nothing|as though it were a text field/i,
      "the description does not warn that session_fill silently fails on a select",
    );
  });

  test("the standalone browser implements it", async () => {
    const cdp = readFileSync(join(root, "src", "cdp.js"), "utf8");
    assert.match(cdp, /case "session_select"/, "the standalone executor has no select branch");
    assert.match(cdp, /SELECT_JS/, "there is no select script for the standalone path");
    // It has to report what it could not match, or a wrong option name is undebuggable.
    assert.match(cdp, /no option matched/, "a failed match does not say what the options were");
    // And it must refuse a non-select rather than appear to succeed.
    assert.match(cdp, /is not a <select>/, "the standalone path does not refuse a non-select target");
  });
});
