import { describe, it } from "node:test";
import assert from "node:assert";
import { findTool, SESSION_TO_BROWSER, TOOL_DEFINITIONS, validateArguments } from "../src/tools.js";

describe("tool surface", () => {
  it("maps every session tool to a browser tool or null for bridge-only tools", () => {
    for (const tool of TOOL_DEFINITIONS) {
      const mapped = SESSION_TO_BROWSER[tool.name];
      if (tool.name === "session_install") {
        assert.strictEqual(mapped, null, `${tool.name} must be bridge-only`);
        continue;
      }
      assert.ok(mapped, `no mapping for ${tool.name}`);
      assert.ok(mapped.startsWith("browser_"), `${tool.name} maps to ${mapped}`);
    }
  });

  it("has unique tool names", () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);
    assert.strictEqual(new Set(names).size, names.length);
  });

  it("exposes the advertised session tools", () => {
    for (const name of [
      "session_install",
      "session_health",
      "session_list_tabs",
      "session_navigate",
      "session_snapshot",
      "session_read_page",
      "session_click",
      "session_fill",
      "session_type",
      "session_press",
      "session_evaluate",
      "session_screenshot",
      "session_wait",
    ]) {
      assert.ok(findTool(name), `missing tool ${name}`);
    }
  });

  it("advertises all supported MCP clients", async () => {
    const { SUPPORTED_MCP_CLIENTS } = await import("../src/tools.js");
    assert.match(SUPPORTED_MCP_CLIENTS, /Claude Code\/Desktop/);
    assert.match(SUPPORTED_MCP_CLIENTS, /OpenFang/);
    assert.match(SUPPORTED_MCP_CLIENTS, /MCP client/);
  });
});

describe("validateArguments", () => {
  const schema = findTool("session_navigate").inputSchema;

  it("accepts valid arguments", () => {
    assert.strictEqual(validateArguments({ url: "https://example.com", newTab: true }, schema), null);
  });

  it("accepts missing optional arguments", () => {
    assert.strictEqual(validateArguments({ url: "https://example.com" }, schema), null);
  });

  it("rejects a missing required argument", () => {
    assert.match(validateArguments({}, schema), /Missing required argument: url/);
  });

  it("rejects a wrong primitive type", () => {
    assert.match(validateArguments({ url: 123 }, schema), /url must be a non-empty string/);
    assert.match(validateArguments({ url: "https://example.com", tabId: "one" }, schema), /tabId must be an integer/);
    assert.match(validateArguments({ url: "https://example.com", newTab: "yes" }, schema), /newTab must be a boolean/);
  });

  it("rejects an empty string for a required string", () => {
    assert.match(validateArguments({ url: "" }, schema), /url must be a non-empty string/);
  });

  it("rejects unknown arguments so typos fail loudly", () => {
    assert.match(validateArguments({ url: "https://example.com", urll: "https://typo.example" }, schema), /Unknown argument: urll/);
  });

  it("rejects non-object arguments", () => {
    assert.match(validateArguments("https://example.com", schema), /arguments must be an object/);
    assert.match(validateArguments(null, schema), /arguments must be an object/);
  });

  it("enforces enums", () => {
    const wait = findTool("session_wait").inputSchema;
    assert.match(validateArguments({ condition: "magic" }, wait), /condition must be one of: load, url, selector/);
    assert.strictEqual(validateArguments({ condition: "load" }, wait), null);
  });

  it("rejects non-integer numbers where integers are required", () => {
    assert.match(validateArguments({ url: "https://example.com", tabId: 1.5 }, schema), /tabId must be an integer/);
  });
});
