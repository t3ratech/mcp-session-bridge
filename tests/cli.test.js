/**
 * The command line, as npm's symlinked binary runs it, and the guarantee that importing
 * the server module starts nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const serverJs = join(root, "src", "server.js");
const scratch = () => mkdtempSync(join(tmpdir(), "t3rnel-cli-"));

describe("the server module", () => {
  it("starts no bridge when merely imported", () => {
    // In a child, so nothing it might start can leak into this process.
    const out = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(serverJs)}).then(() => { const busy = process._getActiveHandles().filter((h) => h.constructor.name === "Server" || h.constructor.name === "Socket" && h.remotePort); console.log(JSON.stringify(busy.length)); process.exit(0); })`], { encoding: "utf8", timeout: 20_000, env: { ...process.env, HOME: scratch() } });
    assert.equal(out.stdout.trim(), "0", out.stderr);
  });
});

describe("the command line", () => {
  const run = (args, home = scratch()) => spawnSync(process.execPath, [serverJs, ...args], { encoding: "utf8", timeout: 20_000, env: { ...process.env, HOME: home, APPDATA: join(home, "AppData") } });

  it("--help prints usage naming every environment variable", () => {
    const out = run(["--help"]);
    assert.equal(out.status, 0);
    for (const name of ["T3RNEL_SESSION_MODE", "T3RNEL_SESSION_PORT", "T3RNEL_SESSION_BROWSER", "T3RNEL_SESSION_TIMEOUT_MS"]) assert.match(out.stdout, new RegExp(name));
    assert.equal(run(["-h"]).stdout, out.stdout);
  });

  it("--install writes the host manifests, and --uninstall removes them, saying so", () => {
    const home = scratch();
    const installed = run(["--install"], home);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /Installed native messaging host: .*com\.t3rnel\.session\.json/);
    const manifest = join(home, ".config", "google-chrome", "NativeMessagingHosts", "com.t3rnel.session.json");
    if (process.platform === "linux") assert.ok(existsSync(manifest));
    const removed = run(["--uninstall"], home);
    assert.match(removed.stdout, /Removed native messaging host: /);
    assert.match(run(["--uninstall"], home).stdout, /No native messaging host registration found\./);
  });

  it("runs through npm's symlink, and exits 143 on SIGTERM", async () => {
    const dir = scratch();
    const link = join(dir, "mcp-session-bridge");
    symlinkSync(serverJs, link);
    const child = spawn(link, [], { env: { ...process.env, HOME: dir, T3RNEL_SESSION_MODE: "standalone", T3RNEL_SESSION_PORT: String(38311 + (process.pid % 500)) }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
    for (let t = 0; t < 10_000 && !out.includes('"id":1'); t += 50) await new Promise((r) => setTimeout(r, 50));
    assert.match(out, /"result":\{\}/);
    const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
    child.kill("SIGTERM");
    assert.deepEqual(await exited, { code: 143, signal: null });
  });

  it("exits by itself when its client closes stdin at once", () => {
    const home = scratch();
    const out = spawnSync(process.execPath, [serverJs], {
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`,
      encoding: "utf8", timeout: 15_000,
      env: { ...process.env, HOME: home, T3RNEL_SESSION_MODE: "standalone", T3RNEL_SESSION_PORT: String(39311 + (process.pid % 500)) },
    });
    assert.equal(out.signal, null, "the server had to be killed: something kept it alive after stdin closed");
    assert.match(out.stdout, /"id":1,"result":\{\}/);
  });
});

describe("recognising the program", () => {
  it("does not run the command line when argv names a file that does not exist", () => {
    const out = spawnSync(process.execPath, ["-e", `process.argv[1] = "/nonexistent/mcp-session-bridge"; import(${JSON.stringify(serverJs)}).then(() => { console.log("not run"); process.exit(0); })`], { encoding: "utf8", timeout: 15_000, env: { ...process.env, HOME: scratch() } });
    assert.equal(out.stdout.trim(), "not run", out.stderr);
  });
});
