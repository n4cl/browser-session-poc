import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";

import { createMcpBrowserServer } from "../scripts/mcp-browser-adapter.mjs";

const LEGACY_PROTOCOL_VERSION = "2025-03-26";

function initializeRequest(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "browser-session-poc-g5-2-test", version: "0.0.0" },
    },
  };
}

function createClient(browserServer, createRequestId = (() => {
  let count = 0;
  return () => `core-request-${++count}`;
})()) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.setDefaultEncoding("utf8");
  let buffered = "";
  const messages = [];
  const waiters = [];
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line);
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    }
  });
  const handle = serveStdio(
    () => createMcpBrowserServer({ browserServer, createRequestId }),
    { transport: new StdioServerTransport(input, output), legacy: "serve" },
  );
  return {
    send(message) { input.write(`${JSON.stringify(message)}\n`); },
    next() {
      if (messages.length > 0) return Promise.resolve(messages.shift());
      return new Promise((resolve) => waiters.push(resolve));
    },
    async close() {
      input.end();
      await handle.close();
    },
  };
}

async function initializeAndList(client) {
  client.send(initializeRequest());
  const initialized = await client.next();
  assert.equal(initialized.result.protocolVersion, LEGACY_PROTOCOL_VERSION);
  client.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  client.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  return client.next();
}

function fakeBrowserServer(calls, overrides = {}) {
  return {
    requestBrowserStatus: async (options) => {
      calls.push(["browser_status", options]);
      return { status: { extension_connected: true, chrome_tabs_available: true }, session_id: "session-secret" };
    },
    requestTabsList: async (options) => {
      calls.push(["tabs_list", options]);
      return {
        tabs: [{ id: 7, window_id: 1, active: true, title: "title-secret", url: "https://url-secret.test/" }],
      };
    },
    requestNavigate: async (options) => {
      calls.push(["navigate", options]);
      return { tab_id: options.tabId, accepted: true, url: options.url };
    },
    requestSnapshot: async (options) => {
      calls.push(["snapshot", options]);
      return {
        tab_id: options.tabId,
        document: { loader_id: "loader-safe" },
        nodes: [{
          ref: 1,
          parent_ref: null,
          backend_dom_node_id: null,
          role: "RootWebArea",
          name: "Example",
          value: null,
          state: { disabled: false, expanded: false, focused: false, hidden: false },
        }],
        truncated: false,
        partial: false,
      };
    },
    requestClick: async (options) => {
      calls.push(["click", options]);
      return { tab_id: options.tabId, loader_id: options.loaderId, backend_dom_node_id: options.backendDomNodeId, accepted: true };
    },
    requestType: async (options) => {
      calls.push(["type", options]);
      return { tab_id: options.tabId, loader_id: options.loaderId, backend_dom_node_id: options.backendDomNodeId, accepted: true };
    },
    ...overrides,
  };
}

test("MCP browser adapter exposes exactly six strict tools and dispatches each core method once", async () => {
  const calls = [];
  const client = createClient(fakeBrowserServer(calls));
  try {
    const tools = await initializeAndList(client);
    assert.deepEqual(tools.result.tools.map(({ name }) => name), [
      "browser_status", "tabs_list", "navigate", "snapshot", "click", "type",
    ]);
    assert.deepEqual(tools.result.tools.find(({ name }) => name === "browser_status").inputSchema, {
      type: "object", properties: {}, additionalProperties: false,
    });
    assert.deepEqual(tools.result.tools.find(({ name }) => name === "type").inputSchema.required, [
      "tab_id", "loader_id", "backend_dom_node_id", "text",
    ]);

    const requests = [
      ["browser_status", {}],
      ["tabs_list", {}],
      ["navigate", { tab_id: 7, url: "https://example.test/next" }],
      ["snapshot", { tab_id: 7 }],
      ["click", { tab_id: 7, loader_id: "loader-safe", backend_dom_node_id: 42 }],
      ["type", { tab_id: 7, loader_id: "loader-safe", backend_dom_node_id: 42, text: "secret input" }],
    ];
    for (const [index, [name, args]] of requests.entries()) {
      client.send({ jsonrpc: "2.0", id: 10 + index, method: "tools/call", params: { name, arguments: args } });
      const response = await client.next();
      assert.equal(response.id, 10 + index);
      assert.equal(response.result.isError, undefined);
    }
    assert.deepEqual(calls.map(([command]) => command), requests.map(([command]) => command));
    assert.deepEqual(calls.map(([, options]) => options.requestId), [
      "core-request-1", "core-request-2", "core-request-3", "core-request-4", "core-request-5", "core-request-6",
    ]);
  } finally {
    await client.close();
  }
});

