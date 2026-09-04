import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  legacyNativeHostWrapperContent,
  nativeHostManifestContent,
  nativeHostWrapperContent,
  resolveNativeHostPaths,
} from "../core/native-host-manifest.mjs";
import { startPairingHarness } from "../core/pairing-harness.mjs";

async function temporaryRuntimeRoot() {
  return mkdtemp(path.join("/private/tmp", "bsp-pairing-harness-"));
}

function uuidFactory(start = 0) {
  let number = start;
  return () => {
    number += 1;
    return `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;
  };
}

function harnessOptions(runtimeRoot, instanceId, uuidStart = 0) {
  return {
    runtimeRoot,
    instanceId,
    createUuid: uuidFactory(uuidStart),
  };
}

function claimPath(runtimeRoot, instanceId) {
  return path.join(runtimeRoot, "pairing-claims", `${instanceId}.claim`);
}

test("harness publishes only after listening, increments generation, and cleans up exactly once", async (t) => {
  const runtimeRoot = await temporaryRuntimeRoot();
  const first = await startPairingHarness(harnessOptions(runtimeRoot, "poc-a"));
  t.after(() => first.close().catch(() => {}));

  assert.equal(first.server.state.phase, "ISSUED");
  assert.equal(first.descriptor.generation, 1);
  assert.deepEqual(JSON.parse(await readFile(first.paths.activeDescriptorPath, "utf8")), first.descriptor);
  assert.equal((await stat(first.paths.activeDescriptorPath)).mode & 0o777, 0o600);
  assert.equal((await stat(claimPath(runtimeRoot, "poc-a"))).mode & 0o777, 0o600);

  const firstClose = first.close();
  const secondClose = first.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
  await assert.rejects(() => readFile(first.paths.activeDescriptorPath, "utf8"), /ENOENT/);
  await assert.rejects(() => readFile(claimPath(runtimeRoot, "poc-a"), "utf8"), /ENOENT/);

  const second = await startPairingHarness(harnessOptions(runtimeRoot, "poc-a"));
  t.after(() => second.close().catch(() => {}));
  assert.equal(second.descriptor.generation, 2);
  await second.close();
});

test("harness defaults its descriptor lease to ten minutes", async (t) => {
  const runtimeRoot = await temporaryRuntimeRoot();
  const issuedAt = new Date("2030-01-01T00:00:00.000Z");
  const harness = await startPairingHarness({
    ...harnessOptions(runtimeRoot, "poc-a"),
    now: () => issuedAt,
  });
  t.after(() => harness.close().catch(() => {}));

  assert.equal(
    Date.parse(harness.descriptor.expires_at) - Date.parse(harness.descriptor.issued_at),
    600_000,
  );
  await harness.close();
});

test("harness upgrades an exact private Gate 1 wrapper before publishing its descriptor", async (t) => {
  const runtimeRoot = await temporaryRuntimeRoot();
  const hostPaths = resolveNativeHostPaths({
    repositoryRoot: path.resolve(import.meta.dirname, ".."),
    runtimeRoot,
    instanceId: "poc-a",
    executablePath: process.execPath,
  });
  await mkdir(path.dirname(hostPaths.manifestPath), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(hostPaths.wrapperPath), { recursive: true, mode: 0o700 });
  await writeFile(hostPaths.manifestPath, nativeHostManifestContent(hostPaths), { mode: 0o600 });
  await writeFile(hostPaths.wrapperPath, legacyNativeHostWrapperContent(hostPaths), { mode: 0o700 });

  const harness = await startPairingHarness(harnessOptions(runtimeRoot, "poc-a"));
  t.after(() => harness.close().catch(() => {}));
  assert.equal(await readFile(hostPaths.wrapperPath, "utf8"), nativeHostWrapperContent(hostPaths));
  assert.deepEqual(JSON.parse(await readFile(harness.paths.activeDescriptorPath, "utf8")), harness.descriptor);
  await harness.close();
});

test("harness rejects a second claim while preserving the first instance", async (t) => {
  const runtimeRoot = await temporaryRuntimeRoot();
  const harness = await startPairingHarness(harnessOptions(runtimeRoot, "poc-a"));
  t.after(() => harness.close().catch(() => {}));

  await assert.rejects(
    () => startPairingHarness(harnessOptions(runtimeRoot, "poc-a")),
    /EEXIST/,
  );
  assert.equal(harness.server.state.phase, "ISSUED");
  assert.deepEqual(JSON.parse(await readFile(harness.paths.activeDescriptorPath, "utf8")), harness.descriptor);
});

test("independent instances have independent claims, descriptors, and sockets", async (t) => {
  const runtimeRoot = await temporaryRuntimeRoot();
  const first = await startPairingHarness(harnessOptions(runtimeRoot, "poc-a"));
  const second = await startPairingHarness(harnessOptions(runtimeRoot, "poc-b", 100));
  t.after(() => first.close().catch(() => {}));
  t.after(() => second.close().catch(() => {}));

  assert.notEqual(first.paths.activeDescriptorPath, second.paths.activeDescriptorPath);
  assert.notEqual(first.descriptor.socket_path, second.descriptor.socket_path);
  assert.notEqual(first.descriptor.profile_instance_id, second.descriptor.profile_instance_id);

  await second.close();
  assert.equal(first.server.state.phase, "ISSUED");
  assert.deepEqual(JSON.parse(await readFile(first.paths.activeDescriptorPath, "utf8")), first.descriptor);
});

test("cleanup refuses a replaced descriptor and leaves it intact", async (t) => {
  const runtimeRoot = await temporaryRuntimeRoot();
  const harness = await startPairingHarness(harnessOptions(runtimeRoot, "poc-a"));
  t.after(() => harness.close().catch(() => {}));

  const replacementPath = `${harness.paths.activeDescriptorPath}.replacement`;
  await writeFile(replacementPath, "replacement\n", { mode: 0o600 });
  await rename(replacementPath, harness.paths.activeDescriptorPath);

  await assert.rejects(() => harness.close(), /pairing harness cleanup failed/);
  assert.equal(await readFile(harness.paths.activeDescriptorPath, "utf8"), "replacement\n");
});

test("cleanup refuses a claim whose private mode changed", async (t) => {
  const runtimeRoot = await temporaryRuntimeRoot();
  const harness = await startPairingHarness(harnessOptions(runtimeRoot, "poc-a"));
  t.after(() => harness.close().catch(() => {}));
  const currentClaimPath = claimPath(runtimeRoot, "poc-a");

  await chmod(currentClaimPath, 0o644);
  await assert.rejects(() => harness.close(), /pairing harness cleanup failed/);
  assert.equal((await stat(currentClaimPath)).mode & 0o777, 0o644);
});

test("invalid generation state fails closed and rolls back the claim", async () => {
  const runtimeRoot = await temporaryRuntimeRoot();
  const instanceDir = path.join(runtimeRoot, "instances", "poc-a");
  await mkdir(instanceDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(instanceDir, "pairing-generation.json"), "not-json\n", { mode: 0o600 });

  await assert.rejects(
    () => startPairingHarness(harnessOptions(runtimeRoot, "poc-a")),
    /pairing generation state must contain valid JSON/,
  );
  await assert.rejects(() => readFile(claimPath(runtimeRoot, "poc-a"), "utf8"), /ENOENT/);
});

test("Native Host files must be private regular files with the expected content", async (t) => {
  const runtimeRoot = await temporaryRuntimeRoot();
  const harness = await startPairingHarness(harnessOptions(runtimeRoot, "poc-a"));
  t.after(() => harness.close().catch(() => {}));
  const hostPaths = resolveNativeHostPaths({
    repositoryRoot: path.resolve(import.meta.dirname, ".."),
    runtimeRoot,
    instanceId: "poc-a",
    executablePath: process.execPath,
  });

  assert.equal((await stat(hostPaths.manifestPath)).mode & 0o777, 0o600);
  assert.equal((await stat(hostPaths.wrapperPath)).mode & 0o777, 0o700);
  await harness.close();

  const targetPath = path.join(runtimeRoot, "outside-manifest.json");
  await writeFile(targetPath, "{}\n", { mode: 0o600 });
  await mkdir(path.dirname(hostPaths.manifestPath), { recursive: true, mode: 0o700 });
  await rename(hostPaths.manifestPath, `${hostPaths.manifestPath}.saved`);
  await symlink(targetPath, hostPaths.manifestPath);
  await assert.rejects(
    () => startPairingHarness(harnessOptions(runtimeRoot, "poc-a")),
    /refusing to overwrite an existing Native Messaging manifest/,
  );
  await assert.rejects(() => readFile(claimPath(runtimeRoot, "poc-a"), "utf8"), /ENOENT/);
});
