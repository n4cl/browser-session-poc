import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { resolvePairingPaths } from "../core/pairing-descriptor.mjs";
import {
  MCP_SERVER_ERROR_CODES,
  parseMcpServerArguments,
  resolveMcpServerRuntimeRoot,
  runMcpServer,
} from "../scripts/mcp-server.mjs";

const SERVER_PATH = path.resolve(import.meta.dirname, "../scripts/mcp-server.mjs");
const LEGACY_PROTOCOL_VERSION = "2025-03-26";

async function temporaryRuntimeRoot(prefix = "bsp-mcp-server-") {
  return mkdtemp(path.join("/private/tmp", prefix));
}

function spawnServer(runtimeRoot, instanceId, argumentsList = ["--instance-id", instanceId]) {
  const child = spawn(process.execPath, [SERVER_PATH, ...argumentsList], {
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
      if (line.length === 0) continue;
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
      reject(new Error("MCP server response timeout"));
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
        reject(new Error("MCP server did not close within the bound"));
      }, timeoutMs);
      child.once("close", onClose);
    });
  };
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  let closePromise;
  const closeInput = () => {
    if (!closePromise) {
      const wait = waitForClose();
      child.stdin.end();
      closePromise = wait.then((result) => ({ ...result, diagnostics }));
    }
    return closePromise;
  };
  return {
    child,
    diagnostics: () => diagnostics,
    output: () => output,
    send,
    nextMessage,
    waitForClose,
    closeInput,
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
      clientInfo: { name: "browser-session-poc-g5-1-test", version: "0.0.0" },
    },
  };
}

async function initializeAndHealth(server) {
  server.send(initializeRequest());
  const initialized = await server.nextMessage();
  assert.equal(initialized.result.protocolVersion, LEGACY_PROTOCOL_VERSION);
  assert.deepEqual(initialized.result.serverInfo, { name: "browser-session-poc", version: "0.0.0" });
  server.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  server.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = await server.nextMessage();
  assert.deepEqual(tools.result.tools.map(({ name }) => name), ["health"]);
  server.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "health", arguments: {} } });
  const health = await server.nextMessage();
  assert.deepEqual(health.result, { content: [{ type: "text", text: "ok" }] });
}

async function assertCleanedUp(runtimeRoot, instanceId) {
  const paths = resolvePairingPaths({ runtimeRoot, instanceId });
  await assert.rejects(() => readFile(paths.activeDescriptorPath), { code: "ENOENT" });
  await assert.rejects(() => readFile(path.join(runtimeRoot, "pairing-claims", `${instanceId}.claim`)), { code: "ENOENT" });
  assert.deepEqual(await readdir(paths.socketDirectory), []);
  const auditFiles = (await readdir(paths.instanceDir)).filter((name) => /^audit-\d+\.jsonl$/u.test(name));
  assert.equal(auditFiles.length, 1);
  assert.equal(await readFile(path.join(paths.instanceDir, auditFiles[0]), "utf8"), "");
}

test("MCP server parser accepts only one explicit safe instance and resolves the existing runtime root", () => {
  assert.deepEqual(parseMcpServerArguments(["--instance-id", "poc-a"]), { instanceId: "poc-a" });
  assert.equal(resolveMcpServerRuntimeRoot({ BROWSER_POC_RUNTIME_ROOT: "/private/tmp/g5-1-runtime" }), "/private/tmp/g5-1-runtime");
  for (const argumentsList of [
    [],
    ["poc-a"],
    ["--instance-id"],
    ["--instance-id", "poc-a", "extra"],
    ["--instance-id", "../outside"],
    ["--instance-id", "poc a"],
  ]) {
    assert.throws(() => parseMcpServerArguments(argumentsList), (error) => error.code === MCP_SERVER_ERROR_CODES.INVALID_ARGUMENTS);
  }
  assert.throws(
    () => resolveMcpServerRuntimeRoot({ BROWSER_POC_RUNTIME_ROOT: "\u0000" }),
    (error) => error.code === MCP_SERVER_ERROR_CODES.INVALID_ARGUMENTS,
  );
});

test("MCP CLI reports invalid arguments without startup detail", async (t) => {
  for (const argumentsList of [
    ["--instance-id", "poc-a", "extra"],
    ["--instance-id", "../outside"],
  ]) {
    const runtimeRoot = await temporaryRuntimeRoot("bsp-mcp-invalid-");
    t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
    const server = spawnServer(runtimeRoot, "poc-a", argumentsList);
    const result = await server.waitForClose();
    assert.deepEqual(result, { code: 1, signal: null });
    assert.equal(server.output(), "");
    assert.equal(server.diagnostics(), `${MCP_SERVER_ERROR_CODES.INVALID_ARGUMENTS}\n`);
  }

  const input = new EventEmitter();
  input.pause = () => {};
  const signalSource = new EventEmitter();
  let diagnostics = "";
  const result = await runMcpServer({
    argumentsList: ["--instance-id", "poc-a"],
    environment: { BROWSER_POC_RUNTIME_ROOT: "\u0000" },
    input,
    output: { write: () => true },
    errorOutput: { write: (chunk) => { diagnostics += chunk; } },
    signalSource,
    startHarness: async () => { throw new Error("must not start"); },
  });
  assert.equal(result, 1);
  assert.equal(diagnostics, `${MCP_SERVER_ERROR_CODES.INVALID_ARGUMENTS}\n`);
});

