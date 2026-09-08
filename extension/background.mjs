import {
  createPairAck,
  startPairing,
  validateBinding,
  validatePairActive,
  validatePairChallenge,
  respondToPing,
  respondToBrowserError,
  respondToBrowserStatus,
  respondToTabsList,
  respondToNavigate,
  respondToSnapshot,
  validateNavigateRequest,
  validateSnapshotRequest,
} from "./pairing-protocol.mjs";
import { createDebuggerSnapshotRunner, SNAPSHOT_ERROR_CODES } from "./debugger-snapshot.mjs";
import { PAIRING_BINDING_STORAGE_KEY } from "./pairing-reset.mjs";

const NATIVE_HOST_NAME = "com.browser_session_poc.gate1";
const STORAGE_KEY = PAIRING_BINDING_STORAGE_KEY;
const RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000];

function reportErrorToConsole(message, detail) {
  console.error(message, detail);
}

function reportWarningToConsole(message, detail) {
  console.warn(message, detail);
}

/** Chrome lifecycle adapter; it reconnects only to the configured Native Host name. */
export function createPairingController({
  chromeApi,
  nativeHostName = NATIVE_HOST_NAME,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  reportError = reportErrorToConsole,
  reportWarning = reportWarningToConsole,
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
  let activeConnectionId = null;
  const snapshotRunner = createDebuggerSnapshotRunner({ chromeApi });

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
    activeConnectionId = null;
    target.disconnect();
    scheduleReconnect();
  };

  const onDisconnect = (target) => {
    if (port !== target) return;
    const phaseAtDisconnect = phase;
    const errorMessage = chromeApi.runtime.lastError?.message;
    if (errorMessage) {
      if (phaseAtDisconnect === "ACTIVE") {
        reportWarning("Native Messaging connection closed after pairing; reconnecting:", errorMessage);
      } else {
        reportError("Native Messaging connection closed before pairing completed:", errorMessage);
      }
    }
    port = undefined;
    phase = "IDLE";
    challenge = null;
    activeConnectionId = null;
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
        activeConnectionId = challenge.hostConnectionId;
        challenge = null;
        phase = "ACTIVE";
        retryAttempt = 0;
      } else if (phase === "ACTIVE") {
        if (message?.type === "ping_request") {
          target.postMessage(respondToPing(message, binding, activeConnectionId));
        } else if (message?.type === "browser_status_request") {
          target.postMessage(respondToBrowserStatus(message, binding, activeConnectionId, {
            chromeTabsAvailable: typeof chromeApi.tabs?.query === "function",
          }));
        } else if (message?.type === "tabs_list_request") {
          if (typeof chromeApi.tabs?.query !== "function") {
            target.postMessage(respondToBrowserError(message, binding, activeConnectionId, "tabs_list", "tabs_unavailable"));
          } else {
            let response;
            try {
              const tabs = await chromeApi.tabs.query({});
              if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
              response = respondToTabsList(message, binding, activeConnectionId, tabs);
            } catch (error) {
              if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
              response = respondToBrowserError(
                message,
                binding,
                activeConnectionId,
                "tabs_list",
                error instanceof Error && error.message === "browser command response exceeds transport limit"
                  ? "response_too_large"
                  : "tabs_unavailable",
              );
            }
            target.postMessage(response);
          }
        } else if (message?.type === "navigate_request") {
          const navigation = validateNavigateRequest(message, binding, activeConnectionId);
          if (typeof chromeApi.tabs?.get !== "function" || typeof chromeApi.tabs?.update !== "function") {
            target.postMessage(respondToBrowserError(message, binding, activeConnectionId, "navigate", "navigation_failed"));
          } else {
            try {
              await chromeApi.tabs.get(navigation.tabId);
            } catch {
              if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
              target.postMessage(respondToBrowserError(message, binding, activeConnectionId, "navigate", "tab_not_found"));
              return;
            }
            try {
              await chromeApi.tabs.update(navigation.tabId, { url: navigation.url });
            } catch {
              if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
              target.postMessage(respondToBrowserError(message, binding, activeConnectionId, "navigate", "navigation_failed"));
              return;
            }
            if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
            target.postMessage(respondToNavigate(message, binding, activeConnectionId, navigation.tabId));
          }
        } else if (message?.type === "snapshot_request") {
          const snapshotTarget = validateSnapshotRequest(message, binding, activeConnectionId);
          try {
            const snapshot = await snapshotRunner.snapshot(snapshotTarget.tabId);
            if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
            target.postMessage(respondToSnapshot(message, binding, activeConnectionId, snapshot));
          } catch (error) {
            if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
            const errorCode = error?.code === "response_too_large"
              ? "response_too_large"
              : SNAPSHOT_ERROR_CODES.includes(error?.code)
                ? error.code
                : "snapshot_failed";
            target.postMessage(respondToBrowserError(message, binding, activeConnectionId, "snapshot", errorCode));
          }
        } else {
          throw new Error("unexpected active protocol message");
        }
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
      activeConnectionId = null;
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
