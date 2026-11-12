/**
 * Tool profiles: a client that loads the whole tool list pays for all of it on every session.
 *
 * The extension publishes 97 tools and their definitions are about 61,000 characters (roughly 15,000 tokens)
 * that every MCP client puts in front of the model before the first question. `T3RNEL_SESSION_TOOLS` (or
 * `--tools`) lists only the profiles a session needs. The default stays `all`, so nothing disappears on upgrade;
 * a tool that is not listed is still callable by name, exactly as with the 100-tool ceiling.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROFILE_NAMES, filterByProfiles, parseToolProfiles, toolProfile } from "../src/profiles.js";
import { TOOL_DEFINITIONS } from "../src/tools.js";
import { extensionSrcRoot } from "./_t3rnel-root.mjs";

/** The real extension registry, read from its source: the names a profile must classify. */
const extensionNames = (() => {
  const file = join(extensionSrcRoot(), "browser-tools.ts");
  assert.ok(existsSync(file), `the extension source is missing at ${file}`);
  const names = [...readFileSync(file, "utf8").matchAll(/case "browser_(\w+)":/g)].map((m) => `session_${m[1]}`);
  return [...new Set(names)];
})();

describe("every tool belongs to exactly one profile", () => {
  it("covers the extension's whole registry and the bridge's own tools", () => {
    assert.ok(extensionNames.length >= 90, `read ${extensionNames.length} extension tools; the registry did not parse`);
    for (const name of [...extensionNames, ...TOOL_DEFINITIONS.map((t) => t.name), "session_install"]) {
      assert.ok(PROFILE_NAMES.includes(toolProfile(name)), `${name} is in no profile`);
    }
  });

  it("puts the everyday verbs in core and a representative tool of each other profile where its work is", () => {
    for (const name of ["navigate", "snapshot", "click", "fill", "read_page", "screenshot", "list_tabs", "install"]) {
      assert.equal(toolProfile(`session_${name}`), "core", name);
    }
    assert.equal(toolProfile("session_network_list"), "network");
    assert.equal(toolProfile("session_console_start"), "network");
    assert.equal(toolProfile("session_css_scan"), "design");
    assert.equal(toolProfile("session_fullpage_capture"), "design");
    assert.equal(toolProfile("session_record_start"), "test");
    assert.equal(toolProfile("session_codegen_export"), "test");
    assert.equal(toolProfile("session_vault_save"), "vault");
    assert.equal(toolProfile("session_firewall_set_policy"), "vault");
    assert.equal(toolProfile("session_audit"), "page");
    assert.equal(toolProfile("session_a_tool_that_does_not_exist_yet"), "page", "a new tool stays reachable in the catch-all profile");
  });

  it("keeps core small: it is the whole point", () => {
    const core = extensionNames.filter((n) => toolProfile(n) === "core");
    assert.ok(core.length >= 15 && core.length <= 30, `core has ${core.length} tools`);
  });
});

describe("parseToolProfiles", () => {
  it("treats nothing, empty and all as every tool", () => {
    for (const value of [undefined, "", "  ", "all", "ALL", " all "]) assert.equal(parseToolProfiles(value), null, JSON.stringify(value));
  });

  it("always includes core and accepts any listing of profiles, in any case, with spaces", () => {
    assert.deepEqual([...parseToolProfiles("network")].sort(), ["core", "network"]);
    assert.deepEqual([...parseToolProfiles(" Design , TEST,design ")].sort(), ["core", "design", "test"]);
    assert.deepEqual([...parseToolProfiles("core")], ["core"]);
  });

  it("refuses an unknown profile by name and lists the valid ones, instead of quietly listing everything or nothing", () => {
    assert.throws(() => parseToolProfiles("network,netwrok"), /unknown tool profile "netwrok".*all.*core.*network/s);
  });

  it("refuses 'all' mixed with profiles, which could only mean one of the two", () => {
    assert.throws(() => parseToolProfiles("all,network"), /all.*cannot be combined/s);
  });
});

describe("filterByProfiles", () => {
  const tools = ["session_navigate", "session_network_list", "session_css_scan", "session_vault_save"].map((name) => ({ name }));

  it("returns the list untouched for all, and only the chosen profiles otherwise", () => {
    assert.equal(filterByProfiles(tools, null), tools);
    assert.deepEqual(filterByProfiles(tools, parseToolProfiles("network")).map((t) => t.name), ["session_navigate", "session_network_list"]);
    assert.deepEqual(filterByProfiles(tools, parseToolProfiles("core")).map((t) => t.name), ["session_navigate"]);
  });

  it("measurably shrinks the list a client has to read", () => {
    const real = extensionNames.map((name) => ({ name, description: "x".repeat(500) }));
    const core = filterByProfiles(real, parseToolProfiles("core"));
    assert.ok(core.length < real.length / 3, `core ${core.length} of ${real.length}`);
  });
});
