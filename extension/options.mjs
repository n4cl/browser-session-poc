import { resetPairingBinding } from "./pairing-reset.mjs";
import { createPairingWake } from "./pairing-protocol.mjs";

export function notifyPairingWake({ chromeApi = chrome } = {}) {
  const sendMessage = chromeApi?.runtime?.sendMessage;
  if (typeof sendMessage !== "function") return;
  try {
    const result = sendMessage(createPairingWake());
    if (result && typeof result.catch === "function") {
      void result.catch(() => {});
    }
  } catch {
    // A sleeping service worker or an unavailable receiver must not affect the Options page.
  }
}

function requiredElement(documentApi, id) {
  const element = documentApi.getElementById(id);
  if (!element) {
    throw new Error(`missing options element: ${id}`);
  }
  return element;
}

export function attachPairingResetPage({ documentApi = document, chromeApi = chrome } = {}) {
  notifyPairingWake({ chromeApi });
  const button = requiredElement(documentApi, "reset-pairing");
  const status = requiredElement(documentApi, "status");
  let pending = false;

  button.addEventListener("click", async () => {
    if (pending) {
      return;
    }
    pending = true;
    button.disabled = true;
    status.textContent = "保存済みの接続情報を削除しています…";
    try {
      await resetPairingBinding({ chromeApi });
    } catch {
      status.textContent = "削除できませんでした。接続情報は変更されていません。";
      button.disabled = false;
      pending = false;
    }
  });
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  attachPairingResetPage();
}
