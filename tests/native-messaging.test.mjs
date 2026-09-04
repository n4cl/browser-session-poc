import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import test from "node:test";
import { extensionIdFromPublicKey, GATE_1_EXTENSION_ID, GATE_1_EXTENSION_ORIGIN } from "../core/extension-id.mjs";
import {
  installNativeHost,
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

function collect(stream) {
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  return () => Buffer.concat(chunks);
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
  assert.deepEqual(manifest.permissions, ["nativeMessaging", "storage"]);
  assert.equal(manifest.permissions.includes("debugger"), false);
  assert.equal(manifest.host_permissions, undefined);
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
  assert.equal(await readFile(paths.manifestPath, "utf8"), nativeHostManifestContent(paths));
  assert.equal(await readFile(paths.wrapperPath, "utf8"), nativeHostWrapperContent(paths));
  assert.match(await readFile(paths.wrapperPath, "utf8"), /--pairing-runtime-root/);
  assert.match(await readFile(paths.wrapperPath, "utf8"), /--pairing-instance-id 'poc-a'/);
  assert.equal((await stat(paths.manifestPath)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.wrapperPath)).mode & 0o777, 0o700);
  assert.equal((await installNativeHost(paths)).installed, false);

  assert.equal((await uninstallNativeHost(paths)).removed, true);
  await assert.rejects(() => readFile(paths.manifestPath));
  await assert.rejects(() => readFile(paths.wrapperPath));
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
