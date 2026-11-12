/**
 * session_read_url: a public page as Markdown. The fetch is the dangerous part — the address
 * comes from a model that may have read it in a hostile page — so most of what is checked here
 * is what it refuses, against a real loopback server (the default policy must refuse that very
 * server) and then, with the policy lifted for the test only, what it reads.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUrl, guardedLookup, pageTitle, htmlToMarkdown, outlineOf, sectionsMatching, isPublicAddress, READ_URL_MAX_BYTES } from "../src/read-url.js";

const open = { addressPolicy: () => true };
let server;
let base;
const hits = [];

before(async () => {
  server = http.createServer((req, res) => {
    hits.push({ url: req.url, accept: req.headers.accept, agent: req.headers["user-agent"] });
    const send = (status, type, body, extra = {}) => { res.writeHead(status, { "content-type": type, ...extra }); res.end(body); };
    if (req.url === "/md") return send(200, "text/markdown; charset=utf-8", "# Title\n\nHello\n\n## Setup\n\nRun it.\n\n### Detail\n\nMore.\n\n## Other\n\nElsewhere.\n");
    if (req.url === "/html") return send(200, "text/html", "<!doctype html><html><head><title>x</title></head><body><nav>menu</nav><h1>Hi &amp; welcome</h1><p>One <a href='/a'>link</a>.</p></body></html>");
    if (req.url === "/txt") return send(200, "text/plain", "plain words");
    if (req.url === "/json") return send(200, "application/json", '{"a":1}');
    if (req.url === "/png") return send(200, "image/png", "x");
    if (req.url === "/none") { res.writeHead(200); res.end("x"); return undefined; }
    if (req.url === "/missing") return send(404, "text/plain", "no");
    if (req.url === "/r1") return send(302, "text/plain", "", { location: "/md" });
    if (req.url === "/loop") return send(302, "text/plain", "", { location: "/loop" });
    if (req.url === "/to-file") return send(302, "text/plain", "", { location: "file:///etc/passwd" });
    if (req.url === "/huge") return send(200, "text/plain", "x".repeat(READ_URL_MAX_BYTES + 10));
    if (req.url === "/slow") return undefined;
    if (req.url === "/llms.txt") return send(200, "text/plain", "# Site\n\n- [Docs](/docs)\n");
    if (req.url === "/long") return send(200, "text/markdown", `# Long\n\n${"word ".repeat(100)}`);
    return send(200, "text/markdown", "# Root\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections(); server.close(); });

describe("what it refuses", () => {
  it("never connects to a loopback address under the default policy, even when the name looks public", async () => {
    const before = hits.length;
    await assert.rejects(readUrl({ url: `${base}/md` }), /resolves to 127\.0\.0\.1, which is not a public address|not a public address/);
    await assert.rejects(readUrl({ url: `http://localhost:${server.address().port}/md` }), /not a public address/);
    assert.equal(hits.length, before, "the server was reached");
  });

  it("classifies addresses: public ones pass; private, loopback, link-local, CGNAT, multicast and mapped forms do not", () => {
    for (const ok of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8", "::ffff:808:808", "172.32.0.1", "100.63.0.1", "100.128.0.1"]) assert.equal(isPublicAddress(ok), true, ok);
    for (const bad of ["0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "100.127.255.255", "198.18.0.1", "198.19.255.255", "::2", "::ffff:0:0", "224.0.0.1", "255.255.255.255", "192.0.0.1", "::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "not an address", ""]) assert.equal(isPublicAddress(bad), false, bad);
  });

  it("judges the address a name resolves to, in both the single and the all-addresses form", async () => {
    const answer = (policy, options) => new Promise((resolve) => guardedLookup(policy, "x.test")("localhost", options, (error, ...rest) => resolve({ error, rest })));
    const refused = await answer(() => false, { all: false });
    assert.match(refused.error.message, /x\.test resolves to .*, which is not a public address/);
    const single = await answer(() => true, { all: false });
    assert.equal(single.error, null);
    assert.equal(typeof single.rest[0], "string");
    assert.ok([4, 6].includes(single.rest[1]));
    const many = await answer(() => true, { all: true });
    assert.ok(Array.isArray(many.rest[0]) && many.rest[0].length > 0);
  });

  it("refuses an https server whose certificate is not trusted, rather than reading it anyway", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3rnel-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
    const secure = https.createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (req, res) => res.end("secret"));
    await new Promise((resolve) => secure.listen(0, "127.0.0.1", resolve));
    try {
      await assert.rejects(readUrl({ url: `https://127.0.0.1:${secure.address().port}/` }, open), /self[- ]signed|certificate/i);
    } finally {
      secure.closeAllConnections();
      secure.close();
    }
  });

  it("refuses other schemes, relative URLs, and credentials in the URL, by name", async () => {
    await assert.rejects(readUrl({ url: "file:///etc/passwd" }), /only http and https URLs can be read, received file/);
    await assert.rejects(readUrl({ url: "ftp://example.com/x" }), /received ftp/);
    await assert.rejects(readUrl({ url: "/relative" }), /"\/relative" is not an absolute URL/);
    await assert.rejects(readUrl({ url: "https://user:pw@example.com/" }), /username or password is refused/);
    await assert.rejects(readUrl({ url: "https://user@example.com/" }), /username or password is refused/);
  });

  it("refuses a redirect to a non-http scheme and a redirect loop", async () => {
    await assert.rejects(readUrl({ url: `${base}/to-file` }, open), /only http and https/);
    await assert.rejects(readUrl({ url: `${base}/loop` }, open), /redirected more than 5 times/);
  });

  it("re-checks the address on every redirect hop", async () => {
    const seen = [];
    const policy = (address) => { seen.push(address); return true; };
    await readUrl({ url: `${base}/r1` }, { addressPolicy: policy });
    assert.ok(seen.length >= 2, `policy consulted ${seen.length} time(s) for two requests`);
  });

  it("refuses a non-success status, a binary body, an untyped body, an oversized body and a silent server", async () => {
    await assert.rejects(readUrl({ url: `${base}/missing` }, open), /answered HTTP 404/);
    await assert.rejects(readUrl({ url: `${base}/png` }, open), /is image\/png, which is not text/);
    await assert.rejects(readUrl({ url: `${base}/none` }, open), /is of unknown type, which is not text/);
    await assert.rejects(readUrl({ url: `${base}/huge` }, open), /larger than 2000000 bytes/);
    await assert.rejects(readUrl({ url: `${base}/slow` }, { ...open, timeoutMs: 150 }), /did not answer within 0\.15s/);
  });

  it("names an unresolvable host rather than hanging", async () => {
    await assert.rejects(readUrl({ url: "http://no-such-host.invalid/" }, open), /ENOTFOUND|EAI_AGAIN/);
  });
});

describe("what it reads", () => {
  it("asks for markdown first and returns a page that serves it untouched", async () => {
    const text = await readUrl({ url: `${base}/md` }, open);
    assert.match(text, /^url: http:\/\/127\.0\.0\.1:\d+\/md\nsource: served as markdown\nchars: \d+\n\n# Title/);
    const hit = hits.filter((h) => h.url === "/md").pop();
    assert.match(hit.accept, /^text\/markdown/);
    assert.doesNotMatch(hit.agent, /Mozilla|Chrome/);
  });

  it("converts HTML when the site serves no markdown, dropping navigation and keeping links absolute", async () => {
    const text = await readUrl({ url: `${base}/html` }, open);
    assert.match(text, /^url: .*\ntitle: x\nsource: converted from html/);
    assert.doesNotMatch(text, /doctype/i);
    assert.match(text, /# Hi & welcome/);
    assert.match(text, new RegExp(`One \\[link\\]\\(${base.replace(/[.]/g, "\\.")}/a\\)\\.`));
    assert.doesNotMatch(text, /menu/);
  });

  it("passes plain text and JSON through, saying what they were", async () => {
    assert.match(await readUrl({ url: `${base}/txt` }, open), /source: served as text\/plain\n.*\n\nplain words$/s);
    assert.match(await readUrl({ url: `${base}/json` }, open), /source: served as application\/json[\s\S]*\{"a":1\}$/);
  });

  it("follows a redirect to the page it names", async () => {
    assert.match(await readUrl({ url: `${base}/r1` }, open), /url: .*\/md\n[\s\S]*# Title/);
  });

  it("reads the site's llms.txt instead when asked", async () => {
    const text = await readUrl({ url: `${base}/some/deep/page`, llmsTxt: true }, open);
    assert.match(text, /url: .*\/llms\.txt/);
    assert.match(text, /\[Docs\]\(\/docs\)/);
  });

  it("returns only the outline, or only the sections whose heading matches", async () => {
    const outline = await readUrl({ url: `${base}/md`, outline: true }, open);
    assert.match(outline, /\n- Title\n {2}- Setup\n {4}- Detail\n {2}- Other$/);
    const filtered = await readUrl({ url: `${base}/md`, filter: "setup" }, open);
    assert.match(filtered, /## Setup[\s\S]*Run it\.[\s\S]*### Detail[\s\S]*More\.$/);
    assert.doesNotMatch(filtered, /Elsewhere/);
    assert.match(await readUrl({ url: `${base}/md`, filter: "other" }, open), /## Other\n\nElsewhere\.$/);
    assert.match(await readUrl({ url: `${base}/md`, filter: "nothing" }, open), /\(no section heading contains "nothing"\)$/);
    assert.match(await readUrl({ url: `${base}/txt`, outline: true }, open), /\(no headings\)$/);
  });

  it("truncates to maxChars and says how to get the rest", async () => {
    const text = await readUrl({ url: `${base}/long`, maxChars: 50 }, open);
    assert.match(text, /truncated: showing the first 50; pass filter, outline or a larger maxChars/);
    assert.ok(text.split("\n\n").slice(1).join("\n\n").length <= 50);
    assert.doesNotMatch(await readUrl({ url: `${base}/long` }, open), /truncated/);
  });
});

describe("htmlToMarkdown", () => {
  const md = (html) => htmlToMarkdown(html, "https://site.test/dir/page");

  it("keeps headings, emphasis, lists, quotes, code, rules and tables", () => {
    const out = md(`<h2>Head</h2><p>a <strong>bold</strong> and <em>it</em> and <code>x()</code></p>
      <ul><li>one</li><li>two<ul><li>deep</li></ul></li></ul><ol><li>first</li><li>second</li></ol>
      <blockquote>said</blockquote><pre>line 1\n  line 2</pre><hr>
      <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$5</td></tr></table>`);
    assert.match(out, /## Head/);
    assert.match(out, /a \*\*bold\*\* and \*it\* and `x\(\)`/);
    assert.match(out, /- one\n- two\n {2}- deep/);
    assert.match(out, /1\. first\n2\. second/);
    assert.match(out, /> said/);
    assert.match(out, /```\nline 1\n {2}line 2\n```/);
    assert.match(out, /---/);
    assert.match(out, /\| Plan \| Price \|\n\| --- \| --- \|\n\| Pro \| \$5 \|/);
  });

  it("resolves relative links and images, and drops scripts, styles, forms, javascript: and fragment links", () => {
    const out = md(`<script>alert(1)</script><style>p{}</style><form><p>login</p></form>
      <p><a href="../up">up</a> <a href="javascript:void(0)">js</a> <a href="#frag">frag</a> <a>bare</a> <a href="https://[bad">odd</a>
      <img src="/i.png" alt="logo"> <img src="data:image/png;base64,AA" alt="inline"> <img src="/j.png"> <img src="http://[bad" alt="broken"></p>`);
    assert.match(out, /\[up\]\(https:\/\/site\.test\/up\)/);
    assert.match(out, /!\[logo\]\(https:\/\/site\.test\/i\.png\)/);
    assert.match(out, / js frag bare odd /);
    assert.match(md('<p>a<a href=/plain>unquoted</a><a href="/empty"></a>b<br>c</p>'), /a\[unquoted\]\(https:\/\/site\.test\/plain\)b\nc/);
    assert.doesNotMatch(out, /alert|p\{\}|login|inline|j\.png/);
    assert.match(out, /broken/);
  });

  it("prefers the main or article element and decodes entities", () => {
    assert.equal(md("<div>chrome</div><main><p>&lt;x&gt; &#65; &#x42; &copy; &unknown; &#0;</p></main><div>more chrome</div>"), "<x> A B © &unknown; &#0;");
    assert.equal(md("<article><p>only</p></article>"), "only");
  });

  it("treats a stray angle bracket as text, and removes empty emphasis", () => {
    assert.equal(md("<p>1 < 2 <b></b>ok</p>"), "1 < 2 ok");
  });
});

describe("outline and sections", () => {
  it("ignore # lines inside code fences", () => {
    const doc = "# Real\n\n```\n# not a heading\n```\n\n## Next\n";
    assert.equal(outlineOf(doc), "- Real\n  - Next");
    assert.equal(sectionsMatching(doc, "heading"), "");
  });
});

describe("pageTitle", () => {
  it("reads the title, collapsing whitespace and decoding entities, and is empty when there is none", () => {
    assert.equal(pageTitle("<head><title>\n  Tom &amp;  Jerry \n</title></head>"), "Tom & Jerry");
    assert.equal(pageTitle("<p>no title</p>"), "");
  });
});
