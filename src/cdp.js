/**
 * Standalone browser mode — the free tier of the Session Bridge.
 *
 * When the T3rnel Browser extension is not installed, the MCP server launches
 * and drives its own dedicated browser over the Chrome DevTools Protocol: a
 * persistent profile under ~/.t3rnel/session-bridge/browser-profile that the
 * user logs into once, the same model Playwright MCP and chrome-devtools-mcp
 * use. Chrome 136+ refuses remote debugging on the default profile, so a
 * dedicated profile is not a choice but a requirement — and it is exactly why
 * the extension path (your real, everyday, already-logged-in browser) remains
 * the extension-backed capability.
 *
 * Zero dependencies: HTTP endpoints over node:http, CDP over the minimal
 * WebSocket client in ws.js.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { connectWebSocket } from "./ws.js";

const CDP_CALL_TIMEOUT_MS = 30000;
const MAX_PAGE_TEXT = 50000;

export function defaultBrowserPath(env = process.env) {
  if (env.T3RNEL_SESSION_BROWSER) return env.T3RNEL_SESSION_BROWSER;
  const candidates = {
    linux: [
      "/opt/chrome-for-testing/chrome-linux64/chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/brave-browser",
      "/usr/bin/microsoft-edge",
    ],
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
  }[platform()] ?? [];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function defaultProfileDir(env = process.env) {
  return env.T3RNEL_SESSION_PROFILE ?? join(homedir(), ".t3rnel", "session-bridge", "browser-profile");
}

const KEY_DEFINITIONS = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

const SNAPSHOT_JS = `(() => {
  document.querySelectorAll("[data-t3rnel-ref]").forEach((el) => el.removeAttribute("data-t3rnel-ref"));
  const interactive = document.querySelectorAll("a, button, input, select, textarea, [role='button'], [role='link'], [onclick]");
  const elements = [];
  let n = 0;
  for (const el of interactive) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const ref = "e" + (++n);
    el.setAttribute("data-t3rnel-ref", ref);
    elements.push({ ref, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute("aria-label") || "").slice(0, 120) });
    if (n >= 200) break;
  }
  return { url: location.href, title: document.title, elements };
})()`;

const FIND_ELEMENT_JS = (selector, ref) => `(() => {
  const el = ${ref != null ? `document.querySelector("[data-t3rnel-ref='${ref}']")` : `document.querySelector(${JSON.stringify(selector ?? "")})`};
  if (!el) throw new Error("Element not found: ${ref ?? selector}");
  el.scrollIntoView({ block: "center", inline: "center" });
  const rect = el.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
})()`;

const FILL_JS = (selector, ref, value) => `(() => {
  const el = ${ref != null ? `document.querySelector("[data-t3rnel-ref='${ref}']")` : `document.querySelector(${JSON.stringify(selector ?? "")})`};
  if (!el) throw new Error("Element not found: ${ref ?? selector}");
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`;

/**
 * Choosing from a dropdown, which `FILL_JS` cannot do.
 *
 * That setter comes from `HTMLInputElement.prototype`, so assigning through it does
 * nothing to a `<select>` — and a required dropdown is common enough on real forms that
 * standalone mode could fill every text field of a submission and still never submit it.
 * Matches by value, then by visible text, then by index, so a caller can use whichever
 * the page makes visible.
 */
const SELECT_JS = (selector, ref, { value, text, index }) => `(() => {
  const el = ${ref != null ? `document.querySelector("[data-t3rnel-ref='${ref}']")` : `document.querySelector(${JSON.stringify(selector ?? "")})`};
  if (!el) throw new Error("Element not found: ${ref ?? selector}");
  if (el.tagName !== "SELECT") throw new Error("target is not a <select>: ${ref ?? selector}");
  const options = Array.from(el.options);
  const wantValue = ${JSON.stringify(value ?? null)};
  const wantText = ${JSON.stringify(text ?? null)};
  const wantIndex = ${JSON.stringify(index ?? null)};
  let chosen = null;
  if (wantValue !== null) chosen = options.find((o) => o.value === wantValue) ?? null;
  if (!chosen && wantText !== null) {
    const needle = String(wantText).trim().toLowerCase();
    chosen = options.find((o) => (o.textContent || "").trim().toLowerCase() === needle)
      ?? options.find((o) => (o.textContent || "").trim().toLowerCase().includes(needle)) ?? null;
  }
  if (!chosen && wantIndex !== null && options[wantIndex]) chosen = options[wantIndex];
  if (!chosen) {
    throw new Error("no option matched; available: " + options.map((o) => o.value + "=" + (o.textContent || "").trim()).join(", ").slice(0, 300));
  }
  el.value = chosen.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { selected: true, value: chosen.value, text: (chosen.textContent || "").trim() };
})()`;

