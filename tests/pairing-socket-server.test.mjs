import assert from "node:assert/strict";
import net from "node:net";
import { lstat, mkdtemp, stat, writeFile, unlink } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { encodeNativeMessage, NativeMessageDecoder } from "../native-host/codec.mjs";
import {
  createPairingDescriptor,
  createSocketPath,
  loadOrCreateProfileMetadata,
  resolvePairingPaths,
} from "../core/pairing-descriptor.mjs";
import { PAIRING_SOCKET_MAX_MESSAGE_BYTES, PairingSocketServer } from "../core/pairing-socket-server.mjs";

const ISSUED_AT = "2030-01-01T00:00:00.000Z";
const EXPIRES_AT = "2030-01-01T01:00:00.000Z";
const NOW = new Date("2030-01-01T00:30:00.000Z");

async function serverFixture(instanceId, suffix, serverOptions = {}) {
  const runtimeRoot = await mkdtemp(path.join("/private/tmp", "bsp-socket-"));
  const paths = resolvePairingPaths({ runtimeRoot, instanceId });
  const metadata = await loadOrCreateProfileMetadata(paths, {
    createUuid: () => `11111111-1111-4111-8111-${suffix}`,
  });
  const socketPath = await createSocketPath(paths, {
    createUuid: () => `22222222-2222-4222-8222-${suffix}`,
  });
  const descriptor = createPairingDescriptor({
    paths,
    profileInstanceId: metadata.profile_instance_id,
    sessionId: `session-${instanceId}`,
    generation: 1,
    socketPath,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    leaseId: `lease-${instanceId}`,
    pairingNonce: `nonce-${instanceId}`,
  });
  const server = new PairingSocketServer({
    paths,
    descriptor,
    profileInstanceId: metadata.profile_instance_id,
    now: NOW,
    ...serverOptions,
  });
  return { paths, metadata, descriptor, server };
}

