import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { encodeNativeMessage, NativeMessageDecoder } from "../native-host/codec.mjs";
import { resolvePairingPaths } from "../core/pairing-descriptor.mjs";
import { MCP_SERVER_ERROR_CODES, runMcpServer } from "../scripts/mcp-server.mjs";

const SERVER_PATH = path.resolve(import.meta.dirname, "../scripts/mcp-server.mjs");
const LEGACY_PROTOCOL_VERSION = "2025-03-26";

async function temporaryRuntimeRoot(prefix = "bsp-mcp-lifecycle-") {
  return mkdtemp(path.join("/private/tmp", prefix));
}

function spawnServer(runtimeRoot, instanceId) {
  const child = spawn(process.execPath, [SERVER_PATH, "--instance-id", instanceId], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, BROWSER_POC_RUNTIME_ROOT: runtimeRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.setDefaultEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let output = "";
  let diagnostics = "";
  const messages = [];
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    output += chunk;
    while (output.includes("\n")) {
      const newline = output.indexOf("\n");
      const line = output.slice(0, newline);
      output = output.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { message = { parse_error: true }; }
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(message);
      else messages.push(message);
    }
  });
  child.stderr.on("data", (chunk) => { diagnostics += chunk; });
  child.once("error", (error) => { for (const waiter of waiters.splice(0)) waiter.reject(error); });
  const nextMessage = (timeoutMs = 5_000) => new Promise((resolve, reject) => {
    if (messages.length > 0) {
      resolve(messages.shift());
      return;
    }
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error("MCP lifecycle response timeout"));
    }, timeoutMs);
    const waiter = {
      resolve: (message) => { clearTimeout(timer); resolve(message); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    };
    waiters.push(waiter);
  });
  const waitForClose = (timeoutMs = 5_000) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    }
    return new Promise((resolve, reject) => {
      let timer;
      const onClose = (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      };
      timer = setTimeout(() => {
        child.removeListener("close", onClose);
        reject(new Error("MCP lifecycle process did not close within the bound"));
      }, timeoutMs);
      child.once("close", onClose);
    });
  };
  return {
    child,
    diagnostics: () => diagnostics,
    output: () => output,
    send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
    nextMessage,
    waitForClose,
    closeInput() {
      const close = waitForClose();
      child.stdin.end();
      return close;
    },
  };
}

function initializeRequest(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "browser-session-poc-g5-4-test", version: "0.0.0" },
    },
  };
}

async function initializeServer(server) {
  server.send(initializeRequest());
  const initialized = await server.nextMessage();
  assert.equal(initialized.result.protocolVersion, LEGACY_PROTOCOL_VERSION);
  server.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  server.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = await server.nextMessage();
  assert.deepEqual(tools.result.tools.map(({ name }) => name), [
    "browser_status", "tabs_list", "navigate", "snapshot", "click", "type",
  ]);
}

function identityMessage(descriptor, connectionId) {
  return {
    protocol_version: 1,
    session_id: descriptor.session_id,
    browser_instance_id: descriptor.browser_instance_id,
    profile_instance_id: descriptor.profile_instance_id,
    generation: descriptor.generation,
    lease_id: descriptor.lease_id,
    host_connection_id: connectionId,
  };
}

async function activeHost(descriptor, connectionId = "connection-a") {
  const socket = net.createConnection(descriptor.socket_path);
  await once(socket, "connect");
  socket.on("error", () => {});
  const decoder = new NativeMessageDecoder({ maxBytes: 64 * 1024 });
  const messages = [];
  const waiters = [];
  socket.on("data", (chunk) => {
    for (const message of decoder.push(chunk)) messages.push(message);
    while (messages.length > 0 && waiters.length > 0) waiters.shift()(messages.shift());
  });
  const next = (timeoutMs = 5_000) => {
    if (messages.length > 0) return Promise.resolve(messages.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("MCP lifecycle host response timeout"));
      }, timeoutMs);
      const waiter = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
      waiters.push(waiter);
    });
  };
  socket.write(encodeNativeMessage({
    type: "host_register",
    ...identityMessage(descriptor, connectionId),
    pairing_nonce: descriptor.pairing_nonce,
  }));
  assert.equal((await next()).type, "pair_challenge");
  socket.write(encodeNativeMessage({ type: "pair_ack", ...identityMessage(descriptor, connectionId) }));
  assert.equal((await next()).type, "pair_active");
  return { socket, next, close: () => new Promise((resolve) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    socket.once("close", resolve);
    socket.destroy();
  }) };
}

