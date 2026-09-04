import {
  BRIDGE_SERVICE_STATES,
  DEVICE_BRIDGE_COMMANDS,
  DeviceBridgeProtocolError,
  T1_TINDER_MANUAL_GATE_COMMANDS,
  isKnownTinderStateForCapabilities,
  isTinderManualGateCapable,
  isExactUtcTimestamp,
  isUuidV4,
  protocolErrorBody,
  sha256Hex
} from "./protocol-v1.js";
import {
  registerAuthenticatedRequestReplay,
  verifyAuthenticatedDeviceRequest
} from "./device-auth.js";

/* ==================================================
DEVICE BRIDGE T0 — PROTOCOL V1 COMMAND ACK
================================================== */

const ACK_STATUSES = new Set(["RECEIVED", "SUCCEEDED", "FAILED", "REJECTED", "EXPIRED"]);
const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "REJECTED", "EXPIRED"]);
const SUPPORTED_COMMANDS = new Set(DEVICE_BRIDGE_COMMANDS);
const TINDER_MANUAL_GATE_COMMANDS = new Set(T1_TINDER_MANUAL_GATE_COMMANDS);
const BRIDGE_STATES = new Set(BRIDGE_SERVICE_STATES);
const MAX_RESULT_BYTES = 1024;
const MAX_ERROR_BYTES = 1024;
const T0_ERROR_MESSAGES = Object.freeze({
  COMMAND_EXECUTION_FAILED: "Execution failed",
  COMMAND_REJECTED: "Command was rejected",
  COMMAND_EXPIRED: "Command expired",
  PROTOCOL_ERROR: "Protocol error",
  DEVICE_STOP_FAILED: "Bridge stop failed",
  CONFIGURATION_REVISION_UNSUPPORTED: "Configuration revision unsupported"
});

