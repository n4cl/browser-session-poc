#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  installNativeHost,
  resolveNativeHostPaths,
  uninstallNativeHost,
} from "../core/native-host-manifest.mjs";

function usage() {
  return [
    "Usage:",
    "  npm run native-host -- plan <instance-id>",
    "  npm run native-host -- install <instance-id>",
    "  npm run native-host -- uninstall <instance-id>",
    "",
    "Environment:",
    "  BROWSER_POC_RUNTIME_ROOT  Runtime directory (default: .runtime)",
  ].join("\n");
}

function configuration(instanceId) {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const runtimeRoot = process.env.BROWSER_POC_RUNTIME_ROOT
    ? path.resolve(process.env.BROWSER_POC_RUNTIME_ROOT)
    : path.join(repositoryRoot, ".runtime");
  return resolveNativeHostPaths({
    repositoryRoot,
    runtimeRoot,
    instanceId,
    executablePath: process.execPath,
  });
}

const [command, instanceId, ...extraArguments] = process.argv.slice(2);
if (
  !command ||
  !instanceId ||
  extraArguments.length > 0 ||
  !["plan", "install", "uninstall"].includes(command)
) {
  process.stderr.write(`${usage()}\n`);
  process.exit(2);
}

try {
  const paths = configuration(instanceId);
  if (command === "plan") {
    process.stdout.write(
      `${JSON.stringify(
        {
          browser_instance_id: paths.browserInstanceId,
          native_host_name: "com.browser_session_poc.gate1",
          manifest_path: paths.manifestPath,
          user_data_dir: paths.userDataDir,
          wrapper_path: paths.wrapperPath,
        },
        null,
        2,
      )}\n`,
    );
  } else if (command === "install") {
    const result = await installNativeHost(paths);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const result = await uninstallNativeHost(paths);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
