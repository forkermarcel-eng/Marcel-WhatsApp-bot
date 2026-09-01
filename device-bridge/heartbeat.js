import {
  DEVICE_BRIDGE_PROTOCOL,
  DeviceBridgeProtocolError,
  isExactUtcTimestamp,
  isUuidV4,
  protocolErrorBody
} from "./protocol-v1.js";
import {
  registerAuthenticatedRequestReplay,
  verifyAuthenticatedDeviceRequest
} from "./device-auth.js";

/* ==================================================
DEVICE BRIDGE T0 — PROTOCOL V1 HEARTBEAT
================================================== */

const REQUIRED_CAPABILITIES = Object.freeze([
  "COMMAND_ACK_V1",
  "COMMAND_PING_V1",
  "COMMAND_REQUEST_STATUS_V1",
  "COMMAND_STOP_BRIDGE_V1",
  "DEVICE_HEARTBEAT_V1"
]);
const BRIDGE_STATES = new Set(["STOPPED", "STARTING", "RUNNING", "STOPPING", "ERROR"]);

function invalidHeartbeat(message) {
  return new DeviceBridgeProtocolError(400, "INVALID_DEVICE_STATE", message);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value, maximum) {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function nullableTimestamp(value) {
  return value === null || isExactUtcTimestamp(value);
}

export function parseAndValidateHeartbeat(req) {
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw new DeviceBridgeProtocolError(400, "INVALID_JSON", "Heartbeat body is not valid JSON");
  }
  if (!object(body)) throw invalidHeartbeat("Heartbeat body must be an object");
  if (body.protocol_version !== 1) throw new DeviceBridgeProtocolError(400, "PROTOCOL_VERSION_MISMATCH", "Heartbeat protocol version is invalid");
  if (!Number.isSafeInteger(body.sequence) || body.sequence < 1) throw invalidHeartbeat("Heartbeat sequence is invalid");
  if (body.sent_at !== req.get("x-marcel-timestamp") || !isExactUtcTimestamp(body.sent_at)) throw invalidHeartbeat("Heartbeat sent_at is invalid");
  if (!object(body.app) || !nonEmptyString(body.app.version_name, 64) || !Number.isSafeInteger(body.app.version_code) || body.app.version_code < 0) throw invalidHeartbeat("Heartbeat app metadata is invalid");
  if (!object(body.device) || !isUuidV4(body.device.installation_id) || !nonEmptyString(body.device.manufacturer, 64) || !nonEmptyString(body.device.model, 128) || !Number.isInteger(body.device.android_api) || body.device.android_api < 24 || !Array.isArray(body.device.abis) || body.device.abis.length < 1 || body.device.abis.length > 8 || body.device.abis.some(abi => !nonEmptyString(abi, 64))) throw invalidHeartbeat("Heartbeat device metadata is invalid");
  if (!object(body.bridge) || !BRIDGE_STATES.has(body.bridge.service_state) || !nullableTimestamp(body.bridge.started_at) || !nullableTimestamp(body.bridge.last_successful_heartbeat_at)) throw invalidHeartbeat("Heartbeat bridge metadata is invalid");
  if (!Array.isArray(body.capabilities) || body.capabilities.length !== REQUIRED_CAPABILITIES.length || body.capabilities.some((item, index) => item !== REQUIRED_CAPABILITIES[index])) throw invalidHeartbeat("Heartbeat capabilities are invalid");
  if (body.tinder_state !== "UNKNOWN") throw invalidHeartbeat("T0 tinder_state must be UNKNOWN");
  if (body.automation_state !== "STOPPED") throw invalidHeartbeat("T0 automation_state must be STOPPED");
  return body;
}

export function deriveDeviceStatus(lastAcceptedHeartbeatAt, now = new Date()) {
  if (!lastAcceptedHeartbeatAt) return "OFFLINE";
  const age = now.valueOf() - new Date(lastAcceptedHeartbeatAt).valueOf();
  return age >= 0 && age <= DEVICE_BRIDGE_PROTOCOL.offlineAfterSeconds * 1000 ? "ONLINE" : "OFFLINE";
}

