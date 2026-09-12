import crypto from "crypto";

export const T0_DEVICE_CAPABILITIES = Object.freeze([
  "COMMAND_ACK_V1",
  "COMMAND_PING_V1",
  "COMMAND_REQUEST_STATUS_V1",
  "COMMAND_STOP_BRIDGE_V1",
  "DEVICE_HEARTBEAT_V1"
]);

export const TINDER_MANUAL_GATE_CAPABILITY = "TINDER_MANUAL_GATE_V1";
export const TINDER_HUMAN_ARMED_CONVERSATION_BINDING_CAPABILITY =
  "TINDER_HUMAN_ARMED_CONVERSATION_BINDING_V1";
// T5 intentionally remains an exact additive profile.  A device that merely
// knows the older T2 reader/binding contract must never receive an opaque
// send-intent payload.
export const TINDER_MANUAL_SEND_CAPABILITY = "TINDER_DRAFT_SEND_V1";
// V4 is deliberately a separate, exact capability profile.  It authorizes a
// device to acknowledge that a visible-chat sync has been staged; it does not
// authorize a capture, identity resolution, or any Tinder write.
export const TINDER_VISIBLE_CHAT_SYNC_CAPABILITY = "TINDER_VISIBLE_CHAT_SYNC_V1";
// This capability grants only a server-authorized, one-shot dispatch of the
// official launcher intent.  It is deliberately additive to the reader
// profile and never implies a Tinder write, a chat selection, or a capture.
export const TINDER_OFFICIAL_APP_RESUME_CAPABILITY = "TINDER_OFFICIAL_APP_RESUME_V1";
// This capability is deliberately narrower than the visible-chat reader.  It
// permits an already human-selected local Conversation screen to attest its
// continuity to one opaque, server-bound binding revision.  It never carries
// a Tinder identifier and grants no reader, navigation or write authority.
export const TINDER_LOCAL_CONVERSATION_ATTESTATION_CAPABILITY =
  "TINDER_LOCAL_CONVERSATION_ATTESTATION_V1";
// V2 does not broaden the attestation authority.  It is an exact additive
// compatibility contract for the post-chat handoff: a runtime must explicitly
// understand the terminal, local CHAT_VERIFIED path before it can receive a
// new bootstrap or an attested V4 reader command.
export const TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CAPABILITY =
  "TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_V2";
// V8 is a distinct bounded autonomous read/return state machine directly
// over the V6 post-chat profile. Each child command remains empty-payload
// and separately auditable.
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_CAPABILITY =
  "TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_V1";
// This marker is deliberately part of the signed, persisted bootstrap
// command payload rather than inferred from the mutable device profile.  It
// lets every later server-side transition distinguish a new post-chat proof
// from an immutable historical V1 row without introducing a schema field.
export const TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_VERSION = "2";

export const T1_DEVICE_CAPABILITIES = Object.freeze([
  ...T0_DEVICE_CAPABILITIES,
  TINDER_MANUAL_GATE_CAPABILITY
]);

// T2 is an exact additive capability profile.  It does not make a Tinder
// conversation identifiable: it only permits a separately human-authorized,
// one-shot association command to be delivered to the already-connected
// local bridge.
export const T2_DEVICE_CAPABILITIES = Object.freeze([
  ...T1_DEVICE_CAPABILITIES,
  TINDER_HUMAN_ARMED_CONVERSATION_BINDING_CAPABILITY
]);

export const T5_DEVICE_CAPABILITIES = Object.freeze([
  ...T2_DEVICE_CAPABILITIES,
  TINDER_MANUAL_SEND_CAPABILITY
]);

export const T4_DEVICE_CAPABILITIES = Object.freeze([
  // V4 is an independent T2 successor.  It must not silently opt a device
  // into the separate T5 manual-send contract.
  ...T2_DEVICE_CAPABILITIES,
  TINDER_VISIBLE_CHAT_SYNC_CAPABILITY
]);
// Keep the semantic name available to callers which must not infer the
// historical T-stage ordering from the capability profile label.
export const TINDER_VISIBLE_CHAT_SYNC_DEVICE_CAPABILITIES = T4_DEVICE_CAPABILITIES;

// An exact profile prevents a device which merely has the visible-chat reader
// from receiving the separate official-app resume command.  It intentionally
// remains independent of T5's sealed manual-send capability.
export const T4_RESUME_DEVICE_CAPABILITIES = Object.freeze([
  ...T4_DEVICE_CAPABILITIES,
  TINDER_OFFICIAL_APP_RESUME_CAPABILITY
]);
export const TINDER_OFFICIAL_APP_RESUME_DEVICE_CAPABILITIES = T4_RESUME_DEVICE_CAPABILITIES;

