import assert from "node:assert/strict";
import test from "node:test";
import { parsePairingCommand, runPairingSession } from "../scripts/pairing-session.mjs";

function writableCapture() {
  let value = "";
  return {
    write(chunk) {
      value += chunk;
    },
    value() {
      return value;
    },
  };
}

async function* commands(lines) {
  yield* lines;
}

test("pairing CLI accepts only an explicit start instance command", () => {
  assert.deepEqual(parsePairingCommand(["start", "poc-a"]), { instanceId: "poc-a" });
  assert.equal(parsePairingCommand([]), null);
  assert.equal(parsePairingCommand(["start"]), null);
  assert.equal(parsePairingCommand(["plan", "poc-a"]), null);
  assert.equal(parsePairingCommand(["start", "poc-a", "extra"]), null);
});

test("pairing CLI reports status, rejects unknown commands, and closes once on quit", async () => {
  const output = writableCapture();
  const errorOutput = writableCapture();
  let closeCalls = 0;
  const harness = {
    server: {
      state: { phase: "ISSUED" },
      async requestPing() {
        throw new Error("no active pairing");
      },
    },
    async close() {
      closeCalls += 1;
    },
  };

  const exitCode = await runPairingSession({
    argumentsList: ["start", "poc-a"],
    runtimeRoot: "/private/tmp/runtime",
    lineReader: commands(["status", "ping", "unknown", "quit"]),
    output,
    errorOutput,
    startHarness: async () => harness,
    createRequestId: () => "request-secret-not-printed",
  });

  assert.equal(exitCode, 0);
  assert.equal(closeCalls, 1);
  assert.equal(
    output.value(),
    "ready poc-a ISSUED\nstatus poc-a ISSUED\nping failed\nerror unknown_command\n",
  );
  assert.equal(errorOutput.value(), "");
  assert.equal(output.value().includes("request-secret-not-printed"), false);
});

test("pairing CLI reports startup and cleanup failures without bypassing cleanup", async () => {
  const output = writableCapture();
  const startupErrors = writableCapture();
  const startupCode = await runPairingSession({
    argumentsList: ["start", "poc-a"],
    runtimeRoot: "/private/tmp/runtime",
    lineReader: commands([]),
    output,
    errorOutput: startupErrors,
    startHarness: async () => {
      throw new Error("claim exists");
    },
  });
  assert.equal(startupCode, 1);
  assert.equal(startupErrors.value(), "claim exists\n");

  const cleanupErrors = writableCapture();
  const cleanupCode = await runPairingSession({
    argumentsList: ["start", "poc-a"],
    runtimeRoot: "/private/tmp/runtime",
    lineReader: commands(["quit"]),
    output: writableCapture(),
    errorOutput: cleanupErrors,
    startHarness: async () => ({
      server: { state: { phase: "ISSUED" }, requestPing: async () => {} },
      close: async () => {
        throw new Error("ownership changed");
      },
    }),
  });
  assert.equal(cleanupCode, 1);
  assert.equal(cleanupErrors.value(), "ownership changed\n");
});
