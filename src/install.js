/**
 * Native messaging host registration. Chrome discovers hosts from manifest
 * files in per-browser directories; `--install` writes them, `--uninstall`
 * removes them. Paths are injectable so tests never touch a real home
 * directory.
 */

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
import { execFileSync } from "node:child_process";

export const HOST_NAME = "com.t3rnel.session";

/**
 * Both ids have to be admitted, and getting this wrong is silent.
 *
 * `scripts/package-store.mjs` strips the manifest `key` from the published build, so an
 * extension installed from the Web Store runs under the store item id. Only an unpacked
 * build from this repository keeps the key-derived id. A host manifest that names one id
 * refuses the other, Chrome reports nothing the buyer can see, and `native-bridge.ts`
 * retries on a 15-second backoff forever — so the extension path fails for every real user
 * with a symptom that names nothing.
 *
 * This is ISSUE-124 in a second location: the licence worker already admits both ids via
 * ALLOWED_EXTENSION_ID, and the native host was missed.
 */
export const STORE_EXTENSION_ID = "egpckhdpkoeimoekciejbmbbcackhdmd";
export const UNPACKED_EXTENSION_ID = "joiiomgbcchbfgicoojocgdfmgkfjcoj";
export const EXTENSION_IDS = [STORE_EXTENSION_ID, UNPACKED_EXTENSION_ID];

/** @deprecated Use EXTENSION_IDS. Retained so an older config keeps resolving. */
export const EXTENSION_ID = UNPACKED_EXTENSION_ID;

export function defaultHostPath() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "native-host.js");
}

export function buildHostManifest(hostPath) {
  return {
    name: HOST_NAME,
    description: "T3rnel MCP Session Bridge native messaging host",
    path: hostPath,
    type: "stdio",
    allowed_origins: EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
  };
}

export function nativeHostDirs(os = platform(), home = homedir()) {
  switch (os) {
    case "linux":
      return [
        join(home, ".config", "google-chrome", "NativeMessagingHosts"),
        join(home, ".config", "chromium", "NativeMessagingHosts"),
        join(home, ".config", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
        join(home, ".config", "microsoft-edge", "NativeMessagingHosts"),
      ];
    case "darwin":
      return [
        join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts"),
        join(home, "Library", "Application Support", "Chromium", "NativeMessagingHosts"),
        join(home, "Library", "Application Support", "BraveSoftware", "Brave-Browser", "NativeMessagingHosts"),
        join(home, "Library", "Application Support", "Microsoft Edge", "NativeMessagingHosts"),
      ];
    case "win32":
      /**
       * Windows keeps the manifest wherever you like and finds it through the registry,
       * so one directory under the roaming profile serves every Chromium browser. The
       * registry keys are written by `installHosts`.
       *
       * This returned `[]`, which meant `mcp-session-bridge --install` on Windows wrote
       * nothing, reported success, and left extension mode permanently broken with no
       * error to search for.
       */
      return [join(process.env.APPDATA || join(home, "AppData", "Roaming"), "T3rnel", "NativeMessagingHosts")];
    default:
      return [join(home, ".config", "google-chrome", "NativeMessagingHosts")];
  }
}

/**
 * Chrome runs the `path` in a host manifest directly, and Windows cannot execute a `.js`.
 *
 * On Linux and macOS the shebang in `native-host.js` makes it runnable, which is why
 * `chmod 0755` is enough there. On Windows the manifest has to point at something the
 * shell can start, so a one-line launcher is written beside the manifest and named in it.
 */
function writeWindowsLauncher(dir, hostPath) {
  const launcher = join(dir, `${HOST_NAME}.bat`);
  // `node` comes from PATH, which the installer already required to run at all.
  writeFileSync(launcher, `@echo off\r\nnode "${hostPath}" %*\r\n`);
  return launcher;
}

/**
 * Windows finds a native messaging host through the registry, not a well-known directory.
 * Each browser reads its own key, and the default value is the path to the manifest.
 */
function registerWindowsHost(manifestPath) {
  const keys = [
    "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
    "HKCU\\Software\\Chromium\\NativeMessagingHosts",
    "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
    "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts",
  ];
  const registered = [];
  for (const key of keys) {
    const full = `${key}\\${HOST_NAME}`;
    try {
      execFileSync("reg", ["add", full, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"], { stdio: "ignore" });
      registered.push(full);
    } catch (error) {
      // A browser that is not installed has no parent key, and `reg add` creates it, so a
      // failure here is a real one — a locked-down profile, or reg.exe missing.
      throw new Error(`Could not register the native host under ${full}: ${error.message}`);
    }
  }
  return registered;
}

export function installHosts({ hostPath = defaultHostPath(), dirs = nativeHostDirs(), os = platform() } = {}) {
  if (!existsSync(hostPath)) {
    throw new Error(`Native host entry point does not exist: ${hostPath}`);
  }
  if (dirs.length === 0) {
    throw new Error(
      `No native messaging host location is known for platform "${os}". ` +
        "Extension mode cannot work until one is added; standalone mode still does " +
        "(set T3RNEL_SESSION_MODE=standalone)."
    );
  }
  if (os !== "win32") chmodSync(hostPath, 0o755);

  const written = [];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    const manifestPath = join(dir, `${HOST_NAME}.json`);
    const executable = os === "win32" ? writeWindowsLauncher(dir, hostPath) : hostPath;
    writeFileSync(manifestPath, `${JSON.stringify(buildHostManifest(executable), null, 2)}\n`);
    written.push(manifestPath);
    if (os === "win32") written.push(...registerWindowsHost(manifestPath));
  }
  return written;
}

export function uninstallHosts({ dirs = nativeHostDirs() } = {}) {
  const removed = [];
  for (const dir of dirs) {
    const manifestPath = join(dir, `${HOST_NAME}.json`);
    if (existsSync(manifestPath)) {
      rmSync(manifestPath);
      removed.push(manifestPath);
    }
  }
  return removed;
}

export function printInstallSummary(written, hostPath, out = console.log) {
  if (written.length === 0) {
    out("Windows: native hosts register via the registry, not the file system.");
    out(`Create HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME} with default value pointing at a manifest containing:`);
    out(JSON.stringify(buildHostManifest(hostPath), null, 2));
    return;
  }
  for (const path of written) {
    out(`Installed native messaging host: ${path}`);
  }
  out("");
  out("Next steps:");
  out("  1. Install the T3rnel Browser extension:");
  out("     https://t3ratech.github.io/t3rnel-browser-plugin/");
  out("  2. Add this server to your MCP client config (Claude Code/Desktop, Cursor, VS Code, Windsurf, Antigravity, IntelliJ, Codex, Grok Build, Kimi Code/Desktop, JCode, Cline, OpenCode, Continue.dev, KiloCode, Roo Code, Aider, OpenClaw, Hermes, OpenFang and any MCP client):");
  out(JSON.stringify({
    mcpServers: {
      "t3rnel-session": {
        command: "mcp-session-bridge",
        env: { T3RNEL_SESSION_MODE: "auto" },
      },
    },
  }, null, 2));
  out("  3. Without the extension, run in standalone (free) mode by adding:");
  out('     T3RNEL_SESSION_MODE=standalone  (or set T3RNEL_SESSION_BROWSER to your Chrome binary)');
}
