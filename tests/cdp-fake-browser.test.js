/**
 * StandaloneBrowser and executeStandaloneTool against a scripted CDP endpoint.
 *
 * The real-Chrome suites prove the happy path; this drives every refusal and failure a
 * real browser will not produce on demand: a binary that dies, one that never opens a
 * port, CDP errors, tabs that vanish, and each tool's argument edges.
 */
import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StandaloneBrowser, defaultBrowserPath, defaultDisplay, defaultProfileDir, explainBrowserExit, executeStandaloneTool, lastMeaningfulLine } from "../src/cdp.js";

const scratch = (p) => mkdtempSync(join(tmpdir(), `t3rnel-cdp-${p}-`));

/** A fake browser binary: writes DevToolsActivePort with `port`, then does `then`. */
function fakeBinary({ port = 0, then = "stay", stderr = "" } = {}) {
  const dir = scratch("bin");
  const bin = join(dir, "fake-chrome.cjs");
  writeFileSync(bin, `#!/usr/bin/env node
const dirArg = process.argv.find((a) => a.startsWith("--user-data-dir="));
const fs = require("fs"); const path = require("path");
${stderr ? `process.stderr.write(${JSON.stringify(stderr)});` : ""}
if (${port} && dirArg) fs.writeFileSync(path.join(dirArg.slice("--user-data-dir=".length), "DevToolsActivePort"), "${port}\\n/devtools/browser/x\\n");
${then === "exit" ? "setTimeout(() => process.exit(3), 50);" : then === "silent" ? "" : "setInterval(() => {}, 1000);"}
`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A CDP endpoint: /json/* over HTTP and one page target over WebSocket. */
async function fakeCdp({ onCommand = () => ({}), pages = [{ id: "T1", title: "One", url: "https://one.test/" }], http404 = new Set(), nonJson = new Set() } = {}) {
  const sockets = new Set();
  let targets = pages.map((p) => ({ ...p, type: "page" }));
  const server = http.createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (http404.has(path)) { res.writeHead(404).end(); return; }
    if (nonJson.has(path)) { res.writeHead(200).end("<html>"); return; }
    const port = server.address().port;
    const withWs = (t) => ({ ...t, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${t.id}` });
    if (path === "/json/version") return res.end(JSON.stringify({ Browser: "FakeChrome/1.0" }));
    if (path === "/json/list") return res.end(JSON.stringify([...targets.map(withWs), { id: "SW", type: "service_worker" }]));
    if (path === "/json/new") {
      const t = { id: `T${targets.length + 1}`, title: "", url: decodeURIComponent(req.url.split("?")[1] ?? ""), type: "page" };
      targets.push(t);
      return res.end(JSON.stringify(withWs(t)));
    }
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    const send = (obj) => {
      const p = Buffer.from(JSON.stringify(obj));
      const h = p.length < 126 ? Buffer.from([0x81, p.length]) : p.length < 65536 ? Buffer.from([0x81, 126, p.length >> 8, p.length & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(p.length), 2); return b; })();
      socket.write(Buffer.concat([h, p]));
    };
    socket.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        if (buf.length < 2) return;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + 4 + len) return;
        const mask = buf.subarray(off, off + 4);
        const data = Buffer.alloc(len);
        for (let i = 0; i < len; i++) data[i] = buf[off + 4 + i] ^ mask[i % 4];
        buf = buf.subarray(off + 4 + len);
        if ((buf[0] & 0x0f) === 0x8) return;
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { continue; }
        const reply = onCommand(msg, { send, socket, removeTarget: (id) => { targets = targets.filter((t) => t.id !== id); } });
        if (reply === "silent") continue;
        if (reply && reply.error) send({ id: msg.id, error: reply.error });
        else send({ id: msg.id, result: reply ?? {} });
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port, sockets, close: () => { for (const s of sockets) s.destroy(); server.close(); } };
}

const cleanups = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function started(cdp, extra = {}) {
  const b = new StandaloneBrowser({ browserPath: fakeBinary({ port: cdp.port }), profileDir: scratch("profile"), ...extra });
  cleanups.push(() => b.close());
  await b.ensureStarted();
  return b;
}

describe("finding and explaining the browser", () => {
  it("searches each platform's usual install paths, honouring an override", () => {
    assert.equal(defaultBrowserPath({ T3RNEL_SESSION_BROWSER: "/x/chrome" }), "/x/chrome");
    assert.equal(defaultBrowserPath({}, "darwin", (p) => p.includes("Brave")), "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
    assert.equal(defaultBrowserPath({}, "win32", (p) => p.endsWith("msedge.exe")), "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
    assert.equal(defaultBrowserPath({}, "linux", (p) => p === "/usr/bin/chromium"), "/usr/bin/chromium");
    assert.equal(defaultBrowserPath({}, "sunos", () => true), null);
    assert.equal(defaultBrowserPath({}, "linux", () => false), null);
  });

  it("reads the display and profile from the environment", () => {
    assert.equal(defaultDisplay({ T3RNEL_SESSION_DISPLAY: "  :99 " }), ":99");
    assert.equal(defaultDisplay({ T3RNEL_SESSION_DISPLAY: " " }), null);
    assert.equal(defaultDisplay({}), null);
    assert.equal(defaultProfileDir({ T3RNEL_SESSION_PROFILE: "/p" }), "/p");
    assert.match(defaultProfileDir({}), /\.t3rnel\/session-bridge\/browser-profile$/);
  });

  it("names the cause of a startup death: sandbox, library, display, or the last line", () => {
    assert.match(explainBrowserExit("/c", 1, "No usable sandbox!"), /no usable sandbox.*\/opt\/google\/chrome\/chrome/s);
    assert.match(explainBrowserExit("/c", 127, "error while loading shared libraries: libnss3.so"), /missing a shared library: error while loading shared libraries: libnss3\.so/);
    assert.match(explainBrowserExit("/c", 1, "Missing X server or $DISPLAY"), /could not open a display.*T3RNEL_SESSION_DISPLAY/s);
    assert.equal(explainBrowserExit("/c", 9, "WARNING: noise\nreal problem\n\n"), "Standalone browser exited before exposing a CDP port (code: 9): real problem");
    assert.equal(explainBrowserExit("/c", 9, "WARNING: only noise"), "Standalone browser exited before exposing a CDP port (code: 9)");
    assert.equal(lastMeaningfulLine("Gtk-Message: x\nDevTools listening on ws://x\n"), "");
  });
});

describe("starting the browser", () => {
  it("refuses with guidance when there is no browser to start", async () => {
    const b = new StandaloneBrowser({ browserPath: null, profileDir: scratch("p") });
    await assert.rejects(b.ensureStarted(), /No browser found for standalone mode.*T3RNEL_SESSION_BROWSER/s);
  });

  it("reuses a live browser a previous run left on the profile", async () => {
    const cdp = await fakeCdp();
    cleanups.push(() => cdp.close());
    const profile = scratch("reuse");
    writeFileSync(join(profile, "DevToolsActivePort"), `${cdp.port}\n/devtools/browser/x\n`);
    const b = new StandaloneBrowser({ browserPath: "/definitely/not/run", profileDir: profile });
    await b.ensureStarted();
    assert.equal(b.port, cdp.port);
    assert.equal(b.process, null);
  });

  it("reports a binary that exits before opening a port, with its stderr", async () => {
    const b = new StandaloneBrowser({ browserPath: fakeBinary({ then: "exit", stderr: "WARNING: x\nfatal: boom\n" }), profileDir: scratch("exit") });
    await assert.rejects(b.ensureStarted(), /exited before exposing a CDP port \(code: 3\): fatal: boom/);
  });

  it("reports a binary that cannot be spawned at all", async () => {
    const b = new StandaloneBrowser({ browserPath: join(scratch("none"), "missing-binary"), profileDir: scratch("spawn") });
    await assert.rejects(b.ensureStarted(), /Cannot start standalone browser: spawn .*ENOENT|exited before exposing a CDP port/);
  });

  it("runs headless, or headful on a given display, as asked", async () => {
    const cdp = await fakeCdp();
    cleanups.push(() => cdp.close());
    const headless = await started(cdp, { headless: true });
    assert.ok(headless.process.spawnargs.includes("--headless=new"));
    const onDisplay = await started(cdp, { headless: true, display: ":99" });
    assert.ok(!onDisplay.process.spawnargs.includes("--headless=new"));
    await onDisplay.ensureStarted(); // already running: returns at once
  });
});

describe("the CDP plumbing", () => {
  it("names HTTP failures and non-JSON answers", async () => {
    const cdp = await fakeCdp({ http404: new Set(["/json/nope"]), nonJson: new Set(["/json/html"]) });
    cleanups.push(() => cdp.close());
    const b = await started(cdp);
    await assert.rejects(b.httpJson("/json/nope"), /CDP HTTP 404 for \/json\/nope/);
    await assert.rejects(b.httpJson("/json/html"), /CDP HTTP \/json\/html returned non-JSON/);
    assert.equal(await b.probe(1), false);
  });

  it("maps tab ids to live targets, forgetting closed ones", async () => {
    const cdp = await fakeCdp({ pages: [{ id: "T1", title: "a", url: "u1" }, { id: "T2", title: "b", url: "u2" }] });
    cleanups.push(() => cdp.close());
    const b = await started(cdp);
    await b.syncTabs();
    assert.deepEqual([...b.tabIds.values()], ["T1", "T2"]);
    assert.throws(() => b.targetFor(99), /No tab with id 99/);
    b.tabIds.clear();
    assert.throws(() => b.targetFor(undefined), /No open tab/);
  });

  it("turns CDP errors, missing tabs and dropped connections into named failures", async () => {
    let drop = false;
    const cdp = await fakeCdp({ onCommand: (m, { socket }) => {
      if (m.method === "Boom.fail") return { error: { message: "no such method" } };
      if (m.method === "Runtime.evaluate" && m.params.expression === "throw") return { exceptionDetails: { text: "Uncaught" } };
      if (m.method === "Runtime.evaluate" && m.params.expression === "throwDesc") return { exceptionDetails: { exception: { description: "TypeError: x" } } };
      if (m.method === "Runtime.evaluate" && m.params.expression === "bare") return { exceptionDetails: {} };
      if (m.method === "Hang.forever") { if (drop) setTimeout(() => socket.destroy(), 20); return "silent"; }
      return {};
    } });
    cleanups.push(() => cdp.close());
    const b = await started(cdp);
    await b.syncTabs();
    await assert.rejects(b.cdp("T1", "Boom.fail"), /CDP error: no such method/);
    await assert.rejects(b.evalIn("T1", "throw"), /Uncaught/);
    await assert.rejects(b.evalIn("T1", "throwDesc"), /TypeError: x/);
    await assert.rejects(b.evalIn("T1", "bare"), /Evaluation failed/);
    await assert.rejects(b.session("GONE"), /Tab went away/);
    drop = true;
    await assert.rejects(b.cdp("T1", "Hang.forever"), /CDP connection to the tab closed/);
  });
});

describe("standalone tools", () => {
  const evaluating = (values) => (m) => {
    if (m.method === "Runtime.evaluate") {
      const v = values(m.params.expression);
      return v instanceof Error ? { exceptionDetails: { text: v.message } } : { result: { value: v } };
    }
    if (m.method === "Page.captureScreenshot") return { data: `SHOT-${m.params.format}-${m.params.quality ?? "none"}` };
    return {};
  };

  it("health, tabs, navigate in place and in a new tab", async () => {
    const cdp = await fakeCdp({ onCommand: evaluating(() => null) });
    cleanups.push(() => cdp.close());
    const b = await started(cdp);
    const health = JSON.parse((await executeStandaloneTool(b, "session_health")).content[0].text);
    assert.equal(health.browser, "FakeChrome/1.0");
    const tabs = JSON.parse((await executeStandaloneTool(b, "session_list_tabs")).content[0].text);
    assert.deepEqual(tabs, [{ id: 1, title: "One", url: "https://one.test/" }]);
    assert.match((await executeStandaloneTool(b, "session_navigate", { url: "https://two.test/" })).content[0].text, /navigated/);
    assert.match((await executeStandaloneTool(b, "session_navigate", { url: "https://three.test/", newTab: true })).content[0].text, /"newTab":true/);
  });

  it("select, press, type with and without a target, screenshot as png and clamped jpeg", async () => {
    const cdp = await fakeCdp({ onCommand: evaluating((e) => (e.includes("SELECT") || e.includes("tagName") ? { selected: true, value: "b", text: "B" } : true)) });
    cleanups.push(() => cdp.close());
    const b = await started(cdp);
    assert.match((await executeStandaloneTool(b, "session_select", { selector: "select", value: "b" })).content[0].text, /"value":"b"/);
    assert.match((await executeStandaloneTool(b, "session_press", { key: "Enter" })).content[0].text, /pressed/);
    assert.match((await executeStandaloneTool(b, "session_press", { key: "Tab" })).content[0].text, /pressed/);
    await assert.rejects(executeStandaloneTool(b, "session_press", { key: "F13" }), /Unsupported key "F13" — supported: Enter, Tab/);
    assert.match((await executeStandaloneTool(b, "session_type", { text: "hi" })).content[0].text, /"typed":2/);
    assert.match((await executeStandaloneTool(b, "session_type", { ref: "@e1", text: "hi" })).content[0].text, /"typed":2/);
    assert.match((await executeStandaloneTool(b, "session_type", {})).content[0].text, /"typed":0/);
    assert.equal((await executeStandaloneTool(b, "session_screenshot", {})).content[0].text, "data:image/png;base64,SHOT-png-none");
    assert.equal((await executeStandaloneTool(b, "session_screenshot", { format: "jpeg", quality: 250 })).content[0].text, "data:image/jpeg;base64,SHOT-jpeg-100");
    assert.equal((await executeStandaloneTool(b, "session_screenshot", { format: "jpeg" })).content[0].text, "data:image/jpeg;base64,SHOT-jpeg-none");
  });

  it("evaluate returns strings as-is, objects as JSON, and undefined by name", async () => {
    const answers = { a: "plain", b: { k: 1 }, c: undefined };
    const cdp = await fakeCdp({ onCommand: evaluating((e) => answers[e]) });
    cleanups.push(() => cdp.close());
    const b = await started(cdp);
    assert.equal((await executeStandaloneTool(b, "session_evaluate", { code: "a" })).content[0].text, "plain");
    assert.equal((await executeStandaloneTool(b, "session_evaluate", { code: "b" })).content[0].text, '{"k":1}');
    assert.equal((await executeStandaloneTool(b, "session_evaluate", { code: "c" })).content[0].text, "undefined");
  });

  it("waits for load, a URL and a selector, and times each out by name", async () => {
    let url = "https://one.test/";
    let found = false;
    const cdp = await fakeCdp({ onCommand: (m, { send }) => {
      if (m.method === "Runtime.evaluate") return { result: { value: m.params.expression === "location.href" ? url : found } };
      if (m.method === "Page.enable") setTimeout(() => send({ method: "Page.loadEventFired", params: {} }), 150);
      return {};
    } });
    cleanups.push(() => cdp.close());
    const b = await started(cdp);
    assert.match((await executeStandaloneTool(b, "session_wait", { condition: "load", timeoutMs: 2000 })).content[0].text, /"waited":true/);
    await assert.rejects(executeStandaloneTool(b, "session_wait", { condition: "load", timeoutMs: 30 }), /Timed out after 30ms waiting for load/);
    setTimeout(() => { url = "https://one.test/done"; found = true; }, 250);
    assert.match((await executeStandaloneTool(b, "session_wait", { condition: "url", value: "done", timeoutMs: 3000 })).content[0].text, /done/);
    assert.match((await executeStandaloneTool(b, "session_wait", { condition: "selector", value: "#x", timeoutMs: 3000 })).content[0].text, /"found":"#x"/);
    url = "https://one.test/"; found = false;
    await assert.rejects(executeStandaloneTool(b, "session_wait", { condition: "url", value: "never", timeoutMs: 250 }), /waiting for URL containing "never"/);
    await assert.rejects(executeStandaloneTool(b, "session_wait", { condition: "selector", value: "#never", timeoutMs: 250 }), /waiting for selector "#never"/);
    await assert.rejects(executeStandaloneTool(b, "session_wait", { condition: "idle" }), /Unknown wait condition "idle" — expected load, url, or selector/);
  });

  it("login and unknown tools refuse by name", async () => {
    const cdp = await fakeCdp();
    cleanups.push(() => cdp.close());
    const b = await started(cdp);
    await assert.rejects(executeStandaloneTool(b, "session_login", {}), /requires the T3rnel Browser extension with Pro/);
    await assert.rejects(executeStandaloneTool(b, "session_vault_list", {}), /Tool session_vault_list is not available in standalone mode/);
  });
});

describe("the remaining edges", () => {
  it("names a browser that never exposes a port within the budget, with and without stderr", async () => {
    const quiet = new StandaloneBrowser({ browserPath: fakeBinary({ then: "stay" }), profileDir: scratch("budget"), portBudgetMs: 300 });
    cleanups.push(() => quiet.close());
    await assert.rejects(quiet.ensureStarted(), (e) => /did not expose a CDP port within 0\.3s/.test(e.message) && !e.message.includes("\n"));
    // Long enough for the fake's stderr to arrive on a loaded machine; the point is what
    // the message carries, not how quickly the budget runs out.
    const noisy = new StandaloneBrowser({ browserPath: fakeBinary({ then: "stay", stderr: "WARNING: x\nsomething is wrong\n" }), profileDir: scratch("budget2"), portBudgetMs: 2000 });
    cleanups.push(() => noisy.close());
    await assert.rejects(noisy.ensureStarted(), /within 2s .*\nsomething is wrong/s);
  });

  it("closes open tab sessions when the browser process exits", async () => {
    const cdp = await fakeCdp();
    cleanups.push(() => cdp.close());
    const b = await started(cdp);
    await b.syncTabs();
    await b.session("T1");
    assert.equal(b.sessions.size, 1);
    const gone = new Promise((r) => b.process.once("exit", r));
    b.process.kill("SIGKILL");
    await gone;
    assert.equal(b.sessions.size, 0);
    assert.equal(b.port, null);
  });

  it("times out a CDP call the tab never answers, and ignores answers to nothing", async () => {
    const cdp = await fakeCdp({ onCommand: (m, { send }) => {
      if (m.method === "Never.answer") { send({ id: 9999, result: {} }); return "silent"; }
      return {};
    } });
    cleanups.push(() => cdp.close());
    const b = new StandaloneBrowser({ browserPath: fakeBinary({ port: cdp.port }), profileDir: scratch("calltimeout"), callTimeoutMs: 120 });
    cleanups.push(() => b.close());
    await b.ensureStarted();
    await b.syncTabs();
    await assert.rejects(b.cdp("T1", "Never.answer"), /CDP call Never\.answer timed out/);
  });

  it("forgets a tab id once its target closes, and lists untitled tabs with empty strings", async () => {
    let remove;
    const cdp = await fakeCdp({ pages: [{ id: "T1" }, { id: "T2", title: "two", url: "u2" }], onCommand: (m, ctx) => { remove = ctx.removeTarget; return {}; } });
    cleanups.push(() => cdp.close());
    const b = await started(cdp);
    const listed = JSON.parse((await executeStandaloneTool(b, "session_list_tabs")).content[0].text);
    assert.deepEqual(listed[0], { id: 1, title: "", url: "" });
    await b.session("T2");
    remove("T2");
    await b.syncTabs();
    assert.deepEqual([...b.tabIds.values()], ["T1"]);
    assert.equal(b.targetFor(1), "T1");
  });

  it("read_page, click and fill by selector or ref, and waits without a value", async () => {
    const seen = [];
    const cdp = await fakeCdp({ onCommand: (m) => {
      if (m.method === "Runtime.evaluate") {
        seen.push(m.params.expression);
        if (m.params.expression.includes("innerText")) return { result: { value: { url: "u", title: "t", text: "hello", truncated: false } } };
        if (m.params.expression === "location.href") return { result: { value: "https://one.test/" } };
        if (m.params.expression.startsWith("!!")) return { result: { value: true } };
        return { result: { value: { x: 1, y: 2 } } };
      }
      return {};
    } });
    cleanups.push(() => cdp.close());
    const b = await started(cdp);
    assert.match((await executeStandaloneTool(b, "session_read_page", { tabId: 1 })).content[0].text, /hello/);
    assert.match((await executeStandaloneTool(b, "session_click", { selector: "#go" })).content[0].text, /"clicked":"#go"/);
    assert.match((await executeStandaloneTool(b, "session_click", { ref: "@e2" })).content[0].text, /"clicked":"@e2"/);
    assert.match((await executeStandaloneTool(b, "session_fill", { ref: "@e3" })).content[0].text, /"filled":"@e3"/);
    assert.match((await executeStandaloneTool(b, "session_fill", { selector: "#q", value: "v" })).content[0].text, /"filled":"#q"/);
    await executeStandaloneTool(b, "session_select", { ref: "@e4", index: 0 });
    assert.match((await executeStandaloneTool(b, "session_wait", { condition: "url", timeoutMs: 500 })).content[0].text, /one\.test/);
    assert.match((await executeStandaloneTool(b, "session_wait", { condition: "selector", timeoutMs: 500 })).content[0].text, /"condition":"selector"/);
    assert.ok(seen.some((e) => e.includes(`[data-t3rnel-ref='e2']`)), "a @ref was not translated to its attribute");
    assert.ok(seen.some((e) => e.includes('"#go"')));
  });
});

describe("a click with nothing to aim at", () => {
  it("names the missing element rather than clicking the page", async () => {
    const cdp = await fakeCdp({ onCommand: (m) => (m.method === "Runtime.evaluate" ? { exceptionDetails: { text: /Element not found: undefined/.test(m.params.expression) ? "Element not found: undefined" : "?" } } : {}) });
    cleanups.push(() => cdp.close());
    const b = await started(cdp);
    await assert.rejects(executeStandaloneTool(b, "session_click", {}), /Element not found: undefined/);
  });
});

describe("fill and select with nothing to aim at", () => {
  it("name the missing element", async () => {
    const cdp = await fakeCdp({ onCommand: (m) => (m.method === "Runtime.evaluate" ? { exceptionDetails: { text: "Element not found: undefined" } } : {}) });
    cleanups.push(() => cdp.close());
    const b = await started(cdp);
    await assert.rejects(executeStandaloneTool(b, "session_fill", {}), /Element not found: undefined/);
    await assert.rejects(executeStandaloneTool(b, "session_select", {}), /Element not found: undefined/);
  });
});
