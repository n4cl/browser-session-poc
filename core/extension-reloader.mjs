import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { GATE_1_EXTENSION_ID } from "./extension-id.mjs";

export const DEVTOOLS_ACTIVE_PORT_FILENAME = "DevToolsActivePort";
export const EXTENSION_RELOAD_EXPRESSION = "setTimeout(() => chrome.runtime.reload(), 0);";
const DEVTOOLS_BROWSER_PATH_PREFIX = "/devtools/browser/";

function fail(message) {
  throw new Error(message);
}

function assertLoopbackWebSocketUrl(webSocketUrl, port) {
  let parsed;
  try {
    parsed = new URL(webSocketUrl);
  } catch {
    fail("invalid DevTools browser endpoint");
  }
  if (
    parsed.protocol !== "ws:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== String(port) ||
    !parsed.pathname.startsWith(DEVTOOLS_BROWSER_PATH_PREFIX) ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    fail("invalid DevTools browser endpoint");
  }
  return parsed.href;
}

export function parseDevToolsActivePort(content) {
  if (typeof content !== "string") fail("invalid DevTools active port file");
  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 2) fail("invalid DevTools active port file");
  if (!/^\d{1,5}$/u.test(lines[0])) fail("invalid DevTools active port file");
  const port = Number.parseInt(lines[0], 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) fail("invalid DevTools active port file");
  if (!/^\/devtools\/browser\/[A-Za-z0-9._~-]+$/u.test(lines[1])) {
    fail("invalid DevTools active port file");
  }
  return { port, webSocketPath: lines[1] };
}

export async function readDevToolsActivePort({
  userDataDir,
  minimumMtimeMs = null,
  readFileImpl = readFile,
  lstatImpl = lstat,
  lstatUserDataDirImpl = lstat,
}) {
  if (typeof userDataDir !== "string" || !path.isAbsolute(userDataDir)) {
    fail("invalid managed Chrome user data directory");
  }
  let profileInfo;
  try {
    profileInfo = await lstatUserDataDirImpl(userDataDir);
  } catch {
    fail("managed Chrome user data directory is unavailable");
  }
  const profileOwnerMatches = typeof process.getuid !== "function" || profileInfo.uid === process.getuid();
  if (
    !profileInfo.isDirectory() ||
    !profileOwnerMatches ||
    (profileInfo.mode & 0o777) !== 0o700
  ) {
    fail("managed Chrome user data directory is unavailable");
  }
  const filePath = path.join(userDataDir, DEVTOOLS_ACTIVE_PORT_FILENAME);
  let info;
  try {
    info = await lstatImpl(filePath);
  } catch {
    fail("managed Chrome DevTools endpoint is unavailable");
  }
  const ownerMatches = typeof process.getuid !== "function" || info.uid === process.getuid();
  const mtimeMatches =
    minimumMtimeMs === null || (Number.isFinite(info.mtimeMs) && info.mtimeMs >= minimumMtimeMs);
  const fileMode = info.mode & 0o777;
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    !ownerMatches ||
    !mtimeMatches ||
    (fileMode !== 0o600 && fileMode !== 0o644)
  ) {
    fail("managed Chrome DevTools endpoint is unavailable");
  }
  let content;
  try {
    content = await readFileImpl(filePath, "utf8");
  } catch {
    fail("managed Chrome DevTools endpoint is unavailable");
  }
  return parseDevToolsActivePort(content);
}

function extensionTarget(targetInfo, extensionId) {
  return targetInfo?.type === "service_worker" && targetInfo.url === `chrome-extension://${extensionId}/background.mjs`;
}

export async function connectBrowserCdp(
  webSocketUrl,
  { WebSocketImpl = globalThis.WebSocket, timeoutMs = 5_000, setTimer = setTimeout, clearTimer = clearTimeout } = {},
) {
  if (typeof WebSocketImpl !== "function") fail("managed Chrome DevTools is unavailable");
  const socket = new WebSocketImpl(webSocketUrl);
  let nextId = 1;
  let opened = false;
  let closed = false;
  const pending = new Map();
  let rejectConnection;
  const connectionFailure = new Promise((_, reject) => { rejectConnection = reject; });
  const rejectPending = (error) => {
    if (closed) return;
    closed = true;
    rejectConnection(error);
    for (const waiter of pending.values()) {
      clearTimer(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };
  const messageHandler = (event) => {
    let message;
    try {
      const data = typeof event?.data === "string" ? event.data : String(event?.data ?? "");
      message = JSON.parse(data);
    } catch {
      rejectPending(new Error("invalid DevTools response"));
      return;
    }
    if (!Number.isSafeInteger(message?.id)) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimer(waiter.timer);
    if (message.error) waiter.reject(new Error("DevTools request failed"));
    else waiter.resolve(message.result);
  };
  const errorHandler = () => rejectPending(new Error("managed Chrome DevTools transport failed"));
  const closeHandler = () => rejectPending(new Error("managed Chrome DevTools transport closed"));
  socket.addEventListener("message", messageHandler);
  socket.addEventListener("error", errorHandler);
  socket.addEventListener("close", closeHandler);
  const openPromise = new Promise((resolve, reject) => {
    const timer = setTimer(() => reject(new Error("managed Chrome DevTools connection timed out")), timeoutMs);
    socket.addEventListener("open", () => {
      clearTimer(timer);
      opened = true;
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimer(timer);
      reject(new Error("managed Chrome DevTools connection failed"));
    }, { once: true });
  });
  await Promise.race([openPromise, connectionFailure]);
  return {
    request(method, params = {}, sessionId = undefined) {
      if (!opened || closed) return Promise.reject(new Error("managed Chrome DevTools is closed"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => {
          pending.delete(id);
          reject(new Error("managed Chrome DevTools request timed out"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        } catch {
          clearTimer(timer);
          pending.delete(id);
          reject(new Error("managed Chrome DevTools transport failed"));
        }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const waiter of pending.values()) {
        clearTimer(waiter.timer);
        waiter.reject(new Error("managed Chrome DevTools closed"));
      }
      pending.clear();
      socket.close();
    },
  };
}

export async function reloadManagedExtension({
  userDataDir,
  extensionId = GATE_1_EXTENSION_ID,
  minimumMtimeMs = null,
  readActivePort = readDevToolsActivePort,
  createCdpClient = connectBrowserCdp,
}) {
  const { port, webSocketPath } = await readActivePort({ userDataDir, minimumMtimeMs });
  const webSocketUrl = assertLoopbackWebSocketUrl(`ws://127.0.0.1:${port}${webSocketPath}`, port);
  const cdp = await createCdpClient(webSocketUrl);
  try {
    const targets = await cdp.request("Target.getTargets");
    const targetInfo = targets?.targetInfos?.find((candidate) => extensionTarget(candidate, extensionId));
    if (!targetInfo) fail("managed Extension service worker is unavailable");
    const attached = await cdp.request("Target.attachToTarget", { targetId: targetInfo.targetId, flatten: true });
    if (typeof attached?.sessionId !== "string" || attached.sessionId.length === 0) {
      fail("managed Extension service worker is unavailable");
    }
    const evaluated = await cdp.request("Runtime.evaluate", {
      expression: EXTENSION_RELOAD_EXPRESSION,
      awaitPromise: false,
      returnByValue: false,
    }, attached.sessionId);
    if (evaluated?.exceptionDetails) fail("managed Extension reload failed");
  } finally {
    cdp.close();
  }
}
