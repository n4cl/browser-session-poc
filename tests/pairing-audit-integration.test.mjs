import assert from "node:assert/strict";
import net from "node:net";
import { chmod, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { encodeNativeMessage, NativeMessageDecoder } from "../native-host/codec.mjs";
import { createPairingDescriptor, createSocketPath, loadOrCreateProfileMetadata, resolvePairingPaths } from "../core/pairing-descriptor.mjs";
import { AUDIT_ERROR_CODE, createPairingAuditLogger, pairingAuditFilePath } from "../core/pairing-audit-log.mjs";
import { PairingSocketServer } from "../core/pairing-socket-server.mjs";

const NOW = new Date("2030-01-01T00:30:00.000Z");

async function serverFixture(auditLogger = null) {
  const runtimeRoot = await mkdtemp(path.join("/private/tmp", "bsp-audit-server-"));
  const paths = resolvePairingPaths({ runtimeRoot, instanceId: "poc-a" });
  await mkdir(paths.instanceDir, { recursive: true, mode: 0o700 });
  await chmod(paths.instanceDir, 0o700);
  const metadata = await loadOrCreateProfileMetadata(paths, { createUuid: () => "11111111-1111-4111-8111-111111111111" });
  const socketPath = await createSocketPath(paths, { createUuid: () => "22222222-2222-4222-8222-222222222222" });
  const descriptor = createPairingDescriptor({
    paths,
    profileInstanceId: metadata.profile_instance_id,
    sessionId: "session-a",
    generation: 1,
    socketPath,
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T01:00:00.000Z",
    leaseId: "lease-a",
    pairingNonce: "nonce-a",
  });
  if (auditLogger === "real") {
    auditLogger = await createPairingAuditLogger({ paths, generation: descriptor.generation });
  }
  const server = new PairingSocketServer({ paths, descriptor, profileInstanceId: metadata.profile_instance_id, now: NOW, auditLogger });
  return { runtimeRoot, paths, descriptor, server, auditLogger };
}

function message(descriptor, type, extra = {}) {
  return {
    type,
    protocol_version: 1,
    session_id: descriptor.session_id,
    browser_instance_id: descriptor.browser_instance_id,
    profile_instance_id: descriptor.profile_instance_id,
    generation: descriptor.generation,
    lease_id: descriptor.lease_id,
    host_connection_id: "connection-a",
    ...extra,
  };
}

async function activeClient(descriptor) {
  const socket = net.createConnection(descriptor.socket_path);
  await once(socket, "connect");
  socket.on("error", () => {});
  const decoder = new NativeMessageDecoder({ maxBytes: 64 * 1024 });
  const messages = [];
  let waiter = null;
  socket.on("data", (chunk) => {
    for (const item of decoder.push(chunk)) messages.push(item);
    if (waiter && messages.length > 0) {
      const resolve = waiter;
      waiter = null;
      resolve(messages.shift());
    }
  });
  const next = () => messages.length > 0 ? Promise.resolve(messages.shift()) : new Promise((resolve) => { waiter = resolve; });
  socket.write(encodeNativeMessage(message(descriptor, "host_register", { pairing_nonce: descriptor.pairing_nonce })));
  assert.equal((await next()).type, "pair_challenge");
  socket.write(encodeNativeMessage(message(descriptor, "pair_ack")));
  assert.equal((await next()).type, "pair_active");
  return { socket, next, hasMessage: () => messages.length > 0 };
}

function auditError() {
  const error = new Error(AUDIT_ERROR_CODE);
  error.code = AUDIT_ERROR_CODE;
  return error;
}

test("browser audit writes issued before dispatch and completion before resolve", async (t) => {
  const events = [];
  let releaseIssued;
  const issuedGate = new Promise((resolve) => { releaseIssued = resolve; });
  const logger = {
    async write(event) {
      events.push(event);
      if (event.outcome === "issued") await issuedGate;
    },
    async close() {},
  };
  const fixture = await serverFixture(logger);
  t.after(() => fixture.server.close());
  await fixture.server.listen();
  const client = await activeClient(fixture.descriptor);
  t.after(() => client.socket.destroy());

  const navigation = fixture.server.requestNavigate({ requestId: "audit-request", tabId: 7, url: "https://example.test/" });
  await Promise.resolve();
  assert.deepEqual(events.map((event) => event.outcome), ["issued"]);
  releaseIssued();
  assert.deepEqual(await client.next(), message(fixture.descriptor, "navigate_request", {
    request_id: "audit-request", tab_id: 7, url: "https://example.test/",
  }));
  client.socket.write(encodeNativeMessage(message(fixture.descriptor, "navigate_response", {
    request_id: "audit-request", tab_id: 7,
  })));
  await navigation;
  const failedRead = fixture.server.requestTabsList({ requestId: "audit-fixed-failure" });
  assert.equal((await client.next()).type, "tabs_list_request");
  client.socket.write(encodeNativeMessage(message(fixture.descriptor, "browser_error_response", {
    request_id: "audit-fixed-failure", command: "tabs_list", error_code: "tabs_unavailable",
  })));
  await assert.rejects(failedRead, (error) => error.code === "tabs_unavailable");
  assert.deepEqual(events.map((event) => event.outcome), ["issued", "success", "issued", "tabs_unavailable"]);
  for (const event of events) assert.deepEqual(Object.keys(event).sort(), [
    "browser_instance_id", "command", "generation", "outcome", "profile_instance_id", "request_id", "session_id", "timestamp",
  ]);
});

test("audit failure before dispatch rejects with audit_unavailable and sends nothing", async (t) => {
  const logger = { async write() { throw auditError(); }, async close() {} };
  const fixture = await serverFixture(logger);
  t.after(() => fixture.server.close());
  await fixture.server.listen();
  const client = await activeClient(fixture.descriptor);
  t.after(() => client.socket.destroy());

  const navigation = fixture.server.requestNavigate({ requestId: "audit-pre-failure", tabId: 7, url: "https://example.test/" });
  await assert.rejects(navigation, (error) => error.code === AUDIT_ERROR_CODE);
  assert.deepEqual(fixture.server.state.pendingBrowserRequests, []);
});

test("completion audit failure maps mutation to outcome_unknown and read to audit_unavailable", async (t) => {
  const logger = {
    async write(event) {
      if (event.outcome !== "issued") throw auditError();
    },
    async close() {},
  };
  const fixture = await serverFixture(logger);
  t.after(() => fixture.server.close());
  await fixture.server.listen();
  const client = await activeClient(fixture.descriptor);
  t.after(() => client.socket.destroy());

  const navigation = fixture.server.requestNavigate({ requestId: "audit-mutation-failure", tabId: 7, url: "https://example.test/" });
  assert.equal((await client.next()).type, "navigate_request");
  client.socket.write(encodeNativeMessage(message(fixture.descriptor, "navigate_response", {
    request_id: "audit-mutation-failure", tab_id: 7,
  })));
  await assert.rejects(navigation, (error) => error.code === "outcome_unknown");

  const status = fixture.server.requestBrowserStatus({ requestId: "audit-read-failure" });
  assert.equal((await client.next()).type, "browser_status_request");
  client.socket.write(encodeNativeMessage(message(fixture.descriptor, "browser_status_response", {
    request_id: "audit-read-failure",
    status: { extension_connected: true, chrome_tabs_available: true },
  })));
  await assert.rejects(status, (error) => error.code === AUDIT_ERROR_CODE);
});

test("browser timeout starts after issued audit and dispatch", async (t) => {
  const events = [];
  let releaseIssued;
  const issuedGate = new Promise((resolve) => { releaseIssued = resolve; });
  const logger = {
    async write(event) {
      events.push(event);
      if (event.outcome === "issued") await issuedGate;
    },
    async close() {},
  };
  const fixture = await serverFixture(logger);
  t.after(() => fixture.server.close());
  await fixture.server.listen();
  const client = await activeClient(fixture.descriptor);
  t.after(() => client.socket.destroy());

  const navigation = fixture.server.requestNavigate({
    requestId: "audit-delayed-timeout",
    tabId: 7,
    url: "https://example.test/",
    timeoutMs: 20,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(events.map((event) => event.outcome), ["issued"]);
  assert.equal(client.hasMessage(), false);
  releaseIssued();
  assert.equal((await client.next()).type, "navigate_request");
  await assert.rejects(navigation, (error) => error.code === "outcome_unknown");
  assert.deepEqual(events.map((event) => event.outcome), ["issued", "outcome_unknown"]);
});

test("closing while issued audit is pending sends nothing and records transport_closed", async (t) => {
  const events = [];
  let releaseIssued;
  const issuedGate = new Promise((resolve) => { releaseIssued = resolve; });
  const logger = {
    async write(event) {
      events.push(event);
      if (event.outcome === "issued") await issuedGate;
    },
    async close() {},
  };
  const fixture = await serverFixture(logger);
  t.after(() => fixture.server.close());
  await fixture.server.listen();
  const client = await activeClient(fixture.descriptor);
  t.after(() => client.socket.destroy());

  const navigation = fixture.server.requestNavigate({
    requestId: "audit-close-before-dispatch",
    tabId: 7,
    url: "https://example.test/",
    timeoutMs: 20,
  });
  const navigationRejected = assert.rejects(navigation, (error) => error.code === "transport_closed");
  await Promise.resolve();
  const closing = fixture.server.close();
  await Promise.resolve();
  assert.equal(client.hasMessage(), false);
  releaseIssued();
  await closing;
  await navigationRejected;
  assert.deepEqual(events.map((event) => event.outcome), ["issued", "transport_closed"]);
});

test("real audit logger preserves issued and completion for an immediate browser response", async (t) => {
  const fixture = await serverFixture("real");
  t.after(async () => {
    await fixture.server.close();
    await fixture.auditLogger.close();
  });
  await fixture.server.listen();
  const client = await activeClient(fixture.descriptor);
  t.after(() => client.socket.destroy());

  const status = fixture.server.requestBrowserStatus({ requestId: "real-audit-fast" });
  assert.equal((await client.next()).type, "browser_status_request");
  client.socket.write(encodeNativeMessage(message(fixture.descriptor, "browser_status_response", {
    request_id: "real-audit-fast",
    status: { extension_connected: true, chrome_tabs_available: true },
  })));
  await status;
  await fixture.auditLogger.close();
  const lines = (await readFile(pairingAuditFilePath(fixture.paths, fixture.descriptor.generation), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((event) => event.outcome), ["issued", "success"]);
});

test("reentrant browser response during socket.write still completes the real audit event", async (t) => {
  const fixture = await serverFixture("real");
  t.after(async () => {
    await fixture.server.close();
    await fixture.auditLogger.close();
  });
  await fixture.server.listen();
  const client = await activeClient(fixture.descriptor);
  t.after(() => client.socket.destroy());

  const originalWrite = net.Socket.prototype.write;
  let injected = false;
  net.Socket.prototype.write = function reentrantAuditWrite(chunk, ...args) {
    if (!injected && Buffer.isBuffer(chunk)) {
      const outbound = new NativeMessageDecoder({ maxBytes: 64 * 1024 }).push(chunk)[0];
      if (outbound?.type === "browser_status_request") {
        injected = true;
        this.emit("data", encodeNativeMessage(message(fixture.descriptor, "browser_status_response", {
          request_id: outbound.request_id,
          status: { extension_connected: true, chrome_tabs_available: true },
        })));
      }
    }
    return Reflect.apply(originalWrite, this, [chunk, ...args]);
  };
  try {
    const status = fixture.server.requestBrowserStatus({ requestId: "real-audit-reentrant" });
    assert.deepEqual(await status, {
      request_id: "real-audit-reentrant",
      command: "browser_status",
      session_id: fixture.descriptor.session_id,
      browser_instance_id: fixture.descriptor.browser_instance_id,
      profile_instance_id: fixture.descriptor.profile_instance_id,
      generation: fixture.descriptor.generation,
      lease_id: fixture.descriptor.lease_id,
      ok: true,
      status: { extension_connected: true, chrome_tabs_available: true },
    });
    assert.equal(injected, true);
  } finally {
    net.Socket.prototype.write = originalWrite;
  }
  await fixture.auditLogger.close();
  const lines = (await readFile(pairingAuditFilePath(fixture.paths, fixture.descriptor.generation), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((event) => event.outcome), ["issued", "success"]);
});
