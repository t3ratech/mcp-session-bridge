#!/usr/bin/env node
/**
 * Builds the MCPB bundle Smithery distributes for the stdio release.
 *
 * Smithery's publish flow has three shapes: a hosted JS module, an external HTTPS URL,
 * and a stdio server shipped as an MCPB bundle. This bridge is the third and cannot be
 * either of the others — it drives the browser the user is already signed into, over a
 * native-messaging relay on their own machine, so there is no address a remote server
 * could be reached at. The bundle is how a stdio server reaches that audience.
 *
 * Every field that also exists somewhere else is read from there rather than typed
 * again: the version and description come from package.json, and the tool list comes
 * from the same TOOL_DEFINITIONS the server answers `tools/list` with. A manifest that
 * advertises a tool the server does not have is the sort of drift a store removes a
 * listing for, and it is only avoidable by not writing the number down twice.
 *
 *   node scripts/build-mcpb.mjs           build build/<name>-<version>.mcpb
 *   node scripts/build-mcpb.mjs --check   verify the manifest without writing the zip
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const repoRoot = resolve(root, "..", "..", "..");
const outDir = join(root, "build");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const { TOOL_DEFINITIONS } = await import(join(root, "src", "tools.js"));

/**
 * How many tools the extension adds, read from the extension's own registry.
 *
 * The bundle serves 20 tools by itself and 99 once the T3rnel Browser extension is
 * connected — measured, by running the bundle both ways. That difference is the reason
 * someone installs the extension, so the listing states it; and because it is a number
 * that will move the next time a tool is added, it is derived from the registry rather
 * than typed into a paragraph where nobody would notice it going stale.
 */
function extensionToolCount() {
  const source = readFileSync(
    join(repoRoot, "products", "browser", "t3rnel-browser", "src", "browser-tools.ts"), "utf8"
  );
  const start = source.indexOf("export const BROWSER_TOOL_NAMES");
  if (start === -1) throw new Error("build-mcpb: BROWSER_TOOL_NAMES not found in the extension registry");
  const open = source.indexOf("[", start);
  const close = source.indexOf("] as const", open);
  const names = [...source.slice(open + 1, close).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
  if (names.length === 0) throw new Error("build-mcpb: the extension registry parsed to zero tools");
  return names.length;
}

/**
 * The bundle carries its own runtime, so it must carry every file the entry point
 * reaches. The bridge imports nothing outside `node:`, which is what makes a bundle
 * this small possible — but that is a property to assert, not to assume, because one
 * added dependency would produce a bundle that fails only on the user's machine.
 */
function assertNoExternalDependencies() {
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) };
  if (Object.keys(deps).length > 0) {
    throw new Error(
      `build-mcpb: the bundle ships no node_modules, but package.json declares ${Object.keys(deps).join(", ")}. ` +
        "Either vendor them into server/ or stop depending on them."
    );
  }
  const sources = execFileSync("grep", ["-rhoE", 'from "[^."][^"]*"', join(root, "src")], { encoding: "utf8" });
  const external = [...new Set(sources.match(/from "([^"]+)"/g) ?? [])]
    .map((m) => m.slice(6, -1))
    .filter((name) => !name.startsWith("node:"));
  if (external.length > 0) {
    throw new Error(`build-mcpb: src imports ${external.join(", ")}, which the bundle does not ship.`);
  }
}

