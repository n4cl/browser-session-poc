export const PAIRING_PROTOCOL_VERSION = 1;
export const BROWSER_COMMAND_RESPONSE_MAX_BYTES = 64 * 1024;
export const NAVIGATE_URL_MAX_LENGTH = 8_192;

const BINDING_FIELDS = [
  "session_id",
  "browser_instance_id",
  "profile_instance_id",
  "generation",
  "lease_id",
];

function fail() {
  throw new Error("invalid pairing protocol message");
}

function exactFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail();
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function validBindingField(field, value) {
  return field === "generation"
    ? Number.isSafeInteger(value) && value > 0
    : nonEmptyString(value);
}

export function validateBinding(binding) {
  exactFields(binding, BINDING_FIELDS);
  if (!BINDING_FIELDS.every((field) => validBindingField(field, binding[field]))) fail();
  return binding;
}

function identityOf(message) {
  return Object.fromEntries(BINDING_FIELDS.map((field) => [field, message[field]]));
}

function validateIdentity(message, binding) {
  for (const field of BINDING_FIELDS) {
    if (message[field] !== binding[field]) fail();
  }
}

function validateConnectionId(value) {
  if (!nonEmptyString(value)) fail();
}

function validateNavigateTarget({ tabId, url }) {
  if (!Number.isSafeInteger(tabId) || tabId < 0 || typeof url !== "string" || url.length === 0 ||
    url.length > NAVIGATE_URL_MAX_LENGTH || url.trim() !== url || /[\u0000-\u001F\u007F]/.test(url)) fail();
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail();
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username !== "" || parsed.password !== "") fail();
  if (parsed.href.length > NAVIGATE_URL_MAX_LENGTH) fail();
  return { tabId, url: parsed.href };
}

function validateBrowserRequest(message, binding, hostConnectionId, command) {
  const extraFields = command === "navigate" ? ["tab_id", "url"] : [];
  exactFields(message, ["type", "request_id", "protocol_version", ...BINDING_FIELDS, "host_connection_id", ...extraFields]);
  if (message.type !== `${command}_request` || !nonEmptyString(message.request_id) || message.request_id.length > 128) fail();
  validateIdentity(message, binding);
  validateConnectionId(message.host_connection_id);
  if (message.host_connection_id !== hostConnectionId) fail();
  return command === "navigate" ? validateNavigateTarget({ tabId: message.tab_id, url: message.url }) : undefined;
}

function assertResponseSize(response) {
  if (new TextEncoder().encode(JSON.stringify(response)).byteLength > BROWSER_COMMAND_RESPONSE_MAX_BYTES) {
    throw new Error("browser command response exceeds transport limit");
  }
  return response;
}

function responseIdentity(binding, hostConnectionId) {
  return { protocol_version: PAIRING_PROTOCOL_VERSION, ...binding, host_connection_id: hostConnectionId };
}

function normalizeTab(tab) {
  // Tabs without IDs cannot later be targeted safely, so omit only that entry rather than fail the list.
  if (!Number.isSafeInteger(tab?.id) || tab.id < 0 || !Number.isSafeInteger(tab?.windowId) || tab.windowId < 0) {
    return null;
  }
  const normalized = {
    id: tab.id,
    window_id: tab.windowId,
    title: tab.title === undefined ? null : tab.title,
    url: tab.url === undefined ? null : tab.url,
    active: tab?.active,
  };
  if ((normalized.title !== null && typeof normalized.title !== "string") ||
    (normalized.url !== null && typeof normalized.url !== "string") ||
    (typeof normalized.title === "string" && normalized.title.length > 4_096) ||
    (typeof normalized.url === "string" && normalized.url.length > 8_192) ||
    typeof normalized.active !== "boolean") fail();
  return normalized;
}

export function startPairing(binding) {
  if (binding === null || binding === undefined) {
    return { type: "pair_start", protocol_version: PAIRING_PROTOCOL_VERSION };
  }
  validateBinding(binding);
  return { type: "resume_start", protocol_version: PAIRING_PROTOCOL_VERSION, ...binding };
}

