import assert from "node:assert/strict";
import test from "node:test";
import {
  createPairingController,
  createPairingWakeReceiver,
  isPairingWakeSender,
} from "../extension/background.mjs";
import { createPairingWake } from "../extension/pairing-protocol.mjs";
import { attachPairingResetPage } from "../extension/options.mjs";

function fakePort() {
  const messages = [];
  let disconnected = false;
  return {
    messages,
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} },
    postMessage(message) { messages.push(message); },
    disconnect() { disconnected = true; },
    get disconnected() { return disconnected; },
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("pairing wake accepts only the exact Options sender and fixed message", () => {
  const extensionId = "test-extension-id";
  const sender = { id: extensionId, url: `chrome-extension://${extensionId}/options.html` };
  assert.equal(isPairingWakeSender(sender, extensionId), true);
  assert.equal(isPairingWakeSender({ ...sender, id: "other-extension-id" }, extensionId), false);
  assert.equal(isPairingWakeSender({ ...sender, url: `${sender.url}?wake=1` }, extensionId), false);
  assert.equal(isPairingWakeSender({ ...sender, url: `${sender.url}#wake` }, extensionId), false);
  assert.equal(isPairingWakeSender({ ...sender, url: `chrome-extension://${extensionId}/other.html` }, extensionId), false);

  let connects = 0;
  const receiver = createPairingWakeReceiver({
    extensionId,
    connect() { connects += 1; },
  });
  receiver(createPairingWake(), sender);
  receiver({ type: "pairing_wake", protocol_version: 2 }, sender);
  receiver({ type: "pairing_wake", protocol_version: 1, extra: "state" }, sender);
  receiver(createPairingWake(), { id: "other-extension-id", url: sender.url });
  receiver(createPairingWake(), { id: extensionId, url: "chrome-extension://other-extension-id/options.html" });
  assert.equal(connects, 1);
});

test("pairing wake invokes the idempotent controller connection only once", async () => {
  const extensionId = "test-extension-id";
  const port = fakePort();
  const listeners = [];
  let connectNativeCalls = 0;
  const chromeApi = {
    runtime: {
      id: extensionId,
      lastError: undefined,
      onMessage: { addListener(listener) { listeners.push(listener); } },
      connectNative() {
        connectNativeCalls += 1;
        return port;
      },
    },
    storage: {
      local: {
        async get() { return {}; },
      },
    },
  };
  createPairingController({ chromeApi, setTimer: () => ({}) });
  assert.equal(listeners.length, 1);
  const sender = { id: extensionId, url: `chrome-extension://${extensionId}/options.html` };
  listeners[0](createPairingWake(), sender);
  listeners[0](createPairingWake(), sender);
  await settle();
  assert.equal(connectNativeCalls, 1);
  assert.deepEqual(port.messages, [{ type: "pair_start", protocol_version: 1 }]);
});

test("Options sends one fixed wake and swallows send failures without changing the page", async () => {
  const button = { disabled: false, addEventListener() {} };
  const status = { textContent: "" };
  const sent = [];
  const documentApi = {
    getElementById(id) {
      return id === "reset-pairing" ? button : status;
    },
  };
  attachPairingResetPage({
    documentApi,
    chromeApi: {
      runtime: {
        sendMessage(message) {
          sent.push(message);
          return Promise.reject(new Error("receiver unavailable"));
        },
      },
    },
  });
  await settle();
  assert.deepEqual(sent, [createPairingWake()]);
  assert.equal(button.disabled, false);
  assert.equal(status.textContent, "");
});
