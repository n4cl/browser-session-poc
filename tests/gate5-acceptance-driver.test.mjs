import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  DRIVER_TOOL_NAMES,
  StdioJsonRpcClient,
  assessFinalSnapshot,
  buildFixtureUrl,
  newStats,
  parseDriverArguments,
  runAcceptance,
  validateToolsList,
} from "../scripts/gate5-acceptance-driver.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

function jsonRpcResult(id, value) {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result: value })}\n`;
}

function toolResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toolError(code) {
  return { isError: true, content: [{ type: "text", text: code }] };
}

function toolDefinitions() {
  return { tools: DRIVER_TOOL_NAMES.map((name) => ({ name })) };
}

function node(ref, backend, role, name, value = null) {
  return {
    ref,
    parent_ref: null,
    backend_dom_node_id: backend,
    role,
    name,
    value,
    state: { disabled: false, expanded: false, focused: false, hidden: false },
  };
}

function snapshot(loaderId, nodes, tabId = 7) {
  return {
    tab_id: tabId,
    document: { loader_id: loaderId },
    nodes,
    truncated: false,
    partial: false,
  };
}

class FakeAcceptanceClient {
  constructor(responses) {
    this.responses = [...responses];
    this.calls = [];
    this.notifications = [];
  }

  async request(method, params) {
    this.calls.push({ method, params });
    const response = this.responses.shift();
    if (!response) throw new Error("fake response exhausted");
    return response;
  }

  notify(method, params) {
    this.notifications.push({ method, params });
  }
}

test("driver argument parsing is explicit, loopback-only, and test-only friendly", () => {
  const parsed = parseDriverArguments([
    "--instance-id", "poc-a",
    "--fixture-origin", "http://127.0.0.1:50977",
    "--marker", "alpha",
    "--other-marker", "bravo",
    "--suffix", "-a",
  ]);
  assert.equal(parsed.fixtureOrigin, "http://127.0.0.1:50977");
  assert.equal(parsed.startFixture, false);
  assert.throws(() => parseDriverArguments([
    "--instance-id", "poc-a",
    "--fixture-origin", "https://127.0.0.1:50977",
    "--marker", "alpha",
    "--other-marker", "bravo",
    "--suffix", "-a",
  ]), /invalid_arguments/u);
  assert.deepEqual(parseDriverArguments(["--help"]), { help: true });
  assert.equal(buildFixtureUrl("http://127.0.0.1:50977", "alpha"), "http://127.0.0.1:50977/?marker=alpha");
});

test("tools/list exactness rejects missing or extra tools", () => {
  assert.equal(validateToolsList(toolDefinitions()), true);
  assert.equal(validateToolsList({ tools: [...toolDefinitions().tools, { name: "extra" }] }), false);
  assert.equal(validateToolsList({ tools: toolDefinitions().tools.slice(1) }), false);
});

test("stdio JSON-RPC client performs request/response framing without exposing payloads", async () => {
  const child = fakeChild();
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (buffer.includes("\n")) {
      const newline = buffer.indexOf("\n");
      const request = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      if (request.method === "initialize") {
        child.stdout.write(jsonRpcResult(request.id, { protocolVersion: "2025-03-26" }));
      } else if (request.method === "tools/list") {
        child.stdout.write(jsonRpcResult(request.id, toolDefinitions()));
      } else if (request.method === "tools/call") {
        child.stdout.write(jsonRpcResult(request.id, toolResult({ status: { extension_connected: true, chrome_tabs_available: true } })));
      }
    }
  });
  const client = new StdioJsonRpcClient(child, { timeoutMs: 500 });
  const initialize = await client.request("initialize", {});
  assert.equal(initialize.result.protocolVersion, "2025-03-26");
  client.notify("notifications/initialized", {});
  const tools = await client.request("tools/list", {});
  assert.equal(validateToolsList(tools.result), true);
  const status = await client.request("tools/call", { name: "browser_status", arguments: {} });
  assert.equal(status.result.content[0].type, "text");
  client.endInput();
  child.emit("close");
});

test("final snapshot assessment returns only booleans and rejects the other marker", () => {
  const good = snapshot("loader-final", [
    node(1, 1, "heading", "Gate 4 storage fixture"),
    node(2, 2, "textbox", "Marker", "alpha-a"),
    node(3, null, "term", "Stored marker"),
    node(4, null, "definition", null, "alpha-a"),
    node(5, null, "term", "Cookie marker"),
    node(6, null, "definition", null, "alpha-a"),
    node(7, null, "term", "localStorage marker"),
    node(8, null, "definition", null, "alpha-a"),
    node(9, null, "term", "Cookie/localStorage match"),
    node(10, null, "definition", null, "true"),
  ]);
  assert.deepEqual(assessFinalSnapshot(good, { expectedMarker: "alpha-a", otherMarker: "bravo-b" }), {
    fixtureH1Present: true,
    cookieLocalStorageMatch: true,
    ownMarkerMatch: true,
    otherMarkerAbsent: true,
  });
  assert.equal(assessFinalSnapshot(good, { expectedMarker: "alpha-a", otherMarker: "alpha-a" }).otherMarkerAbsent, false);
});

test("acceptance sequence uses fresh snapshot targets, retries read-only snapshot only, and mutates once", async () => {
  const firstNodes = [node(1, 1, "heading", "Gate 4 storage fixture"), node(2, 11, "textbox", "Marker", "alpha")];
  const afterTypeNodes = [node(1, 1, "heading", "Gate 4 storage fixture"), node(2, 22, "button", "Save marker")];
  const finalNodes = [
    node(1, 1, "heading", "Gate 4 storage fixture"),
    node(2, 2, "textbox", "Marker", "alpha-a"),
    node(3, null, "term", "Stored marker"), node(4, null, "definition", null, "alpha-a"),
    node(5, null, "term", "Cookie marker"), node(6, null, "definition", null, "alpha-a"),
    node(7, null, "term", "localStorage marker"), node(8, null, "definition", null, "alpha-a"),
    node(9, null, "term", "Cookie/localStorage match"), node(10, null, "definition", null, "true"),
  ];
  const responses = [
    { result: { protocolVersion: "2025-03-26" } },
    { result: toolDefinitions() },
    { result: toolResult({ status: { extension_connected: true, chrome_tabs_available: true } }) },
    { result: toolResult({ tabs: [{ id: 7, window_id: 1, active: true }] }) },
    { result: toolResult({ tab_id: 7, accepted: true }) },
    { result: toolError("snapshot_failed") },
    { result: toolResult(snapshot("loader-one", firstNodes)) },
    { result: toolResult({ tab_id: 7, loader_id: "loader-one", backend_dom_node_id: 11, accepted: true }) },
    { result: toolResult(snapshot("loader-two", afterTypeNodes)) },
    { result: toolResult({ tab_id: 7, loader_id: "loader-two", backend_dom_node_id: 22, accepted: true }) },
    { result: toolResult(snapshot("loader-two", finalNodes)) },
  ];
  const client = new FakeAcceptanceClient(responses);
  const stats = newStats();
  const result = await runAcceptance({
    client,
    fixtureOrigin: "http://127.0.0.1:50977",
    marker: "alpha",
    otherMarker: "bravo-b",
    suffix: "-a",
    stats,
  });
  assert.equal(result.result, "PASS");
  assert.equal(result.snapshot_attempts, 4);
  assert.equal(result.tool_counts.navigate, 1);
  assert.equal(result.tool_counts.type, 1);
  assert.equal(result.tool_counts.click, 1);
  assert.equal(result.correlation_ok, true);
  assert.equal(client.notifications.length, 1);
  const toolCalls = client.calls.filter(({ method }) => method === "tools/call");
  assert.deepEqual(toolCalls.map(({ params }) => params.name), [
    "browser_status", "tabs_list", "navigate", "snapshot", "snapshot", "type", "snapshot", "click", "snapshot",
  ]);
  assert.deepEqual(toolCalls.find(({ params }) => params.name === "navigate").params.arguments, {
    tab_id: 7,
    url: "http://127.0.0.1:50977/?marker=alpha",
  });
  assert.deepEqual(toolCalls.find(({ params }) => params.name === "type").params.arguments, {
    tab_id: 7,
    loader_id: "loader-one",
    backend_dom_node_id: 11,
    text: "-a",
  });
  assert.deepEqual(toolCalls.find(({ params }) => params.name === "click").params.arguments, {
    tab_id: 7,
    loader_id: "loader-two",
    backend_dom_node_id: 22,
  });
});

test("mutation outcome_unknown is not retried", async () => {
  const responses = [
    { result: { protocolVersion: "2025-03-26" } },
    { result: toolDefinitions() },
    { result: toolResult({ status: { extension_connected: true, chrome_tabs_available: true } }) },
    { result: toolResult({ tabs: [{ id: 7, window_id: 1, active: true }] }) },
    { result: toolResult({ tab_id: 7, accepted: true }) },
    { result: toolResult(snapshot("loader-one", [node(1, 11, "textbox", "Marker", "alpha")])) },
    { result: toolError("outcome_unknown") },
  ];
  const client = new FakeAcceptanceClient(responses);
  const stats = newStats();
  const result = await runAcceptance({
    client,
    fixtureOrigin: "http://127.0.0.1:50977",
    marker: "alpha",
    otherMarker: "bravo",
    suffix: "-a",
    stats,
  });
  assert.equal(result.fixed_error, "outcome_unknown");
  assert.equal(result.tool_counts.type, 1);
  assert.equal(result.tool_counts.click, 0);
  assert.equal(client.calls.filter(({ method, params }) => method === "tools/call" && params.name === "type").length, 1);
});
