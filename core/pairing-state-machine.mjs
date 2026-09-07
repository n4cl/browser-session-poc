import { PAIRING_IDENTITY_FIELDS, PAIRING_PROTOCOL_VERSION } from "./pairing-protocol.mjs";
import {
  BROWSER_COMMANDS,
  BROWSER_COMMAND_USED_REQUEST_ID_MAX,
  createBrowserCommandRequest,
  validateBrowserCommandResponse,
} from "./browser-command-protocol.mjs";

export { PAIRING_PROTOCOL_VERSION } from "./pairing-protocol.mjs";

export const PAIRING_STATES = Object.freeze({
  ISSUED: "ISSUED",
  PAIRING: "PAIRING",
  ACTIVE: "ACTIVE",
  REVOKED: "REVOKED",
});

const IDENTITY_FIELDS = PAIRING_IDENTITY_FIELDS;

export class PairingProtocolError extends Error {
  constructor(message = "pairing protocol violation") {
    super(message);
    this.name = "PairingProtocolError";
  }
}

function fail(message) {
  throw new PairingProtocolError(message);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function assertExactFields(message, fields) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    fail("message must be an object");
  }
  const actual = Object.keys(message).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail("message has an unexpected schema");
  }
}

function assertMessageIdentity(message, binding, { connectionId = undefined } = {}) {
  if (message.protocol_version !== PAIRING_PROTOCOL_VERSION) {
    fail("unsupported protocol version");
  }
  for (const field of IDENTITY_FIELDS) {
    if (message[field] !== binding[field]) {
      fail("message identity does not match the session binding");
    }
  }
  if (!isNonEmptyString(message.host_connection_id)) {
    fail("host connection id is invalid");
  }
  if (connectionId !== undefined && message.host_connection_id !== connectionId) {
    fail("message connection does not match the active pairing");
  }
}

function identityMessage(binding, hostConnectionId) {
  return {
    protocol_version: PAIRING_PROTOCOL_VERSION,
    ...binding,
    host_connection_id: hostConnectionId,
  };
}

function withChallenge(binding, hostConnectionId, mode) {
  return {
    type: "pair_challenge",
    ...identityMessage(binding, hostConnectionId),
    pairing_mode: mode,
  };
}

function withActive(binding, hostConnectionId) {
  return {
    type: "pair_active",
    ...identityMessage(binding, hostConnectionId),
  };
}

function assertDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== "object") {
    throw new TypeError("descriptor must be an object");
  }
  for (const field of IDENTITY_FIELDS) {
    if ((field === "generation" && (!Number.isSafeInteger(descriptor[field]) || descriptor[field] <= 0)) ||
      (field !== "generation" && !isNonEmptyString(descriptor[field]))) {
      throw new TypeError("descriptor binding is invalid");
    }
  }
  if (!isNonEmptyString(descriptor.pairing_nonce)) {
    throw new TypeError("descriptor pairing nonce is invalid");
  }
  const expiry = typeof descriptor.expires_at === "string" ? Date.parse(descriptor.expires_at) : Number.NaN;
  if (typeof descriptor.expires_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(descriptor.expires_at) ||
    !Number.isFinite(expiry) || new Date(expiry).toISOString() !== descriptor.expires_at) {
    throw new TypeError("descriptor expiration is invalid");
  }
}

function timestampOf(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
    throw new TypeError("clock must return a valid Date");
  }
  return now.valueOf();
}

function assertLive(state, now) {
  if (timestampOf(now) >= state.expiresAt) {
    fail("pairing lease has expired");
  }
}

function assertRegisterMessage(message, binding, nonce) {
  assertExactFields(message, ["type", "pairing_nonce", ...IDENTITY_FIELDS, "host_connection_id", "protocol_version"]);
  if (message.type !== "host_register") {
    fail("expected host_register");
  }
  assertMessageIdentity(message, binding);
  if (message.pairing_nonce !== nonce) {
    fail("pairing nonce does not match");
  }
}

