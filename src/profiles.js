/**
 * Tool profiles.
 *
 * Every MCP client reads the whole `tools/list` into the model's context before the first question. The extension
 * publishes 97 tools, about 61,000 characters of definitions (roughly 15,000 tokens) per session. A profile lists
 * only the tools a session needs; a tool that is not listed is still callable by name.
 *
 *   core      the everyday verbs: navigate, read, snapshot, click, fill, type, screenshot, tabs, evaluate
 *   network   network and console capture
 *   design    CSS, colour, inspection, full-page capture, visual diffs, React, PDF, Markdown
 *   test      recording, codegen, shadow tests, time travel
 *   vault     the encrypted vault, the agent firewall, licensing
 *   page      everything else, and the home of any tool added later
 *
 * Classification is by name so a tool the extension adds tomorrow lands somewhere without a release here.
 */

export const PROFILE_NAMES = ["core", "network", "design", "test", "vault", "page"];

const CORE = new Set([
  "health", "list_tabs", "switch_tab", "close_tab", "navigate", "back", "forward", "reload", "wait", "read_page",
  "snapshot", "click", "fill", "type", "press", "select", "scroll", "hover", "screenshot", "evaluate", "install",
  "login", "store_login", "read_url",
]);

/** First match wins; anything that matches none is `page`. */
const RULES = [
  ["network", /^(network|console)_/],
  ["test", /^(record|codegen|shadow|timetravel)_/],
  ["vault", /^(vault|firewall|license)_/],
  ["design", /^(css_|inspect_|color_|screenshot_|fullpage_capture$|visual_|react_|viewport_set$|pdf$|md_)/],
];

export function toolProfile(name) {
  const bare = String(name).replace(/^session_/, "");
  if (CORE.has(bare)) return "core";
  for (const [profile, pattern] of RULES) if (pattern.test(bare)) return profile;
  return "page";
}

/**
 * `null` means every tool. Otherwise the set of profiles to list, always including core: a session without
 * navigate and click cannot do anything, so leaving it out could only be a mistake.
 */
export function parseToolProfiles(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text || text === "all") return null;
  const wanted = text.split(",").map((part) => part.trim()).filter(Boolean);
  if (wanted.includes("all")) throw new Error(`T3RNEL_SESSION_TOOLS: "all" cannot be combined with other profiles (got ${wanted.join(", ")})`);
  for (const name of wanted) {
    if (!PROFILE_NAMES.includes(name)) {
      throw new Error(`T3RNEL_SESSION_TOOLS: unknown tool profile "${name}"; use all, or any of ${PROFILE_NAMES.join(", ")}`);
    }
  }
  return new Set(["core", ...wanted]);
}

export function filterByProfiles(tools, profiles) {
  return profiles === null ? tools : tools.filter((tool) => profiles.has(toolProfile(tool.name)));
}
