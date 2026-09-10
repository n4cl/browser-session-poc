#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DEFAULT_CHROME_EXECUTABLE,
  acquireInstanceClaim,
  assertChromeExecutable,
  buildChromeArguments,
  isExpectedChromeProcess,
  processMatchesState,
  readProcessIdentity,
  readState,
  recoverStaleChrome,
  releaseInstanceClaim,
  resolveInstancePaths,
  terminateOwnedChrome,
  writeStateAtomically,
} from "../core/chrome-instance.mjs";
import { reloadManagedExtension } from "../core/extension-reloader.mjs";

function usage() {
  return [
    "Usage:",
    "  npm run chrome -- plan <instance-id>",
    "  npm run chrome -- start <instance-id>",
    "  npm run chrome -- provision <instance-id>",
    "  npm run chrome -- status <instance-id>",
    "  npm run chrome -- stop <instance-id>",
    "  npm run chrome -- recover <instance-id>",
    "  npm run chrome -- reload-extension <instance-id>",
    "",
    "Environment:",
    "  BROWSER_POC_RUNTIME_ROOT  Runtime directory (default: .runtime)",
    "  BROWSER_POC_CHROME        Chrome executable path",
  ].join("\n");
}

function configuration(instanceId, { initialUrl = "about:blank", enableRemoteDebugging = false } = {}) {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const runtimeRoot = process.env.BROWSER_POC_RUNTIME_ROOT
    ? path.resolve(process.env.BROWSER_POC_RUNTIME_ROOT)
    : path.join(repositoryRoot, ".runtime");
  const chromeExecutable =
    process.env.BROWSER_POC_CHROME || DEFAULT_CHROME_EXECUTABLE;
  const paths = resolveInstancePaths({ runtimeRoot, instanceId });
  const extensionDir = path.join(repositoryRoot, "extension");
  const chromeArguments = buildChromeArguments({
    userDataDir: paths.userDataDir,
    initialUrl,
    remoteDebuggingPort: enableRemoteDebugging ? 0 : null,
  });

  return { instanceId, chromeExecutable, chromeArguments, extensionDir, ...paths };
}

function assertStateMatchesConfiguration(state, config) {
  if (
    state.browser_instance_id !== config.instanceId ||
    state.chrome_executable !== config.chromeExecutable ||
    state.user_data_dir !== config.userDataDir
  ) {
    throw new Error("refusing to use state that does not match the requested browser instance");
  }
}

function assertProcessInspectionAvailable() {
  if (!readProcessIdentity(process.pid)) {
    throw new Error("cannot inspect local processes; refusing to start Chrome without safe ownership checks");
  }
}

async function plan(instanceId) {
  const config = configuration(instanceId);
  await assertChromeExecutable(config.chromeExecutable);
  process.stdout.write(
    `${JSON.stringify(
      {
        browser_instance_id: config.instanceId,
        chrome_executable: config.chromeExecutable,
        chrome_arguments: config.chromeArguments,
        manual_extension_directory: config.extensionDir,
        user_data_dir: config.userDataDir,
        state_path: config.statePath,
        claim_path: config.claimPath,
      },
      null,
      2,
    )}\n`,
  );
}