async function descriptorFor(runtimeRoot, instanceId) {
  const paths = resolvePairingPaths({ runtimeRoot, instanceId });
  return JSON.parse(await readFile(paths.activeDescriptorPath, "utf8"));
}

function toolCall(id, name, argumentsValue = {}) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: argumentsValue } };
}

async function assertCleanedUp(runtimeRoot, instanceId) {
  const paths = resolvePairingPaths({ runtimeRoot, instanceId });
  await assert.rejects(() => readFile(paths.activeDescriptorPath), { code: "ENOENT" });
  await assert.rejects(() => readFile(path.join(runtimeRoot, "pairing-claims", `${instanceId}.claim`)), { code: "ENOENT" });
  await assert.deepEqual(await readdir(paths.socketDirectory), []);
}

test("MCP transport failure reports a fixed diagnostic and closes the harness", async () => {
  const input = new EventEmitter();
  input.pause = () => {};
  const signalSource = new EventEmitter();
  let diagnostics = "";
  let harnessCloseCount = 0;
  let handleCloseCount = 0;
  const result = await runMcpServer({
    argumentsList: ["--instance-id", "poc-a"],
    environment: { BROWSER_POC_RUNTIME_ROOT: "/private/tmp/g5-4-transport" },
    input,
    output: { write: () => true },
    errorOutput: { write: (chunk) => { diagnostics += chunk; } },
    signalSource,
    startHarness: async () => ({
      server: {},
      close: async () => { harnessCloseCount += 1; },
    }),
    serve: (_createServer, options) => {
      options.onerror(new Error("raw stdout transport failure"));
      return { close: async () => { handleCloseCount += 1; } };
    },
  });
  assert.equal(result, 1);
  assert.equal(diagnostics, `${MCP_SERVER_ERROR_CODES.TRANSPORT_FAILED}\n`);
  assert.equal(harnessCloseCount, 1);
  assert.equal(handleCloseCount, 1);
  assert.doesNotMatch(diagnostics, /raw stdout transport failure|private\/tmp/u);
});

test("MCP transport closure settles pending read and mutation without retry", async (t) => {
  const runtimeRoot = await temporaryRuntimeRoot();
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const server = spawnServer(runtimeRoot, "poc-a");
  await initializeServer(server);
  const descriptor = await descriptorFor(runtimeRoot, "poc-a");
  const host = await activeHost(descriptor);
  t.after(() => host.close());

  server.send(toolCall(10, "browser_status"));
  const readRequest = await host.next();
  assert.equal(readRequest.type, "browser_status_request");
  server.send(toolCall(11, "navigate", { tab_id: 7, url: "https://url-secret.test/private" }));
  const mutationRequest = await host.next();
  assert.equal(mutationRequest.type, "navigate_request");
  await host.close();

  const responses = await Promise.all([server.nextMessage(), server.nextMessage()]);
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.deepEqual(byId.get(10).result.content, [{ type: "text", text: "transport_closed" }]);
  assert.deepEqual(byId.get(11).result.content, [{ type: "text", text: "outcome_unknown" }]);
  assert.doesNotMatch(JSON.stringify(responses), /url-secret|private|navigate_request|browser_status_request/u);
  assert.equal(host.socket.destroyed, true);

  const close = server.closeInput();
  const result = await close;
  assert.deepEqual(result, { code: 0, signal: null });
  await assertCleanedUp(runtimeRoot, "poc-a");
});

