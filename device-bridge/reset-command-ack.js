import {
  DeviceBridgeProtocolError,
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
DEVICE BRIDGE RESET COMMAND ACK

Only retained device-baseline commands can be acknowledged.
================================================== */

const RETAINED_COMMANDS = new Set([
  "PING",
  "REQUEST_STATUS",
  "STOP_BRIDGE"
]);
const ACK_STATUSES = new Set(["RECEIVED", "SUCCEEDED", "FAILED", "REJECTED", "EXPIRED"]);
const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "REJECTED", "EXPIRED"]);
const BRIDGE_STATES = new Set(["STOPPED", "STARTING", "RUNNING", "STOPPING", "ERROR"]);
const AUTOMATION_STATES = new Set(["STOPPED", "RUNNING"]);
const MAX_RESULT_BYTES = 1024;
const MAX_ERROR_BYTES = 1024;
const GENERIC_ERROR_CODES = new Set([
  "COMMAND_EXECUTION_FAILED",
  "COMMAND_REJECTED",
  "COMMAND_EXPIRED",
  "PROTOCOL_ERROR",
  "DEVICE_STOP_FAILED",
  "CONFIGURATION_REVISION_UNSUPPORTED"
]);

function exactKeys(value, keys) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function invalidAck(message = "Command acknowledgement is invalid") {
  return new DeviceBridgeProtocolError(400, "INVALID_BODY", message);
}

function parseAndValidateResetCommandAck(req) {
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw new DeviceBridgeProtocolError(400, "INVALID_JSON", "Command acknowledgement body is not valid JSON");
  }
  if (!exactKeys(body, ["protocol_version", "command_id", "sent_at", "status", "occurred_at", "result", "error"])) {
    throw invalidAck();
  }
  if (body.protocol_version !== 1) {
    throw new DeviceBridgeProtocolError(400, "PROTOCOL_VERSION_MISMATCH", "Ack protocol version is invalid");
  }
  if (!isUuidV4(body.command_id) || body.command_id !== req.params.commandId) {
    throw new DeviceBridgeProtocolError(409, "COMMAND_DEVICE_MISMATCH", "Command identifier does not match request path");
  }
  if (body.sent_at !== req.get("x-marcel-timestamp") || !isExactUtcTimestamp(body.sent_at)
      || !isExactUtcTimestamp(body.occurred_at) || !ACK_STATUSES.has(body.status)) {
    throw invalidAck("Ack metadata is invalid");
  }
  if (body.result !== null && jsonBytes(body.result) > MAX_RESULT_BYTES) {
    throw invalidAck("Ack result exceeds the baseline limit");
  }
  if (body.error !== null && jsonBytes(body.error) > MAX_ERROR_BYTES) {
    throw invalidAck("Ack error exceeds the baseline limit");
  }
  return body;
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function semanticHash(ack) {
  return sha256Hex(Buffer.from(stableJson({
    status: ack.status,
    occurred_at: ack.occurred_at,
    result: ack.result,
    error: ack.error
  }), "utf8"));
}

function validateError(error) {
  if (!exactKeys(error, ["code", "message"])
      || !GENERIC_ERROR_CODES.has(error.code)
      || typeof error.message !== "string" || !error.message.trim()
      || jsonBytes(error) > MAX_ERROR_BYTES) {
    throw invalidAck("Ack error is not an allowed baseline error");
  }
}

function validateRetainedAck(ack, commandType) {
  if (ack.status === "RECEIVED" || ack.status === "EXPIRED") {
    if (ack.result !== null || ack.error !== null) throw invalidAck(`${ack.status} requires null result and error`);
    return;
  }
  if (ack.status === "FAILED" || ack.status === "REJECTED") {
    if (ack.result !== null) throw invalidAck(`${ack.status} requires null result`);
    if (ack.error !== null) validateError(ack.error);
    return;
  }
  if (ack.status !== "SUCCEEDED" || ack.error !== null) {
    throw invalidAck("Ack status is invalid for a retained command");
  }
  if (commandType === "PING" && exactKeys(ack.result, ["pong"]) && ack.result.pong === true) return;
  if (commandType === "STOP_BRIDGE"
      && exactKeys(ack.result, ["stopped", "reason"])
      && ack.result.stopped === true && ack.result.reason === "ADMIN_REQUEST") return;
  if (commandType === "REQUEST_STATUS"
      && exactKeys(ack.result, ["bridge_service_state", "automation_state"])
      && BRIDGE_STATES.has(ack.result.bridge_service_state)
      && AUTOMATION_STATES.has(ack.result.automation_state)) return;
  throw invalidAck("Ack result is invalid for a retained command");
}

function assertTransition(currentStatus, nextStatus) {
  const valid = currentStatus === null
    ? new Set(["RECEIVED", "REJECTED", "EXPIRED"]).has(nextStatus)
    : currentStatus === "RECEIVED" && new Set(["SUCCEEDED", "FAILED"]).has(nextStatus);
  if (!valid) {
    throw new DeviceBridgeProtocolError(409, "INVALID_ACK_TRANSITION", "Command acknowledgement transition is invalid");
  }
}

function ackResponse(commandId, status, now) {
  return { ok: true, protocol_version: 1, command_id: commandId, status, server_time: now.toISOString() };
}

