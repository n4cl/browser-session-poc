#!/usr/bin/env node

/*
 * PoC/test-only deterministic Gate 5 acceptance driver.
 *
 * This file intentionally does not use a model to generate MCP arguments and
 * must not be reused as a production browser-control API. It owns exactly one
 * MCP stdio child for exactly one browser instance. Run two processes for A/B.
 * stdout is one sanitized JSON summary; stderr contains fixed diagnostics only.
 */

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { validateInstanceId } from "../core/chrome-instance.mjs";

export const DRIVER_TOOL_NAMES = Object.freeze([
  "browser_status",
  "tabs_list",
  "navigate",
  "snapshot",
  "click",
  "type",
]);
export const DRIVER_PROTOCOL_VERSION = "2025-03-26";
export const DRIVER_MAX_MESSAGE_BYTES = 64 * 1024;
export const DRIVER_REQUEST_TIMEOUT_MS = 8_000;
export const DRIVER_SNAPSHOT_ATTEMPTS = 4;
export const DRIVER_SNAPSHOT_DELAY_MS = 150;
export const DRIVER_FIXTURE_START_TIMEOUT_MS = 5_000;
export const DRIVER_CHILD_CLOSE_TIMEOUT_MS = 2_000;

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const serverPath = path.join(repositoryRoot, "scripts", "mcp-server.mjs");
const fixturePath = path.join(repositoryRoot, "scripts", "gate4-fixture.mjs");
const LOOPBACK_HOST = "127.0.0.1";
const MARKER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const READ_ONLY_SNAPSHOT_RETRY_CODES = new Set([
  "debugger_unavailable",
  "tab_not_found",
  "debugger_busy",
  "debugger_attach_failed",
  "snapshot_failed",
  "debugger_detach_failed",
  "tabs_unavailable",
  "timeout",
  "transport_closed",
  "protocol_timeout",
]);
const FIXED_TOOL_ERROR_CODES = new Set([
  "debugger_unavailable",
  "tab_not_found",
  "debugger_busy",
  "debugger_attach_failed",
  "snapshot_failed",
  "debugger_detach_failed",
  "stale_document",
  "node_not_found",
  "not_interactable",
  "click_failed",
  "not_editable",
  "type_failed",
  "response_too_large",
  "tabs_unavailable",
  "navigation_failed",
  "outcome_unknown",
  "timeout",
  "transport_closed",
  "audit_unavailable",
]);

const HELP = [
  "Gate 5 deterministic acceptance driver (PoC/test-only; not a production API).",
  "One invocation owns one MCP stdio server and one browser instance. Run A/B as two processes.",
  "Usage:",
  "  node scripts/gate5-acceptance-driver.mjs --instance-id <id> --fixture-origin <http://127.0.0.1:port> --marker <marker> --other-marker <marker> --suffix <suffix>",
  "  node scripts/gate5-acceptance-driver.mjs --instance-id <id> --start-fixture --marker <marker> --other-marker <marker> --suffix <suffix>",
  "The driver performs initialize/initialized/tools/list and the fixed browser sequence.",
  "Mutation commands are never retried; only bounded read-only snapshots may retry.",
].join("\n") + "\n";

class DriverFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "DriverFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new DriverFailure(code);
}

function fixedCode(value, fallback = "driver_failed") {
  if (value instanceof DriverFailure) return value.code;
  return typeof value?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value.code)
    ? value.code
    : fallback;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function safeMarker(value) {
  return typeof value === "string" && MARKER_PATTERN.test(value);
}

function validateFixtureOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000-\u001F\u007F\s]/u.test(value)) {
    fail("invalid_arguments");
  }
  let parsed;
  try { parsed = new URL(value); } catch { fail("invalid_arguments"); }
  if (parsed.protocol !== "http:" || parsed.hostname !== LOOPBACK_HOST || parsed.username || parsed.password ||
    parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.port === "") {
    fail("invalid_arguments");
  }
  return parsed.origin;
}

