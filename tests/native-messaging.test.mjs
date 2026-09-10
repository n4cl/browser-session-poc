import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import test from "node:test";
import { promisify } from "node:util";
import { extensionIdFromPublicKey, GATE_1_EXTENSION_ID, GATE_1_EXTENSION_ORIGIN } from "../core/extension-id.mjs";
import {
  installNativeHost,
  legacyNativeHostWrapperContent,
  nativeHostManifestContent,
  nativeHostWrapperContent,
  resolveNativeHostPaths,
  uninstallNativeHost,
} from "../core/native-host-manifest.mjs";
import {
  encodeNativeMessage,
  MAX_EXTENSION_TO_HOST_BYTES,
  MAX_HOST_TO_EXTENSION_BYTES,
  NativeMessageDecoder,
} from "../native-host/codec.mjs";
import {
  NATIVE_HOST_FAILURE_MARKER_FILENAME,
  NATIVE_HOST_FAILURE_REASONS,
  NATIVE_HOST_FAILURE_SCHEMA_VERSION,
  NATIVE_HOST_FAILURE_STAGES,
  parseNativeHostArguments,
  connectPairingSocket,
  runNativeHost,
  runPairingNativeHost,
} from "../native-host/host.mjs";
import {
  createPairingDescriptor,
  createSocketPath,
  loadOrCreateProfileMetadata,
  resolvePairingPaths,
  writeActivePairingDescriptor,
} from "../core/pairing-descriptor.mjs";
import { PairingSocketServer } from "../core/pairing-socket-server.mjs";
import { PAIRING_SOCKET_MAX_MESSAGE_BYTES } from "../core/pairing-protocol.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const execFile = promisify(execFileCallback);

function collect(stream) {
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  return () => Buffer.concat(chunks);
}

function nativeOutputQueue(stream) {
  const decoder = new NativeMessageDecoder();
  const messages = [];
  const waiters = [];
  stream.on("data", (chunk) => {
    for (const message of decoder.push(chunk)) {
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    }
  });
  return {
    next() {
      if (messages.length > 0) return Promise.resolve(messages.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

const PAIRING_NOW = new Date("2030-01-01T00:30:00.000Z");

function pairingIdentity(descriptor, hostConnectionId) {
  return {
    protocol_version: 1,
    session_id: descriptor.session_id,
    browser_instance_id: descriptor.browser_instance_id,
    profile_instance_id: descriptor.profile_instance_id,
    generation: descriptor.generation,
    lease_id: descriptor.lease_id,
    host_connection_id: hostConnectionId,
  };
}

async function pairingFixture(instanceId = "poc-a") {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp("/private/tmp/bsp-host-");
  const runtimeRoot = path.join(root, "runtime");
  const paths = resolvePairingPaths({ runtimeRoot, instanceId });
  const metadata = await loadOrCreateProfileMetadata(paths, {
    createUuid: () => "11111111-1111-4111-8111-111111111111",
  });
  const socketPath = await createSocketPath(paths, {
    createUuid: () => "22222222-2222-4222-8222-222222222222",
  });
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
  await writeActivePairingDescriptor(paths, descriptor, {
    profileInstanceId: metadata.profile_instance_id,
    now: PAIRING_NOW,
  });
  return { root, runtimeRoot, paths, metadata, descriptor };
}

function bridgeFor(challenge) {
  const sent = [];
  let closed = false;
  const messages = challenge.messages ?? [
    challenge.message,
    Object.fromEntries(Object.entries({ ...challenge.message, type: "pair_active" }).filter(([key]) => key !== "pairing_mode")),
  ];
  const waiters = [];
  const receive = () => {
    if (messages.length > 0) return Promise.resolve(messages.shift());
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
  const fail = () => {
    while (waiters.length > 0) waiters.shift().reject(new Error("bridge closed"));
  };
  return {
    sent,
    push(message) {
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else messages.push(message);
    },
    fail,
    async connector({ socketPath }) {
      assert.equal(socketPath, challenge.socket_path);
      return {
        send(message) { sent.push(message); },
        receive,
        close() { closed = true; fail(); },
      };
    },
    get closed() { return closed; },
  };
}

test("manifest public key derives the fixed unpacked extension ID", async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "extension", "manifest.json"), "utf8"));
  assert.equal(extensionIdFromPublicKey(manifest.key), GATE_1_EXTENSION_ID);
  assert.equal(manifest.version, "0.0.3");
  assert.deepEqual(manifest.permissions, ["nativeMessaging", "storage", "tabs", "debugger"]);
  assert.equal(manifest.permissions.includes("debugger"), true);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.options_ui, { page: "options.html", open_in_tab: true });
  const background = await readFile(path.join(repositoryRoot, "extension", "background.mjs"), "utf8");
  assert.match(background, /chrome\.runtime\.onInstalled\.addListener/);
  assert.match(background, /chromeApi\.runtime\.connectNative/);
  assert.match(background, /chromeApi\.runtime\.lastError\?\.message/);
  assert.match(background, /createPairingController/);
});

test("Native Messaging codec handles partial and multiple frames", () => {
  const first = encodeNativeMessage({ type: "hello" });
  const second = encodeNativeMessage({ type: "ack" });
  const decoder = new NativeMessageDecoder();

  assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(3), second])), [
    { type: "hello" },
    { type: "ack" },
  ]);
});

