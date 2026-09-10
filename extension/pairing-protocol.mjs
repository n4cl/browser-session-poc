export const PAIRING_PROTOCOL_VERSION = 1;
export const PAIRING_WAKE_MESSAGE_TYPE = "pairing_wake";
export const BROWSER_COMMAND_RESPONSE_MAX_BYTES = 64 * 1024;
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
const BROWSER_COMMANDS = Object.freeze(["browser_status", "tabs_list", "navigate", "snapshot"]);

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

export function validateRebindRequired(message) {
  exactFields(message, ["type", "protocol_version"]);
  if (message.type !== "rebind_required" || message.protocol_version !== PAIRING_PROTOCOL_VERSION) fail();
  return true;
}

export function createPairingWake() {
  return {
    type: PAIRING_WAKE_MESSAGE_TYPE,
    protocol_version: PAIRING_PROTOCOL_VERSION,
  };
}

export function validatePairingWake(message) {
  exactFields(message, ["type", "protocol_version"]);
  if (message.type !== PAIRING_WAKE_MESSAGE_TYPE || message.protocol_version !== PAIRING_PROTOCOL_VERSION) fail();
  return true;
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
    url.length > NAVIGATE_URL_MAX_LENGTH || url.trim() !== url || /[\u0000-\u001F\u007F]/.test(url) || /\s/u.test(url)) fail();
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
  if (!BROWSER_COMMANDS.includes(command)) fail();
  const extraFields = command === "navigate" ? ["tab_id", "url"] : command === "snapshot" ? ["tab_id"] : [];
  exactFields(message, ["type", "request_id", "protocol_version", ...BINDING_FIELDS, "host_connection_id", ...extraFields]);
  if (message.type !== `${command}_request` || !nonEmptyString(message.request_id) || message.request_id.length > 128) fail();
  validateIdentity(message, binding);
  validateConnectionId(message.host_connection_id);
  if (message.host_connection_id !== hostConnectionId) fail();
  if (command === "navigate") return validateNavigateTarget({ tabId: message.tab_id, url: message.url });
  if (command === "snapshot") {
    if (!Number.isSafeInteger(message.tab_id) || message.tab_id < 0) fail();
    return { tabId: message.tab_id };
  }
  return undefined;
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

function boundedText(value) {
  if (value === undefined || value === null) return { value: null, truncated: false };
  if (typeof value !== "string") return { value: null, truncated: true };
  return {
    value: value.slice(0, SNAPSHOT_TEXT_MAX_LENGTH),
    truncated: value.length > SNAPSHOT_TEXT_MAX_LENGTH,
  };
}

function axValue(value) {
  return boundedText(value?.value);
}

function axBoolean(properties, name) {
  const property = Array.isArray(properties)
    ? properties.find((candidate) => candidate?.name === name)?.value?.value
    : undefined;
  return property === true;
}