for (const shutdownEvent of ["end", "SIGTERM"]) {
  test(`MCP server closes a startup shutdown request before serving (${shutdownEvent})`, async () => {
    const input = new EventEmitter();
    input.pause = () => {};
    const signalSource = new EventEmitter();
    const output = { write: () => true };
    let diagnostics = "";
    let startEntered;
    const startEnteredPromise = new Promise((resolve) => { startEntered = resolve; });
    let releaseStart;
    const startRelease = new Promise((resolve) => { releaseStart = resolve; });
    let closeCount = 0;
    let serveCount = 0;
    const running = runMcpServer({
      argumentsList: ["--instance-id", "poc-a"],
      environment: { BROWSER_POC_RUNTIME_ROOT: "/private/tmp/g5-1-startup-shutdown" },
      input,
      output,
      errorOutput: { write: (chunk) => { diagnostics += chunk; } },
      signalSource,
      startHarness: async () => {
        startEntered();
        await startRelease;
        return { close: async () => { closeCount += 1; } };
      },
      serve: () => {
        serveCount += 1;
        throw new Error("serve must not be called after startup shutdown");
      },
    });
    await startEnteredPromise;
    if (shutdownEvent === "end") {
      input.emit("end");
      input.emit("end");
    } else {
      signalSource.emit(shutdownEvent);
    }
    releaseStart();
    assert.equal(await running, 0);
    assert.equal(closeCount, 1);
    assert.equal(serveCount, 0);
    assert.equal(diagnostics, "");
  });
}

test("MCP server owns one harness, closes on EOF, and removes descriptor claim and socket", async (t) => {
  const runtimeRoot = await temporaryRuntimeRoot();
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const server = spawnServer(runtimeRoot, "poc-a");
  await initializeAndHealth(server);
  const firstClose = server.closeInput();
  const secondClose = server.closeInput();
  assert.equal(firstClose, secondClose);
  const result = await firstClose;
  assert.deepEqual(result, { code: 0, signal: null, diagnostics: "" });
  assert.equal(server.output(), "");
  await assertCleanedUp(runtimeRoot, "poc-a");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`MCP server closes once on ${signal} with fixed diagnostics`, async (t) => {
    const runtimeRoot = await temporaryRuntimeRoot();
    t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
    const server = spawnServer(runtimeRoot, "poc-a");
    await initializeAndHealth(server);
    const close = server.waitForClose();
    assert.equal(server.child.kill(signal), true);
    const result = await close;
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(server.diagnostics(), "");
    await assertCleanedUp(runtimeRoot, "poc-a");
  });
}

test("MCP server startup failure rolls back the claim and emits no path or raw error", async (t) => {
  const runtimeRoot = await temporaryRuntimeRoot();
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  await writeFile(path.join(runtimeRoot, "profiles"), "not a directory\n", { mode: 0o600 });
  const server = spawnServer(runtimeRoot, "poc-a");
  const close = server.waitForClose();
  const result = await close;
  assert.deepEqual(result, { code: 1, signal: null });
  assert.equal(server.output(), "");
  assert.equal(server.diagnostics(), "mcp_startup_failed\n");
  await assert.rejects(() => readFile(path.join(runtimeRoot, "pairing-claims", "poc-a.claim")), { code: "ENOENT" });
});

test("separate A/B server processes keep health available after A stops", async (t) => {
  const runtimeRoot = await temporaryRuntimeRoot();
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const [serverA, serverB] = [spawnServer(runtimeRoot, "poc-a"), spawnServer(runtimeRoot, "poc-b")];
  try {
    await Promise.all([initializeAndHealth(serverA), initializeAndHealth(serverB)]);
    const closeA = serverA.closeInput();
    const healthAfterAStop = (async () => {
      serverB.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "health", arguments: {} } });
      return serverB.nextMessage();
    })();
    const [resultA, health] = await Promise.all([closeA, healthAfterAStop]);
    assert.deepEqual(resultA, { code: 0, signal: null, diagnostics: "" });
    assert.deepEqual(health.result, { content: [{ type: "text", text: "ok" }] });
  } finally {
    if (serverB.child.exitCode === null && serverB.child.signalCode === null) await serverB.closeInput();
    if (serverA.child.exitCode === null && serverA.child.signalCode === null) await serverA.closeInput();
  }
  await assertCleanedUp(runtimeRoot, "poc-a");
  await assertCleanedUp(runtimeRoot, "poc-b");
});
