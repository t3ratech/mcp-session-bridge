/**
 * The extension source lives in the t3rnel monorepo, a sibling checkout whose
 * exact layout varies by machine. T3RNEL_REPO_ROOT overrides everything.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every directory above this checkout, nearest first. A fixed `../..` found the monorepo
 * from one layout and not from `products/mcp/<bridge>` inside it, where the root is three
 * levels up — and that is where the release suite runs.
 */
function ancestors(from) {
  const out = [];
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    out.push(dir);
    if (dirname(dir) === dir) return out;
  }
}

export function t3rnelRepoRoot() {
  const candidates = [
    process.env.T3RNEL_REPO_ROOT,
    join(root, "..", "t3rnel"),
    ...ancestors(root),
  ].filter(Boolean);
  const found = candidates.find((p) =>
    existsSync(join(p, "products", "browser", "t3rnel-browser", "src", "browser-tools.ts")));
  if (!found) {
    throw new Error(`t3rnel monorepo not found; set T3RNEL_REPO_ROOT (tried: ${candidates.join(", ")})`);
  }
  return found;
}

export function browserToolsRegistry() {
  return join(t3rnelRepoRoot(), "products", "browser", "t3rnel-browser", "src", "browser-tools.ts");
}

export function extensionSrcRoot() {
  return join(t3rnelRepoRoot(), "products", "browser", "t3rnel-browser", "src");
}
