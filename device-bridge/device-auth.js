import {
  DeviceBridgeProtocolError,
  assertTimestampWithinWindow,
  canonicalRequest,
  isLowercaseSha256,
  isUuidV4,
  parseP256Spki,
  sha256Hex,
  verifyEcdsaSha256
} from "./protocol-v1.js";

/* ==================================================
DEVICE BRIDGE T0 — PROTOCOL V1 DEVICE AUTH BASIS
================================================== */

function header(req, name) {
  const value = req.get(name);
  if (typeof value !== "string" || value.length === 0) {
    throw new DeviceBridgeProtocolError(400, "MISSING_HEADER", `Required header ${name} is missing`);
  }
  return value;
}

export async function verifyAuthenticatedDeviceRequest({ req, pool, urlDeviceId, now = new Date() }) {
  const protocolVersion = header(req, "x-marcel-protocol-version");
  if (protocolVersion !== "1") throw new DeviceBridgeProtocolError(426, "UNSUPPORTED_PROTOCOL_VERSION", "Unsupported device bridge protocol version");
  const deviceId = header(req, "x-marcel-device-id");
  const keyId = header(req, "x-marcel-key-id");
  if (!isUuidV4(deviceId) || !isUuidV4(keyId) || !isUuidV4(urlDeviceId)) {
    throw new DeviceBridgeProtocolError(400, "INVALID_IDENTIFIER", "Device or key identifier is invalid");
  }
  if (deviceId !== urlDeviceId) throw new DeviceBridgeProtocolError(409, "DEVICE_ID_MISMATCH", "Device identifier does not match request path");
  const timestamp = header(req, "x-marcel-timestamp");
  assertTimestampWithinWindow(timestamp, now);
  const requestId = header(req, "x-marcel-request-id");
  if (!isUuidV4(requestId)) throw new DeviceBridgeProtocolError(400, "INVALID_IDENTIFIER", "Request identifier is invalid");
  const contentSha256 = header(req, "x-marcel-content-sha256");
  if (!isLowercaseSha256(contentSha256) || sha256Hex(req.body) !== contentSha256) {
    throw new DeviceBridgeProtocolError(400, "BODY_HASH_MISMATCH", "Request body hash does not match");
  }

  const result = await pool.query(
    `SELECT d.device_id, d.enrollment_state, d.revoked_at AS device_revoked_at,
            k.key_id, k.public_key_spki_der, k.revoked_at AS key_revoked_at
     FROM device_bridge_devices d
     LEFT JOIN device_bridge_keys k ON k.device_id = d.device_id AND k.key_id = $2
     WHERE d.device_id = $1`,
    [deviceId, keyId]
  );
  const row = result.rows[0];
  if (!row) throw new DeviceBridgeProtocolError(404, "DEVICE_NOT_FOUND", "Device authentication failed");
  if (!row.key_id) throw new DeviceBridgeProtocolError(404, "KEY_NOT_FOUND", "Device authentication failed");
  if (row.enrollment_state === "REVOKED" || row.device_revoked_at) throw new DeviceBridgeProtocolError(403, "DEVICE_REVOKED", "Device authentication failed");
  if (row.enrollment_state !== "ACTIVE") throw new DeviceBridgeProtocolError(410, "RE_ENROLL_REQUIRED", "Device must enroll again");
  if (row.key_revoked_at) throw new DeviceBridgeProtocolError(403, "KEY_REVOKED", "Device authentication failed");

  const publicKey = parseP256Spki(Buffer.from(row.public_key_spki_der).toString("base64"));
  const canonical = canonicalRequest({
    protocolVersion: 1,
    method: req.method,
    path: req.originalUrl,
    timestamp,
    requestId,
    contentSha256
  });
  const signature = header(req, "x-marcel-signature");
  if (!verifyEcdsaSha256({ publicKey, canonicalBytes: Buffer.from(canonical, "utf8"), signatureBase64Url: signature })) {
    throw new DeviceBridgeProtocolError(401, "SIGNATURE_INVALID", "Request authentication failed");
  }
  return { deviceId, keyId, requestId, contentSha256, timestamp };
}

export async function registerAuthenticatedRequestReplay(client, authContext, now = new Date()) {
  try {
    await client.query(
      `INSERT INTO device_bridge_request_nonces
        (auth_subject, request_id, content_sha256, accepted_at, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [authContext.keyId, authContext.requestId, authContext.contentSha256, now, new Date(now.valueOf() + 10 * 60 * 1000)]
    );
  } catch (error) {
    if (error?.code === "23505") throw new DeviceBridgeProtocolError(409, "REQUEST_REPLAYED", "Request identifier was already accepted");
    throw error;
  }
}
