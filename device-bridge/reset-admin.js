import crypto from "crypto";
import {
  DEVICE_BRIDGE_PROTOCOL,
  DeviceBridgeProtocolError,
  isUuidV4,
  protocolErrorBody
} from "./protocol-v1.js";
import { RETAINED_COMMANDS } from "./reset-command-ack.js";

/* ==================================================
DEVICE BRIDGE RESET ADMIN SURFACE

This is a small generic device surface.  It deliberately exposes no Tinder
capture, mapping, permit, receipt, diagnostic, or draft/send control.
================================================== */

const COMMAND_EXPIRY_MS = Object.freeze({
  PING: 60 * 1000,
  REQUEST_STATUS: 60 * 1000,
  STOP_BRIDGE: 5 * 60 * 1000
});

function deriveDeviceStatus(lastAcceptedHeartbeatAt, now = new Date()) {
  if (!lastAcceptedHeartbeatAt) return "OFFLINE";
  const age = now.valueOf() - new Date(lastAcceptedHeartbeatAt).valueOf();
  return age >= 0 && age <= DEVICE_BRIDGE_PROTOCOL.offlineAfterSeconds * 1000 ? "ONLINE" : "OFFLINE";
}

function timestampOrNull(value) {
  return value ? new Date(value).toISOString() : null;
}

function deviceProjection(row, now = new Date()) {
  return {
    device_id: row.device_id,
    display_name: row.display_name,
    enrollment_state: row.enrollment_state,
    device_status: deriveDeviceStatus(row.last_accepted_heartbeat_at, now),
    bridge_service_state: row.bridge_service_state,
    app_version_name: row.app_version_name || null,
    app_version_code: row.app_version_code === null ? null : Number(row.app_version_code),
    last_heartbeat_accepted_at: timestampOrNull(row.last_accepted_heartbeat_at),
    created_at: timestampOrNull(row.created_at)
  };
}

function commandProjection(command, acknowledgement) {
  const status = command.terminal_status || acknowledgement?.status || "NONE";
  return {
    protocol_version: Number(command.protocol_version),
    command_id: command.command_id,
    device_id: command.device_id,
    type: command.command_type,
    status,
    terminal_status: command.terminal_status,
    issued_at: new Date(command.issued_at).toISOString(),
    delivered_at: timestampOrNull(command.delivered_at),
    acknowledged_at: timestampOrNull(acknowledgement?.accepted_at),
    occurred_at: timestampOrNull(acknowledgement?.occurred_at),
    terminal_at: timestampOrNull(command.terminal_at)
  };
}

function canonicalCommand(type) {
  if (!RETAINED_COMMANDS.has(type) || !Object.hasOwn(COMMAND_EXPIRY_MS, type)) {
    if (typeof type === "string" && type.includes("TINDER")) {
      throw new DeviceBridgeProtocolError(410, "RETIRED_COMMAND", "Retired command type is unavailable");
    }
    throw new DeviceBridgeProtocolError(400, "COMMAND_TYPE_UNSUPPORTED", "Command type is not supported");
  }
  return {
    payload: type === "STOP_BRIDGE" ? { reason: "ADMIN_REQUEST" } : {},
    expiresInMs: COMMAND_EXPIRY_MS[type]
  };
}

function createResetAdminDeviceListHandler(pool) {
  return async function resetAdminDeviceListHandler(_req, res) {
    try {
      const result = await pool.query(
        `SELECT device_id, display_name, enrollment_state, bridge_service_state,
                app_version_name, app_version_code,
                last_accepted_heartbeat_at, created_at
           FROM device_bridge_devices
          ORDER BY created_at ASC, device_id ASC
          LIMIT 100`
      );
      const now = new Date();
      return res.status(200).json({
        ok: true,
        server_time: now.toISOString(),
        devices: result.rows.map((row) => deviceProjection(row, now))
      });
    } catch (error) {
      console.error("Device Bridge reset device-list read failed.");
      return res.status(500).json(protocolErrorBody(error));
    }
  };
}

