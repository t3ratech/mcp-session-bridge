# MCP Session Bridge — Setup Guide

## What you get

A local MCP server that exposes `session_*` browser-automation tools to any client that speaks the Model Context Protocol — Claude Code and Desktop, Cursor, VS Code, Windsurf, Codex, Cline, Continue.dev, Aider and the rest. In free extension mode the tools run in the user’s own Chrome session, reading authenticated pages without shipping cookies to a cloud browser; Pro tools are gated by the T3rnel Browser extension's own Pro tier. In free standalone mode the server drives its own dedicated CDP browser.

## How it works

```
MCP client (Claude Code / Claude Desktop, Cursor, VS Code, Windsurf, Antigravity, IntelliJ, Codex, Grok Build, Kimi Code/Desktop, JCode, Cline, OpenCode, Continue.dev, KiloCode, Roo Code, Aider, OpenClaw, Hermes, OpenFang and any MCP client)
  │ stdio, newline-delimited JSON-RPC
  ▼
mcp-session-bridge          ← routes to extension relay or standalone CDP browser
  │ local relay socket (~/.t3rnel/session-bridge/bridge.sock, owner-only)
  ▼
mcp-session-bridge-host     ← spawned by Chrome via native messaging
  │
  ▼
T3rnel Browser extension    ← executes the tool against your real, logged-in tabs
```

Nothing leaves the machine: the relay is a Unix domain socket (named pipe on Windows) with owner-only permissions. Pro gating happens inside the closed, shipped extension; the open MCP server only routes the call.

## Prerequisites

- Node.js 20 or newer.
- Chrome, Chromium, Brave or Edge with the **T3rnel Browser** extension installed: https://t3ratech.github.io/t3rnel-browser-plugin/

## Install

```bash
npm install -g @t3ratech/mcp-session-bridge
mcp-session-bridge --install
```

`--install` writes the native-messaging host manifest for Chrome / Chromium / Brave / Edge on Linux and macOS and marks the host executable. On Windows it prints the registry entry to create, because Chrome discovers hosts through the registry there.

To remove the registration later: `mcp-session-bridge --uninstall`.

## Modes

### Auto (recommended)

`T3RNEL_SESSION_MODE=auto` uses the extension when the relay socket is available and falls back to standalone mode otherwise. Add to `claude_desktop_config.json` (or the equivalent file for Cursor, VS Code, Windsurf, Antigravity, IntelliJ, Codex, Grok Build, Kimi Code/Desktop, JCode, Cline, OpenCode, Continue.dev, KiloCode, Roo Code, Aider, OpenClaw, Hermes, OpenFang and any MCP client):

```json
{
  "mcpServers": {
    "t3rnel-session": {
      "command": "mcp-session-bridge",
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
      "command": "mcp-session-bridge",
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
      "command": "mcp-session-bridge",
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

1. Restart Chrome so the extension's service worker opens the native messaging port; that spawns the host and creates the relay socket.
2. Restart your MCP client.
3. Ask the assistant to call `session_health`. A working setup returns extension health; a closed browser fails with a contextual message explaining that the extension is not connected.

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

- **"T3rnel Browser is not installed or not connected"** — the extension is not installed/enabled, or `mcp-session-bridge --install` was never run. Call `session_install` for setup instructions or set `T3RNEL_SESSION_MODE=standalone` for free standalone mode.
- **"T3rnel Browser is installed but is not currently connected"** — Chrome is running but the extension's native messaging port is not open; restart the browser and retry.
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
  extension's Pro tier ($29.99 once, three devices). There is no separate subscription
  for this package.
