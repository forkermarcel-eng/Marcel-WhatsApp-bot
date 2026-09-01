import crypto from "crypto";

/* ==================================================
DEVICE BRIDGE T0 — PROTOCOL V1
================================================== */

export const DEVICE_BRIDGE_PROTOCOL = Object.freeze({
  version: 1,
  heartbeatIntervalSeconds: 30,
  offlineAfterSeconds: 90,
  signatureWindowSeconds: 300,
  maximumRequestBytes: 64 * 1024,
  commands: Object.freeze(["PING", "REQUEST_STATUS", "STOP_BRIDGE"])
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RFC3339_UTC_MILLISECONDS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const BASE64URL_WITHOUT_PADDING = /^[A-Za-z0-9_-]+$/;
const ENROLLMENT_ALPHABET = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

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
