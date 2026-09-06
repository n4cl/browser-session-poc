import net from "node:net";
import { lstat, chmod, unlink } from "node:fs/promises";
import { encodeNativeMessage, NativeMessageDecoder } from "../native-host/codec.mjs";
import { validatePairingDescriptor, validateSocketPath } from "./pairing-descriptor.mjs";
import {
  createPairingState,
  disconnectPairingConnection,
  expirePairingState,
  issuePairingPing,
  cancelPairingPing,
  issueBrowserCommand,
  cancelBrowserCommand,
  reducePairingMessage,
} from "./pairing-state-machine.mjs";
import { PAIRING_SOCKET_MAX_MESSAGE_BYTES } from "./pairing-protocol.mjs";
import { assertBrowserCommandTimeout } from "./browser-command-protocol.mjs";

export { PAIRING_SOCKET_MAX_MESSAGE_BYTES } from "./pairing-protocol.mjs";

function modeOf(stat) {
  return stat.mode & 0o777;
}

async function lstatOrNull(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function assertPrivateSocketDirectory(directory) {
  const info = await lstatOrNull(directory);
  if (!info?.isDirectory() || info.isSymbolicLink() || modeOf(info) !== 0o700) {
    throw new Error("pairing socket directory must be a non-symlink directory with mode 0700");
  }
}

function closeNetServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function listenNetServer(server, socketPath) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

/**
 * Session-scoped transport. It never searches for another instance or replaces an existing socket.
 */
export class PairingSocketServer {
  #paths;
  #descriptor;
  #maxMessageBytes;
  #server = null;
  #sockets = new Set();
  #connections = new Map();
  #createdSocketIdentity = null;
  #state;
  #clock;
  #setTimer;
  #clearTimer;
  #expiryTimer = null;
  #pendingPings = new Map();
  #pendingBrowserCommands = new Map();

  constructor({
    paths,
    descriptor,
    profileInstanceId,
    maxMessageBytes = PAIRING_SOCKET_MAX_MESSAGE_BYTES,
    now = new Date(),
    clock = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes <= 0) {
      throw new TypeError("maxMessageBytes must be a positive safe integer");
    }
    if (typeof clock !== "function" || typeof setTimer !== "function" || typeof clearTimer !== "function") {
      throw new TypeError("clock and timer functions are required");
    }
    validatePairingDescriptor(descriptor, { paths, profileInstanceId, now });
    this.#paths = paths;
    this.#descriptor = descriptor;
    this.#maxMessageBytes = maxMessageBytes;
    this.#state = createPairingState(descriptor);
    this.#clock = clock;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  get state() {
    return this.#state;
  }

  requestPing({ requestId, timeoutMs = 1_000 }) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs must be positive");
    this.#expireIfDue();
    const transition = issuePairingPing(this.#state, { requestId });
    this.#state = transition.state;
    return new Promise((resolve, reject) => {
      const timer = this.#setTimer(() => {
        const cancelled = cancelPairingPing(this.#state, requestId);
        this.#state = cancelled.state;
        this.#applyEffects(cancelled.effects);
      }, timeoutMs);
      this.#pendingPings.set(requestId, { resolve, reject, timer });
      this.#applyEffects(transition.effects);
    });
  }

  /** Sends one correlated read-only browser request to this instance's active Extension only. */
  requestBrowserCommand({ command, requestId, timeoutMs = 1_000 }) {
    assertBrowserCommandTimeout(timeoutMs);
    this.#expireIfDue();
    const transition = issueBrowserCommand(this.#state, { command, requestId });
    this.#state = transition.state;
    return new Promise((resolve, reject) => {
      const timer = this.#setTimer(() => {
        const cancelled = cancelBrowserCommand(this.#state, requestId);
        this.#state = cancelled.state;
        this.#applyEffects(cancelled.effects);
      }, timeoutMs);
      this.#pendingBrowserCommands.set(requestId, { resolve, reject, timer, command });
      this.#applyEffects(transition.effects);
    });
  }

  requestBrowserStatus({ requestId, timeoutMs = 1_000 }) {
    return this.requestBrowserCommand({ command: "browser_status", requestId, timeoutMs });
  }

  requestTabsList({ requestId, timeoutMs = 1_000 }) {
    return this.requestBrowserCommand({ command: "tabs_list", requestId, timeoutMs });
  }

  /**
   * PoC-only fault injection for an ACTIVE Native Host transport. The listener,
   * descriptor, and every other instance remain available for that Host's resume.
   */
  disconnectActiveHost() {
    this.#expireIfDue();
    const connectionId = this.#state.activeConnectionId;
    if (this.#state.phase !== "ACTIVE" || connectionId === null) {
      throw new Error("an active host transport is required");
    }
    const connection = this.#connections.get(connectionId);
    if (!connection || connection.closed) {
      throw new Error("the active host transport is unavailable");
    }

    this.#disconnect(connection);
    connection.socket.destroy();
  }

  async listen() {
    if (this.#server !== null) {
      throw new Error("pairing socket server is already listening");
    }
    validateSocketPath(this.#descriptor.socket_path, this.#paths);
    await assertPrivateSocketDirectory(this.#paths.socketDirectory);
    const existing = await lstatOrNull(this.#descriptor.socket_path);
    if (existing !== null) {
      throw new Error("refusing to replace an existing pairing socket path");
    }

    const server = net.createServer((socket) => this.#accept(socket));
    try {
      await listenNetServer(server, this.#descriptor.socket_path);
      const socketInfo = await lstatOrNull(this.#descriptor.socket_path);
      if (!socketInfo?.isSocket() || socketInfo.isSymbolicLink()) {
        throw new Error("pairing socket was not created as a socket");
      }
      this.#createdSocketIdentity = { dev: socketInfo.dev, ino: socketInfo.ino };
      await chmod(this.#descriptor.socket_path, 0o600);
      const privateSocket = await lstatOrNull(this.#descriptor.socket_path);
      if (!privateSocket?.isSocket() || privateSocket.isSymbolicLink() || modeOf(privateSocket) !== 0o600) {
        throw new Error("pairing socket must have mode 0600");
      }
      if (privateSocket.dev !== this.#createdSocketIdentity.dev || privateSocket.ino !== this.#createdSocketIdentity.ino) {
        throw new Error("pairing socket path changed during setup");
      }
      this.#server = server;
      this.#scheduleExpiry();
    } catch (error) {
      await new Promise((resolve) => server.close(() => resolve()));
      await this.#removeOwnedSocket();
      throw error;
    }
  }

  #accept(socket) {
    const decoder = new NativeMessageDecoder({ maxBytes: this.#maxMessageBytes });
    const connection = { socket, connectionId: null, closed: false };
    this.#sockets.add(connection);

    socket.on("close", () => this.#disconnect(connection));
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      try {
        const messages = decoder.push(chunk);
        for (const message of messages) {
          this.#handleMessage(connection, message);
        }
      } catch {
        socket.destroy();
      }
    });
  }

  #disconnect(connection) {
    if (connection.closed) return;
    connection.closed = true;
    this.#sockets.delete(connection);
    if (connection.connectionId === null || this.#connections.get(connection.connectionId) !== connection) {
      return;
    }

    this.#connections.delete(connection.connectionId);
    const wasActive = this.#state.activeConnectionId === connection.connectionId;
    this.#state = disconnectPairingConnection(this.#state, connection.connectionId).state;
    if (wasActive) {
      for (const requestId of [...this.#state.pendingRequestIds]) {
        const cancelled = cancelPairingPing(this.#state, requestId);
        this.#state = cancelled.state;
        this.#applyEffects(cancelled.effects);
      }
      this.#cancelPendingBrowserCommands();
    }
  }

  #handleMessage(connection, message) {
    this.#expireIfDue();
    const declaredConnectionId = message?.host_connection_id;
    if (connection.connectionId !== null && declaredConnectionId !== connection.connectionId) {
      throw new Error("transport connection does not match its pairing connection");
    }
    const { state, effects } = reducePairingMessage(this.#state, message, { now: this.#clock() });
    if (connection.connectionId === null) {
      if (typeof declaredConnectionId !== "string" || this.#connections.has(declaredConnectionId)) {
        throw new Error("pairing connection id is unavailable");
      }
      connection.connectionId = declaredConnectionId;
      this.#connections.set(declaredConnectionId, connection);
    }
    this.#state = state;
    this.#applyEffects(effects);
  }

  #applyEffects(effects) {
    for (const effect of effects) {
      if (effect.type === "ping_resolved" || effect.type === "ping_rejected") {
        const pending = this.#pendingPings.get(effect.requestId);
        if (pending) {
          this.#pendingPings.delete(effect.requestId);
          this.#clearTimer(pending.timer);
          if (effect.type === "ping_resolved") pending.resolve({ requestId: effect.requestId });
          else pending.reject(new Error("pairing ping was not completed"));
        }
        continue;
      }
      if (effect.type === "browser_resolved" || effect.type === "browser_rejected") {
        const pending = this.#pendingBrowserCommands.get(effect.requestId);
        if (pending) {
          this.#pendingBrowserCommands.delete(effect.requestId);
          this.#clearTimer(pending.timer);
          if (effect.type === "browser_resolved") {
            pending.resolve({
              request_id: effect.requestId,
              command: pending.command,
              session_id: this.#descriptor.session_id,
              browser_instance_id: this.#descriptor.browser_instance_id,
              profile_instance_id: this.#descriptor.profile_instance_id,
              generation: this.#descriptor.generation,
              lease_id: this.#descriptor.lease_id,
              ...effect.response,
            });
          } else {
            const error = new Error(`browser command failed: ${effect.response?.errorCode ?? "transport_closed"}`);
            error.code = effect.response?.errorCode ?? "transport_closed";
            pending.reject(error);
          }
        }
        continue;
      }
      const connection = this.#connections.get(effect.connectionId);
      if (!connection) {
        continue;
      }
      if (effect.type === "send") {
        connection.socket.write(encodeNativeMessage(effect.message, { maxBytes: this.#maxMessageBytes }));
      } else if (effect.type === "fence") {
        connection.socket.destroy();
      }
    }
  }

  #expireIfDue() {
    const transition = expirePairingState(this.#state, this.#clock());
    this.#state = transition.state;
    this.#applyEffects(transition.effects);
    if (this.#state.phase === "REVOKED") {
      for (const requestId of [...this.#state.pendingRequestIds]) {
        const cancelled = cancelPairingPing(this.#state, requestId);
        this.#state = cancelled.state;
        this.#applyEffects(cancelled.effects);
      }
      this.#cancelPendingBrowserCommands();
    }
    return this.#state.phase === "REVOKED";
  }

  #cancelPendingBrowserCommands() {
    for (const requestId of [...this.#state.pendingBrowserRequests].map((request) => request.requestId)) {
      const cancelled = cancelBrowserCommand(this.#state, requestId);
      this.#state = cancelled.state;
      this.#applyEffects(cancelled.effects);
    }
  }

  #scheduleExpiry() {
    const now = this.#clock();
    if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
      throw new TypeError("clock must return a valid Date");
    }
    const delay = Date.parse(this.#descriptor.expires_at) - now.valueOf();
    if (delay <= 0) {
      this.#expireIfDue();
      return;
    }
    const maximumDelay = 0x7fffffff;
    this.#expiryTimer = this.#setTimer(() => {
      this.#expiryTimer = null;
      if (!this.#expireIfDue()) {
        this.#scheduleExpiry();
      }
    }, Math.min(delay, maximumDelay));
  }

  #cancelExpiryTimer() {
    if (this.#expiryTimer !== null) {
      this.#clearTimer(this.#expiryTimer);
      this.#expiryTimer = null;
    }
  }

  async #removeOwnedSocket() {
    if (this.#createdSocketIdentity === null) return;
    const current = await lstatOrNull(this.#descriptor.socket_path);
    if (current?.isSocket() && !current.isSymbolicLink() &&
      current.dev === this.#createdSocketIdentity.dev && current.ino === this.#createdSocketIdentity.ino) {
      await unlink(this.#descriptor.socket_path);
    }
    this.#createdSocketIdentity = null;
  }

  async close() {
    this.#cancelExpiryTimer();
    for (const [requestId, pending] of this.#pendingPings) {
      this.#pendingPings.delete(requestId);
      this.#clearTimer(pending.timer);
      pending.reject(new Error("pairing socket server closed"));
    }
    for (const [requestId, pending] of this.#pendingBrowserCommands) {
      this.#pendingBrowserCommands.delete(requestId);
      this.#clearTimer(pending.timer);
      const error = new Error("browser command failed: transport_closed");
      error.code = "transport_closed";
      pending.reject(error);
    }
    for (const connection of this.#sockets) {
      connection.socket.destroy();
    }
    if (this.#server !== null) {
      // Node removes a Unix socket pathname as part of close(). Remove the inode we created first,
      // after verifying it is still ours, so normal shutdown cannot remove an unrelated pre-existing file.
      await this.#removeOwnedSocket();
      const server = this.#server;
      this.#server = null;
      await closeNetServer(server);
    }
    await this.#removeOwnedSocket();
  }
}
