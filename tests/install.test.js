import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHostManifest,
  defaultHostPath,
  installHosts,
  nativeHostDirs,
  uninstallHosts,
  HOST_NAME,
  EXTENSION_ID, STORE_EXTENSION_ID, UNPACKED_EXTENSION_ID,
} from "../src/install.js";
import { resolveSocketPath } from "../src/relay.js";

describe("install", () => {
  it("builds a manifest bound to the T3rnel Browser extension only", () => {
    const manifest = buildHostManifest("/opt/bridge/native-host.js");
    assert.strictEqual(manifest.name, HOST_NAME);
    assert.strictEqual(manifest.type, "stdio");
    assert.strictEqual(manifest.path, "/opt/bridge/native-host.js");
    // Both ids, not one. The published build runs under the Web Store item id because
    // packaging strips the manifest key; only an unpacked build keeps the key-derived
    // id. A host that names one refuses the other silently, which is how this shipped
    // as a total failure of the paid path. This assertion previously pinned that bug.
    assert.deepStrictEqual(manifest.allowed_origins, [
      `chrome-extension://${STORE_EXTENSION_ID}/`,
      `chrome-extension://${UNPACKED_EXTENSION_ID}/`,
    ]);
    assert.ok(manifest.allowed_origins.includes(`chrome-extension://${EXTENSION_ID}/`));
  });

  it("points at a native host entry point that exists in the package", () => {
    assert.ok(existsSync(defaultHostPath()));
  });

  it("writes and removes manifests in the given browser directories", () => {
    const root = mkdtempSync(join(tmpdir(), "t3rnel-install-"));
    const dirs = [join(root, "chrome"), join(root, "brave")];
    try {
      const hostPath = join(root, "native-host.js");
      writeFileSync(hostPath, "#!/usr/bin/env node\n");

      const written = installHosts({ hostPath, dirs });
      assert.strictEqual(written.length, 2);
      for (const path of written) {
        const manifest = JSON.parse(readFileSync(path, "utf8"));
        assert.strictEqual(manifest.name, HOST_NAME);
        assert.strictEqual(manifest.path, hostPath);
      }

      const removed = uninstallHosts({ dirs });
      assert.deepStrictEqual(removed.sort(), written.sort());
      assert.strictEqual(uninstallHosts({ dirs }).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to install a host entry point that does not exist", () => {
    const root = mkdtempSync(join(tmpdir(), "t3rnel-install-"));
    try {
      assert.throws(
        () => installHosts({ hostPath: join(root, "missing.js"), dirs: [join(root, "chrome")] }),
        /does not exist/
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("targets per-browser directories on linux and macOS, and one plus the registry on Windows", () => {
    /**
     * This asserted `[]` for Windows, which pinned the defect rather than catching it:
     * an empty list meant `--install` wrote nothing, said nothing, and left extension
     * mode permanently broken there. Windows finds a host through the registry, so one
     * directory holds the manifest and `installHosts` writes the keys that point at it.
     */
    const home = "/home/tester";
    for (const dir of nativeHostDirs("linux", home)) {
      assert.ok(dir.startsWith(`${home}/.config/`), dir);
      assert.ok(dir.endsWith("NativeMessagingHosts"), dir);
    }
    for (const dir of nativeHostDirs("darwin", home)) {
      assert.ok(dir.endsWith("NativeMessagingHosts"), dir);
    }
    const windows = nativeHostDirs("win32", home);
    assert.strictEqual(windows.length, 1, "Windows should resolve to exactly one manifest location");
    assert.ok(windows[0].length > 0, "Windows resolves to an empty path");
  });
});

describe("relay socket path", () => {
  it("honours the override", () => {
    assert.strictEqual(resolveSocketPath({ T3RNEL_SESSION_SOCKET: " /tmp/x.sock " }, "linux", "/home/x"), "/tmp/x.sock");
  });

  it("defaults to a per-user unix socket", () => {
    assert.strictEqual(
      resolveSocketPath({}, "linux", "/home/tester"),
      "/home/tester/.t3rnel/session-bridge/bridge.sock"
    );
  });

  it("defaults to a named pipe on Windows", () => {
    assert.strictEqual(resolveSocketPath({}, "win32", "C:\\Users\\tester"), "\\\\.\\pipe\\t3rnel-session-bridge");
  });
});

/**
 * Every platform the bridge claims to run on can actually register the host.
 *
 * `nativeHostDirs("win32")` returned an empty array, so `mcp-session-bridge --install` on
 * Windows wrote nothing, reported success, and left extension mode permanently broken
 * with no error anyone could search for. Nothing caught it because nothing asserted that
 * a platform resolves to somewhere.
 */
describe("native host registration, per platform", () => {
  it("knows a location for every platform it supports", () => {
    for (const os of ["linux", "darwin", "win32"]) {
      const dirs = nativeHostDirs(os, "/home/u");
      assert.ok(
        dirs.length > 0,
        `${os} resolves to no host location, so --install writes nothing and says nothing`
      );
      for (const dir of dirs) assert.ok(dir.length > 0, `${os} produced an empty path`);
    }
  });

  it("puts each platform's manifest where that platform's browsers look", () => {
    const linux = nativeHostDirs("linux", "/home/u");
    assert.ok(linux.some((d) => d.includes(".config/google-chrome")), "no Chrome location on Linux");
    assert.ok(linux.some((d) => d.includes("BraveSoftware")), "no Brave location on Linux");

    const mac = nativeHostDirs("darwin", "/Users/u");
    assert.ok(mac.every((d) => d.includes("Library/Application Support")), "macOS paths are not under Application Support");
    assert.ok(mac.some((d) => d.includes("Microsoft Edge")), "no Edge location on macOS");

    const win = nativeHostDirs("win32", "C:\\Users\\u");
    assert.ok(win.length === 1, "Windows should use one location and the registry, not four directories");
  });

  it("falls back rather than returning nothing on an unknown platform", () => {
    const other = nativeHostDirs("sunos", "/home/u");
    assert.ok(other.length > 0, "an unknown platform gets no location and fails silently");
  });

  it("refuses to report success when it has nowhere to write", () => {
    // The shape of the Windows bug: an empty location list must be an error, never a
    // silent no-op that leaves the user believing the install worked.
    assert.throws(
      () => installHosts({ hostPath: defaultHostPath(), dirs: [], os: "plan9" }),
      /no native messaging host location/i,
      "an install with nowhere to write did not fail loudly"
    );
  });

  it("names an executable Windows can actually start", () => {
    // Chrome runs the manifest's `path` directly and Windows cannot execute a .js, so the
    // manifest must name a launcher rather than the script itself.
    const source = readFileSync(new URL("../src/install.js", import.meta.url), "utf8");
    assert.match(source, /\.bat/, "no Windows launcher is written, so the host can never start");
    assert.match(source, /reg["'\s,]+.*add/s, "the Windows registry keys are never written");
    assert.match(source, /HKCU\\\\Software\\\\Google\\\\Chrome/, "Chrome's registry key is missing");
  });

  it("does not chmod on Windows, where the mode means nothing", () => {
    const source = readFileSync(new URL("../src/install.js", import.meta.url), "utf8");
    assert.match(source, /os !== "win32"\) chmodSync/, "chmod runs unconditionally");
  });
});
