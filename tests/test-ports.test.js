/**
 * No test may start a bridge on the ports a real browser scans.
 *
 * The extension probes 127.0.0.1:17311–17318 every few seconds. A test bridge bound there
 * is found and paired by the developer's own browser, and once the test exits the browser
 * logs "WebSocket connection to ws://127.0.0.1:17317/session failed" on its extensions page
 * — an error the product did not cause, reported as if it had. Every test that starts the
 * server must pin T3RNEL_SESSION_PORT outside that range, or use an ephemeral port.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname);

test("every test that starts the server keeps off the extension's scan range", () => {
  const offenders = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".test.js"))) {
    const text = readFileSync(join(dir, file), "utf8");
    const startsServer = /spawn\([^)]*server\.js|join\(root, "src", "server\.js"\)/.test(text);
    if (!startsServer) continue;
    const pinned = /T3RNEL_SESSION_PORT/.test(text) || /T3RNEL_SESSION_MODE: "standalone"/.test(text);
    if (!pinned) offenders.push(file);
    for (const match of text.matchAll(/T3RNEL_SESSION_PORT:\s*"?(\d{5})"?/g)) {
      const port = Number(match[1]);
      if (port >= 17311 && port <= 17318) offenders.push(`${file} (${port})`);
    }
  }
  assert.deepEqual(offenders, [], `these tests bind where a real browser dials: ${offenders.join(", ")}`);
});
