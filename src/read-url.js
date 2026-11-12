/**
 * session_read_url — a public page as Markdown, without opening a tab.
 *
 * Asks for `text/markdown` first, because a site that serves it has already done the
 * conversion and a model reads it at a fraction of the tokens of the page's HTML; a site
 * that does not is answered with its HTML converted here. This reads what a signed-out
 * visitor gets. A page behind a login belongs to session_navigate and session_dom_compress,
 * which run in the user's own session.
 *
 * Because the address comes from a model that may have read it in a hostile page, the
 * fetch is the dangerous part. Only http(s) is spoken; the address a name resolves to is
 * checked at connect time — not before, which a rebinding DNS answer defeats — and refused
 * when it is loopback, private, link-local, carrier-grade NAT, multicast or reserved; and
 * every redirect is a new request through the same check.
 */
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";

export const READ_URL_MAX_BYTES = 2_000_000;
export const READ_URL_DEFAULT_CHARS = 30_000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20_000;

/** True only for an address that is on the public internet. */
export function isPublicAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && address.split(".")[2] === "0") return false; // IETF protocol assignments
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a >= 224) return false; // multicast, reserved, broadcast
    return true;
  }
  if (net.isIPv6(address)) {
    const lower = address.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
      const hi = parseInt(hexMapped[1], 16);
      const lo = parseInt(hexMapped[2], 16);
      return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const first = parseInt(lower.split(":")[0] || "0", 16);
    if ((first & 0xff00) === 0) return false; // ::/8 — unspecified, loopback, IPv4-compatible
    if ((first & 0xfe00) === 0xfc00) return false; // unique local
    if ((first & 0xffc0) === 0xfe80) return false; // link-local
    if ((first & 0xff00) === 0xff00) return false; // multicast
    return true;
  }
  return false;
}

function parseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error(`session_read_url: "${raw}" is not an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`session_read_url: only http and https URLs can be read, received ${url.protocol.replace(":", "")}`);
  }
  if (url.username || url.password) {
    throw new Error("session_read_url: a URL carrying a username or password is refused; sign in with session_navigate instead");
  }
  return url;
}

/** A `lookup` for http(s).request that refuses any address the policy rejects. */
export function guardedLookup(policy, host) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
      if (error) return callback(error);
      const bad = addresses.find((entry) => !policy(entry.address));
      if (bad) {
        return callback(new Error(`session_read_url: ${host} resolves to ${bad.address}, which is not a public address; refusing to fetch it`));
      }
      if (options?.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function fetchOnce(url, { policy, accept, timeoutMs }) {
  return new Promise((resolve, reject) => {
    // Node never calls `lookup` for an address that is already a literal, so a literal is
    // judged here; a name is judged by the lookup, at connect time.
    const literal = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(literal) && !policy(literal)) {
      reject(new Error(`session_read_url: ${url.hostname} is not a public address; refusing to fetch it`));
      return;
    }
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      {
        method: "GET",
        headers: { Accept: accept, "Accept-Encoding": "identity", "User-Agent": "t3rnel-session-bridge (read_url)" },
        lookup: guardedLookup(policy, url.hostname),
        agent: false, // one connection per request; nothing is held open after the answer
        timeout: timeoutMs,
      },
      (response) => {
        const status = response.statusCode;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          resolve({ redirect: new URL(response.headers.location, url).href, status });
          return;
        }
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > READ_URL_MAX_BYTES) {
            request.destroy(new Error(`session_read_url: ${url.href} is larger than ${READ_URL_MAX_BYTES} bytes; refusing to read it`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve({ status, contentType: String(response.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", reject);
      }
    );
    request.on("timeout", () => request.destroy(new Error(`session_read_url: ${url.href} did not answer within ${timeoutMs / 1000}s`)));
    request.on("error", reject);
    request.end();
  });
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };
const decode = (text) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

const DROP_BLOCKS = /<(script|style|noscript|template|svg|iframe|head|nav|footer|aside|form|select|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK = new Set(["p", "div", "section", "article", "main", "header", "ul", "ol", "table", "blockquote", "pre", "figure", "dl", "li", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "br"]);

function attr(attrs, name) {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? decode(match[2] ?? match[3] ?? match[4]) : "";
}

/** The page's HTML as Markdown: headings, paragraphs, links, lists, code, quotes and tables. */
export function pageTitle(html) {
  const match = String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  return match ? decode(match[1]).replace(/\s+/g, " ").trim() : "";
}

export function htmlToMarkdown(html, baseUrl) {
  let source = String(html).replace(/<!--[\s\S]*?-->|<![^>]*>|<\?[^>]*>/g, "");
  const body = source.match(/<(main|article)\b[^>]*>([\s\S]*)<\/\1\s*>/i);
  source = body ? body[2] : source;
  // Dropping blocks can expose another of the same kind inside; a few passes settle it.
  for (let pass = 0; pass < 3; pass++) source = source.replace(DROP_BLOCKS, "");

  const out = [];
  const lists = [];
  const links = [];
  let inPre = false;
  let row = { cells: 0, header: false };
  let headed = false;
  const push = (text) => out.push(text);
  const breakBlock = () => push("\n\n");

  const token = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+|<)/g;
  for (const match of source.matchAll(token)) {
    const [, closing, rawTag, attrs, text] = match;
    if (text !== undefined) {
      const decoded = decode(text);
      push(inPre ? decoded : decoded.replace(/\s+/g, " "));
      continue;
    }
    const tag = rawTag.toLowerCase();
    const closes = closing === "/";
    if (/^h[1-6]$/.test(tag)) {
      breakBlock();
      if (!closes) push(`${"#".repeat(Number(tag[1]))} `);
    } else if (tag === "a") {
      if (!closes) {
        const href = attr(attrs, "href");
        let target = "";
        if (href && !/^(javascript:|#)/i.test(href)) {
          try { target = new URL(href, baseUrl).href; } catch { target = ""; }
        }
        links.push({ target, at: out.length });
        push("");
      } else {
        const link = links.pop();
        if (link?.target) {
          const label = out.splice(link.at).join("").trim();
          push(label ? `[${label}](${link.target})` : "");
        }
      }
    } else if (tag === "img" && !closes) {
      const alt = attr(attrs, "alt").trim();
      const src = attr(attrs, "src");
      if (alt && src && !src.startsWith("data:")) {
        try { push(`![${alt}](${new URL(src, baseUrl).href})`); } catch { push(alt); }
      }
    } else if (tag === "ul" || tag === "ol") {
      if (closes) lists.pop(); else lists.push({ ordered: tag === "ol", n: 0 });
      if (lists.length === 0 || (lists.length === 1 && !closes)) breakBlock();
    } else if (tag === "li") {
      if (!closes) {
        const list = lists[lists.length - 1];
        const depth = Math.max(lists.length - 1, 0);
        if (list) list.n += 1;
        push(`\n${"  ".repeat(depth)}${list?.ordered ? `${list.n}.` : "-"} `);
      }
    } else if (tag === "pre") {
      inPre = !closes;
      push(closes ? "\n```\n\n" : "\n\n```\n");
    } else if (tag === "code") {
      if (!inPre) push("`");
    } else if (tag === "strong" || tag === "b") {
      push("**");
    } else if (tag === "em" || tag === "i") {
      push("*");
    } else if (tag === "blockquote") {
      breakBlock();
      if (!closes) push("> ");
    } else if (tag === "tr") {
      if (!closes) {
        row = { cells: 0, header: false };
        push("\n");
      } else {
        push("|");
        if (row.header && !headed) push(`\n|${" --- |".repeat(row.cells)}`);
        headed = true;
      }
    } else if (tag === "td" || tag === "th") {
      if (!closes) {
        row.cells += 1;
        row.header ||= tag === "th";
      }
      push(closes ? " " : "| ");
    } else if (tag === "table") {
      headed = false;
      breakBlock();
    } else if (tag === "hr") {
      push("\n\n---\n\n");
    } else if (tag === "br") {
      push("\n");
    } else if (BLOCK.has(tag)) {
      breakBlock();
    }
  }

  return out
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\*\*\s*\*\*/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The `#` headings of a Markdown document, ignoring those inside code fences. */
function headings(markdown) {
  const found = [];
  let fenced = false;
  markdown.split("\n").forEach((line, index) => {
    if (/^```/.test(line)) fenced = !fenced;
    const match = !fenced && line.match(/^(#{1,6})\s+(.*)$/);
    if (match) found.push({ level: match[1].length, title: match[2].trim(), line: index });
  });
  return found;
}

export function outlineOf(markdown) {
  return headings(markdown).map((h) => `${"  ".repeat(h.level - 1)}- ${h.title}`).join("\n");
}

/** Only the sections whose heading contains `needle`, each running to the next heading of its level or above. */
export function sectionsMatching(markdown, needle) {
  const lines = markdown.split("\n");
  const all = headings(markdown);
  const wanted = String(needle).toLowerCase();
  const picked = [];
  for (const [index, heading] of all.entries()) {
    if (!heading.title.toLowerCase().includes(wanted)) continue;
    const next = all.slice(index + 1).find((h) => h.level <= heading.level);
    picked.push(lines.slice(heading.line, next ? next.line : lines.length).join("\n").trim());
  }
  return picked.join("\n\n");
}

/**
 * Reads `url` as Markdown. `llmsTxt` reads the site's /llms.txt instead — the index a site
 * publishes for models, when it has one. `outline` returns only the headings; `filter` only
 * the sections whose heading contains the text.
 */
export async function readUrl(args, { addressPolicy = isPublicAddress, timeoutMs = TIMEOUT_MS } = {}) {
  let url = parseUrl(args.url);
  if (args.llmsTxt) url = new URL("/llms.txt", url.origin);
  const maxChars = args.maxChars ?? READ_URL_DEFAULT_CHARS;
  const accept = "text/markdown, text/plain;q=0.8, text/html;q=0.5, application/xhtml+xml;q=0.5";

  let answer;
  for (let hops = 0; ; hops++) {
    answer = await fetchOnce(url, { policy: addressPolicy, accept, timeoutMs });
    if (!answer.redirect) break;
    if (hops >= MAX_REDIRECTS) throw new Error(`session_read_url: ${args.url} redirected more than ${MAX_REDIRECTS} times`);
    url = parseUrl(answer.redirect);
  }
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`session_read_url: ${url.href} answered HTTP ${answer.status}`);
  }

  const type = answer.contentType.split(";")[0].trim().toLowerCase();
  let markdown;
  let source;
  let title = "";
  if (type === "text/markdown" || type === "text/x-markdown") {
    markdown = answer.body;
    source = "served as markdown";
  } else if (type === "text/html" || type === "application/xhtml+xml") {
    markdown = htmlToMarkdown(answer.body, url.href);
    title = pageTitle(answer.body);
    source = "converted from html";
  } else if (type.startsWith("text/") || type === "application/json" || type.endsWith("+json")) {
    markdown = answer.body;
    source = `served as ${type}`;
  } else {
    throw new Error(`session_read_url: ${url.href} is ${type || "of unknown type"}, which is not text; use session_navigate to open it`);
  }

  let body = markdown;
  if (args.outline) body = outlineOf(markdown) || "(no headings)";
  else if (args.filter) body = sectionsMatching(markdown, args.filter) || `(no section heading contains "${args.filter}")`;

  const truncated = body.length > maxChars;
  if (truncated) body = body.slice(0, maxChars);
  const header = `url: ${url.href}\n${title ? `title: ${title}\n` : ""}source: ${source}\nchars: ${markdown.length}${truncated ? `\ntruncated: showing the first ${maxChars}; pass filter, outline or a larger maxChars` : ""}`;
  return `${header}\n\n${body}`;
}
