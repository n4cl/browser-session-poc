import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { GATE_1_EXTENSION_ORIGIN } from "../core/extension-id.mjs";
import { PAIRING_IDENTITY_FIELDS, PAIRING_PROTOCOL_VERSION, PAIRING_SOCKET_MAX_MESSAGE_BYTES } from "../core/pairing-protocol.mjs";
import {
  validateBrowserCommandRequest,
  validateBrowserCommandResponse,
} from "../core/browser-command-protocol.mjs";
import {
  readActivePairingDescriptor,
  readProfileMetadata,
  resolvePairingPaths,
} from "../core/pairing-descriptor.mjs";
import {
  encodeNativeMessage,
  MAX_EXTENSION_TO_HOST_BYTES,
  MAX_HOST_TO_EXTENSION_BYTES,
  NativeMessageDecoder,
} from "./codec.mjs";

export const GATE_1_NATIVE_HOST_NAME = "com.browser_session_poc.gate1";
export const GATE_1_PROTOCOL_VERSION = 1;
export { PAIRING_PROTOCOL_VERSION } from "../core/pairing-protocol.mjs";

export const NATIVE_HOST_FAILURE_SCHEMA_VERSION = 1;
export const NATIVE_HOST_FAILURE_MARKER_FILENAME = "native-host-last-failure.json";
export const NATIVE_HOST_FAILURE_STAGES = Object.freeze([
  "setup_resolve_paths",
  "setup_validate_origin",
  "setup_read_profile",
  "setup_read_descriptor",
  "setup_create_connection_id",
  "setup_connect_socket",
  "setup_validate_connector",
  "handshake_send_register",
  "handshake_receive_challenge",
  "handshake_write_challenge",
  "handshake_validate_ack",
  "handshake_send_ack",
  "handshake_receive_active",
  "handshake_write_active",
  "active_request_to_extension",
  "active_response_to_socket",
  "input_closed",
]);
export const NATIVE_HOST_FAILURE_REASONS = Object.freeze([
  "validation",
  "transport",
  "unexpected",
]);

function runtimeRoot() {
  return process.env.BROWSER_POC_RUNTIME_ROOT
    ? path.resolve(process.env.BROWSER_POC_RUNTIME_ROOT)
    : path.resolve(import.meta.dirname, "..", ".runtime");
}

export function successMarkerPath({ root = runtimeRoot() } = {}) {
  return path.join(root, "native-host", "gate-1-success.json");
}

export async function writeSuccessMarker(markerPath) {
  await mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  const marker = {
    gate: 1,
    status: "native_messaging_acknowledged",
    recorded_at: new Date().toISOString(),
  };
  await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  await rename(temporaryPath, markerPath);
}

function diagnostic(stderr, message) {
  stderr.write(`[browser-session-poc native-host] ${message}\n`);
}

async function recordNativeHostFailure(marker, { runtimeRoot, instanceId }) {
  if (
    !marker ||
    marker.schema_version !== NATIVE_HOST_FAILURE_SCHEMA_VERSION ||
    marker.browser_instance_id !== instanceId ||
    !NATIVE_HOST_FAILURE_STAGES.includes(marker.stage) ||
    !NATIVE_HOST_FAILURE_REASONS.includes(marker.reason) ||
    typeof marker.recorded_at !== "string"
  ) {
    throw new Error("invalid Native Host failure marker");
  }
  const markerPath = path.join(
    path.resolve(runtimeRoot),
    "instances",
    instanceId,
    NATIVE_HOST_FAILURE_MARKER_FILENAME,
  );
  await mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${markerPath}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, markerPath);
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function assertExactFields(message, fields) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error("invalid protocol message");
  }
  const actual = Object.keys(message).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error("invalid protocol message");
  }
}

