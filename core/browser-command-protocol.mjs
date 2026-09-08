import { PAIRING_IDENTITY_FIELDS, PAIRING_PROTOCOL_VERSION } from "./pairing-protocol.mjs";

export const BROWSER_COMMANDS = Object.freeze(["browser_status", "tabs_list", "navigate", "snapshot"]);
export const BROWSER_COMMAND_TIMEOUT_MAX_MS = 30_000;
export const BROWSER_COMMAND_REQUEST_ID_MAX_LENGTH = 128;
export const BROWSER_COMMAND_RESPONSE_MAX_BYTES = 64 * 1024;
export const BROWSER_COMMAND_USED_REQUEST_ID_MAX = 4_096;
export const NAVIGATE_URL_MAX_LENGTH = 8_192;
export const SNAPSHOT_NODE_MAX = 100;
export const SNAPSHOT_DEPTH_MAX = 16;
export const SNAPSHOT_TEXT_MAX_LENGTH = 512;
export const SNAPSHOT_LOADER_ID_MAX_LENGTH = 256;
export const BROWSER_ERROR_CODES = Object.freeze([
  "debugger_unavailable",
  "tab_not_found",
  "debugger_busy",
  "debugger_attach_failed",
  "snapshot_failed",
  "debugger_detach_failed",
  "response_too_large",
  "tabs_unavailable",
  "navigation_failed",
  "outcome_unknown",
  "timeout",
  "transport_closed",
]);

function fail(message = "invalid browser command message") {
  throw new Error(message);
}

function exactFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail();
}

function nonEmptyString(value, maximumLength = Number.POSITIVE_INFINITY) {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength && value.trim() === value;
}

function identity(binding, connectionId) {
  return {
    protocol_version: PAIRING_PROTOCOL_VERSION,
    ...binding,
    host_connection_id: connectionId,
  };
}

function assertIdentity(message, binding, connectionId) {
  if (message.protocol_version !== PAIRING_PROTOCOL_VERSION) fail("unsupported protocol version");
  for (const field of PAIRING_IDENTITY_FIELDS) {
    if (message[field] !== binding[field]) fail("browser command identity does not match");
  }
  if (message.host_connection_id !== connectionId) fail("browser command connection does not match");
}

function assertRequestId(requestId) {
  if (!nonEmptyString(requestId, BROWSER_COMMAND_REQUEST_ID_MAX_LENGTH)) fail("browser command request id is invalid");
}

export function validateNavigateTarget({ tabId, url }) {
  if (!Number.isSafeInteger(tabId) || tabId < 0) fail("navigate tab id is invalid");
  if (typeof url !== "string" || url.length === 0 || url.length > NAVIGATE_URL_MAX_LENGTH ||
    url.trim() !== url || /[\u0000-\u001F\u007F]/.test(url) || /\s/u.test(url)) {
    fail("navigate URL is invalid");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail("navigate URL is invalid");
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "") {
    fail("navigate URL is invalid");
  }
  if (parsed.href.length > NAVIGATE_URL_MAX_LENGTH) fail("navigate URL is invalid");
  return { tabId, url: parsed.href };
}

function assertTab(tab) {
  exactFields(tab, ["active", "id", "title", "url", "window_id"]);
  if (!Number.isSafeInteger(tab.id) || tab.id < 0 || !Number.isSafeInteger(tab.window_id) || tab.window_id < 0 ||
    typeof tab.active !== "boolean" || (tab.title !== null && typeof tab.title !== "string") ||
    (tab.url !== null && typeof tab.url !== "string") ||
    (typeof tab.title === "string" && tab.title.length > 4_096) ||
    (typeof tab.url === "string" && tab.url.length > 8_192)) {
    fail("tab is invalid");
  }
}

function assertSnapshotTarget(target) {
  if (!Number.isSafeInteger(target?.tabId) || target.tabId < 0) fail("snapshot tab id is invalid");
  return { tabId: target.tabId };
}

