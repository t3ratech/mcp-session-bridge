/**
 * The install paths no Linux run reached: Windows' launcher and registry, macOS and
 * unknown platforms' manifest locations, and the post-install instructions.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHosts, nativeHostDirs, printInstallSummary, HOST_NAME } from "../src/install.js";
import { createFrameDecoder, encodeFrame } from "../src/framing.js";
import { ensureSocketDir, resolveSocketPath } from "../src/relay.js";
import { validateArguments } from "../src/tools.js";

const scratch = () => mkdtempSync(join(tmpdir(), "t3rnel-install-"));

describe("native host locations per platform", () => {
  it("macOS: the four Chromium browsers under Application Support", () => {
    const dirs = nativeHostDirs("darwin", "/Users/u");
    assert.equal(dirs.length, 4);
    for (const dir of dirs) assert.match(dir, /^\/Users\/u\/Library\/Application Support\/.+\/NativeMessagingHosts$/);
  });

  it("Windows: one directory under APPDATA, or the roaming profile when APPDATA is unset", () => {
    const saved = process.env.APPDATA;
    try {
      process.env.APPDATA = "C:/Users/u/AppData/Roaming";
      assert.deepEqual(nativeHostDirs("win32", "C:/Users/u"), [join("C:/Users/u/AppData/Roaming", "T3rnel", "NativeMessagingHosts")]);
      delete process.env.APPDATA;
      assert.deepEqual(nativeHostDirs("win32", "C:/Users/u"), [join("C:/Users/u", "AppData", "Roaming", "T3rnel", "NativeMessagingHosts")]);
    } finally {
      if (saved === undefined) delete process.env.APPDATA; else process.env.APPDATA = saved;
    }
  });

  it("an unknown platform falls back to Chrome's Linux location rather than nothing", () => {
    assert.deepEqual(nativeHostDirs("freebsd", "/home/u"), [join("/home/u", ".config", "google-chrome", "NativeMessagingHosts")]);
  });
});

describe("installing on Windows", () => {
  it("writes a .bat launcher, names it in the manifest, and registers every browser's key", () => {
    const dir = scratch();
    const host = join(dir, "native-host.js");
    writeFileSync(host, "#!/usr/bin/env node\n");
    const calls = [];
    try {
      const written = installHosts({ hostPath: host, dirs: [join(dir, "hosts")], os: "win32", exec: (cmd, args) => calls.push([cmd, args]) });
      const manifestPath = join(dir, "hosts", `${HOST_NAME}.json`);
      const launcher = join(dir, "hosts", `${HOST_NAME}.bat`);
      assert.ok(existsSync(launcher));
      assert.match(readFileSync(launcher, "utf8"), new RegExp(`node "${host.replace(/[\\\\]/g, "\\\\$&")}" %\\*`));
      assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).path, launcher);
      assert.equal(calls.length, 4);
      for (const [cmd, args] of calls) {
        assert.equal(cmd, "reg");
        assert.deepEqual(args.slice(-5), ["/t", "REG_SZ", "/d", manifestPath, "/f"]);
      }
      assert.deepEqual(written, [manifestPath, ...calls.map(([, args]) => args[1])]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the key it could not write when reg.exe fails", () => {
    const dir = scratch();
    const host = join(dir, "native-host.js");
    writeFileSync(host, "");
    try {
      assert.throws(
        () => installHosts({ hostPath: host, dirs: [join(dir, "hosts")], os: "win32", exec: () => { throw new Error("Access is denied."); } }),
        /Could not register the native host under HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com\.t3rnel\.session: Access is denied\./,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the post-install summary", () => {
  it("lists each written manifest, then the extension link, the client config and standalone mode", () => {
    const lines = [];
    printInstallSummary(["/a/com.t3rnel.session.json", "/b/com.t3rnel.session.json"], (line) => lines.push(line));
    assert.equal(lines[0], "Installed native messaging host: /a/com.t3rnel.session.json");
    assert.equal(lines[1], "Installed native messaging host: /b/com.t3rnel.session.json");
    const text = lines.join("\n");
    assert.match(text, /https:\/\/browser\.t3ratech\.co\.zw\//);
    assert.deepEqual(JSON.parse(lines.find((l) => l.startsWith("{"))).mcpServers["t3rnel-session"], { command: "mcp-session-bridge", env: { T3RNEL_SESSION_MODE: "auto" } });
    assert.match(text, /T3RNEL_SESSION_MODE=standalone/);
  });
});

describe("small invariants", () => {
  it("the frame decoder reports the bytes it is still holding", () => {
    const decoded = [];
    const decoder = createFrameDecoder((m) => decoded.push(m));
    const frame = encodeFrame({ a: 1 });
    decoder.push(frame.subarray(0, 6));
    assert.equal(decoder.bufferedBytes, 6);
    decoder.push(frame.subarray(6));
    assert.equal(decoder.bufferedBytes, 0);
    assert.deepEqual(decoded, [{ a: 1 }]);
  });

  it("Windows needs no socket directory: the relay is a named pipe", () => {
    assert.equal(resolveSocketPath({}, "win32", "C:/Users/u"), "\\\\.\\pipe\\t3rnel-session-bridge");
    assert.equal(ensureSocketDir("\\\\.\\pipe\\t3rnel-session-bridge", "win32"), undefined);
  });

  it("validation refuses a non-object and names each wrong type", () => {
    for (const bad of [null, [], "x", 3]) assert.equal(validateArguments(bad, { properties: {} }), "arguments must be an object");
    const schema = { properties: { n: { type: "integer" }, b: { type: "boolean" }, a: { type: "array" }, o: { type: "object" }, x: { type: "whatever" } } };
    assert.equal(validateArguments({ n: 1.5 }, schema), "n must be an integer");
    assert.equal(validateArguments({ b: "true" }, schema), "b must be a boolean");
    assert.equal(validateArguments({ a: {} }, schema), "a must be an array");
    assert.equal(validateArguments({ o: [] }, schema), "o must be an object");
    assert.equal(validateArguments({ o: null }, schema), "o must be an object");
    assert.equal(validateArguments({ n: 2, b: false, a: [], o: {}, x: Symbol.for("anything") }, schema), null);
  });
});

describe("validation's remaining shapes", () => {
  it("accepts any arguments against a schema that names no properties, and checks numbers", () => {
    assert.equal(validateArguments({ anything: 1 }, {}), null);
    assert.equal(validateArguments({ anything: 1 }, { additionalProperties: false }), "Unknown argument: anything");
    const schema = { properties: { n: { type: "number" } } };
    assert.equal(validateArguments({ n: 2.5 }, schema), null);
    assert.equal(validateArguments({ n: Infinity }, schema), "n must be a number");
    assert.equal(validateArguments({ n: "2" }, schema), "n must be a number");
  });
});
