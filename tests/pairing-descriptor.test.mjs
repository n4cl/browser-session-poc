import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  createPairingDescriptor,
  createSocketPath,
  loadOrCreateProfileMetadata,
  MACOS_UNIX_SOCKET_PATH_MAX_BYTES,
  resolvePairingPaths,
  readActivePairingDescriptor,
  readProfileMetadata,
  validatePairingDescriptor,
  validateSocketPath,
  writeActivePairingDescriptor,
} from "../core/pairing-descriptor.mjs";

const ISSUED_AT = "2030-01-01T00:00:00.000Z";
const EXPIRES_AT = "2030-01-01T01:00:00.000Z";
const VALIDATION_TIME = new Date("2030-01-01T00:30:00.000Z");

async function temporaryRuntimeRoot() {
  return fsMkdtemp(path.join("/private/tmp", "bsp-pairing-"));
}

async function fixture(instanceId = "poc-a") {
  const runtimeRoot = await temporaryRuntimeRoot();
  const paths = resolvePairingPaths({ runtimeRoot, instanceId });
  const metadata = await loadOrCreateProfileMetadata(paths, {
    createUuid: () => "11111111-1111-4111-8111-111111111111",
  });
  const socketPath = await createSocketPath(paths, {
    createUuid: () => "22222222-2222-4222-8222-222222222222",
  });
  const descriptor = createPairingDescriptor({
    paths,
    profileInstanceId: metadata.profile_instance_id,
    sessionId: "session-a",
    generation: 1,
    socketPath,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    leaseId: "lease-a",
    pairingNonce: "nonce-a",
  });
  return { runtimeRoot, paths, metadata, socketPath, descriptor };
}

