/**
 * Addressing an element, through the boundary a real MCP client crosses.
 *
 * `ref-roundtrip.test.js` proves the standalone implementation resolves a ref — but it
 * calls `executeStandaloneTool` directly, and so never met the two things between a
 * client and that function: the published schema, and the server's ref map. Both were
 * broken, and each alone made the snapshot-then-act loop every description recommends
 * impossible over MCP:
 *
 *  - `session_click`, `_fill`, `_type` and `_select` published `required: ["selector"]`
 *    while describing `ref` as "used instead of selector". A client that validates
 *    against the schema — most do, and a model is told to — cannot send a ref alone.
 *  - The standalone snapshot emitted `{ref, tag, text}` with no selector, and the server
 *    only remembers refs that carry one. So a ref-only call that did reach the server was
 *    refused with "No snapshot to resolve" one call after a snapshot handed it out.
 *
 * And a third, found alongside: the standalone page scripts spliced the raw selector into
 * a JavaScript string literal for their error message, so any selector containing a
 * double quote — `input[name="q"]`, the most common selector on the web — was a syntax
 * error in the page, reported as a failed tool rather than as "element not found".
 */
import { spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "src", "server.js");
const { TOOL_DEFINITIONS, validateArguments } = await import(join(root, "src", "tools.js"));

const PAGE = `<!doctype html><title>targeting</title>
<button id="target" type="button">press me</button>
<input name="q" id="query">
<select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
<script>
  document.getElementById("target").addEventListener("click", () => {
    document.getElementById("target").textContent = "clicked";
  });
</script>`;

const ADDRESSED = ["session_click", "session_fill", "session_type", "session_select"];

describe("the published schemas let a caller address an element by ref alone", () => {
  for (const name of ADDRESSED) {
    test(`${name} accepts a ref with no selector`, () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
      assert.ok(tool, `${name} is no longer served`);
      assert.ok(tool.inputSchema.properties.ref, `${name} no longer takes a ref`);
      const extra = { session_fill: { value: "x" }, session_type: { text: "x" }, session_select: { text: "x" } }[name] ?? {};
      assert.equal(
        validateArguments({ ref: "@e1", ...extra }, tool.inputSchema),
        null,
        `${name} refuses a ref-only call, so the snapshot-then-act loop its description recommends cannot be sent`,
      );
      assert.ok(
        !(tool.inputSchema.required ?? []).includes("selector"),
        `${name} still publishes selector as required, so a schema-validating client never sends a ref alone`,
      );
    });

    test(`${name} still refuses a call that names no element at all`, () => {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
      const extra = { session_fill: { value: "x" }, session_type: { text: "x" }, session_select: { text: "x" } }[name] ?? {};
      assert.match(
        String(validateArguments({ ...extra }, tool.inputSchema)),
        /selector or ref/,
        `${name} accepted a call with neither selector nor ref, which can only act on nothing`,
      );
    });
  }
});

describe("the published bounds are enforced, not decorative", () => {
  test("a ref that is not @eN is refused before it reaches a page script", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "session_click");
    assert.match(
      String(validateArguments({ ref: "e1']\"); window.pwned = 1; //" }, tool.inputSchema)),
      /ref must match/,
      "a ref outside its declared pattern was accepted and would be spliced into the page",
    );
  });

  test("every declared minimum and maximum refuses the value just outside it", () => {
    const offences = [];
    for (const tool of TOOL_DEFINITIONS) {
      for (const [key, prop] of Object.entries(tool.inputSchema.properties ?? {})) {
        // Every other argument must be valid, or the refusal names that one instead.
        const props = tool.inputSchema.properties ?? {};
        const valid = (p) => p.enum?.[0] ?? (p.type === "integer" || p.type === "number" ? (p.minimum ?? 1) : p.type === "boolean" ? false : "x");
        const base = Object.fromEntries((tool.inputSchema.required ?? []).filter((r) => r !== key).map((r) => [r, valid(props[r] ?? {})]));
        for (const [bound, outside] of [["minimum", (prop.minimum ?? 0) - 1], ["maximum", (prop.maximum ?? 0) + 1]]) {
          if (typeof prop[bound] !== "number") continue;
          const verdict = validateArguments({ ...base, [key]: outside }, tool.inputSchema);
          if (!verdict || !verdict.includes(key)) offences.push(`${tool.name}.${key}=${outside} passed its ${bound}`);
        }
      }
    }
    assert.ok(TOOL_DEFINITIONS.some((t) => Object.values(t.inputSchema.properties ?? {}).some((p) => typeof p.minimum === "number")),
      "no tool declares a minimum, so this check proves nothing");
    assert.deepEqual(offences, [], offences.join("; "));
  });
});

/** One stdio MCP server in standalone mode, driven with real JSON-RPC frames. */
function startServer(env) {
  const proc = spawn(process.execPath, [serverPath], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  const waiting = new Map();
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  let next = 1;
  const call = (method, params, timeoutMs = 30000) => new Promise((resolve, reject) => {
    const id = next++;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`[timed out after ${timeoutMs}ms] no answer to ${method} ${params?.name ?? ""}`));
    }, timeoutMs);
    waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { proc, call };
}