function identity(descriptor, connectionId) {
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

function message(descriptor, type, connectionId, extra = {}) {
  return { type, ...identity(descriptor, connectionId), ...extra };
}

async function framedClient(socketPath) {
  const socket = net.createConnection(socketPath);
  await once(socket, "connect");
  socket.on("error", () => {});
  const decoder = new NativeMessageDecoder({ maxBytes: PAIRING_SOCKET_MAX_MESSAGE_BYTES });
  const messages = [];
  let waiter = null;
  socket.on("data", (chunk) => {
    for (const item of decoder.push(chunk)) {
      messages.push(item);
    }
    if (waiter && messages.length > 0) {
      const resolve = waiter;
      waiter = null;
      resolve(messages.shift());
    }
  });
  return {
    socket,
    send(value) { socket.write(value); },
    next() {
      if (messages.length > 0) return Promise.resolve(messages.shift());
      return new Promise((resolve) => { waiter = resolve; });
    },
  };
}

// This is a native-host-to-session-socket transport probe, not an Extension round-trip harness.
async function activateHostToSessionSocket(client, descriptor, connectionId = "connection-a") {
  client.send(encodeNativeMessage(message(descriptor, "host_register", connectionId, { pairing_nonce: descriptor.pairing_nonce })));
  const challenge = await client.next();
  assert.equal(challenge.type, "pair_challenge");
  client.send(encodeNativeMessage(message(descriptor, "pair_ack", connectionId)));
  assert.equal((await client.next()).type, "pair_active");
}

test("native host-to-session socket transport accepts partial and multiple frames", async (t) => {
  const fixture = await serverFixture("poc-a", "111111111111");
  t.after(() => fixture.server.close());
  await fixture.server.listen();
  assert.equal((await stat(fixture.paths.socketDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(fixture.descriptor.socket_path)).mode & 0o777, 0o600);

  const client = await framedClient(fixture.descriptor.socket_path);
  t.after(() => client.socket.destroy());
  const registration = encodeNativeMessage(message(fixture.descriptor, "host_register", "connection-a", {
    pairing_nonce: fixture.descriptor.pairing_nonce,
  }));
  client.send(registration.subarray(0, 3));
  client.send(registration.subarray(3));
  const challenge = await client.next();
  assert.equal(challenge.type, "pair_challenge");

  const acknowledgement = encodeNativeMessage(message(fixture.descriptor, "pair_ack", "connection-a"));
  const ping = encodeNativeMessage(message(fixture.descriptor, "transport_probe_request", "connection-a", { request_id: "request-a" }));
  client.send(Buffer.concat([acknowledgement, ping]));
  assert.equal((await client.next()).type, "pair_active");
  const response = await client.next();
  assert.deepEqual(response, message(fixture.descriptor, "transport_probe_response", "connection-a", { request_id: "request-a" }));

  const resumeClient = await framedClient(fixture.descriptor.socket_path);
  t.after(() => resumeClient.socket.destroy());
  const oldConnectionClosed = once(client.socket, "close");
  resumeClient.send(encodeNativeMessage(message(fixture.descriptor, "resume", "connection-b")));
  assert.equal((await resumeClient.next()).pairing_mode, "resume");
  resumeClient.send(encodeNativeMessage(message(fixture.descriptor, "pair_ack", "connection-b")));
  await oldConnectionClosed;
  assert.equal((await resumeClient.next()).type, "pair_active");
  resumeClient.send(encodeNativeMessage(message(fixture.descriptor, "transport_probe_request", "connection-b", { request_id: "request-b" })));
  assert.equal((await resumeClient.next()).request_id, "request-b");
  const harnessPing = fixture.server.requestPing({ requestId: "harness-ping", timeoutMs: 1_000 });
  const request = await resumeClient.next();
  assert.equal(request.type, "ping_request");
  resumeClient.send(encodeNativeMessage(message(fixture.descriptor, "ping_response", "connection-b", { request_id: "harness-ping" })));
  assert.deepEqual(await harnessPing, { requestId: "harness-ping" });
});

test("browser_status and tabs_list stay correlated to the active instance and expose timeout/error codes", async (t) => {
  const fixture = await serverFixture("poc-a", "101010101010");
  t.after(() => fixture.server.close());
  await fixture.server.listen();
  const client = await framedClient(fixture.descriptor.socket_path);
  t.after(() => client.socket.destroy());
  await activateHostToSessionSocket(client, fixture.descriptor);

  const status = fixture.server.requestBrowserStatus({ requestId: "status-1", timeoutMs: 1_000 });
  assert.deepEqual(await client.next(), message(fixture.descriptor, "browser_status_request", "connection-a", { request_id: "status-1" }));
  client.send(encodeNativeMessage(message(fixture.descriptor, "browser_status_response", "connection-a", {
    request_id: "status-1",
    status: { extension_connected: true, chrome_tabs_available: true },
  })));
  assert.deepEqual(await status, {
    request_id: "status-1",
    command: "browser_status",
    session_id: fixture.descriptor.session_id,
    browser_instance_id: fixture.descriptor.browser_instance_id,
    profile_instance_id: fixture.descriptor.profile_instance_id,
    generation: fixture.descriptor.generation,
    lease_id: fixture.descriptor.lease_id,
    ok: true,
    status: { extension_connected: true, chrome_tabs_available: true },
  });

  const tabs = fixture.server.requestTabsList({ requestId: "tabs-1", timeoutMs: 1_000 });
  assert.equal((await client.next()).type, "tabs_list_request");
  client.send(encodeNativeMessage(message(fixture.descriptor, "browser_error_response", "connection-a", {
    request_id: "tabs-1",
    command: "tabs_list",
    error_code: "tabs_unavailable",
  })));
  await assert.rejects(tabs, (error) => error.code === "tabs_unavailable");

  const navigation = fixture.server.requestNavigate({
    requestId: "navigate-1",
    tabId: 7,
    url: "https://example.test/next",
    timeoutMs: 1_000,
  });
  assert.deepEqual(await client.next(), message(fixture.descriptor, "navigate_request", "connection-a", {
    request_id: "navigate-1",
    tab_id: 7,
    url: "https://example.test/next",
  }));
  client.send(encodeNativeMessage(message(fixture.descriptor, "navigate_response", "connection-a", {
    request_id: "navigate-1",
    tab_id: 7,
  })));
  assert.deepEqual(await navigation, {
    request_id: "navigate-1",
    command: "navigate",
    session_id: fixture.descriptor.session_id,
    browser_instance_id: fixture.descriptor.browser_instance_id,
    profile_instance_id: fixture.descriptor.profile_instance_id,
    generation: fixture.descriptor.generation,
    lease_id: fixture.descriptor.lease_id,
    ok: true,
    tab_id: 7,
    accepted: true,
  });

  const snapshot = fixture.server.requestSnapshot({ requestId: "snapshot-1", tabId: 7, timeoutMs: 1_000 });
  assert.deepEqual(await client.next(), message(fixture.descriptor, "snapshot_request", "connection-a", {
    request_id: "snapshot-1",
    tab_id: 7,
  }));
  client.send(encodeNativeMessage(message(fixture.descriptor, "snapshot_response", "connection-a", {
    request_id: "snapshot-1",
    tab_id: 7,
    document: { loader_id: "loader-a" },
    nodes: [{
      ref: 1,
      parent_ref: null,
      backend_dom_node_id: null,
      role: "document",
      name: "Example",
      value: null,
      state: { disabled: false, expanded: false, focused: false, hidden: false },
    }],
    truncated: false,
    partial: false,
  })));
  assert.deepEqual(await snapshot, {
    request_id: "snapshot-1",
    command: "snapshot",
    session_id: fixture.descriptor.session_id,
    browser_instance_id: fixture.descriptor.browser_instance_id,
    profile_instance_id: fixture.descriptor.profile_instance_id,
    generation: fixture.descriptor.generation,
    lease_id: fixture.descriptor.lease_id,
    ok: true,
    tab_id: 7,
    document: { loader_id: "loader-a" },
    nodes: [{
      ref: 1,
      parent_ref: null,
      backend_dom_node_id: null,
      role: "document",
      name: "Example",
      value: null,
      state: { disabled: false, expanded: false, focused: false, hidden: false },
    }],
    truncated: false,
    partial: false,
  });

  const navigationTimeout = fixture.server.requestNavigate({
    requestId: "navigate-timeout",
    tabId: 7,
    url: "https://example.test/",
    timeoutMs: 1,
  });
  assert.equal((await client.next()).request_id, "navigate-timeout");
  await assert.rejects(navigationTimeout, (error) => error.code === "outcome_unknown");
  assert.throws(
    () => fixture.server.requestNavigate({ requestId: "navigate-timeout", tabId: 7, url: "https://example.test/", timeoutMs: 1 }),
    /request id is already pending/,
  );

  const snapshotTimeout = fixture.server.requestSnapshot({ requestId: "snapshot-timeout", tabId: 7, timeoutMs: 1 });
  assert.equal((await client.next()).request_id, "snapshot-timeout");
  await assert.rejects(snapshotTimeout, (error) => error.code === "timeout");
  assert.throws(
    () => fixture.server.requestSnapshot({ requestId: "snapshot-timeout", tabId: 7, timeoutMs: 1 }),
    /request id is already pending/,
  );

  const timeout = fixture.server.requestTabsList({ requestId: "tabs-timeout", timeoutMs: 1 });
  assert.equal((await client.next()).request_id, "tabs-timeout");
  await assert.rejects(timeout, (error) => error.code === "timeout");
  assert.throws(
    () => fixture.server.requestTabsList({ requestId: "tabs-timeout", timeoutMs: 1 }),
    /request id is already pending/,
  );
  const staleClosed = once(client.socket, "close");
  client.send(encodeNativeMessage(message(fixture.descriptor, "tabs_list_response", "connection-a", {
    request_id: "tabs-timeout",
    tabs: [],
  })));
  await staleClosed;
});

test("snapshot uses a five-second default timeout distinct from generic browser commands", async (t) => {
  const timerDelays = [];
  const fixture = await serverFixture("poc-a", "111111111112", {
    setTimer(callback, delay) {
      timerDelays.push(delay);
      return { callback, delay };
    },
    clearTimer() {},
  });
  t.after(() => fixture.server.close());
  await fixture.server.listen();
  const client = await framedClient(fixture.descriptor.socket_path);
  t.after(() => client.socket.destroy());
  await activateHostToSessionSocket(client, fixture.descriptor);

  const snapshot = fixture.server.requestSnapshot({ requestId: "snapshot-default", tabId: 7 });
  assert.equal((await client.next()).request_id, "snapshot-default");
  assert.equal(timerDelays.at(-1), 5_000);
  client.send(encodeNativeMessage(message(fixture.descriptor, "snapshot_response", "connection-a", {
    request_id: "snapshot-default",
    tab_id: 7,
    document: { loader_id: "loader-default" },
    nodes: [],
    truncated: false,
    partial: false,
  })));
  await assert.doesNotReject(snapshot);
});

test("invalid JSON and oversized frames are rejected without changing an issued session", async (t) => {
  const fixture = await serverFixture("poc-a", "222222222222");
  t.after(() => fixture.server.close());
  await fixture.server.listen();

  const invalid = await framedClient(fixture.descriptor.socket_path);
  const invalidClosed = once(invalid.socket, "close");
  invalid.send(Buffer.from([1, 0, 0, 0, 0xff]));
  await invalidClosed;
  assert.equal(fixture.server.state.phase, "ISSUED");

  const oversized = await framedClient(fixture.descriptor.socket_path);
  const oversizedClosed = once(oversized.socket, "close");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(PAIRING_SOCKET_MAX_MESSAGE_BYTES + 1);
  oversized.send(header);
  await oversizedClosed;
  assert.equal(fixture.server.state.phase, "ISSUED");
});

test("a late snapshot response after timeout fences the session socket", async (t) => {
  const fixture = await serverFixture("poc-a", "232323232323");
  t.after(() => fixture.server.close());
  await fixture.server.listen();
  const client = await framedClient(fixture.descriptor.socket_path);
  t.after(() => client.socket.destroy());
  await activateHostToSessionSocket(client, fixture.descriptor);

  const snapshot = fixture.server.requestSnapshot({ requestId: "late-snapshot", tabId: 7, timeoutMs: 1 });
  assert.equal((await client.next()).request_id, "late-snapshot");
  await assert.rejects(snapshot, (error) => error.code === "timeout");
  const closed = once(client.socket, "close");
  client.send(encodeNativeMessage(message(fixture.descriptor, "snapshot_response", "connection-a", {
    request_id: "late-snapshot",
    tab_id: 7,
    document: { loader_id: "loader-late" },
    nodes: [],
    truncated: false,
    partial: false,
  })));
  await closed;
});

test("an existing path is preserved and a server removes only its own socket on close", async (t) => {
  const fixture = await serverFixture("poc-a", "333333333333");
  await writeFile(fixture.descriptor.socket_path, "sentinel", { mode: 0o600 });
  await assert.rejects(() => fixture.server.listen(), /refusing to replace/);
  assert.equal((await lstat(fixture.descriptor.socket_path)).isFile(), true);
  await unlink(fixture.descriptor.socket_path);

  await fixture.server.listen();
  assert.equal((await lstat(fixture.descriptor.socket_path)).isSocket(), true);
  await fixture.server.close();
  await assert.rejects(() => lstat(fixture.descriptor.socket_path), { code: "ENOENT" });
  t.after(() => fixture.server.close());
});

test("A and B sockets remain independent when B fails before A starts", async (t) => {
  const a = await serverFixture("poc-a", "444444444444");
  const b = await serverFixture("poc-b", "555555555555");
  t.after(() => Promise.all([a.server.close(), b.server.close()]));
  await b.server.listen();
  await a.server.listen();

  const aClient = await framedClient(a.descriptor.socket_path);
  t.after(() => aClient.socket.destroy());
  await activateHostToSessionSocket(aClient, a.descriptor);

  const bClient = await framedClient(b.descriptor.socket_path);
  t.after(() => bClient.socket.destroy());
  const bClosed = once(bClient.socket, "close");
  bClient.send(encodeNativeMessage(message(b.descriptor, "host_register", "connection-b", { pairing_nonce: "wrong" })));
  await bClosed;
  assert.equal(b.server.state.phase, "ISSUED");

  aClient.send(encodeNativeMessage(message(a.descriptor, "transport_probe_request", "connection-a", { request_id: "a-still-active" })));
  assert.equal((await aClient.next()).request_id, "a-still-active");
});

test("concurrent A and B navigate requests remain on their descriptor-selected sockets", async (t) => {
  const a = await serverFixture("poc-a", "616161616161");
  const b = await serverFixture("poc-b", "626262626262");
  t.after(() => Promise.all([a.server.close(), b.server.close()]));
  await Promise.all([a.server.listen(), b.server.listen()]);
  const aClient = await framedClient(a.descriptor.socket_path);
  const bClient = await framedClient(b.descriptor.socket_path);
  t.after(() => aClient.socket.destroy());
  t.after(() => bClient.socket.destroy());
  await Promise.all([
    activateHostToSessionSocket(aClient, a.descriptor),
    activateHostToSessionSocket(bClient, b.descriptor),
  ]);

  const aNavigation = a.server.requestNavigate({ requestId: "navigate-a", tabId: 7, url: "https://a.example.test/" });
  const bNavigation = b.server.requestNavigate({ requestId: "navigate-b", tabId: 8, url: "https://b.example.test/" });
  assert.deepEqual(await aClient.next(), message(a.descriptor, "navigate_request", "connection-a", {
    request_id: "navigate-a", tab_id: 7, url: "https://a.example.test/",
  }));
  assert.deepEqual(await bClient.next(), message(b.descriptor, "navigate_request", "connection-a", {
    request_id: "navigate-b", tab_id: 8, url: "https://b.example.test/",
  }));
  aClient.send(encodeNativeMessage(message(a.descriptor, "navigate_response", "connection-a", { request_id: "navigate-a", tab_id: 7 })));
  bClient.send(encodeNativeMessage(message(b.descriptor, "navigate_response", "connection-a", { request_id: "navigate-b", tab_id: 8 })));
  const [aResult, bResult] = await Promise.all([aNavigation, bNavigation]);
  assert.equal(aResult.tab_id, 7);
  assert.equal(bResult.tab_id, 8);
  assert.equal(aResult.browser_instance_id, a.descriptor.browser_instance_id);
  assert.equal(bResult.browser_instance_id, b.descriptor.browser_instance_id);

  const aSnapshot = a.server.requestSnapshot({ requestId: "snapshot-a", tabId: 7 });
  const bSnapshot = b.server.requestSnapshot({ requestId: "snapshot-b", tabId: 8 });
  assert.deepEqual(await aClient.next(), message(a.descriptor, "snapshot_request", "connection-a", {
    request_id: "snapshot-a", tab_id: 7,
  }));
  assert.deepEqual(await bClient.next(), message(b.descriptor, "snapshot_request", "connection-a", {
    request_id: "snapshot-b", tab_id: 8,
  }));
  const snapshotPayload = (requestId, tabId) => ({
    request_id: requestId,
    tab_id: tabId,
    document: { loader_id: `loader-${tabId}` },
    nodes: [],
    truncated: false,
    partial: false,
  });
  aClient.send(encodeNativeMessage(message(a.descriptor, "snapshot_response", "connection-a", snapshotPayload("snapshot-a", 7))));
  bClient.send(encodeNativeMessage(message(b.descriptor, "snapshot_response", "connection-a", snapshotPayload("snapshot-b", 8))));
  const [aSnapshotResult, bSnapshotResult] = await Promise.all([aSnapshot, bSnapshot]);
  assert.equal(aSnapshotResult.document.loader_id, "loader-7");
  assert.equal(bSnapshotResult.document.loader_id, "loader-8");
  assert.equal(aSnapshotResult.browser_instance_id, a.descriptor.browser_instance_id);
  assert.equal(bSnapshotResult.browser_instance_id, b.descriptor.browser_instance_id);

  const aClick = a.server.requestClick({
    requestId: "click-a",
    tabId: 7,
    loaderId: "loader-7",
    backendDomNodeId: 41,
  });
  const bClick = b.server.requestClick({
    requestId: "click-b",
    tabId: 8,
    loaderId: "loader-8",
    backendDomNodeId: 42,
  });
  assert.deepEqual(await aClient.next(), message(a.descriptor, "click_request", "connection-a", {
    request_id: "click-a", tab_id: 7, loader_id: "loader-7", backend_dom_node_id: 41,
  }));
  assert.deepEqual(await bClient.next(), message(b.descriptor, "click_request", "connection-a", {
    request_id: "click-b", tab_id: 8, loader_id: "loader-8", backend_dom_node_id: 42,
  }));
  aClient.send(encodeNativeMessage(message(a.descriptor, "click_response", "connection-a", {
    request_id: "click-a", tab_id: 7, loader_id: "loader-7", backend_dom_node_id: 41, accepted: true,
  })));
  bClient.send(encodeNativeMessage(message(b.descriptor, "click_response", "connection-a", {
    request_id: "click-b", tab_id: 8, loader_id: "loader-8", backend_dom_node_id: 42, accepted: true,
  })));
  const [aClickResult, bClickResult] = await Promise.all([aClick, bClick]);
  assert.equal(aClickResult.loader_id, "loader-7");
  assert.equal(bClickResult.loader_id, "loader-8");
  assert.equal(aClickResult.backend_dom_node_id, 41);
  assert.equal(bClickResult.backend_dom_node_id, 42);
  assert.equal(aClickResult.browser_instance_id, a.descriptor.browser_instance_id);
  assert.equal(bClickResult.browser_instance_id, b.descriptor.browser_instance_id);

  const aType = a.server.requestType({
    requestId: "type-a",
    tabId: 7,
    loaderId: "loader-7",
    backendDomNodeId: 41,
    text: "A only",
  });
  const bType = b.server.requestType({
    requestId: "type-b",
    tabId: 8,
    loaderId: "loader-8",
    backendDomNodeId: 42,
    text: "B only",
  });
  assert.deepEqual(await aClient.next(), message(a.descriptor, "type_request", "connection-a", {
    request_id: "type-a", tab_id: 7, loader_id: "loader-7", backend_dom_node_id: 41, text: "A only",
  }));
  assert.deepEqual(await bClient.next(), message(b.descriptor, "type_request", "connection-a", {
    request_id: "type-b", tab_id: 8, loader_id: "loader-8", backend_dom_node_id: 42, text: "B only",
  }));
  aClient.send(encodeNativeMessage(message(a.descriptor, "type_response", "connection-a", {
    request_id: "type-a", tab_id: 7, loader_id: "loader-7", backend_dom_node_id: 41, accepted: true,
  })));
  bClient.send(encodeNativeMessage(message(b.descriptor, "type_response", "connection-a", {
    request_id: "type-b", tab_id: 8, loader_id: "loader-8", backend_dom_node_id: 42, accepted: true,
  })));
  const [aTypeResult, bTypeResult] = await Promise.all([aType, bType]);
  assert.equal(aTypeResult.tab_id, 7);
  assert.equal(bTypeResult.tab_id, 8);
  assert.equal(aTypeResult.browser_instance_id, a.descriptor.browser_instance_id);
  assert.equal(bTypeResult.browser_instance_id, b.descriptor.browser_instance_id);
  assert.equal(Object.hasOwn(aTypeResult, "text"), false);
  assert.equal(Object.hasOwn(bTypeResult, "text"), false);
});

test("disconnecting A's active host fences its pending ping without affecting B", async (t) => {
  const a = await serverFixture("poc-a", "818181818181");
  const b = await serverFixture("poc-b", "828282828282");
  t.after(() => Promise.all([a.server.close(), b.server.close()]));
  await Promise.all([a.server.listen(), b.server.listen()]);

  const aClient = await framedClient(a.descriptor.socket_path);
  const bClient = await framedClient(b.descriptor.socket_path);
  t.after(() => aClient.socket.destroy());
  t.after(() => bClient.socket.destroy());
  await activateHostToSessionSocket(aClient, a.descriptor);
  await activateHostToSessionSocket(bClient, b.descriptor);

  const pendingPing = a.server.requestPing({ requestId: "a-pending", timeoutMs: 1_000 });
  const pendingPingRejected = assert.rejects(pendingPing, /pairing ping was not completed/);
  assert.equal((await aClient.next()).type, "ping_request");
  const pendingNavigate = a.server.requestNavigate({
    requestId: "a-pending-navigate",
    tabId: 7,
    url: "https://example.test/",
    timeoutMs: 1_000,
  });
  const pendingNavigateRejected = assert.rejects(pendingNavigate, (error) => error.code === "outcome_unknown");
  assert.equal((await aClient.next()).type, "navigate_request");
  const aClosed = once(aClient.socket, "close");
  a.server.disconnectActiveHost();
  await aClosed;
  await pendingPingRejected;
  await pendingNavigateRejected;
  assert.equal(a.server.state.phase, "ACTIVE");
  assert.equal(a.server.state.activeConnectionId, null);
  assert.throws(
    () => a.server.requestPing({ requestId: "a-after-disconnect" }),
    /ping is not permitted in the current state/,
  );

  bClient.send(encodeNativeMessage(message(b.descriptor, "transport_probe_request", "connection-a", {
    request_id: "b-remains-active",
  })));
  assert.equal((await bClient.next()).request_id, "b-remains-active");
});

test("closing the server marks pending navigate outcome unknown and read commands transport closed", async (t) => {
  const fixture = await serverFixture("poc-a", "838383838382");
  t.after(() => fixture.server.close());
  await fixture.server.listen();
  const client = await framedClient(fixture.descriptor.socket_path);
  t.after(() => client.socket.destroy());
  await activateHostToSessionSocket(client, fixture.descriptor);

  const navigation = fixture.server.requestNavigate({
    requestId: "close-navigate",
    tabId: 7,
    url: "https://example.test/",
    timeoutMs: 1_000,
  });
  const navigationRejected = assert.rejects(navigation, (error) => error.code === "outcome_unknown");
  assert.equal((await client.next()).type, "navigate_request");
  const status = fixture.server.requestBrowserStatus({ requestId: "close-status", timeoutMs: 1_000 });
  const statusRejected = assert.rejects(status, (error) => error.code === "transport_closed");
  assert.equal((await client.next()).type, "browser_status_request");
  const typing = fixture.server.requestType({
    requestId: "close-type",
    tabId: 7,
    loaderId: "loader-type",
    backendDomNodeId: 42,
    text: "secret text",
    timeoutMs: 1_000,
  });
  const typingRejected = assert.rejects(typing, (error) => error.code === "outcome_unknown");
  assert.equal((await client.next()).type, "type_request");

  await fixture.server.close();
  await navigationRejected;
  await statusRejected;
  await typingRejected;
});

test("disconnect-active-host rejects before an ACTIVE transport exists", async (t) => {
  const fixture = await serverFixture("poc-a", "838383838383");
  t.after(() => fixture.server.close());
  await fixture.server.listen();

  assert.throws(() => fixture.server.disconnectActiveHost(), /an active host transport is required/);
  assert.equal(fixture.server.state.phase, "ISSUED");
});

test("a disconnected active host can resume and serve a later ping", async (t) => {
  const fixture = await serverFixture("poc-a", "848484848484");
  t.after(() => fixture.server.close());
  await fixture.server.listen();

  const initial = await framedClient(fixture.descriptor.socket_path);
  t.after(() => initial.socket.destroy());
  await activateHostToSessionSocket(initial, fixture.descriptor);
  const initialClosed = once(initial.socket, "close");
  fixture.server.disconnectActiveHost();
  await initialClosed;

  const resumed = await framedClient(fixture.descriptor.socket_path);
  t.after(() => resumed.socket.destroy());
  resumed.send(encodeNativeMessage(message(fixture.descriptor, "resume", "connection-b")));
  assert.equal((await resumed.next()).pairing_mode, "resume");
  resumed.send(encodeNativeMessage(message(fixture.descriptor, "pair_ack", "connection-b")));
  assert.equal((await resumed.next()).type, "pair_active");

  const ping = fixture.server.requestPing({ requestId: "after-resume", timeoutMs: 1_000 });
  const request = await resumed.next();
  assert.equal(request.type, "ping_request");
  resumed.send(encodeNativeMessage(message(fixture.descriptor, "ping_response", "connection-b", {
    request_id: "after-resume",
  })));
  assert.deepEqual(await ping, { requestId: "after-resume" });
});

test("the idle expiry timer revokes an active session and fences its socket", async (t) => {
  let currentTime = new Date("2030-01-01T00:30:00.000Z");
  const timers = [];
  const fixture = await serverFixture("poc-a", "666666666666", {
    clock: () => currentTime,
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cancelled = true; },
  });
  t.after(() => fixture.server.close());
  await fixture.server.listen();
  assert.equal(timers.length, 1);

  const client = await framedClient(fixture.descriptor.socket_path);
  await activateHostToSessionSocket(client, fixture.descriptor);
  const candidate = await framedClient(fixture.descriptor.socket_path);
  candidate.send(encodeNativeMessage(message(fixture.descriptor, "resume", "connection-b")));
  assert.equal((await candidate.next()).pairing_mode, "resume");
  const activeClosed = once(client.socket, "close");
  const candidateClosed = once(candidate.socket, "close");
  currentTime = new Date(EXPIRES_AT);
  timers[0].callback();
  await Promise.all([activeClosed, candidateClosed]);
  assert.equal(fixture.server.state.phase, "REVOKED");

  const rejected = await framedClient(fixture.descriptor.socket_path);
  const rejectedClosed = once(rejected.socket, "close");
  rejected.send(encodeNativeMessage(message(fixture.descriptor, "host_register", "connection-b", {
    pairing_nonce: fixture.descriptor.pairing_nonce,
  })));
  await rejectedClosed;
});

test("close cancels an outstanding expiry timer", async () => {
  const timers = [];
  const fixture = await serverFixture("poc-a", "777777777777", {
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cancelled = true; },
  });
  await fixture.server.listen();
  assert.equal(timers.length, 1);
  await fixture.server.close();
  assert.equal(timers[0].cancelled, true);
});
