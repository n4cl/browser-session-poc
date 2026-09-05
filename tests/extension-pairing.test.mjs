import assert from "node:assert/strict";
import test from "node:test";
import {
  createPairAck,
  startPairing,
  validatePairActive,
  validatePairChallenge,
} from "../extension/pairing-protocol.mjs";
import { createPairingController } from "../extension/background.mjs";

const binding = Object.freeze({
  session_id: "session-a",
  browser_instance_id: "browser-a",
  profile_instance_id: "profile-a",
  generation: 1,
  lease_id: "lease-a",
});

function identity(connectionId = "connection-a") {
  return { protocol_version: 1, ...binding, host_connection_id: connectionId };
}

function challenge(mode = "initial", connectionId = "connection-a") {
  return { type: "pair_challenge", ...identity(connectionId), pairing_mode: mode };
}

function active(connectionId = "connection-a") {
  return { type: "pair_active", ...identity(connectionId) };
}

function fakePort() {
  const messages = [];
  const messageListeners = [];
  const disconnectListeners = [];
  let disconnected = false;
  return {
    messages,
    onMessage: { addListener(listener) { messageListeners.push(listener); } },
    onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
    postMessage(message) { messages.push(message); },
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      for (const listener of disconnectListeners) listener();
    },
    emitMessage(message) {
      for (const listener of messageListeners) listener(message);
    },
    get disconnected() { return disconnected; },
  };
}

function fakeChrome({ storedBinding = undefined, ports = [] } = {}) {
  const storage = storedBinding === undefined ? {} : { pairing_binding: storedBinding };
  const setCalls = [];
  const connectedNames = [];
  return {
    storage,
    setCalls,
    connectedNames,
    api: {
      runtime: {
        lastError: undefined,
        connectNative(name) {
          connectedNames.push(name);
          const port = ports.shift();
          if (!port) throw new Error("no fake port");
          return port;
        },
      },
      storage: {
        local: {
          async get(key) { return { [key]: storage[key] }; },
          async set(value) {
            setCalls.push(value);
            Object.assign(storage, value);
          },
        },
      },
    },
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("pure Extension protocol creates initial/resume starts and accepts pair_active only after matching challenge", () => {
  assert.deepEqual(startPairing(null), { type: "pair_start", protocol_version: 1 });
  assert.deepEqual(startPairing(binding), { type: "resume_start", protocol_version: 1, ...binding });
  const initial = validatePairChallenge(challenge(), { binding: null });
  assert.deepEqual(createPairAck(initial), { type: "pair_ack", ...identity() });
  assert.deepEqual(validatePairActive(active(), initial), binding);
  assert.throws(() => validatePairActive(active("other"), initial));
  assert.throws(() => validatePairChallenge(challenge("resume"), { binding: null }));
  assert.throws(() => validatePairChallenge({ ...challenge(), unexpected: true }, { binding: null }));
});

test("initial pairing does not persist before pair_active and persists only the confirmed binding", async () => {
  const port = fakePort();
  const chrome = fakeChrome({ ports: [port] });
  const controller = createPairingController({ chromeApi: chrome.api, setTimer: () => ({}) });
  await controller.connect();
  assert.deepEqual(port.messages, [{ type: "pair_start", protocol_version: 1 }]);

  port.emitMessage(challenge());
  await settle();
  assert.deepEqual(port.messages[1], { type: "pair_ack", ...identity() });
  assert.deepEqual(chrome.setCalls, []);

  port.emitMessage(active());
  await settle();
  assert.deepEqual(chrome.setCalls, [{ pairing_binding: binding }]);
  assert.equal(controller.getState().phase, "ACTIVE");
  port.emitMessage({ type: "ping_request", request_id: "request-a", ...identity() });
  await settle();
  assert.deepEqual(port.messages.at(-1), { type: "ping_response", request_id: "request-a", ...identity() });
});

test("resume preserves its stored binding and malformed pair_active disconnects without saving", async () => {
  const resumePort = fakePort();
  const chrome = fakeChrome({ storedBinding: binding, ports: [resumePort] });
  const controller = createPairingController({ chromeApi: chrome.api, setTimer: () => ({}) });
  await controller.connect();
  assert.deepEqual(resumePort.messages, [{ type: "resume_start", protocol_version: 1, ...binding }]);
  resumePort.emitMessage(challenge("resume"));
  await settle();
  resumePort.emitMessage(active());
  await settle();
  assert.deepEqual(chrome.setCalls, []);
  assert.equal(controller.getState().phase, "ACTIVE");

  const invalidPort = fakePort();
  const invalidChrome = fakeChrome({ ports: [invalidPort] });
  const invalidController = createPairingController({ chromeApi: invalidChrome.api, setTimer: () => ({}) });
  await invalidController.connect();
  invalidPort.emitMessage(challenge());
  await settle();
  invalidPort.emitMessage({ ...active(), generation: 2 });
  await settle();
  assert.equal(invalidPort.disconnected, true);
  assert.deepEqual(invalidChrome.setCalls, []);
});

test("handshake disconnect reports an error and schedules one bounded reconnect", async () => {
  const first = fakePort();
  const second = fakePort();
  const chrome = fakeChrome({ ports: [first, second] });
  const timers = [];
  const errors = [];
  const warnings = [];
  const controller = createPairingController({
    chromeApi: chrome.api,
    setTimer(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    reportError(...args) { errors.push(args); },
    reportWarning(...args) { warnings.push(args); },
  });
  await controller.connect();
  chrome.api.runtime.lastError = { message: "connection lost" };
  first.disconnect();
  first.disconnect();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 100);
  assert.deepEqual(errors, [["Native Messaging connection closed before pairing completed:", "connection lost"]]);
  assert.deepEqual(warnings, []);
  timers[0].callback();
  await settle();
  assert.deepEqual(chrome.connectedNames, ["com.browser_session_poc.gate1", "com.browser_session_poc.gate1"]);
  assert.deepEqual(second.messages, [{ type: "pair_start", protocol_version: 1 }]);
  assert.equal(controller.getState().retryScheduled, false);
});

test("active disconnect warns, keeps its binding, and reconnects without an error", async () => {
  const first = fakePort();
  const second = fakePort();
  const chrome = fakeChrome({ storedBinding: binding, ports: [first, second] });
  const timers = [];
  const errors = [];
  const warnings = [];
  const controller = createPairingController({
    chromeApi: chrome.api,
    setTimer(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimer() {},
    reportError(...args) { errors.push(args); },
    reportWarning(...args) { warnings.push(args); },
  });
  await controller.connect();
  first.emitMessage(challenge("resume"));
  await settle();
  first.emitMessage(active());
  await settle();
  assert.equal(controller.getState().phase, "ACTIVE");

  chrome.api.runtime.lastError = { message: "Native host has exited." };
  first.disconnect();
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, [["Native Messaging connection closed after pairing; reconnecting:", "Native host has exited."]]);
  assert.deepEqual(chrome.setCalls, []);
  assert.deepEqual(chrome.storage.pairing_binding, binding);
  assert.equal(timers.length, 1);
  timers[0].callback();
  await settle();
  assert.deepEqual(second.messages, [{ type: "resume_start", protocol_version: 1, ...binding }]);
});
