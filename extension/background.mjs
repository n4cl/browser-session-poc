import {
  createPairAck,
  PAIRING_WAKE_SEARCH,
  validatePairingWake,
  startPairing,
  validateBinding,
  validateRebindRequired,
  validatePairActive,
  validatePairChallenge,
  respondToPing,
  respondToBrowserError,
  respondToBrowserStatus,
  respondToTabsList,
  respondToNavigate,
  respondToSnapshot,
  respondToClick,
  respondToType,
  validateNavigateRequest,
  validateSnapshotRequest,
  validateClickRequest,
  validateTypeRequest,
  validateExtensionReloadRequest,
} from "./pairing-protocol.mjs";
import {
  createDebuggerSnapshotRunner,
  SNAPSHOT_ERROR_CODES,
  CLICK_ERROR_CODES,
  TYPE_ERROR_CODES,
} from "./debugger-snapshot.mjs";
import { PAIRING_BINDING_STORAGE_KEY } from "./pairing-reset.mjs";

const NATIVE_HOST_NAME = "com.browser_session_poc.gate1";
const STORAGE_KEY = PAIRING_BINDING_STORAGE_KEY;
const RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000];

export const PAIRING_FAILURE_STAGES = Object.freeze([
  "pair_challenge",
  "pair_rebind_required",
  "pair_rebind_storage",
  "pair_active_storage",
  "pair_active_validation",
  "active_ping",
  "active_browser_status",
  "active_tabs_list",
  "active_navigate",
  "active_snapshot",
  "active_click",
  "active_type",
  "active_extension_reload",
  "unexpected_message",
]);
export const PAIRING_FAILURE_REASONS = Object.freeze([
  "validation",
  "storage",
  "chrome_api",
  "transport",
  "unexpected",
]);

function reportErrorToConsole(message, detail) {
  console.error(message, detail);
}

function reportWarningToConsole(message, detail) {
  console.warn(message, detail);
}

export function isPairingWakeSender(sender, extensionId) {
  if (typeof extensionId !== "string" || extensionId.length === 0 || sender?.id !== extensionId || typeof sender?.url !== "string") {
    return false;
  }
  if (sender.url !== `chrome-extension://${extensionId}/options.html${PAIRING_WAKE_SEARCH}`) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === "chrome-extension:"
      && url.hostname === extensionId
      && url.pathname === "/options.html"
      && url.search === PAIRING_WAKE_SEARCH
      && url.hash === "";
  } catch {
    return false;
  }
}

