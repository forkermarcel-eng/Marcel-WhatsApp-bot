import crypto from "crypto";
import {
  DEVICE_BRIDGE_PROTOCOL,
  DeviceBridgeProtocolError,
  assertTimestampWithinWindow,
  canonicalRequest,
  enrollmentCodeDigest,
  isLowercaseSha256,
  isUuidV4,
  normalizeEnrollmentCode,
  parseP256Spki,
  protocolErrorBody,
  publicKeyFingerprint,
  sha256Hex,
  verifyEcdsaSha256
} from "./protocol-v1.js";

/* ==================================================
DEVICE BRIDGE T0 — PROTOCOL V1 ENROLLMENT
================================================== */

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const REQUIRED_CAPABILITIES = Object.freeze([
  "COMMAND_ACK_V1",
  "COMMAND_PING_V1",
  "COMMAND_REQUEST_STATUS_V1",
  "COMMAND_STOP_BRIDGE_V1",
  "DEVICE_HEARTBEAT_V1"
]);
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_ATTEMPTS = 20;
const RATE_LIMIT_MAX_SUBJECTS = 4096;
const enrollmentAttempts = new Map();

function invalidBody(message = "Enrollment request is invalid") {
  return new DeviceBridgeProtocolError(400, "INVALID_BODY", message);
}

function requiredHeader(req, name) {
  const value = req.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new DeviceBridgeProtocolError(400, "MISSING_HEADER", `Required header ${name} is missing`);
  }
  return value;
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidBody(`${name} must be an object`);
}

function assertString(value, name, maximum = 128) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw invalidBody(`${name} is invalid`);
}

function assertExactCapabilities(value) {
  if (!Array.isArray(value) || value.length !== REQUIRED_CAPABILITIES.length ||
      value.some((item, index) => item !== REQUIRED_CAPABILITIES[index])) {
    throw invalidBody("capabilities are invalid");
  }
}

export function generateEnrollmentCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(16);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) throw new Error("Enrollment entropy source must return 16 bytes");
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let normalized = "";
  for (let index = 0; index < 26; index += 1) {
    normalized = CROCKFORD_ALPHABET[Number(value & 31n)] + normalized;
    value >>= 5n;
  }
  return {
    normalized,
    grouped: `${normalized.slice(0, 5)}-${normalized.slice(5, 10)}-${normalized.slice(10, 15)}-${normalized.slice(15, 20)}-${normalized.slice(20)}`
  };
}

export function createEnrollmentCodeRecord(displayName, now = new Date(), randomBytes = crypto.randomBytes) {
  assertString(displayName, "display_name");
  const code = generateEnrollmentCode(randomBytes);
  return {
    enrollmentCodeId: crypto.randomUUID(),
    codeDigest: enrollmentCodeDigest(code.normalized),
    displayName,
    expiresAt: new Date(now.valueOf() + 10 * 60 * 1000),
    groupedCode: code.grouped
  };
}

export function createAdminEnrollmentCodeHandler(pool) {
  return async function adminEnrollmentCodeHandler(req, res) {
    let client;
    try {
      const record = createEnrollmentCodeRecord(req.body?.display_name);
      client = await pool.connect();
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO device_bridge_enrollment_codes
          (enrollment_code_id, code_digest, display_name, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [record.enrollmentCodeId, record.codeDigest, record.displayName, record.expiresAt]
      );
      await client.query(
        `INSERT INTO device_bridge_audit_events (event_type, result_code, http_status)
         VALUES ('ENROLLMENT_CODE_CREATED', 'SUCCEEDED', 201)`
      );
      await client.query("COMMIT");
      res.status(201).json({
        ok: true,
        enrollment_code: record.groupedCode,
        expires_at: record.expiresAt.toISOString()
      });
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      if (error instanceof DeviceBridgeProtocolError) {
        return res.status(error.status).json(protocolErrorBody(error));
      }
      console.error("Device Bridge enrollment-code creation failed.");
      return res.status(500).json(protocolErrorBody(error));
    } finally {
      client?.release();
    }
  };
}

function rateLimitSubject(req) {
  return crypto.createHash("sha256").update(String(req.ip || req.socket?.remoteAddress || "unknown")).digest("hex");
}

export function consumeEnrollmentRateLimit(req, nowMs = Date.now()) {
  for (const [key, entry] of enrollmentAttempts) {
    if (entry.resetAt <= nowMs) enrollmentAttempts.delete(key);
  }
  const subject = rateLimitSubject(req);
  const existing = enrollmentAttempts.get(subject);
  if (existing && existing.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    throw new DeviceBridgeProtocolError(429, "RATE_LIMITED", "Enrollment request rate limit exceeded", true);
  }
  if (!existing && enrollmentAttempts.size >= RATE_LIMIT_MAX_SUBJECTS) {
    const oldest = enrollmentAttempts.keys().next().value;
    enrollmentAttempts.delete(oldest);
  }
  enrollmentAttempts.set(subject, existing
    ? { count: existing.count + 1, resetAt: existing.resetAt }
    : { count: 1, resetAt: nowMs + RATE_LIMIT_WINDOW_MS });
}