function assertAckMessage(message, binding, connectionId) {
  assertExactFields(message, ["type", ...IDENTITY_FIELDS, "host_connection_id", "protocol_version"]);
  if (message.type !== "pair_ack") {
    fail("expected pair_ack");
  }
  assertMessageIdentity(message, binding, { connectionId });
}

function assertResumeMessage(message, binding) {
  assertExactFields(message, ["type", ...IDENTITY_FIELDS, "host_connection_id", "protocol_version"]);
  if (message.type !== "resume") {
    fail("expected resume");
  }
  assertMessageIdentity(message, binding);
}

function assertPingMessage(message, binding, connectionId) {
  assertExactFields(message, ["type", "request_id", ...IDENTITY_FIELDS, "host_connection_id", "protocol_version"]);
  if (message.type !== "ping_request") {
    fail("expected ping_request");
  }
  assertMessageIdentity(message, binding, { connectionId });
  if (!isNonEmptyString(message.request_id)) {
    fail("request id is invalid");
  }
}

function next(state, changes, effects = []) {
  return { state: { ...state, ...changes }, effects };
}

/**
 * Builds the side-effect-free state derived from one validated active descriptor.
 */
export function createPairingState(descriptor) {
  assertDescriptor(descriptor);
  return {
    phase: PAIRING_STATES.ISSUED,
    binding: Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, descriptor[field]])),
    pairingNonce: descriptor.pairing_nonce,
    nonceConsumed: false,
    activeConnectionId: null,
    candidateConnectionId: null,
    candidateKind: null,
    usedConnectionIds: [],
    pendingRequestIds: [],
    pendingBrowserRequests: [],
    usedBrowserRequestIds: [],
    expiresAt: Date.parse(descriptor.expires_at),
  };
}

/**
 * Applies one verified protocol message. Invalid input throws and leaves the caller's state unchanged.
 */
