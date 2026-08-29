import { describe, it } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { connectWebSocket, headerValue } from "../src/ws.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/**
 * Starts an HTTP server and returns it with a teardown that also drops upgraded sockets.
 *
 * The sockets have to be tracked by hand. Once a connection is upgraded, node's HTTP
 * server detaches it and neither `close()` nor `closeAllConnections()` will touch it
 * again, so an untracked WebSocket keeps the test process alive long after every
 * assertion has passed — the suite hangs rather than fails, which is the more annoying
 * of the two.
 */
async function startServer(onUpgrade, onRequest) {
  const server = onRequest ? createServer(onRequest) : createServer();
  const upgraded = new Set();
  if (onUpgrade) {
    server.on("upgrade", (request, socket, head) => {
      upgraded.add(socket);
      socket.on("close", () => upgraded.delete(socket));
      onUpgrade(request, socket, head);
    });
  }
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    stop: () => {
      for (const socket of upgraded) socket.destroy();
      upgraded.clear();
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Answers the upgrade exactly as the RFC prescribes. */
function correctUpgrade(request, socket) {
  const key = request.headers["sec-websocket-key"];
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

describe("websocket handshake", () => {
  it("reads a header value case-insensitively", () => {
    const head = "HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: abc+def/gh=\r\n";
    assert.strictEqual(headerValue(head, "SEC-WEBSOCKET-ACCEPT"), "abc+def/gh=");
  });

  it("reports an absent header as null rather than as an empty value", () => {
    assert.strictEqual(
      headerValue("HTTP/1.1 101 X\r\nUpgrade: websocket\r\n", "sec-websocket-accept"),
      null
    );
  });

  it("does not mistake the status line for a header", () => {
    // "HTTP/1.1" contains a colon-free name but the line does have one; a naive parser
    // that splits the whole head on ":" would treat the status line as a header.
    assert.strictEqual(headerValue("HTTP/1.1 101 Switching\r\n", "http/1.1"), null);
  });

  /*
   * The regression this suite exists for.
   *
   * The accept value was interpolated into a RegExp. Base64 uses `+` and `/`, both regex
   * metacharacters, so a digest containing either compiled to a pattern that did not
   * match the header it was built from. Roughly half of random keys yield such a digest,
   * so the old code failed intermittently against a correct server — and blamed the 101
   * status line, which is the success case. Twenty connections put the odds of this
   * passing by luck at about one in a million.
   */
  it("completes the handshake for every key, including digests containing + and /", async () => {
    const { port, stop } = await startServer(correctUpgrade);
    try {
      for (let attempt = 0; attempt < 20; attempt++) {
        const socket = await connectWebSocket(`ws://127.0.0.1:${port}/`, { timeoutMs: 4000 });
        socket.close();
      }
    } finally {
      stop();
    }
  });

  it("refuses a handshake whose accept value is wrong", async () => {
    const { port, stop } = await startServer((_request, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" +
          "Sec-WebSocket-Accept: not-the-right-digest\r\n\r\n"
      );
    });
    try {
      await assert.rejects(
        () => connectWebSocket(`ws://127.0.0.1:${port}/`, { timeoutMs: 4000 }),
        (error) => {
          assert.match(
            error.message,
            /Sec-WebSocket-Accept/i,
            `the error blamed the wrong thing: ${error.message}`
          );
          return true;
        }
      );
    } finally {
      stop();
    }
  });

  it("refuses a handshake the server declined outright", async () => {
    const { port, stop } = await startServer(null, (_request, response) => {
      response.writeHead(403).end();
    });
    try {
      await assert.rejects(() => connectWebSocket(`ws://127.0.0.1:${port}/`, { timeoutMs: 4000 }));
    } finally {
      stop();
    }
  });
});
