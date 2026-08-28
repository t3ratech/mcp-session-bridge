/**
 * The published skill, checked against the server it describes.
 *
 * A skill is a discovery surface: an agent reads it and decides whether this server can
 * do the job. That makes every claim in it a claim a store can delist for — the same
 * class of drift that got the extension's first listing rejected for metadata that no
 * longer matched the product. So every tool it names must exist, and every count in it
 * must be the count the code actually serves.
 *
 * The skill lives at `skills/signed-in-browser/SKILL.md`, which is the path Smithery
 * syncs from, so there is one copy rather than two that drift.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skill = readFileSync(join(root, "skills", "signed-in-browser", "SKILL.md"), "utf8");
const { TOOL_DEFINITIONS } = await import(join(root, "src", "tools.js"));
const known = new Set(TOOL_DEFINITIONS.map((t) => t.name));

describe("the skill describes the server that actually exists", () => {
  test("names only tools the server serves", () => {
    const referenced = [...new Set(skill.match(/session_[a-z_]+/g) ?? [])];
    assert.ok(referenced.length > 5, "the skill names almost no tools, which is not a usable skill");
    const invented = referenced.filter((name) => !known.has(name));
    assert.deepEqual(invented, [], `the skill names tools that do not exist: ${invented.join(", ")}`);
  });

  test("states the tool counts the code actually serves", () => {
    // 20 standalone, 99 with the extension relay — both measured by running the bundle.
    assert.match(skill, new RegExp(`serves ${TOOL_DEFINITIONS.length} tools`));

    const registry = readFileSync(
      join(root, "..", "..", "clients", "chrome-extension", "src", "browser-tools.ts"), "utf8",
    );
    const open = registry.indexOf("[", registry.indexOf("export const BROWSER_TOOL_NAMES"));
    const names = [...registry.slice(open, registry.indexOf("] as const", open)).matchAll(/"([a-z0-9_]+)"/g)];
    assert.match(skill, new RegExp(`serves ${names.length + 1}\\b`), "the with-extension count is stale");
  });

  test("carries the frontmatter a skill host reads", () => {
    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(frontmatter, "the skill has no frontmatter block");
    assert.match(frontmatter[1], /^name: signed-in-browser$/m);

    const description = frontmatter[1].match(/^description: (.+)$/m);
    assert.ok(description, "the skill has no description, which is what a host matches on");
    // Long enough to describe when to use it, short enough that a host will show it.
    assert.ok(description[1].length > 120, "the description is too thin to route a request by");
    assert.ok(description[1].length < 1024, "the description is longer than hosts display");
    assert.match(description[1], /Use when/i, "the description does not say when to use the skill");
  });

  test("points every link at this product", () => {
    for (const url of skill.match(/https?:\/\/[^\s<>)"]+/g) ?? []) {
      assert.match(
        url, /^https:\/\/(t3ratech\.github\.io|github\.com\/t3ratech)/,
        `${url} is not one of ours`,
      );
    }
  });

  test("names the install path, since that is what an agent needs when the relay is absent", () => {
    assert.match(skill, /session_install/, "nothing tells an agent how to get the signed-in half");
    assert.match(skill, /@t3ratech\/mcp-session-bridge/, "the skill never names the package to install");
  });

  test("tells the agent to verify rather than assume, which is the failure this surface has", () => {
    assert.match(skill, /Verify, don't assume|re-snapshot|Re-snapshot/i);
  });

  test("says what to do before an irreversible action, because this is a live logged-in browser", () => {
    // The whole hazard of this surface: a wrong click sends mail, cancels a subscription
    // or moves money. A skill that omits this is worse than no skill.
    assert.match(skill, /Confirm anything irreversible/i);
    assert.match(skill, /Never enter credentials you generated/i);
    for (const hazard of ["payment", "deleting", "billing"]) {
      assert.match(skill, new RegExp(hazard, "i"), `the skill does not warn about ${hazard}`);
    }
  });

  test("tells the reader when NOT to use it, so it does not get applied to public pages", () => {
    assert.match(skill, /Public page, no login/i);
    assert.match(skill, /don't reach for this|Don't reach for this/i);
  });
});
