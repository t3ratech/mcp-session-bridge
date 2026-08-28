# MCP Session Bridge

A free MCP (Model Context Protocol) server that exposes **authenticated browser-session automation**: `session_*` tools that run in the user's own Chrome profile and real logged-in session, which cloud browser APIs cannot do. A free **standalone** mode is also available; it launches a dedicated automation browser so the same `session_*` tools work without the extension or a license.

## What it does

- Serves MCP over stdio (newline-delimited JSON-RPC) to any client that speaks the Model Context Protocol. The setup guide covers the common ones.
- Uses a dual-transport design:
  - **Extension mode (free; Pro tools gated by the extension)** — forwards calls over a local, owner-only relay socket to a native messaging host that Chrome spawns, and from there to the T3rnel Browser extension, which executes them against the live authenticated tabs.
  - **Standalone mode (free)** — launches its own headful or headless CDP browser on a persistent profile and drives it directly. No license, no extension, and no access to the user's everyday browser.
- Returns structured page context, form values, snapshots, and screenshots without shipping session cookies to a remote browser.

## Price

The bridge itself is free, and this package enforces no licence of its own.

Extension mode reaches the buyer's real authenticated session through the T3rnel Browser
extension, and the Pro tools it exposes are gated by that extension's own Pro tier —
$29.99 once, three devices. Standalone mode is free and needs neither the extension nor a
licence. There is no separate subscription for this package, and nothing here checks for
one; earlier drafts of this file advertised $9/mo and $39/mo tiers that were never
implemented, never enforced and never purchasable.

## Project layout

- `src/server.js` — MCP stdio server: tool surface, schema validation, dual-transport routing, relay client with reconnect and timeouts, and standalone CDP launcher.
- `src/cdp.js` — standalone CDP browser management and WebSocket client.
- `src/native-host.js` — native messaging host spawned by Chrome; owns the relay socket and multiplexes concurrent MCP servers.
- `src/framing.js` — the 4-byte length-prefixed JSON framing shared by native messaging and the relay socket.
- `src/tools.js` — the `session_*` tool definitions, validation, and mapping to the extension's `browser_*` tools.
- `src/license.js` — offline Ed25519 license verification helpers used by the extension and tests.
- `src/install.js` — `--install` / `--uninstall` native host registration for Chrome, Chromium, Brave and Edge.
- `docs/setup-guide.md` — installing on the common MCP clients, plus verification and troubleshooting.
- `docs/chrome-validation-checklist.md` — end-to-end validation steps for Chrome with the T3rnel Browser extension.
- `ads/` — `ad-copy.md`, the shared headline and description copy used when submitting to MCPize, Smithery, mcp.so and PulseMCP.
- `tests/` — `node --test` suite, including end-to-end tests through a real relay socket and native-messaging framing, plus standalone-mode coverage.

## Browser support

Extension mode needs the T3rnel Browser extension, which installs on Chrome, Brave, Edge
and Chromium from one package. Opera implements no side-panel API and Firefox no debugger
API, so both are partly supported; the extension's manifest generator states which
capabilities are absent on each. Standalone mode has no browser requirement at all — it
launches its own CDP browser.

The extension exposes 98 browser tools, all of which are reachable over this bridge
subject to the extension's own Pro gating and its approval gate.

## Supported clients

- Claude Code / Claude Desktop
- Cursor
- VS Code
- Windsurf
- Antigravity
- IntelliJ
- Codex
- Grok Build
- Kimi Code / Kimi Desktop
- JCode
- Cline
- OpenCode
- Continue.dev
- KiloCode
- Roo Code
- Aider
- OpenClaw
- Hermes
- OpenFang
- Any client that speaks MCP stdio

## Install the T3rnel Browser extension

The bridge works best with the T3rnel Browser extension, which lets your AI drive the browser you are already signed into:

<https://t3ratech.github.io/t3rnel-browser-plugin/>