export function validatePairChallenge(message, { binding }) {
  exactFields(message, [
    "type",
    "protocol_version",
    ...BINDING_FIELDS,
    "host_connection_id",
    "pairing_mode",
  ]);
  if (message.type !== "pair_challenge" || message.protocol_version !== PAIRING_PROTOCOL_VERSION) fail();
  validateBinding(identityOf(message));
  validateConnectionId(message.host_connection_id);
  const expectedMode = binding === null || binding === undefined ? "initial" : "resume";
  if (message.pairing_mode !== expectedMode) fail();
  if (expectedMode === "resume") validateIdentity(message, binding);
  return {
    binding: identityOf(message),
    hostConnectionId: message.host_connection_id,
    mode: expectedMode,
  };
}

export function createPairAck(challenge) {
  if (!challenge || !validateBinding(challenge.binding) || !nonEmptyString(challenge.hostConnectionId)) fail();
  return {
    type: "pair_ack",
    protocol_version: PAIRING_PROTOCOL_VERSION,
    ...challenge.binding,
    host_connection_id: challenge.hostConnectionId,
  };
}

export function validatePairActive(message, challenge) {
  exactFields(message, ["type", "protocol_version", ...BINDING_FIELDS, "host_connection_id"]);
  if (message.type !== "pair_active" || message.protocol_version !== PAIRING_PROTOCOL_VERSION) fail();
  validateBinding(identityOf(message));
  if (!challenge || message.host_connection_id !== challenge.hostConnectionId) fail();
  validateIdentity(message, challenge.binding);
  return identityOf(message);
}

export function respondToPing(message, binding, hostConnectionId) {
  exactFields(message, ["type", "request_id", "protocol_version", ...BINDING_FIELDS, "host_connection_id"]);
  if (message.type !== "ping_request" || message.protocol_version !== PAIRING_PROTOCOL_VERSION || !nonEmptyString(message.request_id)) fail();
  validateIdentity(message, binding);
  validateConnectionId(message.host_connection_id);
  if (message.host_connection_id !== hostConnectionId) fail();
  return { type: "ping_response", request_id: message.request_id, protocol_version: PAIRING_PROTOCOL_VERSION, ...binding, host_connection_id: message.host_connection_id };
}

export function respondToBrowserStatus(message, binding, hostConnectionId, { chromeTabsAvailable }) {
  validateBrowserRequest(message, binding, hostConnectionId, "browser_status");
  return assertResponseSize({
    type: "browser_status_response",
    request_id: message.request_id,
    ...responseIdentity(binding, hostConnectionId),
    status: { extension_connected: true, chrome_tabs_available: Boolean(chromeTabsAvailable) },
  });
}

export function respondToTabsList(message, binding, hostConnectionId, tabs) {
  validateBrowserRequest(message, binding, hostConnectionId, "tabs_list");
  if (!Array.isArray(tabs)) fail();
  return assertResponseSize({
    type: "tabs_list_response",
    request_id: message.request_id,
    ...responseIdentity(binding, hostConnectionId),
    tabs: tabs.map(normalizeTab).filter((tab) => tab !== null),
  });
}

export function validateNavigateRequest(message, binding, hostConnectionId) {
  return validateBrowserRequest(message, binding, hostConnectionId, "navigate");
}

export function respondToNavigate(message, binding, hostConnectionId, tabId) {
  const target = validateNavigateRequest(message, binding, hostConnectionId);
  if (tabId !== target.tabId) fail();
  return assertResponseSize({
    type: "navigate_response",
    request_id: message.request_id,
    ...responseIdentity(binding, hostConnectionId),
    tab_id: tabId,
  });
}

export function respondToBrowserError(message, binding, hostConnectionId, command, errorCode) {
  validateBrowserRequest(message, binding, hostConnectionId, command);
  if (!nonEmptyString(errorCode) || errorCode.length > 128) fail();
  return assertResponseSize({
    type: "browser_error_response",
    request_id: message.request_id,
    ...responseIdentity(binding, hostConnectionId),
    command,
    error_code: errorCode,
  });
}
