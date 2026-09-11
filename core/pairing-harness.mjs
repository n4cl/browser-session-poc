import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  createPairingDescriptor,
  createSocketPath,
  loadOrCreateProfileMetadata,
  resolvePairingPaths,
  writeActivePairingDescriptor,
} from "./pairing-descriptor.mjs";
import {
  installNativeHost,
  nativeHostManifestContent,
  nativeHostWrapperContent,
  resolveNativeHostPaths,
} from "./native-host-manifest.mjs";
import { PairingSocketServer } from "./pairing-socket-server.mjs";
import { acquireOrRecoverPairingClaim, probePairingSocket } from "./pairing-claim.mjs";
import { listProcessIdentities, readProcessIdentity } from "./chrome-instance.mjs";
import { createPairingAuditLogger } from "./pairing-audit-log.mjs";

function modeOf(info) { return info.mode & 0o777; }

async function lstatOrNull(filePath) {
  try { return await lstat(filePath); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function readExpectedPrivateFile(filePath, expectedContent, expectedMode, label) {
  const info = await lstatOrNull(filePath);
  if (info === null) return false;
  if (info.isSymbolicLink() || !info.isFile() || modeOf(info) !== expectedMode) throw new Error(`${label} must be a non-symlink regular file with mode ${expectedMode.toString(8)}`);
  if ((await readFile(filePath, "utf8")) !== expectedContent) throw new Error(`${label} does not match this pairing instance`);
  return true;
}

async function recordOwnership(filePath, content, expectedMode = 0o600) {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile() || modeOf(info) !== expectedMode) throw new Error("pairing harness ownership file is unsafe");
  if ((await readFile(filePath, "utf8")) !== content) throw new Error("pairing harness ownership content changed");
  return { dev: info.dev, ino: info.ino, content, expectedMode };
}

async function removeOwnedFile(filePath, ownership) {
  const current = await lstatOrNull(filePath);
  if (current === null) return;
  if (current.isSymbolicLink() || !current.isFile() || modeOf(current) !== ownership.expectedMode || current.dev !== ownership.dev || current.ino !== ownership.ino) throw new Error("refusing to remove changed pairing harness file");
  if ((await readFile(filePath, "utf8")) !== ownership.content) throw new Error("refusing to remove changed pairing harness content");
  await rm(filePath);
}

async function readPrivateGeneration(filePath) {
  const info = await lstatOrNull(filePath);
  if (info === null) return 0;
  if (info.isSymbolicLink() || !info.isFile() || modeOf(info) !== 0o600) throw new Error("pairing generation state must be a non-symlink regular file with mode 600");
  let value;
  try { value = JSON.parse(await readFile(filePath, "utf8")); } catch { throw new Error("pairing generation state must contain valid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 0) throw new Error("invalid pairing generation state");
  return value.generation;
}

async function replacePrivateFileAtomically(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await readExpectedPrivateFile(filePath, content, 0o600, "pairing generation state");
  } finally { await handle?.close(); await rm(temporaryPath, { force: true }); }
}

async function ensureNativeHost(paths) {
  await installNativeHost(paths);
  await readExpectedPrivateFile(paths.manifestPath, nativeHostManifestContent(paths), 0o600, "Native Host manifest");
  await readExpectedPrivateFile(paths.wrapperPath, nativeHostWrapperContent(paths), 0o700, "Native Host wrapper");
}

async function closeOwnedResources({ server, auditLogger, descriptorPath, descriptorOwnership, claimPath, claimOwnership }) {
  const errors = [];
  try { await server?.close(); } catch (error) { errors.push(error); }
  try { await auditLogger?.close(); } catch (error) { errors.push(error); }
  for (const [filePath, ownership] of [[descriptorPath, descriptorOwnership], [claimPath, claimOwnership]]) {
    if (!ownership) continue;
    try { await removeOwnedFile(filePath, ownership); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "pairing harness cleanup failed");
}

export async function startPairingHarness({
  runtimeRoot,
  instanceId,
  ttlMs = 3_600_000,
  now = () => new Date(),
  createUuid = randomUUID,
  repositoryRoot = path.resolve(import.meta.dirname, ".."),
  executablePath = process.execPath,
  processId = process.pid,
  readIdentity = readProcessIdentity,
  listIdentities = listProcessIdentities,
  probeSocket = probePairingSocket,
}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new TypeError("ttlMs must be positive");
  }
  const paths = resolvePairingPaths({ runtimeRoot, instanceId });
  const generationPath = path.join(paths.instanceDir, "pairing-generation.json");
  const { claimPath, claimOwnership } = await acquireOrRecoverPairingClaim({
    paths,
    ownerId: createUuid(),
    pid: processId,
    identity: readIdentity(processId),
    executable: process.execPath,
    now,
    readIdentity,
    listIdentities,
    probeSocket,
  });
  let descriptorOwnership;
  let server;
  let auditLogger;
  try {
    const metadata = await loadOrCreateProfileMetadata(paths, { createUuid });
    const generation = (await readPrivateGeneration(generationPath)) + 1;
    await replacePrivateFileAtomically(generationPath, `${JSON.stringify({ generation })}\n`);
    const hostPaths = resolveNativeHostPaths({ repositoryRoot, runtimeRoot: paths.runtimeRoot, instanceId, executablePath });
    await ensureNativeHost(hostPaths);
    const issuedAt = now();
    if (!(issuedAt instanceof Date) || !Number.isFinite(issuedAt.valueOf())) {
      throw new TypeError("now must return a valid Date");
    }
    const descriptor = createPairingDescriptor({
      paths,
      profileInstanceId: metadata.profile_instance_id,
      sessionId: createUuid(),
      generation,
      socketPath: await createSocketPath(paths, { createUuid }),
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.valueOf() + ttlMs).toISOString(),
      leaseId: createUuid(),
      pairingNonce: createUuid(),
    });
    auditLogger = await createPairingAuditLogger({ paths, generation });
    server = new PairingSocketServer({
      paths,
      descriptor,
      profileInstanceId: metadata.profile_instance_id,
      now: issuedAt,
      auditLogger,
    });
    await server.listen();
    await writeActivePairingDescriptor(paths, descriptor, { profileInstanceId: metadata.profile_instance_id, now: issuedAt });
    descriptorOwnership = await recordOwnership(paths.activeDescriptorPath, `${JSON.stringify(descriptor)}\n`);
    let closing;
    return {
      paths,
      descriptor,
      server,
      close() {
        if (!closing) {
          closing = closeOwnedResources({
            server,
            auditLogger,
            descriptorPath: paths.activeDescriptorPath,
            descriptorOwnership,
            claimPath,
            claimOwnership,
          });
        }
        return closing;
      },
    };
  } catch (error) {
    try {
      await closeOwnedResources({
        server,
        auditLogger,
        descriptorPath: paths.activeDescriptorPath,
        descriptorOwnership,
        claimPath,
        claimOwnership,
      });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "pairing harness setup rollback failed");
    }
    throw error;
  }
}
