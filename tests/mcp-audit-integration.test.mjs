import assert from "node:assert/strict";
import net from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import path from "node:path";
import test from "node:test";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";

import { encodeNativeMessage, NativeMessageDecoder } from "../native-host/codec.mjs";
import {
  createPairingDescriptor,
  createSocketPath,
  loadOrCreateProfileMetadata,
  resolvePairingPaths,
} from "../core/pairing-descriptor.mjs";
import { AUDIT_ERROR_CODE, createPairingAuditLogger, pairingAuditFilePath } from "../core/pairing-audit-log.mjs";
import { PairingSocketServer } from "../core/pairing-socket-server.mjs";
import { createMcpBrowserServer } from "../scripts/mcp-browser-adapter.mjs";

const NOW = new Date("2030-01-01T00:30:00.000Z");
const FORBIDDEN_OUTPUT = /https?:|title-secret|cookie-secret|storage-secret|lease-|nonce-|connection-|session-|profile-|\/private\/tmp|pid-secret|mcp-request/u;

async function serverFixture({ instanceId = "poc-a", suffix = "111111111111", auditLogger = null } = {}) {
  const runtimeRoot = await mkdtemp(path.join("/private/tmp", "bsp-mcp-audit-"));
  const paths = resolvePairingPaths({ runtimeRoot, instanceId });
  await mkdir(paths.instanceDir, { recursive: true, mode: 0o700 });
  await chmod(paths.instanceDir, 0o700);
  const metadata = await loadOrCreateProfileMetadata(paths, {
    createUuid: () => `11111111-1111-4111-8111-${suffix}`,
  });
  const descriptor = createPairingDescriptor({
    paths,
    profileInstanceId: metadata.profile_instance_id,
    sessionId: `session-${instanceId}`,
    generation: 1,
    socketPath: await createSocketPath(paths, { createUuid: () => `22222222-2222-4222-8222-${suffix}` }),
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T01:00:00.000Z",
    leaseId: `lease-${instanceId}`,
    pairingNonce: `nonce-${instanceId}`,
  });
  if (auditLogger === "real") {
    auditLogger = await createPairingAuditLogger({ paths, generation: descriptor.generation });
  }
  const server = new PairingSocketServer({
    paths,
    descriptor,
    profileInstanceId: metadata.profile_instance_id,
    now: NOW,
    auditLogger,
  });
  return { runtimeRoot, paths, descriptor, server, auditLogger };
}

function message(descriptor, type, connectionId, extra = {}) {
  return {
    type,
    protocol_version: 1,
    session_id: descriptor.session_id,
    browser_instance_id: descriptor.browser_instance_id,
    profile_instance_id: descriptor.profile_instance_id,
    generation: descriptor.generation,
    lease_id: descriptor.lease_id,
    host_connection_id: connectionId,
    ...extra,
  };
}

async function activeClient(descriptor) {
  const socket = net.createConnection(descriptor.socket_path);
  await once(socket, "connect");
  socket.on("error", () => {});
  const decoder = new NativeMessageDecoder({ maxBytes: 64 * 1024 });
  const messages = [];
  const waiters = [];
  socket.on("data", (chunk) => {
    for (const item of decoder.push(chunk)) messages.push(item);
    while (messages.length > 0 && waiters.length > 0) waiters.shift()(messages.shift());
  });
  const next = (timeoutMs = 1_000) => {
    if (messages.length > 0) return Promise.resolve(messages.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("host message timeout"));
      }, timeoutMs);
      const waiter = (messageValue) => {
        clearTimeout(timer);
        resolve(messageValue);
      };
      waiters.push(waiter);
    });
  };
  socket.write(encodeNativeMessage(message(descriptor, "host_register", "connection-a", {
    pairing_nonce: descriptor.pairing_nonce,
  })));
  assert.equal((await next()).type, "pair_challenge");
  socket.write(encodeNativeMessage(message(descriptor, "pair_ack", "connection-a")));
  assert.equal((await next()).type, "pair_active");
  return { socket, next, hasMessage: () => messages.length > 0 };
}

