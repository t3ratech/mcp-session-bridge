import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { startExtensionWebSocket, sessionWsBasePort, SESSION_WS_BASE_PORT } from "../src/ws-server.js";
import { connectWebSocket } from "../src/ws.js";

/**
 * The dial-out transport, exercised as the extension would use it: connect,
 * read the hello, send ready, then answer tools/call frames.
 */

const running = [];
afterEach(() => {
  for (const server of running.splice(0)) server.close();
});

async function start(overrides = {}) {
  const server = await startExtensionWebSocket({
    basePort: 0,
    version: "test",
    clientName: "test-client",
    log: () => {},
    ...overrides,
  });
  running.push(server);
  return server;
}

function connectAs(port, hello) {
  return connectWebSocket(`ws://127.0.0.1:${port}/session`, {
    timeoutMs: 4000,
    onMessage: hello.onMessage,
  });
}

describe("the extension WebSocket endpoint", () => {
  it("greets a dialling extension with a hello naming the bridge", async () => {
    const server = await start();
    const helloPromise = new Promise((resolve) => {
      connectAs(server.port, { onMessage: (text) => resolve(JSON.parse(text)) });
    });
    const hello = await helloPromise;
    assert.strictEqual(hello.type, "t3rnel.bridge.hello");
    assert.strictEqual(hello.server, "mcp-session-bridge");
    assert.strictEqual(typeof hello.bridgeId, "string");
    assert.strictEqual(hello.client, "test-client");
  });

  it("reports not-connected until the extension sends ready", async () => {
    const server = await start();
    assert.strictEqual(server.isConnected(), false);
    const ws = await connectAs(server.port, { onMessage: () => {} });
    assert.strictEqual(server.hasExtensionSocket(), true);
    assert.strictEqual(server.isConnected(), false);
    ws.send(JSON.stringify({ type: "t3rnel.bridge.ready" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(server.isConnected(), true);
    ws.close();
  });

  it("round-trips a tools/call request and its result", async () => {
    const server = await start();
    const ws = await connectAs(server.port, {
      onMessage: (text) => {
        const message = JSON.parse(text);
        if (message.method === "tools/call") {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { ok: true, echoed: message.params.name } }));
        }
      },
    });
    ws.send(JSON.stringify({ type: "t3rnel.bridge.ready" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await server.call({ jsonrpc: "2.0", method: "tools/call", params: { name: "browser_navigate", arguments: { url: "https://example.com" } } });
    assert.deepStrictEqual(result, { ok: true, echoed: "browser_navigate" });
    ws.close();
  });

  it("rejects a call while the pairing is still awaiting approval", async () => {
    const server = await start();
    await assert.rejects(
      () => server.call({ jsonrpc: "2.0", method: "tools/call", params: {} }, 500),
      /not approved/i
    );
  });

  it("answers /health over plain HTTP so a human can check it with curl", async () => {
    const server = await start();
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    const body = await response.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.server, "mcp-session-bridge");
  });

  it("fails calls cleanly when the extension socket drops mid-call", async () => {
    const server = await start();
    const ws = await connectAs(server.port, { onMessage: () => {} });
    ws.send(JSON.stringify({ type: "t3rnel.bridge.ready" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const callPromise = server.call({ jsonrpc: "2.0", method: "tools/call", params: {} });
    ws.close();
    await assert.rejects(callPromise, /closed mid-call|timed out/);
  });
});

describe("port selection", () => {
  it("defaults to the documented base port", () => {
    assert.strictEqual(sessionWsBasePort({}), SESSION_WS_BASE_PORT);
  });

  it("rejects a port override that is not a port", () => {
    assert.throws(() => sessionWsBasePort({ T3RNEL_SESSION_PORT: "abc" }), /T3RNEL_SESSION_PORT/);
  });
});
