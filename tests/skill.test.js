/**
 * The published skill, checked against the server it describes.
 *
 * A skill is a discovery surface: an agent reads it and decides whether this server can
 * do the job. That makes every claim in it a claim a store can delist for — the same
 * class of drift that got the extension's first listing rejected for metadata that no
 * longer matched the product. So every tool it names must exist, and every count in it
 * must be the count the code actually serves.
 *
 * They live under `agent-skills/`, not `skills/`. In this codebase `skills/` already
 * means a Rust crate compiled to WASM, with a signed ABI and a registry two crates read
 * — a different thing entirely from a Markdown file an AI client reads. Smithery syncs
 * from `agent-skills/<name>/`, so there is one copy rather than two that drift.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsDir = join(root, "agent-skills");
const skillNames = readdirSync(skillsDir).filter((name) =>
  statSync(join(skillsDir, name)).isDirectory());
const skillText = Object.fromEntries(
  skillNames.map((name) => [name, readFileSync(join(skillsDir, name, "SKILL.md"), "utf8")]));
const skill = skillText["signed-in-browser"];
const { TOOL_DEFINITIONS, STANDALONE_TOOLS, EXTENSION_ONLY_TOOLS } = await import(join(root, "src", "tools.js"));
const known = new Set(TOOL_DEFINITIONS.map((t) => t.name));

describe("the skill describes the server that actually exists", () => {
  test("names only tools the server serves", () => {
    const referenced = [...new Set(skill.match(/session_[a-z_]+/g) ?? [])];
    assert.ok(referenced.length > 5, "the skill names almost no tools, which is not a usable skill");
    const invented = referenced.filter((name) => !known.has(name));
    assert.deepEqual(invented, [], `the skill names tools that do not exist: ${invented.join(", ")}`);
  });

  test("states the tool counts the code actually serves", () => {
    // The standalone figure is the tools that run with nothing installed, not the whole
    // surface. Pinning `TOOL_DEFINITIONS.length` here told an agent it had recording and a
    // credential vault in standalone mode; both refuse, and it found out one error at a time.
    assert.match(skill, new RegExp(`serves ${STANDALONE_TOOLS.length} tools`));

    const registry = readFileSync(
      join(root, "..", "..", "browser", "t3rnel-browser", "src", "browser-tools.ts"), "utf8",
    );
    const open = registry.indexOf("[", registry.indexOf("export const BROWSER_TOOL_NAMES"));
    const names = [...registry.slice(open, registry.indexOf("] as const", open)).matchAll(/"([a-z0-9_]+)"/g)];
    assert.match(skill, new RegExp(`serves ${names.length + 1}\\b`), "the with-extension count is stale");
  });

  test("tells the agent which tools refuse without the extension", () => {
    // An agent planning a standalone run needs the names, not just a count. Without this
    // the skill can state "14 tools" correctly and still leave the reader to discover the
    // other eight by calling them and reading errors.
    const section = skill.slice(skill.indexOf("refuse without the extension"));
    assert.ok(section.length > 100, "the skill no longer explains which tools need the extension");
    const missing = EXTENSION_ONLY_TOOLS.map((tool) => tool.name).filter((name) => !section.includes(name));
    assert.deepEqual(
      missing,
      [],
      `these tools refuse without the extension but the skill never names them: ${missing.join(", ")}`,
    );
    for (const tool of STANDALONE_TOOLS) {
      assert.ok(
        !new RegExp(`${tool.name}[^_]`).test(section.slice(0, section.indexOf("\n\n"))),
        `${tool.name} works standalone but is listed among the tools that refuse`,
      );
    }
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

/**
 * Every published skill, checked against the server and the sites it describes.
 *
 * These are operational instructions other teams follow without checking. A skill naming
 * a tool that does not exist, or a limit that has moved, sends an agent down a path that
 * fails for a reason the skill told it to rule out — which is exactly the failure the
 * signed-in-browser skill exists to prevent, one level up.
 */