export function buildManifest() {
  const standalone = TOOL_DEFINITIONS.length;
  const withExtension = extensionToolCount() + 1; // the extension's surface plus session_install
  return {
    manifest_version: "0.3",
    name: "t3rnel-session-bridge",
    display_name: "T3rnel Browser — Session Bridge",
    version: pkg.version,
    description: pkg.description,
    long_description:
      "Most browser automation starts from a cold, empty profile: no cookies, no session, " +
      "no access to anything behind a login. This one attaches to the browser you are " +
      "already using.\n\n" +
      "The bridge is a stdio MCP server. It talks to the free T3rnel Browser extension " +
      "over a native-messaging relay, so every tool runs in your own signed-in tabs — the " +
      "dashboard you are already authenticated to, the ticket you already have open, the " +
      "internal tool that would take an hour to script a login for.\n\n" +
      `On its own the bridge serves ${standalone} tools against a standalone automation ` +
      "browser, so it is useful before you install anything. Install the free T3rnel " +
      `Browser extension and the same server serves ${withExtension} — adding CSS extraction as ` +
      "component code, full-page capture and annotation, a React inspector, network and " +
      "console capture, form filling, colour sampling, and session recording and replay. " +
      "Ask for `session_install` and it will tell you how.\n\n" +
      "Nothing is hosted. No page content leaves your machine, and there is no account to create.",
    author: {
      name: "T3raTech Solutions (Pvt) Ltd",
      email: "t3ratech.dev@gmail.com",
      url: "https://t3ratech.github.io/t3rnel-browser-plugin/",
    },
    repository: { type: "git", url: pkg.repository.url.replace(/^git\+/, "") },
    homepage: pkg.homepage,
    documentation: "https://t3ratech.github.io/t3rnel-browser-plugin/tools.html",
    support: pkg.bugs.url,
    icon: "icon.png",
    license: pkg.license,
    keywords: pkg.keywords,
    privacy_policies: ["https://t3ratech.github.io/t3rnel-browser-plugin/privacy.html"],
    server: {
      type: "node",
      entry_point: "server/src/server.js",
      mcp_config: {
        command: "node",
        args: ["${__dirname}/server/src/server.js"],
        env: {
          T3RNEL_SESSION_MODE: "${user_config.session_mode}",
          T3RNEL_SESSION_HEADLESS: "${user_config.headless}",
          T3RNEL_SESSION_TIMEOUT_MS: "${user_config.timeout_ms}",
        },
      },
    },
    /**
     * Derived from the same list the server answers `tools/list` with, so the two cannot
     * drift — and carrying each tool's full `inputSchema`, not just its name.
     *
     * MCPB's own spec shows only name and description here, so the first bundle carried
     * only those. Smithery builds its server card from this array and rejected the
     * release with one "expected object, received undefined" per tool: a client reading
     * the card has to know what a tool takes before deciding to install anything.
     */
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    tools_generated: false,
    user_config: {
      session_mode: {
        type: "string",
        title: "Session mode",
        description:
          "auto uses the T3rnel Browser extension when its relay is present and falls back to a " +
          "standalone browser; extension requires the extension; standalone always launches its own browser.",
        default: "auto",
        required: false,
      },
      headless: {
        type: "string",
        title: "Run the standalone browser headless",
        description: 'Set to "1" to hide the standalone browser. Ignored in extension mode, which uses your own window.',
        default: "",
        required: false,
      },
      timeout_ms: {
        type: "string",
        title: "Per-call timeout (ms)",
        description: "How long a single tool call may take before it fails rather than hanging the client.",
        default: "30000",
        required: false,
      },
    },
    compatibility: {
      platforms: ["darwin", "win32", "linux"],
      runtimes: { node: pkg.engines.node },
    },
  };
}

function build({ check }) {
  assertNoExternalDependencies();
  const manifest = buildManifest();

  if (check) {
    console.log(`manifest ok: ${manifest.name} ${manifest.version}, ${manifest.tools.length} tools`);
    return;
  }

  const staging = join(outDir, "mcpb");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  cpSync(join(root, "src"), join(staging, "server", "src"), { recursive: true });
  cpSync(join(root, "README.md"), join(staging, "README.md"));
  /**
   * `server/` is a package root, not a loose folder of files.
   *
   * The first bundle shipped only `src/`, and the server did not start: it reads its own
   * version out of `../package.json`, and `"type": "module"` is what makes Node treat
   * these files as ESM at all. Both live in package.json, so the bundle carries it —
   * trimmed to what the runtime actually reads, since npm scripts, devDependencies and
   * publish config mean nothing inside a bundle.
   */
  const runtimePkg = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
    type: pkg.type,
    bin: pkg.bin,
    engines: pkg.engines,
  };
  writeFileSync(join(staging, "server", "package.json"), `${JSON.stringify(runtimePkg, null, 2)}\n`);

  const icon = join(repoRoot, "products", "browser", "t3rnel-browser", "static", "icons", "icon128.png");
  if (!existsSync(icon)) throw new Error(`build-mcpb: no icon at ${icon}, and the manifest names one.`);
  cpSync(icon, join(staging, "icon.png"));

  const bundle = join(outDir, `${manifest.name}-${manifest.version}.mcpb`);
  rmSync(bundle, { force: true });
  // An MCPB bundle is a zip with manifest.json at its root.
  execFileSync("zip", ["-q", "-r", "-X", bundle, "."], { cwd: staging });

  const sha = execFileSync("sha256sum", [bundle], { encoding: "utf8" }).split(" ")[0];
  const bytes = readFileSync(bundle).length;
  console.log(`bundle : ${bundle}`);
  console.log(`version: ${manifest.version}`);
  console.log(`tools  : ${manifest.tools.length}`);
  console.log(`bytes  : ${bytes}`);
  console.log(`sha256 : ${sha}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  build({ check: process.argv.includes("--check") });
}
