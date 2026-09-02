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
    description:
      "Return setup instructions for the T3rnel Browser extension and for the free standalone automation browser. Needs no browser and no licence, so it is the one tool that always answers — call it when another tool reports the extension is missing. Returns installation steps as text.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "session_health",
    description:
      "Report which transport is live and what it can do. Call this first when another tool fails unexpectedly: it separates 'the extension is not running' from 'this browser does not implement that API', which produce very different fixes. Returns {ok, mode, browser, profileDir} in standalone mode, and the connection state plus the available browser APIs when the extension is attached.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "session_list_tabs",
    description:
      "List every open tab. Returns an array of {id, title, url}. The ids are what every other tool's optional tabId argument accepts; omit tabId and a tool acts on the active tab, which is rarely what you want once you have opened tabs of your own.",
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
    requiresExtension: true,
    description:
      "Close a tab, named explicitly by its id from session_list_tabs. Returns {closed, tabId}. Unlike every other tool here, tabId is required and there is no active-tab default: closing a tab is not undoable, and the active tab is the one the user is looking at. Requires the T3rnel Browser extension; the standalone browser refuses it by name.",
    inputSchema: {
      type: "object",
      // Required, because the extension's handler reads it with `readRequiredNumber` and
      // throws when it is absent. Declaring it optional and promising an active-tab default
      // meant a caller that omitted it got "missing required browser arg: tabId" back from
      // deep inside the extension, for a default this tool never had.
      required: ["tabId"],
      properties: {
        tabId: { type: "integer", description: "Tab to close, from session_list_tabs" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_navigate",
    description:
      "Navigate a tab to a URL inside the user's authenticated session, so pages behind a login load as themselves rather than as a signed-out visitor. Reuses the active tab unless newTab is true. Returns {navigated} with the requested URL, and newTab when a tab was created. It returns once navigation is dispatched, not once the page has settled — follow it with session_wait before reading.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string", description: "Absolute URL to navigate to, including the scheme" },
        tabId: { type: "integer", description: "Tab id from session_list_tabs; uses the active tab when omitted" },
        newTab: { type: "boolean", description: "Open in a new tab instead of reusing the active tab (default false)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_snapshot",
    description:
      "Capture a semantic map of a page for deciding what to act on. Returns {url, title, elements}, where each element is {ref, tag, text} — ref being an @eN handle that session_click, session_fill, session_type, session_select and session_press all accept in place of a CSS selector. Prefer this over session_read_page when the goal is to interact rather than to read: it lists only elements a user could actually operate. Skips zero-size and hidden elements, caps each label at 120 characters, and stops at 200 elements.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "integer", description: "Tab to snapshot; uses the active tab when omitted" } },
      additionalProperties: false,
    },
  },
  {
    name: "session_read_page",
    description:
      "Read a page's visible text, as rendered in the user's authenticated session. Returns {url, title, text, truncated}; text is the body's rendered innerText capped at 50,000 characters, and truncated is true when the page was longer. Prefer this over session_snapshot when the goal is to read or summarise; prefer session_snapshot when the goal is to interact.",
    inputSchema: {
      type: "object",
      properties: { tabId: { type: "integer", description: "Tab to read; uses the active tab when omitted" } },
      additionalProperties: false,
    },
  },
  {
    name: "session_click",
    description:
      "Click an element, by CSS selector or by an @eN ref from session_snapshot. Scrolls the element into view and dispatches a real mouse press and release at its centre, so handlers that ignore synthetic events still fire. Returns {clicked} naming what was targeted. Fails with 'Element not found' rather than clicking something else when nothing matches.",
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
    description:
      "Set a form field's value in one step — input, textarea, or a rich-text editor such as ProseMirror, Lexical or Slate. Writes through the native value setter and then fires input and change, which is what React and Vue listen for. Returns {filled} naming the field. Use session_type instead when a field only reacts to real keystrokes, and session_select for a dropdown.",
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
    description:
      "Type text one character at a time, firing the key events a real keyboard would. Use this instead of session_fill when a field only reacts to keystrokes — search boxes with live suggestions, autocompletes, and inputs with per-character validation. Returns {typed} with the number of characters sent. Slower than session_fill, so reach for it only when session_fill leaves the page unchanged.",
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
    description:
      "Choose an option in a <select> dropdown, by value, by visible text, or by index. Filling a select as though it were a text field does nothing — the native value setter belongs to HTMLInputElement and has no effect here — which is the silent failure this tool exists to prevent. Matches value first, then exact visible text, then a substring, then index. Returns {selected, value, text} for the chosen option, and on no match fails with the available options listed.",
    inputSchema: {
      type: "object",
      required: ["selector"],
      properties: {
        selector: { type: "string", description: "CSS selector for the <select>" },
        ref: { type: "string", description: "A ref from session_snapshot, such as @e12, used instead of selector" },
        value: { type: "string", description: "Option value to choose; tried first" },
        text: { type: "string", description: "Visible option text to choose; matched exactly first, then by substring" },
        index: { type: "integer", description: "Zero-based option index to choose; tried last" },
        tabId: { type: "integer", description: "Tab to act on; uses the active tab when omitted" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_press",
    description:
      "Press a single keyboard key on the focused element, or on a named element after focusing it. Use it to submit a form with Enter, dismiss a dialog with Escape, or walk a suggestion list with ArrowDown. Returns {pressed} naming the key. Supported keys are Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown and Space; anything else fails with the supported list rather than doing nothing.",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: {
        key: { type: "string", description: "One of Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space" },
        selector: { type: "string", description: "CSS selector for the element to press the key on; uses the focused element when omitted" },
        ref: { type: "string", description: "A ref from session_snapshot, such as @e12, used instead of selector" },
        tabId: { type: "integer", description: "Tab to act on; uses the active tab when omitted" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_evaluate",
    description:
      "Run JavaScript in the page's own context and return its completion value. Use it for what the other tools do not cover — reading computed styles, walking a data structure the page holds, or checking a condition too specific for session_wait. Objects come back as formatted JSON, strings as themselves, and an expression with no value as \"undefined\". End the code with the expression you want back; a trailing statement returns nothing useful.",
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
    description:
      "Capture what is currently on screen in a tab. Returns a data: URL holding a base64 PNG or JPEG. This is the visible viewport only — it does not scroll or stitch, so a long page needs the extension's full-page capture instead.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["png", "jpeg"], description: "png (default, lossless) or jpeg (smaller, and the only format quality applies to)" },
        quality: { type: "integer", description: "JPEG quality from 0 to 100; ignored for png" },
        windowId: { type: "integer", description: "Window to capture from; uses the current window when omitted" },
        // Always honoured by the extension, never advertised — so the boundary rejected
        // it and a caller working in one specific tab could only capture the active one.
        tabId: { type: "integer", description: "Tab to capture; uses the active tab when omitted" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_wait",
    description:
      "Block until a page reaches a known state, so the next tool acts on a settled page rather than a half-loaded one. Waits for the load event, for the URL to contain a string, or for a selector to appear. Returns as soon as the condition holds — {condition, waited} for load, {condition, url} for url, {condition, found} for selector — and fails at the timeout with a named error rather than hanging the client. Polls every 200ms; the default timeout is 10000ms.",
    inputSchema: {
      type: "object",
      required: ["condition"],
      properties: {
        condition: { type: "string", enum: ["load", "url", "selector"], description: "What to wait for: load (the load event), url (value appears in the URL), or selector (element appears)" },
        value: { type: "string", description: "URL substring or CSS selector to wait for; required for the url and selector conditions" },
        timeoutMs: { type: "integer", description: "Maximum wait in milliseconds (default 10000)" },
        tabId: { type: "integer", description: "Tab to wait on; uses the active tab when omitted" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_login",
    requiresExtension: true,
    description:
      "Decrypt stored credentials for a domain and fill them into the page's sign-in form. Requires the T3rnel Browser extension with Pro, because the encrypted vault lives in the extension; the refusal comes from the extension rather than from this bridge, so there is one gate rather than two that can disagree. The standalone browser has no vault — sign in once by hand in its profile instead, and the session persists.",
    inputSchema: {
      type: "object",
      required: ["domain"],
      properties: {
        domain: { type: "string", description: "Domain the credentials are saved for, such as \"github.com\"" },
        tabId: { type: "integer", description: "Tab holding the sign-in form; uses the active tab when omitted" },
        submit: { type: "boolean", description: "Ignored; kept so older callers do not break" },
        masterPassword: { type: "string", description: "Passphrase that unlocks the extension's vault. Never log or persist it" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_store_login",
    requiresExtension: true,
    description:
      "Encrypt credentials for a domain and store them in the extension's vault, for session_login to use later. Requires the T3rnel Browser extension with Pro. The password is never returned by this or any other tool, and never appears in a listing or an error.",
    inputSchema: {
      type: "object",
      required: ["domain", "username", "password"],
      properties: {
        domain: { type: "string", description: "Domain the credentials belong to, such as \"github.com\"" },
        username: { type: "string", description: "Username or email to store" },
        password: { type: "string", description: "Password to encrypt and store. It is never returned by any tool" },
        masterPassword: { type: "string", description: "Passphrase that unlocks the extension's vault. Never log or persist it" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_record_start",
    requiresExtension: true,
    description:
      "Begin recording what happens in a tab: clicks, scrolls, keystrokes, form fills, selections and navigations, each with a timestamp. Returns {recording, sessionId, tabId} — keep the sessionId, since every other recording tool needs it. Requires the T3rnel Browser extension. Recording stops on its own if the tab closes or after four hours.",
    inputSchema: {
      type: "object",
      properties: {
        tabId: { type: "integer", description: "Tab to record; uses the active tab when omitted" },
        sessionId: { type: "string", description: "Recording session id; one is generated when omitted" },
        maxEvents: { type: "integer", description: "Maximum events to keep, oldest dropped first (default 10000)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_record_stop",
    requiresExtension: true,
    description:
      "Stop a recording and return {recording, sessionId, eventCount, durationMs}. The events themselves are read separately with session_record_events, so this is cheap to call on a long recording. Requires the T3rnel Browser extension. With several recordings active, sessionId is required and the error names how many are running.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session to stop; required only when more than one recording is active" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_record_list",
    requiresExtension: true,
    description:
      "List every recording, running or finished, so a caller can find the id that session_record_events and session_record_replay need. Returns {sessions}, each entry being {id, tabId, active, startedAt, stoppedAt, stoppedReason, eventCount, durationMs}. Requires the T3rnel Browser extension.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "session_record_events",
    requiresExtension: true,
    description:
      "Fetch the captured events of a recording, in the order they happened. Returns {events, count}, where count is the total held for the session and events is one page of {type, timestamp, tabId, data}; type is one of click, scroll, keypress, input, navigation, focus, select or resize. Page through long recordings with limit and offset rather than reading them whole, since a session can hold tens of thousands of events. Requires the T3rnel Browser extension.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string", description: "Recording session to read, from session_record_list" },
        limit: { type: "integer", description: "Maximum events to return in this page (default 100)" },
        offset: { type: "integer", description: "Number of events to skip, for paging through a long recording (default 0)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "session_record_replay",
    requiresExtension: true,
    description:
      "Replay a stopped recording in its original tab, reproducing the recorded interactions in order. Returns {sessionId, totalEvents, replayedEvents, failedEvents, errors}, so a partial replay reports which steps failed instead of appearing to succeed. The tab must still be open. This acts on the live page and its effects are real — it will re-send messages, re-submit forms and re-spend money — so the extension classifies it high risk and gates it behind an approval prompt. Requires the T3rnel Browser extension.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string", description: "Stopped recording session to replay, from session_record_list" },
        speed: { type: "number", description: "Replay speed multiplier; 1 is the recorded pace, 2 is twice as fast (default 1)" },
      },
      additionalProperties: false,
    },
  },
];

/**
 * The tools that work with no extension installed, derived from the definitions rather
 * than counted by hand.
 *
 * The manifest used to advertise `TOOL_DEFINITIONS.length` as the standalone count,
 * which claimed 22 when 8 of those refuse outright without the extension. A caller in
 * standalone mode was told it had recording and a credential vault, and found out
 * otherwise one error at a time.
 */
export const STANDALONE_TOOLS = TOOL_DEFINITIONS.filter((tool) => !tool.requiresExtension);
export const EXTENSION_ONLY_TOOLS = TOOL_DEFINITIONS.filter((tool) => tool.requiresExtension);

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
