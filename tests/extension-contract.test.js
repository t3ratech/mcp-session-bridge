/**
 * The bridge declares a schema; the extension enforces a different one, in another
 * repository, with no compiler between them.
 *
 * `session_close_tab` shipped declaring `tabId` optional and promising it would close the
 * active tab when omitted. The extension's handler reads it with `readRequiredNumber` and
 * throws, so the documented default never existed: a caller that trusted the description
 * got "missing required browser arg: tabId" back from inside the extension, for a tool
 * that had never had a default at all.
 *
 * Most handlers resolve the tab with `resolveTabId`, which does fall back to the active
 * tab — so the two behaviours look identical from the bridge and can only be told apart by
 * reading the extension. That is what this does.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { TOOL_DEFINITIONS, SESSION_TO_BROWSER } = await import(join(root, "src", "tools.js"));

const extensionRoot = join(root, "..", "..", "browser", "t3rnel-browser", "src");
const sources = ["browser-tools.ts", "browser-tools-extended.ts"]
  .map((name) => join(extensionRoot, name))
  .filter((path) => existsSync(path))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");

/** `case "browser_x": return handler(api, args);` — the switch is the only registry there is. */
const handlerFor = new Map(
  [...sources.matchAll(/case "(browser_\w+)":\s*\n\s*return (\w+)\(/g)].map((m) => [m[1], m[2]]),
);

/** A top-level function body, from its signature to the next line that closes it. */
function bodyOf(name) {
  const start = sources.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (start === -1) return null;
  const end = sources.indexOf("\n}\n", start);
  return sources.slice(start, end === -1 ? undefined : end);
}

describe("the bridge's schema matches what the extension enforces", () => {
  test("the extension's tool switch parsed at all", () => {
    // Without this every assertion below iterates nothing and the suite is decoration.
    assert.ok(
      handlerFor.size > 40,
      `only ${handlerFor.size} extension handlers parsed; the matcher is broken`,
    );
    assert.equal(handlerFor.get("browser_close_tab"), "closeTab", "the handler parse no longer resolves a known tool");
  });

  const withTabId = TOOL_DEFINITIONS.filter(
    (tool) => tool.inputSchema.properties?.tabId && SESSION_TO_BROWSER[tool.name],
  );

  test("there are tools to check", () => {
    assert.ok(withTabId.length >= 8, `only ${withTabId.length} tools take a tabId; the filter is wrong`);
  });

  for (const tool of withTabId) {
    const browserName = SESSION_TO_BROWSER[tool.name];
    const handler = handlerFor.get(browserName);
    if (!handler) continue;
    const body = bodyOf(handler);
    if (!body) continue;

    const demandsTabId = /readRequiredNumber\(args, "tabId"\)|readRequiredTabId\(/.test(body);
    // Three shapes mean "optional, falls back to the active tab": the shared helper, and
    // the two handlers that resolve it inline because they also create a tab.
    const defaultsToActive =
      /resolveTabId\(/.test(body) ||
      (/readOptionalNumber\(args, "tabId"\)/.test(body) && /active: true/.test(body));
    const required = new Set(tool.inputSchema.required ?? []);

    test(`${tool.name} agrees with ${browserName} on whether tabId is optional`, () => {
      assert.ok(
        demandsTabId || defaultsToActive,
        `${handler} resolves tabId in a way this test does not recognise, so it proves nothing about ${tool.name}`,
      );
      if (demandsTabId) {
        assert.ok(
          required.has("tabId"),
          `${tool.name} declares tabId optional but ${handler} throws without it, so the documented default does not exist`,
        );
        assert.doesNotMatch(
          tool.inputSchema.properties.tabId.description,
          /when omitted|active tab when/i,
          `${tool.name} promises an active-tab default that ${handler} does not implement`,
        );
      } else {
        assert.ok(
          !required.has("tabId"),
          `${tool.name} demands tabId but ${handler} falls back to the active tab, so the requirement is invented`,
        );
      }
    });
  }
});
