import {
  createPairAck,
  startPairing,
  validateBinding,
  validatePairActive,
  validatePairChallenge,
} from "./pairing-protocol.mjs";

const NATIVE_HOST_NAME = "com.browser_session_poc.gate1";
const STORAGE_KEY = "pairing_binding";
const RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000];

function diagnostic(message, detail) {
  console.error(message, detail);
}

/** Chrome lifecycle adapter; it reconnects only to the configured Native Host name. */
export function createPairingController({
  chromeApi,
  nativeHostName = NATIVE_HOST_NAME,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  report = diagnostic,
} = {}) {
  if (!chromeApi?.runtime?.connectNative || !chromeApi?.storage?.local) {
    throw new TypeError("Chrome runtime and local storage are required");
  }

  let port;
  let retryTimer = null;
  let retryAttempt = 0;
  let connecting = false;
  let phase = "IDLE";
  let binding = null;
  let challenge = null;

  const clearRetry = () => {
    if (retryTimer !== null) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (retryTimer !== null || port || connecting) return;
    const delay = RETRY_DELAYS_MS[Math.min(retryAttempt, RETRY_DELAYS_MS.length - 1)];
    retryAttempt += 1;
    retryTimer = setTimer(() => {
      retryTimer = null;
      void connect();
    }, delay);
  };

  const disconnect = (target = port) => {
    if (!target || port !== target) return;
    port = undefined;
    phase = "IDLE";
    challenge = null;
    target.disconnect();
    scheduleReconnect();
  };

  const onDisconnect = (target) => {
    if (port !== target) return;
    const errorMessage = chromeApi.runtime.lastError?.message;
    if (errorMessage) {
      report("Native Messaging connection closed:", errorMessage);
    }
    port = undefined;
    phase = "IDLE";
    challenge = null;
    scheduleReconnect();
  };

  const onMessage = async (target, message) => {
    if (port !== target) return;
    try {
      if (phase === "AWAIT_CHALLENGE") {
        challenge = validatePairChallenge(message, { binding });
        target.postMessage(createPairAck(challenge));
        phase = "AWAIT_ACTIVE";
      } else if (phase === "AWAIT_ACTIVE") {
        const activeBinding = validatePairActive(message, challenge);
        if (challenge.mode === "initial") {
          await chromeApi.storage.local.set({ [STORAGE_KEY]: activeBinding });
        }
        if (port !== target) return;
        binding = activeBinding;
        challenge = null;
        phase = "ACTIVE";
        retryAttempt = 0;
      } else {
        throw new Error("unexpected pairing message");
      }
    } catch {
      disconnect(target);
    }
  };

  async function connect() {
    if (port || connecting || retryTimer !== null) return;
    connecting = true;
    let shouldRetry = false;
    let target;
    try {
      const stored = await chromeApi.storage.local.get(STORAGE_KEY);
      const candidate = stored?.[STORAGE_KEY];
      binding = candidate === undefined ? null : validateBinding(candidate);
      target = chromeApi.runtime.connectNative(nativeHostName);
      port = target;
      phase = "AWAIT_CHALLENGE";
      target.onMessage.addListener((message) => { void onMessage(target, message); });
      target.onDisconnect.addListener(() => onDisconnect(target));
      target.postMessage(startPairing(binding));
    } catch {
      if (port === target) {
        port = undefined;
        target?.disconnect();
      }
      phase = "IDLE";
      shouldRetry = true;
    } finally {
      connecting = false;
      if (shouldRetry) scheduleReconnect();
    }
  }

  return {
    connect,
    stop() {
      clearRetry();
      const target = port;
      port = undefined;
      phase = "IDLE";
      challenge = null;
      target?.disconnect();
    },
    getState() {
      return { phase, hasPort: Boolean(port), retryScheduled: retryTimer !== null, retryAttempt };
    },
  };
}

if (typeof chrome !== "undefined") {
  const controller = createPairingController({ chromeApi: chrome });
  chrome.runtime.onInstalled.addListener(() => { void controller.connect(); });
  chrome.runtime.onStartup.addListener(() => { void controller.connect(); });
  void controller.connect();
}
