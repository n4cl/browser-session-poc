import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { resolveInstancePaths } from "./chrome-instance.mjs";

export const PAIRING_DESCRIPTOR_SCHEMA_VERSION = 1;
export const PROFILE_METADATA_SCHEMA_VERSION = 1;
export const MACOS_UNIX_SOCKET_PATH_MAX_BYTES = 103;

const PROFILE_METADATA_DIRECTORY = ".browser-session-poc";
const PROFILE_METADATA_FILENAME = "profile-metadata.json";
const ACTIVE_DESCRIPTOR_FILENAME = "active-descriptor.json";
const SOCKET_DIRECTORY = "sockets";
const PAIRING_DIRECTORY = "pairing";

const PROFILE_METADATA_FIELDS = ["schema_version", "browser_instance_id", "profile_instance_id"];
const DESCRIPTOR_FIELDS = [
  "schema_version",
  "session_id",
  "browser_instance_id",
  "profile_instance_id",
  "generation",
  "lease_id",
  "pairing_nonce",
  "socket_path",
  "issued_at",
  "expires_at",
];

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function assertPathWithin(root, candidate, label) {
  const resolvedRoot = assertAbsolutePath(root, "runtime root");
  const resolvedCandidate = assertAbsolutePath(candidate, label);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} must remain within the runtime root`);
  }
  return resolvedCandidate;
}

function assertExactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${label} has an unexpected schema`);
  }
}

function assertOpaqueId(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function parseIsoInstant(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be an ISO-8601 UTC timestamp`);
  }
  return timestamp;
}

function modeOf(stat) {
  return stat.mode & 0o777;
}

async function inspectExistingPath(filePath, label) {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link`);
    }
    return info;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function ensurePrivateDirectory(directory, runtimeRoot, label) {
  const resolvedDirectory = assertPathWithin(runtimeRoot, directory, label);
  const existing = await inspectExistingPath(resolvedDirectory, label);
  if (existing === null) {
    await mkdir(resolvedDirectory, { recursive: true, mode: 0o700 });
  } else if (!existing.isDirectory()) {
    throw new Error(`${label} must be a directory`);
  }

  const created = await inspectExistingPath(resolvedDirectory, label);
  if (!created?.isDirectory() || modeOf(created) !== 0o700) {
    throw new Error(`${label} must have mode 0700`);
  }
  return resolvedDirectory;
}

async function readPrivateJson(filePath, mode, label) {
  const info = await inspectExistingPath(filePath, label);
  if (info === null) {
    return null;
  }
  if (!info.isFile() || modeOf(info) !== mode) {
    throw new Error(`${label} must be a regular file with mode ${mode.toString(8)}`);
  }
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    throw new Error(`${label} must contain valid JSON`);
  }
}

async function createFileWithoutOverwrite(filePath, content, mode) {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle?.close();
    handle = undefined;
    try {
      await link(temporaryPath, filePath);
      return true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        return false;
      }
      throw error;
    }
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}

function equalFields(first, second, fields) {
  return fields.every((field) => first[field] === second[field]);
}

function assertSocketFilename(socketPath, socketDirectory) {
  if (path.dirname(socketPath) !== socketDirectory || !/^s-[a-f0-9]{32}\.sock$/.test(path.basename(socketPath))) {
    throw new Error("socket path must use the managed short random socket name");
  }
}

export function resolvePairingPaths({ runtimeRoot, instanceId }) {
  const instancePaths = resolveInstancePaths({ runtimeRoot, instanceId });
  const runtime = assertAbsolutePath(instancePaths.runtimeRoot, "runtime root");
  const profileMetadataDirectory = path.join(instancePaths.userDataDir, PROFILE_METADATA_DIRECTORY);
  const pairingDirectory = path.join(instancePaths.instanceDir, PAIRING_DIRECTORY);

  return {
    ...instancePaths,
    instanceId,
    profileMetadataDirectory,
    profileMetadataPath: path.join(profileMetadataDirectory, PROFILE_METADATA_FILENAME),
    pairingDirectory,
    activeDescriptorPath: path.join(pairingDirectory, ACTIVE_DESCRIPTOR_FILENAME),
    socketDirectory: path.join(runtime, SOCKET_DIRECTORY),
  };
}

