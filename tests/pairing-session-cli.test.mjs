import assert from "node:assert/strict";
import test from "node:test";
import { parseInteractiveCommand, parsePairingCommand, runPairingSession } from "../scripts/pairing-session.mjs";

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

test("pairing CLI parses navigate arguments strictly and canonicalizes accepted URLs", () => {
  assert.deepEqual(parseInteractiveCommand("navigate 7 https:example.test/path%20with-encoding"), {
    type: "navigate",
    tabId: 7,
    url: "https://example.test/path%20with-encoding",
  });
  for (const command of [
    "navigate", "navigate 7", "navigate -1 https://example.test/", "navigate 07 https://example.test/",
    "navigate 7 https://example.test/ extra", "navigate unsafe https://example.test/", "navigate 7 file:///private/tmp/x",
    "navigate 7 https://user:password@example.test/", "navigate 7 https://example.test/\tpath",
    "navigate 7 https://example.test/internal\u00a0space",
    `navigate 7 https:example.test/${"a".repeat(8_173)}`,
  ]) {
    assert.equal(parseInteractiveCommand(command), null);
  }
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
      disconnectActiveHost() {
        throw new Error("an active host transport is required");
      },
    },
    async close() {
      closeCalls += 1;
    },
  };

  const exitCode = await runPairingSession({
    argumentsList: ["start", "poc-a"],
    runtimeRoot: "/private/tmp/runtime",
    lineReader: commands(["status", "ping", "disconnect-active-host", "unknown", "quit"]),
    output,
    errorOutput,
    startHarness: async () => harness,
    createRequestId: () => "request-secret-not-printed",
  });

  assert.equal(exitCode, 0);
  assert.equal(closeCalls, 1);
  assert.equal(
    output.value(),
    "ready poc-a ISSUED\nstatus poc-a ISSUED\nping failed\nhost disconnect rejected\nerror unknown_command\n",
  );
  assert.equal(errorOutput.value(), "");
  assert.equal(output.value().includes("request-secret-not-printed"), false);
});

test("pairing CLI dispatches browser commands with fresh request IDs and prints only safe result JSON", async () => {
  const output = writableCapture();
  const errorOutput = writableCapture();
  const requestIds = ["request-status", "request-tabs"];
  const statusCalls = [];
  const tabCalls = [];
  const exitCode = await runPairingSession({
    argumentsList: ["start", "poc-a"],
    runtimeRoot: "/private/tmp/runtime",
    lineReader: commands(["browser-status", "tabs-list", "unknown", "quit"]),
    output,
    errorOutput,
    createRequestId: () => requestIds.shift(),
    startHarness: async () => ({
      server: {
        state: { phase: "ACTIVE" },
        async requestBrowserStatus(options) {
          statusCalls.push(options);
          return {
            generation: 3,
            lease_id: "lease-must-not-print",
            status: { extension_connected: true, chrome_tabs_available: true },
          };
        },
        async requestTabsList(options) {
          tabCalls.push(options);
          return {
            generation: 3,
            lease_id: "lease-must-not-print",
            tabs: [{ id: 4, window_id: 2, title: "Example", url: "https://example.test/", active: true }],
          };
        },
      },
      async close() {},
    }),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(statusCalls, [{ requestId: "request-status", timeoutMs: 1_000 }]);
  assert.deepEqual(tabCalls, [{ requestId: "request-tabs", timeoutMs: 1_000 }]);
  assert.equal(output.value(), [
    "ready poc-a ISSUED",
    '{"command":"browser_status","generation":3,"status":{"extension_connected":true,"chrome_tabs_available":true}}',
    '{"command":"tabs_list","generation":3,"tabs":[{"id":4,"window_id":2,"title":"Example","url":"https://example.test/","active":true}]}',
    "error unknown_command",
    "",
  ].join("\n"));
  assert.equal(output.value().includes("lease-must-not-print"), false);
  assert.equal(errorOutput.value(), "");
});

test("pairing CLI dispatches navigate with exact arguments and never echoes its URL", async () => {
  const output = writableCapture();
  const calls = [];
  const exitCode = await runPairingSession({
    argumentsList: ["start", "poc-a"],
    runtimeRoot: "/private/tmp/runtime",
    lineReader: commands(["navigate 7 https://example.test/private", "navigate 7 https://example.test/ extra", "quit"]),
    output,
    errorOutput: writableCapture(),
    createRequestId: () => "request-navigate",
    startHarness: async () => ({
      server: {
        state: { phase: "ACTIVE" },
        async requestNavigate(options) {
          calls.push(options);
          return { generation: 3, tab_id: 7, accepted: true, lease_id: "lease-must-not-print" };
        },
      },
      async close() {},
    }),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(calls, [{
    requestId: "request-navigate",
    tabId: 7,
    url: "https://example.test/private",
    timeoutMs: 1_000,
  }]);
  assert.equal(output.value(), "ready poc-a ISSUED\n{\"command\":\"navigate\",\"generation\":3,\"tab_id\":7,\"accepted\":true}\nerror invalid_navigate\n");
  assert.equal(output.value().includes("example.test"), false);
  assert.equal(output.value().includes("lease-must-not-print"), false);
});

test("pairing CLI reports browser command failures without exposing transport details and still cleans up", async () => {
  const output = writableCapture();
  let closeCalls = 0;
  const exitCode = await runPairingSession({
    argumentsList: ["start", "poc-a"],
    runtimeRoot: "/private/tmp/runtime",
    lineReader: commands(["browser-status", "tabs-list", "quit"]),
    output,
    errorOutput: writableCapture(),
    startHarness: async () => ({
      server: {
        state: { phase: "ACTIVE" },
        async requestBrowserStatus() { throw new Error("lease-must-not-print"); },
        async requestTabsList() { throw new Error("nonce-must-not-print"); },
      },
      async close() { closeCalls += 1; },
    }),
  });

  assert.equal(exitCode, 0);
  assert.equal(closeCalls, 1);
  assert.equal(output.value(), "ready poc-a ISSUED\nbrowser-status failed\ntabs-list failed\n");
  assert.equal(output.value().includes("must-not-print"), false);
});

test("pairing CLI disconnects only an active Host without printing its identity", async () => {
  const output = writableCapture();
  const errorOutput = writableCapture();
  let disconnectCalls = 0;
  const exitCode = await runPairingSession({
    argumentsList: ["start", "poc-a"],
    runtimeRoot: "/private/tmp/runtime",
    lineReader: commands(["disconnect-active-host", "quit"]),
    output,
    errorOutput,
    startHarness: async () => ({
      server: {
        state: { phase: "ACTIVE" },
        disconnectActiveHost() {
          disconnectCalls += 1;
        },
      },
      async close() {},
    }),
  });

  assert.equal(exitCode, 0);
  assert.equal(disconnectCalls, 1);
  assert.equal(output.value(), "ready poc-a ISSUED\nhost disconnected\n");
  assert.equal(errorOutput.value(), "");
  assert.equal(output.value().includes("connection"), false);
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
      server: {
        state: { phase: "ISSUED" },
        requestPing: async () => {},
        disconnectActiveHost() {},
      },
      close: async () => {
        throw new Error("ownership changed");
      },
    }),
  });
  assert.equal(cleanupCode, 1);
  assert.equal(cleanupErrors.value(), "ownership changed\n");
});
