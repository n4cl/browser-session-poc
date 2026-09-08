import { normalizeSnapshot } from "./pairing-protocol.mjs";

export const SNAPSHOT_ERROR_CODES = Object.freeze([
  "debugger_unavailable",
  "tab_not_found",
  "debugger_busy",
  "debugger_attach_failed",
  "snapshot_failed",
  "debugger_detach_failed",
  "response_too_large",
]);

export class DebuggerSnapshotError extends Error {
  constructor(code) {
    super(code);
    this.name = "DebuggerSnapshotError";
    this.code = code;
  }
}

function failure(code) {
  return new DebuggerSnapshotError(code);
}

function isTabId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertDebuggerApi(chromeApi) {
  if (typeof chromeApi?.debugger?.attach !== "function" ||
    typeof chromeApi.debugger?.sendCommand !== "function" ||
    typeof chromeApi.debugger?.detach !== "function") {
    throw failure("debugger_unavailable");
  }
}

/**
 * Runs one read-only accessibility snapshot. A runner is scoped to one
 * Extension connection and serializes operations per tab; separate Chrome
 * profiles get separate runner instances and can proceed concurrently.
 */
export function createDebuggerSnapshotRunner({ chromeApi } = {}) {
  if (!chromeApi) throw new TypeError("chromeApi is required");
  const inFlight = new Map();

  async function snapshot(tabId) {
    if (!isTabId(tabId)) throw failure("snapshot_failed");
    if (inFlight.has(tabId)) throw failure("debugger_busy");
    const token = {};
    inFlight.set(tabId, token);

    let attached = false;
    let accessibilityEnabled = false;
    let result;
    let operationError;
    try {
      if (typeof chromeApi.tabs?.get !== "function") throw failure("debugger_unavailable");
      try {
        const tab = await chromeApi.tabs.get(tabId);
        if (!tab || !isTabId(tab.id) || tab.id !== tabId) throw failure("tab_not_found");
      } catch (error) {
        if (error instanceof DebuggerSnapshotError && error.code === "tab_not_found") throw error;
        throw failure("tab_not_found");
      }

      assertDebuggerApi(chromeApi);
      try {
        await chromeApi.debugger.attach({ tabId }, "1.3");
        attached = true;
      } catch {
        throw failure("debugger_attach_failed");
      }

      try {
        const frameTree = await chromeApi.debugger.sendCommand({ tabId }, "Page.getFrameTree");
        const loaderId = frameTree?.frame?.loaderId;
        if (typeof loaderId !== "string" || loaderId.length === 0) throw failure("snapshot_failed");
        await chromeApi.debugger.sendCommand({ tabId }, "Accessibility.enable");
        accessibilityEnabled = true;
        const accessibilityTree = await chromeApi.debugger.sendCommand({ tabId }, "Accessibility.getFullAXTree");
        result = normalizeSnapshot({
          tabId,
          frameTree,
          axNodes: accessibilityTree?.nodes,
        });
      } catch (error) {
        if (error instanceof DebuggerSnapshotError) throw error;
        throw failure("snapshot_failed");
      }
    } catch (error) {
      operationError = error instanceof DebuggerSnapshotError ? error : failure("snapshot_failed");
    } finally {
      if (attached) {
        let cleanupFailed = false;
        if (accessibilityEnabled) {
          try {
            await chromeApi.debugger.sendCommand({ tabId }, "Accessibility.disable");
          } catch {
            cleanupFailed = true;
          }
        }
        try {
          await chromeApi.debugger.detach({ tabId });
        } catch {
          cleanupFailed = true;
        }
        if (cleanupFailed) operationError = failure("debugger_detach_failed");
      }
      if (inFlight.get(tabId) === token) inFlight.delete(tabId);
    }
    if (operationError) throw operationError;
    return result;
  }

  return Object.freeze({ snapshot });
}

export async function runDebuggerSnapshot(options) {
  return createDebuggerSnapshotRunner(options).snapshot(options.tabId);
}