function assertSnapshotNode(node) {
  exactFields(node, ["backend_dom_node_id", "name", "parent_ref", "ref", "role", "state", "value"]);
  if (!Number.isSafeInteger(node.ref) || node.ref <= 0 ||
    !(node.parent_ref === null || (Number.isSafeInteger(node.parent_ref) && node.parent_ref > 0)) ||
    !(node.backend_dom_node_id === null || (Number.isSafeInteger(node.backend_dom_node_id) && node.backend_dom_node_id > 0)) ||
    typeof node.role !== "string" || node.role.length === 0 || node.role.length > SNAPSHOT_TEXT_MAX_LENGTH ||
    !(node.name === null || (typeof node.name === "string" && node.name.length <= SNAPSHOT_TEXT_MAX_LENGTH)) ||
    !(node.value === null || (typeof node.value === "string" && node.value.length <= SNAPSHOT_TEXT_MAX_LENGTH))) fail("snapshot node is invalid");
  exactFields(node.state, ["disabled", "expanded", "focused", "hidden"]);
  if (!Object.values(node.state).every((value) => typeof value === "boolean")) fail("snapshot node is invalid");
}

function assertSnapshotTree(nodes) {
  const refs = new Set();
  nodes.forEach((node, index) => {
    assertSnapshotNode(node);
    if (node.ref !== index + 1 || refs.has(node.ref)) fail("snapshot node is invalid");
    refs.add(node.ref);
  });
  const visiting = new Set();
  const depths = new Map();
  const depthOf = (node) => {
    if (depths.has(node.ref)) return depths.get(node.ref);
    if (visiting.has(node.ref)) fail("snapshot node is invalid");
    visiting.add(node.ref);
    let depth = 0;
    if (node.parent_ref !== null) {
      const parent = nodes[node.parent_ref - 1];
      if (!parent || parent.ref !== node.parent_ref) fail("snapshot node is invalid");
      depth = depthOf(parent) + 1;
    }
    visiting.delete(node.ref);
    depths.set(node.ref, depth);
    return depth;
  };
  nodes.forEach((node) => {
    if (depthOf(node) > SNAPSHOT_DEPTH_MAX) fail("snapshot node is invalid");
  });
}

function assertSnapshot(snapshot, tabId) {
  exactFields(snapshot, ["document", "nodes", "partial", "tab_id", "truncated"]);
  if (snapshot.tab_id !== tabId || !snapshot.document || typeof snapshot.document !== "object" || Array.isArray(snapshot.document)) {
    fail("snapshot response is invalid");
  }
  exactFields(snapshot.document, ["loader_id"]);
  if (!nonEmptyString(snapshot.document.loader_id, SNAPSHOT_LOADER_ID_MAX_LENGTH) || !Array.isArray(snapshot.nodes) ||
    snapshot.nodes.length > SNAPSHOT_NODE_MAX || typeof snapshot.truncated !== "boolean" || typeof snapshot.partial !== "boolean") {
    fail("snapshot response is invalid");
  }
  assertSnapshotTree(snapshot.nodes);
}

export function browserRequestType(command) {
  if (!BROWSER_COMMANDS.includes(command)) fail("browser command is unsupported");
  return `${command}_request`;
}

export function browserResponseType(command) {
  if (!BROWSER_COMMANDS.includes(command)) fail("browser command is unsupported");
  return `${command}_response`;
}

function requestFields(command) {
  return command === "navigate" ? ["tab_id", "url"] : command === "snapshot" ? ["tab_id"] : [];
}

export function createBrowserCommandRequest({ command, requestId, binding, connectionId, target = undefined }) {
  assertRequestId(requestId);
  const request = { type: browserRequestType(command), request_id: requestId, ...identity(binding, connectionId) };
  if (command === "navigate") {
    const navigation = validateNavigateTarget(target ?? {});
    request.tab_id = navigation.tabId;
    request.url = navigation.url;
  } else if (command === "snapshot") {
    request.tab_id = assertSnapshotTarget(target ?? {}).tabId;
  }
  return request;
}