function createResetAdminDeviceStatusHandler(pool) {
  return async function resetAdminDeviceStatusHandler(req, res) {
    try {
      if (!isUuidV4(req.params.deviceId)) {
        throw new DeviceBridgeProtocolError(400, "INVALID_IDENTIFIER", "Device identifier is invalid");
      }
      const result = await pool.query(
        `SELECT device_id, display_name, enrollment_state, bridge_service_state,
                app_version_name, app_version_code,
                last_accepted_heartbeat_at, created_at
           FROM device_bridge_devices
          WHERE device_id=$1`,
        [req.params.deviceId]
      );
      const row = result.rows[0];
      if (!row) throw new DeviceBridgeProtocolError(404, "DEVICE_NOT_FOUND", "Device was not found");
      const now = new Date();
      return res.status(200).json({ ok: true, server_time: now.toISOString(), device: deviceProjection(row, now) });
    } catch (error) {
      const status = error instanceof DeviceBridgeProtocolError ? error.status : 500;
      if (!(error instanceof DeviceBridgeProtocolError)) console.error("Device Bridge reset device-status read failed.");
      return res.status(status).json(protocolErrorBody(error));
    }
  };
}

function createResetAdminCommandHandler(pool) {
  return async function resetAdminCommandHandler(req, res) {
    let client;
    try {
      if (!isUuidV4(req.params.deviceId)) {
        throw new DeviceBridgeProtocolError(400, "INVALID_IDENTIFIER", "Device identifier is invalid");
      }
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)
          || Object.keys(req.body).length !== 1 || typeof req.body.type !== "string") {
        throw new DeviceBridgeProtocolError(400, "INVALID_BODY", "Command request must contain only type");
      }
      const command = canonicalCommand(req.body.type);
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.valueOf() + command.expiresInMs);
      const commandId = crypto.randomUUID();
      client = await pool.connect();
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT device_id, enrollment_state, revoked_at, configuration_revision
           FROM device_bridge_devices
          WHERE device_id=$1
          FOR UPDATE`,
        [req.params.deviceId]
      );
      const device = result.rows[0];
      if (!device) throw new DeviceBridgeProtocolError(404, "DEVICE_NOT_FOUND", "Device was not found");
      if (device.enrollment_state !== "ACTIVE" || device.revoked_at) {
        throw new DeviceBridgeProtocolError(403, "DEVICE_REVOKED", "Device is not active");
      }
      await client.query(
        `INSERT INTO device_bridge_commands
           (command_id, device_id, protocol_version, command_type, payload,
            configuration_revision, issued_at, expires_at)
         VALUES ($1,$2,1,$3,$4::jsonb,$5,$6,$7)`,
        [commandId, req.params.deviceId, req.body.type, JSON.stringify(command.payload),
          device.configuration_revision, issuedAt, expiresAt]
      );
      await client.query(
        `INSERT INTO device_bridge_audit_events
           (event_type, device_id, command_id, result_code, http_status, details)
         VALUES ('COMMAND_CREATED',$1,$2,'SUCCEEDED',201,$3::jsonb)`,
        [req.params.deviceId, commandId, JSON.stringify({ command_type: req.body.type })]
      );
      await client.query("COMMIT");
      return res.status(201).json({
        ok: true,
        command: {
          command_id: commandId,
          protocol_version: 1,
          type: req.body.type,
          issued_at: issuedAt.toISOString(),
          expires_at: expiresAt.toISOString(),
          configuration_revision: device.configuration_revision,
          payload: command.payload
        }
      });
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      const status = error instanceof DeviceBridgeProtocolError ? error.status : 500;
      if (!(error instanceof DeviceBridgeProtocolError)) console.error("Device Bridge reset command creation failed.");
      return res.status(status).json(protocolErrorBody(error));
    } finally {
      client?.release();
    }
  };
}

function createResetAdminCommandStatusHandler(pool) {
  return async function resetAdminCommandStatusHandler(req, res) {
    try {
      if (!isUuidV4(req.params.deviceId) || !isUuidV4(req.params.commandId)) {
        throw new DeviceBridgeProtocolError(400, "INVALID_IDENTIFIER", "Device or command identifier is invalid");
      }
      const commandResult = await pool.query(
        `SELECT command_id, device_id, protocol_version, command_type, issued_at,
                delivered_at, terminal_status, terminal_at
           FROM device_bridge_commands
          WHERE device_id=$1 AND command_id=$2`,
        [req.params.deviceId, req.params.commandId]
      );
      const command = commandResult.rows[0];
      if (!command) throw new DeviceBridgeProtocolError(404, "COMMAND_NOT_FOUND", "Command was not found");
      if (!RETAINED_COMMANDS.has(command.command_type)) {
        throw new DeviceBridgeProtocolError(410, "RETIRED_COMMAND", "Retired command status is unavailable");
      }
      const acknowledgement = await pool.query(
        `SELECT status, occurred_at, accepted_at
           FROM device_bridge_command_acks
          WHERE device_id=$1 AND command_id=$2
          ORDER BY accepted_at DESC, ack_id DESC
          LIMIT 1`,
        [req.params.deviceId, req.params.commandId]
      );
      return res.status(200).json({
        ok: true,
        server_time: new Date().toISOString(),
        command: commandProjection(command, acknowledgement.rows[0])
      });
    } catch (error) {
      const status = error instanceof DeviceBridgeProtocolError ? error.status : 500;
      if (!(error instanceof DeviceBridgeProtocolError)) console.error("Device Bridge reset command-status read failed.");
      return res.status(status).json(protocolErrorBody(error));
    }
  };
}

function createResetAdminDeviceRevokeHandler(pool) {
  return async function resetAdminDeviceRevokeHandler(req, res) {
    let client;
    try {
      if (!isUuidV4(req.params.deviceId)) {
        throw new DeviceBridgeProtocolError(400, "INVALID_IDENTIFIER", "Device identifier is invalid");
      }
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length !== 0) {
        throw new DeviceBridgeProtocolError(400, "INVALID_BODY", "Device revoke request must be an empty object");
      }
      const revokedAt = new Date();
      client = await pool.connect();
      await client.query("BEGIN");
      const result = await client.query(
        `SELECT device_id, enrollment_state, revoked_at
           FROM device_bridge_devices
          WHERE device_id=$1
          FOR UPDATE`,
        [req.params.deviceId]
      );
      const device = result.rows[0];
      if (!device) throw new DeviceBridgeProtocolError(404, "DEVICE_NOT_FOUND", "Device was not found");
      await client.query(
        `SELECT key_id FROM device_bridge_keys
          WHERE device_id=$1 AND revoked_at IS NULL
          FOR UPDATE`,
        [req.params.deviceId]
      );
      if (device.enrollment_state === "REVOKED" && device.revoked_at) {
        await client.query("COMMIT");
        return res.status(200).json({
          ok: true,
          protocol_version: 1,
          device_id: req.params.deviceId,
          enrollment_state: "REVOKED",
          revoked_at: new Date(device.revoked_at).toISOString()
        });
      }
      await client.query(
        `UPDATE device_bridge_devices
            SET enrollment_state='REVOKED', revoked_at=$2, revoked_reason='ADMIN_REQUEST',
                bridge_service_state='STOPPED', automation_state='STOPPED', updated_at=$2
          WHERE device_id=$1`,
        [req.params.deviceId, revokedAt]
      );
      await client.query(
        `UPDATE device_bridge_keys
            SET revoked_at=$2, revoked_reason='ADMIN_REQUEST'
          WHERE device_id=$1 AND revoked_at IS NULL`,
        [req.params.deviceId, revokedAt]
      );
      await client.query(
        `INSERT INTO device_bridge_audit_events
           (event_type, device_id, result_code, http_status, details)
         VALUES ('DEVICE_REVOKED',$1,'SUCCEEDED',200,$2::jsonb)`,
        [req.params.deviceId, JSON.stringify({ reason: "ADMIN_REQUEST" })]
      );
      await client.query("COMMIT");
      return res.status(200).json({
        ok: true,
        protocol_version: 1,
        device_id: req.params.deviceId,
        enrollment_state: "REVOKED",
        revoked_at: revokedAt.toISOString()
      });
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      const status = error instanceof DeviceBridgeProtocolError ? error.status : 500;
      if (!(error instanceof DeviceBridgeProtocolError)) console.error("Device Bridge reset device revoke failed.");
      return res.status(status).json(protocolErrorBody(error));
    } finally {
      client?.release();
    }
  };
}

export {
  createResetAdminCommandHandler,
  createResetAdminCommandStatusHandler,
  createResetAdminDeviceListHandler,
  createResetAdminDeviceRevokeHandler,
  createResetAdminDeviceStatusHandler
};
