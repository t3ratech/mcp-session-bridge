#!/usr/bin/env node
/**
 * Publishes the stdio release to Smithery.
 *
 * Smithery's web form at smithery.ai/servers/new only accepts an HTTPS URL, which this
 * server cannot have: it drives the browser the user is already signed into, over a
 * native-messaging relay on their own machine, so there is nowhere remote to point at.
 * The stdio path is an MCPB bundle submitted to `PUT /servers/{qualifiedName}/releases`,
 * and that is what this does.
 *
 * Every field is derived from the bundle's own manifest, so the listing and the thing it
 * describes cannot disagree.
 *
 *   node scripts/publish-smithery.mjs --dry-run   print exactly what would be sent
 *   node scripts/publish-smithery.mjs             publish
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const repoRoot = resolve(root, "..", "..");

const NAMESPACE = process.env.SMITHERY_NAMESPACE ?? "t3ratech-dev";
const SERVER_ID = process.env.SMITHERY_SERVER_ID ?? "mcp-session-bridge";
const API = "https://api.smithery.ai";

function credential() {
  // Read from the environment, or from the repo's .env without echoing anything.
  if (process.env.T3RATECH_SMITHERY_API_KEY) return process.env.T3RATECH_SMITHERY_API_KEY;
  const envFile = join(repoRoot, ".env");
  if (existsSync(envFile)) {
    const line = readFileSync(envFile, "utf8")
      .split("\n")
      .find((l) => l.startsWith("T3RATECH_SMITHERY_API_KEY="));
    if (line) return line.slice("T3RATECH_SMITHERY_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("publish-smithery: T3RATECH_SMITHERY_API_KEY is not set and is not in .env");
}

/**
 * MCPB's `user_config` and Smithery's `configSchema` describe the same three settings in
 * two notations. Translating rather than hand-writing the second keeps one source: a
 * default changed in the manifest reaches the listing without anyone remembering to.
 */
function configSchemaFrom(userConfig, env) {
  const properties = {};
  for (const [variable, reference] of Object.entries(env)) {
    const key = reference.match(/^\$\{user_config\.([a-z_]+)\}$/)?.[1];
    const entry = key && userConfig[key];
    if (!entry) continue;
    properties[variable] = {
      type: "string",
      title: entry.title,
      description: entry.description,
      ...(entry.default !== undefined && entry.default !== "" ? { default: entry.default } : {}),
    };
  }
  return { type: "object", properties, required: [] };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const { buildManifest } = await import(join(here, "build-mcpb.mjs"));
  const manifest = buildManifest();
  const { TOOL_DEFINITIONS } = await import(join(root, "src", "tools.js"));

  const bundlePath = join(root, "build", `${manifest.name}-${manifest.version}.mcpb`);
  if (!existsSync(bundlePath)) {
    throw new Error(`publish-smithery: no bundle at ${bundlePath}. Run: node scripts/build-mcpb.mjs`);
  }

  const payload = {
    type: "stdio",
    runtime: "node",
    configSchema: configSchemaFrom(manifest.user_config, manifest.server.mcp_config.env),
    serverCard: {
      serverInfo: {
        name: manifest.name,
        title: manifest.display_name,
        version: manifest.version,
        websiteUrl: manifest.homepage,
        description: manifest.description,
      },
      // The card carries the full input schemas so a client can call a tool without
      // installing the bundle first to find out what it takes.
      tools: TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    },
  };

  const qualifiedName = `${NAMESPACE}/${SERVER_ID}`;
  const url = `${API}/servers/${encodeURIComponent(qualifiedName)}/releases`;

  if (dryRun) {
    console.log(`PUT ${url}`);
    console.log(`bundle: ${bundlePath} (${readFileSync(bundlePath).length} bytes)`);
    console.log(JSON.stringify(payload, null, 2).slice(0, 2000));
    return;
  }

  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  form.append("bundle", new Blob([readFileSync(bundlePath)]), `${manifest.name}-${manifest.version}.mcpb`);

  const response = await fetch(url, {
    method: "PUT",
    headers: { Authorization: `Bearer ${credential()}` },
    body: form,
  });
  const text = await response.text();
  console.log(`PUT ${url}`);
  console.log(`HTTP ${response.status}`);
  console.log(text.slice(0, 1500));
  if (!response.ok) process.exitCode = 1;
}

await main();
