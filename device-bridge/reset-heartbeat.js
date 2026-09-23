import {
  BRIDGE_SERVICE_STATES,
  DEVICE_BRIDGE_PROTOCOL,
  DeviceBridgeProtocolError,
  isExactUtcTimestamp,
  isUuidV4,
  protocolErrorBody,
  T0_DEVICE_CAPABILITIES
} from "./protocol-v1.js";
import {
  registerAuthenticatedRequestReplay,
  verifyAuthenticatedDeviceRequest
} from "./device-auth.js";

/* ==================================================
DEVICE BRIDGE RESET HEARTBEAT

This is deliberately a generic liveness update.  It accepts an installed
pre-reset Bridge heartbeat so the enrolled device does not need to be
re-enrolled, but drops every Tinder-specific capability, state, and
diagnostic before persistence.  It never selects, acknowledges, or issues a
command.
================================================== */

const MAX_CAPABILITIES = 64;
const GENERIC_CAPABILITY = /^[A-Z0-9_:-]{1,128}$/;
const RETAINED_CAPABILITIES = new Set(T0_DEVICE_CAPABILITIES);
const LEGACY_TINDER_FIELD = /^tinder_[a-z0-9_]*$/;
const ROOT_FIELDS = new Set([
  "protocol_version",
  "sequence",
  "sent_at",
  "app",
  "device",
  "bridge",
  "capabilities",
  "tinder_state",
  "automation_state"
]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value, maximum) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum;
}

function nullableTimestamp(value) {
  return value === null || (typeof value === "string" && isExactUtcTimestamp(value));
}

function invalidHeartbeat(message) {
  return new DeviceBridgeProtocolError(400, "INVALID_BODY", message);
}

function normalizeGenericCapabilities(value) {
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES
      || value.some((capability) => typeof capability !== "string"
        || !GENERIC_CAPABILITY.test(capability))) {
    throw invalidHeartbeat("Heartbeat capabilities are invalid");
  }

  // Existing installations may still advertise retired extensions. Keep only
  // the fixed generic baseline; ignored values are neither persisted as
  // runtime state nor used as an authorization signal.
  return Object.freeze([...new Set(value.filter((capability) => RETAINED_CAPABILITIES.has(capability)))]);
}

function parseAndValidateResetHeartbeat(req) {
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw new DeviceBridgeProtocolError(400, "INVALID_JSON", "Heartbeat body is not valid JSON");
  }
  if (!plainObject(body)) throw invalidHeartbeat("Heartbeat body must be an object");
  if (Object.keys(body).some((key) => !ROOT_FIELDS.has(key) && !LEGACY_TINDER_FIELD.test(key))) {
    throw invalidHeartbeat("Heartbeat body contains unsupported fields");
  }
  if (body.protocol_version !== 1) {
    throw new DeviceBridgeProtocolError(400, "PROTOCOL_VERSION_MISMATCH", "Heartbeat protocol version is invalid");
  }
  if (!Number.isSafeInteger(body.sequence) || body.sequence < 1) {
    throw invalidHeartbeat("Heartbeat sequence is invalid");
  }
  if (body.sent_at !== req.get("x-marcel-timestamp") || !isExactUtcTimestamp(body.sent_at)) {
    throw invalidHeartbeat("Heartbeat sent_at is invalid");
  }
  if (!plainObject(body.app) || !boundedText(body.app.version_name, 64)
      || !Number.isSafeInteger(body.app.version_code) || body.app.version_code < 0) {
    throw invalidHeartbeat("Heartbeat app metadata is invalid");
  }
  if (!plainObject(body.device) || !isUuidV4(body.device.installation_id)
      || !boundedText(body.device.manufacturer, 64)
      || !boundedText(body.device.model, 128)
      || !Number.isInteger(body.device.android_api) || body.device.android_api < 24
      || !Array.isArray(body.device.abis) || body.device.abis.length < 1 || body.device.abis.length > 8
      || body.device.abis.some((abi) => !boundedText(abi, 64))) {
    throw invalidHeartbeat("Heartbeat device metadata is invalid");
  }
  if (!plainObject(body.bridge) || !BRIDGE_SERVICE_STATES.includes(body.bridge.service_state)
      || !nullableTimestamp(body.bridge.started_at)
      || !nullableTimestamp(body.bridge.last_successful_heartbeat_at)) {
    throw invalidHeartbeat("Heartbeat bridge metadata is invalid");
  }
  return Object.freeze({
    sequence: body.sequence,
    app: Object.freeze({ version_name: body.app.version_name.trim(), version_code: body.app.version_code }),
    device: Object.freeze({
      installation_id: body.device.installation_id,
      manufacturer: body.device.manufacturer.trim(),
      model: body.device.model.trim(),
      android_api: body.device.android_api,
      abis: Object.freeze(body.device.abis.map((abi) => abi.trim()))
    }),
    bridge: Object.freeze({ service_state: body.bridge.service_state }),
    capabilities: normalizeGenericCapabilities(body.capabilities)
  });
}

