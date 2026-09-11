import assert from "node:assert/strict";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pairingAuditFilePath, createPairingAuditLogger, AUDIT_ERROR_CODE, PAIRING_AUDIT_FIELDS } from "../core/pairing-audit-log.mjs";
import { resolvePairingPaths } from "../core/pairing-descriptor.mjs";
import { startPairingHarness } from "../core/pairing-harness.mjs";

async function fixture() {
  const runtimeRoot = await mkdtemp(path.join("/private/tmp", "bsp-audit-"));
  const paths = resolvePairingPaths({ runtimeRoot, instanceId: "poc-a" });
  await mkdir(paths.instanceDir, { recursive: true, mode: 0o700 });
  await chmod(paths.instanceDir, 0o700);
  return { runtimeRoot, paths };
}

function event(requestId, outcome = "issued") {
  return {
    session_id: "session-a",
    browser_instance_id: "poc-a",
    profile_instance_id: "profile-a",
    generation: 7,
    request_id: requestId,
    command: "navigate",
    outcome,
    timestamp: "2030-01-01T00:00:00.000Z",
  };
}

function auditError(error) {
  return error?.code === AUDIT_ERROR_CODE;
}

test("pairing audit logger writes exact events with private mode and serialized close", async (t) => {
  const { runtimeRoot, paths } = await fixture();
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const logger = await createPairingAuditLogger({ paths, generation: 7 });
  const filePath = pairingAuditFilePath(paths, 7);

  const writes = [
    logger.write(event("request-a", "issued")),
    logger.write(event("request-a", "success")),
    logger.write(event("request-b", "issued")),
    logger.write(event("request-b", "timeout")),
  ];
  const closing = logger.close();
  await Promise.all(writes);
  await closing;

  const lines = (await readFile(filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((entry) => entry.outcome), ["issued", "success", "issued", "timeout"]);
  for (const entry of lines) assert.deepEqual(Object.keys(entry).sort(), [...PAIRING_AUDIT_FIELDS].sort());
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(filePath)).nlink, 1);
  await assert.rejects(() => logger.write(event("after-close")), auditError);
  await assert.rejects(() => createPairingAuditLogger({ paths, generation: 7 }), auditError);
});

test("pairing audit logger rejects secret fields through its event API", async (t) => {
  const { runtimeRoot, paths } = await fixture();
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const logger = await createPairingAuditLogger({ paths, generation: 1 });
  await assert.rejects(() => logger.write({ ...event("request-secret"), text: "must-not-be-accepted" }), auditError);
  await logger.close();
});

test("pairing audit logger fails closed for an existing symlink path", async (t) => {
  const { runtimeRoot, paths } = await fixture();
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const target = path.join(runtimeRoot, "outside-audit.jsonl");
  await writeFile(target, "outside\n", { mode: 0o600 });
  await symlink(target, pairingAuditFilePath(paths, 1));
  await assert.rejects(() => createPairingAuditLogger({ paths, generation: 1 }), auditError);
});

test("pairing audit logger rejects a symlinked instance directory and a foreign uid", async (t) => {
  const first = await fixture();
  const outside = path.join(first.runtimeRoot, "outside-instance");
  await mkdir(outside, { mode: 0o700 });
  await rm(first.paths.instanceDir, { recursive: true, force: true });
  await symlink(outside, first.paths.instanceDir);
  await assert.rejects(() => createPairingAuditLogger({ paths: first.paths, generation: 1 }), auditError);
  await rm(first.runtimeRoot, { recursive: true, force: true });

  const second = await fixture();
  t.after(() => rm(second.runtimeRoot, { recursive: true, force: true }));
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  await assert.rejects(() => createPairingAuditLogger({ paths: second.paths, generation: 1, uid: uid + 1 }), auditError);
});

test("pairing audit logger detects hardlink and mode mutation before a write", async (t) => {
  const first = await fixture();
  const firstLogger = await createPairingAuditLogger({ paths: first.paths, generation: 1 });
  const firstFile = pairingAuditFilePath(first.paths, 1);
  await link(firstFile, path.join(first.runtimeRoot, "audit-hardlink"));
  await assert.rejects(() => firstLogger.write(event("hardlink")), auditError);
  await assert.rejects(() => firstLogger.close(), auditError);
  await rm(first.runtimeRoot, { recursive: true, force: true });

  const second = await fixture();
  t.after(() => rm(second.runtimeRoot, { recursive: true, force: true }));
  const secondLogger = await createPairingAuditLogger({ paths: second.paths, generation: 1 });
  await chmod(pairingAuditFilePath(second.paths, 1), 0o644);
  await assert.rejects(() => secondLogger.write(event("mode")), auditError);
  await assert.rejects(() => secondLogger.close(), auditError);
});

test("pairing harness injects one private audit file per instance generation", async (t) => {
  const runtimeRoot = await mkdtemp(path.join("/private/tmp", "bsp-audit-harness-"));
  t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
  const first = await startPairingHarness({ runtimeRoot, instanceId: "poc-a" });
  const second = await startPairingHarness({ runtimeRoot, instanceId: "poc-b" });
  t.after(() => Promise.all([first.close().catch(() => {}), second.close().catch(() => {})]));
  const firstAudit = pairingAuditFilePath(first.paths, first.descriptor.generation);
  const secondAudit = pairingAuditFilePath(second.paths, second.descriptor.generation);
  assert.notEqual(firstAudit, secondAudit);
  assert.equal((await stat(firstAudit)).mode & 0o777, 0o600);
  assert.equal((await stat(secondAudit)).mode & 0o777, 0o600);
});
