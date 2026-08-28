/**
 * Attacks on the relay: the multiplexer every MCP client talks through.
 *
 * This hop is the one nobody watches. A defect here does not throw — it drops a
 * response, or answers the wrong client, or hands back an id the caller cannot match to
 * the request it sent, and the symptom reaches the user as "Claude just hung".
 *
 * The existing suite drives it the way a well-behaved MCP server does. These cases
 * drive it the way three of them at once do, with ids that collide, frames that arrive
 * in pieces, bodies that are too big, and connections that vanish mid-request.
 */
import assert from "node:assert";
import net from "node:net";
import { spawn } from "node:child_process";
import { describe, it, after, afterEach } from "node:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createFrameDecoder, encodeFrame, MAX_FRAME_BYTES } from "../src/framing.js";


const __dirname = dirname(fileURLToPath(import.meta.url));
const hostPath = join(__dirname, "..", "src", "native-host.js");
const dirs = [];
const spawned = [];
const opened = [];

/**
 * A failed assertion skips whatever cleanup follows it. With a child process still
 * running, the test process cannot exit and the whole file reports as a timeout
 * instead of as the one failure it found — which is what happened the first time this
 * suite ran. Everything is registered on creation and torn down centrally.
 */
afterEach(() => {
  for (const client of opened.splice(0)) client.close();
  for (const host of spawned.splice(0)) host.kill();
});

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function socketPath() {
  const dir = mkdtempSync(join(tmpdir(), "relay-adv-"));
  dirs.push(dir);
  return join(dir, "bridge.sock");
}

/**
 * The host with a stand-in for Chrome on the other side: every frame the host writes to
 * stdout is decoded here, so a test can see exactly what the extension would have been
 * asked, and answer it.
 */
function spawnHost(path) {
  const proc = spawn("node", [hostPath], {
    env: { ...process.env, T3RNEL_SESSION_SOCKET: path },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const toExtension = [];
  const waiters = [];
  const decoder = createFrameDecoder((message) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else toExtension.push(message);
  });
  proc.stdout.on("data", (chunk) => decoder.push(chunk));
  let ready = false;
  proc.stderr.on("data", (chunk) => {
    if (String(chunk).includes("relay listening")) ready = true;
  });
  const handle = {
    proc,
    /** Next request the extension would have received. */
    nextRequest(timeoutMs = 5000) {
      if (toExtension.length > 0) return Promise.resolve(toExtension.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the host never asked the extension anything")), timeoutMs);
        waiters.push((message) => { clearTimeout(timer); resolve(message); });
      });
    },
    /** Answer as the extension does. */
    reply(message) {
      proc.stdin.write(encodeFrame(message));
    },
    async waitReady(timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (!ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      if (!ready) throw new Error("the relay never started listening");
    },
    kill() { proc.kill("SIGKILL"); },
  };
  spawned.push(handle);
  return handle;
}

class Client {
  constructor(path) {
    this.received = [];
    this.waiters = [];
    this.decoder = createFrameDecoder((message) => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.received.push(message);
    });
    this.socket = net.createConnection({ path });
    this.socket.on("data", (chunk) => this.decoder.push(chunk));
    this.socket.on("error", () => {});
    opened.push(this);
    return new Promise((resolve, reject) => {
      this.socket.on("connect", () => resolve(this));
      this.socket.on("error", reject);
    });
  }
  send(message) { this.socket.write(encodeFrame(message)); }
  sendRaw(buffer) { this.socket.write(buffer); }
  next(timeoutMs = 5000) {
    if (this.received.length > 0) return Promise.resolve(this.received.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the relay never answered")), timeoutMs);
      this.waiters.push((message) => { clearTimeout(timer); resolve(message); });
    });
  }
  close() { this.socket.destroy(); }
}

