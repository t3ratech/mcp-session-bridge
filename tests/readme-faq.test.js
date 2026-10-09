/**
 * The README's Questions section is what a retrieval engine quotes about this
 * bridge (ISSUE-439). It may only say what the package and the extension do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { t3rnelRepoRoot } from "./_t3rnel-root.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { SUPPORTED_MCP_CLIENTS } = await import(join(root, "src", "tools.js"));
const section = readme.split(/^## Questions$/m)[1]?.split(/^## /m)[0] ?? "";
const qa = [...section.matchAll(/^### (.+)\n\n([\s\S]*?)(?=\n### |\n*$)/gm)].map((m) => ({ q: m[1], a: m[2].trim() }));
const flat = (s) => s.replace(/\s+/g, " ");

test("the README answers the questions people ask, each as a statement", () => {
  assert.ok(qa.length >= 8, `only ${qa.length} questions`);
  for (const { q, a } of qa) {
    assert.ok(q.endsWith("?"), q);
    assert.ok(a.length > 40, `${q}: answer too thin`);
  }
});

test("the install command in the FAQ is this package's own name", () => {
  assert.ok(section.includes(pkg.name), "package name");
  assert.ok(flat(section).includes("-y @t3ratech/mcp-session-bridge"));
  assert.ok(flat(section).includes("1.3.0"), "the zero-setup claim is tied to the version that introduced it");
  assert.ok(Number(pkg.version.split(".")[1]) >= 3, "the FAQ says 1.3.0+ needs no native host; the package must be at least that");
});

test("every client the FAQ names is one the bridge declares support for", () => {
  const declared = SUPPORTED_MCP_CLIENTS.split(/,\s*|\s+and\s+/).map((c) => c.trim());
  const named = ["Cursor", "VS Code", "Windsurf", "Antigravity", "IntelliJ", "Codex", "Cline", "Continue.dev", "Aider", "OpenFang"];
  for (const c of named) {
    assert.ok(section.includes(c), `FAQ lacks ${c}`);
    assert.ok(declared.some((d) => d.includes(c)), `${c} is not in SUPPORTED_MCP_CLIENTS`);
  }
});

test("the tool counts equal what the extension publishes, plus the bridge's own session_install", () => {
  const repo = t3rnelRepoRoot();
  const ext = join(repo, "products", "browser", "t3rnel-browser", "src");
  const registry = readFileSync(join(ext, "browser-tools.ts"), "utf8");
  const names = [...registry.slice(registry.indexOf("export const BROWSER_TOOL_NAMES"), registry.indexOf("] as const")).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
  const gate = readFileSync(join(ext, "approval-gate.ts"), "utf8");
  const start = gate.indexOf("export const MCP_INTERNAL_ONLY");
  const internal = [...gate.slice(gate.indexOf("[", start), gate.indexOf("]);", start)).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
  const published = names.length - internal.length;
  assert.ok(flat(section).includes(`exposes ${published} browser tools`), `FAQ must say ${published}`);
  assert.ok(flat(section).includes(`listing to ${published + 1}`), `FAQ must say ${published + 1}`);
  assert.ok(published + 1 < 100, "the FAQ claims the listing is under the 100-tool ceiling");
});

test("the FAQ states the bridge is loopback-only, which the server enforces", () => {
  assert.match(section, /127\.0\.0\.1/);
  const ws = readFileSync(join(root, "src", "ws-server.js"), "utf8");
  assert.match(ws, /server\.listen\(candidate, "127\.0\.0\.1"/);
});

test("the FAQ says the approval gate ships off, which the extension's default confirms", () => {
  const repo = t3rnelRepoRoot();
  const gate = readFileSync(join(repo, "products", "browser", "t3rnel-browser", "src", "approval-gate.ts"), "utf8");
  assert.match(gate, /DEFAULT_APPROVAL_POLICY[\s\S]*?mode: "off"/);
  assert.match(section, /ships off/);
});
