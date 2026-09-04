export const MAX_EXTENSION_TO_HOST_BYTES = 64 * 1024 * 1024;
export const MAX_HOST_TO_EXTENSION_BYTES = 1 * 1024 * 1024;

export function encodeNativeMessage(message, { maxBytes = MAX_HOST_TO_EXTENSION_BYTES } = {}) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > maxBytes) {
    throw new Error(`native message exceeds ${maxBytes} byte limit`);
  }

  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class NativeMessageDecoder {
  #pending = Buffer.alloc(0);

  constructor({ maxBytes = MAX_EXTENSION_TO_HOST_BYTES } = {}) {
    this.maxBytes = maxBytes;
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      throw new TypeError("native message chunk must be bytes");
    }
    this.#pending = Buffer.concat([this.#pending, chunk]);
    const messages = [];

    while (this.#pending.length >= 4) {
      const payloadLength = this.#pending.readUInt32LE(0);
      if (payloadLength > this.maxBytes) {
        throw new Error(`native message exceeds ${this.maxBytes} byte limit`);
      }
      if (this.#pending.length < 4 + payloadLength) {
        break;
      }

      const payload = this.#pending.subarray(4, 4 + payloadLength);
      this.#pending = this.#pending.subarray(4 + payloadLength);
      try {
        messages.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)));
      } catch {
        throw new Error("native message contains invalid JSON");
      }
    }

    return messages;
  }
}
