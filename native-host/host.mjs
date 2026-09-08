import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
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
    return;
  }
  validateBrowserCommandRequest(message, { binding: descriptor, connectionId: hostConnectionId });
}

function assertExtensionResponse(message, descriptor, hostConnectionId) {
  if (message?.type === "ping_response") {
    assertPing(message, descriptor, hostConnectionId, "ping_response");
    return;
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
  now = new Date(),
}) {
  if (origin !== GATE_1_EXTENSION_ORIGIN) {
    diagnostic(stderr, "rejected unexpected extension origin");
    return false;
  }

  let bridge;
  try {
    const paths = resolvePairingPaths({ runtimeRoot: pairingRuntimeRoot, instanceId });
    const profile = await readProfile(paths);
    const descriptor = await readDescriptor(paths, { profileInstanceId: profile.profile_instance_id, now });
    const hostConnectionId = createUuid();
    if (!isNonEmptyString(hostConnectionId)) {
      throw new Error("invalid host connection id");
    }
    bridge = await socketConnector({ socketPath: descriptor.socket_path });
    if (!bridge || typeof bridge.send !== "function" || typeof bridge.receive !== "function" || typeof bridge.close !== "function") {
      throw new Error("invalid pairing socket connector");
    }

    const decoder = new NativeMessageDecoder({ maxBytes: MAX_EXTENSION_TO_HOST_BYTES });
    let phase = "START";
    for await (const chunk of input) {
      for (const message of decoder.push(chunk)) {
        if (phase === "START") {
          let pairingMode;
          if (message?.type === "pair_start") {
            assertPairStart(message);
            pairingMode = "initial";
            bridge.send({
              type: "host_register",
              ...descriptorIdentity(descriptor, hostConnectionId),
              pairing_nonce: descriptor.pairing_nonce,
            });
          } else if (message?.type === "resume_start") {
            assertResumeStart(message, descriptor);
            pairingMode = "resume";
            bridge.send({ type: "resume", ...descriptorIdentity(descriptor, hostConnectionId) });
          } else {
            throw new Error("unexpected pairing start");
          }
          const challenge = await bridge.receive();
          assertPairChallenge(challenge, descriptor, hostConnectionId, pairingMode);
          nativeWrite(output, challenge);
          phase = "AWAIT_ACK";
        } else if (phase === "AWAIT_ACK") {
          assertPairAck(message, descriptor, hostConnectionId);
          bridge.send(message);
          const active = await bridge.receive();
          assertPairActive(active, descriptor, hostConnectionId);
          nativeWrite(output, active);
          phase = "ACTIVE";
          void (async () => {
            try {
              while (phase === "ACTIVE") {
                const request = await bridge.receive();
                assertExtensionRequest(request, descriptor, hostConnectionId);
                nativeWrite(output, request);
              }
            } catch {
              if (!input.readableEnded) input.destroy(new Error("pairing socket closed"));
            }
          })();
        } else if (phase === "ACTIVE") {
          assertExtensionResponse(message, descriptor, hostConnectionId);
          bridge.send(message);
        } else {
          throw new Error("unexpected pairing protocol message");
        }
      }
    }
    return phase === "ACTIVE";
  } catch {
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
