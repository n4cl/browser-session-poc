import net from "node:net";
import { lstat, chmod, unlink } from "node:fs/promises";
import { encodeNativeMessage, NativeMessageDecoder } from "../native-host/codec.mjs";
import { validatePairingDescriptor, validateSocketPath } from "./pairing-descriptor.mjs";
import {
  createPairingState,
  disconnectPairingConnection,
  expirePairingState,
  reducePairingMessage,
} from "./pairing-state-machine.mjs";
import { PAIRING_SOCKET_MAX_MESSAGE_BYTES } from "./pairing-protocol.mjs";

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

    const disconnect = () => {
      if (connection.closed) return;
      connection.closed = true;
      this.#sockets.delete(connection);
      if (connection.connectionId !== null && this.#connections.get(connection.connectionId) === connection) {
        this.#connections.delete(connection.connectionId);
        this.#state = disconnectPairingConnection(this.#state, connection.connectionId).state;
      }
    };
    socket.on("close", disconnect);
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
    return this.#state.phase === "REVOKED";
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
