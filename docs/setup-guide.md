# MCP Session Bridge — Setup Guide

## What you get

A local MCP server that exposes `session_*` browser-automation tools to any client that speaks the Model Context Protocol — Claude Code and Desktop, Cursor, VS Code, Windsurf, Codex, Cline, Continue.dev, Aider and the rest. In free extension mode the tools run in the user’s own Chrome session, reading authenticated pages without shipping cookies to a cloud browser; Pro tools are gated by the T3rnel Browser extension's own Pro tier. In free standalone mode the server drives its own dedicated CDP browser.

## How it works

```
MCP client (Claude Code / Claude Desktop, Cursor, VS Code, Windsurf, Antigravity, IntelliJ, Codex, Grok Build, Kimi Code/Desktop, JCode, Cline, OpenCode, Continue.dev, KiloCode, Roo Code, Aider, OpenClaw, Hermes, OpenFang and any MCP client)
  │ stdio, newline-delimited JSON-RPC
  ▼
mcp-session-bridge          ← routes to the extension or a standalone CDP browser
  │ loopback WebSocket (ws://127.0.0.1, extension dials out — since 1.3.0)
  ▼
T3rnel Browser extension    ← executes the tool against your real, logged-in tabs
```

Nothing leaves the machine: the WebSocket listens on loopback only. While AI/MCP
automation is allowed — the extension's default, and the choice its setup page offers —
the extension approves a connecting bridge automatically, so the first connection just
works and no prompt ever stands between the client and a tool. Arming the approval
gate in the extension's Settings restores supervision: a new bridge then shows a
one-time **Approve connection** card in the side panel. A declined bridge stays
refused either way.
Bridge installs older than 1.3.0 keep working through the previous path (relay socket
→ native messaging host Chrome spawns) until it is retired in 1.4. Pro gating happens
inside the closed, shipped extension; the open MCP server only routes the call.

## Prerequisites

- Node.js 20 or newer.
- Chrome, Chromium, Brave or Edge with the **T3rnel Browser** extension installed: https://browser.t3ratech.co.zw/

## Install

Since 1.3.0 there is no install step: point your MCP client at the package and it runs
through `npx`. The server binds a loopback WebSocket the moment it starts, and the
extension connects to it the next time its service worker wakes.

```json
{
  "mcpServers": {
    "t3rnel-session": {
      "command": "npx",
      "args": ["-y", "@t3ratech/mcp-session-bridge"]
    }
  }
}
```

With automation allowed — the extension's default — the first connection is approved
automatically and every `session_*` tool is unlocked at once; there is nothing to
click. If you armed the approval gate in Settings (or declined AI/MCP automation at
setup), the side panel instead shows a one-time **Approve connection** card: approve
it once and every MCP action is covered permanently, decline it and `session_*` calls
are refused until you approve — the card reappears on the next connection attempt.

Every bridge this browser trusts — auto-paired or approved — is listed under
**Settings → Session bridges** in the side panel, each with a **Forget** button.
Forget drops the id from both trust sets and closes its live connection; the next
connection from that bridge is judged fresh — auto-paired while automation stands,
or shown the card under an armed gate. To keep a bridge out rather than re-judge it,
decline the card instead of forgetting it.

<details>
<summary>Legacy install (bridge &lt; 1.3.0): native messaging host</summary>

The pre-1.3 transport registers a native-messaging host so Chrome can spawn it:

```bash
npm install -g @t3ratech/mcp-session-bridge
mcp-session-bridge --install
```

`--install` writes the native-messaging host manifest for Chrome / Chromium / Brave / Edge on Linux and macOS and marks the host executable. On Windows it prints the registry entry to create, because Chrome discovers hosts through the registry there. To remove the registration later: `mcp-session-bridge --uninstall`. Extension 1.3.0 still accepts this transport as a fallback; it is scheduled for removal in 1.4.

</details>

## Modes

### Auto (recommended)

`T3RNEL_SESSION_MODE=auto` uses the extension when it is connected and falls back to standalone mode otherwise. Add to `claude_desktop_config.json` (or the equivalent file for Cursor, VS Code, Windsurf, Antigravity, IntelliJ, Codex, Grok Build, Kimi Code/Desktop, JCode, Cline, OpenCode, Continue.dev, KiloCode, Roo Code, Aider, OpenClaw, Hermes, OpenFang and any MCP client):