async function start(
  instanceId,
  {
    initialUrl = "about:blank",
    showManualExtensionDirectory = false,
    enableRemoteDebugging = false,
    quiet = false,
  } = {},
) {
  const config = configuration(instanceId, { initialUrl, enableRemoteDebugging });
  await assertChromeExecutable(config.chromeExecutable);
  assertProcessInspectionAvailable();
  const owner = {
    browser_instance_id: instanceId,
    launcher_pid: process.pid,
    claimed_at: new Date().toISOString(),
  };
  await acquireInstanceClaim({ claimPath: config.claimPath, owner });

  let child;
  let identity;
  let stateWritten = false;
  try {
    await mkdir(config.userDataDir, { recursive: true, mode: 0o700 });
    child = spawn(config.chromeExecutable, config.chromeArguments, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    await new Promise((resolve) => setTimeout(resolve, 500));
    identity = readProcessIdentity(child.pid);
    if (!identity) {
      throw new Error("Chrome process exited before its identity could be recorded");
    }
    if (
      !isExpectedChromeProcess({
        chromeExecutable: config.chromeExecutable,
        userDataDir: config.userDataDir,
        identity,
      })
    ) {
      throw new Error("refusing to record Chrome process with an unexpected executable or profile");
    }

    const state = {
      schema_version: 1,
      browser_instance_id: instanceId,
      chrome_executable: config.chromeExecutable,
      chrome_pid: child.pid,
      process_start: identity.processStart,
      user_data_dir: config.userDataDir,
      started_at: new Date().toISOString(),
      state: "running",
    };
    await writeStateAtomically(config.statePath, state);
    stateWritten = true;
    if (!quiet) {
      process.stdout.write(
        `${JSON.stringify(
          showManualExtensionDirectory
            ? {
                ...state,
                manual_extension_directory: config.extensionDir,
                next_step: "Use Load unpacked in chrome://extensions and select manual_extension_directory",
              }
            : state,
          null,
          2,
        )}\n`,
      );
    }
  } catch (error) {
    if (!child) {
      await releaseInstanceClaim(config.claimPath);
    } else if (identity && !stateWritten) {
      const rollbackState = {
        chrome_executable: config.chromeExecutable,
        chrome_pid: child.pid,
        process_start: identity.processStart,
        user_data_dir: config.userDataDir,
      };
      const stopped = await terminateOwnedChrome({ state: rollbackState });
      if (stopped) {
        await releaseInstanceClaim(config.claimPath);
      }
    }
    throw error;
  }
}

async function status(instanceId) {
  const config = configuration(instanceId);
  const state = await readState(config.statePath);
  assertStateMatchesConfiguration(state, config);
  const identity = readProcessIdentity(state.chrome_pid);
  const running = processMatchesState({ state, identity });
  process.stdout.write(`${JSON.stringify({ ...state, running }, null, 2)}\n`);
  if (!running && state.state !== "stopped") {
    process.exitCode = 1;
  }
}

async function stop(instanceId, { quiet = false } = {}) {
  const config = configuration(instanceId);
  const state = await readState(config.statePath);
  assertStateMatchesConfiguration(state, config);
  const identity = readProcessIdentity(state.chrome_pid);
  if (!processMatchesState({ state, identity })) {
    throw new Error("refusing to stop process: recorded Chrome identity no longer matches");
  }

  await writeStateAtomically(config.statePath, {
    ...state,
    state: "stop_requested",
    stop_requested_at: new Date().toISOString(),
  });
  const stopped = await terminateOwnedChrome({ state });
  if (!stopped) {
    throw new Error("Chrome did not exit before the stop timeout; its claim remains held");
  }
  await writeStateAtomically(config.statePath, {
    ...state,
    state: "stopped",
    stopped_at: new Date().toISOString(),
  });
  await releaseInstanceClaim(config.claimPath);
  if (!quiet) {
    process.stdout.write(`stopped ${instanceId}\n`);
  }
}

async function recover(instanceId) {
  const config = configuration(instanceId);
  const state = await readState(config.statePath);
  assertStateMatchesConfiguration(state, config);
  await recoverStaleChrome({
    state,
    statePath: config.statePath,
    claimPath: config.claimPath,
  });
  process.stdout.write(`recovered ${instanceId}\n`);
}

async function reloadExtension(instanceId) {
  const config = configuration(instanceId);
  const state = await readState(config.statePath);
  assertStateMatchesConfiguration(state, config);
  if (state.state !== "running") {
    throw new Error("refusing to reload Extension: managed Chrome is not running");
  }
  const identity = readProcessIdentity(state.chrome_pid);
  if (!processMatchesState({ state, identity })) {
    throw new Error("refusing to reload Extension: managed Chrome identity no longer matches");
  }

  await stop(instanceId, { quiet: true });
  let maintenanceStarted = false;
  const maintenanceNotBefore = Date.now() - 5_000;
  try {
    await start(instanceId, { enableRemoteDebugging: true, quiet: true });
    maintenanceStarted = true;
    const maintenanceConfig = configuration(instanceId, { enableRemoteDebugging: true });
    const maintenanceState = await readState(maintenanceConfig.statePath);
    assertStateMatchesConfiguration(maintenanceState, maintenanceConfig);
    if (maintenanceState.state !== "running") {
      throw new Error("refusing to reload Extension: maintenance Chrome is not running");
    }
    const maintenanceIdentity = readProcessIdentity(maintenanceState.chrome_pid);
    if (!processMatchesState({ state: maintenanceState, identity: maintenanceIdentity })) {
      throw new Error("refusing to reload Extension: maintenance Chrome identity no longer matches");
    }
    await reloadManagedExtension({
      userDataDir: maintenanceConfig.userDataDir,
      minimumMtimeMs: maintenanceNotBefore,
    });
  } finally {
    if (maintenanceStarted) {
      await stop(instanceId, { quiet: true });
    }
    await start(instanceId, { quiet: true });
  }
  process.stdout.write(`reloaded-extension ${instanceId}\n`);
}

const [command, instanceId, ...extraArguments] = process.argv.slice(2);
if (!command || !instanceId || extraArguments.length > 0) {
  process.stderr.write(`${usage()}\n`);
  process.exit(2);
}

try {
  if (command === "plan") {
    await plan(instanceId);
  } else if (command === "start") {
    await start(instanceId);
  } else if (command === "provision") {
    await start(instanceId, {
      initialUrl: "chrome://extensions",
      showManualExtensionDirectory: true,
    });
  } else if (command === "status") {
    await status(instanceId);
  } else if (command === "stop") {
    await stop(instanceId);
  } else if (command === "recover") {
    await recover(instanceId);
  } else if (command === "reload-extension") {
    await reloadExtension(instanceId);
  } else {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