describe("the relay answers the right client, with the id they sent", () => {
  it("gives a numeric id back as a number", async () => {
    /**
     * JSON-RPC correlates a response to a request by id, and the id must come back the
     * way it went out. The relay rewrites ids to `<conn>:<id>` to keep two clients from
     * colliding, and rebuilding a numeric id from that string produced `"7"` where the
     * client sent `7`. A client keying its pending map by the value it sent never finds
     * the response and waits forever.
     */
    const path = socketPath();
    const host = spawnHost(path);
    await host.waitReady();
    const client = await new Client(path);

    client.send({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
    const asked = await host.nextRequest();
    host.reply({ jsonrpc: "2.0", id: asked.id, result: { tools: [] } });

    const answer = await client.next();
    assert.strictEqual(answer.id, 7, `the id came back as ${JSON.stringify(answer.id)}, which is not what was sent`);
  });

  it("gives a string id back as the same string", async () => {
    const path = socketPath();
    const host = spawnHost(path);
    await host.waitReady();
    const client = await new Client(path);

    client.send({ jsonrpc: "2.0", id: "req-abc", method: "tools/list", params: {} });
    const asked = await host.nextRequest();
    host.reply({ jsonrpc: "2.0", id: asked.id, result: {} });

    const answer = await client.next();
    assert.strictEqual(answer.id, "req-abc");
  });

  it("keeps an id that itself contains the separator intact", async () => {
    // The rewrite is `<conn>:<id>`, so an id of "1:2" produces "3:1:2". Splitting on the
    // last colon rather than the first would hand back "2".
    const path = socketPath();
    const host = spawnHost(path);
    await host.waitReady();
    const client = await new Client(path);

    client.send({ jsonrpc: "2.0", id: "1:2:3", method: "tools/list", params: {} });
    const asked = await host.nextRequest();
    host.reply({ jsonrpc: "2.0", id: asked.id, result: {} });

    const answer = await client.next();
    assert.strictEqual(answer.id, "1:2:3");
  });

  it("does not deliver one client's answer to another that used the same id", async () => {
    /**
     * The whole reason the rewrite exists. Two MCP servers both start their ids at 1;
     * without separation the second client receives the first client's page content.
     */
    const path = socketPath();
    const host = spawnHost(path);
    await host.waitReady();
    const first = await new Client(path);
    const second = await new Client(path);

    first.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "first" } });
    const askedFirst = await host.nextRequest();
    second.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "second" } });
    const askedSecond = await host.nextRequest();

    assert.notStrictEqual(askedFirst.id, askedSecond.id, "two clients' requests reached the extension under one id");

    // Answer out of order, which is the normal case when one page is slower.
    host.reply({ jsonrpc: "2.0", id: askedSecond.id, result: { who: "second" } });
    host.reply({ jsonrpc: "2.0", id: askedFirst.id, result: { who: "first" } });

    const secondAnswer = await second.next();
    const firstAnswer = await first.next();
    assert.strictEqual(secondAnswer.result.who, "second", "the second client received the wrong answer");
    assert.strictEqual(firstAnswer.result.who, "first", "the first client received the wrong answer");
  });
});

describe("the relay refuses what it cannot serve, out loud", () => {
  it("answers a non-object body with a JSON-RPC error rather than silence", async () => {
    const path = socketPath();
    const host = spawnHost(path);
    await host.waitReady();
    const client = await new Client(path);

    client.send([1, 2, 3]);
    const answer = await client.next();
    assert.strictEqual(answer.error.code, -32600);
  });

  it("survives a frame split across many chunks", async () => {
    // A local socket coalesces and splits freely. A decoder that assumed one write per
    // frame would deadlock on a large tools/call payload.
    const path = socketPath();
    const host = spawnHost(path);
    await host.waitReady();
    const client = await new Client(path);

    const frame = encodeFrame({ jsonrpc: "2.0", id: 42, method: "tools/call", params: { blob: "x".repeat(20_000) } });
    for (let offset = 0; offset < frame.length; offset += 97) {
      client.sendRaw(frame.subarray(offset, Math.min(offset + 97, frame.length)));
      await new Promise((r) => setImmediate(r));
    }
    const asked = await host.nextRequest();
    assert.strictEqual(asked.params.blob.length, 20_000);
  });

  it("survives several frames arriving in one chunk", async () => {
    const path = socketPath();
    const host = spawnHost(path);
    await host.waitReady();
    const client = await new Client(path);

    client.sendRaw(Buffer.concat([
      encodeFrame({ jsonrpc: "2.0", id: 1, method: "a" }),
      encodeFrame({ jsonrpc: "2.0", id: 2, method: "b" }),
      encodeFrame({ jsonrpc: "2.0", id: 3, method: "c" }),
    ]));
    const methods = [(await host.nextRequest()).method, (await host.nextRequest()).method, (await host.nextRequest()).method];
    assert.deepStrictEqual(methods, ["a", "b", "c"]);
  });

  it("drops a client that claims an impossible frame length instead of allocating it", async () => {
    // A four-byte header can claim four gigabytes. Trusting it is how a local socket
    // becomes an out-of-memory kill.
    const path = socketPath();
    const host = spawnHost(path);
    await host.waitReady();
    const client = await new Client(path);

    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_FRAME_BYTES + 1, 0);
    client.sendRaw(header);
    client.sendRaw(Buffer.from("{"));

    await new Promise((r) => setTimeout(r, 400));
    assert.ok(host.proc.exitCode === null, "an oversized client frame killed the whole host");

    // The host must still serve a new client afterwards.
    const fresh = await new Client(path);
    fresh.send({ jsonrpc: "2.0", id: 9, method: "tools/list" });
    const asked = await host.nextRequest();
    assert.strictEqual(asked.method, "tools/list");
  });

  it("does not let malformed JSON from one client disturb another", async () => {
    const path = socketPath();
    const host = spawnHost(path);
    await host.waitReady();
    const bad = await new Client(path);
    const good = await new Client(path);

    const body = Buffer.from("{not json at all", "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    bad.sendRaw(Buffer.concat([header, body]));

    good.send({ jsonrpc: "2.0", id: 5, method: "tools/list" });
    const asked = await host.nextRequest();
    assert.strictEqual(asked.method, "tools/list", "a malformed frame from one client broke another's request");
  });
});