describe("every skill in this repository", () => {
  test("there are several, and each has a SKILL.md", () => {
    assert.ok(skillNames.length >= 3, `only ${skillNames.length} skill(s) found`);
    for (const name of skillNames) {
      assert.ok(skillText[name].length > 500, `${name}/SKILL.md is too short to be useful`);
    }
  });

  test("each carries frontmatter a host can route on", () => {
    for (const [name, text] of Object.entries(skillText)) {
      const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
      assert.ok(frontmatter, `${name} has no frontmatter`);
      assert.match(frontmatter[1], new RegExp(`^name: ${name}$`, "m"), `${name}'s frontmatter name does not match its directory`);

      const description = frontmatter[1].match(/^description: (.+)$/m);
      assert.ok(description, `${name} has no description`);
      assert.ok(description[1].length > 100, `${name}'s description is too thin to route a request by`);
      assert.ok(description[1].length < 1024, `${name}'s description is longer than hosts display`);
      assert.match(description[1], /Use when/i, `${name} does not say when to use it`);
    }
  });

  test("none of them names a session tool that does not exist", () => {
    for (const [name, text] of Object.entries(skillText)) {
      const invented = [...new Set(text.match(/session_[a-z_]+/g) ?? [])].filter((t) => !known.has(t));
      assert.deepEqual(invented, [], `${name} names tools that do not exist: ${invented.join(", ")}`);
    }
  });

  test("every link points at something of ours or a site the skill is about", () => {
    const allowed = /^https?:\/\/(t3ratech\.github\.io|github\.com|smithery\.ai|glama\.ai|mcpservers\.org|news\.ycombinator\.com|hn\.algolia\.com|www\.npmjs\.com)/;
    for (const [name, text] of Object.entries(skillText)) {
      for (const url of text.match(/https?:\/\/[^\s<>)"`]+/g) ?? []) {
        assert.match(url, allowed, `${name} links to ${url}, which is neither ours nor a site it documents`);
      }
    }
  });

  test("the publishing skill records the traps that were paid for", () => {
    // Each of these cost a failed submission to discover. A skill that loses them is
    // worth less than the time it took to write.
    const publish = skillText["publish-mcp-server"];
    assert.ok(publish, "the publish-mcp-server skill is missing");
    for (const [what, pattern] of [
      ["Glama's 400-character description limit", /400 characters/],
      ["Glama having no /submit page", /no `?\/submit`? page|parsed as a \*?search\*?/i],
      ["the required category select on mcpservers.org", /required category/i],
      ["the paid options to leave alone", /\$39|paid option/i],
      ["a checkbox's value not being its state", /`?value`? is `?"?on"?`?/i],
      ["Smithery needing inputSchema per tool", /inputSchema/],
      ["linking to source rather than a marketing site", /source repository, not to a marketing site|not to a marketing site/i],
      ["mcp.so being excluded and why", /support ticket/i],
    ]) {
      assert.match(publish, pattern, `the publishing skill no longer records ${what}`);
    }
  });

  test("the Hacker News skill records the rules that make a submission worth spending", () => {
    const hn = skillText["post-to-hacker-news"];
    assert.ok(hn, "the post-to-hacker-news skill is missing");
    assert.match(hn, /80 characters/, "the title length limit is gone");
    assert.match(hn, /url`? and `?text`? are exclusive|exclusive/i, "the url-or-text rule is gone");
    assert.match(hn, /\/newest/, "nothing says how to tell a submission succeeded");
    assert.match(hn, /first comment/i, "the first-comment convention is gone");
    for (const selector of ["input[name=title]", "input[name=url]", "input[type=submit]"]) {
      assert.ok(hn.includes(selector), `the HN skill no longer names ${selector}`);
    }
  });

  test("each publishing skill says a filled form is not a submission", () => {
    for (const name of ["publish-mcp-server", "post-to-hacker-news"]) {
      assert.match(
        skillText[name],
        /filled form is not a submission|re-snapshot|did not go/i,
        `${name} does not say how to tell a submission from a silent failure`,
      );
    }
  });
});
