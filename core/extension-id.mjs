import { createHash } from "node:crypto";

export const GATE_1_EXTENSION_ID = "clahiechjmcpfihlnjaoadbfpeachnij";
export const GATE_1_EXTENSION_ORIGIN = `chrome-extension://${GATE_1_EXTENSION_ID}/`;

export function extensionIdFromPublicKey(publicKeyBase64) {
  const digest = createHash("sha256")
    .update(Buffer.from(publicKeyBase64, "base64"))
    .digest("hex")
    .slice(0, 32);
  return [...digest]
    .map((hexCharacter) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(hexCharacter, 16)))
    .join("");
}