export function parseDriverArguments(argv) {
  if (!Array.isArray(argv)) fail("invalid_arguments");
  if (argv.length === 1 && argv[0] === "--help") return Object.freeze({ help: true });
  const values = new Map();
  let startFixture = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--start-fixture") {
      if (startFixture) fail("invalid_arguments");
      startFixture = true;
      continue;
    }
    if (!argument.startsWith("--") || index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      fail("invalid_arguments");
    }
    if (!["--instance-id", "--fixture-origin", "--marker", "--other-marker", "--suffix"].includes(argument) || values.has(argument)) {
      fail("invalid_arguments");
    }
    values.set(argument, argv[index + 1]);
    index += 1;
  }
  const instanceId = values.get("--instance-id");
  try { validateInstanceId(instanceId); } catch { fail("invalid_arguments"); }
  const marker = values.get("--marker");
  const otherMarker = values.get("--other-marker");
  const suffix = values.get("--suffix");
  if (!safeMarker(marker) || !safeMarker(otherMarker) || !safeMarker(suffix) || marker === otherMarker || marker === suffix || otherMarker === suffix) {
    fail("invalid_arguments");
  }
  const originValue = values.get("--fixture-origin");
  if (startFixture === (originValue !== undefined)) fail("invalid_arguments");
  return Object.freeze({
    help: false,
    instanceId,
    fixtureOrigin: originValue === undefined ? null : validateFixtureOrigin(originValue),
    startFixture,
    marker,
    otherMarker,
    suffix,
    runtimeRoot: path.resolve(process.env.BROWSER_POC_RUNTIME_ROOT ?? path.join(repositoryRoot, ".runtime")),
  });
}

function createSummary(stats, overrides = {}) {
  return {
    result: "FAIL",
    tools_exact: Boolean(stats.toolsExact),
    protocol_counts: {
      initialize: stats.protocolCounts.initialize,
      initialized: stats.protocolCounts.initialized,
      tools_list: stats.protocolCounts.toolsList,
    },
    tool_counts: { ...stats.toolCounts },
    snapshot_attempts: stats.snapshotAttempts,
    fixture_h1_present: false,
    cookie_localstorage_match: false,
    own_marker_match: false,
    other_marker_absent: false,
    correlation_ok: false,
    fixed_error: stats.fixedError ?? "not_run",
    ...overrides,
  };
}

function newStats() {
  return {
    toolsExact: false,
    protocolCounts: { initialize: 0, initialized: 0, toolsList: 0 },
    toolCounts: Object.fromEntries(DRIVER_TOOL_NAMES.map((name) => [name, 0])),
    snapshotAttempts: 0,
    fixedError: null,
  };
}

function sanitizeToolErrorCode(value) {
  if (typeof value !== "string") return "tool_error";
  return FIXED_TOOL_ERROR_CODES.has(value) ? value : "tool_error";
}

function parseJsonLine(line) {
  if (typeof line !== "string" || line.length === 0 || Buffer.byteLength(line, "utf8") > DRIVER_MAX_MESSAGE_BYTES) {
    fail("protocol_oversize");
  }
  let message;
  try { message = JSON.parse(line); } catch { fail("protocol_invalid"); }
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
    fail("protocol_invalid");
  }
  return message;
}

/** Minimal newline-delimited JSON-RPC client used only by this PoC/test driver. */
export class StdioJsonRpcClient {
  #child;
  #buffer = "";
  #nextId = 1;
  #pending = new Map();
  #fatal = null;