function descriptorIdentity(descriptor, hostConnectionId) {
  return {
    protocol_version: PAIRING_PROTOCOL_VERSION,
    session_id: descriptor.session_id,
    browser_instance_id: descriptor.browser_instance_id,
    profile_instance_id: descriptor.profile_instance_id,
    generation: descriptor.generation,
    lease_id: descriptor.lease_id,
    host_connection_id: hostConnectionId,
  };
}

function assertIdentity(message, descriptor, hostConnectionId) {
  if (message.protocol_version !== PAIRING_PROTOCOL_VERSION) {
    throw new Error("pairing protocol version does not match");
  }
  for (const field of PAIRING_IDENTITY_FIELDS) {
    if (message[field] !== descriptor[field]) {
      throw new Error("pairing identity does not match");
    }
  }
  if (message.host_connection_id !== hostConnectionId) {
    throw new Error("pairing connection does not match");
  }
}

function assertPairStart(message) {
  assertExactFields(message, ["type", "protocol_version"]);
  if (message.type !== "pair_start" || message.protocol_version !== PAIRING_PROTOCOL_VERSION) {
    throw new Error("invalid pair start");
  }
}

function assertResumeStart(message, descriptor) {
  assertExactFields(message, ["type", "protocol_version", ...PAIRING_IDENTITY_FIELDS]);
  if (message.type !== "resume_start" || message.protocol_version !== PAIRING_PROTOCOL_VERSION) {
    throw new Error("invalid resume start");
  }
  for (const field of PAIRING_IDENTITY_FIELDS) {
    if (message[field] !== descriptor[field]) {
      throw new Error("resume identity does not match");
    }
  }
}

function assertPairAck(message, descriptor, hostConnectionId) {
  assertExactFields(message, ["type", "protocol_version", ...PAIRING_IDENTITY_FIELDS, "host_connection_id"]);
  if (message.type !== "pair_ack") {
    throw new Error("invalid pair acknowledgement");
  }
  assertIdentity(message, descriptor, hostConnectionId);
}

function assertPairChallenge(message, descriptor, hostConnectionId, pairingMode) {
  assertExactFields(message, [
    "type",
    "protocol_version",
    ...PAIRING_IDENTITY_FIELDS,
    "host_connection_id",
    "pairing_mode",
  ]);
  if (message.type !== "pair_challenge" || message.pairing_mode !== pairingMode) {
    throw new Error("invalid pairing challenge");
  }
  assertIdentity(message, descriptor, hostConnectionId);
}

function assertPairActive(message, descriptor, hostConnectionId) {
  assertExactFields(message, ["type", "protocol_version", ...PAIRING_IDENTITY_FIELDS, "host_connection_id"]);
  if (message.type !== "pair_active") {
    throw new Error("invalid pairing activation");
  }
  assertIdentity(message, descriptor, hostConnectionId);
}

function assertPing(message, descriptor, hostConnectionId, type) {
  assertExactFields(message, ["type", "request_id", "protocol_version", ...PAIRING_IDENTITY_FIELDS, "host_connection_id"]);
  if (message.type !== type || !isNonEmptyString(message.request_id)) throw new Error("invalid pairing ping");
  assertIdentity(message, descriptor, hostConnectionId);
}

function assertExtensionRequest(message, descriptor, hostConnectionId) {
  if (message?.type === "ping_request") {
    assertPing(message, descriptor, hostConnectionId, "ping_request");
    return { command: "ping", requestId: message.request_id };
  }
  return validateBrowserCommandRequest(message, { binding: descriptor, connectionId: hostConnectionId });
}

function assertExtensionResponse(message, descriptor, hostConnectionId) {
  if (message?.type === "ping_response") {
    assertPing(message, descriptor, hostConnectionId, "ping_response");
    return { command: "ping", requestId: message.request_id };
  }
  const command = message?.type === "browser_status_response"
    ? "browser_status"
    : message?.type === "tabs_list_response"
      ? "tabs_list"
      : message?.type === "navigate_response"
        ? "navigate"
        : message?.type === "snapshot_response"
          ? "snapshot"
      : message?.type === "browser_error_response" ? message.command : null;
  validateBrowserCommandResponse(message, {
    command,
    requestId: message?.request_id,
    binding: descriptor,
    connectionId: hostConnectionId,
    target: command === "snapshot" ? { tabId: message?.tab_id } : undefined,
  });
  return { command, requestId: message?.request_id };
}