// Keep the attestation profile explicitly additive.  Older reader/resume
// builds must not receive a bootstrap command they cannot validate, while an
// attestation-capable device retains every pre-existing read-only capability.
export const T4_RESUME_ATTESTATION_DEVICE_CAPABILITIES = Object.freeze([
  ...T4_RESUME_DEVICE_CAPABILITIES,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_CAPABILITY
]);
export const TINDER_LOCAL_CONVERSATION_ATTESTATION_DEVICE_CAPABILITIES =
  T4_RESUME_ATTESTATION_DEVICE_CAPABILITIES;

// The V1 attestation profile remains a recognized historical profile so its
// heartbeats and terminal invalidations remain safe.  The V2 successor is a
// separate exact profile: it must match the Android V2 heartbeat exactly and
// must not claim the V1 contract that the Android handler intentionally
// refuses for new bootstrap work.
export const T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES = Object.freeze([
  ...T4_RESUME_DEVICE_CAPABILITIES,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CAPABILITY
]);
export const TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES =
  T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES;

export const T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES = Object.freeze([
  ...T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_CAPABILITY
]);
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_DEVICE_CAPABILITIES =
  T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES;

export const T0_DEVICE_BRIDGE_COMMANDS = Object.freeze([
  "PING",
  "REQUEST_STATUS",
  "STOP_BRIDGE"
]);

export const T1_TINDER_MANUAL_GATE_COMMANDS = Object.freeze([
  "CONNECT_TINDER",
  "DISCONNECT_TINDER"
]);

export const T2_TINDER_HUMAN_ARMED_CONVERSATION_COMMANDS = Object.freeze([
  "ARM_TINDER_CONVERSATION_BINDING"
]);

export const T5_TINDER_MANUAL_SEND_COMMANDS = Object.freeze([
  "SEND_TINDER_DRAFT"
]);

export const T4_TINDER_VISIBLE_CHAT_SYNC_COMMANDS = Object.freeze([
  "SYNC_TINDER_VISIBLE_CHAT"
]);

export const T4_TINDER_OFFICIAL_APP_RESUME_COMMANDS = Object.freeze([
  "RESUME_OFFICIAL_TINDER_APP"
]);

export const T4_TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMANDS = Object.freeze([
  "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION"
]);

export const T4_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_COMMANDS = Object.freeze([
  "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT",
  "RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT"
]);

export const DEVICE_BRIDGE_COMMANDS = Object.freeze([
  ...T0_DEVICE_BRIDGE_COMMANDS,
  ...T1_TINDER_MANUAL_GATE_COMMANDS,
  ...T2_TINDER_HUMAN_ARMED_CONVERSATION_COMMANDS,
  ...T5_TINDER_MANUAL_SEND_COMMANDS,
  ...T4_TINDER_VISIBLE_CHAT_SYNC_COMMANDS,
  ...T4_TINDER_OFFICIAL_APP_RESUME_COMMANDS,
  ...T4_TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMANDS,
  ...T4_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_COMMANDS
]);

export const BRIDGE_SERVICE_STATES = Object.freeze([
  "STOPPED",
  "STARTING",
  "RUNNING",
  "STOPPING",
  "ERROR"
]);

export const T0_TINDER_STATES = Object.freeze(["UNKNOWN"]);

export const T1_TINDER_STATES = Object.freeze([
  "DISCONNECTED",
  "CONNECTING",
  "CONNECTED",
  "AUTH_REQUIRED",
  "REVIEW_REQUIRED",
  "UNKNOWN"
]);

export const AUTOMATION_STATES = Object.freeze(["STOPPED"]);

/* ==================================================
DEVICE BRIDGE T0 — PROTOCOL V1
================================================== */