export function validateProfileMetadata(metadata, { browserInstanceId }) {
  assertExactFields(metadata, PROFILE_METADATA_FIELDS, "profile metadata");
  if (metadata.schema_version !== PROFILE_METADATA_SCHEMA_VERSION) {
    throw new Error("profile metadata has an unsupported schema version");
  }
  if (metadata.browser_instance_id !== browserInstanceId) {
    throw new Error("profile metadata browser instance does not match");
  }
  assertOpaqueId(metadata.profile_instance_id, "profile metadata profile_instance_id");
  return metadata;
}

async function ensureProfileScope(paths) {
  await ensurePrivateDirectory(paths.runtimeRoot, paths.runtimeRoot, "runtime directory");
  await ensurePrivateDirectory(path.join(paths.runtimeRoot, "profiles"), paths.runtimeRoot, "profiles directory");
  await ensurePrivateDirectory(paths.userDataDir, paths.runtimeRoot, "user data directory");
  await ensurePrivateDirectory(
    paths.profileMetadataDirectory,
    paths.runtimeRoot,
    "profile metadata directory",
  );
}

async function ensureDescriptorScope(paths) {
  await ensurePrivateDirectory(paths.runtimeRoot, paths.runtimeRoot, "runtime directory");
  await ensurePrivateDirectory(path.join(paths.runtimeRoot, "instances"), paths.runtimeRoot, "instances directory");
  await ensurePrivateDirectory(paths.instanceDir, paths.runtimeRoot, "instance directory");
  await ensurePrivateDirectory(paths.pairingDirectory, paths.runtimeRoot, "pairing directory");
}

export async function loadOrCreateProfileMetadata(paths, { createUuid = randomUUID } = {}) {
  await ensureProfileScope(paths);
  const existing = await readPrivateJson(paths.profileMetadataPath, 0o600, "profile metadata");
  if (existing !== null) {
    return validateProfileMetadata(existing, { browserInstanceId: paths.instanceId });
  }

  const metadata = {
    schema_version: PROFILE_METADATA_SCHEMA_VERSION,
    browser_instance_id: paths.instanceId,
    profile_instance_id: createUuid(),
  };
  validateProfileMetadata(metadata, { browserInstanceId: paths.instanceId });
  const created = await createFileWithoutOverwrite(
    paths.profileMetadataPath,
    `${JSON.stringify(metadata)}\n`,
    0o600,
  );
  if (created) {
    return metadata;
  }

  const concurrent = await readPrivateJson(paths.profileMetadataPath, 0o600, "profile metadata");
  return validateProfileMetadata(concurrent, { browserInstanceId: paths.instanceId });
}

export async function createSocketPath(paths, { createUuid = randomUUID } = {}) {
  await ensurePrivateDirectory(paths.runtimeRoot, paths.runtimeRoot, "runtime directory");
  const socketDirectory = await ensurePrivateDirectory(
    paths.socketDirectory,
    paths.runtimeRoot,
    "socket directory",
  );
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = createUuid().replaceAll("-", "");
    if (!/^[a-f0-9]{32}$/.test(token)) {
      throw new Error("socket UUID must produce 32 hexadecimal characters");
    }
    const socketPath = path.join(socketDirectory, `s-${token}.sock`);
    validateSocketPath(socketPath, paths);
    if ((await inspectExistingPath(socketPath, "socket path")) === null) {
      return socketPath;
    }
  }
  throw new Error("unable to allocate a unique socket path");
}

export function validateSocketPath(socketPath, paths) {
  const resolvedSocketPath = assertPathWithin(paths.runtimeRoot, socketPath, "socket path");
  if (resolvedSocketPath !== socketPath) {
    throw new Error("socket path must be normalized");
  }
  const socketDirectory = assertPathWithin(paths.runtimeRoot, paths.socketDirectory, "socket directory");
  assertSocketFilename(resolvedSocketPath, socketDirectory);
  if (Buffer.byteLength(resolvedSocketPath, "utf8") > MACOS_UNIX_SOCKET_PATH_MAX_BYTES) {
    throw new Error("socket path exceeds the macOS Unix socket path limit");
  }
  return resolvedSocketPath;
}