function commandEnvelope(row) {
  return {
    command_id: row.command_id,
    protocol_version: row.protocol_version,
    type: row.command_type,
    issued_at: new Date(row.issued_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    configuration_revision: row.configuration_revision,
    payload: row.payload
  };
}

async function selectDeliverableCommands(client, deviceId, now) {
  const result = await client.query(
    `SELECT command_id, protocol_version, command_type, issued_at, expires_at,
            configuration_revision, payload
     FROM device_bridge_commands
     WHERE device_id=$1 AND terminal_status IS NULL AND expires_at>$2
       AND command_type IN ('PING','REQUEST_STATUS','STOP_BRIDGE')
       AND (
         (command_type IN ('PING','REQUEST_STATUS') AND payload='{}'::jsonb)
         OR (command_type='STOP_BRIDGE' AND payload='{"reason":"ADMIN_REQUEST"}'::jsonb)
       )
     ORDER BY issued_at ASC, command_id ASC
     LIMIT $3`,
    [deviceId, now, DEVICE_BRIDGE_PROTOCOL.commandBatchLimit]
  );
  return result.rows.map(commandEnvelope);
}

function heartbeatResponse(serverTime, acceptedAt, commands) {
  return {
    ok: true,
    protocol_version: 1,
    server_time: serverTime.toISOString(),
    accepted_at: acceptedAt.toISOString(),
    configuration: {
      heartbeat_interval_seconds: 30,
      offline_after_seconds: 90,
      signature_window_seconds: 300,
      configuration_revision: 1
    },
    device_directive: "CONTINUE",
    commands
  };
}

export async function processHeartbeatTransaction(pool, auth, heartbeat, now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT d.device_id, d.installation_id, d.enrollment_state, d.revoked_at,
              d.last_heartbeat_sequence, d.last_heartbeat_body_sha256, d.last_accepted_heartbeat_at,
              k.key_id, k.revoked_at AS key_revoked_at
       FROM device_bridge_devices d
       JOIN device_bridge_keys k ON k.device_id=d.device_id AND k.key_id=$2
       WHERE d.device_id=$1 FOR UPDATE OF d, k`,
      [auth.deviceId, auth.keyId]
    );
    const device = locked.rows[0];
    if (!device || device.enrollment_state === "REVOKED" || device.revoked_at) {
      throw new DeviceBridgeProtocolError(403, "DEVICE_REVOKED", "Device heartbeat is not authorized");
    }
    if (device.enrollment_state !== "ACTIVE") throw new DeviceBridgeProtocolError(410, "RE_ENROLL_REQUIRED", "Device must enroll again");
    if (device.key_revoked_at) throw new DeviceBridgeProtocolError(403, "KEY_REVOKED", "Device heartbeat is not authorized");
    if (device.installation_id !== heartbeat.device.installation_id) {
      throw new DeviceBridgeProtocolError(409, "DEVICE_ID_MISMATCH", "Installation identifier does not match device");
    }
    await registerAuthenticatedRequestReplay(client, auth, now);

    const previousSequence = device.last_heartbeat_sequence === null ? null : Number(device.last_heartbeat_sequence);
    const idempotent = previousSequence !== null && heartbeat.sequence === previousSequence && device.last_heartbeat_body_sha256 === auth.contentSha256;
    if (previousSequence !== null && (heartbeat.sequence < previousSequence || (heartbeat.sequence === previousSequence && !idempotent))) {
      throw new DeviceBridgeProtocolError(409, "HEARTBEAT_SEQUENCE_CONFLICT", "Heartbeat sequence conflicts with the last accepted heartbeat");
    }

    let acceptedAt = now;
    if (!idempotent) {
      await client.query(
        `UPDATE device_bridge_devices SET
          app_version_name=$2, app_version_code=$3, manufacturer=$4, model=$5,
          android_api=$6, abis=$7::jsonb, capabilities=$8::jsonb,
          bridge_service_state=$9, tinder_state='UNKNOWN', automation_state='STOPPED',
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
        [auth.requestId, auth.deviceId, auth.keyId, JSON.stringify({ sequence: heartbeat.sequence })]
      );
    } else {
      acceptedAt = new Date(device.last_accepted_heartbeat_at);
    }
    const commands = await selectDeliverableCommands(client, auth.deviceId, now);
    await client.query("COMMIT");
    return heartbeatResponse(now, acceptedAt, commands);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function createHeartbeatHandler(pool) {
  return async function heartbeatHandler(req, res) {
    try {
      const auth = await verifyAuthenticatedDeviceRequest({ req, pool, urlDeviceId: req.params.deviceId });
      const heartbeat = parseAndValidateHeartbeat(req);
      const response = await processHeartbeatTransaction(pool, auth, heartbeat);
      return res.status(200).json(response);
    } catch (error) {
      const status = error instanceof DeviceBridgeProtocolError ? error.status : 500;
      if (!(error instanceof DeviceBridgeProtocolError)) console.error("Device Bridge heartbeat transaction failed.");
      return res.status(status).json(protocolErrorBody(error, req.get("x-marcel-request-id")));
    }
  };
}
