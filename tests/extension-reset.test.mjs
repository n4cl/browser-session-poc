import assert from "node:assert/strict";
import test from "node:test";
import { attachPairingResetPage } from "../extension/options.mjs";
import { PAIRING_BINDING_STORAGE_KEY, resetPairingBinding } from "../extension/pairing-reset.mjs";

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

test("binding reset removes only the binding before reloading", async () => {
  const calls = [];
  await resetPairingBinding({
    chromeApi: {
      storage: { local: { async remove(key) { calls.push(["remove", key]); } } },
      runtime: { reload() { calls.push(["reload"]); } },
    },
  });
  assert.deepEqual(calls, [["remove", PAIRING_BINDING_STORAGE_KEY], ["reload"]]);
});

test("binding reset does not reload when storage removal fails", async () => {
  let reloads = 0;
  await assert.rejects(
    () => resetPairingBinding({
      chromeApi: {
        storage: { local: { async remove() { throw new Error("storage unavailable"); } } },
        runtime: { reload() { reloads += 1; } },
      },
    }),
    /storage unavailable/,
  );
  assert.equal(reloads, 0);
});

test("options reset ignores a second click and reports failure without reloading", async () => {
  const listeners = [];
  const button = { disabled: false, addEventListener(_, listener) { listeners.push(listener); } };
  const status = { textContent: "" };
  let removeCalls = 0;
  let reloads = 0;
  const documentApi = { getElementById(id) { return id === "reset-pairing" ? button : status; } };
  attachPairingResetPage({
    documentApi,
    chromeApi: {
      storage: { local: { async remove() { removeCalls += 1; throw new Error("failed"); } } },
      runtime: { reload() { reloads += 1; } },
    },
  });
  listeners[0]();
  listeners[0]();
  await settle();
  assert.equal(removeCalls, 1);
  assert.equal(reloads, 0);
  assert.equal(button.disabled, false);
  assert.equal(status.textContent, "削除できませんでした。接続情報は変更されていません。");
});