describe("the relay does not leak state across connections", () => {
  it("forgets a request whose client disconnected before the answer arrived", async () => {
    const path = socketPath();
    const host = spawnHost(path);
    await host.waitReady();
    const client = await new Client(path);

    client.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    const asked = await host.nextRequest();
    await new Promise((r) => setTimeout(r, 200));

    // Answering a dead connection must not throw inside the host.
    host.reply({ jsonrpc: "2.0", id: asked.id, result: {} });
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(host.proc.exitCode, null, "answering a departed client killed the host");

    const fresh = await new Client(path);
    fresh.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.strictEqual((await host.nextRequest()).method, "tools/list");
  });

  it("holds a bounded number of outstanding requests under a flood", async () => {
    // A client that never reads its answers must not grow the host without limit.
    const path = socketPath();
    const host = spawnHost(path);
    await host.waitReady();
    const client = await new Client(path);

    for (let i = 0; i < 4000; i += 1) {
      client.send({ jsonrpc: "2.0", id: i, method: "tools/call", params: {} });
    }
    await new Promise((r) => setTimeout(r, 1500));
    assert.strictEqual(host.proc.exitCode, null, "a flood of requests killed the host");
  });

  it("keeps the socket owner-only", async () => {
    // The socket is the whole authority to drive a signed-in browser. Group or world
    // access hands that to every process on a shared machine.
    const path = socketPath();
    const host = spawnHost(path);
    await host.waitReady();
    const mode = statSync(path).mode & 0o777;
    assert.strictEqual(mode, 0o600, `the relay socket is mode ${mode.toString(8)}, not 600`);
  });
});


