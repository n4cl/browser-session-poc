export const PAIRING_PROTOCOL_VERSION = 1;

const BINDING_FIELDS = [
  "session_id",
  "browser_instance_id",
  "profile_instance_id",
  "generation",
  "lease_id",
];

function fail() {
  throw new Error("invalid pairing protocol message");
}

function exactFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) fail();
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function validBindingField(field, value) {
  return field === "generation"
    ? Number.isSafeInteger(value) && value > 0
    : nonEmptyString(value);
}

export function validateBinding(binding) {
  exactFields(binding, BINDING_FIELDS);
  if (!BINDING_FIELDS.every((field) => validBindingField(field, binding[field]))) fail();
  return binding;
}

function identityOf(message) {
  return Object.fromEntries(BINDING_FIELDS.map((field) => [field, message[field]]));
}

function validateIdentity(message, binding) {
  for (const field of BINDING_FIELDS) {
    if (message[field] !== binding[field]) fail();
  }
}

function validateConnectionId(value) {
  if (!nonEmptyString(value)) fail();
}

export function startPairing(binding) {
  if (binding === null || binding === undefined) {
    return { type: "pair_start", protocol_version: PAIRING_PROTOCOL_VERSION };
  }
  validateBinding(binding);
  return { type: "resume_start", protocol_version: PAIRING_PROTOCOL_VERSION, ...binding };
}

export function validatePairChallenge(message, { binding }) {
  exactFields(message, [
    "type",
    "protocol_version",
    ...BINDING_FIELDS,
    "host_connection_id",
    "pairing_mode",
  ]);
  if (message.type !== "pair_challenge" || message.protocol_version !== PAIRING_PROTOCOL_VERSION) fail();
  validateBinding(identityOf(message));
  validateConnectionId(message.host_connection_id);
  const expectedMode = binding === null || binding === undefined ? "initial" : "resume";
  if (message.pairing_mode !== expectedMode) fail();
  if (expectedMode === "resume") validateIdentity(message, binding);
  return {
    binding: identityOf(message),
    hostConnectionId: message.host_connection_id,
    mode: expectedMode,
  };
}

export function createPairAck(challenge) {
  if (!challenge || !validateBinding(challenge.binding) || !nonEmptyString(challenge.hostConnectionId)) fail();
  return {
    type: "pair_ack",
    protocol_version: PAIRING_PROTOCOL_VERSION,
    ...challenge.binding,
    host_connection_id: challenge.hostConnectionId,
  };
}

export function validatePairActive(message, challenge) {
  exactFields(message, ["type", "protocol_version", ...BINDING_FIELDS, "host_connection_id"]);
  if (message.type !== "pair_active" || message.protocol_version !== PAIRING_PROTOCOL_VERSION) fail();
  validateBinding(identityOf(message));
  if (!challenge || message.host_connection_id !== challenge.hostConnectionId) fail();
  validateIdentity(message, challenge.binding);
  return identityOf(message);
}
