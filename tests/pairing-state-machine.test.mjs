import assert from "node:assert/strict";
import test from "node:test";
import {
  PAIRING_STATES,
  PairingProtocolError,
  createPairingState,
  disconnectPairingConnection,
  expirePairingState,
  issuePairingPing,
  issueExtensionReload,
  cancelExtensionReload,
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

test("Extension reload is sent once and resolves only after a different resumed connection is active", () => {
  const issued = issueExtensionReload(activeState(), { requestId: "reload-1" });
  assert.deepEqual(issued.effects, [{
    type: "send",
    connectionId: "connection-a",
    message: {
      type: "extension_reload_request",
      request_id: "reload-1",
      ...identity("connection-a"),
    },
  }]);
  assert.equal(issued.state.pendingExtensionReload.connectionId, "connection-a");
  assert.throws(() => issueExtensionReload(issued.state, { requestId: "reload-2" }), PairingProtocolError);

  const candidate = reducePairingMessage(issued.state, resume());
  assert.equal(candidate.state.activeConnectionId, "connection-a");
  assert.equal(candidate.state.pendingExtensionReload.requestId, "reload-1");
  const resumed = reducePairingMessage(candidate.state, ack("connection-b"));
  assert.equal(resumed.state.activeConnectionId, "connection-b");
  assert.equal(resumed.state.pendingExtensionReload, null);
  assert.deepEqual(resumed.effects.at(-1), { type: "extension_reload_resolved", requestId: "reload-1" });
});

test("Extension reload cancellation is a fixed failure and prevents request reuse", () => {
  const issued = issueExtensionReload(activeState(), { requestId: "reload-timeout" });
  const cancelled = cancelExtensionReload(issued.state, "reload-timeout", "reload_timeout");
  assert.deepEqual(cancelled.effects, [{
    type: "extension_reload_rejected",
    requestId: "reload-timeout",
    errorCode: "reload_timeout",
  }]);
  assert.equal(cancelled.state.pendingExtensionReload, null);
  assert.throws(() => issueExtensionReload(cancelled.state, { requestId: "reload-timeout" }), PairingProtocolError);
});

test("Extension reload lease expiry rejects the waiter without any retry effect", () => {
  const issued = issueExtensionReload(activeState(), { requestId: "reload-lease" });
  const expired = expirePairingState(issued.state, new Date(descriptor.expires_at));
  assert.equal(expired.state.phase, PAIRING_STATES.REVOKED);
  assert.equal(expired.state.pendingExtensionReload, null);
  assert.deepEqual(expired.effects.at(-1), {
    type: "extension_reload_rejected",
    requestId: "reload-lease",
    errorCode: "lease_expired",
  });
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
  assert.throws(
    () => issueBrowserCommand(completed.state, { command: "browser_status", requestId: "status-1" }),
    PairingProtocolError,
  );

  const extensionAudit = issueBrowserCommand(activeState(), { command: "browser_status", requestId: "audit-unavailable-response" });
  assert.throws(
    () => reducePairingMessage(extensionAudit.state, {
      type: "browser_error_response",
      ...identity("connection-a"),
      request_id: "audit-unavailable-response",
      command: "browser_status",
      error_code: "audit_unavailable",
    }),
    PairingProtocolError,
  );

  const listed = issueBrowserCommand(activeState(), { command: "tabs_list", requestId: "tabs-list" });
  const listedResponse = reducePairingMessage(listed.state, {
    type: "tabs_list_response",
    ...identity("connection-a"),
    request_id: "tabs-list",
    tabs: [{ id: 3, window_id: 1, title: null, url: null, active: false }],
  });
  assert.deepEqual(listedResponse.effects[0].response, {
    ok: true,
    tabs: [{ id: 3, window_id: 1, title: null, url: null, active: false }],
  });

  const tabs = issueBrowserCommand(activeState(), { command: "tabs_list", requestId: "tabs-1" });
  const cancelled = cancelBrowserCommand(tabs.state, "tabs-1");
  assert.deepEqual(cancelled.effects, [{
    type: "browser_rejected",
    requestId: "tabs-1",
    response: { ok: false, errorCode: "timeout" },
  }]);
  assert.throws(
    () => issueBrowserCommand(cancelled.state, { command: "tabs_list", requestId: "tabs-1" }),
    PairingProtocolError,
  );
  assert.throws(
    () => reducePairingMessage(cancelled.state, {
      type: "tabs_list_response",
      ...identity("connection-a"),
      request_id: "tabs-1",
      tabs: [],
    }),
    PairingProtocolError,
  );
  assert.throws(() => issueBrowserCommand(activeState(), { command: "navigate", requestId: "nope" }), PairingProtocolError);
});

test("navigate canonicalizes an exact safe target, correlates its tab, and marks timeout outcome unknown", () => {
  const active = activeState();
  const status = issueBrowserCommand(active, { command: "browser_status", requestId: "status-concurrent" });
  const navigation = issueBrowserCommand(status.state, {
    command: "navigate",
    requestId: "navigate-1",
    target: { tabId: 7, url: "https:example.test/next%20page" },
  });
  assert.equal(navigation.state.pendingBrowserRequests.length, 2);
  assert.deepEqual(navigation.effects[0].message, {
    type: "navigate_request",
    ...identity("connection-a"),
    request_id: "navigate-1",
    tab_id: 7,
    url: "https://example.test/next%20page",
  });
  assert.throws(
    () => reducePairingMessage(navigation.state, {
      type: "navigate_response",
      ...identity("connection-a"),
      request_id: "navigate-1",
      tab_id: 8,
    }),
    PairingProtocolError,
  );
  const accepted = reducePairingMessage(navigation.state, {
    type: "navigate_response",
    ...identity("connection-a"),
    request_id: "navigate-1",
    tab_id: 7,
  });
  assert.deepEqual(accepted.effects, [{
    type: "browser_resolved",
    requestId: "navigate-1",
    response: { ok: true, tab_id: 7, accepted: true },
  }]);

  const timedOut = issueBrowserCommand(activeState(), {
    command: "navigate",
    requestId: "navigate-timeout",
    target: { tabId: 7, url: "https://example.test/" },
  });
  const cancelled = cancelBrowserCommand(timedOut.state, "navigate-timeout");
  assert.deepEqual(cancelled.effects, [{
    type: "browser_rejected",
    requestId: "navigate-timeout",
    response: { ok: false, errorCode: "outcome_unknown" },
  }]);
  assert.throws(
    () => issueBrowserCommand(cancelled.state, {
      command: "navigate",
      requestId: "navigate-timeout",
      target: { tabId: 7, url: "https://example.test/" },
    }),
    PairingProtocolError,
  );
  assert.throws(
    () => reducePairingMessage(cancelled.state, {
      type: "navigate_response",
      ...identity("connection-a"),
      request_id: "navigate-timeout",
      tab_id: 7,
    }),
    PairingProtocolError,
  );

  for (const target of [
    { tabId: -1, url: "https://example.test/" },
    { tabId: 7, url: "ftp://example.test/" },
    { tabId: 7, url: "https://user:password@example.test/" },
    { tabId: 7, url: "https://example.test/ " },
    { tabId: 7, url: "https://example.test/internal space" },
    { tabId: 7, url: "https://example.test/internal\u00a0space" },
    { tabId: 7, url: "https://example.test/\tpath" },
    { tabId: 7, url: "https://example.test/\npath" },
    { tabId: 7, url: "x".repeat(8_193) },
    { tabId: 7, url: `https:example.test/${"a".repeat(8_173)}` },
  ]) {
    assert.throws(() => issueBrowserCommand(activeState(), { command: "navigate", requestId: "invalid-target", target }), PairingProtocolError);
  }
});

test("transport cancellation distinguishes read closure from mutation uncertainty", () => {
  const status = issueBrowserCommand(activeState(), { command: "browser_status", requestId: "transport-status" });
  const statusCancelled = cancelBrowserCommand(status.state, "transport-status", { reason: "transport_closed" });
  assert.deepEqual(statusCancelled.effects, [{
    type: "browser_rejected",
    requestId: "transport-status",
    response: { ok: false, errorCode: "transport_closed" },
  }]);

  const navigation = issueBrowserCommand(activeState(), {
    command: "navigate",
    requestId: "transport-navigation",
    target: { tabId: 7, url: "https://example.test/" },
  });
  const navigationCancelled = cancelBrowserCommand(navigation.state, "transport-navigation", { reason: "transport_closed" });
  assert.deepEqual(navigationCancelled.effects, [{
    type: "browser_rejected",
    requestId: "transport-navigation",
    response: { ok: false, errorCode: "outcome_unknown" },
  }]);
});

test("snapshot is explicit-tab, read-only, and timeout is retry-safe", () => {
  const issued = issueBrowserCommand(activeState(), {
    command: "snapshot",
    requestId: "snapshot-1",
    target: { tabId: 7 },
  });
  assert.deepEqual(issued.effects[0].message, {
    type: "snapshot_request",
    ...identity("connection-a"),
    request_id: "snapshot-1",
    tab_id: 7,
  });
  const timeout = cancelBrowserCommand(issued.state, "snapshot-1");
  assert.deepEqual(timeout.effects, [{
    type: "browser_rejected",
    requestId: "snapshot-1",
    response: { ok: false, errorCode: "timeout" },
  }]);
  assert.throws(() => issueBrowserCommand(timeout.state, {
    command: "snapshot",
    requestId: "snapshot-1",
    target: { tabId: 7 },
  }), PairingProtocolError);
});

test("snapshot response correlates document, node schema, and late responses", () => {
  const issued = issueBrowserCommand(activeState(), {
    command: "snapshot",
    requestId: "snapshot-response",
    target: { tabId: 7 },
  });
  const response = {
    type: "snapshot_response",
    ...identity("connection-a"),
    request_id: "snapshot-response",
    tab_id: 7,
    document: { loader_id: "loader-a" },
    nodes: [{
      ref: 1,
      parent_ref: null,
      backend_dom_node_id: 10,
      role: "document",
      name: "Example",
      value: null,
      state: { disabled: false, expanded: false, focused: true, hidden: false },
    }],
    truncated: false,
    partial: false,
  };
  const completed = reducePairingMessage(issued.state, response);
  assert.deepEqual(completed.effects, [{
    type: "browser_resolved",
    requestId: "snapshot-response",
    response: {
      ok: true,
      tab_id: 7,
      document: response.document,
      nodes: response.nodes,
      truncated: false,
      partial: false,
    },
  }]);

  const pending = issueBrowserCommand(activeState(), {
    command: "snapshot",
    requestId: "snapshot-late",
    target: { tabId: 7 },
  });
  const cancelled = cancelBrowserCommand(pending.state, "snapshot-late");
  assert.throws(() => reducePairingMessage(cancelled.state, { ...response, request_id: "snapshot-late" }), PairingProtocolError);
  assert.throws(() => reducePairingMessage(issued.state, { ...response, tab_id: 8 }), PairingProtocolError);
  assert.throws(() => reducePairingMessage(issued.state, {
    ...response,
    nodes: [{ ...response.nodes[0], parent_ref: 1 }],
  }), PairingProtocolError);
});

test("snapshot commands stay separated by A/B identity bindings", () => {
  const descriptorB = { ...descriptor, session_id: "session-b", browser_instance_id: "browser-b", profile_instance_id: "profile-b" };
  const stateB = reducePairingMessage(
    reducePairingMessage(createPairingState(descriptorB), { ...register(), session_id: descriptorB.session_id, browser_instance_id: descriptorB.browser_instance_id, profile_instance_id: descriptorB.profile_instance_id }).state,
    { ...ack(), session_id: descriptorB.session_id, browser_instance_id: descriptorB.browser_instance_id, profile_instance_id: descriptorB.profile_instance_id },
  ).state;
  const a = issueBrowserCommand(activeState(), { command: "snapshot", requestId: "snapshot-a", target: { tabId: 7 } });
  const b = issueBrowserCommand(stateB, { command: "snapshot", requestId: "snapshot-b", target: { tabId: 8 } });
  assert.equal(a.effects[0].connectionId, "connection-a");
  assert.equal(b.effects[0].connectionId, "connection-a");
  assert.equal(a.effects[0].message.session_id, descriptor.session_id);
  assert.equal(b.effects[0].message.session_id, descriptorB.session_id);
  assert.equal(a.effects[0].message.tab_id, 7);
  assert.equal(b.effects[0].message.tab_id, 8);
});

test("click commands correlate every target field and timeout as outcome unknown", () => {
  const target = { tabId: 7, loaderId: "loader-click", backendDomNodeId: 42 };
  const issued = issueBrowserCommand(activeState(), {
    command: "click",
    requestId: "click-1",
    target,
  });
  assert.deepEqual(issued.effects[0].message, {
    type: "click_request",
    ...identity("connection-a"),
    request_id: "click-1",
    tab_id: 7,
    loader_id: "loader-click",
    backend_dom_node_id: 42,
  });
  const response = reducePairingMessage(issued.state, {
    type: "click_response",
    ...identity("connection-a"),
    request_id: "click-1",
    tab_id: target.tabId,
    loader_id: target.loaderId,
    backend_dom_node_id: target.backendDomNodeId,
    accepted: true,
  });
  assert.deepEqual(response.effects, [{
    type: "browser_resolved",
    requestId: "click-1",
    response: {
      ok: true,
      tab_id: target.tabId,
      loader_id: target.loaderId,
      backend_dom_node_id: target.backendDomNodeId,
      accepted: true,
    },
  }]);

  const pending = issueBrowserCommand(activeState(), {
    command: "click",
    requestId: "click-timeout",
    target,
  });
  const cancelled = cancelBrowserCommand(pending.state, "click-timeout");
  assert.deepEqual(cancelled.effects, [{
    type: "browser_rejected",
    requestId: "click-timeout",
    response: { ok: false, errorCode: "outcome_unknown" },
  }]);
  assert.throws(() => reducePairingMessage(cancelled.state, {
    type: "click_response",
    ...identity("connection-a"),
    request_id: "click-timeout",
    tab_id: target.tabId,
    loader_id: target.loaderId,
    backend_dom_node_id: target.backendDomNodeId,
    accepted: true,
  }), PairingProtocolError);
  assert.throws(() => issueBrowserCommand(activeState(), {
    command: "click",
    requestId: "click-invalid",
    target: { ...target, loaderId: "loader with space" },
  }), PairingProtocolError);
  assert.throws(() => reducePairingMessage(issued.state, {
    type: "click_response",
    ...identity("connection-a"),
    request_id: "click-1",
    tab_id: target.tabId,
    loader_id: target.loaderId,
    backend_dom_node_id: 43,
    accepted: true,
  }), PairingProtocolError);
});

test("click commands stay separated by A/B identity bindings", () => {
  const descriptorB = { ...descriptor, session_id: "session-b", browser_instance_id: "browser-b", profile_instance_id: "profile-b" };
  const stateB = reducePairingMessage(
    reducePairingMessage(createPairingState(descriptorB), {
      ...register(),
      session_id: descriptorB.session_id,
      browser_instance_id: descriptorB.browser_instance_id,
      profile_instance_id: descriptorB.profile_instance_id,
    }).state,
    {
      ...ack(),
      session_id: descriptorB.session_id,
      browser_instance_id: descriptorB.browser_instance_id,
      profile_instance_id: descriptorB.profile_instance_id,
    },
  ).state;
  const a = issueBrowserCommand(activeState(), {
    command: "click",
    requestId: "click-a",
    target: { tabId: 7, loaderId: "loader-a", backendDomNodeId: 41 },
  });
  const b = issueBrowserCommand(stateB, {
    command: "click",
    requestId: "click-b",
    target: { tabId: 8, loaderId: "loader-b", backendDomNodeId: 42 },
  });
  assert.equal(a.effects[0].connectionId, "connection-a");
  assert.equal(b.effects[0].connectionId, "connection-a");
  assert.equal(a.effects[0].message.browser_instance_id, descriptor.browser_instance_id);
  assert.equal(b.effects[0].message.browser_instance_id, descriptorB.browser_instance_id);
  assert.equal(a.effects[0].message.loader_id, "loader-a");
  assert.equal(b.effects[0].message.loader_id, "loader-b");
});

test("type commands correlate targets while keeping text request-only", () => {
  const target = { tabId: 7, loaderId: "loader-type", backendDomNodeId: 42, text: "hello world" };
  const issued = issueBrowserCommand(activeState(), {
    command: "type",
    requestId: "type-1",
    target,
  });
  assert.deepEqual(issued.effects[0].message, {
    type: "type_request",
    ...identity("connection-a"),
    request_id: "type-1",
    tab_id: 7,
    loader_id: "loader-type",
    backend_dom_node_id: 42,
    text: "hello world",
  });
  const response = reducePairingMessage(issued.state, {
    type: "type_response",
    ...identity("connection-a"),
    request_id: "type-1",
    tab_id: 7,
    loader_id: "loader-type",
    backend_dom_node_id: 42,
    accepted: true,
  });
  assert.deepEqual(response.effects, [{
    type: "browser_resolved",
    requestId: "type-1",
    response: { ok: true, tab_id: 7, loader_id: "loader-type", backend_dom_node_id: 42, accepted: true },
  }]);
  assert.equal(JSON.stringify(response.effects).includes("hello world"), false);

  const pending = issueBrowserCommand(activeState(), {
    command: "type",
    requestId: "type-timeout",
    target,
  });
  const cancelled = cancelBrowserCommand(pending.state, "type-timeout");
  assert.deepEqual(cancelled.effects, [{
    type: "browser_rejected",
    requestId: "type-timeout",
    response: { ok: false, errorCode: "outcome_unknown" },
  }]);
  assert.throws(() => reducePairingMessage(cancelled.state, {
    type: "type_response",
    ...identity("connection-a"),
    request_id: "type-timeout",
    tab_id: 7,
    loader_id: "loader-type",
    backend_dom_node_id: 42,
    accepted: true,
  }), PairingProtocolError);
  assert.throws(() => issueBrowserCommand(activeState(), {
    command: "type",
    requestId: "type-invalid",
    target: { ...target, text: "" },
  }), PairingProtocolError);
});

test("type commands stay separated by A/B identity bindings", () => {
  const descriptorB = { ...descriptor, session_id: "session-b", browser_instance_id: "browser-b", profile_instance_id: "profile-b" };
  const stateB = reducePairingMessage(
    reducePairingMessage(createPairingState(descriptorB), {
      ...register(),
      session_id: descriptorB.session_id,
      browser_instance_id: descriptorB.browser_instance_id,
      profile_instance_id: descriptorB.profile_instance_id,
    }).state,
    {
      ...ack(),
      session_id: descriptorB.session_id,
      browser_instance_id: descriptorB.browser_instance_id,
      profile_instance_id: descriptorB.profile_instance_id,
    },
  ).state;
  const a = issueBrowserCommand(activeState(), {
    command: "type",
    requestId: "type-a",
    target: { tabId: 7, loaderId: "loader-a", backendDomNodeId: 41, text: "A secret" },
  });
  const b = issueBrowserCommand(stateB, {
    command: "type",
    requestId: "type-b",
    target: { tabId: 8, loaderId: "loader-b", backendDomNodeId: 42, text: "B secret" },
  });
  assert.equal(a.effects[0].message.browser_instance_id, descriptor.browser_instance_id);
  assert.equal(b.effects[0].message.browser_instance_id, descriptorB.browser_instance_id);
  assert.equal(a.effects[0].message.tab_id, 7);
  assert.equal(b.effects[0].message.tab_id, 8);
  assert.equal(a.effects[0].message.text, "A secret");
  assert.equal(b.effects[0].message.text, "B secret");
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