const text = (message) => {
  assert.equal(message.error, undefined, `the server refused: ${message.error?.message}`);
  assert.notEqual(message.result?.isError, true, `the tool failed: ${message.result?.content?.[0]?.text}`);
  return message.result.content[0].text;
};

describe("snapshot, then act by ref, over the real stdio server", () => {
  let home;
  let server;
  let pageUrl;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), "t3rnel-targeting-"));
    const file = join(home, "page.html");
    writeFileSync(file, PAGE);
    pageUrl = `file://${file}`;
    server = startServer({
      T3RNEL_SESSION_MODE: "standalone",
      T3RNEL_SESSION_PROFILE: join(home, "profile"),
      // The user's own bridge must not answer for this server.
      T3RNEL_SESSION_PORT: "47931",
    });
    const init = await server.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "targeting-test", version: "1" } });
    assert.ok(init.result, `initialize failed: ${init.error?.message}`);
    text(await server.call("tools/call", { name: "session_navigate", arguments: { url: pageUrl } }, 60000));
    text(await server.call("tools/call", { name: "session_wait", arguments: { condition: "selector", value: "#target", timeoutMs: 15000 } }));
  });

  after(async () => {
    server?.proc.kill("SIGTERM");
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const read = async (expression) =>
    text(await server.call("tools/call", { name: "session_evaluate", arguments: { code: expression } }));

  test("the tools/list a client receives does not require a selector", async () => {
    const listed = await server.call("tools/list", {});
    for (const name of ADDRESSED) {
      const tool = listed.result.tools.find((t) => t.name === name);
      assert.ok(tool, `${name} is missing from tools/list`);
      assert.ok(!(tool.inputSchema.required ?? []).includes("selector"), `${name} is served with selector required`);
    }
  });

  test("a ref from session_snapshot drives a click", async () => {
    const snap = JSON.parse(text(await server.call("tools/call", { name: "session_snapshot", arguments: {} })));
    const button = snap.elements.find((e) => e.tag === "button");
    assert.ok(button?.ref, "the snapshot did not list the button");
    text(await server.call("tools/call", { name: "session_click", arguments: { ref: button.ref } }));
    assert.equal(await read(`document.getElementById("target").textContent`), "clicked", "the click by ref never reached the button");
  });

  test("a ref from session_snapshot drives a fill and a select", async () => {
    const snap = JSON.parse(text(await server.call("tools/call", { name: "session_snapshot", arguments: {} })));
    const field = snap.elements.find((e) => e.tag === "input");
    const dropdown = snap.elements.find((e) => e.tag === "select");
    text(await server.call("tools/call", { name: "session_fill", arguments: { ref: field.ref, value: "by ref" } }));
    assert.equal(await read(`document.getElementById("query").value`), "by ref");
    text(await server.call("tools/call", { name: "session_select", arguments: { ref: dropdown.ref, text: "Beta" } }));
    assert.equal(await read(`document.getElementById("choice").value`), "b");
  });

  test("a selector containing double quotes fills the field it names", async () => {
    text(await server.call("tools/call", { name: "session_fill", arguments: { selector: 'input[name="q"]', value: "quoted" } }));
    assert.equal(await read(`document.getElementById("query").value`), "quoted", "a quoted attribute selector did not reach the field");
  });

  test("a quoted selector that matches nothing is refused as not found, not as broken script", async () => {
    const message = await server.call("tools/call", { name: "session_click", arguments: { selector: 'button[data-x="missing"]' } });
    const refusal = message.error?.message ?? message.result?.content?.[0]?.text ?? "";
    assert.match(refusal, /Element not found: button\[data-x="missing"\]/, `the refusal was: ${refusal}`);
    assert.doesNotMatch(refusal, /SyntaxError|Unexpected identifier|missing \) after/, "the selector broke the page script");
  });

  /**
   * An MCP client stops a stdio server with a signal as often as by closing stdin, and
   * the bridge only cleaned up on stdin close. SIGTERM ended node and left its Chrome
   * running — every test run of this file leaked one browser window, and so does every
   * client that restarts the server.
   */
  test("a bridge stopped with SIGTERM takes its standalone browser with it", async () => {
    const profile = join(home, "profile");
    const browsers = () => readdirSync("/proc").filter((pid) => /^\d+$/.test(pid)).filter((pid) => {
      try {
        // Chrome rewrites its own argv into one space-joined string, so match on text.
        const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
        return argv.includes(`--user-data-dir=${profile} `) && argv.includes("--remote-debugging-port") && !argv.includes("--type=");
      } catch { return false; }
    });
    assert.ok(browsers().length > 0, "no standalone browser was running, so this proves nothing");
    const exited = new Promise((resolve) => server.proc.once("exit", resolve));
    server.proc.kill("SIGTERM");
    await exited;
    const deadline = Date.now() + 10_000;
    while (browsers().length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(browsers(), [], "the standalone browser outlived the bridge that launched it");
  });
});
