import path from "node:path";
import { pathToFileURL } from "node:url";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { validateInstanceId } from "../core/chrome-instance.mjs";
import { resolvePairingPaths } from "../core/pairing-descriptor.mjs";
import { startPairingHarness } from "../core/pairing-harness.mjs";
import { createMcpBrowserServer } from "./mcp-browser-adapter.mjs";

export const MCP_SERVER_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENTS: "mcp_invalid_arguments",
  STARTUP_FAILED: "mcp_startup_failed",
  TRANSPORT_FAILED: "mcp_transport_failed",
  SHUTDOWN_FAILED: "mcp_shutdown_failed",
});

export const MCP_SERVER_MAX_BUFFER_BYTES = 64 * 1024;

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function parseMcpServerArguments(argumentsList) {
  if (!Array.isArray(argumentsList) || argumentsList.length !== 2 || argumentsList[0] !== "--instance-id") {
    throw fixedError(MCP_SERVER_ERROR_CODES.INVALID_ARGUMENTS);
  }
  try {
    validateInstanceId(argumentsList[1]);
  } catch {
    throw fixedError(MCP_SERVER_ERROR_CODES.INVALID_ARGUMENTS);
  }
  return { instanceId: argumentsList[1] };
}

export function resolveMcpServerRuntimeRoot(environment = process.env) {
  const configured = environment?.BROWSER_POC_RUNTIME_ROOT;
  if (configured !== undefined && (typeof configured !== "string" || configured.length === 0 || configured.includes("\u0000"))) {
    throw fixedError(MCP_SERVER_ERROR_CODES.INVALID_ARGUMENTS);
  }
  return path.resolve(configured ?? path.resolve(import.meta.dirname, "..", ".runtime"));
}

export { createMcpBrowserServer } from "./mcp-browser-adapter.mjs";

export async function runMcpServer({
  argumentsList = process.argv.slice(2),
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  startHarness = startPairingHarness,
  serve = serveStdio,
  signalSource = process,
} = {}) {
  let harness;
  let handle;
  let closePromise;
  let startupReady = false;
  let shutdownRequested = false;
  let requestedExitCode = 0;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const writeFixed = (code) => {
    errorOutput.write(`${code}\n`);
  };
  const closeOnce = (exitCode = 0) => {
    if (exitCode !== 0) {
      requestedExitCode = exitCode;
    }
    if (!closePromise) {
      closePromise = (async () => {
        let finalExitCode = requestedExitCode;
        try {
          await handle?.close();
        } catch {
          writeFixed(MCP_SERVER_ERROR_CODES.SHUTDOWN_FAILED);
          finalExitCode = 1;
        }
        try {
          await harness?.close();
        } catch {
          writeFixed(MCP_SERVER_ERROR_CODES.SHUTDOWN_FAILED);
          finalExitCode = 1;
        }
        if (requestedExitCode !== 0) {
          finalExitCode = 1;
        }
        finish(finalExitCode);
        return finalExitCode;
      })();
    }
    return closePromise;
  };
  const requestShutdown = (exitCode = 0) => {
    shutdownRequested = true;
    if (exitCode !== 0) {
      requestedExitCode = exitCode;
    }
    if (startupReady) {
      void closeOnce(requestedExitCode);
    }
  };
  const onInputEnd = () => { requestShutdown(0); };
  const onSignal = () => { requestShutdown(0); };
  input.once("end", onInputEnd);
  signalSource.once("SIGINT", onSignal);
  signalSource.once("SIGTERM", onSignal);
  try {
    const { instanceId } = parseMcpServerArguments(argumentsList);
    const runtimeRoot = resolveMcpServerRuntimeRoot(environment);
    const paths = resolvePairingPaths({ runtimeRoot, instanceId });
    harness = await startHarness({ runtimeRoot: paths.runtimeRoot, instanceId });
    if (shutdownRequested) {
      await closeOnce(requestedExitCode);
      return await finished;
    }
    const transport = new StdioServerTransport(input, output, { maxBufferSize: MCP_SERVER_MAX_BUFFER_BYTES });
    handle = serve(() => createMcpBrowserServer({ browserServer: harness.server }), {
      transport,
      legacy: "serve",
      onerror: () => {
        writeFixed(MCP_SERVER_ERROR_CODES.TRANSPORT_FAILED);
        requestShutdown(1);
      },
    });
    startupReady = true;
    if (shutdownRequested) {
      void closeOnce(requestedExitCode);
    }
    return await finished;
  } catch (error) {
    writeFixed(error?.code === MCP_SERVER_ERROR_CODES.INVALID_ARGUMENTS
      ? MCP_SERVER_ERROR_CODES.INVALID_ARGUMENTS
      : MCP_SERVER_ERROR_CODES.STARTUP_FAILED);
    try {
      await harness?.close();
    } catch {
      writeFixed(MCP_SERVER_ERROR_CODES.SHUTDOWN_FAILED);
    }
    input.pause?.();
    return 1;
  } finally {
    input.off("end", onInputEnd);
    signalSource.off("SIGINT", onSignal);
    signalSource.off("SIGTERM", onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runMcpServer();
}
