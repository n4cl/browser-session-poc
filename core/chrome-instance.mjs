import { spawnSync } from "node:child_process";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

export const DEFAULT_CHROME_EXECUTABLE =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function validateInstanceId(instanceId) {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw new Error(
      "instance ID must be 1-64 characters and contain only letters, numbers, underscores, or hyphens",
    );
  }
  return instanceId;
}

export function resolveInstancePaths({ runtimeRoot, instanceId }) {
  validateInstanceId(instanceId);
  const absoluteRuntimeRoot = path.resolve(runtimeRoot);

  return {
    runtimeRoot: absoluteRuntimeRoot,
    instanceDir: path.join(absoluteRuntimeRoot, "instances", instanceId),
    claimPath: path.join(absoluteRuntimeRoot, "claims", `${instanceId}.claim`),
    statePath: path.join(absoluteRuntimeRoot, "instances", instanceId, "state.json"),
    userDataDir: path.join(absoluteRuntimeRoot, "profiles", instanceId),
  };
}

export function buildChromeArguments({ userDataDir, initialUrl = "about:blank" }) {
  if (!path.isAbsolute(userDataDir)) {
    throw new Error("user data directory must be an absolute path");
  }

  const arguments_ = [
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
  arguments_.push("--new-window", initialUrl);
  return arguments_;
}

export async function assertChromeExecutable(chromeExecutable) {
  await access(chromeExecutable, fsConstants.X_OK);
}

export async function acquireInstanceClaim({ claimPath, owner }) {
  await mkdir(path.dirname(claimPath), { recursive: true, mode: 0o700 });

  let handle;
  try {
    handle = await open(claimPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, "utf8");
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`browser instance is already claimed: ${owner.browser_instance_id}`);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function releaseInstanceClaim(claimPath) {
  await rm(claimPath, { force: true });
}

export async function writeStateAtomically(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, statePath);
}

export async function readState(statePath) {
  return JSON.parse(await readFile(statePath, "utf8"));
}

export function parseProcessIdentity(output) {
  const line = output.trim();
  const match = line.match(/^(.{24})\s+(.+)$/);
  if (!match) {
    return null;
  }

  return { processStart: match[1], command: match[2] };
}

export function readProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }

  const result = spawnSync("ps", ["-ww", "-o", "lstart=", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`unable to inspect process ${pid}: ${result.error.message}`);
  }
  if (result.status === 1 || !result.stdout.trim()) {
    return null;
  }
  if (result.status !== 0) {
    throw new Error(`unable to inspect process ${pid}: ps exited with status ${result.status}`);
  }

  return parseProcessIdentity(result.stdout);
}

export function parseProcessIdentities(output) {
  const lines = output.trim();
  if (!lines) {
    return [];
  }

  return lines.split("\n").map((line) => {
    const match = line.match(/^\s*(\d+)\s+(.{24})\s+(.+)$/);
    if (!match) {
      throw new Error("unable to parse process list output");
    }
    return {
      pid: Number.parseInt(match[1], 10),
      processStart: match[2],
      command: match[3],
    };
  });
}

export function listProcessIdentities() {
  const result = spawnSync("ps", ["-ww", "-o", "pid=", "-o", "lstart=", "-o", "command=", "-ax"], {
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`unable to list processes: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`unable to list processes: ps exited with status ${result.status}`);
  }

  return parseProcessIdentities(result.stdout);
}

export function isExpectedChromeProcess({ chromeExecutable, userDataDir, identity }) {
  if (
    !identity ||
    typeof identity.command !== "string" ||
    typeof chromeExecutable !== "string" ||
    typeof userDataDir !== "string"
  ) {
    return false;
  }

  const executablePrefix = `${chromeExecutable} `;
  if (!identity.command.startsWith(executablePrefix)) {
    return false;
  }

  const profileArgument = `--user-data-dir=${userDataDir}`;
  const profileIndex = identity.command.indexOf(profileArgument);
  if (profileIndex === -1) {
    return false;
  }
  const before = identity.command[profileIndex - 1];
  const after = identity.command[profileIndex + profileArgument.length];
  return (before === " " || before === "\t") && (after === undefined || after === " " || after === "\t");
}

export function processMatchesState({ state, identity }) {
  if (!state || !identity || typeof state.process_start !== "string") {
    return false;
  }
  return (
    identity.processStart === state.process_start &&
    isExpectedChromeProcess({
      chromeExecutable: state.chrome_executable,
      userDataDir: state.user_data_dir,
      identity,
    })
  );
}

export async function recoverStaleChrome({
  state,
  statePath,
  claimPath,
  readIdentity = readProcessIdentity,
  listIdentities = listProcessIdentities,
  writeState = writeStateAtomically,
  releaseClaim = releaseInstanceClaim,
  now = () => new Date().toISOString(),
}) {
  if (!Number.isSafeInteger(state?.chrome_pid) || state.chrome_pid <= 0) {
    throw new Error("refusing to recover state without a valid recorded Chrome PID");
  }

  if (readIdentity(state.chrome_pid) !== null) {
    throw new Error("refusing to recover: recorded Chrome PID is still assigned");
  }

  const matchingProcess = listIdentities().find((identity) =>
    isExpectedChromeProcess({
      chromeExecutable: state.chrome_executable,
      userDataDir: state.user_data_dir,
      identity,
    }),
  );
  if (matchingProcess) {
    throw new Error("refusing to recover: a Chrome process still uses the recorded user data directory");
  }

  const recoveredState = {
    ...state,
    state: "recovered",
    recovered_at: now(),
  };
  await writeState(statePath, recoveredState);
  await releaseClaim(claimPath);
  return recoveredState;
}

export async function waitForProcessExit({
  pid,
  readIdentity = readProcessIdentity,
  timeoutMs = 10_000,
  pollMs = 100,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (readIdentity(pid) === null) {
      return true;
    }
    await sleep(pollMs);
  }
  return false;
}

export async function terminateOwnedChrome({
  state,
  readIdentity = readProcessIdentity,
  killProcess = process.kill,
  waitForExit = waitForProcessExit,
}) {
  const identity = readIdentity(state.chrome_pid);
  if (!processMatchesState({ state, identity })) {
    throw new Error("refusing to stop process: recorded Chrome identity no longer matches");
  }

  killProcess(state.chrome_pid, "SIGTERM");
  return waitForExit({ pid: state.chrome_pid, readIdentity });
}
