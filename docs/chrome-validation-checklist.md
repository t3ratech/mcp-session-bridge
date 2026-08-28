# Chrome Validation Checklist for MCP Session Bridge

Use this checklist to confirm the bridge works end-to-end in Chrome with an authenticated session.

## 1. Extension

- [ ] Install the [T3rnel Browser](https://t3ratech.github.io/t3rnel-browser-plugin/) extension.
- [ ] Activate Pro in the extension (Settings → Get Pro).
- [ ] Open a tab and log in to a site (e.g. GitHub, Notion, internal dashboard).

## 2. Native host

- [ ] Run `mcp-session-bridge --install`.
- [ ] Verify the manifest exists under the correct browser config directory:
  - Brave: `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.t3rnel.session.json`
  - Chrome: `~/.config/google-chrome/NativeMessagingHosts/com.t3rnel.session.json`
  - Edge: `~/.config/microsoft-edge/NativeMessagingHosts/com.t3rnel.session.json`
- [ ] Restart the browser so the service worker opens the native port.
- [ ] Confirm the relay socket appears: `ls ~/.t3rnel/session-bridge/bridge.sock`.

## 3. MCP server connection

- [ ] Run `mcp-session-bridge` directly (or through an MCP client).
- [ ] Send `initialize` and confirm `serverInfo.name` is `t3rnel-session`.
- [ ] Send `tools/list` and confirm `session_list_tabs`, `session_navigate`, `session_read_page`, `session_login` and `session_store_login` are present.

## 4. Authenticated session test

- [ ] Call `session_list_tabs` and confirm the logged-in tab appears in the list.
- [ ] Call `session_navigate` with the authenticated URL if it is not the active tab.
- [ ] Call `session_read_page` and confirm the returned text contains content only visible to a logged-in user (e.g. "Welcome, <your name>").
- [ ] Call `session_screenshot` and visually confirm the page is the authenticated view.

## 5. Login-assist tool (Pro)

- [ ] Call `session_store_login` with `domain`, `username` and `password` for the test site.
- [ ] Navigate to the site's sign-in page.
- [ ] Call `session_login` with the same `domain` and `submit: true`.
- [ ] Confirm the page transitions to the authenticated dashboard.

## 6. Fallback / standalone mode

- [ ] Close Chrome or remove the relay socket.
- [ ] Set `T3RNEL_SESSION_MODE=standalone` and `T3RNEL_SESSION_BROWSER` to a browser binary.
- [ ] Confirm `session_list_tabs` returns a single `about:blank` tab on first start.
- [ ] Confirm the standalone profile persists under `~/.t3rnel/session-bridge/browser-profile`.