test("MCP browser adapter strips tab URL/title and type text from results", async () => {
  const calls = [];
  const client = createClient(fakeBrowserServer(calls));
  try {
    await initializeAndList(client);
    client.send({ jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "tabs_list", arguments: {} } });
    const tabs = await client.next();
    assert.deepEqual(tabs.result.structuredContent, { tabs: [{ id: 7, window_id: 1, active: true }] });
    assert.doesNotMatch(JSON.stringify(tabs), /title-secret|url-secret/u);
    client.send({
      jsonrpc: "2.0", id: 21, method: "tools/call",
      params: { name: "type", arguments: { tab_id: 7, loader_id: "loader-safe", backend_dom_node_id: 42, text: "input-secret" } },
    });
    const typed = await client.next();
    assert.deepEqual(typed.result.structuredContent, {
      tab_id: 7, loader_id: "loader-safe", backend_dom_node_id: 42, accepted: true,
    });
    assert.doesNotMatch(JSON.stringify(typed), /input-secret/u);
  } finally {
    await client.close();
  }
});

test("MCP browser adapter rejects malformed input, maps fixed errors, and does not retry", async () => {
  const calls = [];
  let clickCalls = 0;
  const client = createClient(fakeBrowserServer(calls, {
    requestClick: async (options) => {
      clickCalls += 1;
      calls.push(["click", options]);
      const error = new Error("raw Chrome secret");
      error.code = "outcome_unknown";
      throw error;
    },
  }));
  try {
    await initializeAndList(client);
    client.send({
      jsonrpc: "2.0", id: 30, method: "tools/call",
      params: { name: "navigate", arguments: { tab_id: 7, url: "https://example.test/", extra: "secret" } },
    });
    const malformed = await client.next();
    assert.ok(malformed.error || malformed.result?.isError);
    assert.doesNotMatch(JSON.stringify(malformed), /secret/u);
    assert.equal(calls.length, 0);

    client.send({
      jsonrpc: "2.0", id: 31, method: "tools/call",
      params: { name: "click", arguments: { tab_id: 7, loader_id: "loader-safe", backend_dom_node_id: 42 } },
    });
    const failed = await client.next();
    assert.equal(failed.result.isError, true);
    assert.deepEqual(failed.result.content, [{ type: "text", text: "outcome_unknown" }]);
    assert.doesNotMatch(JSON.stringify(failed), /raw Chrome secret/u);
    assert.equal(clickCalls, 1);
  } finally {
    await client.close();
  }
});

test("MCP browser adapter converts an oversized compact result to a fixed error", async () => {
  const client = createClient(fakeBrowserServer([], {
    requestSnapshot: async () => ({
      tab_id: 7,
      document: { loader_id: "loader-safe" },
      nodes: [{
        ref: 1,
        parent_ref: null,
        backend_dom_node_id: null,
        role: "RootWebArea",
        name: "x".repeat(66_000),
        value: null,
        state: { disabled: false, expanded: false, focused: false, hidden: false },
      }],
      truncated: false,
      partial: false,
    }),
  }));
  try {
    await initializeAndList(client);
    client.send({ jsonrpc: "2.0", id: 40, method: "tools/call", params: { name: "snapshot", arguments: { tab_id: 7 } } });
    const response = await client.next();
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.content, [{ type: "text", text: "response_too_large" }]);
  } finally {
    await client.close();
  }
});