test("Native Messaging codec rejects invalid JSON and oversize frames", () => {
  const invalidJson = Buffer.alloc(5);
  invalidJson.writeUInt32LE(1, 0);
  invalidJson[4] = 0xff;
  assert.throws(() => new NativeMessageDecoder().push(invalidJson), /invalid JSON/);

  const oversizedHeader = Buffer.alloc(4);
  oversizedHeader.writeUInt32LE(MAX_EXTENSION_TO_HOST_BYTES + 1, 0);
  assert.throws(() => new NativeMessageDecoder().push(oversizedHeader), /exceeds/);
  assert.throws(
    () => encodeNativeMessage({ payload: "x".repeat(20) }, { maxBytes: 10 }),
    /exceeds/,
  );
  assert.equal(MAX_EXTENSION_TO_HOST_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_HOST_TO_EXTENSION_BYTES, 1 * 1024 * 1024);
});

test("Native Host session socket connector enforces the shared 64 KiB framing limit", async () => {
  class FakeSocket extends EventEmitter {
    writes = [];
    destroyed = false;
    write(frame) {
      this.writes.push(frame);
      return true;
    }
    destroy() { this.destroyed = true; }
  }
  const socket = new FakeSocket();
  const connecting = connectPairingSocket({ socketPath: "/tmp/unused.sock", socketFactory: () => socket });
  socket.emit("connect");
  const connector = await connecting;
  assert.equal(PAIRING_SOCKET_MAX_MESSAGE_BYTES, 64 * 1024);
  assert.throws(() => connector.send({ payload: "x".repeat(PAIRING_SOCKET_MAX_MESSAGE_BYTES + 1) }), /exceeds/);
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32LE(PAIRING_SOCKET_MAX_MESSAGE_BYTES + 1);
  socket.emit("data", oversized);
  assert.equal(socket.destroyed, true);
});

test("Native Host completes exact-origin hello and ack without stdout diagnostics", async () => {
  const root = await readTemporaryRoot("browser-poc-host-");
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const outputBytes = collect(output);
  const diagnostics = collect(stderr);
  const markerPath = path.join(root, "marker.json");

  const run = runNativeHost({
    input,
    output,
    stderr,
    origin: GATE_1_EXTENSION_ORIGIN,
    markerPath,
  });
  input.end(
    Buffer.concat([
      encodeNativeMessage({ type: "hello", protocol_version: 1 }),
      encodeNativeMessage({ type: "ack", protocol_version: 1 }),
    ]),
  );

  assert.equal(await run, true);
  assert.deepEqual(new NativeMessageDecoder().push(outputBytes()), [
    { type: "hello_ack", protocol_version: 1 },
  ]);
  assert.equal(diagnostics().length, 0);
  assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), {
    gate: 1,
    status: "native_messaging_acknowledged",
    recorded_at: (await JSON.parse(await readFile(markerPath, "utf8"))).recorded_at,
  });
  assert.equal((await stat(markerPath)).mode & 0o777, 0o600);
});

test("Native Host rejects an origin that is not an exact match", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const outputBytes = collect(output);
  const diagnostics = collect(stderr);
  input.end();

  assert.equal(
    await runNativeHost({
      input,
      output,
      stderr,
      origin: `${GATE_1_EXTENSION_ORIGIN}unexpected`,
      markerPath: path.join(await readTemporaryRoot("browser-poc-origin-"), "marker.json"),
    }),
    false,
  );
  assert.equal(outputBytes().length, 0);
  assert.match(diagnostics().toString("utf8"), /rejected unexpected extension origin/);
});

test("pairing Native Host bridges partial initial frames through one descriptor-selected socket", async () => {
  const fixture = await pairingFixture();
  const connectionId = "connection-a";
  const challenge = {
    socket_path: fixture.descriptor.socket_path,
    message: {
      type: "pair_challenge",
      ...pairingIdentity(fixture.descriptor, connectionId),
      pairing_mode: "initial",
    },
  };
  const bridge = bridgeFor(challenge);
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const outputBytes = collect(output);
  const diagnostics = collect(stderr);
  const run = runPairingNativeHost({
    input,
    output,
    stderr,
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: "poc-a",
    createUuid: () => connectionId,
    socketConnector: bridge.connector,
    now: PAIRING_NOW,
  });
  const start = encodeNativeMessage({ type: "pair_start", protocol_version: 1 });
  const ack = encodeNativeMessage({ type: "pair_ack", ...pairingIdentity(fixture.descriptor, connectionId) });
  input.write(start.subarray(0, 2));
  input.end(Buffer.concat([start.subarray(2), ack]));

  assert.equal(await run, true);
  assert.deepEqual(bridge.sent, [
    {
      type: "host_register",
      ...pairingIdentity(fixture.descriptor, connectionId),
      pairing_nonce: fixture.descriptor.pairing_nonce,
    },
    { type: "pair_ack", ...pairingIdentity(fixture.descriptor, connectionId) },
  ]);
  assert.deepEqual(new NativeMessageDecoder().push(outputBytes()), [
    challenge.message,
    {
      type: "pair_active",
      ...pairingIdentity(fixture.descriptor, connectionId),
    },
  ]);
  assert.equal(diagnostics().length, 0);
  assert.equal(bridge.closed, true);
});