  constructor(child, { timeoutMs = DRIVER_REQUEST_TIMEOUT_MS } = {}) {
    if (!child?.stdin || !child?.stdout) throw new TypeError("child stdio is required");
    this.#child = child;
    this.timeoutMs = timeoutMs;
    child.stdout.setEncoding?.("utf8");
    child.stderr?.setEncoding?.("utf8");
    child.stdout.on("data", (chunk) => this.#consume(String(chunk)));
    child.stderr?.on("data", () => {});
    child.once("error", () => this.#failPending("transport_closed"));
    child.once("close", () => this.#failPending("transport_closed"));
  }

  #failPending(code) {
    if (!this.#fatal) this.#fatal = new DriverFailure(code);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.#fatal);
    }
    this.#pending.clear();
  }

  #consume(chunk) {
    if (this.#fatal) return;
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > DRIVER_MAX_MESSAGE_BYTES) {
      this.#failPending("protocol_oversize");
      return;
    }
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length === 0) continue;
      let message;
      try { message = parseJsonLine(line); } catch (error) {
        this.#failPending(fixedCode(error, "protocol_invalid"));
        return;
      }
      if (!("id" in message)) continue;
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    }
  }

  request(method, params = {}) {
    if (this.#fatal) return Promise.reject(this.#fatal);
    const id = this.#nextId;
    this.#nextId += 1;
    const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    if (Buffer.byteLength(message, "utf8") + 1 > DRIVER_MAX_MESSAGE_BYTES) return Promise.reject(new DriverFailure("protocol_oversize"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new DriverFailure("protocol_timeout"));
      }, this.timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#child.stdin.write(`${message}\n`, (error) => {
          if (!error) return;
          const pending = this.#pending.get(id);
          if (!pending) return;
          this.#pending.delete(id);
          clearTimeout(timer);
          reject(new DriverFailure("transport_closed"));
        });
      } catch {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new DriverFailure("transport_closed"));
      }
    });
  }

  notify(method, params = {}) {
    if (this.#fatal) fail(this.#fatal.code);
    const message = JSON.stringify({ jsonrpc: "2.0", method, params });
    try { this.#child.stdin.write(`${message}\n`); } catch { fail("transport_closed"); }
  }

  endInput() {
    if (this.#child.stdin.destroyed || this.#child.stdin.writableEnded) return;
    try { this.#child.stdin.end(); } catch { /* cleanup is bounded by the caller */ }
  }
}

function spawnMcpServer({ instanceId, runtimeRoot }) {
  return spawn(process.execPath, [serverPath, "--instance-id", instanceId], {
    cwd: repositoryRoot,
    env: { ...process.env, BROWSER_POC_RUNTIME_ROOT: runtimeRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function waitForChildClose(child, timeoutMs = DRIVER_CHILD_CLOSE_TIMEOUT_MS) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = setTimeout(() => {
      child.removeListener("close", onClose);
      resolve(false);
    }, timeoutMs);
    function onClose() {
      clearTimeout(timer);
      resolve(true);
    }
    child.once("close", onClose);
  });
}

async function closeChildBounded(child) {
  if (!child) return true;
  if (!child.stdin.destroyed && !child.stdin.writableEnded) {
    try { child.stdin.end(); } catch { /* continue to bounded signal cleanup */ }
  }
  if (await waitForChildClose(child)) return true;
  try { child.kill("SIGTERM"); } catch { /* continue to SIGKILL bound */ }
  if (await waitForChildClose(child)) return true;
  try { child.kill("SIGKILL"); } catch { return false; }
  return await waitForChildClose(child, 1_000);
}

function consumeFixtureLine(state, chunk) {
  state.buffer += chunk;
  if (Buffer.byteLength(state.buffer, "utf8") > DRIVER_MAX_MESSAGE_BYTES) fail("fixture_start_failed");
  const newline = state.buffer.indexOf("\n");
  if (newline < 0) return null;
  const line = state.buffer.slice(0, newline);
  state.buffer = state.buffer.slice(newline + 1);
  const match = /^gate4-fixture ready (http:\/\/127\.0\.0\.1:\d+)\/$/u.exec(line);
  return match ? validateFixtureOrigin(`${match[1]}/`) : fail("fixture_start_failed");
}

async function startFixture() {
  const child = spawn(process.execPath, [fixturePath, "--port", "0"], {
    cwd: repositoryRoot,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding?.("utf8");
  child.stderr?.on("data", () => {});
  const state = { buffer: "" };
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DriverFailure("fixture_start_timeout")), DRIVER_FIXTURE_START_TIMEOUT_MS);
    const onData = (chunk) => {
      try {
        const value = consumeFixtureLine(state, String(chunk));
        if (value) {
          clearTimeout(timer);
          child.stdout.removeListener("data", onData);
          resolve(value);
        }
      } catch (error) {
        clearTimeout(timer);
        child.stdout.removeListener("data", onData);
        reject(error);
      }
    };
    child.stdout.on("data", onData);
    child.once("error", () => { clearTimeout(timer); reject(new DriverFailure("fixture_start_failed")); });
    child.once("close", () => { clearTimeout(timer); reject(new DriverFailure("fixture_start_failed")); });
  }).catch(async (error) => {
    await closeChildBounded(child);
    throw error;
  });
  return { child, origin };
}

function responseResult(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) fail("protocol_invalid");
  if (response.error) fail("jsonrpc_error");
  if (!("result" in response) || !response.result || typeof response.result !== "object") fail("protocol_invalid");
  return response.result;
}

function parseToolText(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) fail("tool_result_invalid");
  if (result.isError === true) {
    const text = Array.isArray(result.content) && result.content.length === 1 && result.content[0]?.type === "text"
      ? result.content[0].text
      : null;
    fail(sanitizeToolErrorCode(text));
  }
  if (!Array.isArray(result.content) || result.content.length !== 1 || result.content[0]?.type !== "text") fail("tool_result_invalid");
  try {
    const parsed = JSON.parse(result.content[0].text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("tool_result_invalid");
    return parsed;
  } catch (error) {
    if (error instanceof DriverFailure) throw error;
    fail("tool_result_invalid");
  }
}

async function callTool(client, stats, name, args) {
  if (!DRIVER_TOOL_NAMES.includes(name)) fail("invalid_arguments");
  stats.toolCounts[name] += 1;
  const response = await client.request("tools/call", { name, arguments: args });
  return parseToolText(responseResult(response));
}

export function validateToolsList(result) {
  const tools = result?.tools;
  if (!Array.isArray(tools) || tools.length !== DRIVER_TOOL_NAMES.length) return false;
  const names = tools.map((tool) => tool?.name);
  return names.every((name, index) => name === DRIVER_TOOL_NAMES[index]) &&
    new Set(names).size === DRIVER_TOOL_NAMES.length;
}

async function initializeAndList(client, stats) {
  const initialize = await client.request("initialize", {
    protocolVersion: DRIVER_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "browser-session-poc-gate5-driver", version: "0.0.0" },
  });
  stats.protocolCounts.initialize += 1;
  const initializedResult = responseResult(initialize);
  if (initializedResult.protocolVersion !== DRIVER_PROTOCOL_VERSION) fail("protocol_version_mismatch");
  client.notify("notifications/initialized", {});
  stats.protocolCounts.initialized += 1;
  const toolsList = await client.request("tools/list", {});
  stats.protocolCounts.toolsList += 1;
  const toolsResult = responseResult(toolsList);
  stats.toolsExact = validateToolsList(toolsResult);
  if (!stats.toolsExact) fail("tools_mismatch");
}

