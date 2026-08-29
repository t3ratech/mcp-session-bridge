---
name: post-to-hacker-news
description: Submit to Hacker News, including Show HN, by driving a signed-in browser. Use when launching a product, tool or MCP server, or when a submission needs its customary author comment. Covers the title rules, when a Show HN is allowed, the url-or-text choice, and how to tell a real submission from a silent failure.
metadata: { "homepage": "https://t3ratech.github.io/t3rnel-browser-plugin/", "mcp": "t3ratech-dev/mcp-session-bridge" }
---

# Submitting to Hacker News

One shot per thing. A submission that goes up before the links work, or with a title that
reads as marketing, is spent — reposting the same URL is treated as a duplicate and gets
nothing. Decide it is ready before opening the form.

Drive it with the `session_*` tools from the T3rnel Session Bridge, in the browser the
operator is signed into. `news.ycombinator.com/submit` shows the form when signed in and a
login page otherwise, so the form's presence is the check.

## Before submitting

- **Every link in it resolves.** A store listing still in review is a 404 to a reader, and
  the front page is not a second chance.
- **Show HN has rules**: it must be something people can try *now*, made by the poster.
  Not a landing page, not a waitlist, not a company announcement. If someone cannot use it
  within a minute of arriving, it is not a Show HN.
- **The title carries no marketing.** No "revolutionary", no superlatives, no exclamation.
  State what the thing is. Under 80 characters; HN silently rewrites long or hyped titles,
  and its rewrite is usually worse than a careful one.

## The form

Four controls, none of them labelled — address them by name:

| Selector | Holds |
|---|---|
| `input[name=title]` | the title, ≤ 80 characters |
| `input[name=url]` | the link |
| `textarea[name=text]` | body text |
| `input[type=submit]` | submit |

**`url` and `text` are exclusive.** Fill one. For anything with a repository or a live
page, use `url` and put the explanation in the first comment. Use `text` only for a
question or discussion with nothing to link.

```
session_navigate  → https://news.ycombinator.com/submit
session_snapshot  → confirm the form is there, which confirms the session is signed in
session_fill      → input[name=title], then input[name=url]
session_snapshot  → read the values back before submitting
session_click     → input[type=submit]
```

**A successful submission redirects to `/newest`.** Still being on `/submit` means it did
not go — re-snapshot and read `problem` on the fields, then screenshot if that is empty.

## The first comment

Post one immediately. On Show HN it is expected, and without it the thread starts with no
context and usually stays empty.

Find the item id, then comment on `item?id=<id>`:

```bash
curl -s "https://hn.algolia.com/api/v1/search_by_date?query=<words>&tags=story"
```

Indexing takes a minute or two; the story is also visible on `/newest` immediately.

What the comment should carry, in this order:

1. **The premise** — the problem, in one paragraph, without selling.
2. **How it works** — enough that a reader can judge it without installing.
3. **What you would want to know if you were reading it** — the limitations, the licensing,
   the security posture. Volunteering these is what separates a Show HN that gets a
   technical discussion from one that gets picked apart.
4. **What is not done.** Naming the gaps yourself is read as confidence. Having them found
   is read as spin.

Do not thank people in advance, do not ask for upvotes, and do not describe the thing as
solving a problem nobody stated.

## After posting

Record the item URL. Answer replies quickly and plainly for the first few hours — that is
the whole value of the channel, and an unattended Show HN is worse than none.
