const NATIVE_HOST_NAME = "com.browser_session_poc.gate1";
const PROTOCOL_VERSION = 1;

let port;

function connectNativeHost() {
  if (port) {
    return;
  }

  let acknowledged = false;
  port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  port.onMessage.addListener((message) => {
    if (
      !acknowledged &&
      message?.type === "hello_ack" &&
      message.protocol_version === PROTOCOL_VERSION
    ) {
      acknowledged = true;
      port.postMessage({ type: "ack", protocol_version: PROTOCOL_VERSION });
    }
  });
  port.onDisconnect.addListener(() => {
    const errorMessage = chrome.runtime.lastError?.message;
    if (errorMessage) {
      console.error("Native Messaging connection closed:", errorMessage);
    }
    port = undefined;
  });
  port.postMessage({ type: "hello", protocol_version: PROTOCOL_VERSION });
}

chrome.runtime.onInstalled.addListener(connectNativeHost);
chrome.runtime.onStartup.addListener(connectNativeHost);
connectNativeHost();
