import assert from "node:assert/strict";
import test from "node:test";
import {
  PAIRING_STATES,
  PairingProtocolError,
  createPairingState,
  disconnectPairingConnection,
  expirePairingState,
  issuePairingPing,
  issueBrowserCommand,
  cancelBrowserCommand,
  reducePairingMessage,
} from "../core/pairing-state-machine.mjs";

const descriptor = Object.freeze({
  session_id: "session-a",
  browser_instance_id: "browser-a",
  profile_instance_id: "profile-a",
  generation: 7,
  lease_id: "lease-a",
  pairing_nonce: "nonce-a",
  expires_at: "2030-01-01T01:00:00.000Z",
});

function identity(connectionId) {
  return {
    protocol_version: 1,
    session_id: descriptor.session_id,
    browser_instance_id: descriptor.browser_instance_id,
    profile_instance_id: descriptor.profile_instance_id,
    generation: descriptor.generation,
    lease_id: descriptor.lease_id,
    host_connection_id: connectionId,
  };
}

function register(connectionId = "connection-a") {
  return { type: "host_register", ...identity(connectionId), pairing_nonce: descriptor.pairing_nonce };
}

function ack(connectionId = "connection-a") {
  return { type: "pair_ack", ...identity(connectionId) };
}

function resume(connectionId = "connection-b") {
  return { type: "resume", ...identity(connectionId) };
}

function ping(connectionId = "connection-a", requestId = "request-a") {
  return { type: "transport_probe_request", ...identity(connectionId), request_id: requestId };
}

function activeState() {
  const registered = reducePairingMessage(createPairingState(descriptor), register());
  return reducePairingMessage(registered.state, ack()).state;
}

test("initial pairing consumes the nonce, then allows only the acknowledged connection to ping", () => {
  const issued = createPairingState(descriptor);
  const registered = reducePairingMessage(issued, register());
  assert.equal(registered.state.phase, PAIRING_STATES.PAIRING);
  assert.equal(registered.state.nonceConsumed, true);
  assert.deepEqual(registered.effects[0].message, {
    type: "pair_challenge",
    ...identity("connection-a"),
    pairing_mode: "initial",
  });

  assert.throws(() => reducePairingMessage(registered.state, register()), PairingProtocolError);
  const active = reducePairingMessage(registered.state, ack()).state;
  const roundtrip = reducePairingMessage(active, ping());
  assert.equal(roundtrip.effects.length, 1);
  assert.deepEqual(roundtrip.effects[0].message, {
    type: "transport_probe_response",
    ...identity("connection-a"),
    request_id: "request-a",
  });
});

test("identity, nonce, connection, and message ordering violations fail closed", () => {
  const issued = createPairingState(descriptor);
  for (const candidate of [
    { ...register(), pairing_nonce: "wrong" },
    { ...register(), generation: 8 },
    { ...register(), extra: true },
    ack(),
    ping(),
  ]) {
    assert.throws(() => reducePairingMessage(issued, candidate), PairingProtocolError);
  }

  const active = activeState();
  for (const candidate of [
    ack(),
    ping("connection-b"),
    { ...ping(), request_id: "" },
    { ...resume("connection-a") },
  ]) {
    assert.throws(() => reducePairingMessage(active, candidate), PairingProtocolError);
  }
});

test("initial candidate loss revokes while resume loss keeps the old active connection", () => {
  const registered = reducePairingMessage(createPairingState(descriptor), register()).state;
  const revoked = disconnectPairingConnection(registered, "connection-a").state;
  assert.equal(revoked.phase, PAIRING_STATES.REVOKED);
  assert.equal(revoked.nonceConsumed, true);
  assert.throws(() => reducePairingMessage(revoked, register()), PairingProtocolError);

  const active = activeState();
  const candidate = reducePairingMessage(active, resume()).state;
  const restored = disconnectPairingConnection(candidate, "connection-b").state;
  assert.equal(restored.phase, PAIRING_STATES.ACTIVE);
  assert.equal(restored.activeConnectionId, "connection-a");
  assert.equal(restored.candidateConnectionId, null);
  assert.equal(reducePairingMessage(restored, ping()).effects.length, 1);
});

test("resume fences the old connection only after the new candidate acknowledges", () => {
  const candidate = reducePairingMessage(activeState(), resume());
  assert.equal(candidate.state.activeConnectionId, "connection-a");
  assert.equal(candidate.state.candidateConnectionId, "connection-b");
  assert.equal(candidate.effects[0].message.pairing_mode, "resume");

  const resumed = reducePairingMessage(candidate.state, ack("connection-b"));
  assert.equal(resumed.state.activeConnectionId, "connection-b");
  assert.deepEqual(resumed.effects, [
    {
      type: "send",
      connectionId: "connection-b",
      message: { type: "pair_active", ...identity("connection-b") },
    },
    { type: "fence", connectionId: "connection-a" },
  ]);
  assert.throws(() => reducePairingMessage(resumed.state, ping("connection-a")), PairingProtocolError);
  assert.equal(reducePairingMessage(resumed.state, ping("connection-b")).effects.length, 1);
});

test("issued pairing pings resolve only for the active identity and pending request", () => {
  const issued = issuePairingPing(activeState(), { requestId: "request-ping" });
  assert.equal(issued.state.pendingRequestIds.length, 1);
  assert.equal(issued.effects[0].message.type, "ping_request");
  assert.throws(() => issuePairingPing(issued.state, { requestId: "request-ping" }), PairingProtocolError);
  assert.throws(() => reducePairingMessage(issued.state, { ...issued.effects[0].message, type: "ping_response", request_id: "wrong" }), PairingProtocolError);
  const resolved = reducePairingMessage(issued.state, { ...issued.effects[0].message, type: "ping_response" });
  assert.deepEqual(resolved.state.pendingRequestIds, []);
  assert.deepEqual(resolved.effects, [{ type: "ping_resolved", requestId: "request-ping" }]);
});

