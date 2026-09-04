import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { extensionIdFromPublicKey, GATE_1_EXTENSION_ID, GATE_1_EXTENSION_ORIGIN } from "../core/extension-id.mjs";
import {
  installNativeHost,
  nativeHostManifestContent,
  nativeHostWrapperContent,
  resolveNativeHostPaths,
  uninstallNativeHost,
} from "../core/native-host-manifest.mjs";
import {
  encodeNativeMessage,
  MAX_EXTENSION_TO_HOST_BYTES,
  MAX_HOST_TO_EXTENSION_BYTES,
  NativeMessageDecoder,
} from "../native-host/codec.mjs";
import { runNativeHost } from "../native-host/host.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function collect(stream) {
  const chunks = [];
  stream.on("data", (chunk) => chunks.push(chunk));
  return () => Buffer.concat(chunks);
}

test("manifest public key derives the fixed unpacked extension ID", async () => {
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, "extension", "manifest.json"), "utf8"));
  assert.equal(extensionIdFromPublicKey(manifest.key), GATE_1_EXTENSION_ID);
  assert.deepEqual(manifest.permissions, ["nativeMessaging"]);
  assert.equal(manifest.permissions.includes("debugger"), false);
  assert.equal(manifest.host_permissions, undefined);
  const background = await readFile(path.join(repositoryRoot, "extension", "background.mjs"), "utf8");
  assert.match(background, /chrome\.runtime\.onInstalled\.addListener/);
  assert.match(background, /chrome\.runtime\.connectNative/);
  assert.match(background, /chrome\.runtime\.lastError\?\.message/);
  assert.match(background, /console\.error\("Native Messaging connection closed:", errorMessage\)/);
});

test("Native Messaging codec handles partial and multiple frames", () => {
  const first = encodeNativeMessage({ type: "hello" });
  const second = encodeNativeMessage({ type: "ack" });
  const decoder = new NativeMessageDecoder();

  assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(3), second])), [
    { type: "hello" },
    { type: "ack" },
  ]);
});

test("Native Messaging codec rejects invalid JSON and oversize frames", () => {
  const invalidJson = Buffer.alloc(5);
  invalidJson.writeUInt32LE(1, 0);
  invalidJson[4] = 0xff;
  assert.throws(() => new NativeMessageDecoder().push(invalidJson), /invalid JSON/);

  const oversizedHeader = Buffer.alloc(4);
  oversizedHeader.writeUInt32LE(MAX_EXTENSION_TO_HOST_BYTES + 1, 0);
  assert.throws(() => new NativeMessageDecoder().push(oversizedHeader), /exceeds/);
  assert.throws(
    () => encodeNativeMessage({ payload: "x".repeat(20) }, { maxBytes: 10 }),
    /exceeds/,
  );
  assert.equal(MAX_EXTENSION_TO_HOST_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_HOST_TO_EXTENSION_BYTES, 1 * 1024 * 1024);
});

test("Native Host completes exact-origin hello and ack without stdout diagnostics", async () => {
  const root = await readTemporaryRoot("browser-poc-host-");
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const outputBytes = collect(output);
  const diagnostics = collect(stderr);
  const markerPath = path.join(root, "marker.json");

  const run = runNativeHost({
    input,
    output,
    stderr,
    origin: GATE_1_EXTENSION_ORIGIN,
    markerPath,
  });
  input.end(
    Buffer.concat([
      encodeNativeMessage({ type: "hello", protocol_version: 1 }),
      encodeNativeMessage({ type: "ack", protocol_version: 1 }),
    ]),
  );

  assert.equal(await run, true);
  assert.deepEqual(new NativeMessageDecoder().push(outputBytes()), [
    { type: "hello_ack", protocol_version: 1 },
  ]);
  assert.equal(diagnostics().length, 0);
  assert.deepEqual(JSON.parse(await readFile(markerPath, "utf8")), {
    gate: 1,
    status: "native_messaging_acknowledged",
    recorded_at: (await JSON.parse(await readFile(markerPath, "utf8"))).recorded_at,
  });
  assert.equal((await stat(markerPath)).mode & 0o777, 0o600);
});

