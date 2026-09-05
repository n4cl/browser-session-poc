export const PAIRING_BINDING_STORAGE_KEY = "pairing_binding";

/** Removes only the confirmed pairing binding. Reload happens only after that succeeds. */
export async function resetPairingBinding({ chromeApi, storageKey = PAIRING_BINDING_STORAGE_KEY } = {}) {
  if (!chromeApi?.storage?.local?.remove || !chromeApi?.runtime?.reload) {
    throw new TypeError("Chrome storage.local.remove and runtime.reload are required");
  }
  await chromeApi.storage.local.remove(storageKey);
  chromeApi.runtime.reload();
}
