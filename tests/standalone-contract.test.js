import { describe, test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { TOOL_DEFINITIONS, validateArguments, findTool } = await import(join(root, "src", "tools.js"));

/**
 * The standalone implementation must read the arguments the schema declares.
 *
 * `validateArguments` rejects any property the schema does not list, so an implementation
 * reading `args.expression` when the schema says `code` can never receive a value — it
 * reads `undefined` on every call, forever, and returns something plausible instead of
 * failing. Both defects this catches shipped that way: `session_evaluate` evaluated the
 * literal string "undefined" and had never once worked in standalone mode, and
 * `session_wait` silently substituted its default for every caller-supplied timeout.
 *
 * Neither was reachable by a test that called the tools and checked they returned
 * something, which is why this asserts the contract between the two files directly.
 */
describe("the standalone browser implements the declared tool surface", () => {
  /**
   * Comments are stripped before scanning.
   *
   * The first draft matched `args.foo` anywhere in the file, so it flagged the very
   * comments explaining the defects it had just caught — a test that fails on its own
   * documentation is a test people delete.
   */
  const cdp = readFileSync(join(root, "src", "cdp.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const body = cdp.slice(cdp.indexOf("export async function executeStandaloneTool"));
  const cases = [...body.matchAll(/case "(session_\w+)": \{([\s\S]*?)\n    \}/g)];

  test("finds the standalone switch at all", () => {
    assert.ok(cases.length > 5, `only ${cases.length} tool cases parsed; the matcher is broken and this suite proves nothing`);
  });

  test("reads no argument the schema does not declare", () => {
    const offences = [];
    for (const [, name, block] of cases) {
      const def = TOOL_DEFINITIONS.find((tool) => tool.name === name);
      assert.ok(def, `${name} is implemented but not declared, so no client can call it`);
      const declared = new Set(Object.keys(def.inputSchema.properties || {}));
      for (const match of new Set([...block.matchAll(/args\.(\w+)/g)].map((m) => m[1]))) {
        if (!declared.has(match)) {
          offences.push(`${name} reads args.${match}, which the schema does not declare — no caller can ever set it`);
        }
      }
    }
    assert.deepEqual(offences, [], offences.join("; "));
  });

  test("every declared required argument is one a caller can actually pass", () => {
    for (const tool of TOOL_DEFINITIONS) {
      for (const required of tool.inputSchema.required ?? []) {
        assert.ok(
          (tool.inputSchema.properties || {})[required],
          `${tool.name} requires "${required}" but does not declare it as a property, so validation rejects every call`
        );
      }
    }
  });

  test("session_evaluate accepts code and rejects the name that used to be read", () => {
    const tool = findTool("session_evaluate");
    assert.equal(validateArguments({ code: "1+1" }, tool.inputSchema), null, "the documented argument is rejected");
    assert.match(
      String(validateArguments({ expression: "1+1" }, tool.inputSchema)),
      /Unknown argument: expression/,
      "the schema silently accepts the wrong name, which is how the defect hid"
    );
  });

  test("session_wait accepts timeoutMs and rejects timeout", () => {
    const tool = findTool("session_wait");
    assert.equal(validateArguments({ condition: "load", timeoutMs: 30000 }, tool.inputSchema), null);
    assert.match(String(validateArguments({ condition: "load", timeout: 30000 }, tool.inputSchema)), /Unknown argument: timeout/);
  });
});
