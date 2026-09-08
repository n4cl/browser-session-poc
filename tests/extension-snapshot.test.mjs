import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeSnapshot,
  respondToSnapshot,
} from "../extension/pairing-protocol.mjs";
import {
  createDebuggerSnapshotRunner,
  DebuggerSnapshotError,
} from "../extension/debugger-snapshot.mjs";
import { createPairingController } from "../extension/background.mjs";
import { validateBrowserCommandResponse } from "../core/browser-command-protocol.mjs";

const binding = Object.freeze({
  session_id: "session-a",
  browser_instance_id: "browser-a",
  profile_instance_id: "profile-a",
  generation: 1,
  lease_id: "lease-a",
});

function request(tabId = 7) {
  return {
    type: "snapshot_request",
    request_id: "snapshot-1",
    protocol_version: 1,
    ...binding,
    host_connection_id: "connection-a",
    tab_id: tabId,
  };
}

function node(nodeId, parentId = undefined, overrides = {}) {
  return {
    nodeId,
    ...(parentId === undefined ? {} : { parentId }),
    role: { value: "generic" },
    name: { value: "name" },
    value: { value: "value" },
    properties: [],
    ...overrides,
  };
}

function apiFixture({ sendCommand = undefined, attach = undefined, detach = undefined, tab = { id: 7 } } = {}) {
  const calls = [];
  const api = {
    tabs: {
      async get(tabId) {
        calls.push(["tabs.get", tabId]);
        if (!tab) throw new Error("tab missing");
        return tab;
      },
    },
    debugger: {
      async attach(target, version) {
        calls.push(["attach", target, version]);
        if (attach) return attach(target, version);
      },
      async sendCommand(target, method) {
        calls.push(["sendCommand", target, method]);
        if (sendCommand) return sendCommand(target, method);
        if (method === "Page.getFrameTree") return { frameTree: { frame: { loaderId: "loader-a" } } };
        if (method === "Accessibility.getFullAXTree") return { nodes: [node("root")] };
        return {};
      },
      async detach(target) {
        calls.push(["detach", target]);
        if (detach) return detach(target);
      },
    },
  };
  return { api, calls };
}

function pairingPort() {
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
    emit(message) {
      for (const listener of messageListeners) listener(message);
    },
    get disconnected() { return disconnected; },
  };
}

function pairingChrome(port, debuggerApi) {
  return {
    runtime: {
      lastError: undefined,
      connectNative() { return port; },
    },
    storage: {
      local: {
        async get() { return {}; },
        async set() {},
      },
    },
    tabs: {
      async get(tabId) { return { id: tabId }; },
    },
    debugger: debuggerApi,
  };
}

async function pairedController(chromeApi, port) {
  const controller = createPairingController({ chromeApi, setTimer: () => ({}) });
  await controller.connect();
  port.emit({ type: "pair_challenge", protocol_version: 1, ...binding, host_connection_id: "connection-a", pairing_mode: "initial" });
  await Promise.resolve();
  port.emit({ type: "pair_active", protocol_version: 1, ...binding, host_connection_id: "connection-a" });
  await Promise.resolve();
  return controller;
}

test("snapshot normalization produces bounded contiguous refs and hides raw AX fields", () => {
  const snapshot = normalizeSnapshot({
    tabId: 7,
    frameTree: { frame: { id: "root-frame", loaderId: "loader-a" }, childFrames: [{ id: "oopif" }] },
    axNodes: [
      node("child", "root", { properties: [{ name: "focused", value: { value: true } }] }),
      node("root", undefined, { backendDOMNodeId: 11, role: { value: "document" } }),
      node("oopif", undefined, { frameId: "oopif" }),
      node("ignored", undefined, { ignored: true }),
    ],
  });
  assert.deepEqual(snapshot.nodes.map(({ ref, parent_ref }) => ({ ref, parent_ref })), [
    { ref: 1, parent_ref: null },
    { ref: 2, parent_ref: 1 },
  ]);
  assert.equal(snapshot.nodes[1].state.focused, true);
  assert.equal(Object.hasOwn(snapshot.nodes[1], "nodeId"), false);
  const response = respondToSnapshot(request(), binding, "connection-a", snapshot);
  assert.deepEqual(validateBrowserCommandResponse(response, {
    command: "snapshot",
    requestId: "snapshot-1",
    binding,
    connectionId: "connection-a",
    target: { tabId: 7 },
  }), { ok: true, ...snapshot });
});

test("snapshot normalization handles cycles, missing parents, depth, node and text bounds", () => {
  const deep = [];
  for (let index = 0; index < 20; index += 1) {
    deep.push(node(`deep-${index}`, index === 0 ? undefined : `deep-${index - 1}`, {
      name: { value: "x".repeat(700) },
    }));
  }
  const snapshot = normalizeSnapshot({
    tabId: 7,
    frameTree: { frame: { loaderId: "loader-a" } },
    axNodes: [
      ...deep,
      node("cycle-a", "cycle-b"),
      node("cycle-b", "cycle-a"),
      node("orphan", "does-not-exist"),
      ...Array.from({ length: 120 }, (_, index) => node(`wide-${index}`)),
    ],
  });
  assert.equal(snapshot.nodes.length <= 100, true);
  assert.equal(snapshot.nodes.every((candidate, index) => candidate.ref === index + 1), true);
  assert.equal(snapshot.nodes.every((candidate) => candidate.name.length <= 512), true);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.partial, true);
  assert.doesNotThrow(() => validateBrowserCommandResponse(respondToSnapshot(request(), binding, "connection-a", snapshot), {
    command: "snapshot",
    requestId: "snapshot-1",
    binding,
    connectionId: "connection-a",
    target: { tabId: 7 },
  }));
});