function validateStatus(result) {
  if (!exactKeys(result, ["status"]) || !exactKeys(result.status, ["chrome_tabs_available", "extension_connected"]) ||
    result.status.extension_connected !== true || result.status.chrome_tabs_available !== true) {
    fail("browser_unavailable");
  }
}

function validateTabs(result) {
  if (!exactKeys(result, ["tabs"]) || !Array.isArray(result.tabs) || result.tabs.length === 0) fail("tabs_unavailable");
  for (const tab of result.tabs) {
    if (!exactKeys(tab, ["id", "window_id", "active"]) || !Number.isSafeInteger(tab.id) || tab.id < 0 ||
      !Number.isSafeInteger(tab.window_id) || tab.window_id < 0 || typeof tab.active !== "boolean") fail("tabs_unavailable");
  }
  return (result.tabs.find((tab) => tab.active) ?? result.tabs[0]).id;
}

function validateSnapshot(result, tabId) {
  if (!exactKeys(result, ["tab_id", "document", "nodes", "truncated", "partial"]) || result.tab_id !== tabId ||
    !exactKeys(result.document, ["loader_id"]) || typeof result.document.loader_id !== "string" || result.document.loader_id.length === 0 ||
    !Array.isArray(result.nodes) || typeof result.truncated !== "boolean" || typeof result.partial !== "boolean") {
    fail("snapshot_invalid");
  }
  for (const node of result.nodes) {
    if (!node || typeof node !== "object" || Array.isArray(node) || !Number.isSafeInteger(node.ref) || node.ref <= 0 ||
      !(node.backend_dom_node_id === null || (Number.isSafeInteger(node.backend_dom_node_id) && node.backend_dom_node_id > 0)) ||
      typeof node.role !== "string" || !(node.name === null || typeof node.name === "string") ||
      !(node.value === null || typeof node.value === "string")) fail("snapshot_invalid");
  }
  return result;
}