export function validatePairingDescriptor(descriptor, { paths, profileInstanceId, now = new Date() }) {
  assertExactFields(descriptor, DESCRIPTOR_FIELDS, "pairing descriptor");
  if (descriptor.schema_version !== PAIRING_DESCRIPTOR_SCHEMA_VERSION) {
    throw new Error("pairing descriptor has an unsupported schema version");
  }
  assertOpaqueId(descriptor.session_id, "pairing descriptor session_id");
  if (descriptor.browser_instance_id !== paths.instanceId) {
    throw new Error("pairing descriptor browser instance does not match");
  }
  if (descriptor.profile_instance_id !== profileInstanceId) {
    throw new Error("pairing descriptor profile instance does not match");
  }
  if (!Number.isSafeInteger(descriptor.generation) || descriptor.generation <= 0) {
    throw new Error("pairing descriptor generation must be a positive safe integer");
  }
  assertOpaqueId(descriptor.lease_id, "pairing descriptor lease_id");
  assertOpaqueId(descriptor.pairing_nonce, "pairing descriptor pairing_nonce");
  validateSocketPath(descriptor.socket_path, paths);
  const issuedAt = parseIsoInstant(descriptor.issued_at, "pairing descriptor issued_at");
  const expiresAt = parseIsoInstant(descriptor.expires_at, "pairing descriptor expires_at");
  if (expiresAt <= issuedAt) {
    throw new Error("pairing descriptor expires_at must be after issued_at");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
    throw new Error("descriptor validation time must be a valid Date");
  }
  if (expiresAt <= now.valueOf()) {
    throw new Error("pairing descriptor has expired");
  }
  return descriptor;
}

export function createPairingDescriptor({
  paths,
  profileInstanceId,
  sessionId,
  generation,
  socketPath,
  issuedAt,
  expiresAt,
  leaseId = randomUUID(),
  pairingNonce = randomUUID(),
}) {
  const descriptor = {
    schema_version: PAIRING_DESCRIPTOR_SCHEMA_VERSION,
    session_id: sessionId,
    browser_instance_id: paths.instanceId,
    profile_instance_id: profileInstanceId,
    generation,
    lease_id: leaseId,
    pairing_nonce: pairingNonce,
    socket_path: socketPath,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  return validatePairingDescriptor(descriptor, { paths, profileInstanceId, now: new Date(issuedAt) });
}

export async function writeActivePairingDescriptor(
  paths,
  descriptor,
  { profileInstanceId, now = new Date() } = {},
) {
  await ensureDescriptorScope(paths);
  await ensurePrivateDirectory(paths.socketDirectory, paths.runtimeRoot, "socket directory");
  validatePairingDescriptor(descriptor, { paths, profileInstanceId, now });
  const existing = await readPrivateJson(paths.activeDescriptorPath, 0o600, "active pairing descriptor");
  if (existing !== null) {
    validatePairingDescriptor(existing, { paths, profileInstanceId, now });
    if (!equalFields(existing, descriptor, DESCRIPTOR_FIELDS)) {
      throw new Error("refusing to overwrite a different active pairing descriptor");
    }
    return { created: false, descriptor: existing };
  }

  const created = await createFileWithoutOverwrite(
    paths.activeDescriptorPath,
    `${JSON.stringify(descriptor)}\n`,
    0o600,
  );
  if (created) {
    return { created: true, descriptor };
  }

  const concurrent = await readPrivateJson(paths.activeDescriptorPath, 0o600, "active pairing descriptor");
  validatePairingDescriptor(concurrent, { paths, profileInstanceId, now });
  if (!equalFields(concurrent, descriptor, DESCRIPTOR_FIELDS)) {
    throw new Error("refusing to overwrite a different active pairing descriptor");
  }
  return { created: false, descriptor: concurrent };
}