test("snapshot response is compacted below the 64 KiB transport bound", () => {
  const snapshot = normalizeSnapshot({
    tabId: 7,
    frameTree: { frame: { loaderId: "loader-a" } },
    axNodes: Array.from({ length: 100 }, (_, index) => node(`wide-${index}`, undefined, {
      name: { value: "n".repeat(512) },
      value: { value: "v".repeat(512) },
      role: { value: "r".repeat(512) },
    })),
  });
  const response = respondToSnapshot(request(), binding, "connection-a", snapshot);
  assert.equal(new TextEncoder().encode(JSON.stringify(response)).byteLength <= 64 * 1024, true);
  assert.equal(response.truncated, true);
  assert.doesNotThrow(() => validateBrowserCommandResponse(response, {
    command: "snapshot",
    requestId: "snapshot-1",
    binding,
    connectionId: "connection-a",
    target: { tabId: 7 },
  }));
});

test("debugger snapshot follows attach/CDP/disable/detach order", async () => {
  const { api, calls } = apiFixture();
  const result = await createDebuggerSnapshotRunner({ chromeApi: api }).snapshot(7);
  assert.equal(result.document.loader_id, "loader-a");
  assert.deepEqual(calls.map(([name, ...args]) => [name, ...args]), [
    ["tabs.get", 7],
    ["attach", { tabId: 7 }, "1.3"],
    ["sendCommand", { tabId: 7 }, "Page.getFrameTree"],
    ["sendCommand", { tabId: 7 }, "Accessibility.enable"],
    ["sendCommand", { tabId: 7 }, "Accessibility.getFullAXTree"],
    ["sendCommand", { tabId: 7 }, "Accessibility.disable"],
    ["detach", { tabId: 7 }],
  ]);
});

test("debugger attach failure never attempts detach and Chrome errors stay fixed", async () => {
  const { api, calls } = apiFixture({ attach() { throw new Error("secret Chrome detail"); } });
  await assert.rejects(createDebuggerSnapshotRunner({ chromeApi: api }).snapshot(7), (error) => {
    assert.ok(error instanceof DebuggerSnapshotError);
    assert.equal(error.code, "debugger_attach_failed");
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
  assert.deepEqual(calls.map(([name]) => name), ["tabs.get", "attach"]);
});

test("invalid Page.getFrameTree responses return fixed snapshot_failed and still detach", async () => {
  for (const response of [{}, { frameTree: {} }, { frameTree: null }]) {
    const { api, calls } = apiFixture({
      sendCommand(_target, method) {
        if (method === "Page.getFrameTree") return response;
        if (method === "Accessibility.getFullAXTree") return { nodes: [node("root")] };
        return {};
      },
    });
    await assert.rejects(createDebuggerSnapshotRunner({ chromeApi: api }).snapshot(7), (error) => {
      assert.equal(error.code, "snapshot_failed");
      assert.equal(error.message, "snapshot_failed");
      return true;
    });
    assert.deepEqual(calls.map(([name]) => name), [
      "tabs.get",
      "attach",
      "sendCommand",
      "detach",
    ]);
  }
});

test("same-tab snapshots reject busy and allow a later operation", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { api } = apiFixture({
    sendCommand(_target, method) {
      if (method === "Page.getFrameTree") return blocked;
      if (method === "Accessibility.getFullAXTree") return { nodes: [node("root")] };
      return {};
    },
  });
  const runner = createDebuggerSnapshotRunner({ chromeApi: api });
  const first = runner.snapshot(7);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(runner.snapshot(7), (error) => error.code === "debugger_busy");
  release({ frameTree: { frame: { loaderId: "loader-a" } } });
  await first;
  await assert.doesNotReject(runner.snapshot(7));
});

test("cleanup failure wins over an otherwise complete snapshot", async () => {
  const { api } = apiFixture({ detach() { throw new Error("detach detail"); } });
  await assert.rejects(createDebuggerSnapshotRunner({ chromeApi: api }).snapshot(7), (error) => error.code === "debugger_detach_failed");
});

test("background drops a snapshot response when the Native Host port changes mid-command", async () => {
  const port = pairingPort();
  let release;
  const frameTree = new Promise((resolve) => { release = resolve; });
  const debuggerApi = {
    async attach() {},
    async sendCommand(_target, method) {
      if (method === "Page.getFrameTree") return frameTree;
      if (method === "Accessibility.getFullAXTree") return { nodes: [node("root")] };
      return {};
    },
    async detach() {},
  };
  const controller = await pairedController(pairingChrome(port, debuggerApi), port);
  port.emit(request());
  await new Promise((resolve) => setImmediate(resolve));
  port.disconnect();
  release({ frameTree: { frame: { loaderId: "loader-a" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(port.messages.some((message) => message.type === "snapshot_response"), false);
  assert.equal(controller.getState().phase, "IDLE");
});
