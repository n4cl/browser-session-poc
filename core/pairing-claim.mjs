import net from "node:net";
import { lstat, mkdir, open, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { listProcessIdentities, readProcessIdentity } from "./chrome-instance.mjs";
import {
  readProfileMetadata,
  resolvePairingPaths,
  validatePairingDescriptor,
} from "./pairing-descriptor.mjs";

export const PAIRING_CLAIM_SCHEMA_VERSION = 2;

const CLAIM_FIELDS = [
  "schema_version", "browser_instance_id", "owner_id", "pid", "process_start",
  "process_command", "executable", "runtime_root",
];

function modeOf(info) {
  return info.mode & 0o777;
}

async function lstatOrNull(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertExactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`${label} has an unexpected schema`);
  }
}

function assertPrivateRegular(info, mode, label) {
  if (!info?.isFile() || info.isSymbolicLink() || modeOf(info) !== mode) {
    throw new Error(`${label} must be a non-symlink regular file with mode ${mode.toString(8)}`);
  }
}

function assertPrivateDirectory(info, label) {
  if (!info?.isDirectory() || info.isSymbolicLink() || modeOf(info) !== 0o700) {
    throw new Error(`${label} must be a non-symlink directory with mode 700`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function claimPath(paths) {
  return path.join(paths.runtimeRoot, "pairing-claims", `${paths.instanceId}.claim`);
}

function ownsClaim(claim, identity) {
  return identity !== null &&
    identity.processStart === claim.process_start &&
    identity.command === claim.process_command;
}

function isLegacyClaim(claim, paths) {
  return claim && typeof claim === "object" && !Array.isArray(claim) &&
    Object.keys(claim).length === 2 && claim.instance_id === paths.instanceId &&
    typeof claim.owner_id === "string" && claim.owner_id.length > 0;
}

function isLegacyHarness(identity, instanceId) {
  const instancePattern = new RegExp(`(^|[\\s'\"])${instanceId}($|[\\s'\"])`);
  return Boolean(identity?.command?.includes("pairing-session.mjs") && instancePattern.test(identity.command));
}

async function writeNewPrivateFile(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readClaim(filePath) {
  const info = await lstatOrNull(filePath);
  if (info === null) return null;
  assertPrivateRegular(info, 0o600, "pairing claim");
  const content = await readFile(filePath, "utf8");
  try {
    return { claim: JSON.parse(content), ownership: { dev: info.dev, ino: info.ino, content } };
  } catch {
    throw new Error("pairing claim must contain valid JSON");
  }
}

async function removeOwnedFile(filePath, ownership, label) {
  const current = await lstatOrNull(filePath);
  if (current === null) return;
  assertPrivateRegular(current, 0o600, label);
  if (current.dev !== ownership.dev || current.ino !== ownership.ino || (await readFile(filePath, "utf8")) !== ownership.content) {
    throw new Error(`refusing to remove changed ${label}`);
  }
  await rm(filePath);
}

async function inspectDescriptor(paths, now) {
  const info = await lstatOrNull(paths.activeDescriptorPath);
  if (info === null) return null;
  assertPrivateDirectory(await lstatOrNull(paths.pairingDirectory), "pairing descriptor directory");
  assertPrivateDirectory(await lstatOrNull(paths.socketDirectory), "pairing socket directory");
  assertPrivateRegular(info, 0o600, "active pairing descriptor");
  const content = await readFile(paths.activeDescriptorPath, "utf8");
  let descriptor;
  try { descriptor = JSON.parse(content); } catch { throw new Error("active pairing descriptor must contain valid JSON"); }
  const metadata = await readProfileMetadata(paths);
  validatePairingDescriptor(descriptor, { paths, profileInstanceId: metadata.profile_instance_id, now: new Date(descriptor.issued_at) });
  if (!path.resolve(descriptor.socket_path).startsWith(`${path.resolve(paths.runtimeRoot)}${path.sep}`)) {
    throw new Error("active pairing descriptor socket path is outside the runtime root");
  }
  const socketInfo = await lstatOrNull(descriptor.socket_path);
  if (socketInfo !== null && (socketInfo.isSymbolicLink() || !socketInfo.isSocket() || modeOf(socketInfo) !== 0o600)) {
    throw new Error("pairing socket must be a non-symlink socket with mode 600");
  }
  return {
    descriptor,
    expired: Date.parse(descriptor.expires_at) <= now.valueOf(),
    descriptorOwnership: { dev: info.dev, ino: info.ino, content },
    socketOwnership: socketInfo && { dev: socketInfo.dev, ino: socketInfo.ino },
  };
}

async function removeOwnedSocket(socketPath, ownership) {
  const current = await lstatOrNull(socketPath);
  if (current === null) return;
  if (current.isSymbolicLink() || !current.isSocket() || modeOf(current) !== 0o600 || current.dev !== ownership.dev || current.ino !== ownership.ino) {
    throw new Error("refusing to remove changed pairing socket");
  }
  await unlink(socketPath);
}

export function validatePairingClaim(claim, { paths }) {
  assertExactFields(claim, CLAIM_FIELDS, "pairing claim");
  if (claim.schema_version !== PAIRING_CLAIM_SCHEMA_VERSION || claim.browser_instance_id !== paths.instanceId || claim.runtime_root !== paths.runtimeRoot) {
    throw new Error("pairing claim does not match this instance");
  }
  if (!Number.isSafeInteger(claim.pid) || claim.pid <= 0 || !path.isAbsolute(claim.executable)) {
    throw new Error("pairing claim has an invalid process identity");
  }
  for (const field of ["owner_id", "process_start", "process_command", "executable"]) assertNonEmptyString(claim[field], `pairing claim ${field}`);
  return claim;
}

export function createPairingClaim({ paths, ownerId, pid, identity, executable }) {
  if (!identity?.processStart || !identity?.command) throw new Error("unable to record pairing harness process identity");
  return validatePairingClaim({ schema_version: PAIRING_CLAIM_SCHEMA_VERSION, browser_instance_id: paths.instanceId, owner_id: ownerId, pid, process_start: identity.processStart, process_command: identity.command, executable, runtime_root: paths.runtimeRoot }, { paths });
}

export function probePairingSocket(socketPath, { timeoutMs = 250 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => socket.destroy(), timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); socket.end(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
    socket.once("close", () => { clearTimeout(timer); resolve(false); });
  });
}

export async function recoverStalePairingClaim({ runtimeRoot, instanceId, now = () => new Date(), readIdentity = readProcessIdentity, listIdentities = listProcessIdentities, probeSocket = probePairingSocket, requesterPid = null }) {
  const paths = resolvePairingPaths({ runtimeRoot, instanceId });
  const recorded = await readClaim(claimPath(paths));
  if (recorded === null) return { recovered: false, reason: "claim_missing" };
  const recoveryTime = now();
  if (!(recoveryTime instanceof Date) || !Number.isFinite(recoveryTime.valueOf())) throw new TypeError("now must return a valid Date");
  const legacy = isLegacyClaim(recorded.claim, paths);
  if (legacy) {
    if (listIdentities().some((identity) => identity.pid !== requesterPid && isLegacyHarness(identity, paths.instanceId))) throw new Error("refusing to recover: a legacy pairing harness process may still be running");
  } else {
    validatePairingClaim(recorded.claim, { paths });
    if (ownsClaim(recorded.claim, readIdentity(recorded.claim.pid)) || listIdentities().some((identity) => ownsClaim(recorded.claim, identity))) throw new Error("refusing to recover: recorded pairing harness is still running");
  }
  const stale = await inspectDescriptor(paths, recoveryTime);
  if (legacy && (stale === null || !stale.expired)) throw new Error("refusing to recover a legacy pairing claim without an expired descriptor");
  if (stale && await probeSocket(stale.descriptor.socket_path)) throw new Error("refusing to recover: pairing socket is still accepting connections");
  if (stale?.socketOwnership) await removeOwnedSocket(stale.descriptor.socket_path, stale.socketOwnership);
  if (stale) await removeOwnedFile(paths.activeDescriptorPath, stale.descriptorOwnership, "active pairing descriptor");
  await removeOwnedFile(claimPath(paths), recorded.ownership, "pairing claim");
  return { recovered: true, legacy };
}

export async function acquireOrRecoverPairingClaim({ paths, ownerId, pid, identity, executable, now, readIdentity, listIdentities, probeSocket }) {
  const claim = createPairingClaim({ paths, ownerId, pid, identity, executable });
  const filePath = claimPath(paths);
  const content = `${JSON.stringify(claim)}\n`;
  try {
    await writeNewPrivateFile(filePath, content);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await recoverStalePairingClaim({ runtimeRoot: paths.runtimeRoot, instanceId: paths.instanceId, now, readIdentity, listIdentities, probeSocket, requesterPid: pid });
    await writeNewPrivateFile(filePath, content);
  }
  const info = await lstat(filePath);
  assertPrivateRegular(info, 0o600, "pairing claim");
  if ((await readFile(filePath, "utf8")) !== content) throw new Error("pairing claim ownership content changed");
  return { claimPath: filePath, claimOwnership: { dev: info.dev, ino: info.ino, content, expectedMode: 0o600 } };
}
