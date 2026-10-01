# MCP Session Bridge

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/t3ratech/mcp-session-bridge)

A free MCP (Model Context Protocol) server that exposes **authenticated browser-session automation**: `session_*` tools that run in the user's own Chrome profile and real logged-in session, which cloud browser APIs cannot do. A free **standalone** mode is also available; it launches a dedicated automation browser so the same `session_*` tools work without the extension or a license.

## What it does

- Serves MCP over stdio (newline-delimited JSON-RPC) to any client that speaks the Model Context Protocol. The setup guide covers the common ones.
- Uses a dual-transport design:
  - **Extension mode (free; Pro tools gated by the extension)** — since 1.3.0 the bridge serves a loopback WebSocket the extension's service worker dials out to, so `npx @t3ratech/mcp-session-bridge` is the whole setup: no global install, no `--install`, no native host manifest. The first connection asks once in the extension panel, permanently. The pre-1.3 path — relay socket to a native messaging host Chrome spawns — remains as a fallback for hosts registered by older installs.
  - **Standalone mode (free)** — launches its own headful or headless CDP browser on a persistent profile and drives it directly. No license, no extension, and no access to the user's everyday browser.
- Returns structured page context, form values, snapshots, and screenshots without shipping session cookies to a remote browser.

## Price

The bridge itself is free, and this package enforces no licence of its own.

Extension mode reaches the buyer's real authenticated session through the T3rnel Browser
extension, and the Pro tools it exposes are gated by that extension's own Pro tier —
a one-time payment for three devices, priced by WavePay and shown in the extension. Standalone mode is free and needs neither the extension nor a
licence. There is no separate subscription for this package, and nothing here checks for
one; earlier drafts of this file advertised $9/mo and $39/mo tiers that were never
implemented, never enforced and never purchasable.

## Project layout

- `src/server.js` — MCP stdio server: tool surface, schema validation, dual-transport routing, loopback WebSocket endpoint, relay client with reconnect and timeouts, and standalone CDP launcher.
- `src/cdp.js` — standalone CDP browser management and WebSocket client.
- `src/ws-server.js` — the loopback WebSocket endpoint extension mode dials out to (1.3.0+).
- `src/native-host.js` — legacy path: native messaging host spawned by Chrome; owns the relay socket and multiplexes concurrent MCP servers.
- `src/framing.js` — the 4-byte length-prefixed JSON framing shared by native messaging and the relay socket.
- `src/tools.js` — the `session_*` tool definitions, validation, and mapping to the extension's `browser_*` tools.
- `src/license.js` — offline Ed25519 license verification helpers used by the extension and tests.
- `src/install.js` — `--install` / `--uninstall` native host registration for Chrome, Chromium, Brave and Edge (legacy transport only — not needed for 1.3.0+).
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

The extension exposes 97 browser tools over this bridge — the full surface minus three
licence-maintenance tools that stay panel-only — subject to the extension's own Pro
gating. The count stays under the 100-tool limit some MCP clients enforce, and
`session_install` (setup instructions) brings the bridge's own listing to 98.

## Supported clients

- Claude Code / Claude Cowork
- Cursor
- VS Code
- Windsurf / Devin Desktop
- Google Antigravity
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

<https://browser.t3ratech.co.zw/>

Every `session_*` error that reports the extension missing — on any tool that genuinely
needs it — carries this link. Standalone-capable tools never nag: they just work
without the extension.

## Where this is listed

- [npm](https://www.npmjs.com/package/@t3ratech/mcp-session-bridge) · [Model Context Protocol registry](https://registry.modelcontextprotocol.io) · [Smithery](https://smithery.ai) · [Glama](https://glama.ai/mcp/servers)
- Agent skills: [skills.sh](https://skills.sh/t3ratech/mcp-session-bridge/signed-in-browser) · [ClawHub](https://clawhub.ai/t3ratech/skills/t3rnel-signed-in-browser)
- Listed in the [Claude Market skill directory](https://www.claudemarket.ai/skills)

## Licence

Source-available, not open source. See [LICENSE](LICENSE) for the terms.

In short: the published npm package is free to use for any purpose, commercial or
otherwise; you may read and locally modify this source; you may not redistribute it or
publish a derivative without written permission.

Directory listings that expect an SPDX identifier will report "no licence" for this
repository. That is expected — GitHub detects the file and classifies it as `other` /
`NOASSERTION`, because the terms are bespoke rather than one of the recognised
open-source licences. The licence exists; it simply is not an OSI one.