export const DEVICE_BRIDGE_PROTOCOL = Object.freeze({
  version: 1,
  heartbeatIntervalSeconds: 30,
  offlineAfterSeconds: 90,
  signatureWindowSeconds: 300,
  maximumRequestBytes: 64 * 1024,
  commandBatchLimit: 50,
  commands: DEVICE_BRIDGE_COMMANDS
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC3339_UTC_MILLISECONDS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const BASE64URL_WITHOUT_PADDING = /^[A-Za-z0-9_-]+$/;
const ENROLLMENT_ALPHABET = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

function exactArray(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((item, index) => item === right[index]);
}

export function deviceBridgeCapabilityProfile(capabilities) {
  if (exactArray(capabilities, T0_DEVICE_CAPABILITIES)) return "T0";
  if (exactArray(capabilities, T1_DEVICE_CAPABILITIES)) return "T1";
  if (exactArray(capabilities, T2_DEVICE_CAPABILITIES)) return "T2";
  if (exactArray(capabilities, T5_DEVICE_CAPABILITIES)) return "T5";
  if (exactArray(capabilities, T4_DEVICE_CAPABILITIES)) return "T4";
  if (exactArray(capabilities, T4_RESUME_DEVICE_CAPABILITIES)) return "T4_RESUME";
  if (exactArray(capabilities, T4_RESUME_ATTESTATION_DEVICE_CAPABILITIES)) return "T4_RESUME_ATTESTATION";
  if (exactArray(capabilities, T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES)) return "T4_RESUME_ATTESTATION_POST_CHAT";
  if (exactArray(capabilities, T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES)) return "T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP";
  return null;
}

export function isTinderManualGateCapable(capabilities) {
  const profile = deviceBridgeCapabilityProfile(capabilities);
  return profile === "T1" || profile === "T2" || profile === "T5" || profile === "T4" || profile === "T4_RESUME" || profile === "T4_RESUME_ATTESTATION" || profile === "T4_RESUME_ATTESTATION_POST_CHAT" || profile === "T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP";
}

export function isTinderHumanArmedConversationBindingCapable(capabilities) {
  const profile = deviceBridgeCapabilityProfile(capabilities);
  return profile === "T2" || profile === "T5" || profile === "T4" || profile === "T4_RESUME" || profile === "T4_RESUME_ATTESTATION" || profile === "T4_RESUME_ATTESTATION_POST_CHAT" || profile === "T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP";
}

export function isTinderManualSendCapable(capabilities) {
  return deviceBridgeCapabilityProfile(capabilities) === "T5";
}

export function isTinderVisibleChatSyncCapable(capabilities) {
  const profile = deviceBridgeCapabilityProfile(capabilities);
  return profile === "T4" || profile === "T4_RESUME" || profile === "T4_RESUME_ATTESTATION" || profile === "T4_RESUME_ATTESTATION_POST_CHAT" || profile === "T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP";
}

export function isTinderOfficialAppResumeCapable(capabilities) {
  const profile = deviceBridgeCapabilityProfile(capabilities);
  return profile === "T4_RESUME" || profile === "T4_RESUME_ATTESTATION" || profile === "T4_RESUME_ATTESTATION_POST_CHAT" || profile === "T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP";
}

export function isTinderLocalConversationAttestationCapable(capabilities) {
  const profile = deviceBridgeCapabilityProfile(capabilities);
  return profile === "T4_RESUME_ATTESTATION" || profile === "T4_RESUME_ATTESTATION_POST_CHAT" || profile === "T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP";
}

// New bootstrap, its STAGED acknowledgement, signed positive ATTESTED
// ingress, and V2 reader work all require the post-chat profile.  The V1
// profile above remains intentionally recognizable only for fail-closed
// historical-state handling, never for new post-chat authority.
export function isTinderLocalConversationAttestationPostChatCapable(capabilities) {
  const profile = deviceBridgeCapabilityProfile(capabilities);
  return profile === "T4_RESUME_ATTESTATION_POST_CHAT"
    || profile === "T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP";
}

export function isTinderUnboundInboxConversationSweepCapable(capabilities) {
  return deviceBridgeCapabilityProfile(capabilities)
    === "T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP";
}

export function isKnownTinderStateForCapabilities(state, capabilities) {
  const allowed = isTinderManualGateCapable(capabilities)
    ? T1_TINDER_STATES
    : T0_TINDER_STATES;
  return allowed.includes(state);
}

export class DeviceBridgeProtocolError extends Error {
  constructor(status, code, message, retryable = false) {
    super(message);
    this.name = "DeviceBridgeProtocolError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export function protocolErrorBody(error, requestId = null, now = new Date()) {
  const known = error instanceof DeviceBridgeProtocolError;
  return {
    ok: false,
    protocol_version: DEVICE_BRIDGE_PROTOCOL.version,
    error: {
      code: known ? error.code : "INTERNAL_ERROR",
      message: known ? error.message : "Internal device bridge error",
      retryable: known ? error.retryable : false
    },
    request_id: isUuidV4(requestId) ? requestId : null,
    server_time: now.toISOString()
  };
}

export function isUuidV4(value) {
  return typeof value === "string" && UUID_V4.test(value);
}

export function isExactUtcTimestamp(value) {
  if (typeof value !== "string" || !RFC3339_UTC_MILLISECONDS.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export function assertTimestampWithinWindow(value, now = new Date()) {
  if (!isExactUtcTimestamp(value)) {
    throw new DeviceBridgeProtocolError(400, "INVALID_HEADER", "Request timestamp is invalid");
  }
  const differenceSeconds = Math.abs(now.valueOf() - new Date(value).valueOf()) / 1000;
  if (differenceSeconds > DEVICE_BRIDGE_PROTOCOL.signatureWindowSeconds) {
    throw new DeviceBridgeProtocolError(401, "TIMESTAMP_OUT_OF_WINDOW", "Request timestamp is outside the accepted window");
  }
}

export function assertJsonUtf8ContentType(value) {
  if (typeof value !== "string" || value.toLowerCase() !== "application/json; charset=utf-8") {
    throw new DeviceBridgeProtocolError(400, "INVALID_CONTENT_TYPE", "Content-Type must be application/json; charset=utf-8");
  }
}

export function assertRawBody(body) {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new DeviceBridgeProtocolError(400, "INVALID_BODY", "A non-empty raw request body is required");
  }
  if (body.length > DEVICE_BRIDGE_PROTOCOL.maximumRequestBytes) {
    throw new DeviceBridgeProtocolError(400, "REQUEST_TOO_LARGE", "Device bridge request exceeds 64 KiB");
  }
  return body;
}

export function sha256Hex(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError("SHA-256 input must be bytes");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function isLowercaseSha256(value) {
  return typeof value === "string" && LOWERCASE_SHA256.test(value);
}

export function isBase64UrlWithoutPadding(value) {
  return typeof value === "string" && BASE64URL_WITHOUT_PADDING.test(value) && !value.includes("=");
}

export function canonicalRequest({ protocolVersion, method, path, timestamp, requestId, contentSha256 }) {
  if (protocolVersion !== DEVICE_BRIDGE_PROTOCOL.version) {
    throw new DeviceBridgeProtocolError(426, "UNSUPPORTED_PROTOCOL_VERSION", "Unsupported device bridge protocol version");
  }
  if (typeof method !== "string" || method !== method.toUpperCase()) {
    throw new DeviceBridgeProtocolError(400, "INVALID_HEADER", "HTTP method must be uppercase");
  }
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("?")) {
    throw new DeviceBridgeProtocolError(400, "INVALID_HEADER", "Signed device bridge paths must not contain a query string");
  }
  if (!isExactUtcTimestamp(timestamp) || !isUuidV4(requestId) || !isLowercaseSha256(contentSha256)) {
    throw new DeviceBridgeProtocolError(400, "INVALID_HEADER", "Canonical request fields are invalid");
  }
  return [String(protocolVersion), method, path, timestamp, requestId, contentSha256].join("\n");
}

export function parseP256Spki(publicKeyBase64) {
  if (typeof publicKeyBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(publicKeyBase64)) {
    throw new DeviceBridgeProtocolError(400, "ENROLLMENT_PROOF_INVALID", "Public key encoding is invalid");
  }
  try {
    const der = Buffer.from(publicKeyBase64, "base64");
    if (der.length === 0 || der.toString("base64") !== publicKeyBase64) throw new Error("Non-canonical Base64");
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    const details = key.asymmetricKeyDetails || {};
    if (key.asymmetricKeyType !== "ec" || details.namedCurve !== "prime256v1") throw new Error("Not P-256");
    return key;
  } catch {
    throw new DeviceBridgeProtocolError(400, "ENROLLMENT_PROOF_INVALID", "Public key must be an EC P-256 SPKI key");
  }
}

export function verifyEcdsaSha256({ publicKey, canonicalBytes, signatureBase64Url }) {
  if (!isBase64UrlWithoutPadding(signatureBase64Url)) return false;
  try {
    return crypto.verify("sha256", Buffer.from(canonicalBytes), publicKey, Buffer.from(signatureBase64Url, "base64url"));
  } catch {
    return false;
  }
}

export function normalizeEnrollmentCode(value) {
  if (typeof value !== "string") throw new DeviceBridgeProtocolError(401, "ENROLLMENT_CODE_INVALID", "Enrollment code is invalid");
  const normalized = value.replaceAll("-", "").toUpperCase();
  if (!ENROLLMENT_ALPHABET.test(normalized)) throw new DeviceBridgeProtocolError(401, "ENROLLMENT_CODE_INVALID", "Enrollment code is invalid");
  return normalized;
}

export function enrollmentCodeDigest(value) {
  return sha256Hex(Buffer.from(normalizeEnrollmentCode(value), "ascii"));
}

export function publicKeyFingerprint(publicKey) {
  return sha256Hex(publicKey.export({ format: "der", type: "spki" }));
}

const SAFE_AUDIT_FIELDS = new Set([
  "request_id", "device_id", "key_id", "command_id", "event_type", "result_code",
  "http_status", "latency_ms", "sequence", "app_version", "public_key_fingerprint"
]);

export function safeAuditDetails(details = {}) {
  return Object.fromEntries(Object.entries(details).filter(([key, value]) => SAFE_AUDIT_FIELDS.has(key) && value !== undefined));
}

export function deviceBridgeAudit(logger, eventType, details = {}) {
  logger.info({ device_bridge: safeAuditDetails({ ...details, event_type: eventType }) }, "Device Bridge audit event");
}
