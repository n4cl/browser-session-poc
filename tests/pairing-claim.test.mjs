import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readProcessIdentity } from "../core/chrome-instance.mjs";
import {
  createPairingClaim,
  recoverStalePairingClaim,
  validatePairingClaim,
} from "../core/pairing-claim.mjs";
import {
  createPairingDescriptor,
  createSocketPath,
  loadOrCreateProfileMetadata,
  resolvePairingPaths,
  writeActivePairingDescriptor,
} from "../core/pairing-descriptor.mjs";

const EXECUTABLE = "/usr/local/bin/node";
const IDENTITY = { processStart: "Thu Sep  5 00:02:00 2026", command: `${EXECUTABLE} pairing-session.mjs start poc-a` };

async function runtimeRoot() {
  return mkdtemp(path.join("/private/tmp", "bsp-pairing-claim-"));
}

async function writeClaim(paths, claim) {
  const filePath = path.join(paths.runtimeRoot, "pairing-claims", `${paths.instanceId}.claim`);
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify(claim)}\n`, { mode: 0o600 });
  return filePath;
}

test("new claim records process identity and recovers a reused PID only when no owner remains", async () => {
  const root = await runtimeRoot();
  const paths = resolvePairingPaths({ runtimeRoot: root, instanceId: "poc-a" });
  const claim = createPairingClaim({ paths, ownerId: "owner-a", pid: 42, identity: IDENTITY, executable: EXECUTABLE });
  const filePath = await writeClaim(paths, claim);
  assert.deepEqual(validatePairingClaim(claim, { paths }), claim);

  const recovered = await recoverStalePairingClaim({
    runtimeRoot: root,
    instanceId: "poc-a",
    readIdentity: () => ({ ...IDENTITY, processStart: "Thu Sep  5 00:03:00 2026" }),
    listIdentities: () => [],
  });
  assert.deepEqual(recovered, { recovered: true, legacy: false });
  await assert.rejects(() => readFile(filePath), /ENOENT/);
});

test("the actual ps identity of this Node process keeps a v2 partial claim live", async () => {
  const root = await runtimeRoot();
  const paths = resolvePairingPaths({ runtimeRoot: root, instanceId: "poc-a" });
  const identity = readProcessIdentity(process.pid);
  assert.ok(identity);
  const claim = createPairingClaim({
    paths,
    ownerId: "owner-a",
    pid: process.pid,
    identity,
    executable: process.execPath,
  });
  await writeClaim(paths, claim);

  await assert.rejects(
    () => recoverStalePairingClaim({ runtimeRoot: root, instanceId: "poc-a" }),
    /recorded pairing harness is still running/,
  );
});

test("recovery refuses a live new-schema owner and does not affect another instance", async () => {
  const root = await runtimeRoot();
  const first = resolvePairingPaths({ runtimeRoot: root, instanceId: "poc-a" });
  const second = resolvePairingPaths({ runtimeRoot: root, instanceId: "poc-b" });
  const firstClaim = createPairingClaim({ paths: first, ownerId: "owner-a", pid: 42, identity: IDENTITY, executable: EXECUTABLE });
  const secondClaim = createPairingClaim({ paths: second, ownerId: "owner-b", pid: 43, identity: { ...IDENTITY, command: `${EXECUTABLE} pairing-session.mjs start poc-b` }, executable: EXECUTABLE });
  const firstPath = await writeClaim(first, firstClaim);
  const secondPath = await writeClaim(second, secondClaim);

  await assert.rejects(() => recoverStalePairingClaim({ runtimeRoot: root, instanceId: "poc-a", readIdentity: () => IDENTITY, listIdentities: () => [] }), /still running/);
  assert.deepEqual(JSON.parse(await readFile(firstPath, "utf8")), firstClaim);
  assert.deepEqual(JSON.parse(await readFile(secondPath, "utf8")), secondClaim);
});

test("an expired legacy claim recovers only after its descriptor is expired and socket probe fails", async () => {
  const root = await runtimeRoot();
  const paths = resolvePairingPaths({ runtimeRoot: root, instanceId: "poc-a" });
  const metadata = await loadOrCreateProfileMetadata(paths, { createUuid: () => "11111111-1111-4111-8111-111111111111" });
  const descriptor = createPairingDescriptor({
    paths,
    profileInstanceId: metadata.profile_instance_id,
    sessionId: "session-a",
    generation: 1,
    socketPath: await createSocketPath(paths, { createUuid: () => "22222222-2222-4222-8222-222222222222" }),
    issuedAt: "2030-01-01T00:00:00.000Z",
    expiresAt: "2030-01-01T00:01:00.000Z",
    leaseId: "lease-a",
    pairingNonce: "nonce-a",
  });
  await writeActivePairingDescriptor(paths, descriptor, { profileInstanceId: metadata.profile_instance_id, now: new Date(descriptor.issued_at) });
  const filePath = await writeClaim(paths, { instance_id: "poc-a", owner_id: "legacy-owner" });

  const recovered = await recoverStalePairingClaim({
    runtimeRoot: root,
    instanceId: "poc-a",
    now: () => new Date("2030-01-01T00:02:00.000Z"),
    listIdentities: () => [{ ...IDENTITY, pid: 44 }],
    probeSocket: async () => false,
    requesterPid: 44,
  });
  assert.deepEqual(recovered, { recovered: true, legacy: true });
  await assert.rejects(() => readFile(filePath), /ENOENT/);
  await assert.rejects(() => readFile(paths.activeDescriptorPath), /ENOENT/);
});

test("legacy recovery fails closed before expiry or when a legacy harness may exist", async () => {
  const root = await runtimeRoot();
  const paths = resolvePairingPaths({ runtimeRoot: root, instanceId: "poc-a" });
  await writeClaim(paths, { instance_id: "poc-a", owner_id: "legacy-owner" });
  await assert.rejects(() => recoverStalePairingClaim({ runtimeRoot: root, instanceId: "poc-a", listIdentities: () => [] }), /without an expired descriptor/);
  await assert.rejects(() => recoverStalePairingClaim({ runtimeRoot: root, instanceId: "poc-a", requesterPid: 44, listIdentities: () => [{ ...IDENTITY, pid: 45 }] }), /may still be running/);
});

test("recovery fails closed for changed claim and descriptor paths", async () => {
  const root = await runtimeRoot();
  const paths = resolvePairingPaths({ runtimeRoot: root, instanceId: "poc-a" });
  const claim = createPairingClaim({ paths, ownerId: "owner-a", pid: 42, identity: IDENTITY, executable: EXECUTABLE });
  const filePath = await writeClaim(paths, claim);
  await chmod(filePath, 0o644);
  await assert.rejects(() => recoverStalePairingClaim({ runtimeRoot: root, instanceId: "poc-a", readIdentity: () => null, listIdentities: () => [] }), /pairing claim must be/);

  await chmod(filePath, 0o600);
  await mkdir(paths.pairingDirectory, { recursive: true, mode: 0o700 });
  await mkdir(paths.socketDirectory, { recursive: true, mode: 0o700 });
  const targetPath = path.join(root, "outside-descriptor.json");
  await writeFile(targetPath, "{}\n", { mode: 0o600 });
  await symlink(targetPath, paths.activeDescriptorPath);
  await assert.rejects(() => recoverStalePairingClaim({ runtimeRoot: root, instanceId: "poc-a", readIdentity: () => null, listIdentities: () => [] }), /active pairing descriptor must be/);
});
