import assert from "node:assert/strict";
import test from "node:test";
import {
  EXTENSION_RELOAD_EXPRESSION,
  parseDevToolsActivePort,
  readDevToolsActivePort,
  reloadManagedExtension,
} from "../core/extension-reloader.mjs";

const extensionId = "clahiechjmcpfihlnjaoadbfpeachnij";

test("DevToolsActivePort accepts only a loopback browser endpoint path", () => {
  assert.deepEqual(parseDevToolsActivePort("9222\n/devtools/browser/browser-a\n"), {
    port: 9_222,
    webSocketPath: "/devtools/browser/browser-a",
  });
  for (const content of [
    "9222\n/devtools/page/page-a\n",
    "9222\n/devtools/browser/browser-a?secret=1\n",
    "65536\n/devtools/browser/browser-a\n",
    "0\n/devtools/browser/browser-a\n",
    "9222\n/devtools/browser/browser-a\nextra\n",
  ]) {
    assert.throws(() => parseDevToolsActivePort(content));
  }
});

test("DevToolsActivePort is tied to the current user and maintenance startup", async () => {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const profileInfo = {
    isDirectory: () => true,
    mode: 0o40700,
    uid: currentUid,
  };
  const fileInfo = {
    isFile: () => true,
    mode: 0o100600,
    nlink: 1,
    uid: currentUid,
    mtimeMs: 2_000,
  };
  const readOptions = {
    userDataDir: "/tmp/browser-poc/profiles/poc-a",
    minimumMtimeMs: 1_000,
    lstatUserDataDirImpl: async () => profileInfo,
    lstatImpl: async () => fileInfo,
    readFileImpl: async () => "9\n/devtools/browser/browser-a\n",
  };
  assert.deepEqual(await readDevToolsActivePort(readOptions), {
    port: 9,
    webSocketPath: "/devtools/browser/browser-a",
  });
  await assert.rejects(() => readDevToolsActivePort({
    ...readOptions,
    lstatImpl: async () => ({ ...fileInfo, mtimeMs: 999 }),
  }), /endpoint is unavailable/);
  await assert.rejects(() => readDevToolsActivePort({
    ...readOptions,
    lstatImpl: async () => ({ ...fileInfo, nlink: 2 }),
  }), /endpoint is unavailable/);
  assert.deepEqual(await readDevToolsActivePort({
    ...readOptions,
    lstatImpl: async () => ({ ...fileInfo, mode: 0o100644 }),
  }), {
    port: 9,
    webSocketPath: "/devtools/browser/browser-a",
  });
  await assert.rejects(() => readDevToolsActivePort({
    ...readOptions,
    lstatUserDataDirImpl: async () => ({ ...profileInfo, mode: 0o40755 }),
  }), /user data directory is unavailable/);
  await assert.rejects(() => readDevToolsActivePort({
    ...readOptions,
    lstatUserDataDirImpl: async () => ({ ...profileInfo, isDirectory: () => false }),
  }), /user data directory is unavailable/);
  if (currentUid !== undefined) {
    await assert.rejects(() => readDevToolsActivePort({
      ...readOptions,
      lstatImpl: async () => ({ ...fileInfo, uid: currentUid + 1 }),
    }), /endpoint is unavailable/);
    await assert.rejects(() => readDevToolsActivePort({
      ...readOptions,
      lstatUserDataDirImpl: async () => ({ ...profileInfo, uid: currentUid + 1 }),
    }), /user data directory is unavailable/);
  }
});

test("managed Extension reload targets only the dedicated Extension service worker", async () => {
  const calls = [];
  let closed = false;
  const cdp = {
    async request(method, params, sessionId) {
      calls.push({ method, params, sessionId });
      if (method === "Target.getTargets") {
        return {
          targetInfos: [
            { targetId: "foreign", type: "service_worker", url: "chrome-extension://other/background.mjs" },
            { targetId: "extension", type: "service_worker", url: `chrome-extension://${extensionId}/background.mjs` },
          ],
        };
      }
      if (method === "Target.attachToTarget") return { sessionId: "extension-session" };
      assert.equal(method, "Runtime.evaluate");
      assert.equal(sessionId, "extension-session");
      assert.deepEqual(params, {
        expression: EXTENSION_RELOAD_EXPRESSION,
        awaitPromise: false,
        returnByValue: false,
      });
      return { result: { type: "undefined" } };
    },
    close() { closed = true; },
  };
  await reloadManagedExtension({
    userDataDir: "/tmp/browser-poc/profiles/poc-a",
    extensionId,
    readActivePort: async ({ userDataDir }) => {
      assert.equal(userDataDir, "/tmp/browser-poc/profiles/poc-a");
      return { port: 9_222, webSocketPath: "/devtools/browser/browser-a" };
    },
    createCdpClient: async (url) => {
      assert.equal(url, "ws://127.0.0.1:9222/devtools/browser/browser-a");
      return cdp;
    },
  });
  assert.deepEqual(calls, [
    { method: "Target.getTargets", params: undefined, sessionId: undefined },
    { method: "Target.attachToTarget", params: { targetId: "extension", flatten: true }, sessionId: undefined },
    {
      method: "Runtime.evaluate",
      params: {
        expression: EXTENSION_RELOAD_EXPRESSION,
        awaitPromise: false,
        returnByValue: false,
      },
      sessionId: "extension-session",
    },
  ]);
  assert.equal(closed, true);
});

test("managed Extension reload closes CDP when the Extension worker is unavailable", async () => {
  let closed = false;
  await assert.rejects(
    () => reloadManagedExtension({
      userDataDir: "/tmp/browser-poc/profiles/poc-a",
      extensionId,
      readActivePort: async () => ({ port: 9_222, webSocketPath: "/devtools/browser/browser-a" }),
      createCdpClient: async () => ({
        async request() { return { targetInfos: [] }; },
        close() { closed = true; },
      }),
    }),
    /managed Extension service worker is unavailable/,
  );
  assert.equal(closed, true);
});