```json
{
  "mcpServers": {
    "t3rnel-session": {
      "command": "npx",
      "args": ["-y", "@t3ratech/mcp-session-bridge"],
      "env": { "T3RNEL_SESSION_MODE": "auto" }
    }
  }
}
```

### Extension mode (Pro required)

Use the user's real, logged-in browser. Activate Pro in the T3rnel Browser extension, then:

```json
{
  "mcpServers": {
    "t3rnel-session": {
      "command": "npx",
      "args": ["-y", "@t3ratech/mcp-session-bridge"],
      "env": { "T3RNEL_SESSION_MODE": "extension" }
    }
  }
}
```

### Standalone mode (free)

Launch and drive a dedicated browser:

```json
{
  "mcpServers": {
    "t3rnel-session": {
      "command": "npx",
      "args": ["-y", "@t3ratech/mcp-session-bridge"],
      "env": {
        "T3RNEL_SESSION_MODE": "standalone",
        "T3RNEL_SESSION_BROWSER": "/usr/bin/brave-browser",
        "T3RNEL_SESSION_HEADLESS": "0"
      }
    }
  }
}
```

### Other clients

Add the same server block to the client's MCP settings (`~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`, VS Code settings, or the equivalent for your client).

## Verify

1. Install the T3rnel Browser extension if you have not: https://browser.t3ratech.co.zw/
2. Restart your MCP client so it spawns the bridge; the extension connects to it within a few seconds of its service worker waking.
3. With AI/MCP automation allowed — the default — pairing is automatic and there is nothing to click. If the approval gate is armed, the side panel shows a one-time **Approve connection** card instead — approve it once and every `session_*` tool is unlocked permanently.
4. Ask the assistant to call `session_health`. A working setup returns extension health; a closed browser fails with a message that names the missing piece and links to the extension install page.

## Environment variables

| Variable | Required | Purpose | Default |
|---|---|---|---|
| `T3RNEL_SESSION_MODE` | no | `auto`, `extension` or `standalone` | `auto` |
| `T3RNEL_SESSION_SOCKET` | no | Override the relay socket path | `~/.t3rnel/session-bridge/bridge.sock` |
| `T3RNEL_SESSION_BROWSER` | no | Browser binary for standalone mode | first known Chrome/Chromium/Brave/Edge path |
| `T3RNEL_SESSION_PROFILE` | no | Profile directory for standalone mode | `~/.t3rnel/session-bridge/browser-profile` |
| `T3RNEL_SESSION_HEADLESS` | no | `1` to run standalone headless | unset (headful) |
| `T3RNEL_SESSION_TIMEOUT_MS` | no | Tool call timeout | 30000 |
| `LICENSE_PUBLIC_KEY_SPKI_B64` | no | Overrides the embedded Ed25519 public key in the server (testing) | embedded default |

## Troubleshooting

- **"T3rnel Browser is not installed or not connected — install it here"** — every error from a tool that genuinely needs the extension carries this hint and the install link. It means the extension is not installed/enabled or has not connected yet; open the browser and give the side panel a moment. If the approval gate is armed, approve the pairing card it shows. Standalone-capable tools never emit it — they work without the extension.
- **"T3rnel Browser is installed but is not currently connected"** — the browser is running but the service worker has not reached the bridge yet; open the side panel once to wake it. If the gate is armed, also check that the pairing was approved — a declined card blocks every call until the next attempt.
- **Timeout errors** — the tab is stuck or the extension is reloading; raise `T3RNEL_SESSION_TIMEOUT_MS` or retry.
- Call `session_install` at any time for the store link and setup steps; it does not require a browser session.

## Tools

- `session_install` — installation instructions for the T3rnel Browser extension and the free standalone mode
- `session_health` — extension health and available browser APIs
- `session_list_tabs` — open tabs with ids, titles, URLs
- `session_navigate` — navigate a tab to a URL
- `session_snapshot` — semantic snapshot with interactive element refs
- `session_read_page` — full page content of an authenticated page
- `session_click` / `session_fill` / `session_type` / `session_press` — trusted input
- `session_evaluate` — run JavaScript in the page context
- `session_screenshot` — visible-area screenshot, PNG or JPEG
- `session_wait` — wait for load, URL, or selector

## Pricing

- The bridge is free. Standalone mode needs no licence and no extension.
- Extension mode needs the T3rnel Browser extension; its Pro tools are gated by that
  extension's Pro tier (one-time, three devices; the extension shows the current WavePay price). There is no separate subscription
  for this package.
