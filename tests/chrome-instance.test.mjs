import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  acquireInstanceClaim,
  buildChromeArguments,
  parseProcessIdentity,
  processMatchesState,
  readState,
  releaseInstanceClaim,
  resolveInstancePaths,
  terminateOwnedChrome,
  validateInstanceId,
  waitForProcessExit,
  writeStateAtomically,
} from "../core/chrome-instance.mjs";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";

test("instance ID accepts bounded filesystem-safe values", () => {
  assert.equal(validateInstanceId("session-A_01"), "session-A_01");
  assert.throws(() => validateInstanceId("../escape"));
  assert.throws(() => validateInstanceId("contains/slash"));
  assert.throws(() => validateInstanceId(""));
});

test("instance paths are isolated by browser instance ID", () => {
  const a = resolveInstancePaths({ runtimeRoot: "/tmp/browser-poc", instanceId: "a" });
  const b = resolveInstancePaths({ runtimeRoot: "/tmp/browser-poc", instanceId: "b" });
  assert.notEqual(a.userDataDir, b.userDataDir);
  assert.equal(a.userDataDir, path.resolve("/tmp/browser-poc/profiles/a"));
});

test("Chrome arguments use an absolute dedicated profile and never auto-load an extension", () => {
  const args = buildChromeArguments({
    userDataDir: "/tmp/browser-poc/profiles/a",
  });
  assert.ok(args.includes("--user-data-dir=/tmp/browser-poc/profiles/a"));
  assert.equal(args.some((argument) => argument.startsWith("--load-extension=")), false);
  assert.throws(() => buildChromeArguments({ userDataDir: "relative/profile" }));
});

test("provisioning arguments open chrome extensions without auto-loading", () => {
  const args = buildChromeArguments({
    userDataDir: "/tmp/browser-poc/profiles/a",
    initialUrl: "chrome://extensions",
  });
  assert.equal(args.at(-1), "chrome://extensions");
  assert.equal(
    args.some((argument) => argument.startsWith("--load-extension=")),
    false,
  );
});

test("claim acquisition rejects a second owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-poc-claim-"));
  const claimPath = path.join(root, "a.claim");
  const owner = { browser_instance_id: "a" };

  await acquireInstanceClaim({ claimPath, owner });
  await assert.rejects(() => acquireInstanceClaim({ claimPath, owner }), /already claimed/);
  assert.equal(JSON.parse(await readFile(claimPath, "utf8")).browser_instance_id, "a");
  await releaseInstanceClaim(claimPath);
});

test("state writes are readable after atomic replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-poc-state-"));
  const statePath = path.join(root, "instances", "a", "state.json");
  await writeStateAtomically(statePath, { browser_instance_id: "a", generation: 1 });
  await writeStateAtomically(statePath, { browser_instance_id: "a", generation: 2 });
  assert.deepEqual(await readState(statePath), { browser_instance_id: "a", generation: 2 });
});

test("process identity must match executable, start time, and user data directory", () => {
  const state = {
    chrome_executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    process_start: "Thu Sep 4 12:00:00 2026",
    user_data_dir: "/tmp/browser-poc/profiles/a",
  };
  const identity = {
    processStart: "Thu Sep 4 12:00:00 2026",
    command:
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/browser-poc/profiles/a",
  };

  assert.equal(processMatchesState({ state, identity }), true);
  assert.equal(
    processMatchesState({ state, identity: { ...identity, processStart: "Thu Sep 4 12:00:01 2026" } }),
    false,
  );
  assert.equal(
    processMatchesState({
      state,
      identity: { ...identity, command: identity.command.replace("profiles/a", "profiles/b") },
    }),
    false,
  );
  assert.equal(processMatchesState({ state, identity: null }), false);
  assert.equal(
    processMatchesState({
      state,
      identity: { ...identity, command: `${state.chrome_executable}-backup --user-data-dir=${state.user_data_dir}` },
    }),
    false,
  );
  assert.equal(
    processMatchesState({
      state,
      identity: { ...identity, command: identity.command.replace("profiles/a", "profiles/ab") },
    }),
    false,
  );
});

test("process identity parser preserves macOS single-digit day output", () => {
  assert.deepEqual(
    parseProcessIdentity(
      "Thu Sep  4 12:00:00 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/a\n",
    ),
    {
      processStart: "Thu Sep  4 12:00:00 2026",
      command:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --user-data-dir=/tmp/a",
    },
  );
  assert.equal(parseProcessIdentity("not ps output"), null);
});

test("owned Chrome termination refuses an identity mismatch before sending a signal", async () => {
  const state = {
    chrome_executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    chrome_pid: 42,
    process_start: "Thu Sep  4 12:00:00 2026",
    user_data_dir: "/tmp/browser-poc/profiles/a",
  };
  let killed = false;

  await assert.rejects(
    () =>
      terminateOwnedChrome({
        state,
        readIdentity: () => null,
        killProcess: () => {
          killed = true;
        },
      }),
    /identity no longer matches/,
  );
  assert.equal(killed, false);
});

test("owned Chrome termination waits for confirmed exit", async () => {
  const state = {
    chrome_executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    chrome_pid: 42,
    process_start: "Thu Sep  4 12:00:00 2026",
    user_data_dir: "/tmp/browser-poc/profiles/a",
  };
  const identity = {
    processStart: state.process_start,
    command: `${state.chrome_executable} --user-data-dir=${state.user_data_dir}`,
  };
  let reads = 0;
  let signal;

  const stopped = await terminateOwnedChrome({
    state,
    readIdentity: () => (reads++ < 2 ? identity : null),
    killProcess: (pid, receivedSignal) => {
      signal = { pid, receivedSignal };
    },
    waitForExit: ({ pid, readIdentity }) =>
      waitForProcessExit({ pid, readIdentity, timeoutMs: 20, pollMs: 0 }),
  });

  assert.equal(stopped, true);
  assert.deepEqual(signal, { pid: 42, receivedSignal: "SIGTERM" });
});