export function reducePairingMessage(state, message, { now = new Date() } = {}) {
  if (!state || !Object.values(PAIRING_STATES).includes(state.phase)) {
    throw new TypeError("pairing state is invalid");
  }
  assertLive(state, now);

  const { binding } = state;
  switch (message?.type) {
    case "host_register": {
      if (state.phase !== PAIRING_STATES.ISSUED || state.nonceConsumed) {
        fail("host registration is not permitted in the current state");
      }
      assertRegisterMessage(message, binding, state.pairingNonce);
      const connectionId = message.host_connection_id;
      if (state.usedConnectionIds.includes(connectionId)) {
        fail("host connection id has already been used");
      }
      return next(state, {
        phase: PAIRING_STATES.PAIRING,
        nonceConsumed: true,
        candidateConnectionId: connectionId,
        candidateKind: "initial",
        usedConnectionIds: [...state.usedConnectionIds, connectionId],
      }, [{ type: "send", connectionId, message: withChallenge(binding, connectionId, "initial") }]);
    }
    case "pair_ack": {
      if (![
        PAIRING_STATES.PAIRING,
        PAIRING_STATES.ACTIVE,
      ].includes(state.phase) || !state.candidateConnectionId) {
        fail("pair acknowledgement is not permitted in the current state");
      }
      assertAckMessage(message, binding, state.candidateConnectionId);
      const oldConnectionId = state.activeConnectionId;
      const connectionId = state.candidateConnectionId;
      const effects = [{ type: "send", connectionId, message: withActive(binding, connectionId) }];
      if (oldConnectionId !== null) {
        for (const requestId of state.pendingRequestIds) effects.push({ type: "ping_rejected", requestId });
        for (const { requestId } of state.pendingBrowserRequests) effects.push({ type: "browser_rejected", requestId });
        effects.push({ type: "fence", connectionId: oldConnectionId });
      }
      return next(state, {
        phase: PAIRING_STATES.ACTIVE,
        activeConnectionId: connectionId,
        candidateConnectionId: null,
        candidateKind: null,
        pendingRequestIds: oldConnectionId === null ? state.pendingRequestIds : [],
        pendingBrowserRequests: oldConnectionId === null ? state.pendingBrowserRequests : [],
      }, effects);
    }
    case "resume": {
      if (state.phase !== PAIRING_STATES.ACTIVE || state.candidateConnectionId !== null) {
        fail("resume is not permitted in the current state");
      }
      assertResumeMessage(message, binding);
      if (message.host_connection_id === state.activeConnectionId) {
        fail("resume requires a new host connection");
      }
      const connectionId = message.host_connection_id;
      if (state.usedConnectionIds.includes(connectionId)) {
        fail("host connection id has already been used");
      }
      return next(state, {
        candidateConnectionId: connectionId,
        candidateKind: "resume",
        usedConnectionIds: [...state.usedConnectionIds, connectionId],
      }, [{ type: "send", connectionId, message: withChallenge(binding, connectionId, "resume") }]);
    }
    case "ping_response": {
      if (state.phase !== PAIRING_STATES.ACTIVE || !state.activeConnectionId) fail("ping is not permitted in the current state");
      assertExactFields(message, ["type", "request_id", ...IDENTITY_FIELDS, "host_connection_id", "protocol_version"]);
      assertMessageIdentity(message, binding, { connectionId: state.activeConnectionId });
      if (!isNonEmptyString(message.request_id) || !state.pendingRequestIds.includes(message.request_id)) fail("ping response is not pending");
      return next(state, { pendingRequestIds: state.pendingRequestIds.filter((id) => id !== message.request_id) }, [
        { type: "ping_resolved", requestId: message.request_id },
      ]);
    }
    case "browser_status_response":
    case "tabs_list_response":
    case "navigate_response":
    case "browser_error_response": {
      if (state.phase !== PAIRING_STATES.ACTIVE || !state.activeConnectionId) {
        fail("browser command is not permitted in the current state");
      }
      const requestId = message?.request_id;
      const pending = state.pendingBrowserRequests.find((candidate) => candidate.requestId === requestId);
      if (!pending) fail("browser command response is not pending");
      let response;
      try {
        response = validateBrowserCommandResponse(message, {
          command: pending.command,
          requestId: pending.requestId,
          binding,
          connectionId: state.activeConnectionId,
          target: pending.target,
        });
      } catch {
        fail("browser command response is invalid");
      }
      return next(state, {
        pendingBrowserRequests: state.pendingBrowserRequests.filter((candidate) => candidate.requestId !== requestId),
      }, [{ type: response.ok ? "browser_resolved" : "browser_rejected", requestId, response }]);
    }
    case "transport_probe_request": {
      if (state.phase !== PAIRING_STATES.ACTIVE || !state.activeConnectionId) {
        fail("ping is not permitted in the current state");
      }
      assertPingMessage({ ...message, type: "ping_request" }, binding, state.activeConnectionId);
      return next(state, {}, [{
        type: "send",
        connectionId: state.activeConnectionId,
        message: {
          type: "transport_probe_response",
          ...identityMessage(binding, state.activeConnectionId),
          request_id: message.request_id,
        },
      }]);
    }
    default:
      fail("message type is not permitted");
  }
}

export function issuePairingPing(state, { requestId }) {
  if (state.phase !== PAIRING_STATES.ACTIVE || !state.activeConnectionId || !isNonEmptyString(requestId)) {
    fail("ping is not permitted in the current state");
  }
  if (state.pendingRequestIds.includes(requestId) || state.pendingBrowserRequests.some((candidate) => candidate.requestId === requestId)) {
    fail("ping request id is already pending");
  }
  return next(state, { pendingRequestIds: [...state.pendingRequestIds, requestId] }, [{
    type: "send",
    connectionId: state.activeConnectionId,
    message: { type: "ping_request", ...identityMessage(state.binding, state.activeConnectionId), request_id: requestId },
  }]);
}