export function resetEnrollmentRateLimitForTests() {
  enrollmentAttempts.clear();
}

export function parseAndValidateEnrollmentRequest(req, now = new Date()) {
  if (req.get("x-marcel-device-id") !== undefined || req.get("x-marcel-key-id") !== undefined) {
    throw new DeviceBridgeProtocolError(400, "INVALID_HEADER", "Device and key headers must be absent during enrollment");
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw new DeviceBridgeProtocolError(400, "INVALID_JSON", "Enrollment request body is not valid JSON");
  }
  assertPlainObject(body, "body");
  const protocolHeader = requiredHeader(req, "x-marcel-protocol-version");
  if (protocolHeader !== "1") throw new DeviceBridgeProtocolError(426, "UNSUPPORTED_PROTOCOL_VERSION", "Unsupported device bridge protocol version");
  if (body.protocol_version !== Number(protocolHeader)) throw new DeviceBridgeProtocolError(400, "PROTOCOL_VERSION_MISMATCH", "Protocol header and body differ");
  if (!isUuidV4(body.enrollment_attempt_id) || !isUuidV4(body.installation_id)) throw invalidBody("Enrollment identifiers are invalid");
  assertString(body.display_name, "display_name");
  assertPlainObject(body.public_key, "public_key");
  if (body.public_key.algorithm !== "EC_P256_SHA256" || body.public_key.format !== "SPKI_DER_BASE64") throw invalidBody("Public key metadata is invalid");
  assertPlainObject(body.app, "app");
  assertString(body.app.version_name, "app.version_name", 64);
  if (!Number.isSafeInteger(body.app.version_code) || body.app.version_code < 0) throw invalidBody("app.version_code is invalid");
  assertPlainObject(body.device, "device");
  assertString(body.device.manufacturer, "device.manufacturer", 64);
  assertString(body.device.model, "device.model", 128);
  if (!Number.isInteger(body.device.android_api) || body.device.android_api < 24) throw invalidBody("device.android_api is invalid");
  if (!Array.isArray(body.device.abis) || body.device.abis.length < 1 || body.device.abis.length > 8 || body.device.abis.some(abi => typeof abi !== "string" || abi.length < 1 || abi.length > 64)) throw invalidBody("device.abis is invalid");
  assertExactCapabilities(body.capabilities);

  const timestamp = requiredHeader(req, "x-marcel-timestamp");
  if (body.requested_at !== timestamp) throw new DeviceBridgeProtocolError(400, "INVALID_BODY", "requested_at must equal the request timestamp");
  assertTimestampWithinWindow(timestamp, now);
  const requestId = requiredHeader(req, "x-marcel-request-id");
  if (!isUuidV4(requestId)) throw new DeviceBridgeProtocolError(400, "INVALID_IDENTIFIER", "Request identifier is invalid");
  const claimedHash = requiredHeader(req, "x-marcel-content-sha256");
  if (!isLowercaseSha256(claimedHash) || sha256Hex(req.body) !== claimedHash) throw new DeviceBridgeProtocolError(400, "BODY_HASH_MISMATCH", "Request body hash does not match");
  const normalizedCode = normalizeEnrollmentCode(body.enrollment_code);
  const publicKey = parseP256Spki(body.public_key.value);
  const fingerprint = publicKeyFingerprint(publicKey);
  const canonical = canonicalRequest({
    protocolVersion: 1,
    method: req.method,
    path: req.originalUrl,
    timestamp,
    requestId,
    contentSha256: claimedHash
  });
  const signature = requiredHeader(req, "x-marcel-signature");
  if (!verifyEcdsaSha256({ publicKey, canonicalBytes: Buffer.from(canonical, "utf8"), signatureBase64Url: signature })) {
    throw new DeviceBridgeProtocolError(401, "ENROLLMENT_PROOF_INVALID", "Enrollment proof is invalid");
  }
  return { body, requestId, contentSha256: claimedHash, normalizedCode, codeDigest: enrollmentCodeDigest(normalizedCode), publicKey, fingerprint };
}

function enrollmentSuccess(row, status, now = new Date()) {
  return {
    status,
    body: {
      ok: true,
      protocol_version: 1,
      device_id: row.device_id,
      key_id: row.key_id,
      server_time: now.toISOString(),
      configuration: {
        heartbeat_interval_seconds: 30,
        offline_after_seconds: 90,
        signature_window_seconds: 300,
        configuration_revision: 1
      },
      device_directive: "CONTINUE"
    }
  };
}

function enrollmentCodeInvalid() {
  return new DeviceBridgeProtocolError(401, "ENROLLMENT_CODE_INVALID", "Enrollment code is invalid");
}

