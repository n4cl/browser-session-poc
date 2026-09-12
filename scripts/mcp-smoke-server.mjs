import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";

export const MCP_SMOKE_MAX_BUFFER_BYTES = 64 * 1024;

const EMPTY_OBJECT_SCHEMA = Object.freeze({
  "~standard": Object.freeze({
    version: 1,
    vendor: "browser-session-poc/mcp-smoke",
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

export function createSmokeServer() {
  const server = new McpServer({ name: "browser-session-poc-mcp-smoke", version: "0.0.0" });
  server.registerTool(
    "health",
    {
      title: "Health",
      description: "Returns a fixed health result for the Gate 5 SDK smoke test.",
      inputSchema: EMPTY_OBJECT_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => ({ content: [{ type: "text", text: "ok" }] }),
  );
  return server;
}

export function startSmokeServer({ input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
  const transport = new StdioServerTransport(input, output, { maxBufferSize: MCP_SMOKE_MAX_BUFFER_BYTES });
  let handle;
  let closing;
  const reportFixedError = () => {
    errorOutput.write("mcp_smoke_error\n");
    void close();
  };
  const close = () => {
    if (!closing) {
      closing = Promise.resolve(handle?.close()).catch(() => {}).then(() => {
        process.exitCode = 0;
      });
    }
    return closing;
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  input.once("end", () => { void close(); });
  handle = serveStdio(() => createSmokeServer(), {
    transport,
    legacy: "serve",
    onerror: reportFixedError,
  });
  return Object.freeze({ handle, close });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startSmokeServer();
}