async function snapshotWithBoundedRetry(client, stats, tabId) {
  let lastError = "snapshot_failed";
  for (let attempt = 0; attempt < DRIVER_SNAPSHOT_ATTEMPTS; attempt += 1) {
    stats.snapshotAttempts += 1;
    try {
      const snapshot = validateSnapshot(await callTool(client, stats, "snapshot", { tab_id: tabId }), tabId);
      return snapshot;
    } catch (error) {
      lastError = fixedCode(error, "snapshot_failed");
      if (!READ_ONLY_SNAPSHOT_RETRY_CODES.has(lastError) || attempt + 1 >= DRIVER_SNAPSHOT_ATTEMPTS) fail(lastError);
      await sleep(DRIVER_SNAPSHOT_DELAY_MS);
    }
  }
  fail(lastError);
}

function nodeTexts(node) {
  return [node?.name, node?.value].filter((value) => typeof value === "string");
}

function nodeHasBackendId(node) {
  return Number.isSafeInteger(node?.backend_dom_node_id) && node.backend_dom_node_id > 0;
}

function findNode(snapshot, predicate, errorCode) {
  const node = snapshot.nodes.find((candidate) => predicate(candidate) && nodeHasBackendId(candidate));
  if (!node) fail(errorCode);
  return node;
}

function findMarkerInput(snapshot) {
  return findNode(snapshot, (node) => node.role === "textbox" && node.name === "Marker", "marker_input_not_found");
}

function findSaveButton(snapshot) {
  return findNode(snapshot, (node) => node.role === "button" && node.name === "Save marker", "save_button_not_found");
}

function hasLabelledValue(snapshot, label, expected) {
  const nodes = snapshot.nodes;
  for (let index = 0; index < nodes.length; index += 1) {
    if (!nodeTexts(nodes[index]).includes(label)) continue;
    if (nodeTexts(nodes[index]).includes(expected)) return true;
    for (let next = index + 1; next < Math.min(nodes.length, index + 5); next += 1) {
      if (nodeTexts(nodes[next]).includes(expected)) return true;
    }
  }
  return false;
}

function exactSnapshotText(snapshot, value) {
  return snapshot.nodes.some((node) => nodeTexts(node).includes(value));
}

function assessFinalSnapshot(snapshot, { expectedMarker, otherMarker }) {
  const fixtureH1Present = snapshot.nodes.some((node) => node.role === "heading" && node.name === "Gate 4 storage fixture");
  const cookieLocalStorageMatch = hasLabelledValue(snapshot, "Cookie/localStorage match", "true");
  const ownMarkerMatch = ["Stored marker", "Cookie marker", "localStorage marker"].every((label) =>
    hasLabelledValue(snapshot, label, expectedMarker));
  const otherMarkerAbsent = !exactSnapshotText(snapshot, otherMarker);
  return { fixtureH1Present, cookieLocalStorageMatch, ownMarkerMatch, otherMarkerAbsent };
}

function validateMutation(result, command, target) {
  if (!exactKeys(result, ["tab_id", "loader_id", "backend_dom_node_id", "accepted"]) || result.accepted !== true ||
    result.tab_id !== target.tabId || result.loader_id !== target.loaderId || result.backend_dom_node_id !== target.backendDomNodeId) {
    fail(`${command}_invalid`);
  }
}

function validateNavigate(result, tabId) {
  if (!exactKeys(result, ["tab_id", "accepted"]) || result.accepted !== true || result.tab_id !== tabId) fail("navigate_invalid");
}

function buildFixtureUrl(origin, marker) {
  const url = new URL(origin);
  url.searchParams.set("marker", marker);
  return url.href;
}

