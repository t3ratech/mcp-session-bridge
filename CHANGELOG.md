# Changelog — @t3ratech/mcp-session-bridge

All notable changes to the bridge. Newest first.

## 1.2.0 — 2026-09-02

### Changed

- **Relicensed under Apache-2.0.** The bridge has always been free to use; it is now free
  to fork, redistribute and build on. The previous licence was source-available custom
  text, which no licence detector recognises — Glama scored the server `F` on licensing
  with "MCP servers without a LICENSE cannot be installed", because a `LicenseRef-`
  identifier reads to tooling as no licence at all. `NOTICE` records what the grant does
  and does not cover: the T3rnel Browser extension the bridge connects to is a separate
  proprietary product, and Apache-2.0 section 6 grants no trademark rights.
- **Every tool description rewritten, and every parameter documented.** Each description
  now says when to reach for that tool rather than restating its name, and no parameter is
  left for the model to guess at. `session_record_events` was the weakest — "Fetch the
  recorded events for a session", with three undocumented arguments — and now explains why
  long recordings are paged rather than returned whole.

### Added

- **`session_close_tab`.** The surface covered the whole browsing lifecycle except
  closing, so an agent could open tabs it had no way to tidy up. Without a `tabId` it
  closes the active tab, which is called out in the description because the active tab is
  usually the one the user is looking at.

### Fixed

- **`session_evaluate` had never worked in standalone mode.** It read `args.expression`
  while its schema declares `code`, and argument validation rejects any property the schema
  does not list — so no caller could ever reach the value. Every standalone evaluation ran
  the literal string `"undefined"` and returned it, which looks enough like a real answer
  that nothing reported a problem.
- **`session_wait` ignored the timeout it was given.** Same mismatch: it read
  `args.timeout` against a schema declaring `timeoutMs`. A caller asking for thirty seconds
  silently got ten, then an error naming a timeout it had never chosen.
- **The standalone tool count was overstated by eight.** The MCPB manifest, the npm
  description and the agent skill each derived "22 tools standalone" from the size of the
  whole surface, but `session_close_tab`, the two vault tools and the five recording tools
  refuse without the extension. The real figure is 14. Tools now carry a
  `requiresExtension` flag, every published count derives from it, and a test checks the
  flag against the standalone implementation rather than trusting it.
- **`session_record_events` advertised the wrong page size.** Its `limit` was documented as
  defaulting to 500 while the recorder applies 100, so a caller who omitted it received a
  short page with no indication the recording was longer. Documented defaults are now
  pinned to the code that applies them.

## 1.1.1 — 2026-08-28

### Fixed

- **The WebSocket handshake failed at random against a perfectly correct server.** The
  `Sec-WebSocket-Accept` value the server echoes was interpolated into a `RegExp` and
  matched against the response head. That value is base64, and base64 uses `+` and `/`,
  both regex metacharacters — so any digest containing one compiled to a pattern that did
  not match the very header it was built from. About 58% of random keys produce such a
  digest, so most connections were refused, and the error blamed the
  `HTTP/1.1 101` status line, which is the success case. The value is now compared
  literally. Found while driving standalone mode against a browser on a virtual display.
- **A browser that would not start reported nothing useful.** Its stderr was discarded, so
  every cause — a missing sandbox, an absent shared library, no display — surfaced as the
  same "exited before exposing a CDP port". The bridge now keeps the tail of stderr and
  names the cause, with the remedy where there is one. The sandbox case is called out
  specifically: Chrome for Testing ships no SUID sandbox helper, and current Ubuntu denies
  the unprivileged user namespaces it would otherwise fall back on, so it cannot start at
  all on an ordinary desktop. The advice is to point `T3RNEL_SESSION_BROWSER` at a
  packaged browser rather than to pass `--no-sandbox`, because this browser renders
  untrusted pages.
- **`session_snapshot` advertised refs that no tool accepted.** Every element it returns
  carries a `ref`, and the description promises them, but the selector-taking tools
  rejected anything but `selector` — so an agent following the pattern every other browser
  MCP server uses, snapshot then act on a ref, got `Unknown argument: ref` on its first
  action. Refs now resolve against the last snapshot, per tab, and a stale one is refused
  by name. Found by driving the server against a real browser rather than by reading it.
- **The package description claimed a flat "98 tools over stdio".** Measured by running
  the bundle both ways, it is 20 on its own and 99 with the extension relay connected.

