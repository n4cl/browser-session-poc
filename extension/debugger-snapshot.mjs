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
export const CLICK_ERROR_CODES = Object.freeze([
  "debugger_unavailable",
  "tab_not_found",
  "debugger_busy",
  "debugger_attach_failed",
  "stale_document",
  "node_not_found",
  "not_interactable",
  "click_failed",
  "outcome_unknown",
  "debugger_detach_failed",
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

function isLoaderId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/\s/u.test(value);
}

function isBackendDomNodeId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function assertDebuggerApi(chromeApi) {
  if (typeof chromeApi?.debugger?.attach !== "function" ||
    typeof chromeApi.debugger?.sendCommand !== "function" ||
    typeof chromeApi.debugger?.detach !== "function") {
    throw failure("debugger_unavailable");
  }
}

function quadCenter(quads) {
  if (!Array.isArray(quads)) return null;
  let selected = null;
  let selectedArea = 0;
  for (const quad of quads) {
    if (!Array.isArray(quad) || quad.length !== 8 || !quad.every((value) => typeof value === "number" && Number.isFinite(value))) continue;
    const area = Math.abs(
      (quad[0] * quad[3] + quad[2] * quad[5] + quad[4] * quad[7] + quad[6] * quad[1] -
        quad[1] * quad[2] - quad[3] * quad[4] - quad[5] * quad[6] - quad[7] * quad[0]) / 2,
    );
    if (area <= selectedArea) continue;
    selectedArea = area;
    selected = {
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    };
  }
  return selected;
}

/**
 * Runs snapshot and click operations for one Extension service-worker controller.
 * Operations are serialized per tab; separate Chrome profiles use separate controllers.
 */
export function createDebuggerSnapshotRunner({ chromeApi } = {}) {
  if (!chromeApi) throw new TypeError("chromeApi is required");
  const inFlight = new Map();

  async function runTabOperation(tabId, operation, fallbackCode) {
    if (!isTabId(tabId)) throw failure(fallbackCode);
    if (inFlight.has(tabId)) throw failure("debugger_busy");
    const token = {};
    inFlight.set(tabId, token);

    let attached = false;
    const context = { accessibilityEnabled: false, mutationMayHaveOccurred: false };
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
        result = await operation({
          sendCommand: (method, params = undefined) =>
            params === undefined
              ? chromeApi.debugger.sendCommand({ tabId }, method)
              : chromeApi.debugger.sendCommand({ tabId }, method, params),
          context,
        });
      } catch (error) {
        if (error instanceof DebuggerSnapshotError) throw error;
        throw failure(fallbackCode);
      }
    } catch (error) {
      operationError = error instanceof DebuggerSnapshotError ? error : failure("snapshot_failed");
    } finally {
      if (attached) {
        let cleanupFailed = false;
        if (context.accessibilityEnabled) {
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
        if (cleanupFailed) {
          operationError = context.mutationMayHaveOccurred
            ? failure("outcome_unknown")
            : failure("debugger_detach_failed");
        }
      }
      if (inFlight.get(tabId) === token) inFlight.delete(tabId);
    }
    if (operationError) throw operationError;
    return result;
  }

  async function snapshot(tabId) {
    return runTabOperation(tabId, async ({ sendCommand, context }) => {
      let frameTreeResponse;
      try {
        frameTreeResponse = await sendCommand("Page.getFrameTree");
        const frameTree = frameTreeResponse?.frameTree;
        const loaderId = frameTree?.frame?.loaderId;
        if (!frameTree || typeof frameTree !== "object" || typeof loaderId !== "string" || loaderId.length === 0) {
          throw failure("snapshot_failed");
        }
        await sendCommand("Accessibility.enable");
        context.accessibilityEnabled = true;
        const accessibilityTree = await sendCommand("Accessibility.getFullAXTree");
        return normalizeSnapshot({ tabId, frameTree, axNodes: accessibilityTree?.nodes });
      } catch (error) {
        if (error instanceof DebuggerSnapshotError) throw error;
        throw failure("snapshot_failed");
      }
    }, "snapshot_failed");
  }

  async function click(tabId, loaderId, backendDomNodeId) {
    if (!isLoaderId(loaderId) || !isBackendDomNodeId(backendDomNodeId)) throw failure("click_failed");
    return runTabOperation(tabId, async ({ sendCommand, context }) => {
      let frameTreeResponse;
      try {
        frameTreeResponse = await sendCommand("Page.getFrameTree");
      } catch {
        throw failure("click_failed");
      }
      const frameTree = frameTreeResponse?.frameTree;
      const currentLoaderId = frameTree?.frame?.loaderId;
      if (!frameTree || typeof frameTree !== "object" || !isLoaderId(currentLoaderId)) throw failure("click_failed");
      if (currentLoaderId !== loaderId) throw failure("stale_document");

      try {
        await sendCommand("DOM.scrollIntoViewIfNeeded", { backendNodeId: backendDomNodeId });
      } catch {
        throw failure("node_not_found");
      }

      let contentQuads;
      try {
        contentQuads = await sendCommand("DOM.getContentQuads", { backendNodeId: backendDomNodeId });
      } catch {
        throw failure("not_interactable");
      }
      const center = quadCenter(contentQuads?.quads);
      if (!center) throw failure("not_interactable");

      try {
        await sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: center.x, y: center.y });
      } catch {
        throw failure("click_failed");
      }
      try {
        context.mutationMayHaveOccurred = true;
        await sendCommand("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: center.x,
          y: center.y,
          button: "left",
          clickCount: 1,
        });
      } catch {
        throw failure("outcome_unknown");
      }
      try {
        await sendCommand("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: center.x,
          y: center.y,
          button: "left",
          clickCount: 1,
        });
      } catch {
        throw failure("outcome_unknown");
      }
      return { tabId, loaderId, backendDomNodeId, accepted: true };
    }, "click_failed");
  }

  return Object.freeze({ snapshot, click });
}

export async function runDebuggerSnapshot(options) {
  return createDebuggerSnapshotRunner(options).snapshot(options.tabId);
}