export function validateBrowserCommandRequest(message, { binding, connectionId }) {
  const command = BROWSER_COMMANDS.find((candidate) => message?.type === browserRequestType(candidate));
  if (!command) fail("browser command is unsupported");
  exactFields(message, ["type", "request_id", ...PAIRING_IDENTITY_FIELDS, "host_connection_id", "protocol_version", ...requestFields(command)]);
  assertIdentity(message, binding, connectionId);
  assertRequestId(message.request_id);
  if (command === "navigate") {
    return { command, requestId: message.request_id, target: validateNavigateTarget({ tabId: message.tab_id, url: message.url }) };
  }
  if (command === "snapshot") return { command, requestId: message.request_id, target: assertSnapshotTarget({ tabId: message.tab_id }) };
  return { command, requestId: message.request_id };
}

/** Validates an Extension response and returns a compact result for the session caller. */
export function validateBrowserCommandResponse(message, { command, requestId, binding, connectionId, target = undefined }) {
  if (!BROWSER_COMMANDS.includes(command)) fail("browser command is unsupported");
  assertRequestId(requestId);
  const common = ["type", "request_id", ...PAIRING_IDENTITY_FIELDS, "host_connection_id", "protocol_version"];
  assertBrowserCommandResponseSize(message);
  if (message?.type === "browser_error_response") {
    exactFields(message, [...common, "command", "error_code"]);
    assertIdentity(message, binding, connectionId);
    if (message.request_id !== requestId || message.command !== command || !BROWSER_ERROR_CODES.includes(message.error_code)) {
      fail("browser command error does not match its request");
    }
    return { ok: false, errorCode: message.error_code };
  }
  const responseFields = command === "browser_status" ? ["status"] : command === "tabs_list" ? ["tabs"] : command === "navigate" ? ["tab_id"] : ["document", "nodes", "partial", "tab_id", "truncated"];
  exactFields(message, [...common, ...responseFields]);
  assertIdentity(message, binding, connectionId);
  if (message.type !== browserResponseType(command) || message.request_id !== requestId) {
    fail("browser command response does not match its request");
  }
  if (command === "browser_status") {
    exactFields(message.status, ["chrome_tabs_available", "extension_connected"]);
    if (typeof message.status.extension_connected !== "boolean" || typeof message.status.chrome_tabs_available !== "boolean") {
      fail("browser status is invalid");
    }
    return { ok: true, status: message.status };
  }
  if (command === "tabs_list") {
    if (!Array.isArray(message.tabs)) fail("tabs response is invalid");
    message.tabs.forEach(assertTab);
    return { ok: true, tabs: message.tabs };
  }
  if (command === "snapshot") {
    const tabId = assertSnapshotTarget(target ?? {}).tabId;
    assertSnapshot({
      document: message.document,
      nodes: message.nodes,
      partial: message.partial,
      tab_id: message.tab_id,
      truncated: message.truncated,
    }, tabId);
    return { ok: true, tab_id: tabId, document: message.document, nodes: message.nodes, truncated: message.truncated, partial: message.partial };
  }
  if (!Number.isSafeInteger(message.tab_id) || message.tab_id < 0) fail("navigate response tab id is invalid");
  if (target !== undefined && message.tab_id !== validateNavigateTarget(target).tabId) {
    fail("navigate response does not match its target");
  }
  return { ok: true, tab_id: message.tab_id, accepted: true };
}

export function assertBrowserCommandTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > BROWSER_COMMAND_TIMEOUT_MAX_MS) {
    throw new TypeError(`timeoutMs must be an integer from 1 to ${BROWSER_COMMAND_TIMEOUT_MAX_MS}`);
  }
}

export function assertBrowserCommandResponseSize(message) {
  if (new TextEncoder().encode(JSON.stringify(message)).byteLength > BROWSER_COMMAND_RESPONSE_MAX_BYTES) {
    fail("browser command response exceeds transport limit");
  }
}
