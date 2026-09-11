#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import process from "node:process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  BROWSER_ERROR_CODES,
  CLICK_LOADER_ID_MAX_LENGTH,
  SNAPSHOT_COMMAND_TIMEOUT_DEFAULT_MS,
  TYPE_TEXT_MAX_LENGTH,
  validateClickTarget,
  validateTypeTarget,
  validateNavigateTarget,
} from "../core/browser-command-protocol.mjs";
import { AUDIT_ERROR_CODE } from "../core/pairing-audit-log.mjs";
import { startPairingHarness } from "../core/pairing-harness.mjs";

const DEFAULT_PAIRING_LEASE_MINUTES = 60;
const MAX_PAIRING_LEASE_MINUTES = 1_440;
const LEASE_MINUTES_PATTERN = /^[1-9]\d*$/;
const SESSION_DISPLAY_ERROR_CODES = new Set([...BROWSER_ERROR_CODES, AUDIT_ERROR_CODE]);

function displayErrorCode(error) {
  return SESSION_DISPLAY_ERROR_CODES.has(error?.code) ? ` ${error.code}` : "";
}

function displayAuditError(error) {
  return error?.code === AUDIT_ERROR_CODE ? ` ${AUDIT_ERROR_CODE}` : "";
}

export function parsePairingCommand(argumentsList) {
  const [command, instanceId, ...extra] = argumentsList;
  if (command !== "start" || !instanceId) {
    return null;
  }
  if (extra.length === 0) {
    return { instanceId, leaseMinutes: DEFAULT_PAIRING_LEASE_MINUTES };
  }
  if (
    extra.length !== 2 ||
    extra[0] !== "--lease-minutes" ||
    typeof extra[1] !== "string" ||
    !LEASE_MINUTES_PATTERN.test(extra[1])
  ) {
    return null;
  }
  const leaseMinutes = Number(extra[1]);
  if (!Number.isSafeInteger(leaseMinutes) || leaseMinutes < 1 || leaseMinutes > MAX_PAIRING_LEASE_MINUTES) {
    return null;
  }
  return { instanceId, leaseMinutes };
}

export function parseInteractiveCommand(line) {
  if (line === "status" || line === "ping" || line === "browser-status" || line === "tabs-list" ||
    line === "disconnect-active-host" || line === "quit") {
    return { type: line };
  }
  const typeMatch = typeof line === "string"
    ? /^type\s+(\S+)\s+(\S+)\s+(\S+)\s+([\s\S]+)$/u.exec(line)
    : null;
  if (typeMatch) {
    const [, tabToken, loaderId, backendToken, jsonText] = typeMatch;
    if (!/^(0|[1-9]\d*)$/.test(tabToken) || !/^[1-9]\d*$/.test(backendToken) ||
      loaderId.length > CLICK_LOADER_ID_MAX_LENGTH) return null;
    let text;
    try {
      text = JSON.parse(jsonText);
    } catch {
      return null;
    }
    const tabId = Number(tabToken);
    const backendDomNodeId = Number(backendToken);
    if (!Number.isSafeInteger(tabId) || !Number.isSafeInteger(backendDomNodeId) ||
      typeof text !== "string" || text.length === 0 || text.length > TYPE_TEXT_MAX_LENGTH) return null;
    try {
      return { type: "type", ...validateTypeTarget({ tabId, loaderId, backendDomNodeId, text }) };
    } catch {
      return null;
    }
  }
  const parts = typeof line === "string" ? line.split(" ") : [];
  if (parts.length === 2 && parts[0] === "snapshot" && /^(0|[1-9]\d*)$/.test(parts[1])) {
    const tabId = Number(parts[1]);
    if (Number.isSafeInteger(tabId)) return { type: "snapshot", tabId };
    return null;
  }
  if (parts.length === 4 && parts[0] === "click" && /^(0|[1-9]\d*)$/.test(parts[1]) &&
    /^\S+$/u.test(parts[2]) && parts[2].length <= CLICK_LOADER_ID_MAX_LENGTH && /^[1-9]\d*$/.test(parts[3])) {
    const tabId = Number(parts[1]);
    const backendDomNodeId = Number(parts[3]);
    if (Number.isSafeInteger(tabId) && Number.isSafeInteger(backendDomNodeId)) {
      try {
        return { type: "click", ...validateClickTarget({ tabId, loaderId: parts[2], backendDomNodeId }) };
      } catch {
        return null;
      }
    }
    return null;
  }
  if (parts.length === 3 && parts[0] === "navigate" && /^(0|[1-9]\d*)$/.test(parts[1])) {
    const tabId = Number(parts[1]);
    try {
      const target = validateNavigateTarget({ tabId, url: parts[2] });
      return { type: "navigate", ...target };
    } catch {
      return null;
    }
  }
  return null;
}