### Added

- **A virtual display, for research that needs to look like a real browser.**
  `T3RNEL_SESSION_DISPLAY` (or `scripts/virtual-display.sh`, which brings up Xvfb and
  tears it down again) runs the browser headful against an X server with no monitor
  attached.

  This is not a smaller headless. Headless Chrome identifies itself as `HeadlessChrome` in
  the user agent — measured here against Chrome 152, beside the same browser on a virtual
  display reporting plain `Chrome/152` — and it is exactly the shape anti-bot systems
  watch for, so the sites most worth researching are the ones most likely to refuse it. A
  browser on a virtual display is the ordinary browser, with the ordinary profile,
  extension and signed-in sessions. The cost is one Xvfb process.

  A display takes precedence over `headless` when both are set: a caller who has gone to
  the trouble of running an X server does not want the flag that defeats it.

  For completeness on the alternative: loading the extension into a throwaway browser via
  `--load-extension` is no longer possible. On Chrome 152 the flag is accepted and the
  extension is not loaded, and `--disable-features=DisableLoadExtensionCommandLineSwitch`
  no longer restores it. An extension reaches such a browser through enterprise policy or
  not at all.
- **An MCPB bundle and a Smithery stdio release.** `scripts/build-mcpb.mjs` builds it and
  `scripts/publish-smithery.mjs` publishes it; every field is derived from the source it
  describes rather than typed twice. Smithery's URL-publishing path cannot take this
  server — it drives a browser on the user's own machine, so there is nowhere remote to
  point at.
- **A published skill**, `signed-in-browser`, covering when the capability applies, when
  it does not, and what to confirm before acting in a live logged-in browser.

## 1.1.0 — 2026-08-27

- The bridge exposes the extension registry's full 98-tool `session_*` surface and
  reports its installed package version during MCP initialization.
- Extension mode uses an isolated headed-test relay when one is configured, preventing
  manual verification from colliding with a user's normal browser relay.
- Tool definitions derive from the extension registry so the bridge cannot silently
  publish a smaller surface than the installed browser product.

### Fixed

- **`session_install` answers in the shape MCP defines.** It returned a bare object with
  no `content` array, so a spec-compliant client rendered nothing at all — from the one
  tool whose entire job is to explain how to install. It now returns readable steps a
  person can follow, with the machine-readable details alongside them.
- **`server.json` and `package.json` agree on the version.** The registry manifest sat at
  1.0.2 while the package was 1.1.0, so the MCP registry advertised a version that was
  never published.

### Removed

- **`src/license.js`.** The bridge is free and the extension enforces its own Pro tier;
  a licence verifier nothing imported was both dead code in a published package and a
  contradiction of the free positioning.

## 1.0.2 — 2026-08-23

### Fixed

- **The relay returns the JSON-RPC id it was given.** Every request is rewritten to
  `<conn>:<id>` so two MCP servers cannot collide, and the id was rebuilt from that
  string on the way back — a request sent as `7` came back as `"7"`. Correlating a
  response to its request by id is the whole of JSON-RPC, so a client holding its
  outstanding requests in a map keyed by the value it sent never matched the answer. The
  symptom reached the user as a hang with no error. The shipped server survived only
  because it stringifies its own keys; other MCP clients did not.
- **A dropped request now says so.** Once 1024 requests were outstanding the oldest was
  evicted silently, leaving whoever sent it waiting for an answer that could no longer be
  routed. They receive an error and can retry.

### Testing

Sixty-two tests, including a suite written to break the relay: ids that collide across
connections, an id containing the separator the rewrite uses, a frame split across a
hundred chunks, three frames in one chunk, a header claiming four gigabytes, malformed
JSON from one client while another is mid-request, an answer arriving for a client that
has already disconnected, a four-thousand-request flood, and the socket's permissions.

One existing test was found to assert the string `"1"` came back from a request sent as
`1` — pinning the id defect in place rather than catching it.

## 1.0.1 — 2026-08-22

- Native host accepts both the unpacked and Web Store extension ids, so a published
  build can connect.
- A licence with no `product` claim is accepted; the service issues one SKU and sets no
  such field.

## 1.0.0 — 2026-08-21

First release. MCP server that drives an already-signed-in Chrome session through the
T3rnel Browser extension, or a standalone automation browser with no extension and no
licence.
