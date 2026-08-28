# Changelog — @t3ratech/mcp-session-bridge

All notable changes to the bridge. Newest first.

## 1.1.1 — 2026-08-28

### Fixed

- **`session_snapshot` advertised refs that no tool accepted.** Every element it returns
  carries a `ref`, and the description promises them, but the selector-taking tools
  rejected anything but `selector` — so an agent following the pattern every other browser
  MCP server uses, snapshot then act on a ref, got `Unknown argument: ref` on its first
  action. Refs now resolve against the last snapshot, per tab, and a stale one is refused
  by name. Found by driving the server against a real browser rather than by reading it.
- **The package description claimed a flat "98 tools over stdio".** Measured by running
  the bundle both ways, it is 20 on its own and 99 with the extension relay connected.

### Added

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