async function runAcceptance({ client, fixtureOrigin, marker, otherMarker, suffix, stats }) {
  try {
    await initializeAndList(client, stats);
    validateStatus(await callTool(client, stats, "browser_status", {}));
    const tabId = validateTabs(await callTool(client, stats, "tabs_list", {}));
    const navigateResult = await callTool(client, stats, "navigate", { tab_id: tabId, url: buildFixtureUrl(fixtureOrigin, marker) });
    validateNavigate(navigateResult, tabId);

    const firstSnapshot = await snapshotWithBoundedRetry(client, stats, tabId);
    const markerInput = findMarkerInput(firstSnapshot);
    const firstLoaderId = firstSnapshot.document.loader_id;
    const typeTarget = { tabId, loaderId: firstLoaderId, backendDomNodeId: markerInput.backend_dom_node_id };
    const typed = await callTool(client, stats, "type", {
      tab_id: typeTarget.tabId,
      loader_id: typeTarget.loaderId,
      backend_dom_node_id: typeTarget.backendDomNodeId,
      text: suffix,
    });
    validateMutation(typed, "type", typeTarget);

    const afterType = await snapshotWithBoundedRetry(client, stats, tabId);
    const saveButton = findSaveButton(afterType);
    const clickTarget = { tabId, loaderId: afterType.document.loader_id, backendDomNodeId: saveButton.backend_dom_node_id };
    const clicked = await callTool(client, stats, "click", {
      tab_id: clickTarget.tabId,
      loader_id: clickTarget.loaderId,
      backend_dom_node_id: clickTarget.backendDomNodeId,
    });
    validateMutation(clicked, "click", clickTarget);

    const finalSnapshot = await snapshotWithBoundedRetry(client, stats, tabId);
    const booleans = assessFinalSnapshot(finalSnapshot, { expectedMarker: `${marker}${suffix}`, otherMarker });
    const correlationOk = typed.tab_id === typeTarget.tabId && typed.loader_id === typeTarget.loaderId &&
      typed.backend_dom_node_id === typeTarget.backendDomNodeId && clicked.tab_id === clickTarget.tabId &&
      clicked.loader_id === clickTarget.loaderId && clicked.backend_dom_node_id === clickTarget.backendDomNodeId &&
      finalSnapshot.tab_id === tabId;
    const mutationCounts = stats.toolCounts.navigate === 1 && stats.toolCounts.type === 1 && stats.toolCounts.click === 1;
    const pass = stats.toolsExact && mutationCounts && booleans.fixtureH1Present && booleans.cookieLocalStorageMatch &&
      booleans.ownMarkerMatch && booleans.otherMarkerAbsent && correlationOk;
    return createSummary(stats, {
      result: pass ? "PASS" : "FAIL",
      fixture_h1_present: booleans.fixtureH1Present,
      cookie_localstorage_match: booleans.cookieLocalStorageMatch,
      own_marker_match: booleans.ownMarkerMatch,
      other_marker_absent: booleans.otherMarkerAbsent,
      correlation_ok: correlationOk,
      fixed_error: pass ? null : "acceptance_failed",
    });
  } catch (error) {
    stats.fixedError = fixedCode(error);
    return createSummary(stats);
  }
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseDriverArguments(argv); } catch (error) {
    process.stdout.write(`${JSON.stringify({ result: "FAIL", fixed_error: fixedCode(error, "invalid_arguments") })}\n`);
    process.stderr.write(`${fixedCode(error, "invalid_arguments")}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const stats = newStats();
  let fixture;
  let child;
  let client;
  let summary;
  try {
    fixture = options.startFixture ? await startFixture() : { child: null, origin: options.fixtureOrigin };
    child = spawnMcpServer({ instanceId: options.instanceId, runtimeRoot: options.runtimeRoot });
    client = new StdioJsonRpcClient(child);
    summary = await runAcceptance({
      client,
      fixtureOrigin: fixture.origin,
      marker: options.marker,
      otherMarker: options.otherMarker,
      suffix: options.suffix,
      stats,
    });
  } catch (error) {
    stats.fixedError = fixedCode(error);
    summary = createSummary(stats);
  } finally {
    if (client) client.endInput();
    const mcpClosed = await closeChildBounded(child);
    const fixtureClosed = await closeChildBounded(fixture?.child);
    if ((!mcpClosed || !fixtureClosed) && summary?.fixed_error === null) {
      summary.fixed_error = "cleanup_failed";
      summary.result = "FAIL";
    }
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.result !== "PASS") {
    process.stderr.write(`${summary.fixed_error}\n`);
    process.exitCode = 1;
  }
}

export {
  DriverFailure,
  assessFinalSnapshot,
  buildFixtureUrl,
  createSummary,
  newStats,
  runAcceptance,
  validateSnapshot,
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