function mcpClient(browserServer, createRequestId) {
  const input = new PassThrough();
  const output = new PassThrough();
  input.setDefaultEncoding("utf8");
  output.setEncoding("utf8");
  let buffered = "";
  const messages = [];
  const waiters = [];
  output.on("data", (chunk) => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const messageValue = JSON.parse(line);
      if (waiters.length > 0) waiters.shift()(messageValue);
      else messages.push(messageValue);
    }
  });
  const handle = serveStdio(
    () => createMcpBrowserServer({ browserServer, createRequestId }),
    { transport: new StdioServerTransport(input, output), legacy: "serve" },
  );
  return {
    send(messageValue) { input.write(`${JSON.stringify(messageValue)}\n`); },
    next(timeoutMs = 1_000) {
      if (messages.length > 0) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("MCP response timeout"));
        }, timeoutMs);
        const waiter = (messageValue) => {
          clearTimeout(timer);
          resolve(messageValue);
        };
        waiters.push(waiter);
      });
    },
    async close() {
      input.end();
      await handle.close();
    },
  };
}

async function initialize(client) {
  client.send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "browser-session-poc-g5-3-test", version: "0.0.0" },
    },
  });
  assert.equal((await client.next()).result.protocolVersion, "2025-03-26");
  client.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
}

function toolRequest(id, name, argumentsValue) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: argumentsValue } };
}

function navigateResponse(fixture, requestId) {
  return message(fixture.descriptor, "navigate_response", "connection-a", {
    request_id: requestId,
    tab_id: 7,
  });
}

function assertAuditEvents(events, expectedOutcomes) {
  assert.deepEqual(events.map((event) => event.outcome), expectedOutcomes);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), [
      "browser_instance_id", "command", "generation", "outcome", "profile_instance_id", "request_id", "session_id", "timestamp",
    ]);
  }
}