export function createPairingWakeReceiver({ extensionId, connect }) {
  if (typeof connect !== "function") throw new TypeError("pairing wake connect callback is required");
  return (message, sender) => {
    try {
      validatePairingWake(message);
    } catch {
      return undefined;
    }
    if (!isPairingWakeSender(sender, extensionId)) return undefined;
    try {
      const result = connect();
      if (result && typeof result.catch === "function") void result.catch(() => {});
    } catch {
      // A wake failure must not disclose state or affect the Options page.
    }
    return undefined;
  };
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
    let failureStage = "unexpected_message";
    let failureReason = "unexpected";
    try {
      if (phase === "AWAIT_CHALLENGE") {
        if (message?.type === "rebind_required") {
          failureStage = "pair_rebind_required";
          failureReason = "validation";
          validateRebindRequired(message);
          if (binding === null) throw new Error("rebind requires a stored binding");
          failureStage = "pair_rebind_storage";
          failureReason = "storage";
          await chromeApi.storage.local.remove(STORAGE_KEY);
          binding = null;
          if (port !== target || phase !== "AWAIT_CHALLENGE") return;
          disconnect(target);
          return;
        }
        failureStage = "pair_challenge";
        failureReason = "validation";
        challenge = validatePairChallenge(message, { binding });
        failureReason = "transport";
        target.postMessage(createPairAck(challenge));
        phase = "AWAIT_ACTIVE";
      } else if (phase === "AWAIT_ACTIVE") {
        failureStage = "pair_active_validation";
        failureReason = "validation";
        const activeBinding = validatePairActive(message, challenge);
        if (challenge.mode === "initial") {
          failureStage = "pair_active_storage";
          failureReason = "storage";
          await chromeApi.storage.local.set({ [STORAGE_KEY]: activeBinding });
        }
        if (port !== target) return;
        binding = activeBinding;
        activeConnectionId = challenge.hostConnectionId;
        challenge = null;
        phase = "ACTIVE";
        retryAttempt = 0;
      } else if (phase === "ACTIVE") {
        if (message?.type === "extension_reload_request") {
          failureStage = "active_extension_reload";
          failureReason = "validation";
          validateExtensionReloadRequest(message, binding, activeConnectionId);
          failureReason = "chrome_api";
          if (typeof chromeApi.runtime?.reload !== "function") throw new Error("runtime reload unavailable");
          chromeApi.runtime.reload();
          return;
        } else if (message?.type === "ping_request") {
          failureStage = "active_ping";
          failureReason = "validation";
          const response = respondToPing(message, binding, activeConnectionId);
          failureReason = "transport";
          target.postMessage(response);
        } else if (message?.type === "browser_status_request") {
          failureStage = "active_browser_status";
          failureReason = "validation";
          const response = respondToBrowserStatus(message, binding, activeConnectionId, {
            chromeTabsAvailable: typeof chromeApi.tabs?.query === "function",
          });
          failureReason = "transport";
          target.postMessage(response);
        } else if (message?.type === "tabs_list_request") {
          failureStage = "active_tabs_list";
          failureReason = "validation";
          if (typeof chromeApi.tabs?.query !== "function") {
            const response = respondToBrowserError(message, binding, activeConnectionId, "tabs_list", "tabs_unavailable");
            failureReason = "transport";
            target.postMessage(response);
          } else {
            let response;
            failureReason = "chrome_api";
            try {
              const tabs = await chromeApi.tabs.query({});
              if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
              failureReason = "validation";
              response = respondToTabsList(message, binding, activeConnectionId, tabs);
            } catch (error) {
              if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
              failureReason = "validation";
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
            failureReason = "transport";
            target.postMessage(response);
          }
        } else if (message?.type === "navigate_request") {
          failureStage = "active_navigate";
          failureReason = "validation";
          const navigation = validateNavigateRequest(message, binding, activeConnectionId);
          if (typeof chromeApi.tabs?.get !== "function" || typeof chromeApi.tabs?.update !== "function") {
            const response = respondToBrowserError(message, binding, activeConnectionId, "navigate", "navigation_failed");
            failureReason = "transport";
            target.postMessage(response);
          } else {
            failureReason = "chrome_api";
            try {
              await chromeApi.tabs.get(navigation.tabId);
            } catch {
              if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
              failureReason = "validation";
              const response = respondToBrowserError(message, binding, activeConnectionId, "navigate", "tab_not_found");
              failureReason = "transport";
              target.postMessage(response);
              return;
            }
            try {
              await chromeApi.tabs.update(navigation.tabId, { url: navigation.url });
            } catch {
              if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
              failureReason = "validation";
              const response = respondToBrowserError(message, binding, activeConnectionId, "navigate", "navigation_failed");
              failureReason = "transport";
              target.postMessage(response);
              return;
            }
            if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
            failureReason = "transport";
            target.postMessage(respondToNavigate(message, binding, activeConnectionId, navigation.tabId));
          }
        } else if (message?.type === "snapshot_request") {
          failureStage = "active_snapshot";
          failureReason = "validation";
          const snapshotTarget = validateSnapshotRequest(message, binding, activeConnectionId);
          try {
            failureReason = "chrome_api";
            const snapshot = await snapshotRunner.snapshot(snapshotTarget.tabId);
            if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
            failureReason = "validation";
            const response = respondToSnapshot(message, binding, activeConnectionId, snapshot);
            failureReason = "transport";
            target.postMessage(response);
          } catch (error) {
            if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
            const errorCode = error?.code === "response_too_large"
              ? "response_too_large"
              : SNAPSHOT_ERROR_CODES.includes(error?.code)
                ? error.code
                : "snapshot_failed";
            failureReason = "validation";
            const response = respondToBrowserError(message, binding, activeConnectionId, "snapshot", errorCode);
            failureReason = "transport";
            target.postMessage(response);
          }
        } else if (message?.type === "click_request") {
          failureStage = "active_click";
          failureReason = "validation";
          const clickTarget = validateClickRequest(message, binding, activeConnectionId);
          try {
            failureReason = "chrome_api";
            const click = await snapshotRunner.click(
              clickTarget.tabId,
              clickTarget.loaderId,
              clickTarget.backendDomNodeId,
            );
            if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
            failureReason = "validation";
            const response = respondToClick(message, binding, activeConnectionId, click);
            failureReason = "transport";
            target.postMessage(response);
          } catch (error) {
            if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
            const errorCode = CLICK_ERROR_CODES.includes(error?.code) ? error.code : "click_failed";
            failureReason = "validation";
            const response = respondToBrowserError(message, binding, activeConnectionId, "click", errorCode);
            failureReason = "transport";
            target.postMessage(response);
          }
        } else if (message?.type === "type_request") {
          failureStage = "active_type";
          failureReason = "validation";
          const typeTarget = validateTypeRequest(message, binding, activeConnectionId);
          try {
            failureReason = "chrome_api";
            const typed = await snapshotRunner.type(
              typeTarget.tabId,
              typeTarget.loaderId,
              typeTarget.backendDomNodeId,
              typeTarget.text,
            );
            if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
            failureReason = "validation";
            const response = respondToType(message, binding, activeConnectionId, typed);
            failureReason = "transport";
            target.postMessage(response);
          } catch (error) {
            if (port !== target || phase !== "ACTIVE" || activeConnectionId === null) return;
            const errorCode = TYPE_ERROR_CODES.includes(error?.code) ? error.code : "type_failed";
            failureReason = "validation";
            const response = respondToBrowserError(message, binding, activeConnectionId, "type", errorCode);
            failureReason = "transport";
            target.postMessage(response);
          }
        } else {
          failureStage = "unexpected_message";
          failureReason = "unexpected";
          throw new Error("unexpected active protocol message");
        }
      } else {
        failureStage = "unexpected_message";
        failureReason = "unexpected";
        throw new Error("unexpected pairing message");
      }
    } catch {
      try {
        reportError("Native Messaging pairing protocol failure", {
          stage: failureStage,
          reason: failureReason,
        });
      } catch {
        // Diagnostic reporting must not change the disconnect behavior.
      }
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

  if (typeof chromeApi.runtime?.onMessage?.addListener === "function" && typeof chromeApi.runtime.id === "string") {
    chromeApi.runtime.onMessage.addListener(createPairingWakeReceiver({
      extensionId: chromeApi.runtime.id,
      connect,
    }));
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
