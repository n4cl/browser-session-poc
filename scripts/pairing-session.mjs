#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import process from "node:process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { startPairingHarness } from "../core/pairing-harness.mjs";

export function parsePairingCommand(argumentsList) {
  const [command, instanceId, ...extra] = argumentsList;
  if (command !== "start" || !instanceId || extra.length !== 0) {
    return null;
  }
  return { instanceId };
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
      if (line === "status") {
        output.write(`status ${command.instanceId} ${harness.server.state.phase}\n`);
      } else if (line === "ping") {
        try {
          await harness.server.requestPing({ requestId: createRequestId(), timeoutMs: 1_000 });
          output.write("ping ok\n");
        } catch {
          output.write("ping failed\n");
        }
      } else if (line === "browser-status") {
        try {
          const result = await harness.server.requestBrowserStatus({ requestId: createRequestId(), timeoutMs: 1_000 });
          output.write(`${JSON.stringify({ command: "browser_status", generation: result.generation, status: result.status })}\n`);
        } catch {
          output.write("browser-status failed\n");
        }
      } else if (line === "tabs-list") {
        try {
          const result = await harness.server.requestTabsList({ requestId: createRequestId(), timeoutMs: 1_000 });
          output.write(`${JSON.stringify({ command: "tabs_list", generation: result.generation, tabs: result.tabs })}\n`);
        } catch {
          output.write("tabs-list failed\n");
        }
      } else if (line === "disconnect-active-host") {
        try {
          harness.server.disconnectActiveHost();
          output.write("host disconnected\n");
        } catch {
          output.write("host disconnect rejected\n");
        }
      } else if (line === "quit") {
        break;
      } else {
        output.write("error unknown_command\n");
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
