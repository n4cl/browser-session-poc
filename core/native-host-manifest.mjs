import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { GATE_1_EXTENSION_ORIGIN } from "./extension-id.mjs";
import { resolveInstancePaths } from "./chrome-instance.mjs";
import { GATE_1_NATIVE_HOST_NAME } from "../native-host/host.mjs";

function requireAbsolutePath(value, label) {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function modeOf(info) {
  return info.mode & 0o777;
}

async function readPrivateRegularFile(filePath, expectedMode, unsafeMessage) {
  let info;
  try {
    info = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || modeOf(info) !== expectedMode) {
    throw new Error(unsafeMessage);
  }
  return await readFile(filePath, "utf8");
}

async function writeAtomically(filePath, content, mode) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}

async function writeAndVerify(filePath, content, mode, unsafeMessage) {
  await writeAtomically(filePath, content, mode);
  const written = await readPrivateRegularFile(filePath, mode, unsafeMessage);
  if (written !== content) {
    throw new Error(unsafeMessage);
  }
}

export function resolveNativeHostPaths({ repositoryRoot, runtimeRoot, instanceId, executablePath }) {
  const root = requireAbsolutePath(repositoryRoot, "repository root");
  const runtime = requireAbsolutePath(runtimeRoot, "runtime root");
  const nodeExecutable = requireAbsolutePath(executablePath, "Node executable");
  const instancePaths = resolveInstancePaths({ runtimeRoot: runtime, instanceId });
  const nativeHostsDir = path.join(instancePaths.userDataDir, "NativeMessagingHosts");
  const wrapperPath = path.join(instancePaths.instanceDir, "native-host", "gate-1-host.sh");

  return {
    browserInstanceId: instanceId,
    hostPath: path.join(root, "native-host", "host.mjs"),
    manifestPath: path.join(nativeHostsDir, `${GATE_1_NATIVE_HOST_NAME}.json`),
    nodeExecutable,
    runtimeRoot: runtime,
    userDataDir: instancePaths.userDataDir,
    wrapperPath,
  };
}

export function nativeHostManifestContent({ wrapperPath }) {
  return `${JSON.stringify(
    {
      name: GATE_1_NATIVE_HOST_NAME,
      description: "Browser Session PoC Gate 1 Native Host",
      path: wrapperPath,
      type: "stdio",
      allowed_origins: [GATE_1_EXTENSION_ORIGIN],
    },
    null,
    2,
  )}\n`;
}

export function nativeHostWrapperContent({ nodeExecutable, hostPath, runtimeRoot, browserInstanceId }) {
  return `#!/bin/sh\nexec ${shellQuote(nodeExecutable)} ${shellQuote(hostPath)} --pairing-runtime-root ${shellQuote(runtimeRoot)} --pairing-instance-id ${shellQuote(browserInstanceId)} "$@"\n`;
}

export function legacyNativeHostWrapperContent({ nodeExecutable, hostPath }) {
  return `#!/bin/sh\nexec ${shellQuote(nodeExecutable)} ${shellQuote(hostPath)} "$@"\n`;
}

export async function installNativeHost(paths) {
  const manifest = nativeHostManifestContent(paths);
  const wrapper = nativeHostWrapperContent(paths);
  const legacyWrapper = legacyNativeHostWrapperContent(paths);
  const manifestUnsafe = "refusing to overwrite an existing Native Messaging manifest";
  const wrapperUnsafe = "refusing to overwrite an existing Native Host wrapper";
  const existingManifest = await readPrivateRegularFile(paths.manifestPath, 0o600, manifestUnsafe);
  if (existingManifest !== null && existingManifest !== manifest) {
    throw new Error(manifestUnsafe);
  }
  const existingWrapper = await readPrivateRegularFile(paths.wrapperPath, 0o700, wrapperUnsafe);
  if (
    existingWrapper !== null &&
    existingWrapper !== wrapper &&
    existingWrapper !== legacyWrapper
  ) {
    throw new Error(wrapperUnsafe);
  }

  let manifestInstalled = false;
  let wrapperUpgraded = false;
  if (existingManifest === null) {
    await writeAndVerify(paths.manifestPath, manifest, 0o600, manifestUnsafe);
    manifestInstalled = true;
  }
  if (existingWrapper === null) {
    await writeAndVerify(paths.wrapperPath, wrapper, 0o700, wrapperUnsafe);
  } else if (existingWrapper === legacyWrapper) {
    await writeAndVerify(paths.wrapperPath, wrapper, 0o700, wrapperUnsafe);
    wrapperUpgraded = true;
  }

  return {
    installed: manifestInstalled,
    upgraded: wrapperUpgraded,
    manifestPath: paths.manifestPath,
  };
}

export async function uninstallNativeHost(paths) {
  const manifest = nativeHostManifestContent(paths);
  const wrapper = nativeHostWrapperContent(paths);
  const manifestUnsafe = "refusing to remove a Native Messaging manifest not generated by this PoC";
  const wrapperUnsafe = "refusing to remove a Native Host wrapper not generated by this PoC";
  const existingManifest = await readPrivateRegularFile(paths.manifestPath, 0o600, manifestUnsafe);
  if (existingManifest === null) {
    return { removed: false, reason: "manifest_missing" };
  }
  if (existingManifest !== manifest) {
    throw new Error(manifestUnsafe);
  }

  const existingWrapper = await readPrivateRegularFile(paths.wrapperPath, 0o700, wrapperUnsafe);
  if (existingWrapper !== null && existingWrapper !== wrapper) {
    throw new Error(wrapperUnsafe);
  }

  await rm(paths.manifestPath);
  if (existingWrapper !== null) {
    await rm(paths.wrapperPath);
  }
  return { removed: true };
}
