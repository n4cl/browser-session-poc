#!/usr/bin/env node

import os from "node:os";
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
    "  npm run native-host -- plan",
    "  npm run native-host -- install",
    "  npm run native-host -- uninstall",
    "",
    "Environment:",
    "  BROWSER_POC_RUNTIME_ROOT       Runtime directory (default: .runtime)",
    "  BROWSER_POC_NATIVE_HOSTS_DIR  Native Messaging manifest directory",
  ].join("\n");
}

function configuration() {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const runtimeRoot = process.env.BROWSER_POC_RUNTIME_ROOT
    ? path.resolve(process.env.BROWSER_POC_RUNTIME_ROOT)
    : path.join(repositoryRoot, ".runtime");
  const nativeHostsDir = process.env.BROWSER_POC_NATIVE_HOSTS_DIR
    ? path.resolve(process.env.BROWSER_POC_NATIVE_HOSTS_DIR)
    : path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "NativeMessagingHosts",
      );
  return resolveNativeHostPaths({
    repositoryRoot,
    runtimeRoot,
    nativeHostsDir,
    executablePath: process.execPath,
  });
}

const [command, ...extraArguments] = process.argv.slice(2);
if (!command || extraArguments.length > 0 || !["plan", "install", "uninstall"].includes(command)) {
  process.stderr.write(`${usage()}\n`);
  process.exit(2);
}

try {
  const paths = configuration();
  if (command === "plan") {
    process.stdout.write(
      `${JSON.stringify(
        {
          native_host_name: "com.browser_session_poc.gate1",
          manifest_path: paths.manifestPath,
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
