import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { startExtensionWebSocket } from "../src/ws-server.js";
import { connectWebSocket } from "../src/ws.js";

/**
 * Several browsers carrying the extension at once.
 *
 * Chrome and Brave both run the store extension on a machine that uses both, and a copy
 * that only runs in private windows connects fine but sees no windows. Each test connects
 * fake browsers the way the extension does (connect, send ready, answer tools/call) and
 * checks which of them a call lands in.
 */

const servers = [];
const sockets = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const server of servers.splice(0)) server.close();
});

const logged = [];
async function start(overrides = {}) {
  logged.length = 0;
  const server = await startExtensionWebSocket({
    basePort: 0,
    version: "test",
    clientName: "test-client",
    log: (line) => logged.push(line),
    probeTimeoutMs: 2000,
    ...overrides,
  });
  servers.push(server);
  return server;
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

/**
 * A fake browser. `onProbe` answers browser_list_tabs (return undefined to stay silent);
 * every other tool answers with the browser's name, so a test can see where a call landed.
 */
async function browser(server, name, onProbe) {
  const seen = [];
  const ws = await connectWebSocket(`ws://127.0.0.1:${server.port}/session`, {
    timeoutMs: 4000,
    onMessage: (raw) => {
      const message = JSON.parse(raw);
      if (message.method !== "tools/call") return;
      seen.push(message.params.name);
      const answer = message.params.name === "browser_list_tabs" ? onProbe() : text(`answered by ${name}`);
      if (answer !== undefined) ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer }));
    },
  });
  sockets.push(ws);
  ws.send(JSON.stringify({ type: "t3rnel.bridge.ready" }));
  // The server records ready on the frame's arrival; give it that moment.
  await new Promise((resolve) => setTimeout(resolve, 60));
  return { ws, seen, probes: () => seen.filter((tool) => tool === "browser_list_tabs").length };
}

const call = (server, tool = "browser_navigate") =>
  server.call({ jsonrpc: "2.0", method: "tools/call", params: { name: tool, arguments: {} } });
const who = async (server, tool) => (await call(server, tool)).content[0].text;

const TABS = [{ id: 1, title: "a page", url: "https://example.test/" }];

describe("a call with several browsers connected", () => {
  it("goes to the browser that can see tabs, not the one that connected first", async () => {
    const server = await start();
    await browser(server, "blind", () => text([]));
    await browser(server, "sighted", () => text(TABS));
    assert.strictEqual(await who(server), "answered by sighted");
  });

  it("holds that choice: later calls do not probe again", async () => {
    const server = await start();
    const blind = await browser(server, "blind", () => text([]));
    const sighted = await browser(server, "sighted", () => text(TABS));
    await who(server);
    await who(server);
    await who(server);
    assert.strictEqual(blind.probes(), 1);
    assert.strictEqual(sighted.probes(), 1);
    assert.strictEqual(sighted.seen.filter((tool) => tool === "browser_navigate").length, 3);
  });

  it("uses the only browser connected without probing it", async () => {
    const server = await start();
    const only = await browser(server, "only", () => text(TABS));
    assert.strictEqual(await who(server), "answered by only");
    assert.strictEqual(only.probes(), 0);
  });

  it("does not wait on a lone browser that never answers a probe", async () => {
    const server = await start({ probeTimeoutMs: 60_000 });
    await browser(server, "old extension", () => undefined);
    const started = Date.now();
    assert.strictEqual(await who(server), "answered by old extension");
    assert.ok(Date.now() - started < 1500, "a single browser was probed");
  });

  it("falls back to the first browser when none of them can see a tab", async () => {
    const server = await start();
    await browser(server, "first", () => text([]));
    await browser(server, "second", () => text([]));
    assert.strictEqual(await who(server), "answered by first");
  });

  it("probes again on the next call after a fallback, in case a browser has opened a window", async () => {
    const server = await start();
    let open = false;
    const first = await browser(server, "first", () => text(open ? TABS : []));
    await browser(server, "second", () => text([]));
    assert.strictEqual(await who(server), "answered by first");
    open = true;
    assert.strictEqual(await who(server), "answered by first");
    assert.strictEqual(first.probes(), 2);
  });

  it("treats an answer that is not JSON as no tabs and moves on to the next browser", async () => {
    const server = await start();
    await browser(server, "garbled", () => text("not json at all"));
    await browser(server, "sighted", () => text(TABS));
    assert.strictEqual(await who(server), "answered by sighted");
    assert.ok(logged.some((line) => /-> non-array tabs/.test(line)), logged.join("\n"));
  });

  it("accepts a list that arrives as the result itself, not wrapped in text content", async () => {
    const server = await start();
    await browser(server, "blind", () => text([]));
    await browser(server, "bare", () => TABS);
    assert.strictEqual(await who(server), "answered by bare");
  });

  it("treats an answer with no content as no tabs", async () => {
    const server = await start();
    await browser(server, "empty", () => ({}));
    await browser(server, "sighted", () => text(TABS));
    assert.strictEqual(await who(server), "answered by sighted");
  });

  it("skips a browser that does not answer the probe, without waiting for it forever", async () => {
    const server = await start({ probeTimeoutMs: 120 });
    await browser(server, "silent", () => undefined);
    await browser(server, "sighted", () => text(TABS));
    const started = Date.now();
    assert.strictEqual(await who(server), "answered by sighted");
    assert.ok(Date.now() - started < 1500, "the call waited far longer than the probe timeout");
    assert.ok(logged.some((line) => /failed: probe timeout/.test(line)), logged.join("\n"));
  });

  it("probes again when the pinned browser goes away", async () => {
    const server = await start();
    await browser(server, "blind", () => text([]));
    const pinned = await browser(server, "pinned", () => text(TABS));
    assert.strictEqual(await who(server), "answered by pinned");
    pinned.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await browser(server, "newcomer", () => text(TABS));
    assert.strictEqual(await who(server), "answered by newcomer");
  });

  it("goes to the one browser left when the pinned one leaves, without probing it again", async () => {
    const server = await start();
    const blind = await browser(server, "blind", () => text([]));
    const pinned = await browser(server, "pinned", () => text(TABS));
    await who(server);
    pinned.ws.close();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.strictEqual(await who(server), "answered by blind");
    assert.strictEqual(blind.probes(), 1);
  });

  it("logs a count of tabs and never a title or an address", async () => {
    const server = await start();
    await browser(server, "blind", () => text([]));
    await browser(server, "sighted", () => text(TABS));
    await who(server);
    const probeLines = logged.filter((line) => line.includes("probe conn"));
    assert.ok(probeLines.length >= 1);
    for (const line of probeLines) {
      assert.ok(!line.includes("a page") && !line.includes("example.test"), line);
    }
    assert.ok(probeLines.some((line) => /-> 1 tabs$/.test(line)), probeLines.join("\n"));
  });

  it("refuses by name when no browser has approved the bridge", async () => {
    const server = await start();
    await assert.rejects(() => call(server), /has not approved this bridge yet/);
  });
});