async function processResetCommandAckTransaction(pool, auth, ack, now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const identity = await client.query(
      `SELECT d.device_id, d.enrollment_state, d.revoked_at, d.configuration_revision,
              k.key_id, k.revoked_at AS key_revoked_at
         FROM device_bridge_devices d
         JOIN device_bridge_keys k ON k.device_id=d.device_id AND k.key_id=$2
        WHERE d.device_id=$1
        FOR UPDATE OF d, k`,
      [auth.deviceId, auth.keyId]
    );
    const device = identity.rows[0];
    if (!device || device.enrollment_state === "REVOKED" || device.revoked_at || device.key_revoked_at) {
      throw new DeviceBridgeProtocolError(403, "DEVICE_REVOKED", "Device acknowledgement is not authorized");
    }
    if (device.enrollment_state !== "ACTIVE") {
      throw new DeviceBridgeProtocolError(410, "RE_ENROLL_REQUIRED", "Device must enroll again");
    }
    const commandResult = await client.query(
      `SELECT command_id, device_id, command_type, payload, configuration_revision,
              expires_at, terminal_status
         FROM device_bridge_commands
        WHERE command_id=$1
        FOR UPDATE`,
      [ack.command_id]
    );
    const command = commandResult.rows[0];
    if (!command) throw new DeviceBridgeProtocolError(404, "COMMAND_NOT_FOUND", "Command was not found");
    if (command.device_id !== auth.deviceId) {
      throw new DeviceBridgeProtocolError(409, "COMMAND_DEVICE_MISMATCH", "Command does not belong to this device");
    }
    if (!RETAINED_COMMANDS.has(command.command_type)) {
      throw new DeviceBridgeProtocolError(400, "COMMAND_TYPE_UNSUPPORTED", "Command type is not supported");
    }
    if (Number(command.configuration_revision) !== Number(device.configuration_revision)) {
      throw new DeviceBridgeProtocolError(409, "CONFIGURATION_REVISION_UNSUPPORTED", "Command configuration revision is unsupported");
    }
    validateRetainedAck(ack, command.command_type);
    await registerAuthenticatedRequestReplay(client, auth, now);

    const bodySha256 = semanticHash(ack);
    const history = await client.query(
      `SELECT status, body_sha256
         FROM device_bridge_command_acks
        WHERE command_id=$1
        ORDER BY accepted_at ASC, ack_id ASC`,
      [ack.command_id]
    );
    const sameStatus = history.rows.find((row) => row.status === ack.status);
    if (sameStatus) {
      if (sameStatus.body_sha256 !== bodySha256) {
        throw new DeviceBridgeProtocolError(409, "INVALID_ACK_TRANSITION", "Existing acknowledgement has different content");
      }
      await client.query("COMMIT");
      return ackResponse(ack.command_id, ack.status, now);
    }
    const currentStatus = command.terminal_status || (history.rows.some((row) => row.status === "RECEIVED") ? "RECEIVED" : null);
    assertTransition(currentStatus, ack.status);
    const expired = new Date(command.expires_at).valueOf() <= now.valueOf();
    if (expired && currentStatus === null && ack.status !== "EXPIRED") {
      throw new DeviceBridgeProtocolError(410, "COMMAND_EXPIRED", "Command has expired");
    }
    if (!expired && currentStatus === null && ack.status === "EXPIRED") {
      throw new DeviceBridgeProtocolError(409, "INVALID_ACK_TRANSITION", "Command has not expired");
    }
    await client.query(
      `INSERT INTO device_bridge_command_acks
         (command_id, device_id, status, occurred_at, result, error, body_sha256, accepted_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [ack.command_id, auth.deviceId, ack.status, ack.occurred_at,
        ack.result === null ? null : JSON.stringify(ack.result),
        ack.error === null ? null : JSON.stringify(ack.error), bodySha256, now]
    );
    if (TERMINAL_STATUSES.has(ack.status)) {
      await client.query(
        `UPDATE device_bridge_commands
            SET terminal_status=$2, terminal_at=$3
          WHERE command_id=$1`,
        [ack.command_id, ack.status, now]
      );
    }
    if (command.command_type === "STOP_BRIDGE" && ack.status === "SUCCEEDED") {
      await client.query(
        `UPDATE device_bridge_devices
            SET bridge_service_state='STOPPED', automation_state='STOPPED', updated_at=$2
          WHERE device_id=$1`,
        [auth.deviceId, now]
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

function createResetCommandAckHandler(pool) {
  return async function resetCommandAckHandler(req, res) {
    try {
      const auth = await verifyAuthenticatedDeviceRequest({ req, pool, urlDeviceId: req.params.deviceId });
      const ack = parseAndValidateResetCommandAck(req);
      return res.status(200).json(await processResetCommandAckTransaction(pool, auth, ack));
    } catch (error) {
      const status = error instanceof DeviceBridgeProtocolError ? error.status : 500;
      if (!(error instanceof DeviceBridgeProtocolError)) console.error("Device Bridge reset command acknowledgement failed.");
      return res.status(status).json(protocolErrorBody(error, req.get("x-marcel-request-id")));
    }
  };
}

export {
  RETAINED_COMMANDS,
  createResetCommandAckHandler,
  parseAndValidateResetCommandAck,
  processResetCommandAckTransaction
};
