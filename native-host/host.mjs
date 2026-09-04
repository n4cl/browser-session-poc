import { mkdir, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import { GATE_1_EXTENSION_ORIGIN } from "../core/extension-id.mjs";
import {
  encodeNativeMessage,
  MAX_EXTENSION_TO_HOST_BYTES,
  MAX_HOST_TO_EXTENSION_BYTES,
  NativeMessageDecoder,
} from "./codec.mjs";

export const GATE_1_NATIVE_HOST_NAME = "com.browser_session_poc.gate1";
export const GATE_1_PROTOCOL_VERSION = 1;

function runtimeRoot() {
  return process.env.BROWSER_POC_RUNTIME_ROOT
    ? path.resolve(process.env.BROWSER_POC_RUNTIME_ROOT)
    : path.resolve(import.meta.dirname, "..", ".runtime");
}

export function successMarkerPath({ root = runtimeRoot() } = {}) {
  return path.join(root, "native-host", "gate-1-success.json");
}

export async function writeSuccessMarker(markerPath) {
  await mkdir(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${markerPath}.${process.pid}.tmp`;
  const marker = {
    gate: 1,
    status: "native_messaging_acknowledged",
    recorded_at: new Date().toISOString(),
  };
  await writeFile(temporaryPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  await rename(temporaryPath, markerPath);
}

function diagnostic(stderr, message) {
  stderr.write(`[browser-session-poc native-host] ${message}\n`);
}

export async function runNativeHost({
  input,
  output,
  stderr,
  origin,
  markerPath = successMarkerPath(),
}) {
  if (origin !== GATE_1_EXTENSION_ORIGIN) {
    diagnostic(stderr, "rejected unexpected extension origin");
    return false;
  }

  const decoder = new NativeMessageDecoder({ maxBytes: MAX_EXTENSION_TO_HOST_BYTES });
  let helloAcknowledged = false;
  let markerWritten = false;

  try {
    for await (const chunk of input) {
      for (const message of decoder.push(chunk)) {
        if (
          !helloAcknowledged &&
          message?.type === "hello" &&
          message.protocol_version === GATE_1_PROTOCOL_VERSION
        ) {
          output.write(
            encodeNativeMessage(
              { type: "hello_ack", protocol_version: GATE_1_PROTOCOL_VERSION },
              { maxBytes: MAX_HOST_TO_EXTENSION_BYTES },
            ),
          );
          helloAcknowledged = true;
        } else if (
          helloAcknowledged &&
          !markerWritten &&
          message?.type === "ack" &&
          message.protocol_version === GATE_1_PROTOCOL_VERSION
        ) {
          await writeSuccessMarker(markerPath);
          markerWritten = true;
        } else {
          diagnostic(stderr, "rejected unexpected protocol message");
          return false;
        }
      }
    }
  } catch (error) {
    diagnostic(stderr, error instanceof Error ? error.message : "protocol failure");
    return false;
  }

  return markerWritten;
}

async function main() {
  const succeeded = await runNativeHost({
    input: process.stdin,
    output: process.stdout,
    stderr: process.stderr,
    origin: process.argv[2],
  });
  if (!succeeded) {
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