const READ_PAGE_JS = `(() => {
  const text = (document.body ? document.body.innerText : document.documentElement.innerText) || "";
  return { url: location.href, title: document.title, text: text.slice(0, ${MAX_PAGE_TEXT}), truncated: text.length > ${MAX_PAGE_TEXT} };
})()`;

export class StandaloneBrowser {
  constructor({ browserPath = defaultBrowserPath(), profileDir = defaultProfileDir(), headless = false } = {}) {
    this.browserPath = browserPath;
    this.profileDir = profileDir;
    this.headless = headless;
    this.process = null;
    this.port = null;
    this.sessions = new Map(); // targetId -> { ws, nextId, pending, loadListeners }
    this.tabIds = new Map(); // numeric tab id -> CDP target id
    this.nextTabId = 1;
  }

  async ensureStarted() {
    if (this.port && this.process && !this.process.killed) return;
    if (!this.browserPath) {
      throw new Error(
        "No browser found for standalone mode. Install Chrome/Chromium/Brave/Edge, or set T3RNEL_SESSION_BROWSER to its binary. " +
          "For your real logged-in browser, install the T3rnel Browser extension instead."
      );
    }
    mkdirSync(this.profileDir, { recursive: true });
    const portFile = join(this.profileDir, "DevToolsActivePort");
    if (existsSync(portFile)) {
      // A previous run may have left a live browser on this profile.
      const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
      if (port && (await this.probe(port))) {
        this.port = port;
        return;
      }
    }
    const args = [
      "--remote-debugging-port=0",
      `--user-data-dir=${this.profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
    ];
    if (this.headless) args.push("--headless=new");
    args.push("about:blank");
    this.process = spawn(this.browserPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    this.process.stderr.on("data", () => {});
    let earlyExit = null;
    this.process.on("error", (error) => {
      earlyExit = new Error(`Cannot start standalone browser: ${error.message}`);
    });
    this.process.on("exit", (code) => {
      this.port = null;
      this.process = null;
      for (const session of this.sessions.values()) session.ws.close();
      this.sessions.clear();
      earlyExit = new Error(`Standalone browser exited before exposing a CDP port (code: ${code})`);
    });
    const started = Date.now();
    while (Date.now() - started < 15000) {
      if (earlyExit) throw earlyExit;
      if (existsSync(portFile)) {
        const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
        if (port && (await this.probe(port))) {
          this.port = port;
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Standalone browser did not expose a CDP port within 15s (binary: ${this.browserPath})`);
  }

  async probe(port) {
    try {
      await this.httpJson("/json/version", "GET", port);
      return true;
    } catch {
      return false;
    }
  }

