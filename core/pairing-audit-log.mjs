import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { BROWSER_COMMANDS, BROWSER_ERROR_CODES } from "./browser-command-protocol.mjs";

export const AUDIT_ERROR_CODE = "audit_unavailable";
export const PAIRING_AUDIT_FIELDS = Object.freeze([
  "session_id",
  "browser_instance_id",
  "profile_instance_id",
  "generation",
  "request_id",
  "command",
  "outcome",
  "timestamp",
]);
export const PAIRING_AUDIT_OUTCOMES = Object.freeze([
  "issued",
  "success",
  ...BROWSER_ERROR_CODES,
]);

function modeOf(info) {
  return info.mode & 0o777;
}

function auditUnavailable() {
  const error = new Error(AUDIT_ERROR_CODE);
  error.code = AUDIT_ERROR_CODE;
  return error;
}

function exactFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw auditUnavailable();
  const actual = Object.keys(value).sort();
  const expected = [...PAIRING_AUDIT_FIELDS].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw auditUnavailable();
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function validTimestamp(value) {
  if (!nonEmptyString(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function validatePairingAuditEvent(event) {
  exactFields(event);
  if (!nonEmptyString(event.session_id) || !nonEmptyString(event.browser_instance_id) ||
    !nonEmptyString(event.profile_instance_id) || !Number.isSafeInteger(event.generation) || event.generation <= 0 ||
    !nonEmptyString(event.request_id) || !BROWSER_COMMANDS.includes(event.command) ||
    !PAIRING_AUDIT_OUTCOMES.includes(event.outcome) || !validTimestamp(event.timestamp)) {
    throw auditUnavailable();
  }
  return { ...event };
}

function currentUid() {
  if (typeof process.getuid !== "function") throw auditUnavailable();
  const uid = process.getuid();
  if (!Number.isSafeInteger(uid) || uid < 0) throw auditUnavailable();
  return uid;
}

async function inspect(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw auditUnavailable();
  }
}

function assertPrivateDirectory(info, uid) {
  if (!info || info.isSymbolicLink() || !info.isDirectory() || modeOf(info) !== 0o700 || info.uid !== uid) {
    throw auditUnavailable();
  }
}

function assertPrivateFile(info, uid) {
  if (!info || info.isSymbolicLink() || !info.isFile() || modeOf(info) !== 0o600 || info.uid !== uid || info.nlink !== 1) {
    throw auditUnavailable();
  }
}

function auditFilePath(paths, generation) {
  if (!paths || typeof paths.instanceDir !== "string" || !Number.isSafeInteger(generation) || generation <= 0) {
    throw auditUnavailable();
  }
  return path.join(paths.instanceDir, `audit-${generation}.jsonl`);
}

export function pairingAuditFilePath(paths, generation) {
  return auditFilePath(paths, generation);
}

/**
 * Creates one append-only audit file for one instance generation. The file is
 * intentionally new-only; an existing generation file is never appended to.
 */
export async function createPairingAuditLogger({ paths, generation, uid = currentUid() }) {
  const filePath = auditFilePath(paths, generation);
  try {
    if (!Number.isSafeInteger(uid) || uid < 0) throw auditUnavailable();
    assertPrivateDirectory(await inspect(paths.instanceDir), uid);
  } catch {
    throw auditUnavailable();
  }

  let handle;
  try {
    handle = await open(filePath, "wx", 0o600);
    const fileInfo = await handle.stat();
    const pathInfo = await inspect(filePath);
    assertPrivateFile(fileInfo, uid);
    assertPrivateFile(pathInfo, uid);
    if (fileInfo.dev !== pathInfo.dev || fileInfo.ino !== pathInfo.ino) throw auditUnavailable();
  } catch {
    await handle?.close().catch(() => {});
    throw auditUnavailable();
  }

  let closing = false;
  let closed = false;
  let unhealthy = false;
  let firstFailure = null;
  let tail = Promise.resolve();
  let closePromise = null;

  const verifyOpenFile = async () => {
    const fileInfo = await handle.stat();
    const pathInfo = await inspect(filePath);
    assertPrivateFile(fileInfo, uid);
    assertPrivateFile(pathInfo, uid);
    if (fileInfo.dev !== pathInfo.dev || fileInfo.ino !== pathInfo.ino) throw auditUnavailable();
  };

  const write = async (event) => {
    const safeEvent = validatePairingAuditEvent(event);
    if (closing || closed || unhealthy) throw auditUnavailable();
    const task = tail.then(async () => {
      if (unhealthy) throw auditUnavailable();
      try {
        await verifyOpenFile();
        await handle.write(`${JSON.stringify(safeEvent)}\n`, null, "utf8");
      } catch {
        throw auditUnavailable();
      }
    });
    tail = task.catch((error) => {
      unhealthy = true;
      firstFailure ??= error;
    });
    await task;
  };

  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      await tail;
      let failure = firstFailure;
      try {
        await handle.sync();
      } catch {
        failure ??= auditUnavailable();
      }
      try {
        await handle.close();
      } catch {
        failure ??= auditUnavailable();
      }
      closed = true;
      if (failure) throw auditUnavailable();
    })();
    return closePromise;
  };

  return Object.freeze({ write, close });
}
