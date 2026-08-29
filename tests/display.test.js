import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDisplay, StandaloneBrowser } from "../src/cdp.js";

/*
 * These tests spawn a real process and read back what it was actually given.
 *
 * A fake browser is used rather than a stubbed `spawn`, because the thing under test is
 * the command line and environment Chrome receives. Asserting on an intercepted call
 * would pass just as happily if the arguments were assembled into a variable nobody
 * passed to the child.
 */

let dir;
let fakeBrowser;
const recording = () => join(dir, "argv.json");

before(() => {
  dir = mkdtempSync(join(tmpdir(), "t3rnel-display-"));
  fakeBrowser = join(dir, "fake-chrome");
  writeFileSync(
    fakeBrowser,
    `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.T3RNEL_TEST_RECORDING, JSON.stringify({
  argv: process.argv.slice(2),
  display: process.env.DISPLAY ?? null,
}));
process.exit(0);
`
  );
  chmodSync(fakeBrowser, 0o755);
});

after(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the launcher against the fake browser and returns what the browser saw. */
async function launchAndRecord(options) {
  const profileDir = mkdtempSync(join(dir, "profile-"));
  process.env.T3RNEL_TEST_RECORDING = recording();
  const browser = new StandaloneBrowser({ browserPath: fakeBrowser, profileDir, ...options });
  // The fake exits immediately, so waiting for a debugger port always fails. The failure
  // is expected and irrelevant; the recording it leaves behind is the subject.
  await browser.ensureStarted().catch(() => {});
  assert.ok(existsSync(recording()), "the fake browser did not run, so nothing was tested");
  const seen = JSON.parse(readFileSync(recording(), "utf8"));
  rmSync(recording(), { force: true });
  return seen;
}

describe("virtual display", () => {
  it("reads no display from an environment that sets none", () => {
    assert.strictEqual(defaultDisplay({}), null);
  });

  it("treats a blank display variable as unset rather than as a display named ''", () => {
    assert.strictEqual(defaultDisplay({ T3RNEL_SESSION_DISPLAY: "   " }), null);
  });

  it("runs the browser headful on the configured display", async () => {
    const seen = await launchAndRecord({ display: ":99" });
    assert.strictEqual(seen.display, ":99", "the browser was not pointed at the virtual display");
    assert.ok(
      !seen.argv.includes("--headless=new"),
      "the browser was started headless, which defeats the point of a virtual display"
    );
  });

  it("keeps the display even when headless was also asked for", async () => {
    // Both set is not a contradiction to resolve arbitrarily: a caller who supplied a
    // display has gone to the trouble of running an X server, and headless would waste it.
    const seen = await launchAndRecord({ display: ":99", headless: true });
    assert.strictEqual(seen.display, ":99");
    assert.ok(
      !seen.argv.includes("--headless=new"),
      "headless won over an explicit display"
    );
  });

  it("runs headless when asked and no display is configured", async () => {
    const seen = await launchAndRecord({ headless: true, display: null });
    assert.ok(
      seen.argv.includes("--headless=new"),
      "headless was requested and the browser did not get the flag"
    );
  });

  it("inherits the ambient display when none is configured", async () => {
    const ambient = process.env.DISPLAY ?? null;
    const seen = await launchAndRecord({ display: null });
    assert.strictEqual(seen.display, ambient, "the launcher rewrote a display it was not given");
  });
});