function invalidAck(message = "Command acknowledgement is invalid") {
  return new DeviceBridgeProtocolError(400, "INVALID_BODY", message);
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function validateSucceededResult(commandType, result, capabilities = null) {
  if (result === null) {
    if (!TINDER_MANUAL_GATE_COMMANDS.has(commandType)) return;
    throw invalidAck("Ack result is required for this Tinder manual gate command");
  }
  if (jsonBytes(result) > MAX_RESULT_BYTES) throw invalidAck("Ack result exceeds the T0 limit");
  if (commandType === "PING" && exactKeys(result, ["pong"]) && result.pong === true) return;
  if (commandType === "STOP_BRIDGE" && exactKeys(result, ["stopped", "reason"]) && result.stopped === true && result.reason === "ADMIN_REQUEST") return;
  if (commandType === "REQUEST_STATUS" && exactKeys(result, ["device_status"]) &&
      exactKeys(result.device_status, ["bridge_service_state", "tinder_state", "automation_state"]) &&
      BRIDGE_STATES.has(result.device_status.bridge_service_state) &&
      isKnownTinderStateForCapabilities(result.device_status.tinder_state, capabilities) &&
      result.device_status.automation_state === "STOPPED") return;
  if (commandType === "CONNECT_TINDER" && exactKeys(result, ["tinder_state"]) && result.tinder_state === "CONNECTED") return;
  if (commandType === "DISCONNECT_TINDER" && exactKeys(result, ["tinder_state"]) && result.tinder_state === "DISCONNECTED") return;
  throw invalidAck("Ack result is not allowed for this T0 command");
}

function validateTechnicalError(error) {
  if (!exactKeys(error, ["code", "message"]) ||
      !Object.hasOwn(T0_ERROR_MESSAGES, error.code) ||
      error.message !== T0_ERROR_MESSAGES[error.code] ||
      jsonBytes(error) > MAX_ERROR_BYTES) {
    throw invalidAck("Ack error is invalid or exceeds the T0 limit");
  }
}

export function parseAndValidateCommandAck(req, commandType = null, capabilities = null) {
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw new DeviceBridgeProtocolError(400, "INVALID_JSON", "Command acknowledgement body is not valid JSON");
  }
  if (!exactKeys(body, ["protocol_version", "command_id", "sent_at", "status", "occurred_at", "result", "error"])) throw invalidAck();
  if (body.protocol_version !== 1) throw new DeviceBridgeProtocolError(400, "PROTOCOL_VERSION_MISMATCH", "Ack protocol version is invalid");
  if (!isUuidV4(body.command_id) || body.command_id !== req.params.commandId) throw new DeviceBridgeProtocolError(409, "COMMAND_DEVICE_MISMATCH", "Command identifier does not match request path");
  if (body.sent_at !== req.get("x-marcel-timestamp") || !isExactUtcTimestamp(body.sent_at)) throw invalidAck("Ack sent_at is invalid");
  if (!isExactUtcTimestamp(body.occurred_at)) throw invalidAck("Ack occurred_at is invalid");
  if (!ACK_STATUSES.has(body.status)) throw invalidAck("Ack status is invalid");
  if (body.status === "RECEIVED" || body.status === "EXPIRED") {
    if (body.result !== null || body.error !== null) throw invalidAck(`${body.status} requires null result and error`);
  } else if (body.status === "SUCCEEDED") {
    if (body.error !== null) throw invalidAck("SUCCEEDED requires null error");
    if (commandType) validateSucceededResult(commandType, body.result, capabilities);
    else if (body.result !== null && jsonBytes(body.result) > MAX_RESULT_BYTES) throw invalidAck("Ack result exceeds the T0 limit");
  } else if (body.status === "FAILED") {
    if (body.result !== null) throw invalidAck("FAILED requires null result");
    validateTechnicalError(body.error);
  } else if (body.status === "REJECTED") {
    if (body.result !== null) throw invalidAck("REJECTED requires null result");
    if (body.error !== null) validateTechnicalError(body.error);
  }
  return body;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

export function commandAckSemanticHash(ack) {
  return sha256Hex(Buffer.from(stableJson({
    status: ack.status,
    occurred_at: ack.occurred_at,
    result: ack.result,
    error: ack.error
  }), "utf8"));
}

function assertTransition(currentStatus, nextStatus) {
  const valid = currentStatus === null
    ? new Set(["RECEIVED", "REJECTED", "EXPIRED"]).has(nextStatus)
    : currentStatus === "RECEIVED" && new Set(["SUCCEEDED", "FAILED"]).has(nextStatus);
  if (!valid) throw new DeviceBridgeProtocolError(409, "INVALID_ACK_TRANSITION", "Command acknowledgement transition is invalid");
}

function ackResponse(commandId, status, now) {
  return { ok: true, protocol_version: 1, command_id: commandId, status, server_time: now.toISOString() };
}

export async function processCommandAckTransaction(pool, auth, ack, now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const identity = await client.query(
      `SELECT d.device_id, d.enrollment_state, d.revoked_at,
              d.configuration_revision, d.capabilities,
              k.key_id, k.revoked_at AS key_revoked_at
       FROM device_bridge_devices d
       JOIN device_bridge_keys k ON k.device_id=d.device_id AND k.key_id=$2
       WHERE d.device_id=$1 FOR UPDATE OF d, k`,
      [auth.deviceId, auth.keyId]
    );
    const device = identity.rows[0];
    if (!device || device.enrollment_state === "REVOKED" || device.revoked_at) throw new DeviceBridgeProtocolError(403, "DEVICE_REVOKED", "Device acknowledgement is not authorized");
    if (device.enrollment_state !== "ACTIVE") throw new DeviceBridgeProtocolError(410, "RE_ENROLL_REQUIRED", "Device must enroll again");
    if (device.key_revoked_at) throw new DeviceBridgeProtocolError(403, "KEY_REVOKED", "Device acknowledgement is not authorized");
    await registerAuthenticatedRequestReplay(client, auth, now);

    const commandResult = await client.query(
      `SELECT command_id, device_id, command_type, configuration_revision,
              issued_at, expires_at, terminal_status, terminal_at
       FROM device_bridge_commands WHERE command_id=$1 FOR UPDATE`,
      [ack.command_id]
    );
    const command = commandResult.rows[0];
    if (!command) throw new DeviceBridgeProtocolError(404, "COMMAND_NOT_FOUND", "Command was not found");
    if (command.device_id !== auth.deviceId) throw new DeviceBridgeProtocolError(409, "COMMAND_DEVICE_MISMATCH", "Command does not belong to this device");
    if (!SUPPORTED_COMMANDS.has(command.command_type)) throw new DeviceBridgeProtocolError(400, "COMMAND_TYPE_UNSUPPORTED", "Command type is not supported");
    if (TINDER_MANUAL_GATE_COMMANDS.has(command.command_type) && !isTinderManualGateCapable(device.capabilities)) {
      throw new DeviceBridgeProtocolError(409, "DEVICE_CAPABILITY_UNSUPPORTED", "Device does not support the Tinder manual gate");
    }
    if (Number(command.configuration_revision) !== Number(device.configuration_revision)) throw new DeviceBridgeProtocolError(409, "CONFIGURATION_REVISION_UNSUPPORTED", "Command configuration revision is unsupported");

    validateSucceededResultForCommand(ack, command.command_type, device.capabilities);
    const semanticHash = commandAckSemanticHash(ack);
    const history = await client.query(
      `SELECT status, occurred_at, result, error, body_sha256, accepted_at
       FROM device_bridge_command_acks WHERE command_id=$1 ORDER BY accepted_at ASC, ack_id ASC`,
      [ack.command_id]
    );
    const sameStatus = history.rows.find(row => row.status === ack.status);
    if (sameStatus) {
      if (sameStatus.body_sha256 !== semanticHash) throw new DeviceBridgeProtocolError(409, "INVALID_ACK_TRANSITION", "Existing acknowledgement has different content");
      await client.query("COMMIT");
      return ackResponse(ack.command_id, ack.status, now);
    }
    const currentStatus = command.terminal_status || (history.rows.some(row => row.status === "RECEIVED") ? "RECEIVED" : null);
    assertTransition(currentStatus, ack.status);
    const expired = new Date(command.expires_at).valueOf() <= now.valueOf();
    if (expired && currentStatus === null && ack.status !== "EXPIRED") throw new DeviceBridgeProtocolError(410, "COMMAND_EXPIRED", "Command has expired");
    if (!expired && currentStatus === null && ack.status === "EXPIRED") throw new DeviceBridgeProtocolError(409, "INVALID_ACK_TRANSITION", "Command has not expired");

    await client.query(
      `INSERT INTO device_bridge_command_acks
        (command_id, device_id, status, occurred_at, result, error, body_sha256, accepted_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [ack.command_id, auth.deviceId, ack.status, ack.occurred_at,
        ack.result === null ? null : JSON.stringify(ack.result),
        ack.error === null ? null : JSON.stringify(ack.error), semanticHash, now]
    );
    if (TERMINAL_STATUSES.has(ack.status)) {
      await client.query(
        `UPDATE device_bridge_commands SET terminal_status=$2, terminal_at=$3 WHERE command_id=$1`,
        [ack.command_id, ack.status, now]
      );
    }
    await client.query(
      `INSERT INTO device_bridge_audit_events
        (event_type, request_id, device_id, key_id, command_id, result_code, http_status, details)
       VALUES ($1,$2,$3,$4,$5,'SUCCEEDED',200,$6::jsonb)`,
      [TERMINAL_STATUSES.has(ack.status) ? "COMMAND_ACK_TERMINAL" : "COMMAND_ACK_RECEIVED",
        auth.requestId, auth.deviceId, auth.keyId, ack.command_id,
        JSON.stringify({ command_type: command.command_type, ack_status: ack.status })]
    );
    await client.query("COMMIT");
    return ackResponse(ack.command_id, ack.status, now);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function validateSucceededResultForCommand(ack, commandType, capabilities) {
  if (ack.status === "SUCCEEDED") validateSucceededResult(commandType, ack.result, capabilities);
}

export function createCommandAckHandler(pool) {
  return async function commandAckHandler(req, res) {
    try {
      const auth = await verifyAuthenticatedDeviceRequest({ req, pool, urlDeviceId: req.params.deviceId });
      const ack = parseAndValidateCommandAck(req);
      const response = await processCommandAckTransaction(pool, auth, ack);
      return res.status(200).json(response);
    } catch (error) {
      const status = error instanceof DeviceBridgeProtocolError ? error.status : 500;
      if (!(error instanceof DeviceBridgeProtocolError)) console.error("Device Bridge command acknowledgement failed.");
      return res.status(status).json(protocolErrorBody(error, req.get("x-marcel-request-id")));
    }
  };
}