async function waitForCondition(condition, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("condition timeout");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("MCP navigate waits for issued and completion audit around the real socket dispatch", async (t) => {
  const events = [];
  let releaseIssued;
  let releaseCompletion;
  const issuedGate = new Promise((resolve) => { releaseIssued = resolve; });
  const completionGate = new Promise((resolve) => { releaseCompletion = resolve; });
  const logger = {
    async write(event) {
      events.push(event);
      if (event.outcome === "issued") await issuedGate;
      if (event.outcome === "success") await completionGate;
    },
    async close() {},
  };
  const fixture = await serverFixture({ auditLogger: logger });
  t.after(async () => {
    await fixture.server.close();
    await rm(fixture.runtimeRoot, { recursive: true, force: true });
  });
  await fixture.server.listen();
  const host = await activeClient(fixture.descriptor);
  t.after(() => host.socket.destroy());
  const client = mcpClient(fixture.server, () => "core-navigate");
  t.after(() => client.close());
  await initialize(client);

  client.send(toolRequest(100, "navigate", { tab_id: 7, url: "https://url-secret.test/private" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.map((event) => event.outcome), ["issued"]);
  assert.equal(host.hasMessage(), false);
  releaseIssued();
  const request = await host.next();
  assert.equal(request.type, "navigate_request");
  assert.equal(request.request_id, "core-navigate");
  assert.doesNotMatch(JSON.stringify(request), /mcp-request/u);
  host.socket.write(encodeNativeMessage(navigateResponse(fixture, request.request_id)));
  await waitForCondition(() => events.length === 2);
  assert.deepEqual(events.map((event) => event.outcome), ["issued", "success"]);
  const responseBeforeAudit = await Promise.race([
    client.next(30).then(() => "response", () => "pending"),
    new Promise((resolve) => setTimeout(() => resolve("pending"), 40)),
  ]);
  assert.equal(responseBeforeAudit, "pending");
  releaseCompletion();
  const response = await client.next();
  assert.deepEqual(JSON.parse(response.result.content[0].text), { tab_id: 7, accepted: true });
  assert.doesNotMatch(JSON.stringify(response), FORBIDDEN_OUTPUT);
  assertAuditEvents(events, ["issued", "success"]);
});

test("MCP browser_status reentrant response completes real audit before result", async (t) => {
  const fixture = await serverFixture({ auditLogger: "real" });
  t.after(async () => {
    await fixture.server.close();
    await fixture.auditLogger.close().catch(() => {});
    await rm(fixture.runtimeRoot, { recursive: true, force: true });
  });
  await fixture.server.listen();
  const host = await activeClient(fixture.descriptor);
  t.after(() => host.socket.destroy());
  const client = mcpClient(fixture.server, () => "core-status");
  t.after(() => client.close());
  await initialize(client);
  const originalWrite = net.Socket.prototype.write;
  let injected = false;
  net.Socket.prototype.write = function reentrantWrite(chunk, ...args) {
    if (!injected && Buffer.isBuffer(chunk)) {
      const outgoing = new NativeMessageDecoder({ maxBytes: 64 * 1024 }).push(chunk)[0];
      if (outgoing?.type === "browser_status_request") {
        injected = true;
        this.emit("data", encodeNativeMessage(message(fixture.descriptor, "browser_status_response", "connection-a", {
          request_id: outgoing.request_id,
          status: { extension_connected: true, chrome_tabs_available: true },
        })));
      }
    }
    return Reflect.apply(originalWrite, this, [chunk, ...args]);
  };
  try {
    client.send(toolRequest(101, "browser_status", {}));
    const response = await client.next();
    assert.equal(injected, true);
    assert.deepEqual(JSON.parse(response.result.content[0].text), {
      status: { extension_connected: true, chrome_tabs_available: true },
    });
  } finally {
    net.Socket.prototype.write = originalWrite;
  }
  await fixture.auditLogger.close();
  const lines = (await readFile(pairingAuditFilePath(fixture.paths, fixture.descriptor.generation), "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
  assertAuditEvents(lines, ["issued", "success"]);
});

test("MCP audit preflight failure dispatches no browser request and returns fixed error", async (t) => {
  const logger = { async write() { throw Object.assign(new Error("raw audit path"), { code: AUDIT_ERROR_CODE }); }, async close() {} };
  const fixture = await serverFixture({ auditLogger: logger });
  t.after(async () => {
    await fixture.server.close();
    await rm(fixture.runtimeRoot, { recursive: true, force: true });
  });
  await fixture.server.listen();
  const host = await activeClient(fixture.descriptor);
  t.after(() => host.socket.destroy());
  const client = mcpClient(fixture.server, () => "core-preflight");
  t.after(() => client.close());
  await initialize(client);
  client.send(toolRequest(102, "navigate", { tab_id: 7, url: "https://url-secret.test/" }));
  const response = await client.next();
  assert.equal(response.result.isError, true);
  assert.deepEqual(response.result.content, [{ type: "text", text: AUDIT_ERROR_CODE }]);
  assert.equal(host.hasMessage(), false);
  assert.equal(fixture.server.state.pendingBrowserRequests.length, 0);
  assert.doesNotMatch(JSON.stringify(response), FORBIDDEN_OUTPUT);
});

test("MCP completion audit failures map reads and mutations without exposing request data", async (t) => {
  const events = [];
  const logger = {
    async write(event) {
      events.push(event);
      if (event.outcome !== "issued") throw Object.assign(new Error("raw completion path"), { code: AUDIT_ERROR_CODE });
    },
    async close() {},
  };
  const fixture = await serverFixture({ auditLogger: logger });
  t.after(async () => {
    await fixture.server.close();
    await rm(fixture.runtimeRoot, { recursive: true, force: true });
  });
  await fixture.server.listen();
  const host = await activeClient(fixture.descriptor);
  t.after(() => host.socket.destroy());
  const client = mcpClient(fixture.server, () => `core-${events.length}`);
  t.after(() => client.close());
  await initialize(client);

  const readRequests = [
    ["browser_status", {}, "browser_status_response", { status: { extension_connected: true, chrome_tabs_available: true } }],
    ["tabs_list", {}, "tabs_list_response", { tabs: [] }],
    ["snapshot", { tab_id: 7 }, "snapshot_response", {
      tab_id: 7,
      document: { loader_id: "loader-safe" },
      nodes: [{
        ref: 1, parent_ref: null, backend_dom_node_id: null, role: "RootWebArea", name: "Example", value: null,
        state: { disabled: false, expanded: false, focused: false, hidden: false },
      }],
      truncated: false,
      partial: false,
    }],
  ];
  for (const [index, [name, args, responseType, responseFields]] of readRequests.entries()) {
    client.send(toolRequest(110 + index, name, args));
    const request = await host.next();
    host.socket.write(encodeNativeMessage(message(fixture.descriptor, responseType, "connection-a", {
      request_id: request.request_id,
      ...responseFields,
    })));
    const response = await client.next();
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.content, [{ type: "text", text: AUDIT_ERROR_CODE }]);
    assert.doesNotMatch(JSON.stringify(response), FORBIDDEN_OUTPUT);
  }

  const mutationRequests = [
    ["navigate", { tab_id: 7, url: "https://url-secret.test/" }, "navigate_response", { tab_id: 7 }],
    ["click", { tab_id: 7, loader_id: "loader-safe", backend_dom_node_id: 42 }, "click_response", {
      tab_id: 7, loader_id: "loader-safe", backend_dom_node_id: 42, accepted: true,
    }],
    ["type", { tab_id: 7, loader_id: "loader-safe", backend_dom_node_id: 42, text: "storage-secret" }, "type_response", {
      tab_id: 7, loader_id: "loader-safe", backend_dom_node_id: 42, accepted: true,
    }],
  ];
  for (const [index, [name, args, responseType, responseFields]] of mutationRequests.entries()) {
    client.send(toolRequest(120 + index, name, args));
    const request = await host.next();
    host.socket.write(encodeNativeMessage(message(fixture.descriptor, responseType, "connection-a", {
      request_id: request.request_id,
      ...responseFields,
    })));
    const response = await client.next();
    assert.equal(response.result.isError, true);
    assert.deepEqual(response.result.content, [{ type: "text", text: "outcome_unknown" }]);
    assert.doesNotMatch(JSON.stringify(response), FORBIDDEN_OUTPUT);
  }
  assertAuditEvents(events, ["issued", "success", "issued", "success", "issued", "success", "issued", "success", "issued", "success", "issued", "success"]);
});

test("MCP real audit files stay private and isolated across A/B instances", async (t) => {
  const a = await serverFixture({ instanceId: "poc-a", suffix: "333333333333", auditLogger: "real" });
  const b = await serverFixture({ instanceId: "poc-b", suffix: "444444444444", auditLogger: "real" });
  t.after(async () => {
    await Promise.all([a.server.close(), b.server.close()]);
    await Promise.all([a.auditLogger.close().catch(() => {}), b.auditLogger.close().catch(() => {})]);
    await Promise.all([rm(a.runtimeRoot, { recursive: true, force: true }), rm(b.runtimeRoot, { recursive: true, force: true })]);
  });
  await Promise.all([a.server.listen(), b.server.listen()]);
  const aHost = await activeClient(a.descriptor);
  const bHost = await activeClient(b.descriptor);
  t.after(() => { aHost.socket.destroy(); bHost.socket.destroy(); });
  const aMcp = mcpClient(a.server, () => "core-a-status");
  const bMcp = mcpClient(b.server, () => "core-b-status");
  t.after(() => Promise.all([aMcp.close(), bMcp.close()]));
  await Promise.all([initialize(aMcp), initialize(bMcp)]);
  aMcp.send(toolRequest(130, "browser_status", {}));
  bMcp.send(toolRequest(230, "browser_status", {}));
  const [aRequest, bRequest] = await Promise.all([aHost.next(), bHost.next()]);
  assert.notEqual(aRequest.request_id, bRequest.request_id);
  aHost.socket.write(encodeNativeMessage(message(a.descriptor, "browser_status_response", "connection-a", {
    request_id: aRequest.request_id,
    status: { extension_connected: true, chrome_tabs_available: true },
  })));
  bHost.socket.write(encodeNativeMessage(message(b.descriptor, "browser_status_response", "connection-a", {
    request_id: bRequest.request_id,
    status: { extension_connected: false, chrome_tabs_available: true },
  })));
  const [aResponse, bResponse] = await Promise.all([aMcp.next(), bMcp.next()]);
  assert.equal(JSON.parse(aResponse.result.content[0].text).status.extension_connected, true);
  assert.equal(JSON.parse(bResponse.result.content[0].text).status.extension_connected, false);
  await Promise.all([a.server.close(), b.server.close(), a.auditLogger.close(), b.auditLogger.close()]);
  for (const fixture of [a, b]) {
    const filePath = pairingAuditFilePath(fixture.paths, fixture.descriptor.generation);
    const fileInfo = await stat(filePath);
    assert.equal(fileInfo.mode & 0o777, 0o600);
    assert.equal(fileInfo.nlink, 1);
    const instanceInfo = await stat(fixture.paths.instanceDir);
    assert.equal(instanceInfo.mode & 0o777, 0o700);
    const socketDirectoryInfo = await stat(fixture.paths.socketDirectory);
    assert.equal(socketDirectoryInfo.mode & 0o777, 0o700);
    const lines = (await readFile(filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assertAuditEvents(lines, ["issued", "success"]);
    assert.equal(lines[0].browser_instance_id, fixture.descriptor.browser_instance_id);
  }
});