describe("the host as Chrome spawns it", () => {
  /**
   * Scoped, because this section came from its own file and had independently grown a
   * `spawnHost`, a `__dirname` and a test client with the same names as the ones
   * above. Keeping it in its own block means both sets stay exactly as they were.
   */
  // The host path and `__dirname` are defined once at the top of this file; the merged
  // section below used to carry its own identical copy.

  function waitFor(predicate, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (predicate()) {
          resolve();
        } else if (Date.now() - started > timeoutMs) {
          reject(new Error("Timed out waiting for condition"));
        } else {
          setTimeout(poll, 25);
        }
      };
      poll();
    });
  }

  function spawnHost(socketPath) {
    const proc = spawn("node", [hostPath], { env: { ...process.env, T3RNEL_SESSION_SOCKET: socketPath } });
    proc.stderr.on("data", () => {});
    return proc;
  }

  /** A socket client standing in for the MCP server process. */
  class RelayTestClient {
    constructor(socketPath) {
      this.messages = [];
      this.waiters = [];
      this.decoder = createFrameDecoder((message) => {
        const waiter = this.waiters.shift();
        if (waiter) waiter(message);
        else this.messages.push(message);
      });
      this.socket = net.createConnection({ path: socketPath });
      this.socket.on("data", (chunk) => this.decoder.push(chunk));
      return new Promise((resolve, reject) => {
        this.socket.on("connect", () => resolve(this));
        this.socket.on("error", reject);
      });
    }

    send(message) {
      this.socket.write(encodeFrame(message));
    }

    next(timeoutMs = 5000) {
      if (this.messages.length > 0) return Promise.resolve(this.messages.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for relay message")), timeoutMs);
        this.waiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    }

    close() {
      this.socket.destroy();
    }
  }

  function nextNativeMessage(hostProc, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timeout waiting for native message")), timeoutMs);
      const decoder = createFrameDecoder((message) => {
        clearTimeout(timer);
        hostProc.stdout.off("data", onData);
        resolve(message);
      });
      const onData = (chunk) => decoder.push(chunk);
      hostProc.stdout.on("data", onData);
    });
  }

  describe("native host", () => {
    it("routes concurrent clients with colliding ids back to the right client", async () => {
      const dir = mkdtempSync(join(tmpdir(), "t3rnel-host-"));
      const socketPath = join(dir, "bridge.sock");
      const host = spawnHost(socketPath);

      try {
        await waitFor(() => existsSync(socketPath));
        const clientA = await new RelayTestClient(socketPath);
        const clientB = await new RelayTestClient(socketPath);

        clientA.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_health" } });
        clientB.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_list_tabs" } });

        const first = await nextNativeMessage(host);
        const second = await nextNativeMessage(host);
        assert.notStrictEqual(first.id, second.id, "rewritten ids must be unique across connections");

        // Answer in reverse order: routing is by id, not arrival order.
        host.stdin.write(encodeFrame({ jsonrpc: "2.0", id: second.id, result: { for: "B" } }));
        host.stdin.write(encodeFrame({ jsonrpc: "2.0", id: first.id, result: { for: "A" } }));

        // The id comes back as the number that was sent. This previously asserted the
        // string "1", which pinned in place a defect where the rewrite `<conn>:<id>` was
        // unwound into a string and every numeric id changed type in transit.
        const [responseA, responseB] = await Promise.all([clientA.next(), clientB.next()]);
        assert.deepStrictEqual(responseA, { jsonrpc: "2.0", id: 1, result: { for: "A" } });
        assert.deepStrictEqual(responseB, { jsonrpc: "2.0", id: 1, result: { for: "B" } });

        clientA.close();
        clientB.close();
      } finally {
        host.kill();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("rejects a malformed frame body with Invalid Request", async () => {
      const dir = mkdtempSync(join(tmpdir(), "t3rnel-host-"));
      const socketPath = join(dir, "bridge.sock");
      const host = spawnHost(socketPath);

      try {
        await waitFor(() => existsSync(socketPath));
        const client = await new RelayTestClient(socketPath);
        client.send("not an object");
        const response = await client.next();
        assert.strictEqual(response.error.code, -32600);
        client.close();
      } finally {
        host.kill();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("keeps serving other clients when one disconnects mid-request", async () => {
      const dir = mkdtempSync(join(tmpdir(), "t3rnel-host-"));
      const socketPath = join(dir, "bridge.sock");
      const host = spawnHost(socketPath);

      try {
        await waitFor(() => existsSync(socketPath));
        const gone = await new RelayTestClient(socketPath);
        const alive = await new RelayTestClient(socketPath);

        gone.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_health" } });
        const orphan = await nextNativeMessage(host);
        gone.close();
        // The late response must be dropped without crashing the host.
        host.stdin.write(encodeFrame({ jsonrpc: "2.0", id: orphan.id, result: { late: true } }));

        alive.send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "browser_list_tabs" } });
        const forwarded = await nextNativeMessage(host);
        host.stdin.write(encodeFrame({ jsonrpc: "2.0", id: forwarded.id, result: { tabs: 3 } }));

        const response = await alive.next();
        assert.deepStrictEqual(response.result, { tabs: 3 });
        alive.close();
      } finally {
        host.kill();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("exits when Chrome closes the native messaging stream", async () => {
      const dir = mkdtempSync(join(tmpdir(), "t3rnel-host-"));
      const socketPath = join(dir, "bridge.sock");
      const host = spawnHost(socketPath);

      await waitFor(() => existsSync(socketPath));
      host.stdin.end();

      const code = await new Promise((resolve) => host.on("exit", resolve));
      assert.strictEqual(code, 0);
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