/** Converts only the small AX subset needed by later interaction tools; raw CDP objects never cross the protocol. */
export function normalizeSnapshot({ tabId, frameTree, axNodes }) {
  const loaderId = frameTree?.frame?.loaderId;
  const rootFrameId = frameTree?.frame?.id;
  if (!Number.isSafeInteger(tabId) || tabId < 0 || !nonEmptyString(loaderId) || loaderId.length > SNAPSHOT_LOADER_ID_MAX_LENGTH || !Array.isArray(axNodes)) fail();
  const candidates = [];
  const byNodeId = new Map();
  const rawByNodeId = new Map();
  const duplicateNodeIds = new Set();
  let truncated = false;
  for (const raw of axNodes) {
    if (!raw || typeof raw !== "object" || typeof raw.nodeId !== "string" || raw.nodeId.length === 0) {
      truncated = true;
      continue;
    }
    if (rawByNodeId.has(raw.nodeId)) {
      duplicateNodeIds.add(raw.nodeId);
      truncated = true;
      continue;
    }

    const record = {
      raw,
      nodeId: raw.nodeId,
      parentId: raw.parentId === undefined ? null : raw.parentId,
      frameMismatch: raw.frameId !== undefined && (rootFrameId === undefined || raw.frameId !== rootFrameId),
      ignored: raw.ignored === true,
      eligible: false,
    };
    rawByNodeId.set(record.nodeId, record);
    if (record.frameMismatch) {
      truncated = true;
      continue;
    }
    if (record.ignored) {
      truncated = true;
      continue;
    }
    const role = axValue(raw.role);
    if (role.value === null || role.value.length === 0) {
      truncated = true;
      continue;
    }
    const name = axValue(raw.name);
    const value = axValue(raw.value);
    const backend = raw.backendDOMNodeId;
    if (backend !== undefined && (!Number.isSafeInteger(backend) || backend <= 0)) {
      truncated = true;
      continue;
    }
    const candidate = {
      raw,
      nodeId: raw.nodeId,
      parentId: record.parentId,
      role: role.value,
      name: name.value,
      value: value.value,
      backend_dom_node_id: backend ?? null,
      textTruncated: role.truncated || name.truncated || value.truncated,
      sourceIndex: candidates.length,
    };
    record.eligible = true;
    record.candidate = candidate;
    byNodeId.set(candidate.nodeId, candidate);
    candidates.push(candidate);
    truncated ||= candidate.textTruncated;
  }

  // Compute depth without trusting CDP parent order. Cycles are treated as partial
  // input and never become a parent relationship in the normalized tree.
  const depthById = new Map();
  const cycleIds = new Set();
  let partial = false;
  // Ignored AX nodes are structural only: walk through them, but never through
  // unknown, excluded, or other-frame records when resolving an output parent.
  const resolveParent = (candidate) => {
    const visiting = new Set();
    let parentId = candidate.parentId;
    while (parentId !== null) {
      if (visiting.has(parentId) || duplicateNodeIds.has(parentId)) {
        return { ok: false };
      }
      visiting.add(parentId);
      const parent = rawByNodeId.get(parentId);
      if (!parent || parent.frameMismatch || (!parent.ignored && !parent.eligible)) {
        return { ok: false };
      }
      if (parent.eligible) {
        return { ok: true, parentId };
      }
      parentId = parent.parentId;
    }
    return { ok: true, parentId: null };
  };
  for (const candidate of candidates) {
    const resolved = resolveParent(candidate);
    if (!resolved.ok) {
      candidate.parentResolutionFailed = true;
      truncated = true;
      partial = true;
    } else {
      candidate.parentId = resolved.parentId;
    }
  }
  const computeDepth = (candidate, visiting = new Set()) => {
    if (depthById.has(candidate.nodeId)) return depthById.get(candidate.nodeId);
    if (candidate.parentResolutionFailed) {
      depthById.set(candidate.nodeId, Number.POSITIVE_INFINITY);
      return Number.POSITIVE_INFINITY;
    }
    if (visiting.has(candidate.nodeId)) {
      for (const id of visiting) cycleIds.add(id);
      partial = true;
      return Number.POSITIVE_INFINITY;
    }
    visiting.add(candidate.nodeId);
    let depth = 0;
    if (candidate.parentId !== null) {
      const parent = byNodeId.get(candidate.parentId);
      if (!parent) {
        partial = true;
      } else {
        depth = computeDepth(parent, visiting) + 1;
      }
    }
    visiting.delete(candidate.nodeId);
    depthById.set(candidate.nodeId, depth);
    return depth;
  };
  for (const candidate of candidates) computeDepth(candidate);
  if (cycleIds.size > 0) truncated = true;

  const selected = new Set();
  const ordered = [...candidates].sort((left, right) => {
    const depth = (depthById.get(left.nodeId) ?? Number.POSITIVE_INFINITY) - (depthById.get(right.nodeId) ?? Number.POSITIVE_INFINITY);
    return Number.isNaN(depth) || depth === 0 ? left.sourceIndex - right.sourceIndex : depth || left.sourceIndex - right.sourceIndex;
  });
  for (const candidate of ordered) {
    const depth = depthById.get(candidate.nodeId);
    if (cycleIds.has(candidate.nodeId) || !Number.isFinite(depth) || depth > SNAPSHOT_DEPTH_MAX) {
      truncated = true;
      partial = true;
      continue;
    }
    if (candidate.parentId !== null && !selected.has(candidate.parentId)) {
      // A missing/excluded parent must not leave an invalid parent_ref. Keep the
      // omission visible via partial and omit the child as well.
      truncated = true;
      partial = true;
      continue;
    }
    if (selected.size >= SNAPSHOT_NODE_MAX) {
      truncated = true;
      partial = true;
      continue;
    }
    selected.add(candidate.nodeId);
  }

  // Keep parents before children so later transport-size pruning can remove a
  // suffix without leaving a parent_ref that points at an omitted node.
  const selectedCandidates = ordered.filter((candidate) => selected.has(candidate.nodeId));
  const refs = new Map(selectedCandidates.map((candidate, index) => [candidate.nodeId, index + 1]));
  const nodes = selectedCandidates.map((candidate) => ({
    ref: refs.get(candidate.nodeId),
    parent_ref: candidate.parentId === null ? null : refs.get(candidate.parentId) ?? null,
    backend_dom_node_id: candidate.backend_dom_node_id,
    role: candidate.role,
    name: candidate.name,
    value: candidate.value,
    state: {
      disabled: axBoolean(candidate.raw.properties, "disabled"),
      expanded: axBoolean(candidate.raw.properties, "expanded"),
      focused: axBoolean(candidate.raw.properties, "focused"),
      hidden: axBoolean(candidate.raw.properties, "hidden"),
    },
  }));
  return { tab_id: tabId, document: { loader_id: loaderId }, nodes, truncated, partial };
}

