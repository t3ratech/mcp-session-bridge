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
    description: "Report whether the extension is connected and which browser APIs the current session exposes. Use this first when another tool fails unexpectedly: it distinguishes 'the extension is not running' from 'this browser does not implement that API'.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "session_list_tabs",
    description: "List every open tab with its id, title and URL. Tab ids from here are what every other tool's optional tabId argument accepts; without one, tools act on the active tab.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    /**
     * Named `session_close_tab` so the automatic prefix swap reaches the extension's
     * `browser_close_tab`. The tool surface is otherwise complete for the browsing
     * lifecycle: open, navigate, read, interact, record — and, until now, never close,
     * which left an agent opening tabs it had no way to tidy up.
     */
    name: "session_close_tab",
    description: "Close a tab in the user's browser. Without a tabId this closes the active tab, so pass one explicitly when tidying up a tab the agent opened rather than the one the user is looking at.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer", description: "Tab to close, from session_list_tabs; closes the active tab when omitted" },
      },
      additionalProperties: false,
    },
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
      properties: { tabId: { type: "integer", description: "Tab to snapshot; uses the active tab when omitted" } },
      additionalProperties: false,
    },
  },
  {
    name: "session_read_page",
    description: "Read the full page content of an authenticated page: text, inputs and interactive elements.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "integer", description: "Tab to read; uses the active tab when omitted" } },
      additionalProperties: false,
    },
  },
  {
    name: "session_click",
    description: "Click an element in the user's authenticated session, by CSS selector or by an @eN ref taken from session_snapshot. Scrolls the element into view first and fails rather than clicking something else if the selector matches nothing.",
    inputSchema: {
      type: "object",
      required: ["selector"],
      properties: {
        selector: { type: "string", description: "CSS selector for the element to click" },
        ref: { type: "string", description: "A ref from session_snapshot, such as @e12, used instead of selector" },
        tabId: { type: "integer", description: "Tab to act on; uses the active tab when omitted" },
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
        selector: { type: "string", description: "CSS selector for the field to fill" },
        ref: { type: "string", description: "A ref from session_snapshot, such as @e12, used instead of selector" },
        value: { type: "string", description: "Text to place in the field, replacing whatever is there" },
        tabId: { type: "integer", description: "Tab to act on; uses the active tab when omitted" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_type",
    description: "Type text one character at a time, firing the key events a real keyboard would. Use this instead of session_fill when a field only reacts to keystrokes \u2014 search boxes with live suggestions, and inputs with per-character validation.",
    inputSchema: {
      type: "object",
      required: ["selector", "text"],
      properties: {
        selector: { type: "string", description: "CSS selector for the field to type into" },
        ref: { type: "string", description: "A ref from session_snapshot, such as @e12, used instead of selector" },
        text: { type: "string", description: "Text to type, one character at a time" },
        tabId: { type: "integer", description: "Tab to act on; uses the active tab when omitted" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_select",
    description: "Choose an option in a <select> dropdown, by value, visible text or index. Filling a select as though it were a text field does nothing.",
    inputSchema: {
      type: "object",
      required: ["selector"],
      properties: {
        selector: { type: "string", description: "CSS selector for the <select>" },
        ref: { type: "string", description: "A ref from session_snapshot, such as @e12, used instead of selector" },
        value: { type: "string", description: "Option value to choose" },
        text: { type: "string", description: "Visible option text to choose; matched exactly first, then by substring" },
        index: { type: "integer", description: "Option index to choose" },
        tabId: { type: "integer", description: "Tab to act on; uses the active tab when omitted" },
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
        key: { type: "string", description: "Key name, such as Enter, Tab, Escape, ArrowDown" },
        selector: { type: "string", description: "CSS selector for the element to press the key on; the focused element when omitted" },
        ref: { type: "string", description: "A ref from session_snapshot, such as @e12, used instead of selector" },
        tabId: { type: "integer", description: "Tab to act on; uses the active tab when omitted" },
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
        code: { type: "string", description: "JavaScript to run in the page's own context. Its completion value is returned, so end with the expression you want back" },
        tabId: { type: "integer", description: "Tab to run in; uses the active tab when omitted" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_screenshot",
    description: "Capture the visible area of a tab and return it as a base64 PNG or JPEG. Captures only what is on screen; it does not scroll or stitch a full page.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["png", "jpeg"], description: "png (default, lossless) or jpeg (smaller, and the only format quality applies to)" },
        quality: { type: "integer", description: "JPEG quality 0-100" },
        windowId: { type: "integer", description: "Window to capture from; uses the current window when omitted" },
        // Always honoured by the extension, never advertised — so the boundary rejected
        // it and a caller working in one specific tab could only capture the active one.
        tabId: { type: "integer", description: "Tab to capture (defaults to the active tab)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_wait",
    description: "Block until a condition holds: the page finishes loading, the URL contains a string, or a selector appears. Returns as soon as the condition is met and fails at the timeout rather than hanging the client.",
    inputSchema: {
      type: "object",
      required: ["condition"],
      properties: {
        condition: { type: "string", enum: ["load", "url", "selector"], description: "What to wait for: load, url, or selector" },
        value: { type: "string", description: "URL substring or selector to wait for" },
        timeoutMs: { type: "integer", description: "Maximum wait in milliseconds" },
        tabId: { type: "integer", description: "Tab to wait on; uses the active tab when omitted" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_login",
    description: "Decrypt stored credentials for a domain and fill them into the page's sign-in form. Requires the extension and a Pro licence; the refusal comes from the extension, not from this bridge.",
    inputSchema: {
      type: "object",
      required: ["domain"],
      properties: {
        domain: { type: "string", description: "Domain the credentials are saved for, e.g. \"github.com\"" },
        tabId: { type: "integer", description: "Tab holding the sign-in form; uses the active tab when omitted" },
        submit: { type: "boolean", description: "Ignored; kept for compatibility" },
        masterPassword: { type: "string", description: "Passphrase that unlocks the extension's vault. Never log or persist it" },
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
        domain: { type: "string", description: "Domain the credentials belong to, such as \\\"github.com\\\"" },
        username: { type: "string", description: "Username or email to store" },
        password: { type: "string", description: "Password to encrypt and store. It is never returned by any tool" },
        masterPassword: { type: "string", description: "Passphrase that unlocks the extension's vault. Never log or persist it" },
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
    description: "Stop a recording session and return how many events it captured and how long it ran. The events themselves are read separately with session_record_events.",
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
    description: "List every recording session with its id, state and event count, so a caller can find the id it needs for session_record_events or session_record_replay.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "session_record_events",
    description: "Fetch the captured events of a recording session \u2014 clicks, scrolls, keystrokes, form fills and navigations, in the order they happened. Long recordings are paged with limit and offset rather than returned whole, because a full session can be tens of thousands of events.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string", description: "Recording session to read, from session_record_list" },
        limit: { type: "integer", description: "Maximum events to return in this page (default 500)" },
        offset: { type: "integer", description: "Number of events to skip, for paging through a long recording" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_record_replay",
    description: "Replay a stopped recording in its original tab, reproducing the recorded interactions in order. The tab must still be open; replay acts on the live page and its effects are real.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string", description: "Stopped recording session to replay, from session_record_list" },
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