function nativeWrite(output, message) {
  output.write(encodeNativeMessage(message, { maxBytes: MAX_HOST_TO_EXTENSION_BYTES }));
}

/**
 * Connects a Native Host process to exactly one descriptor-selected Unix socket. This is a Host-to-
 * session transport only; it is not an Extension round-trip harness.
 */
export async function connectPairingSocket({ socketPath, socketFactory = (target) => net.createConnection(target) }) {
  const socket = socketFactory(socketPath);
  if (!socket || typeof socket.on !== "function" || typeof socket.write !== "function") {
    throw new TypeError("socket factory must return a socket-like object");
  }
  try {
    await once(socket, "connect");
  } catch {
    socket.destroy?.();
    throw new Error("unable to connect to pairing socket");
  }

  const decoder = new NativeMessageDecoder({ maxBytes: PAIRING_SOCKET_MAX_MESSAGE_BYTES });
  const messages = [];
  const waiters = [];
  let closed = false;
  const rejectWaiters = () => {
    while (waiters.length > 0) {
      waiters.shift().reject(new Error("pairing socket closed"));
    }
  };
  socket.on("data", (chunk) => {
    try {
      const decoded = decoder.push(chunk);
      for (const message of decoded) {
        const waiter = waiters.shift();
        if (waiter) {
          waiter.resolve(message);
        } else {
          messages.push(message);
        }
      }
    } catch {
      socket.destroy();
    }
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    closed = true;
    rejectWaiters();
  });
  return {
    send(message) {
      if (closed || !socket.write(encodeNativeMessage(message, { maxBytes: PAIRING_SOCKET_MAX_MESSAGE_BYTES }))) {
        if (closed) throw new Error("pairing socket closed");
      }
    },
    receive() {
      if (messages.length > 0) return Promise.resolve(messages.shift());
      if (closed) return Promise.reject(new Error("pairing socket closed"));
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    close() {
      socket.destroy();
    },
  };
}

/**
 * Gate 2 Native Host bridge. The wrapper supplies only a fixed runtime root and browser instance ID;
 * the Host re-reads that instance's private profile metadata and active descriptor without fallback.
 */
export async function runPairingNativeHost({
  input,
  output,
  stderr,
  origin,
  runtimeRoot: pairingRuntimeRoot,
  instanceId,
  createUuid = randomUUID,
  readProfile = readProfileMetadata,
  readDescriptor = readActivePairingDescriptor,
  socketConnector = connectPairingSocket,
  recordFailure = recordNativeHostFailure,
  now = new Date(),
}) {
  let paths;
  let bridge;
  let phase = "START";
  let failureStage = "setup_resolve_paths";
  let failureReason = "unexpected";
  let asynchronousFailure;
  const pendingRequests = new Map();
  const reportFailure = async (stage, reason) => {
    if (!paths) return;
    const marker = {
      schema_version: NATIVE_HOST_FAILURE_SCHEMA_VERSION,
      browser_instance_id: paths.instanceId,
      stage,
      reason,
      recorded_at: new Date().toISOString(),
    };
    try {
      await recordFailure(marker, { runtimeRoot: paths.runtimeRoot, instanceId: paths.instanceId });
    } catch {
      diagnostic(stderr, "failure diagnostic unavailable");
    }
  };

  try {
    failureStage = "setup_resolve_paths";
    failureReason = "validation";
    paths = resolvePairingPaths({ runtimeRoot: pairingRuntimeRoot, instanceId });
    failureStage = "setup_validate_origin";
    failureReason = "validation";
    if (origin !== GATE_1_EXTENSION_ORIGIN) {
      throw new Error("unexpected extension origin");
    }

    failureStage = "setup_read_profile";
    failureReason = "validation";
    const profile = await readProfile(paths);
    failureStage = "setup_read_descriptor";
    failureReason = "validation";
    const descriptor = await readDescriptor(paths, { profileInstanceId: profile.profile_instance_id, now });
    failureStage = "setup_create_connection_id";
    failureReason = "validation";
    const hostConnectionId = createUuid();
    if (!isNonEmptyString(hostConnectionId)) {
      throw new Error("invalid host connection id");
    }

    failureStage = "setup_connect_socket";
    failureReason = "transport";
    bridge = await socketConnector({ socketPath: descriptor.socket_path });
    failureStage = "setup_validate_connector";
    failureReason = "validation";
    if (!bridge || typeof bridge.send !== "function" || typeof bridge.receive !== "function" || typeof bridge.close !== "function") {
      throw new Error("invalid pairing socket connector");
    }

    const decoder = new NativeMessageDecoder({ maxBytes: MAX_EXTENSION_TO_HOST_BYTES });
    for await (const chunk of input) {
      failureStage = phase === "ACTIVE"
        ? "active_response_to_socket"
        : phase === "START"
          ? "handshake_send_register"
          : "handshake_validate_ack";
      failureReason = "validation";
      for (const message of decoder.push(chunk)) {
        if (phase === "START") {
          let pairingMode;
          failureStage = "handshake_send_register";
          failureReason = "validation";
          if (message?.type === "pair_start") {
            assertPairStart(message);
            pairingMode = "initial";
            const register = {
              type: "host_register",
              ...descriptorIdentity(descriptor, hostConnectionId),
              pairing_nonce: descriptor.pairing_nonce,
            };
            failureReason = "transport";
            bridge.send(register);
          } else if (message?.type === "resume_start") {
            assertResumeStart(message, descriptor);
            pairingMode = "resume";
            failureReason = "transport";
            bridge.send({ type: "resume", ...descriptorIdentity(descriptor, hostConnectionId) });
          } else {
            throw new Error("unexpected pairing start");
          }
          failureStage = "handshake_receive_challenge";
          failureReason = "transport";
          const challenge = await bridge.receive();
          failureReason = "validation";
          assertPairChallenge(challenge, descriptor, hostConnectionId, pairingMode);
          failureStage = "handshake_write_challenge";
          failureReason = "transport";
          nativeWrite(output, challenge);
          phase = "AWAIT_ACK";
        } else if (phase === "AWAIT_ACK") {
          failureStage = "handshake_validate_ack";
          failureReason = "validation";
          assertPairAck(message, descriptor, hostConnectionId);
          failureStage = "handshake_send_ack";
          failureReason = "transport";
          bridge.send(message);
          failureStage = "handshake_receive_active";
          failureReason = "transport";
          const active = await bridge.receive();
          failureReason = "validation";
          assertPairActive(active, descriptor, hostConnectionId);
          failureStage = "handshake_write_active";
          failureReason = "transport";
          nativeWrite(output, active);
          phase = "ACTIVE";
          void (async () => {
            let pumpStage = "active_request_to_extension";
            let pumpReason = "transport";
            try {
              while (phase === "ACTIVE") {
                pumpStage = "active_request_to_extension";
                pumpReason = "transport";
                const request = await bridge.receive();
                pumpReason = "validation";
                const pending = assertExtensionRequest(request, descriptor, hostConnectionId);
                pumpReason = "transport";
                nativeWrite(output, request);
                pendingRequests.set(pending.requestId, pending.command);
              }
            } catch {
              asynchronousFailure = { stage: pumpStage, reason: pumpReason };
              if (!input.readableEnded) input.destroy(new Error("pairing socket closed"));
            }
          })();
        } else if (phase === "ACTIVE") {
          failureStage = "active_response_to_socket";
          failureReason = "validation";
          const response = assertExtensionResponse(message, descriptor, hostConnectionId);
          if (pendingRequests.get(response.requestId) !== response.command) {
            throw new Error("browser response does not match a pending request");
          }
          failureReason = "transport";
          bridge.send(message);
          pendingRequests.delete(response.requestId);
        } else {
          throw new Error("unexpected pairing protocol message");
        }
      }
    }
    if (phase === "ACTIVE") {
      if (pendingRequests.size > 0) {
        await reportFailure("input_closed", "transport");
        diagnostic(stderr, "rejected pairing protocol");
        return false;
      }
      return true;
    }
    await reportFailure("input_closed", "unexpected");
    diagnostic(stderr, "rejected pairing protocol");
    return false;
  } catch {
    const failure = asynchronousFailure ?? { stage: failureStage, reason: failureReason };
    await reportFailure(failure.stage, failure.reason);
    diagnostic(stderr, "rejected pairing protocol");
    return false;
  } finally {
    bridge?.close();
  }
}

export function parseNativeHostArguments(argv) {
  if (argv.length === 1 && isNonEmptyString(argv[0])) {
    return { mode: "gate1", origin: argv[0] };
  }
  if (
    argv.length === 5 &&
    argv[0] === "--pairing-runtime-root" &&
    path.isAbsolute(argv[1]) &&
    argv[2] === "--pairing-instance-id" &&
    isNonEmptyString(argv[3]) &&
    isNonEmptyString(argv[4])
  ) {
    return {
      mode: "pairing",
      runtimeRoot: path.resolve(argv[1]),
      instanceId: argv[3],
      origin: argv[4],
    };
  }
  throw new Error("invalid Native Host arguments");
}

export async function runNativeHost({
  input,
  output,
  stderr,
  origin,
  markerPath = successMarkerPath(),
}) {
  if (origin !== GATE_1_EXTENSION_ORIGIN) {
    diagnostic(stderr, "rejected unexpected extension origin");
    return false;
  }

  const decoder = new NativeMessageDecoder({ maxBytes: MAX_EXTENSION_TO_HOST_BYTES });
  let helloAcknowledged = false;
  let markerWritten = false;

  try {
    for await (const chunk of input) {
      for (const message of decoder.push(chunk)) {
        if (
          !helloAcknowledged &&
          message?.type === "hello" &&
          message.protocol_version === GATE_1_PROTOCOL_VERSION
        ) {
          output.write(
            encodeNativeMessage(
              { type: "hello_ack", protocol_version: GATE_1_PROTOCOL_VERSION },
              { maxBytes: MAX_HOST_TO_EXTENSION_BYTES },
            ),
          );
          helloAcknowledged = true;
        } else if (
          helloAcknowledged &&
          !markerWritten &&
          message?.type === "ack" &&
          message.protocol_version === GATE_1_PROTOCOL_VERSION
        ) {
          await writeSuccessMarker(markerPath);
          markerWritten = true;
        } else {
          diagnostic(stderr, "rejected unexpected protocol message");
          return false;
        }
      }
    }
  } catch (error) {
    diagnostic(stderr, error instanceof Error ? error.message : "protocol failure");
    return false;
  }

  return markerWritten;
}

async function main() {
  let succeeded = false;
  try {
    const arguments_ = parseNativeHostArguments(process.argv.slice(2));
    succeeded = arguments_.mode === "gate1"
      ? await runNativeHost({
        input: process.stdin,
        output: process.stdout,
        stderr: process.stderr,
        origin: arguments_.origin,
      })
      : await runPairingNativeHost({
        input: process.stdin,
        output: process.stdout,
        stderr: process.stderr,
        origin: arguments_.origin,
        runtimeRoot: arguments_.runtimeRoot,
        instanceId: arguments_.instanceId,
      });
  } catch {
    diagnostic(process.stderr, "rejected Native Host arguments");
  }
  if (!succeeded) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