  async httpJson(path, method = "GET", port = this.port) {
    return new Promise((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, path, method, timeout: 5000 }, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          if (response.statusCode >= 400) {
            reject(new Error(`CDP HTTP ${response.statusCode} for ${path}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(`CDP HTTP ${path} returned non-JSON`));
          }
        });
      });
      request.on("error", reject);
      request.on("timeout", () => request.destroy(new Error(`CDP HTTP ${path} timed out`)));
      request.end();
    });
  }

  /** Rebuild the numeric-tab-id map from live targets, preserving assignments. */
  async syncTabs() {
    const targets = (await this.httpJson("/json/list")).filter((target) => target.type === "page");
    const live = new Set(targets.map((target) => target.id));
    for (const [tabId, targetId] of this.tabIds) {
      if (!live.has(targetId)) this.tabIds.delete(tabId);
    }
    for (const target of targets) {
      if (![...this.tabIds.values()].includes(target.id)) {
        this.tabIds.set(this.nextTabId++, target.id);
      }
    }
    return targets;
  }

  targetFor(tabId) {
    if (tabId != null) {
      const targetId = this.tabIds.get(tabId);
      if (!targetId) throw new Error(`No tab with id ${tabId} — call session_list_tabs for live ids`);
      return targetId;
    }
    const first = this.tabIds.entries().next().value;
    if (!first) throw new Error("No open tab — call session_navigate with newTab first");
    return first[1];
  }

  async session(targetId) {
    let session = this.sessions.get(targetId);
    if (session) return session;
    const targets = await this.httpJson("/json/list");
    const target = targets.find((entry) => entry.id === targetId);
    if (!target) throw new Error("Tab went away — call session_list_tabs for live ids");
    const pending = new Map();
    const loadListeners = new Set();
    const ws = await connectWebSocket(target.webSocketDebuggerUrl, {
      onMessage: (text) => {
        const message = JSON.parse(text);
        if (message.method === "Page.loadEventFired") {
          for (const listener of loadListeners) listener();
          return;
        }
        if (message.id == null) return;
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`CDP error: ${message.error.message}`));
        else entry.resolve(message.result);
      },
      onClose: () => {
        this.sessions.delete(targetId);
        for (const entry of pending.values()) {
          clearTimeout(entry.timer);
          entry.reject(new Error("CDP connection to the tab closed"));
        }
        pending.clear();
      },
    });
    session = { ws, nextId: 1, pending, loadListeners };
    this.sessions.set(targetId, session);
    await this.cdp(targetId, "Page.enable");
    await this.cdp(targetId, "Runtime.enable");
    return session;
  }

  async cdp(targetId, method, params = {}) {
    const session = await this.session(targetId);
    const id = session.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`CDP call ${method} timed out`));
      }, CDP_CALL_TIMEOUT_MS);
      session.pending.set(id, { resolve, reject, timer });
      session.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalIn(targetId, expression, awaitPromise = false) {
    const result = await this.cdp(targetId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed");
    }
    return result.result?.value;
  }

  async close() {
    for (const session of this.sessions.values()) session.ws.close();
    this.sessions.clear();
    if (this.process && !this.process.killed) this.process.kill();
  }
}

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

/**
 * Executes one session_* tool against the standalone browser. Mirrors the
 * extension's browser_* semantics so an MCP client sees the same surface on
 * both transports; capabilities that need the extension say so by name.
 */
export async function executeStandaloneTool(browser, name, args = {}) {
  await browser.ensureStarted();
  await browser.syncTabs();

  switch (name) {
    case "session_health": {
      const version = await browser.httpJson("/json/version");
      return text({ ok: true, mode: "standalone", browser: version.Browser, profileDir: browser.profileDir });
    }
    case "session_list_tabs": {
      const targets = await browser.syncTabs();
      const tabs = [...browser.tabIds.entries()].map(([tabId, targetId]) => {
        const target = targets.find((entry) => entry.id === targetId);
        return { id: tabId, title: target?.title ?? "", url: target?.url ?? "" };
      });
      return text(tabs);
    }
    case "session_navigate": {
      if (args.newTab) {
        const target = await browser.httpJson(`/json/new?${encodeURIComponent(args.url)}`, "PUT");
        browser.tabIds.set(browser.nextTabId++, target.id);
        return text({ navigated: args.url, newTab: true });
      }
      const targetId = browser.targetFor(args.tabId);
      await browser.cdp(targetId, "Page.navigate", { url: args.url });
      return text({ navigated: args.url });
    }
    case "session_read_page": {
      return text(await browser.evalIn(browser.targetFor(args.tabId), READ_PAGE_JS));
    }
    case "session_snapshot": {
      return text(await browser.evalIn(browser.targetFor(args.tabId), SNAPSHOT_JS));
    }
    case "session_click": {
      const targetId = browser.targetFor(args.tabId);
      const point = await browser.evalIn(targetId, FIND_ELEMENT_JS(args.selector, args.ref));
      await browser.cdp(targetId, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await browser.cdp(targetId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
      return text({ clicked: args.ref ?? args.selector });
    }
    case "session_select": {
      const chosen = await browser.evalIn(
        browser.targetFor(args.tabId),
        SELECT_JS(args.selector, args.ref, { value: args.value, text: args.text, index: args.index })
      );
      return text(chosen);
    }
    case "session_fill": {
      await browser.evalIn(browser.targetFor(args.tabId), FILL_JS(args.selector, args.ref, args.value ?? ""));
      return text({ filled: args.ref ?? args.selector });
    }
    case "session_type": {
      const targetId = browser.targetFor(args.tabId);
      if (args.selector || args.ref) {
        await browser.evalIn(targetId, `document.querySelector(${JSON.stringify(args.selector ?? `[data-t3rnel-ref='${args.ref}']`)})?.focus()`);
      }
      await browser.cdp(targetId, "Input.insertText", { text: args.text ?? "" });
      return text({ typed: (args.text ?? "").length });
    }
    case "session_press": {
      const definition = KEY_DEFINITIONS[args.key];
      if (!definition) throw new Error(`Unsupported key "${args.key}" — supported: ${Object.keys(KEY_DEFINITIONS).join(", ")}`);
      const targetId = browser.targetFor(args.tabId);
      await browser.cdp(targetId, "Input.dispatchKeyEvent", { type: definition.text ? "keyDown" : "rawKeyDown", ...definition });
      await browser.cdp(targetId, "Input.dispatchKeyEvent", { type: "keyUp", ...definition, text: undefined });
      return text({ pressed: args.key });
    }
    case "session_evaluate": {
      const value = await browser.evalIn(browser.targetFor(args.tabId), args.expression ?? "undefined", true);
      return text(value === undefined ? "undefined" : typeof value === "string" ? value : JSON.stringify(value, null, 2));
    }
    case "session_screenshot": {
      const targetId = browser.targetFor(args.tabId);
      const format = args.format === "jpeg" ? "jpeg" : "png";
      const params = { format };
      if (format === "jpeg" && typeof args.quality === "number") params.quality = Math.max(0, Math.min(100, args.quality));
      const shot = await browser.cdp(targetId, "Page.captureScreenshot", params);
      return text(`data:image/${format};base64,${shot.data}`);
    }
    case "session_wait": {
      const targetId = browser.targetFor(args.tabId);
      const timeoutMs = args.timeout ?? 10000;
      const deadline = Date.now() + timeoutMs;
      if (args.condition === "load") {
        const session = await browser.session(targetId);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms waiting for load`)), timeoutMs);
          session.loadListeners.add(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        return text({ condition: "load", waited: true });
      }
      if (args.condition === "url") {
        while (Date.now() < deadline) {
          const url = await browser.evalIn(targetId, "location.href");
          if (typeof url === "string" && url.includes(args.value ?? "")) return text({ condition: "url", url });
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throw new Error(`Timed out after ${timeoutMs}ms waiting for URL containing "${args.value}"`);
      }
      if (args.condition === "selector") {
        while (Date.now() < deadline) {
          const found = await browser.evalIn(targetId, `!!document.querySelector(${JSON.stringify(args.value ?? "")})`);
          if (found) return text({ condition: "selector", found: args.value });
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throw new Error(`Timed out after ${timeoutMs}ms waiting for selector "${args.value}"`);
      }
      throw new Error(`Unknown wait condition "${args.condition}" — expected load, url, or selector`);
    }
    case "session_login":
      throw new Error(
        "session_login requires the T3rnel Browser extension with Pro — its encrypted credential vault lives in the extension. " +
          "The standalone browser has no vault; log in once manually in the standalone profile instead, and the session persists."
      );
    default:
      throw new Error(`Tool ${name} is not available in standalone mode`);
  }
}