test("A forced child termination is recovered by a new generation while B stays active", async (t) => {
  const runtimeRoot = await temporaryRuntimeRoot();
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const serverA = spawnServer(runtimeRoot, "poc-a");
  const serverB = spawnServer(runtimeRoot, "poc-b");
  const hosts = [];
  let serverARestarted = null;
  try {
    await Promise.all([initializeServer(serverA), initializeServer(serverB)]);
    const [descriptorA, descriptorB] = await Promise.all([
      descriptorFor(runtimeRoot, "poc-a"),
      descriptorFor(runtimeRoot, "poc-b"),
    ]);
    const [hostA, hostB] = await Promise.all([activeHost(descriptorA), activeHost(descriptorB)]);
    hosts.push(hostA, hostB);

    serverA.send(toolCall(20, "browser_status"));
    const oldRequest = await hostA.next();
    assert.equal(oldRequest.type, "browser_status_request");
    serverB.send(toolCall(21, "browser_status"));
    const bRequest = await hostB.next();
    assert.equal(bRequest.type, "browser_status_request");
    const oldAClosed = hostA.close();
    assert.equal(serverA.child.kill("SIGKILL"), true);
    const [aKilled, aHostClosed] = await Promise.all([serverA.waitForClose(), oldAClosed]);
    assert.deepEqual(aKilled, { code: null, signal: "SIGKILL" });
    assert.equal(aHostClosed, false);

    hostB.socket.write(encodeNativeMessage({
      type: "browser_status_response",
      ...identityMessage(descriptorB, "connection-a"),
      request_id: bRequest.request_id,
      status: { extension_connected: true, chrome_tabs_available: true },
    }));
    const bResponse = await serverB.nextMessage();
    assert.deepEqual(JSON.parse(bResponse.result.content[0].text), {
      status: { extension_connected: true, chrome_tabs_available: true },
    });

    // The claim identity uses the platform process start timestamp; wait for
    // its one-second resolution before intentionally starting a replacement.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    serverARestarted = spawnServer(runtimeRoot, "poc-a");
    const descriptorARestarted = await (async () => {
      await initializeServer(serverARestarted);
      return descriptorFor(runtimeRoot, "poc-a");
    })();
    assert.equal(descriptorARestarted.generation, descriptorA.generation + 1);
    assert.notEqual(descriptorARestarted.socket_path, descriptorA.socket_path);
    const hostARestarted = await activeHost(descriptorARestarted, "connection-b");
    hosts.push(hostARestarted);
    serverARestarted.send(toolCall(22, "browser_status"));
    const newRequest = await hostARestarted.next();
    assert.notEqual(newRequest.request_id, oldRequest.request_id);
    hostARestarted.socket.write(encodeNativeMessage({
      type: "browser_status_response",
      ...identityMessage(descriptorARestarted, "connection-b"),
      request_id: newRequest.request_id,
      status: { extension_connected: true, chrome_tabs_available: true },
    }));
    const newResponse = await serverARestarted.nextMessage();
    assert.deepEqual(JSON.parse(newResponse.result.content[0].text), {
      status: { extension_connected: true, chrome_tabs_available: true },
    });
    assert.equal(serverB.child.exitCode, null);
    assert.equal(serverB.child.signalCode, null);

    const closeA = serverARestarted.closeInput();
    const closeB = serverB.closeInput();
    const [resultA, resultB] = await Promise.all([closeA, closeB]);
    assert.deepEqual(resultA, { code: 0, signal: null });
    assert.deepEqual(resultB, { code: 0, signal: null });
  } finally {
    for (const host of hosts) await host.close().catch(() => {});
    if (serverA.child.exitCode === null && serverA.child.signalCode === null) serverA.child.kill("SIGKILL");
    if (serverB.child.exitCode === null && serverB.child.signalCode === null) await serverB.closeInput().catch(() => {});
    if (serverARestarted?.child.exitCode === null && serverARestarted.child.signalCode === null) {
      await serverARestarted.closeInput().catch(() => {});
    }
  }
  const aPaths = resolvePairingPaths({ runtimeRoot, instanceId: "poc-a" });
  const bPaths = resolvePairingPaths({ runtimeRoot, instanceId: "poc-b" });
  assert.deepEqual(await readdir(aPaths.instanceDir).then((names) => names.filter((name) => /^audit-\d+\.jsonl$/u.test(name)).sort()), ["audit-1.jsonl", "audit-2.jsonl"]);
  assert.deepEqual(await readdir(bPaths.instanceDir).then((names) => names.filter((name) => /^audit-\d+\.jsonl$/u.test(name)).sort()), ["audit-1.jsonl"]);
  await assertCleanedUp(runtimeRoot, "poc-a");
  await assertCleanedUp(runtimeRoot, "poc-b");
});