test("pairing Native Host identifies an active handshake receive failure without exposing the socket error", async () => {
  const fixture = await pairingFixture();
  const connectionId = "connection-handshake-receive";
  const challenge = {
    type: "pair_challenge",
    ...pairingIdentity(fixture.descriptor, connectionId),
    pairing_mode: "initial",
  };
  let receives = 0;
  const sent = [];
  const failures = [];
  const bridge = {
    send(message) { sent.push(message); },
    receive() {
      receives += 1;
      if (receives === 1) return Promise.resolve(challenge);
      return Promise.reject(new Error("secret socket failure"));
    },
    close() {},
  };
  const input = new PassThrough();
  const run = runPairingNativeHost({
    input,
    output: new PassThrough(),
    stderr: new PassThrough(),
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: fixture.paths.instanceId,
    createUuid: () => connectionId,
    socketConnector: async () => bridge,
    recordFailure: async (marker) => failures.push(marker),
    now: PAIRING_NOW,
  });
  input.end(Buffer.concat([
    encodeNativeMessage({ type: "pair_start", protocol_version: 1 }),
    encodeNativeMessage({ type: "pair_ack", ...pairingIdentity(fixture.descriptor, connectionId) }),
  ]));

  assert.equal(await run, false);
  assert.deepEqual(sent, [
    {
      type: "host_register",
      ...pairingIdentity(fixture.descriptor, connectionId),
      pairing_nonce: fixture.descriptor.pairing_nonce,
    },
    { type: "pair_ack", ...pairingIdentity(fixture.descriptor, connectionId) },
  ]);
  assert.deepEqual(failures.map(({ stage, reason }) => ({ stage, reason })), [{
    stage: "handshake_receive_active",
    reason: "transport",
  }]);
  assert.doesNotMatch(JSON.stringify(failures), /secret socket failure|session-a|nonce-a/);
});

test("pairing Native Host identifies active handshake output failure without exposing the write error", async () => {
  const fixture = await pairingFixture();
  const connectionId = "connection-handshake-write";
  const bridge = bridgeFor({
    socket_path: fixture.descriptor.socket_path,
    message: {
      type: "pair_challenge",
      ...pairingIdentity(fixture.descriptor, connectionId),
      pairing_mode: "initial",
    },
  });
  let writes = 0;
  const failures = [];
  const output = {
    write() {
      writes += 1;
      if (writes === 2) throw new Error("secret output failure");
    },
  };
  const input = new PassThrough();
  const run = runPairingNativeHost({
    input,
    output,
    stderr: new PassThrough(),
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: fixture.paths.instanceId,
    createUuid: () => connectionId,
    socketConnector: bridge.connector,
    recordFailure: async (marker) => failures.push(marker),
    now: PAIRING_NOW,
  });
  input.end(Buffer.concat([
    encodeNativeMessage({ type: "pair_start", protocol_version: 1 }),
    encodeNativeMessage({ type: "pair_ack", ...pairingIdentity(fixture.descriptor, connectionId) }),
  ]));

  assert.equal(await run, false);
  assert.deepEqual(failures.map(({ stage, reason }) => ({ stage, reason })), [{
    stage: "handshake_write_active",
    reason: "transport",
  }]);
  assert.doesNotMatch(JSON.stringify(failures), /secret output failure|session-a|nonce-a/);
});

