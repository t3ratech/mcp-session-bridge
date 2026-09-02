/**
 * A ref that `session_snapshot` hands out must resolve in the tool it is handed to.
 *
 * Nothing checked that. The suite asserted that `ref` was *accepted* as an argument and
 * that an unresolvable one produced a helpful refusal — never that a ref the snapshot had
 * just produced could then be acted on.
 *
 * It could not, in standalone mode. The extension emits and matches `@eN`; standalone
 * emitted a bare `eN` and matched literally, so an agent that had read the descriptions
 * (which say `@e12`) or had ever run against the extension built `[data-t3rnel-ref='@e12']`
 * and got "Element not found" for a ref the snapshot had given it one call earlier.
 *
 * This drives a real browser because the defect lives in a string that only exists once
 * the page is loaded and the attribute is written.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { StandaloneBrowser, executeStandaloneTool } = await import(join(root, "src", "cdp.js"));

/** Read the text a tool returned, which the bridge wraps in an MCP content block. */
const payload = (result) => {
  const text = result?.content?.[0]?.text;
  assert.ok(typeof text === "string", "the tool returned no text content to read");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const PAGE = `<!doctype html><meta charset="utf-8"><title>Ref round trip</title>
<button id="target">Press me</button>
<input id="field" value="">
<select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
<script>
  document.getElementById("target").addEventListener("click", () => {
    document.getElementById("target").textContent = "clicked";
  });
</script>`;

describe("a ref from a snapshot resolves in the tools that take one", () => {
  let browser;
  let home;
  let pageUrl;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), "t3rnel-refs-"));
    const file = join(home, "page.html");
    writeFileSync(file, PAGE);
    pageUrl = `file://${file}`;
    browser = new StandaloneBrowser({ profileDir: join(home, "profile") });
    await browser.ensureStarted();
    await executeStandaloneTool(browser, "session_navigate", { url: pageUrl });
    await executeStandaloneTool(browser, "session_wait", { condition: "selector", value: "#target", timeoutMs: 15000 });
  });

  after(async () => {
    await browser?.close?.().catch(() => {});
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("the snapshot produced refs at all", async () => {
    // Rule: pin existence before asserting anything about the shape, or an empty element
    // list satisfies every check below.
    const snap = payload(await executeStandaloneTool(browser, "session_snapshot", {}));
    assert.ok(Array.isArray(snap.elements), "the snapshot returned no element list");
    assert.ok(snap.elements.length >= 3, `the snapshot found ${snap.elements.length} elements on a page with three`);
  });

  test("refs are emitted in the same shape the extension uses", async () => {
    const snap = payload(await executeStandaloneTool(browser, "session_snapshot", {}));
    for (const element of snap.elements) {
      assert.match(
        element.ref,
        /^@e\d+$/,
        `standalone emitted ${element.ref}, which is not the @eN form the extension emits and the descriptions promise`,
      );
    }
  });

  test("a ref the snapshot returned drives a click", async () => {
    const snap = payload(await executeStandaloneTool(browser, "session_snapshot", {}));
    const button = snap.elements.find((element) => element.tag === "button");
    assert.ok(button, "the snapshot did not list the button, so this proves nothing");

    await executeStandaloneTool(browser, "session_click", { ref: button.ref });
    const after = payload(await executeStandaloneTool(browser, "session_evaluate", {
      code: "document.getElementById('target').textContent",
    }));
    assert.equal(after, "clicked", "the click by ref did not reach the button");
  });

  test("a ref the snapshot returned drives a fill", async () => {
    const snap = payload(await executeStandaloneTool(browser, "session_snapshot", {}));
    const field = snap.elements.find((element) => element.tag === "input");
    assert.ok(field, "the snapshot did not list the input");

    await executeStandaloneTool(browser, "session_fill", { ref: field.ref, value: "written by ref" });
    const value = payload(await executeStandaloneTool(browser, "session_evaluate", {
      code: "document.getElementById('field').value",
    }));
    assert.equal(value, "written by ref", "the fill by ref did not reach the input");
  });

  test("a ref the snapshot returned drives a select", async () => {
    const snap = payload(await executeStandaloneTool(browser, "session_snapshot", {}));
    const dropdown = snap.elements.find((element) => element.tag === "select");
    assert.ok(dropdown, "the snapshot did not list the select");

    const chosen = payload(await executeStandaloneTool(browser, "session_select", { ref: dropdown.ref, text: "Beta" }));
    assert.equal(chosen.value, "b", "selecting by ref chose the wrong option");
  });

  test("the bare eN form still resolves, so an older caller does not break", async () => {
    const snap = payload(await executeStandaloneTool(browser, "session_snapshot", {}));
    const field = snap.elements.find((element) => element.tag === "input");
    const bare = field.ref.replace(/^@/, "");
    assert.notEqual(bare, field.ref, "the ref carried no @ to strip, so this asserts nothing");

    await executeStandaloneTool(browser, "session_fill", { ref: bare, value: "bare ref" });
    const value = payload(await executeStandaloneTool(browser, "session_evaluate", {
      code: "document.getElementById('field').value",
    }));
    assert.equal(value, "bare ref", "a bare eN ref no longer resolves");
  });
});
