/**
 * The tool surface. Names are `session_*` on the outside and map onto the T3rnel
 * Browser extension's `browser_*` tools on the inside; the extension executes them
 * against the user's own already-signed-in tabs.
 *
 * The bridge itself is free and holds no licence of its own. Where a tool is part of
 * the extension's Pro tier, the extension is the thing that says so — the refusal
 * comes back through the relay unchanged, so there is one gate rather than two that
 * can disagree.
 */

export const SUPPORTED_MCP_CLIENTS =
  "Claude Code/Desktop, Cursor, VS Code, Windsurf, Antigravity, IntelliJ, Codex, Grok Build, Kimi Code/Desktop, JCode, Cline, OpenCode, Continue.dev, KiloCode, Roo Code, Aider, OpenClaw, Hermes, OpenFang and any MCP client";

export const TOOL_DEFINITIONS = [
  {
    name: "session_install",
    description: "Return installation instructions for the T3rnel Browser extension and the free standalone automation browser. Does not require an active browser session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "session_health",
    description: "Check extension health and which browser APIs are available in the connected session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "session_list_tabs",
    description: "List all open browser tabs with their ids, titles and URLs.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "session_navigate",
    description: "Navigate a tab to a URL in the user's authenticated session. Reuses the active tab unless newTab is true.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Absolute URL to navigate to" },
        tabId: { type: "integer", description: "Tab id from session_list_tabs" },
        newTab: { type: "boolean", description: "Open in a new tab instead of reusing the active tab" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_snapshot",
    description: "Capture a semantic snapshot of a page: URL, title, active element and interactive elements with refs.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "integer" } },
      additionalProperties: false,
    },
  },
  {
    name: "session_read_page",
    description: "Read the full page content of an authenticated page: text, inputs and interactive elements.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "integer" } },
      additionalProperties: false,
    },
  },
  {
    name: "session_click",
    description: "Click an element by CSS selector or @eN ref from a snapshot.",
    inputSchema: {
      type: "object",
      required: ["selector"],
      properties: {
        selector: { type: "string" },
        ref: { type: "string", description: "A ref from session_snapshot, such as @e12, used instead of selector" },
        tabId: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_fill",
    description: "Fill a form field (input, textarea, or contenteditable) with a value. Supports ProseMirror, Lexical, Slate and other rich text editors.",
    inputSchema: {
      type: "object",
      required: ["selector", "value"],
      properties: {
        selector: { type: "string" },
        ref: { type: "string", description: "A ref from session_snapshot, such as @e12, used instead of selector" },
        value: { type: "string" },
        tabId: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_type",
    description: "Type text character by character into a field, simulating real keyboard input.",
    inputSchema: {
      type: "object",
      required: ["selector", "text"],
      properties: {
        selector: { type: "string" },
        ref: { type: "string", description: "A ref from session_snapshot, such as @e12, used instead of selector" },
        text: { type: "string" },
        tabId: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_press",
    description: "Press a keyboard key (Enter, Tab, Escape, ...) on the focused element or a specific element.",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: {
        key: { type: "string" },
        selector: { type: "string" },
        ref: { type: "string", description: "A ref from session_snapshot, such as @e12, used instead of selector" },
        tabId: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_evaluate",
    description: "Execute JavaScript in the page context of the authenticated session and return the result.",
    inputSchema: {
      type: "object",
      required: ["code"],
      properties: {
        code: { type: "string" },
        tabId: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_screenshot",
    description: "Take a screenshot of the visible tab area. Returns base64 PNG or JPEG.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["png", "jpeg"] },
        quality: { type: "integer", description: "JPEG quality 0-100" },
        windowId: { type: "integer" },
        // Always honoured by the extension, never advertised — so the boundary rejected
        // it and a caller working in one specific tab could only capture the active one.
        tabId: { type: "integer", description: "Tab to capture (defaults to the active tab)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_wait",
    description: "Wait for a condition: page load, URL match, or selector presence.",
    inputSchema: {
      type: "object",
      required: ["condition"],
      properties: {
        condition: { type: "string", enum: ["load", "url", "selector"] },
        value: { type: "string", description: "URL substring or selector to wait for" },
        timeoutMs: { type: "integer", description: "Maximum wait in milliseconds" },
        tabId: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_login",
    description: "Decrypt and retrieve stored credentials for a domain. Requires the extension and Pro.",
    inputSchema: {
      type: "object",
      required: ["domain"],
      properties: {
        domain: { type: "string", description: "Domain the credentials are saved for, e.g. \"github.com\"" },
        tabId: { type: "integer" },
        submit: { type: "boolean", description: "Ignored; kept for compatibility" },
        masterPassword: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_store_login",
    description: "Encrypt and store credentials for a domain in the extension's vault. Requires the extension and Pro.",
    inputSchema: {
      type: "object",
      required: ["domain", "username", "password"],
      properties: {
        domain: { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        masterPassword: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_record_start",
    description: "Start recording user interactions on a tab. Captures clicks, scrolls, keystrokes, form fills, and navigations.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer", description: "Tab to record; uses the active tab when omitted" },
        sessionId: { type: "string", description: "Optional recording session id; one is generated if omitted" },
        maxEvents: { type: "integer", description: "Maximum number of events to capture (default 10000)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_record_stop",
    description: "Stop a recording session and return the captured event count and duration.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session to stop; required only when multiple recordings are active" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_record_list",
    description: "List all recording sessions and their status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "session_record_events",
    description: "Fetch the recorded events for a session.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        limit: { type: "integer" },
        offset: { type: "integer" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_record_replay",
    description: "Replay a stopped recording session in the original tab.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        speed: { type: "number", description: "Replay speed multiplier (default 1)" },
      },
      additionalProperties: false,
    },
  },
];

export const SESSION_TOOLS = TOOL_DEFINITIONS;

const SESSION_TO_BROWSER_BASE = Object.fromEntries(
  TOOL_DEFINITIONS.map((tool) => [tool.name, tool.name.replace(/^session_/, "browser_")])
);

export const SESSION_TO_BROWSER = {
  ...SESSION_TO_BROWSER_BASE,
  session_install: null,
  session_login: "browser_vault_load",
  session_store_login: "browser_vault_save",
};

export function findTool(name) {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name);
}

/**
 * Returns null when the arguments satisfy the schema, otherwise a sentence a
 * user can act on. Rejects unknown properties so typos fail loudly instead of
 * being silently dropped on the way to the browser.
 */
export function validateArguments(args, schema) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return "arguments must be an object";
  }
  const properties = schema.properties || {};
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in properties)) {
        return `Unknown argument: ${key}`;
      }
    }
  }
  for (const key of schema.required || []) {
    if (args[key] === undefined) {
      return `Missing required argument: ${key}`;
    }
  }
  for (const [key, prop] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined) continue;
    const typeError = checkType(key, value, prop);
    if (typeError) return typeError;
    if (prop.enum && !prop.enum.includes(value)) {
      return `${key} must be one of: ${prop.enum.join(", ")}`;
    }
  }
  return null;
}

function checkType(key, value, prop) {
  switch (prop.type) {
    case "string":
      return typeof value === "string" && value.length > 0 ? null : `${key} must be a non-empty string`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `${key} must be a number`;
    case "integer":
      return Number.isInteger(value) ? null : `${key} must be an integer`;
    case "boolean":
      return typeof value === "boolean" ? null : `${key} must be a boolean`;
    case "array":
      return Array.isArray(value) ? null : `${key} must be an array`;
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value) ? null : `${key} must be an object`;
    default:
      return null;
  }
}
