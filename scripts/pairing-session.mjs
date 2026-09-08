#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import process from "node:process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { validateNavigateTarget } from "../core/browser-command-protocol.mjs";
import { startPairingHarness } from "../core/pairing-harness.mjs";

export function parsePairingCommand(argumentsList) {
  const [command, instanceId, ...extra] = argumentsList;
  if (command !== "start" || !instanceId || extra.length !== 0) {
    return null;
  }
  return { instanceId };
}

export function parseInteractiveCommand(line) {
  if (line === "status" || line === "ping" || line === "browser-status" || line === "tabs-list" ||
    line === "disconnect-active-host" || line === "quit") {
    return { type: line };
  }
  const parts = typeof line === "string" ? line.split(" ") : [];
  if (parts.length === 2 && parts[0] === "snapshot" && /^(0|[1-9]\d*)$/.test(parts[1])) {
    const tabId = Number(parts[1]);
    if (Number.isSafeInteger(tabId)) return { type: "snapshot", tabId };
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
    errorOutput.write("usage: pairing start <instance-id>\n");
    return 2;
  }

  let harness;
  try {
    harness = await startHarness({ runtimeRoot, instanceId: command.instanceId });
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
        } catch {
          output.write("browser-status failed\n");
        }
      } else if (interactive?.type === "tabs-list") {
        try {
          const result = await harness.server.requestTabsList({ requestId: createRequestId(), timeoutMs: 1_000 });
          output.write(`${JSON.stringify({ command: "tabs_list", generation: result.generation, tabs: result.tabs })}\n`);
        } catch {
          output.write("tabs-list failed\n");
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
        } catch {
          output.write("navigate failed\n");
        }
      } else if (interactive?.type === "snapshot") {
        try {
          const result = await harness.server.requestSnapshot({
            requestId: createRequestId(),
            tabId: interactive.tabId,
            timeoutMs: 1_000,
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
        } catch {
          output.write("snapshot failed\n");
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