test("browser commands preserve identity, correlate responses, and reject timeout without retry", () => {
  const issued = issueBrowserCommand(activeState(), { command: "browser_status", requestId: "status-1" });
  assert.deepEqual(issued.effects[0].message, {
    type: "browser_status_request",
    ...identity("connection-a"),
    request_id: "status-1",
  });
  assert.throws(
    () => reducePairingMessage(issued.state, {
      type: "browser_status_response",
      ...identity("connection-a"),
      request_id: "wrong-request",
      status: { extension_connected: true, chrome_tabs_available: true },
    }),
    PairingProtocolError,
  );
  const completed = reducePairingMessage(issued.state, {
    type: "browser_status_response",
    ...identity("connection-a"),
    request_id: "status-1",
    status: { extension_connected: true, chrome_tabs_available: true },
  });
  assert.deepEqual(completed.effects, [{
    type: "browser_resolved",
    requestId: "status-1",
    response: { ok: true, status: { extension_connected: true, chrome_tabs_available: true } },
  }]);

  const tabs = issueBrowserCommand(activeState(), { command: "tabs_list", requestId: "tabs-1" });
  const cancelled = cancelBrowserCommand(tabs.state, "tabs-1");
  assert.deepEqual(cancelled.effects, [{
    type: "browser_rejected",
    requestId: "tabs-1",
    response: { ok: false, errorCode: "timeout" },
  }]);
  assert.throws(() => issueBrowserCommand(activeState(), { command: "navigate", requestId: "nope" }), PairingProtocolError);
});

test("expiration revokes ISSUED, PAIRING, and ACTIVE at the inclusive descriptor boundary", () => {
  const boundary = new Date(descriptor.expires_at);
  const issued = expirePairingState(createPairingState(descriptor), boundary);
  assert.equal(issued.state.phase, PAIRING_STATES.REVOKED);
  assert.deepEqual(issued.effects, []);

  const beforeExpiry = new Date("2030-01-01T00:00:00.000Z");
  const pairingState = reducePairingMessage(createPairingState(descriptor), register(), { now: beforeExpiry }).state;
  const pairing = expirePairingState(pairingState, boundary);
  assert.equal(pairing.state.phase, PAIRING_STATES.REVOKED);
  assert.deepEqual(pairing.effects, [{ type: "fence", connectionId: "connection-a" }]);

  const active = reducePairingMessage(pairingState, ack(), { now: beforeExpiry }).state;
  const activeExpiry = expirePairingState(active, boundary);
  assert.equal(activeExpiry.state.phase, PAIRING_STATES.REVOKED);
  assert.deepEqual(activeExpiry.effects, [{ type: "fence", connectionId: "connection-a" }]);
  assert.throws(() => reducePairingMessage(activeExpiry.state, ping(), { now: boundary }), PairingProtocolError);
});

test("expiration fences both active and resume candidates without affecting another instance", () => {
  const beforeExpiry = new Date("2030-01-01T00:00:00.000Z");
  const aCandidate = reducePairingMessage(activeState(), resume(), { now: beforeExpiry }).state;
  const aExpiry = expirePairingState(aCandidate, new Date(descriptor.expires_at));
  assert.deepEqual(aExpiry.effects, [
    { type: "fence", connectionId: "connection-a" },
    { type: "fence", connectionId: "connection-b" },
  ]);

  const descriptorB = { ...descriptor, session_id: "session-b", browser_instance_id: "browser-b", profile_instance_id: "profile-b" };
  const bIssued = createPairingState(descriptorB);
  const bExpiry = expirePairingState(bIssued, new Date(descriptor.expires_at));
  assert.equal(bExpiry.state.phase, PAIRING_STATES.REVOKED);
  assert.equal(aCandidate.phase, PAIRING_STATES.ACTIVE);
  assert.equal(aCandidate.activeConnectionId, "connection-a");
});

test("a host connection ID remains fenced after A then B then attempted A reuse", () => {
  const active = activeState();
  const resumed = reducePairingMessage(active, resume()).state;
  const withB = reducePairingMessage(resumed, ack("connection-b")).state;
  const disconnected = disconnectPairingConnection(withB, "connection-b").state;
  assert.deepEqual(disconnected.usedConnectionIds, ["connection-a", "connection-b"]);
  assert.throws(() => reducePairingMessage(disconnected, resume("connection-a")), PairingProtocolError);
  assert.throws(() => reducePairingMessage(disconnected, resume("connection-b")), PairingProtocolError);
});

test("A and B are independent even when B fails before A starts", () => {
  const descriptorB = { ...descriptor, session_id: "session-b", browser_instance_id: "browser-b", profile_instance_id: "profile-b", pairing_nonce: "nonce-b" };
  const bIssued = createPairingState(descriptorB);
  assert.throws(() => reducePairingMessage(bIssued, register()), PairingProtocolError);
  assert.equal(bIssued.phase, PAIRING_STATES.ISSUED);

  const aActive = activeState();
  assert.equal(aActive.phase, PAIRING_STATES.ACTIVE);
  assert.equal(reducePairingMessage(aActive, ping()).effects[0].message.request_id, "request-a");
});