test("profile metadata persists one profile instance ID with private modes", async () => {
  const runtimeRoot = await temporaryRuntimeRoot();
  const paths = resolvePairingPaths({ runtimeRoot, instanceId: "poc-a" });
  const first = await loadOrCreateProfileMetadata(paths, {
    createUuid: () => "11111111-1111-4111-8111-111111111111",
  });
  const second = await loadOrCreateProfileMetadata(paths, {
    createUuid: () => "99999999-9999-4999-8999-999999999999",
  });

  assert.equal(first.profile_instance_id, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(second, first);
  assert.equal((await stat(paths.profileMetadataDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.profileMetadataPath)).mode & 0o777, 0o600);
});

test("pairing paths and descriptors are isolated per browser instance", async () => {
  const runtimeRoot = await temporaryRuntimeRoot();
  const firstPaths = resolvePairingPaths({ runtimeRoot, instanceId: "poc-a" });
  const secondPaths = resolvePairingPaths({ runtimeRoot, instanceId: "poc-b" });
  const firstMetadata = await loadOrCreateProfileMetadata(firstPaths, {
    createUuid: () => "11111111-1111-4111-8111-111111111111",
  });
  const secondMetadata = await loadOrCreateProfileMetadata(secondPaths, {
    createUuid: () => "22222222-2222-4222-8222-222222222222",
  });

  assert.notEqual(firstPaths.userDataDir, secondPaths.userDataDir);
  assert.notEqual(firstPaths.activeDescriptorPath, secondPaths.activeDescriptorPath);
  assert.notEqual(firstMetadata.profile_instance_id, secondMetadata.profile_instance_id);
  assert.equal(firstPaths.profileMetadataPath.includes(`${path.sep}Default${path.sep}`), false);
});

test("active descriptor is atomically created, idempotent, and never overwritten", async () => {
  const { paths, metadata, descriptor } = await fixture();
  const first = await writeActivePairingDescriptor(paths, descriptor, {
    profileInstanceId: metadata.profile_instance_id,
    now: VALIDATION_TIME,
  });
  const second = await writeActivePairingDescriptor(paths, descriptor, {
    profileInstanceId: metadata.profile_instance_id,
    now: VALIDATION_TIME,
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.deepEqual(JSON.parse(await readFile(paths.activeDescriptorPath, "utf8")), descriptor);
  assert.equal((await stat(paths.pairingDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(paths.activeDescriptorPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(paths.pairingDirectory), ["active-descriptor.json"]);

  await assert.rejects(
    () =>
      writeActivePairingDescriptor(
        paths,
        { ...descriptor, session_id: "other-session" },
        { profileInstanceId: metadata.profile_instance_id, now: VALIDATION_TIME },
      ),
    /refusing to overwrite/,
  );
  assert.deepEqual(JSON.parse(await readFile(paths.activeDescriptorPath, "utf8")), descriptor);
});

test("profile metadata fails closed for schema, instance, permission, and symlink violations", async () => {
  const runtimeRoot = await temporaryRuntimeRoot();
  const paths = resolvePairingPaths({ runtimeRoot, instanceId: "poc-a" });
  await mkdir(paths.profileMetadataDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    paths.profileMetadataPath,
    `${JSON.stringify({ schema_version: 1, browser_instance_id: "poc-b", profile_instance_id: "profile-b" })}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(() => loadOrCreateProfileMetadata(paths), /browser instance does not match/);

  await writeFile(paths.profileMetadataPath, '{"schema_version":1,"browser_instance_id":"poc-a","profile_instance_id":"profile-a","extra":true}\n', { mode: 0o600 });
  await assert.rejects(() => loadOrCreateProfileMetadata(paths), /unexpected schema/);

  await writeFile(paths.profileMetadataPath, '{"schema_version":1,"browser_instance_id":"poc-a","profile_instance_id":"profile-a"}\n', { mode: 0o600 });
  await chmod(paths.profileMetadataPath, 0o644);
  await assert.rejects(() => loadOrCreateProfileMetadata(paths), /mode 600/);

  await chmod(paths.profileMetadataPath, 0o600);
  await unlink(paths.profileMetadataPath);
  const targetPath = path.join(runtimeRoot, "outside.json");
  await writeFile(targetPath, "{}\n", { mode: 0o600 });
  await symlink(targetPath, paths.profileMetadataPath);
  await assert.rejects(() => loadOrCreateProfileMetadata(paths), /symbolic link/);
});

test("descriptor validation rejects every invalid binding class and expired leases", async () => {
  const { paths, metadata, descriptor } = await fixture();
  const validate = (candidate, profileInstanceId = metadata.profile_instance_id, now = VALIDATION_TIME) =>
    validatePairingDescriptor(candidate, { paths, profileInstanceId, now });

  const invalidDescriptors = [
    { ...descriptor, unknown: true },
    Object.fromEntries(Object.entries(descriptor).filter(([field]) => field !== "session_id")),
    { ...descriptor, schema_version: 2 },
    { ...descriptor, session_id: "" },
    { ...descriptor, browser_instance_id: "poc-b" },
    { ...descriptor, profile_instance_id: "profile-b" },
    { ...descriptor, generation: 0 },
    { ...descriptor, generation: Number.MAX_SAFE_INTEGER + 1 },
    { ...descriptor, lease_id: "" },
    { ...descriptor, pairing_nonce: "" },
    { ...descriptor, socket_path: "relative.sock" },
    { ...descriptor, issued_at: "2030-01-01" },
    { ...descriptor, expires_at: ISSUED_AT },
    { ...descriptor, expires_at: "2029-12-31T23:59:59.999Z" },
  ];

  for (const candidate of invalidDescriptors) {
    assert.throws(() => validate(candidate));
  }
  assert.throws(() => validate(descriptor, metadata.profile_instance_id, new Date(EXPIRES_AT)), /expired/);
  assert.throws(() => validate(descriptor, "different-profile"), /profile instance does not match/);
});

test("socket paths reject traversal and macOS length overflow without using the instance ID as a filename", async () => {
  const { runtimeRoot, paths, socketPath } = await fixture("poc-with-a-long-but-valid-instance-id-1234567890");
  assert.equal(path.basename(socketPath).includes(paths.instanceId), false);
  assert.ok(Buffer.byteLength(socketPath, "utf8") <= MACOS_UNIX_SOCKET_PATH_MAX_BYTES);
  assert.throws(
    () => validateSocketPath(path.join(runtimeRoot, "outside", "s-22222222222222222222222222222222.sock"), paths),
    /managed short random socket name/,
  );
  assert.throws(
    () => resolvePairingPaths({ runtimeRoot, instanceId: "../outside" }),
    /instance ID/,
  );

  const longRuntimeRoot = path.join("/private/tmp", `bsp-${"a".repeat(80)}`);
  const longPaths = resolvePairingPaths({ runtimeRoot: longRuntimeRoot, instanceId: "poc-a" });
  const longSocketPath = path.join(longPaths.socketDirectory, "s-22222222222222222222222222222222.sock");
  assert.throws(() => validateSocketPath(longSocketPath, longPaths), /path limit/);
});

test("active descriptor rejects a symbolic link instead of following it", async () => {
  const { runtimeRoot, paths, metadata, descriptor } = await fixture();
  await writeActivePairingDescriptor(paths, descriptor, {
    profileInstanceId: metadata.profile_instance_id,
    now: VALIDATION_TIME,
  });
  await unlink(paths.activeDescriptorPath);
  const targetPath = path.join(runtimeRoot, "outside-descriptor.json");
  await writeFile(targetPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
  await symlink(targetPath, paths.activeDescriptorPath);

  await assert.rejects(
    () =>
      writeActivePairingDescriptor(paths, descriptor, {
        profileInstanceId: metadata.profile_instance_id,
        now: VALIDATION_TIME,
      }),
    /symbolic link/,
  );
  assert.equal((await lstat(paths.activeDescriptorPath)).isSymbolicLink(), true);
});

test("active descriptor fails closed for invalid permissions and unknown fields", async () => {
  const { paths, metadata, descriptor } = await fixture();
  await writeActivePairingDescriptor(paths, descriptor, {
    profileInstanceId: metadata.profile_instance_id,
    now: VALIDATION_TIME,
  });
  await chmod(paths.activeDescriptorPath, 0o644);
  await assert.rejects(
    () =>
      writeActivePairingDescriptor(paths, descriptor, {
        profileInstanceId: metadata.profile_instance_id,
        now: VALIDATION_TIME,
      }),
    /mode 600/,
  );

  await chmod(paths.activeDescriptorPath, 0o600);
  await writeFile(paths.activeDescriptorPath, `${JSON.stringify({ ...descriptor, unexpected: true })}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    () =>
      writeActivePairingDescriptor(paths, descriptor, {
        profileInstanceId: metadata.profile_instance_id,
        now: VALIDATION_TIME,
      }),
    /unexpected schema/,
  );
});

test("Native Host readers only accept the current instance's private metadata and descriptor", async () => {
  const { runtimeRoot, paths, metadata, descriptor } = await fixture("poc-a");
  await writeActivePairingDescriptor(paths, descriptor, {
    profileInstanceId: metadata.profile_instance_id,
    now: VALIDATION_TIME,
  });
  assert.deepEqual(await readProfileMetadata(paths), metadata);
  assert.deepEqual(
    await readActivePairingDescriptor(paths, {
      profileInstanceId: metadata.profile_instance_id,
      now: VALIDATION_TIME,
    }),
    descriptor,
  );

  await chmod(paths.activeDescriptorPath, 0o644);
  await assert.rejects(
    () => readActivePairingDescriptor(paths, { profileInstanceId: metadata.profile_instance_id, now: VALIDATION_TIME }),
    /mode 600/,
  );
  await chmod(paths.activeDescriptorPath, 0o600);
  await unlink(paths.activeDescriptorPath);
  const outside = path.join(runtimeRoot, "outside-descriptor.json");
  await writeFile(outside, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
  await symlink(outside, paths.activeDescriptorPath);
  await assert.rejects(
    () => readActivePairingDescriptor(paths, { profileInstanceId: metadata.profile_instance_id, now: VALIDATION_TIME }),
    /symbolic link/,
  );
});

async function fsMkdtemp(prefix) {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(prefix);
}