export function cancelPairingPing(state, requestId) {
  if (!state.pendingRequestIds.includes(requestId)) return next(state, {});
  return next(state, { pendingRequestIds: state.pendingRequestIds.filter((id) => id !== requestId) }, [
    { type: "ping_rejected", requestId },
  ]);
}

/** Issues one Gate 3 browser command over the currently fenced active transport. */
export function issueBrowserCommand(state, { command, requestId, target = undefined }) {
  if (state.phase !== PAIRING_STATES.ACTIVE || !state.activeConnectionId || !BROWSER_COMMANDS.includes(command)) {
    fail("browser command is not permitted in the current state");
  }
  if (state.pendingRequestIds.includes(requestId) || state.pendingBrowserRequests.some((candidate) => candidate.requestId === requestId) ||
    state.usedBrowserRequestIds.includes(requestId)) {
    fail("browser command request id is already pending");
  }
  let message;
  try {
    message = createBrowserCommandRequest({ command, requestId, binding: state.binding, connectionId: state.activeConnectionId, target });
  } catch {
    fail("browser command target is invalid");
  }
  if (state.usedBrowserRequestIds.length >= BROWSER_COMMAND_USED_REQUEST_ID_MAX) {
    fail("browser command request id capacity is exhausted");
  }
  return next(state, {
    pendingBrowserRequests: [...state.pendingBrowserRequests, { command, requestId, target }],
    usedBrowserRequestIds: [...state.usedBrowserRequestIds, requestId],
  }, [{ type: "send", connectionId: state.activeConnectionId, message }]);
}

export function cancelBrowserCommand(state, requestId) {
  const pending = state.pendingBrowserRequests.find((candidate) => candidate.requestId === requestId);
  if (!pending) return next(state, {});
  return next(state, {
    pendingBrowserRequests: state.pendingBrowserRequests.filter((candidate) => candidate.requestId !== requestId),
  }, [{
    type: "browser_rejected",
    requestId,
    response: { ok: false, errorCode: pending.command === "navigate" ? "outcome_unknown" : "timeout" },
  }]);
}

/**
 * Revokes the lease at its inclusive expiry boundary and identifies any active transport connections
 * that must be fenced by the caller.
 */
export function expirePairingState(state, now = new Date()) {
  if (!state || !Object.values(PAIRING_STATES).includes(state.phase)) {
    throw new TypeError("pairing state is invalid");
  }
  if (timestampOf(now) < state.expiresAt || state.phase === PAIRING_STATES.REVOKED) {
    return next(state, {});
  }
  const connectionIds = [...new Set([state.activeConnectionId, state.candidateConnectionId].filter(Boolean))];
  return next(state, {
    phase: PAIRING_STATES.REVOKED,
    activeConnectionId: null,
    candidateConnectionId: null,
    candidateKind: null,
  }, connectionIds.map((connectionId) => ({ type: "fence", connectionId })));
}

/**
 * Models transport loss without performing any I/O. A lost initial candidate revokes the descriptor;
 * a lost resume candidate leaves the existing active connection unchanged.
 */
export function disconnectPairingConnection(state, connectionId) {
  if (!isNonEmptyString(connectionId)) {
    throw new TypeError("host connection id is invalid");
  }
  if (state.phase === PAIRING_STATES.PAIRING && state.candidateConnectionId === connectionId) {
    return next(state, {
      phase: PAIRING_STATES.REVOKED,
      candidateConnectionId: null,
      candidateKind: null,
    });
  }
  if (state.phase === PAIRING_STATES.ACTIVE && state.candidateConnectionId === connectionId) {
    return next(state, { candidateConnectionId: null, candidateKind: null });
  }
  if (state.phase === PAIRING_STATES.ACTIVE && state.activeConnectionId === connectionId) {
    return next(state, { activeConnectionId: null });
  }
  return next(state, {});
}