function compactSnapshot(snapshot, envelope) {
  let nodes = snapshot.nodes;
  let truncated = snapshot.truncated;
  while (true) {
    const candidate = { ...snapshot, nodes, truncated };
    // Leave room for the fixed response envelope (identity and request ID).
    if (new TextEncoder().encode(JSON.stringify({ ...envelope, ...candidate })).byteLength <= BROWSER_COMMAND_RESPONSE_MAX_BYTES) {
      return candidate;
    }
    if (nodes.length === 0) {
      const error = new Error("browser command response exceeds transport limit");
      error.code = "response_too_large";
      throw error;
    }
    nodes = nodes.slice(0, -1).map((node, index) => ({ ...node, ref: index + 1 }));
    truncated = true;
  }
}

export function validateSnapshotRequest(message, binding, hostConnectionId) {
  return validateBrowserRequest(message, binding, hostConnectionId, "snapshot");
}

export function respondToSnapshot(message, binding, hostConnectionId, snapshot) {
  const target = validateSnapshotRequest(message, binding, hostConnectionId);
  if (snapshot?.tab_id !== target.tabId) fail();
  const envelope = { type: "snapshot_response", request_id: message.request_id, ...responseIdentity(binding, hostConnectionId) };
  const payload = {
    tab_id: snapshot.tab_id,
    document: snapshot.document,
    nodes: snapshot.nodes,
    truncated: snapshot.truncated,
    partial: snapshot.partial,
  };
  const compacted = compactSnapshot(payload, envelope);
  return assertResponseSize({ ...envelope, ...compacted });
}

export function respondToBrowserError(message, binding, hostConnectionId, command, errorCode) {
  validateBrowserRequest(message, binding, hostConnectionId, command);
  if (!BROWSER_ERROR_CODES.includes(errorCode)) fail();
  return assertResponseSize({
    type: "browser_error_response",
    request_id: message.request_id,
    ...responseIdentity(binding, hostConnectionId),
    command,
    error_code: errorCode,
  });
}
