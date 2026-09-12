import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MCP_SMOKE_MAX_BUFFER_BYTES } from "../scripts/mcp-smoke-server.mjs";

const SERVER_PATH = fileURLToPath(new URL("../scripts/mcp-smoke-server.mjs", import.meta.url));
const LEGACY_PROTOCOL_VERSION = "2025-03-26";

function spawnSmokeServer() {
  const child = spawn(process.execPath, [SERVER_PATH], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.setDefaultEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  let diagnostics = "";
  const lines = [];
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    output += chunk;
    while (output.includes("\n")) {
      const newline = output.indexOf("\n");
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      if (line.length === 0) continue;
      let message;
      try { message = JSON.parse(line); } catch { message = { parse_error: true, raw: line }; }
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else lines.push(message);
    }
  });
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  child.once("error", (error) => { for (const waiter of waiters.splice(0)) waiter.reject(error); });
  const nextMessage = () => new Promise((resolve, reject) => {
    if (lines.length > 0) resolve(lines.shift());
    else waiters.push({ resolve, reject });
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const waitForClose = (timeoutMs = 2_000) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.removeListener("close", onClose);
        reject(new Error("smoke server did not close within the bound"));
      }, timeoutMs);
      const onClose = (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      };
      child.once("close", onClose);
    });
  };
  const close = async () => {
    const closePromise = waitForClose();
    if (child.exitCode === null && child.signalCode === null) child.stdin.end();
    const { code, signal } = await closePromise;
    return { code, signal, diagnostics };
  };
  return { child, output: () => output, diagnostics: () => diagnostics, send, nextMessage, waitForClose, close };
}

function initializeRequest(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "browser-session-poc-smoke-client", version: "0.0.0" },
    },
  };
}

async function initialize(server) {
  server.send(initializeRequest());
  const response = await server.nextMessage();
  assert.equal(response.id, 1);
  assert.equal(response.error, undefined);
  assert.equal(response.result.protocolVersion, LEGACY_PROTOCOL_VERSION);
  assert.deepEqual(response.result.serverInfo, {
    name: "browser-session-poc-mcp-smoke",
    version: "0.0.0",
  });
  server.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
}

test("MCP SDK v2 serves the legacy 2025 stdio handshake without a probe", async () => {
  const server = spawnSmokeServer();
  try {
    await initialize(server);
    server.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = await server.nextMessage();
    assert.equal(tools.id, 2);
    assert.deepEqual(tools.result.tools.map(({ name }) => name), ["health"]);
    assert.deepEqual(tools.result.tools[0].inputSchema, {
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    server.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "health", arguments: {} } });
    const health = await server.nextMessage();
    assert.equal(health.id, 3);
    assert.deepEqual(health.result, { content: [{ type: "text", text: "ok" }] });
    assert.equal(server.diagnostics(), "");
  } finally {
    const result = await server.close();
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    assert.equal(result.diagnostics, "");
  }
});

test("MCP SDK rejects unknown tools and malformed exact-empty arguments without echoing input", async () => {
  const server = spawnSmokeServer();
  try {
    await initialize(server);
    server.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "unknown", arguments: {} } });
    const unknown = await server.nextMessage();
    assert.equal(unknown.id, 4);
    assert.ok(unknown.error || unknown.result?.isError);
    assert.doesNotMatch(JSON.stringify(unknown), /unknown-secret/u);

    server.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "health", arguments: { "unknown-secret": true } } });
    const malformed = await server.nextMessage();
    assert.equal(malformed.id, 5);
    assert.ok(malformed.error || malformed.result?.isError);
    assert.doesNotMatch(JSON.stringify(malformed), /unknown-secret/u);
    assert.equal(server.diagnostics(), "");
  } finally {
    const result = await server.close();
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
  }
});

test("MCP SDK stdio emits only newline-delimited JSON-RPC and exits cleanly on SIGTERM", async () => {
  const server = spawnSmokeServer();
  await initialize(server);
  const closePromise = server.waitForClose();
  server.child.kill("SIGTERM");
  const { code, signal } = await closePromise;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(server.diagnostics(), "");
});

test("MCP SDK stdio closes on a message larger than its configured bound", async () => {
  const server = spawnSmokeServer();
  try {
    const closePromise = server.waitForClose();
    const oversized = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { padding: "x".repeat(MCP_SMOKE_MAX_BUFFER_BYTES) } });
    assert.ok(Buffer.byteLength(oversized) > MCP_SMOKE_MAX_BUFFER_BYTES);
    server.child.stdin.end(`${oversized}\n`);
    const { code, signal } = await closePromise;
    assert.equal(code, 0);
    assert.equal(signal, null);
    assert.equal(server.output(), "");
    assert.equal(server.diagnostics(), "mcp_smoke_error\n");
  } finally {
    if (server.child.exitCode === null && server.child.signalCode === null) server.child.kill("SIGKILL");
  }
});