test("Native Host rejects an origin that is not an exact match", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const outputBytes = collect(output);
  const diagnostics = collect(stderr);
  input.end();

  assert.equal(
    await runNativeHost({
      input,
      output,
      stderr,
      origin: `${GATE_1_EXTENSION_ORIGIN}unexpected`,
      markerPath: path.join(await readTemporaryRoot("browser-poc-origin-"), "marker.json"),
    }),
    false,
  );
  assert.equal(outputBytes().length, 0);
  assert.match(diagnostics().toString("utf8"), /rejected unexpected extension origin/);
});

test("Native Messaging manifest install and uninstall protect pre-existing files", async () => {
  const root = await readTemporaryRoot("browser-poc-manifest-");
  const paths = resolveNativeHostPaths({
    repositoryRoot,
    runtimeRoot: path.join(root, "runtime"),
    instanceId: "poc-a",
    executablePath: process.execPath,
  });

  assert.equal((await installNativeHost(paths)).installed, true);
  assert.equal(await readFile(paths.manifestPath, "utf8"), nativeHostManifestContent(paths));
  assert.equal(await readFile(paths.wrapperPath, "utf8"), nativeHostWrapperContent(paths));
  assert.equal((await stat(paths.manifestPath)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.wrapperPath)).mode & 0o777, 0o700);
  assert.equal((await installNativeHost(paths)).installed, false);

  assert.equal((await uninstallNativeHost(paths)).removed, true);
  await assert.rejects(() => readFile(paths.manifestPath));
  await assert.rejects(() => readFile(paths.wrapperPath));
});

test("Native Messaging manifest refuses a non-PoC manifest", async () => {
  const root = await readTemporaryRoot("browser-poc-manifest-conflict-");
  const paths = resolveNativeHostPaths({
    repositoryRoot,
    runtimeRoot: path.join(root, "runtime"),
    instanceId: "poc-a",
    executablePath: process.execPath,
  });
  await import("node:fs/promises").then(({ mkdir, writeFile }) =>
    mkdir(path.dirname(paths.manifestPath), { recursive: true }).then(() =>
      writeFile(paths.manifestPath, '{"name":"another-host"}\n'),
    ),
  );

  await assert.rejects(() => installNativeHost(paths), /refusing to overwrite/);
  await assert.rejects(() => uninstallNativeHost(paths), /not generated by this PoC/);
  assert.equal(await readFile(paths.manifestPath, "utf8"), '{"name":"another-host"}\n');
});

test("Native Messaging manifests are isolated to the browser instance user data directory", () => {
  const runtimeRoot = "/tmp/browser-poc-runtime";
  const first = resolveNativeHostPaths({
    repositoryRoot,
    runtimeRoot,
    instanceId: "poc-a",
    executablePath: process.execPath,
  });
  const second = resolveNativeHostPaths({
    repositoryRoot,
    runtimeRoot,
    instanceId: "poc-b",
    executablePath: process.execPath,
  });

  assert.equal(
    first.manifestPath,
    path.join(
      runtimeRoot,
      "profiles",
      "poc-a",
      "NativeMessagingHosts",
      "com.browser_session_poc.gate1.json",
    ),
  );
  assert.equal(first.manifestPath.includes(`${path.sep}Default${path.sep}`), false);
  assert.notEqual(first.manifestPath, second.manifestPath);
  assert.notEqual(first.wrapperPath, second.wrapperPath);
  assert.throws(
    () =>
      resolveNativeHostPaths({
        repositoryRoot,
        runtimeRoot,
        instanceId: "../outside",
        executablePath: process.execPath,
      }),
    /instance ID/,
  );
});

async function readTemporaryRoot(prefix) {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(path.join(os.tmpdir(), prefix));
}