export async function runPairingSession({
  argumentsList,
  runtimeRoot,
  lineReader,
  output,
  errorOutput,
  startHarness = startPairingHarness,
  createRequestId = randomUUID,
}) {
  const command = parsePairingCommand(argumentsList);
  if (command === null) {
    errorOutput.write("usage: pairing start <instance-id> [--lease-minutes <1..1440>]\n");
    return 2;
  }

  let harness;
  try {
    harness = await startHarness({
      runtimeRoot,
      instanceId: command.instanceId,
      ttlMs: command.leaseMinutes * 60_000,
    });
  } catch (error) {
    errorOutput.write(`${error.message}\n`);
    return 1;
  }

  let closed = false;
  const closeOnce = async () => {
    if (!closed) {
      closed = true;
      await harness.close();
    }
  };

  output.write(`ready ${command.instanceId} ISSUED\n`);
  let exitCode = 0;
  try {
    for await (const line of lineReader) {
      const interactive = parseInteractiveCommand(line);
      if (interactive?.type === "status") {
        output.write(`status ${command.instanceId} ${harness.server.state.phase}\n`);
      } else if (interactive?.type === "ping") {
        try {
          await harness.server.requestPing({ requestId: createRequestId(), timeoutMs: 1_000 });
          output.write("ping ok\n");
        } catch {
          output.write("ping failed\n");
        }
      } else if (interactive?.type === "browser-status") {
        try {
          const result = await harness.server.requestBrowserStatus({ requestId: createRequestId(), timeoutMs: 1_000 });
          output.write(`${JSON.stringify({ command: "browser_status", generation: result.generation, status: result.status })}\n`);
        } catch (error) {
          output.write(`browser-status failed${displayAuditError(error)}\n`);
        }
      } else if (interactive?.type === "tabs-list") {
        try {
          const result = await harness.server.requestTabsList({ requestId: createRequestId(), timeoutMs: 1_000 });
          output.write(`${JSON.stringify({ command: "tabs_list", generation: result.generation, tabs: result.tabs })}\n`);
        } catch (error) {
          output.write(`tabs-list failed${displayAuditError(error)}\n`);
        }
      } else if (interactive?.type === "navigate") {
        try {
          const result = await harness.server.requestNavigate({
            requestId: createRequestId(),
            tabId: interactive.tabId,
            url: interactive.url,
            timeoutMs: 1_000,
          });
          output.write(`${JSON.stringify({ command: "navigate", generation: result.generation, tab_id: result.tab_id, accepted: result.accepted })}\n`);
        } catch (error) {
          output.write(`navigate failed${displayAuditError(error)}\n`);
        }
      } else if (interactive?.type === "snapshot") {
        try {
          const result = await harness.server.requestSnapshot({
            requestId: createRequestId(),
            tabId: interactive.tabId,
            timeoutMs: SNAPSHOT_COMMAND_TIMEOUT_DEFAULT_MS,
          });
          output.write(`${JSON.stringify({
            command: "snapshot",
            generation: result.generation,
            tab_id: result.tab_id,
            document: result.document,
            nodes: result.nodes,
            truncated: result.truncated,
            partial: result.partial,
          })}\n`);
        } catch (error) {
          output.write(`snapshot failed${displayErrorCode(error)}\n`);
        }
      } else if (interactive?.type === "click") {
        try {
          const result = await harness.server.requestClick({
            requestId: createRequestId(),
            tabId: interactive.tabId,
            loaderId: interactive.loaderId,
            backendDomNodeId: interactive.backendDomNodeId,
            timeoutMs: SNAPSHOT_COMMAND_TIMEOUT_DEFAULT_MS,
          });
          output.write(`${JSON.stringify({
            command: "click",
            generation: result.generation,
            tab_id: result.tab_id,
            loader_id: result.loader_id,
            backend_dom_node_id: result.backend_dom_node_id,
            accepted: result.accepted,
          })}\n`);
        } catch (error) {
          output.write(`click failed${displayErrorCode(error)}\n`);
        }
      } else if (interactive?.type === "type") {
        try {
          const result = await harness.server.requestType({
            requestId: createRequestId(),
            tabId: interactive.tabId,
            loaderId: interactive.loaderId,
            backendDomNodeId: interactive.backendDomNodeId,
            text: interactive.text,
            timeoutMs: SNAPSHOT_COMMAND_TIMEOUT_DEFAULT_MS,
          });
          output.write(`${JSON.stringify({
            command: "type",
            generation: result.generation,
            tab_id: result.tab_id,
            loader_id: result.loader_id,
            backend_dom_node_id: result.backend_dom_node_id,
            accepted: result.accepted,
          })}\n`);
        } catch (error) {
          output.write(`type failed${displayErrorCode(error)}\n`);
        }
      } else if (interactive?.type === "disconnect-active-host") {
        try {
          harness.server.disconnectActiveHost();
          output.write("host disconnected\n");
        } catch {
          output.write("host disconnect rejected\n");
        }
      } else if (interactive?.type === "quit") {
        break;
      } else {
        output.write(`${typeof line === "string" && line.startsWith("navigate")
          ? "error invalid_navigate"
          : typeof line === "string" && line.startsWith("snapshot")
            ? "error invalid_snapshot"
            : typeof line === "string" && line.startsWith("click")
              ? "error invalid_click"
            : typeof line === "string" && line.startsWith("type")
              ? "error invalid_type"
            : "error unknown_command"}\n`);
      }
    }
  } finally {
    try {
      await closeOnce();
    } catch (error) {
      errorOutput.write(`${error.message}\n`);
      exitCode = 1;
    }
  }
  return exitCode;
}

export async function main({
  argumentsList = process.argv.slice(2),
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
} = {}) {
  const runtimeRoot = environment.BROWSER_POC_RUNTIME_ROOT
    ? path.resolve(environment.BROWSER_POC_RUNTIME_ROOT)
    : path.resolve(import.meta.dirname, "..", ".runtime");
  const lineReader = createInterface({ input, crlfDelay: Infinity });
  let settled = false;
  const stopReader = () => {
    if (!settled) {
      settled = true;
      lineReader.close();
    }
  };
  process.once("SIGINT", stopReader);
  process.once("SIGTERM", stopReader);
  try {
    return await runPairingSession({
      argumentsList,
      runtimeRoot,
      lineReader,
      output,
      errorOutput,
    });
  } finally {
    settled = true;
    process.off("SIGINT", stopReader);
    process.off("SIGTERM", stopReader);
    lineReader.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
