import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import {
  BROWSER_COMMAND_RESPONSE_MAX_BYTES,
  BROWSER_ERROR_CODES,
  CLICK_LOADER_ID_MAX_LENGTH,
  TYPE_TEXT_MAX_LENGTH,
  validateClickTarget,
  validateNavigateTarget,
  validateTypeTarget,
} from "../core/browser-command-protocol.mjs";
import { AUDIT_ERROR_CODE } from "../core/pairing-audit-log.mjs";

export const MCP_BROWSER_TOOL_NAMES = Object.freeze([
  "browser_status",
  "tabs_list",
  "navigate",
  "snapshot",
  "click",
  "type",
]);
export const MCP_BROWSER_RESULT_MAX_BYTES = BROWSER_COMMAND_RESPONSE_MAX_BYTES;

const FIXED_TOOL_ERROR_CODES = new Set([...BROWSER_ERROR_CODES, AUDIT_ERROR_CODE]);

function exactFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid tool arguments");
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error("invalid tool arguments");
  }
}

function validateTabId(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid tab id");
  return value;
}

function fixedSchema({ fields, properties, validate }) {
  const inputSchema = {
    type: "object",
    properties: Object.freeze(properties),
    additionalProperties: false,
  };
  if (fields.length > 0) inputSchema.required = Object.freeze([...fields]);
  return Object.freeze({
    "~standard": Object.freeze({
      version: 1,
      vendor: "browser-session-poc/mcp-browser-adapter",
      validate(value) {
        try {
          exactFields(value, fields);
          return { value: validate(value) };
        } catch {
          return { issues: [{ message: "invalid tool arguments" }] };
        }
      },
      jsonSchema: Object.freeze({
        input: () => inputSchema,
        output: () => ({ type: "object" }),
      }),
    }),
  });
}

const EMPTY_SCHEMA = fixedSchema({ fields: [], properties: {}, validate: () => ({}) });
const NAVIGATE_SCHEMA = fixedSchema({
  fields: ["tab_id", "url"],
  properties: {
    tab_id: { type: "integer", minimum: 0 },
    url: { type: "string", minLength: 1, maxLength: 8_192 },
  },
  validate: ({ tab_id: tabId, url }) => validateNavigateTarget({ tabId, url }),
});
const SNAPSHOT_SCHEMA = fixedSchema({
  fields: ["tab_id"],
  properties: { tab_id: { type: "integer", minimum: 0 } },
  validate: ({ tab_id: tabId }) => ({ tabId: validateTabId(tabId) }),
});
const CLICK_SCHEMA = fixedSchema({
  fields: ["tab_id", "loader_id", "backend_dom_node_id"],
  properties: {
    tab_id: { type: "integer", minimum: 0 },
    loader_id: { type: "string", minLength: 1, maxLength: CLICK_LOADER_ID_MAX_LENGTH, pattern: "^\\S+$" },
    backend_dom_node_id: { type: "integer", minimum: 1 },
  },
  validate: ({ tab_id: tabId, loader_id: loaderId, backend_dom_node_id: backendDomNodeId }) =>
    validateClickTarget({ tabId, loaderId, backendDomNodeId }),
});
const TYPE_SCHEMA = fixedSchema({
  fields: ["tab_id", "loader_id", "backend_dom_node_id", "text"],
  properties: {
    tab_id: { type: "integer", minimum: 0 },
    loader_id: { type: "string", minLength: 1, maxLength: CLICK_LOADER_ID_MAX_LENGTH, pattern: "^\\S+$" },
    backend_dom_node_id: { type: "integer", minimum: 1 },
    text: { type: "string", minLength: 1, maxLength: TYPE_TEXT_MAX_LENGTH },
  },
  validate: ({ tab_id: tabId, loader_id: loaderId, backend_dom_node_id: backendDomNodeId, text }) =>
    validateTypeTarget({ tabId, loaderId, backendDomNodeId, text }),
});

