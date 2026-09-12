import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { validateInstanceId } from "../core/chrome-instance.mjs";
import { resolvePairingPaths } from "../core/pairing-descriptor.mjs";
import { startPairingHarness } from "../core/pairing-harness.mjs";

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

const EMPTY_OBJECT_SCHEMA = Object.freeze({
  "~standard": Object.freeze({
    version: 1,
    vendor: "browser-session-poc/mcp-server",
    validate(value) {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 0) {
        return { issues: [{ message: "arguments must be an empty object" }] };
      }
      return { value: {} };
    },
    jsonSchema: Object.freeze({
      input: () => ({ type: "object", properties: {}, additionalProperties: false }),
      output: () => ({ type: "object", properties: {}, additionalProperties: false }),
    }),
  }),
});

export function createMcpLifecycleServer() {
  const server = new McpServer({ name: "browser-session-poc", version: "0.0.0" });
  server.registerTool(
    "health",
    {
      title: "Health",
      description: "Returns a fixed process health result.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  return server;
}

export async function runMcpServer({
  argumentsList = process.argv.slice(2),
  environment = process.env,
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  startHarness = startPairingHarness,
  serve = serveStdio,
} = {}) {
  let harness;
  let handle;
  let closePromise;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const writeFixed = (code) => {
    errorOutput.write(`${code}\n`);
  };
  const closeOnce = (requestedExitCode = 0) => {
    if (!closePromise) {
      closePromise = (async () => {
        let exitCode = requestedExitCode;
        try {
          await handle?.close();
        } catch {
          writeFixed(MCP_SERVER_ERROR_CODES.SHUTDOWN_FAILED);
          exitCode = 1;
        }
        try {
          await harness?.close();
        } catch {
          writeFixed(MCP_SERVER_ERROR_CODES.SHUTDOWN_FAILED);
          exitCode = 1;
        }
        finish(exitCode);
        return exitCode;
      })();
    }
    return closePromise;
  };
  const onInputEnd = () => { void closeOnce(0); };
  const onSignal = () => { void closeOnce(0); };
  input.once("end", onInputEnd);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const { instanceId } = parseMcpServerArguments(argumentsList);
    const runtimeRoot = resolveMcpServerRuntimeRoot(environment);
    const paths = resolvePairingPaths({ runtimeRoot, instanceId });
    harness = await startHarness({ runtimeRoot: paths.runtimeRoot, instanceId });
    const transport = new StdioServerTransport(input, output, { maxBufferSize: MCP_SERVER_MAX_BUFFER_BYTES });
    handle = serve(() => createMcpLifecycleServer(), {
      transport,
      legacy: "serve",
      onerror: () => {
        writeFixed(MCP_SERVER_ERROR_CODES.TRANSPORT_FAILED);
        void closeOnce(1);
      },
    });
    return await finished;
  } catch {
    writeFixed(MCP_SERVER_ERROR_CODES.STARTUP_FAILED);
    try {
      await harness?.close();
    } catch {
      writeFixed(MCP_SERVER_ERROR_CODES.SHUTDOWN_FAILED);
    }
    input.pause?.();
    return 1;
  } finally {
    input.off("end", onInputEnd);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runMcpServer();
}
