/**
 * A default stated in a tool description is a promise about the extension's behaviour,
 * and the two live in different repositories with nothing holding them together.
 *
 * `session_record_events` advertised "default 500" while the recorder used 100. Nothing
 * failed: a caller who omitted `limit` got a short page, assumed the recording was short,
 * and never learned otherwise. That is the whole class this pins — the numbers a caller
 * plans around, checked against the code that actually applies them.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { TOOL_DEFINITIONS } = await import(join(root, "src", "tools.js"));

const recorder = readFileSync(
  join(root, "..", "..", "browser", "t3rnel-browser", "src", "features", "session-recorder.ts"),
  "utf8",
);

describe("documented defaults match the code that applies them", () => {
  const applied = new Map(
    [...recorder.matchAll(/readOptionalNumber\(args,\s*"(\w+)"\)\s*\?\?\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]),
  );

  test("the recorder's defaults were found at all", () => {
    // Without this the loop below iterates an empty map and passes while proving nothing.
    assert.ok(
      applied.size >= 3,
      `only ${applied.size} defaults parsed from session-recorder.ts; the matcher is broken`,
    );
    assert.equal(applied.get("limit"), 100, "the parse found a limit default that is not the one in the source");
  });

  test("every default a tool advertises is the default the recorder applies", () => {
    const mismatches = [];
    for (const tool of TOOL_DEFINITIONS) {
      for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
        const stated = property.description?.match(/\(default (\d+)\)/);
        if (!stated || !applied.has(name)) continue;
        if (Number(stated[1]) !== applied.get(name)) {
          mismatches.push(
            `${tool.name}.${name} advertises ${stated[1]} but the recorder applies ${applied.get(name)}`,
          );
        }
      }
    }
    assert.deepEqual(mismatches, [], mismatches.join("; "));
  });

  test("the parameters whose defaults callers depend on actually state one", () => {
    // A silent default is the same defect wearing a different hat: the caller still cannot
    // predict the page size without reading another repository's source.
    for (const [toolName, parameter] of [
      ["session_record_events", "limit"],
      ["session_record_start", "maxEvents"],
    ]) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === toolName);
      assert.ok(tool, `${toolName} is no longer offered`);
      assert.match(
        tool.inputSchema.properties[parameter].description,
        /\(default \d+\)/,
        `${toolName}.${parameter} has a default in code that its description does not state`,
      );
    }
  });
});