const TOOL_DEFINITIONS = Object.freeze({
  browser_status: Object.freeze({
    title: "Browser status",
    description: "Return the paired browser status.",
    inputSchema: EMPTY_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }),
  tabs_list: Object.freeze({
    title: "List tabs",
    description: "Return the paired browser tabs without page URL or title fields.",
    inputSchema: EMPTY_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }),
  navigate: Object.freeze({
    title: "Navigate tab",
    description: "Navigate one paired browser tab.",
    inputSchema: NAVIGATE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }),
  snapshot: Object.freeze({
    title: "Snapshot tab",
    description: "Return a bounded accessibility snapshot for one paired browser tab.",
    inputSchema: SNAPSHOT_SCHEMA,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }),
  click: Object.freeze({
    title: "Click node",
    description: "Click one node in the current paired browser document.",
    inputSchema: CLICK_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }),
  type: Object.freeze({
    title: "Type into node",
    description: "Insert text into one node in the current paired browser document.",
    inputSchema: TYPE_SCHEMA,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }),
});

function fixedToolError(error) {
  const code = FIXED_TOOL_ERROR_CODES.has(error?.code) ? error.code : "transport_closed";
  return { isError: true, content: [{ type: "text", text: code }] };
}

function assertResultSize(result) {
  let bytes;
  try {
    bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  } catch {
    const error = new Error("response_too_large");
    error.code = "response_too_large";
    throw error;
  }
  if (bytes > MCP_BROWSER_RESULT_MAX_BYTES) {
    const error = new Error("response_too_large");
    error.code = "response_too_large";
    throw error;
  }
}

function compactTabs(tabs) {
  if (!Array.isArray(tabs)) throw new Error("tabs response is invalid");
  return tabs.map((tab) => ({ id: tab.id, window_id: tab.window_id, active: tab.active }));
}

function compactResult(command, result) {
  if (command === "browser_status") return { status: result.status };
  if (command === "tabs_list") return { tabs: compactTabs(result.tabs) };
  if (command === "navigate") return { tab_id: result.tab_id, accepted: result.accepted };
  if (command === "snapshot") {
    return {
      tab_id: result.tab_id,
      document: result.document,
      nodes: result.nodes,
      truncated: result.truncated,
      partial: result.partial,
    };
  }
  return {
    tab_id: result.tab_id,
    loader_id: result.loader_id,
    backend_dom_node_id: result.backend_dom_node_id,
    accepted: result.accepted,
  };
}

function successResult(result) {
  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch {
    const error = new Error("response_too_large");
    error.code = "response_too_large";
    throw error;
  }
  const response = { content: [{ type: "text", text: serialized }] };
  assertResultSize(response);
  return response;
}

function dispatch(browserServer, command, requestId, args) {
  if (command === "browser_status") return browserServer.requestBrowserStatus({ requestId });
  if (command === "tabs_list") return browserServer.requestTabsList({ requestId });
  if (command === "navigate") return browserServer.requestNavigate({ requestId, tabId: args.tabId, url: args.url });
  if (command === "snapshot") return browserServer.requestSnapshot({ requestId, tabId: args.tabId });
  if (command === "click") {
    return browserServer.requestClick({
      requestId,
      tabId: args.tabId,
      loaderId: args.loaderId,
      backendDomNodeId: args.backendDomNodeId,
    });
  }
  return browserServer.requestType({
    requestId,
    tabId: args.tabId,
    loaderId: args.loaderId,
    backendDomNodeId: args.backendDomNodeId,
    text: args.text,
  });
}

export function createMcpBrowserServer({ browserServer, createRequestId = randomUUID } = {}) {
  const server = new McpServer({ name: "browser-session-poc", version: "0.0.0" });
  for (const command of MCP_BROWSER_TOOL_NAMES) {
    const definition = TOOL_DEFINITIONS[command];
    server.registerTool(command, definition, async (input) => {
      try {
        const requestId = createRequestId();
        const result = await dispatch(browserServer, command, requestId, input);
        return successResult(compactResult(command, result));
      } catch (error) {
        return fixedToolError(error);
      }
    });
  }
  return server;
}
