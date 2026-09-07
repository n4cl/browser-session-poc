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

function fakeChrome({ storedBinding = undefined, ports = [], tabs = undefined, tabGet = undefined, tabUpdate = undefined } = {}) {
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
      ...(tabs === undefined && tabGet === undefined && tabUpdate === undefined ? {} : {
        tabs: {
          async query() { return tabs; },
          async get(tabId) {
            if (tabGet) return tabGet(tabId);
            const tab = tabs?.find((candidate) => candidate.id === tabId);
            if (!tab) throw new Error("tab unavailable");
            return tab;
          },
          async update(tabId, properties) {
            if (tabUpdate) return tabUpdate(tabId, properties);
            const tab = tabs?.find((candidate) => candidate.id === tabId);
            if (!tab) throw new Error("tab unavailable");
            return { ...tab, ...properties };
          },
        },
      }),
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

test("active Extension correlates browser_status and tabs_list with its paired identity", async () => {
  const port = fakePort();
  const chrome = fakeChrome({
    ports: [port],
    tabs: [
      { id: 7, windowId: 3, title: "Example", url: "https://example.test/", active: true },
      { id: 8, windowId: 3, active: false },
      { id: 9, windowId: 3, title: "", url: "", active: false },
      { windowId: 3, title: "untargetable", url: "https://example.test/no-id", active: false },
      { id: 10, title: "untargetable", url: "https://example.test/no-window", active: false },
    ],
  });
  const controller = createPairingController({ chromeApi: chrome.api, setTimer: () => ({}) });
  await controller.connect();
  port.emitMessage(challenge());
  await settle();
  port.emitMessage(active());
  await settle();

  port.emitMessage({ type: "browser_status_request", request_id: "status-1", ...identity() });
  await settle();
  assert.deepEqual(port.messages.at(-1), {
    type: "browser_status_response",
    request_id: "status-1",
    ...identity(),
    status: { extension_connected: true, chrome_tabs_available: true },
  });

  port.emitMessage({ type: "tabs_list_request", request_id: "tabs-1", ...identity() });
  await settle();
  assert.deepEqual(port.messages.at(-1), {
    type: "tabs_list_response",
    request_id: "tabs-1",
    ...identity(),
    tabs: [
      { id: 7, window_id: 3, title: "Example", url: "https://example.test/", active: true },
      { id: 8, window_id: 3, title: null, url: null, active: false },
      { id: 9, window_id: 3, title: "", url: "", active: false },
    ],
  });

  port.emitMessage({ type: "tabs_list_request", request_id: "tabs-foreign", ...identity("other") });
  await settle();
  assert.equal(port.disconnected, true);
});

test("tabs_list returns an explicit error when its bounded socket response would be too large", async () => {
  const port = fakePort();
  const tabs = Array.from({ length: 20 }, (_, id) => ({
    id,
    windowId: 1,
    title: "x".repeat(4_096),
    url: `https://example.test/${id}`,
    active: id === 0,
  }));
  const chrome = fakeChrome({ ports: [port], tabs });
  const controller = createPairingController({ chromeApi: chrome.api, setTimer: () => ({}) });
  await controller.connect();
  port.emitMessage(challenge());
  await settle();
  port.emitMessage(active());
  await settle();
  port.emitMessage({ type: "tabs_list_request", request_id: "oversized", ...identity() });
  await settle();
  assert.deepEqual(port.messages.at(-1), {
    type: "browser_error_response",
    request_id: "oversized",
    ...identity(),
    command: "tabs_list",
    error_code: "response_too_large",
  });
});

test("navigate verifies a local tab, accepts only the paired request, and returns fixed Chrome error codes", async () => {
  const port = fakePort();
  const updates = [];
  const chrome = fakeChrome({
    ports: [port],
    tabs: [{ id: 7, windowId: 3, title: "Example", url: "https://example.test/", active: true }],
    tabUpdate(tabId, properties) {
      updates.push({ tabId, properties });
      return { id: tabId, ...properties };
    },
  });
  const controller = createPairingController({ chromeApi: chrome.api, setTimer: () => ({}) });
  await controller.connect();
  port.emitMessage(challenge());
  await settle();
  port.emitMessage(active());
  await settle();

  port.emitMessage({ type: "navigate_request", request_id: "navigate-1", ...identity(), tab_id: 7, url: "https://example.test/next" });
  await settle();
  assert.deepEqual(updates, [{ tabId: 7, properties: { url: "https://example.test/next" } }]);
  assert.deepEqual(port.messages.at(-1), { type: "navigate_response", request_id: "navigate-1", ...identity(), tab_id: 7 });

  port.emitMessage({ type: "navigate_request", request_id: "navigate-missing", ...identity(), tab_id: 8, url: "https://example.test/" });
  await settle();
  assert.deepEqual(port.messages.at(-1), {
    type: "browser_error_response",
    request_id: "navigate-missing",
    ...identity(),
    command: "navigate",
    error_code: "tab_not_found",
  });

  port.emitMessage({ type: "navigate_request", request_id: "navigate-invalid", ...identity(), tab_id: 7, url: "https://user:password@example.test/" });
  await settle();
  assert.equal(port.disconnected, true);
});

test("navigate reports navigation_failed without exposing Chrome API errors", async () => {
  const port = fakePort();
  const chrome = fakeChrome({
    ports: [port],
    tabs: [{ id: 7, windowId: 3, title: "Example", url: "https://example.test/", active: true }],
    tabUpdate() { throw new Error("Chrome API detail must not cross the protocol"); },
  });
  const controller = createPairingController({ chromeApi: chrome.api, setTimer: () => ({}) });
  await controller.connect();
  port.emitMessage(challenge());
  await settle();
  port.emitMessage(active());
  await settle();
  port.emitMessage({ type: "navigate_request", request_id: "navigate-failed", ...identity(), tab_id: 7, url: "https://example.test/" });
  await settle();
  assert.deepEqual(port.messages.at(-1), {
    type: "browser_error_response",
    request_id: "navigate-failed",
    ...identity(),
    command: "navigate",
    error_code: "navigation_failed",
  });
  assert.equal(JSON.stringify(port.messages.at(-1)).includes("Chrome API detail"), false);
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
