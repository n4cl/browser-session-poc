import { PAIRING_IDENTITY_FIELDS, PAIRING_PROTOCOL_VERSION } from "./pairing-protocol.mjs";

export const BROWSER_COMMANDS = Object.freeze(["browser_status", "tabs_list", "navigate"]);
export const BROWSER_COMMAND_TIMEOUT_MAX_MS = 30_000;
export const BROWSER_COMMAND_REQUEST_ID_MAX_LENGTH = 128;
export const BROWSER_COMMAND_RESPONSE_MAX_BYTES = 64 * 1024;
export const BROWSER_COMMAND_USED_REQUEST_ID_MAX = 4_096;
export const NAVIGATE_URL_MAX_LENGTH = 8_192;

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

export function browserRequestType(command) {
  if (!BROWSER_COMMANDS.includes(command)) fail("browser command is unsupported");
  return `${command}_request`;
}

export function browserResponseType(command) {
  if (!BROWSER_COMMANDS.includes(command)) fail("browser command is unsupported");
  return `${command}_response`;
}

function requestFields(command) {
  return command === "navigate" ? ["tab_id", "url"] : [];
}

export function createBrowserCommandRequest({ command, requestId, binding, connectionId, target = undefined }) {
  assertRequestId(requestId);
  const request = { type: browserRequestType(command), request_id: requestId, ...identity(binding, connectionId) };
  if (command === "navigate") {
    const navigation = validateNavigateTarget(target ?? {});
    request.tab_id = navigation.tabId;
    request.url = navigation.url;
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
  return { command, requestId: message.request_id };
}

/** Validates an Extension response and returns a compact result for the session caller. */
export function validateBrowserCommandResponse(message, { command, requestId, binding, connectionId, target = undefined }) {
  assertRequestId(requestId);
  const common = ["type", "request_id", ...PAIRING_IDENTITY_FIELDS, "host_connection_id", "protocol_version"];
  if (message?.type === "browser_error_response") {
    exactFields(message, [...common, "command", "error_code"]);
    assertIdentity(message, binding, connectionId);
    if (message.request_id !== requestId || message.command !== command || !nonEmptyString(message.error_code, 128)) {
      fail("browser command error does not match its request");
    }
    return { ok: false, errorCode: message.error_code };
  }
  const responseFields = command === "browser_status" ? ["status"] : command === "tabs_list" ? ["tabs"] : ["tab_id"];
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