function heartbeatResponse(now, acceptedAt) {
  return {
    ok: true,
    protocol_version: 1,
    server_time: now.toISOString(),
    accepted_at: acceptedAt.toISOString(),
    configuration: {
      heartbeat_interval_seconds: DEVICE_BRIDGE_PROTOCOL.heartbeatIntervalSeconds,
      offline_after_seconds: DEVICE_BRIDGE_PROTOCOL.offlineAfterSeconds,
      signature_window_seconds: DEVICE_BRIDGE_PROTOCOL.signatureWindowSeconds,
      configuration_revision: 1
    },
    device_directive: "CONTINUE",
    commands: []
  };
}

async function processResetHeartbeatTransaction(pool, auth, heartbeat, now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT d.device_id, d.installation_id, d.enrollment_state, d.revoked_at,
              d.last_heartbeat_sequence, d.last_heartbeat_body_sha256,
              d.last_accepted_heartbeat_at, k.key_id, k.revoked_at AS key_revoked_at
         FROM device_bridge_devices d
         JOIN device_bridge_keys k ON k.device_id=d.device_id AND k.key_id=$2
        WHERE d.device_id=$1
        FOR UPDATE OF d, k`,
      [auth.deviceId, auth.keyId]
    );
    const device = locked.rows[0];
    if (!device || device.enrollment_state === "REVOKED" || device.revoked_at || device.key_revoked_at) {
      throw new DeviceBridgeProtocolError(403, "DEVICE_REVOKED", "Device heartbeat is not authorized");
    }
    if (device.enrollment_state !== "ACTIVE") {
      throw new DeviceBridgeProtocolError(410, "RE_ENROLL_REQUIRED", "Device must enroll again");
    }
    if (device.installation_id !== heartbeat.device.installation_id) {
      throw new DeviceBridgeProtocolError(409, "DEVICE_ID_MISMATCH", "Installation identifier does not match device");
    }

    await registerAuthenticatedRequestReplay(client, auth, now);
    const previousSequence = device.last_heartbeat_sequence === null
      ? null
      : Number(device.last_heartbeat_sequence);
    const idempotent = previousSequence !== null
      && heartbeat.sequence === previousSequence
      && device.last_heartbeat_body_sha256 === auth.contentSha256;
    if (previousSequence !== null && (heartbeat.sequence < previousSequence
        || (heartbeat.sequence === previousSequence && !idempotent))) {
      throw new DeviceBridgeProtocolError(
        409,
        "HEARTBEAT_SEQUENCE_CONFLICT",
        "Heartbeat sequence conflicts with the last accepted heartbeat"
      );
    }

    let acceptedAt = now;
    if (!idempotent) {
      await client.query(
        `UPDATE device_bridge_devices SET
           app_version_name=$2, app_version_code=$3, manufacturer=$4, model=$5,
           android_api=$6, abis=$7::jsonb, capabilities=$8::jsonb,
           bridge_service_state=$9,
           last_heartbeat_sequence=$10, last_heartbeat_body_sha256=$11,
           last_accepted_heartbeat_at=$12, updated_at=$12
         WHERE device_id=$1`,
        [auth.deviceId, heartbeat.app.version_name, heartbeat.app.version_code,
          heartbeat.device.manufacturer, heartbeat.device.model, heartbeat.device.android_api,
          JSON.stringify(heartbeat.device.abis), JSON.stringify(heartbeat.capabilities),
          heartbeat.bridge.service_state, heartbeat.sequence, auth.contentSha256, now]
      );
      await client.query(
        `INSERT INTO device_bridge_audit_events
           (event_type, request_id, device_id, key_id, result_code, http_status, details)
         VALUES ('HEARTBEAT_ACCEPTED',$1,$2,$3,'SUCCEEDED',200,$4::jsonb)`,
        [auth.requestId, auth.deviceId, auth.keyId,
          JSON.stringify({ bridge_service_state: heartbeat.bridge.service_state })]
      );
    } else {
      acceptedAt = new Date(device.last_accepted_heartbeat_at);
    }
    await client.query("COMMIT");
    return heartbeatResponse(now, acceptedAt);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function createResetHeartbeatHandler(pool) {
  return async function resetHeartbeatHandler(req, res) {
    try {
      const auth = await verifyAuthenticatedDeviceRequest({ req, pool, urlDeviceId: req.params.deviceId });
      const heartbeat = parseAndValidateResetHeartbeat(req);
      return res.status(200).json(await processResetHeartbeatTransaction(pool, auth, heartbeat));
    } catch (error) {
      const status = error instanceof DeviceBridgeProtocolError ? error.status : 500;
      if (!(error instanceof DeviceBridgeProtocolError)) console.error("Device Bridge reset heartbeat failed.");
      return res.status(status).json(protocolErrorBody(error, req.get("x-marcel-request-id")));
    }
  };
}

export {
  createResetHeartbeatHandler,
  parseAndValidateResetHeartbeat,
  processResetHeartbeatTransaction
};
