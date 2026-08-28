---
name: publish-mcp-server
description: List an MCP server on the public directories — Smithery, Glama, mcpservers.org and awesome-mcp-servers — by driving a signed-in browser. Use when a new MCP server is ready to announce, when an existing listing needs updating after a release, or when a directory submission was filled in and did not go through. Covers the per-site field limits, the required controls that are easy to miss, and the paid options to leave alone.
metadata: { "homepage": "https://t3ratech.github.io/t3rnel-browser-plugin/", "mcp": "t3ratech-dev/mcp-session-bridge" }
---

# Listing an MCP server on the public directories

Each directory has its own form, its own limits, and at least one control that is easy to
miss. Everything below was learned by submitting to it, including the mistakes.

Use the `session_*` tools from the **T3rnel Session Bridge**, in the browser the operator
is already signed into. Most of these directories need an account, and several give no
visible error without one.

## The rule that costs the most time

**A filled form is not a submission.** After clicking submit, check what actually
happened, in this order:

1. **Re-snapshot.** If the form's fields are gone, it submitted. If they are still there
   holding your values, it did not.
2. **Look for `problem` on any field.** `session_snapshot` reports `invalid`, `problem`,
   `maxLength` and `required`. `problem` carries the page's own message — *"Description
   must be at most 400 characters"* — from `aria-errormessage`, `aria-describedby`, or the
   browser's validation message.
3. **Check every control, not just the text inputs.** A required `<select>` shows as
   `role: combobox, tag: select`. Filtering a snapshot to `input` and `textarea` hides it,
   and the form then fails for a reason that was on screen the whole time.
4. **If it is still unclear, `session_screenshot` and read the page.** Do not infer. Twice
   this was concluded to be "probably needs a login" when the answer was a character limit
   and an unselected dropdown.

**Never tick a paid option.** Several of these forms offer expedited review for money, and
at least one renders it beside the free submit. A checkbox's `value` is `"on"` whether or
not it is ticked — read `checked`, which the snapshot reports, and leave paid tiers alone
unless the operator has said otherwise in this session.

## Smithery — <https://smithery.ai>

The web form at `smithery.ai/servers/new` takes **an HTTPS URL only**. A stdio server has
no such URL, so that form cannot list one. Publish the bundle instead:

```bash
node scripts/build-mcpb.mjs                       # a zip with manifest.json at its root
smithery mcp publish ./build/<name>-<v>.mcpb -n <namespace>/<slug>
```

- The manifest's `tools` array needs each tool's **`inputSchema`**, not just a name and
  description. MCPB's own spec shows only the latter; Smithery builds its server card from
  it and rejects the release with one "expected object, received undefined" per tool.
- The **CLI creates the server record**; the API cannot. `PUT /servers/{name}/releases`
  answers 404 until the record exists.
- **Display name, description, homepage and repository are UI-only.** The release payload
  does not set them, and a listing with the slug as its name and no description is close to
  undiscoverable. Set them at `/servers/<ns>/<slug>/settings`, then reload the page and read
  the values back — the registry API caches and will show the old ones for a while.
- The icon has its own endpoint, and the field name is `icon`:
  `PUT /servers/{name}/icon` as multipart.

## Glama — <https://glama.ai>

- **There is no `/submit` page.** `glama.ai/mcp/servers/submit` is parsed as a *search* for
  `author:submit`, returns HTTP 200, and looks like a working URL. Use the **Add Server**
  button on `glama.ai/mcp/servers`.
- Three fields: Name, Description, GitHub Repository URL. Then "Submit for Review".
- **Description must be at most 400 characters.** Nothing says so until you submit.
- `glama.json` in the repository supplies the rest of the metadata. The API is read-only —
  `POST` 404s — so this is browser-only.

## mcpservers.org — <https://mcpservers.org/submit>

- Fields: name, one-sentence description, GitHub URL, email, **and a required category
  `<select>`**. The select is the one that gets missed.
- Choose the category with `session_select` (`selector` plus `text`, `value` or `index`).
- There is a **Premium Submit — $39** checkbox beside the free submit. Leave it unticked;
  the form submits fine without it.

## awesome-mcp-servers — GitHub PR

```bash
gh repo clone punkpeye/awesome-mcp-servers /tmp/amcp -- --depth=1
# edit README.md, then:
gh repo fork --remote=false --clone=false
git push "https://github.com/<you>/awesome-mcp-servers.git" <branch>
gh pr create --repo punkpeye/awesome-mcp-servers --head <you>:<branch> --base main ...
```

- **Alphabetical order within the category**, by the `owner/repo` in the link text.
- Their CONTRIBUTING invites agent PRs: put `🤖🤖🤖` at the end of the title to opt into
  the fast-track.
- Use the legend honestly — 📇 TypeScript/JavaScript, 🐍 Python, 🏠 local, ☁️ cloud,
  🍎 🪟 🐧 for platforms. Claim a platform only if the install path really works there.

## What to link to

**Link to the server's source repository, not to a marketing site.** Every one of these
directories exists to point a reader at code. A documentation or product-site repo sends
them to a website, which is the single most common reason a listing is rejected or
quietly ignored.

If the server is closed source, say so in the description and link the package instead —
do not link a website and hope.

## Sites deliberately not covered

- **mcp.so** — its free path opens a *support ticket*, not a listing; the confirmation
  reads "Ticket submitted" and nothing is listed. Its actual submit path is "Pay and submit
  automatically", which is a paid flow. Do not use either without explicit instruction.

## After submitting

Record what actually happened, per site: **live** (a public page was fetched and shows
it), **submitted / in review**, or **not submitted**. Most of these queue for human review,
so absence from a search minutes later is expected and is not evidence of failure — the
form closing is.