export async function enrollDeviceTransaction(pool, validated, now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const codeResult = await client.query(
      `SELECT * FROM device_bridge_enrollment_codes WHERE code_digest = $1 FOR UPDATE`,
      [validated.codeDigest]
    );
    const code = codeResult.rows[0];
    if (!code) throw enrollmentCodeInvalid();
    const nonce = await client.query(
      `SELECT 1 FROM device_bridge_request_nonces WHERE auth_subject = $1 AND request_id = $2`,
      [`enrollment:${validated.codeDigest}`, validated.requestId]
    );
    if (nonce.rowCount) throw new DeviceBridgeProtocolError(409, "REQUEST_REPLAYED", "Request identifier was already accepted");

    if (code.consumed_at) {
      const identical = code.enrollment_attempt_id === validated.body.enrollment_attempt_id &&
        code.consumed_installation_id === validated.body.installation_id &&
        code.consumed_public_key_fingerprint === validated.fingerprint;
      if (!identical) throw enrollmentCodeInvalid();
      await insertEnrollmentNonce(client, validated, now);
      await client.query("COMMIT");
      return enrollmentSuccess({ device_id: code.consumed_device_id, key_id: code.consumed_key_id }, 200, now);
    }
    if (new Date(code.expires_at).valueOf() <= now.valueOf()) throw enrollmentCodeInvalid();

    const conflicts = await client.query(
      `SELECT 1 FROM device_bridge_devices d
       LEFT JOIN device_bridge_keys k ON k.device_id = d.device_id
       WHERE d.installation_id = $1 OR k.public_key_fingerprint = $2 LIMIT 1`,
      [validated.body.installation_id, validated.fingerprint]
    );
    if (conflicts.rowCount) throw enrollmentCodeInvalid();

    const deviceId = crypto.randomUUID();
    const keyId = crypto.randomUUID();
    const payload = validated.body;
    await client.query(
      `INSERT INTO device_bridge_devices
        (device_id, installation_id, display_name, app_version_name, app_version_code,
         manufacturer, model, android_api, abis, capabilities, configuration_revision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,1)`,
      [deviceId, payload.installation_id, payload.display_name, payload.app.version_name,
        payload.app.version_code, payload.device.manufacturer, payload.device.model,
        payload.device.android_api, JSON.stringify(payload.device.abis), JSON.stringify(payload.capabilities)]
    );
    await client.query(
      `INSERT INTO device_bridge_keys
        (key_id, device_id, algorithm, public_key_spki_der, public_key_fingerprint)
       VALUES ($1,$2,'EC_P256_SHA256',$3,$4)`,
      [keyId, deviceId, validated.publicKey.export({ format: "der", type: "spki" }), validated.fingerprint]
    );
    await client.query(
      `UPDATE device_bridge_enrollment_codes SET
        consumed_at=$2, enrollment_attempt_id=$3, consumed_installation_id=$4,
        consumed_public_key_fingerprint=$5, consumed_device_id=$6, consumed_key_id=$7
       WHERE enrollment_code_id=$1`,
      [code.enrollment_code_id, now, payload.enrollment_attempt_id, payload.installation_id, validated.fingerprint, deviceId, keyId]
    );
    await insertEnrollmentNonce(client, validated, now);
    await client.query(
      `INSERT INTO device_bridge_audit_events
        (event_type, request_id, device_id, key_id, result_code, http_status)
       VALUES ('DEVICE_ENROLLED',$1,$2,$3,'SUCCEEDED',201)`,
      [validated.requestId, deviceId, keyId]
    );
    await client.query("COMMIT");
    return enrollmentSuccess({ device_id: deviceId, key_id: keyId }, 201, now);
  } catch (error) {
    await client.query("ROLLBACK");
    if (error?.code === "23505") throw enrollmentCodeInvalid();
    throw error;
  } finally {
    client.release();
  }
}

async function insertEnrollmentNonce(client, validated, now) {
  try {
    await client.query(
      `INSERT INTO device_bridge_request_nonces
        (auth_subject, request_id, content_sha256, accepted_at, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [`enrollment:${validated.codeDigest}`, validated.requestId, validated.contentSha256, now, new Date(now.valueOf() + 10 * 60 * 1000)]
    );
  } catch (error) {
    if (error?.code === "23505") throw new DeviceBridgeProtocolError(409, "REQUEST_REPLAYED", "Request identifier was already accepted");
    throw error;
  }
}

export function createDeviceEnrollmentHandler(pool) {
  return async function deviceEnrollmentHandler(req, res) {
    try {
      consumeEnrollmentRateLimit(req);
      const validated = parseAndValidateEnrollmentRequest(req);
      const result = await enrollDeviceTransaction(pool, validated);
      return res.status(result.status).json(result.body);
    } catch (error) {
      const status = error instanceof DeviceBridgeProtocolError ? error.status : 500;
      if (!(error instanceof DeviceBridgeProtocolError)) console.error("Device Bridge enrollment transaction failed.");
      return res.status(status).json(protocolErrorBody(error, req.get("x-marcel-request-id")));
    }
  };
}
