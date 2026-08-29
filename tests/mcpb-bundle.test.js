/**
 * The MCPB bundle Smithery distributes for the stdio release.
 *
 * A bundle is only correct if it starts on a machine that has nothing else installed —
 * no repository, no node_modules, no npm package. The first one built here did not: it
 * shipped `src/` without the `package.json` the server reads its own version from, and
 * without which Node does not even treat the files as ESM. Nothing in the build reported
 * a problem; it failed on the first `node server/src/server.js`.
 *
 * So these cases assert the layout a cold machine needs, and that every count in the
 * manifest comes from the thing it describes rather than from a paragraph someone typed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { buildManifest } = await import(join(root, "scripts", "build-mcpb.mjs"));
const { TOOL_DEFINITIONS } = await import(join(root, "src", "tools.js"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

describe("the MCPB manifest describes the server that is actually shipped", () => {
  const manifest = buildManifest();

  test("declares the manifest version the spec is written against", () => {
    assert.equal(manifest.manifest_version, "0.3");
  });

  test("carries the same version as the package, so a release cannot ship two numbers", () => {
    assert.equal(manifest.version, pkg.version);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  });

  test("advertises exactly the tools the server answers tools/list with", () => {
    // A manifest naming a tool the server does not have is the drift a store delists for.
    assert.deepEqual(
      manifest.tools.map((t) => t.name).sort(),
      TOOL_DEFINITIONS.map((t) => t.name).sort(),
    );
    for (const tool of manifest.tools) {
      assert.ok(tool.description.length > 20, `${tool.name} has no description a client could choose it by`);
    }
  });

  test("states tool counts that match what the code actually serves", () => {
    // Measured by running the bundle both ways: 20 alone, 99 with the extension relay.
    const standalone = String(TOOL_DEFINITIONS.length);
    assert.match(manifest.long_description, new RegExp(`serves ${standalone} tools`));

    const registry = readFileSync(
      join(root, "..", "..", "products", "browser-extension", "src", "browser-tools.ts"), "utf8",
    );
    const open = registry.indexOf("[", registry.indexOf("export const BROWSER_TOOL_NAMES"));
    const names = [...registry.slice(open, registry.indexOf("] as const", open)).matchAll(/"([a-z0-9_]+)"/g)];
    assert.ok(names.length > 50, "the extension registry parsed to an implausible count");
    assert.match(manifest.long_description, new RegExp(`serves ${names.length + 1}\\b`));
  });

  test("names an entry point, a runtime and a command that agree with each other", () => {
    assert.equal(manifest.server.type, "node");
    assert.equal(manifest.server.entry_point, "server/src/server.js");
    assert.equal(manifest.server.mcp_config.command, "node");
    assert.ok(
      manifest.server.mcp_config.args[0].endsWith(manifest.server.entry_point),
      "the command does not launch the entry point the manifest names",
    );
  });

  test("declares every platform and runtime the server is claimed to work on", () => {
    assert.deepEqual(manifest.compatibility.platforms.sort(), ["darwin", "linux", "win32"]);
    assert.equal(manifest.compatibility.runtimes.node, pkg.engines.node);
  });

  test("points every link at a page that is part of this product", () => {
    for (const url of [manifest.homepage, manifest.documentation, manifest.support, ...manifest.privacy_policies]) {
      assert.match(url, /^https:\/\/(t3ratech\.github\.io|github\.com\/t3ratech)/, `${url} is not one of ours`);
    }
  });

  test("maps every configurable value onto a user_config entry that exists", () => {
    // `${user_config.x}` with no `x` defined is silently empty at runtime.
    for (const value of Object.values(manifest.server.mcp_config.env)) {
      const referenced = value.match(/^\$\{user_config\.([a-z_]+)\}$/);
      assert.ok(referenced, `${value} is not a user_config reference`);
      assert.ok(
        manifest.user_config[referenced[1]],
        `the manifest reads user_config.${referenced[1]}, which it never defines`,
      );
    }
  });
});

describe("the bundle starts on a machine that has nothing else installed", () => {
  const bundle = join(root, "build", `${buildManifest().name}-${pkg.version}.mcpb`);

  test("has been built", () => {
    assert.ok(existsSync(bundle), `no bundle at ${bundle} — run node scripts/build-mcpb.mjs`);
  });

  test("is a zip with manifest.json at its root, which is what makes it an MCPB", () => {
    const listing = execFileSync("unzip", ["-Z1", bundle], { encoding: "utf8" }).split("\n");
    assert.ok(listing.includes("manifest.json"), "manifest.json is not at the root of the bundle");
    assert.ok(listing.includes("server/src/server.js"), "the entry point is not in the bundle");
    assert.ok(listing.includes("server/package.json"), "no package.json beside the server");
    assert.ok(listing.includes("icon.png"), "the manifest names an icon the bundle does not carry");
  });

  test("answers initialize and tools/list when extracted somewhere else entirely", () => {
    const where = mkdtempSync(join(tmpdir(), "mcpb-"));
    try {
      execFileSync("unzip", ["-q", bundle, "-d", where]);
      const frames = [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      ].join("\n");

      // HOME is redirected so the bridge finds no relay socket and reports its own
      // surface rather than the extension's — the count a fresh install actually sees.
      const out = execFileSync("node", [join(where, "server", "src", "server.js")], {
        input: `${frames}\n`, encoding: "utf8", timeout: 30_000,
        env: { ...process.env, HOME: join(where, "nohome"), USERPROFILE: join(where, "nohome") },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const replies = out.split("\n").filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);

      const initialized = replies.find((r) => r.id === 1);
      assert.ok(initialized, "the extracted bundle never answered initialize");
      assert.equal(initialized.result.serverInfo.version, pkg.version);

      const listed = replies.find((r) => r.id === 2);
      assert.ok(listed, "the extracted bundle never answered tools/list");
      assert.equal(
        listed.result.tools.length, TOOL_DEFINITIONS.length,
        "a fresh install serves a different number of tools than the manifest advertises",
      );
    } finally {
      rmSync(where, { recursive: true, force: true });
    }
  });
});