test("pairing Native Host failure diagnostics use exact fields and do not expose protocol secrets", async () => {
  const fixture = await pairingFixture();
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  input.end(encodeNativeMessage({ type: "unexpected", session_id: "secret-session", request_id: "secret-request" }));

  assert.equal(await runPairingNativeHost({
    input,
    output,
    stderr,
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: fixture.paths.instanceId,
    socketConnector: async () => { throw new Error("secret socket error"); },
    now: PAIRING_NOW,
  }), false);

  const markerPath = path.join(fixture.paths.instanceDir, NATIVE_HOST_FAILURE_MARKER_FILENAME);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  assert.deepEqual(Object.keys(marker).sort(), [
    "browser_instance_id",
    "reason",
    "recorded_at",
    "schema_version",
    "stage",
  ]);
  assert.equal(marker.schema_version, NATIVE_HOST_FAILURE_SCHEMA_VERSION);
  assert.equal(marker.browser_instance_id, fixture.paths.instanceId);
  assert.ok(NATIVE_HOST_FAILURE_STAGES.includes(marker.stage));
  assert.ok(NATIVE_HOST_FAILURE_REASONS.includes(marker.reason));
  assert.match(marker.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await stat(markerPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(markerPath, "utf8"), /secret-session|secret-request|secret socket error/);
});

test("pairing Native Host setup diagnostics identify descriptor and socket boundaries", async () => {
  const fixture = await pairingFixture();
  const descriptorFailures = [];
  const descriptorInput = new PassThrough();
  descriptorInput.end();
  assert.equal(
    await runPairingNativeHost({
      input: descriptorInput,
      output: new PassThrough(),
      stderr: new PassThrough(),
      origin: GATE_1_EXTENSION_ORIGIN,
      runtimeRoot: fixture.runtimeRoot,
      instanceId: fixture.paths.instanceId,
      readDescriptor: async () => { throw new Error("secret descriptor validation"); },
      recordFailure: async (marker) => descriptorFailures.push(marker),
      now: PAIRING_NOW,
    }),
    false,
  );
  assert.deepEqual(descriptorFailures.map(({ stage, reason }) => ({ stage, reason })), [{
    stage: "setup_read_descriptor",
    reason: "validation",
  }]);
  assert.doesNotMatch(JSON.stringify(descriptorFailures), /secret descriptor validation|session-a|nonce-a/);

  const socketFailures = [];
  const socketInput = new PassThrough();
  socketInput.end();
  assert.equal(
    await runPairingNativeHost({
      input: socketInput,
      output: new PassThrough(),
      stderr: new PassThrough(),
      origin: GATE_1_EXTENSION_ORIGIN,
      runtimeRoot: fixture.runtimeRoot,
      instanceId: fixture.paths.instanceId,
      socketConnector: async () => { throw new Error("secret socket transport"); },
      recordFailure: async (marker) => socketFailures.push(marker),
      now: PAIRING_NOW,
    }),
    false,
  );
  assert.deepEqual(socketFailures.map(({ stage, reason }) => ({ stage, reason })), [{
    stage: "setup_connect_socket",
    reason: "transport",
  }]);
  assert.doesNotMatch(JSON.stringify(socketFailures), /secret socket transport|session-a|nonce-a/);
});

test("pairing Native Host records an ACTIVE socket-to-Extension failure and ignores diagnostic writer errors", async (t) => {
  const fixture = await pairingFixture();
  const server = new PairingSocketServer({
    paths: fixture.paths,
    descriptor: fixture.descriptor,
    profileInstanceId: fixture.metadata.profile_instance_id,
    now: PAIRING_NOW,
  });
  t.after(() => server.close());
  await server.listen();

  const input = new PassThrough();
  input.on("error", () => {});
  const output = new PassThrough();
  const stderr = new PassThrough();
  const diagnosticsBytes = collect(stderr);
  const outputQueue = nativeOutputQueue(output);
  const failures = [];
  const run = runPairingNativeHost({
    input,
    output,
    stderr,
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: fixture.paths.instanceId,
    createUuid: () => "connection-diagnostic",
    recordFailure: async (marker) => {
      failures.push(marker);
      throw new Error("diagnostic sink unavailable");
    },
    now: PAIRING_NOW,
  });

  input.write(encodeNativeMessage({ type: "pair_start", protocol_version: 1 }));
  assert.equal((await outputQueue.next()).type, "pair_challenge");
  input.write(encodeNativeMessage({ type: "pair_ack", ...pairingIdentity(fixture.descriptor, "connection-diagnostic") }));
  assert.equal((await outputQueue.next()).type, "pair_active");
  server.disconnectActiveHost();

  assert.equal(await run, false);
  assert.deepEqual(failures.map(({ stage, reason }) => ({ stage, reason })), [{
    stage: "active_request_to_extension",
    reason: "transport",
  }]);
  const diagnostics = diagnosticsBytes().toString("utf8");
  assert.match(diagnostics, /rejected pairing protocol/);
  assert.match(diagnostics, /failure diagnostic unavailable/);
  assert.doesNotMatch(diagnostics, /diagnostic sink unavailable/);
});

test("pairing Native Host records input closure while an ACTIVE ping waits for Extension response", async (t) => {
  const fixture = await pairingFixture();
  const server = new PairingSocketServer({
    paths: fixture.paths,
    descriptor: fixture.descriptor,
    profileInstanceId: fixture.metadata.profile_instance_id,
    now: PAIRING_NOW,
  });
  t.after(() => server.close());
  await server.listen();

  const input = new PassThrough();
  const output = new PassThrough();
  const outputQueue = nativeOutputQueue(output);
  const run = runPairingNativeHost({
    input,
    output,
    stderr: new PassThrough(),
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: fixture.paths.instanceId,
    createUuid: () => "connection-pending-eof",
    now: PAIRING_NOW,
  });

  input.write(encodeNativeMessage({ type: "pair_start", protocol_version: 1 }));
  assert.equal((await outputQueue.next()).type, "pair_challenge");
  input.write(encodeNativeMessage({ type: "pair_ack", ...pairingIdentity(fixture.descriptor, "connection-pending-eof") }));
  assert.equal((await outputQueue.next()).type, "pair_active");

  const ping = server.requestPing({ requestId: "active-ping-eof", timeoutMs: 1_000 });
  assert.deepEqual(await outputQueue.next(), {
    type: "ping_request",
    ...pairingIdentity(fixture.descriptor, "connection-pending-eof"),
    request_id: "active-ping-eof",
  });
  input.end();

  assert.equal(await run, false);
  await assert.rejects(ping);
  const marker = JSON.parse(await readFile(
    path.join(fixture.paths.instanceDir, NATIVE_HOST_FAILURE_MARKER_FILENAME),
    "utf8",
  ));
  assert.deepEqual({ stage: marker.stage, reason: marker.reason }, {
    stage: "input_closed",
    reason: "transport",
  });
  assert.deepEqual(Object.keys(marker).sort(), [
    "browser_instance_id",
    "reason",
    "recorded_at",
    "schema_version",
    "stage",
  ]);
});

test("pairing Native Host normal ACTIVE input close does not create a failure marker", async () => {
  const fixture = await pairingFixture();
  const connectionId = "connection-normal-close";
  const bridge = bridgeFor({
    socket_path: fixture.descriptor.socket_path,
    message: {
      type: "pair_challenge",
      ...pairingIdentity(fixture.descriptor, connectionId),
      pairing_mode: "initial",
    },
  });
  const input = new PassThrough();
  const run = runPairingNativeHost({
    input,
    output: new PassThrough(),
    stderr: new PassThrough(),
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: fixture.paths.instanceId,
    createUuid: () => connectionId,
    socketConnector: bridge.connector,
    now: PAIRING_NOW,
  });
  input.end(Buffer.concat([
    encodeNativeMessage({ type: "pair_start", protocol_version: 1 }),
    encodeNativeMessage({ type: "pair_ack", ...pairingIdentity(fixture.descriptor, connectionId) }),
  ]));
  assert.equal(await run, true);
  await assert.rejects(
    readFile(path.join(fixture.paths.instanceDir, NATIVE_HOST_FAILURE_MARKER_FILENAME)),
    { code: "ENOENT" },
  );
});

test("pairing Native Host reaches the descriptor-selected session socket without a connector override", async (t) => {
  const fixture = await pairingFixture();
  const server = new PairingSocketServer({
    paths: fixture.paths,
    descriptor: fixture.descriptor,
    profileInstanceId: fixture.metadata.profile_instance_id,
    now: PAIRING_NOW,
  });
  t.after(() => server.close());
  await server.listen();

  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const firstOutput = new Promise((resolve) => output.once("data", resolve));
  const run = runPairingNativeHost({
    input,
    output,
    stderr,
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: "poc-a",
    createUuid: () => "connection-integration",
    now: PAIRING_NOW,
  });
  input.write(encodeNativeMessage({ type: "pair_start", protocol_version: 1 }));
  const [challenge] = new NativeMessageDecoder().push(await firstOutput);
  assert.equal(challenge.type, "pair_challenge");
  input.end(encodeNativeMessage({ type: "pair_ack", ...pairingIdentity(fixture.descriptor, "connection-integration") }));
  assert.equal(await run, true);
  assert.equal(stderr.read(), null);
});

test("pairing Native Host forwards a valid snapshot response without exiting", async (t) => {
  const fixture = await pairingFixture();
  const server = new PairingSocketServer({
    paths: fixture.paths,
    descriptor: fixture.descriptor,
    profileInstanceId: fixture.metadata.profile_instance_id,
    now: PAIRING_NOW,
  });
  t.after(() => server.close());
  await server.listen();

  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const outputQueue = nativeOutputQueue(output);
  let settled = false;
  const run = runPairingNativeHost({
    input,
    output,
    stderr,
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: "poc-a",
    createUuid: () => "connection-snapshot",
    now: PAIRING_NOW,
  });
  run.then(() => { settled = true; });

  input.write(encodeNativeMessage({ type: "pair_start", protocol_version: 1 }));
  assert.equal((await outputQueue.next()).type, "pair_challenge");
  input.write(encodeNativeMessage({ type: "pair_ack", ...pairingIdentity(fixture.descriptor, "connection-snapshot") }));
  assert.equal((await outputQueue.next()).type, "pair_active");

  const snapshot = server.requestSnapshot({ requestId: "native-snapshot", tabId: 7, timeoutMs: 1_000 });
  assert.deepEqual(await outputQueue.next(), {
    type: "snapshot_request",
    ...pairingIdentity(fixture.descriptor, "connection-snapshot"),
    request_id: "native-snapshot",
    tab_id: 7,
  });
  input.write(encodeNativeMessage({
    type: "snapshot_response",
    ...pairingIdentity(fixture.descriptor, "connection-snapshot"),
    request_id: "native-snapshot",
    tab_id: 7,
    document: { loader_id: "loader-native" },
    nodes: [],
    truncated: false,
    partial: false,
  }));
  assert.deepEqual(await snapshot, {
    request_id: "native-snapshot",
    command: "snapshot",
    session_id: fixture.descriptor.session_id,
    browser_instance_id: fixture.descriptor.browser_instance_id,
    profile_instance_id: fixture.descriptor.profile_instance_id,
    generation: fixture.descriptor.generation,
    lease_id: fixture.descriptor.lease_id,
    ok: true,
    tab_id: 7,
    document: { loader_id: "loader-native" },
    nodes: [],
    truncated: false,
    partial: false,
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(stderr.read(), null);

  const click = server.requestClick({
    requestId: "native-click",
    tabId: 7,
    loaderId: "loader-native",
    backendDomNodeId: 42,
    timeoutMs: 1_000,
  });
  assert.deepEqual(await outputQueue.next(), {
    type: "click_request",
    ...pairingIdentity(fixture.descriptor, "connection-snapshot"),
    request_id: "native-click",
    tab_id: 7,
    loader_id: "loader-native",
    backend_dom_node_id: 42,
  });
  input.write(encodeNativeMessage({
    type: "click_response",
    ...pairingIdentity(fixture.descriptor, "connection-snapshot"),
    request_id: "native-click",
    tab_id: 7,
    loader_id: "loader-native",
    backend_dom_node_id: 42,
    accepted: true,
  }));
  assert.deepEqual(await click, {
    request_id: "native-click",
    command: "click",
    session_id: fixture.descriptor.session_id,
    browser_instance_id: fixture.descriptor.browser_instance_id,
    profile_instance_id: fixture.metadata.profile_instance_id,
    generation: fixture.descriptor.generation,
    lease_id: fixture.descriptor.lease_id,
    ok: true,
    tab_id: 7,
    loader_id: "loader-native",
    backend_dom_node_id: 42,
    accepted: true,
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(stderr.read(), null);
  input.end();
  assert.equal(await run, true);
});

test("pairing Native Host rejects an invalid snapshot schema", async (t) => {
  const fixture = await pairingFixture();
  const server = new PairingSocketServer({
    paths: fixture.paths,
    descriptor: fixture.descriptor,
    profileInstanceId: fixture.metadata.profile_instance_id,
    now: PAIRING_NOW,
  });
  t.after(() => server.close());
  await server.listen();

  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const outputQueue = nativeOutputQueue(output);
  const run = runPairingNativeHost({
    input,
    output,
    stderr,
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: "poc-a",
    createUuid: () => "connection-invalid-snapshot",
    now: PAIRING_NOW,
  });
  input.write(encodeNativeMessage({ type: "pair_start", protocol_version: 1 }));
  assert.equal((await outputQueue.next()).type, "pair_challenge");
  input.write(encodeNativeMessage({ type: "pair_ack", ...pairingIdentity(fixture.descriptor, "connection-invalid-snapshot") }));
  assert.equal((await outputQueue.next()).type, "pair_active");

  const snapshot = server.requestSnapshot({ requestId: "invalid-native-snapshot", tabId: 7, timeoutMs: 1_000 });
  assert.equal((await outputQueue.next()).type, "snapshot_request");
  const rejected = assert.rejects(snapshot, (error) => error.code === "timeout");
  input.write(encodeNativeMessage({
    type: "snapshot_response",
    ...pairingIdentity(fixture.descriptor, "connection-invalid-snapshot"),
    request_id: "invalid-native-snapshot",
    tab_id: 7,
    document: { loader_id: "loader-invalid" },
    nodes: [{
      ref: 1,
      parent_ref: 1,
      backend_dom_node_id: null,
      role: "document",
      name: null,
      value: null,
      state: { disabled: false, expanded: false, focused: false, hidden: false },
    }],
    truncated: false,
    partial: false,
  }));
  assert.equal(await run, false);
  await rejected;
  assert.match(stderr.read().toString("utf8"), /rejected pairing protocol/);
});

test("pairing Native Host validates resume bindings and cannot use another instance descriptor", async () => {
  const fixture = await pairingFixture();
  const connectionId = "connection-b";
  const challenge = {
    socket_path: fixture.descriptor.socket_path,
    message: {
      type: "pair_challenge",
      ...pairingIdentity(fixture.descriptor, connectionId),
      pairing_mode: "resume",
    },
  };
  const bridge = bridgeFor(challenge);
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const run = runPairingNativeHost({
    input,
    output,
    stderr,
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: "poc-a",
    createUuid: () => connectionId,
    socketConnector: bridge.connector,
    now: PAIRING_NOW,
  });
  input.end(Buffer.concat([
    encodeNativeMessage({
      type: "resume_start",
      protocol_version: 1,
      session_id: fixture.descriptor.session_id,
      browser_instance_id: fixture.descriptor.browser_instance_id,
      profile_instance_id: fixture.descriptor.profile_instance_id,
      generation: fixture.descriptor.generation,
      lease_id: fixture.descriptor.lease_id,
    }),
    encodeNativeMessage({ type: "pair_ack", ...pairingIdentity(fixture.descriptor, connectionId) }),
  ]));
  assert.equal(await run, true);
  assert.deepEqual(bridge.sent[0], { type: "resume", ...pairingIdentity(fixture.descriptor, connectionId) });

  const foreignInput = new PassThrough();
  const foreignOutput = new PassThrough();
  const foreignStderr = new PassThrough();
  const foreignRun = runPairingNativeHost({
    input: foreignInput,
    output: foreignOutput,
    stderr: foreignStderr,
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: "poc-b",
    socketConnector: bridge.connector,
    now: PAIRING_NOW,
  });
  foreignInput.end(encodeNativeMessage({ type: "pair_start", protocol_version: 1 }));
  assert.equal(await foreignRun, false);
  assert.equal(foreignOutput.read(), null);
  assert.match(foreignStderr.read().toString("utf8"), /rejected pairing protocol/);

  await writeFile(
    fixture.paths.activeDescriptorPath,
    `${JSON.stringify({ ...fixture.descriptor, browser_instance_id: "poc-b" })}\n`,
    { mode: 0o600 },
  );
  const wrongDescriptorInput = new PassThrough();
  const wrongDescriptorOutput = new PassThrough();
  const wrongDescriptorStderr = new PassThrough();
  const wrongDescriptorRun = runPairingNativeHost({
    input: wrongDescriptorInput,
    output: wrongDescriptorOutput,
    stderr: wrongDescriptorStderr,
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: "poc-a",
    socketConnector: bridge.connector,
    now: PAIRING_NOW,
  });
  wrongDescriptorInput.end(encodeNativeMessage({ type: "pair_start", protocol_version: 1 }));
  assert.equal(await wrongDescriptorRun, false);
  assert.equal(wrongDescriptorOutput.read(), null);
});

test("pairing Native Host requests a rebind for a stale resume without registering it", async () => {
  const fixture = await pairingFixture();
  const bridge = bridgeFor({
    socket_path: fixture.descriptor.socket_path,
    message: { type: "unused" },
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const outputQueue = nativeOutputQueue(output);
  const failures = [];
  const run = runPairingNativeHost({
    input,
    output,
    stderr: new PassThrough(),
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: "poc-a",
    createUuid: () => "connection-stale",
    socketConnector: bridge.connector,
    recordFailure: async (marker) => failures.push(marker),
    now: PAIRING_NOW,
  });
  input.end(encodeNativeMessage({
    type: "resume_start",
    protocol_version: 1,
    session_id: "stale-session",
    browser_instance_id: fixture.descriptor.browser_instance_id,
    profile_instance_id: fixture.descriptor.profile_instance_id,
    generation: fixture.descriptor.generation,
    lease_id: fixture.descriptor.lease_id,
  }));

  assert.equal(await run, false);
  assert.deepEqual(await outputQueue.next(), {
    type: "rebind_required",
    protocol_version: 1,
  });
  assert.deepEqual(bridge.sent, []);
  assert.equal(bridge.closed, true);
  assert.deepEqual(failures, []);
});

test("pairing Native Host rejects stale resumes from another browser or profile instance", async () => {
  for (const field of ["browser_instance_id", "profile_instance_id"]) {
    const fixture = await pairingFixture();
    const bridge = bridgeFor({
      socket_path: fixture.descriptor.socket_path,
      message: { type: "unused" },
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const stderr = new PassThrough();
    const failures = [];
    const run = runPairingNativeHost({
      input,
      output,
      stderr,
      origin: GATE_1_EXTENSION_ORIGIN,
      runtimeRoot: fixture.runtimeRoot,
      instanceId: "poc-a",
      createUuid: () => "connection-foreign-instance",
      socketConnector: bridge.connector,
      recordFailure: async (marker) => failures.push(marker),
      now: PAIRING_NOW,
    });
    input.end(encodeNativeMessage({
      type: "resume_start",
      protocol_version: 1,
      session_id: fixture.descriptor.session_id,
      browser_instance_id: field === "browser_instance_id"
        ? "foreign-browser-instance"
        : fixture.descriptor.browser_instance_id,
      profile_instance_id: field === "profile_instance_id"
        ? "foreign-profile-instance"
        : fixture.descriptor.profile_instance_id,
      generation: fixture.descriptor.generation,
      lease_id: fixture.descriptor.lease_id,
    }));

    assert.equal(await run, false);
    assert.equal(output.read(), null);
    assert.deepEqual(bridge.sent, []);
    assert.equal(bridge.closed, true);
    assert.deepEqual(failures.map(({ stage, reason }) => ({ stage, reason })), [{
      stage: "handshake_send_register",
      reason: "validation",
    }]);
    assert.equal(stderr.read().toString("utf8"), "[browser-session-poc native-host] rejected pairing protocol\n");
  }
});

test("pairing Native Host rejects socket failures, expired descriptors, and mismatched acknowledgements", async () => {
  const fixture = await pairingFixture();
  const connectionId = "connection-a";
  const rejectionInput = new PassThrough();
  const rejectionOutput = new PassThrough();
  const rejectionStderr = new PassThrough();
  const rejected = runPairingNativeHost({
    input: rejectionInput,
    output: rejectionOutput,
    stderr: rejectionStderr,
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: "poc-a",
    socketConnector: async () => { throw new Error("socket refused"); },
    now: PAIRING_NOW,
  });
  rejectionInput.end(encodeNativeMessage({ type: "pair_start", protocol_version: 1 }));
  assert.equal(await rejected, false);

  const originInput = new PassThrough();
  originInput.end(encodeNativeMessage({ type: "pair_start", protocol_version: 1 }));
  assert.equal(
    await runPairingNativeHost({
      input: originInput,
      output: new PassThrough(),
      stderr: new PassThrough(),
      origin: `${GATE_1_EXTENSION_ORIGIN}wrong`,
      runtimeRoot: fixture.runtimeRoot,
      instanceId: "poc-a",
      socketConnector: async () => { throw new Error("should not connect"); },
      now: PAIRING_NOW,
    }),
    false,
  );

  const expiredInput = new PassThrough();
  const expiredOutput = new PassThrough();
  const expiredStderr = new PassThrough();
  const expired = runPairingNativeHost({
    input: expiredInput,
    output: expiredOutput,
    stderr: expiredStderr,
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: "poc-a",
    socketConnector: async () => { throw new Error("should not connect"); },
    now: new Date("2030-01-01T01:00:00.000Z"),
  });
  expiredInput.end(encodeNativeMessage({ type: "pair_start", protocol_version: 1 }));
  assert.equal(await expired, false);

  const mismatch = bridgeFor({
    socket_path: fixture.descriptor.socket_path,
    message: { type: "pair_challenge", ...pairingIdentity(fixture.descriptor, connectionId), pairing_mode: "initial" },
  });
  const mismatchInput = new PassThrough();
  const mismatchOutput = new PassThrough();
  const mismatchStderr = new PassThrough();
  const mismatchedRun = runPairingNativeHost({
    input: mismatchInput,
    output: mismatchOutput,
    stderr: mismatchStderr,
    origin: GATE_1_EXTENSION_ORIGIN,
    runtimeRoot: fixture.runtimeRoot,
    instanceId: "poc-a",
    createUuid: () => connectionId,
    socketConnector: mismatch.connector,
    now: PAIRING_NOW,
  });
  mismatchInput.end(Buffer.concat([
    encodeNativeMessage({ type: "pair_start", protocol_version: 1 }),
    encodeNativeMessage({ type: "pair_ack", ...pairingIdentity(fixture.descriptor, "other-connection") }),
  ]));
  assert.equal(await mismatchedRun, false);
  assert.equal(mismatch.sent.length, 1);
});

test("pairing Native Host arguments are strict while the direct Gate 1 entry point remains explicit", () => {
  assert.deepEqual(parseNativeHostArguments([GATE_1_EXTENSION_ORIGIN]), {
    mode: "gate1",
    origin: GATE_1_EXTENSION_ORIGIN,
  });
  assert.deepEqual(
    parseNativeHostArguments([
      "--pairing-runtime-root",
      "/tmp/browser-poc",
      "--pairing-instance-id",
      "poc-a",
      GATE_1_EXTENSION_ORIGIN,
    ]),
    {
      mode: "pairing",
      runtimeRoot: "/tmp/browser-poc",
      instanceId: "poc-a",
      origin: GATE_1_EXTENSION_ORIGIN,
    },
  );
  assert.throws(() => parseNativeHostArguments(["--pairing-runtime-root", "/tmp", GATE_1_EXTENSION_ORIGIN]));
  assert.throws(() => parseNativeHostArguments(["--pairing-runtime-root", "relative", "--pairing-instance-id", "poc-a", GATE_1_EXTENSION_ORIGIN]));
});

test("Native Messaging manifest install and uninstall protect pre-existing files", async () => {
  const root = await readTemporaryRoot("browser-poc-manifest-");
  const paths = resolveNativeHostPaths({
    repositoryRoot,
    runtimeRoot: path.join(root, "runtime"),
    instanceId: "poc-a",
    executablePath: process.execPath,
  });

  assert.equal((await installNativeHost(paths)).installed, true);
  assert.equal((await installNativeHost(paths)).upgraded, false);
  assert.equal(await readFile(paths.manifestPath, "utf8"), nativeHostManifestContent(paths));
  assert.equal(await readFile(paths.wrapperPath, "utf8"), nativeHostWrapperContent(paths));
  assert.match(await readFile(paths.wrapperPath, "utf8"), /--pairing-runtime-root/);
  assert.match(await readFile(paths.wrapperPath, "utf8"), /--pairing-instance-id 'poc-a'/);
  assert.equal((await stat(paths.manifestPath)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.wrapperPath)).mode & 0o777, 0o700);
  assert.deepEqual(await installNativeHost(paths), {
    installed: false,
    upgraded: false,
    manifestPath: paths.manifestPath,
  });

  assert.equal((await uninstallNativeHost(paths)).removed, true);
  await assert.rejects(() => readFile(paths.manifestPath));
  await assert.rejects(() => readFile(paths.wrapperPath));
});

test("Native Host install atomically upgrades only the exact private Gate 1 wrapper", async () => {
  const root = await readTemporaryRoot("browser-poc-manifest-upgrade-");
  const paths = resolveNativeHostPaths({
    repositoryRoot,
    runtimeRoot: path.join(root, "runtime"),
    instanceId: "poc-a",
    executablePath: process.execPath,
  });
  await mkdir(path.dirname(paths.manifestPath), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(paths.wrapperPath), { recursive: true, mode: 0o700 });
  await writeFile(paths.manifestPath, nativeHostManifestContent(paths), { mode: 0o600 });
  await writeFile(paths.wrapperPath, legacyNativeHostWrapperContent(paths), { mode: 0o700 });

  assert.deepEqual(await installNativeHost(paths), {
    installed: false,
    upgraded: true,
    manifestPath: paths.manifestPath,
  });
  assert.equal(await readFile(paths.wrapperPath, "utf8"), nativeHostWrapperContent(paths));
  assert.equal((await stat(paths.manifestPath)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.wrapperPath)).mode & 0o777, 0o700);
  assert.equal((await uninstallNativeHost(paths)).removed, true);
});

test("Native Host CLI prints the wrapper upgrade result as JSON", async () => {
  const root = await readTemporaryRoot("browser-poc-manifest-cli-upgrade-");
  const runtimeRoot = path.join(root, "runtime");
  const paths = resolveNativeHostPaths({
    repositoryRoot,
    runtimeRoot,
    instanceId: "poc-a",
    executablePath: process.execPath,
  });
  await mkdir(path.dirname(paths.manifestPath), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(paths.wrapperPath), { recursive: true, mode: 0o700 });
  await writeFile(paths.manifestPath, nativeHostManifestContent(paths), { mode: 0o600 });
  await writeFile(paths.wrapperPath, legacyNativeHostWrapperContent(paths), { mode: 0o700 });

  const { stdout } = await execFile(
    process.execPath,
    [path.join(repositoryRoot, "scripts", "native-host-manifest.mjs"), "install", "poc-a"],
    { env: { ...process.env, BROWSER_POC_RUNTIME_ROOT: runtimeRoot } },
  );
  assert.deepEqual(JSON.parse(stdout), {
    installed: false,
    upgraded: true,
    manifestPath: paths.manifestPath,
  });
});

test("Native Host install rejects unsafe legacy wrappers and manifests", async () => {
  const root = await readTemporaryRoot("browser-poc-manifest-unsafe-");
  const paths = resolveNativeHostPaths({
    repositoryRoot,
    runtimeRoot: path.join(root, "runtime"),
    instanceId: "poc-a",
    executablePath: process.execPath,
  });
  await mkdir(path.dirname(paths.manifestPath), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(paths.wrapperPath), { recursive: true, mode: 0o700 });
  await writeFile(paths.manifestPath, nativeHostManifestContent(paths), { mode: 0o600 });
  await writeFile(paths.wrapperPath, legacyNativeHostWrapperContent(paths), { mode: 0o700 });
  await chmod(paths.wrapperPath, 0o644);
  await assert.rejects(() => installNativeHost(paths), /refusing to overwrite/);

  await chmod(paths.wrapperPath, 0o700);
  const replacement = `${paths.wrapperPath}.replacement`;
  await writeFile(replacement, "not-a-wrapper\n", { mode: 0o700 });
  await rename(paths.wrapperPath, `${paths.wrapperPath}.saved`);
  await symlink(replacement, paths.wrapperPath);
  await assert.rejects(() => installNativeHost(paths), /refusing to overwrite/);
});

test("Native Messaging manifest refuses a non-PoC manifest", async () => {
  const root = await readTemporaryRoot("browser-poc-manifest-conflict-");
  const paths = resolveNativeHostPaths({
    repositoryRoot,
    runtimeRoot: path.join(root, "runtime"),
    instanceId: "poc-a",
    executablePath: process.execPath,
  });
  await import("node:fs/promises").then(({ mkdir, writeFile }) =>
    mkdir(path.dirname(paths.manifestPath), { recursive: true }).then(() =>
      writeFile(paths.manifestPath, '{"name":"another-host"}\n'),
    ),
  );

  await assert.rejects(() => installNativeHost(paths), /refusing to overwrite/);
  await assert.rejects(() => uninstallNativeHost(paths), /not generated by this PoC/);
  assert.equal(await readFile(paths.manifestPath, "utf8"), '{"name":"another-host"}\n');
});

test("Native Messaging manifests are isolated to the browser instance user data directory", () => {
  const runtimeRoot = "/tmp/browser-poc-runtime";
  const first = resolveNativeHostPaths({
    repositoryRoot,
    runtimeRoot,
    instanceId: "poc-a",
    executablePath: process.execPath,
  });
  const second = resolveNativeHostPaths({
    repositoryRoot,
    runtimeRoot,
    instanceId: "poc-b",
    executablePath: process.execPath,
  });

  assert.equal(
    first.manifestPath,
    path.join(
      runtimeRoot,
      "profiles",
      "poc-a",
      "NativeMessagingHosts",
      "com.browser_session_poc.gate1.json",
    ),
  );
  assert.equal(first.manifestPath.includes(`${path.sep}Default${path.sep}`), false);
  assert.notEqual(first.manifestPath, second.manifestPath);
  assert.notEqual(first.wrapperPath, second.wrapperPath);
  assert.throws(
    () =>
      resolveNativeHostPaths({
        repositoryRoot,
        runtimeRoot,
        instanceId: "../outside",
        executablePath: process.execPath,
      }),
    /instance ID/,
  );
});

async function readTemporaryRoot(prefix) {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(path.join(os.tmpdir(), prefix));
}
