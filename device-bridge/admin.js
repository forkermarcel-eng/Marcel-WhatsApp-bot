import crypto from "crypto";
import {
  DEVICE_BRIDGE_PROTOCOL,
  DeviceBridgeProtocolError,
  isUuidV4,
  protocolErrorBody
} from "./protocol-v1.js";
import { deriveDeviceStatus } from "./heartbeat.js";

/* ==================================================
DEVICE BRIDGE T0 — PROTOCOL V1 ADMIN READ/COMMANDS
================================================== */

const COMMAND_EXPIRY_MS = Object.freeze({
  PING: 5 * 60 * 1000,
  REQUEST_STATUS: 5 * 60 * 1000,
  STOP_BRIDGE: 10 * 60 * 1000
});

function statusRow(row, now) {
  return {
    device_id: row.device_id,
    display_name: row.display_name,
    enrollment_state: row.enrollment_state,
    device_status: deriveDeviceStatus(row.last_accepted_heartbeat_at, now),
    last_heartbeat_accepted_at: row.last_accepted_heartbeat_at ? new Date(row.last_accepted_heartbeat_at).toISOString() : null,
    app_version: row.app_version_name,
    app_build: row.app_version_code === null ? null : Number(row.app_version_code),
    bridge_service_state: row.bridge_service_state,
    tinder_state: row.tinder_state,
    automation_state: row.automation_state,
    configuration_revision: row.configuration_revision
  };
}

const STATUS_COLUMNS = `device_id, display_name, enrollment_state, last_accepted_heartbeat_at,
  app_version_name, app_version_code, bridge_service_state, tinder_state,
  automation_state, configuration_revision`;

export function createAdminDeviceListHandler(pool) {
  return async function adminDeviceListHandler(req, res) {
    try {
      const now = new Date();
      const result = await pool.query(
        `SELECT ${STATUS_COLUMNS} FROM device_bridge_devices ORDER BY created_at ASC, device_id ASC LIMIT 100`
      );
      return res.status(200).json({ ok: true, server_time: now.toISOString(), devices: result.rows.map(row => statusRow(row, now)) });
    } catch (error) {
      console.error("Device Bridge admin device-list read failed.");
      return res.status(500).json(protocolErrorBody(error));
    }
  };
}

export function createAdminDeviceStatusHandler(pool) {
  return async function adminDeviceStatusHandler(req, res) {
    try {
      if (!isUuidV4(req.params.deviceId)) throw new DeviceBridgeProtocolError(400, "INVALID_IDENTIFIER", "Device identifier is invalid");
      const now = new Date();
      const result = await pool.query(
        `SELECT ${STATUS_COLUMNS} FROM device_bridge_devices WHERE device_id=$1`,
        [req.params.deviceId]
      );
      if (!result.rows[0]) throw new DeviceBridgeProtocolError(404, "DEVICE_NOT_FOUND", "Device was not found");
      return res.status(200).json({ ok: true, server_time: now.toISOString(), device: statusRow(result.rows[0], now) });
    } catch (error) {
      const status = error instanceof DeviceBridgeProtocolError ? error.status : 500;
      if (!(error instanceof DeviceBridgeProtocolError)) console.error("Device Bridge admin device-status read failed.");
      return res.status(status).json(protocolErrorBody(error));
    }
  };
}

export function canonicalCommand(type) {
  if (!Object.hasOwn(COMMAND_EXPIRY_MS, type)) {
    throw new DeviceBridgeProtocolError(400, "COMMAND_TYPE_UNSUPPORTED", "Command type is not supported");
  }
  return {
    payload: type === "STOP_BRIDGE" ? { reason: "ADMIN_REQUEST" } : {},
    expiresInMs: COMMAND_EXPIRY_MS[type]
  };
}

export function createAdminCommandHandler(pool) {
  return async function adminCommandHandler(req, res) {
    let client;
    try {
      if (!isUuidV4(req.params.deviceId)) throw new DeviceBridgeProtocolError(400, "INVALID_IDENTIFIER", "Device identifier is invalid");
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || typeof req.body.type !== "string") {
        throw new DeviceBridgeProtocolError(400, "INVALID_BODY", "Command request must contain only type");
      }
      const command = canonicalCommand(req.body.type);
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.valueOf() + command.expiresInMs);
      const commandId = crypto.randomUUID();
      client = await pool.connect();
      await client.query("BEGIN");
      const device = await client.query(
        `SELECT device_id, enrollment_state, revoked_at, configuration_revision
         FROM device_bridge_devices WHERE device_id=$1 FOR UPDATE`,
        [req.params.deviceId]
      );
      const row = device.rows[0];
      if (!row) throw new DeviceBridgeProtocolError(404, "DEVICE_NOT_FOUND", "Device was not found");
      if (row.enrollment_state !== "ACTIVE" || row.revoked_at) throw new DeviceBridgeProtocolError(403, "DEVICE_REVOKED", "Device is not active");
      await client.query(
        `INSERT INTO device_bridge_commands
          (command_id, device_id, protocol_version, command_type, payload,
           configuration_revision, issued_at, expires_at)
         VALUES ($1,$2,1,$3,$4::jsonb,$5,$6,$7)`,
        [commandId, req.params.deviceId, req.body.type, JSON.stringify(command.payload), row.configuration_revision, issuedAt, expiresAt]
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
          configuration_revision: row.configuration_revision,
          payload: command.payload
        }
      });
    } catch (error) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      const status = error instanceof DeviceBridgeProtocolError ? error.status : 500;
      if (!(error instanceof DeviceBridgeProtocolError)) console.error("Device Bridge admin command creation failed.");
      return res.status(status).json(protocolErrorBody(error));
    } finally {
      client?.release();
    }
  };
}

export function createAdminDeviceRevokeHandler(pool) {
  return async function adminDeviceRevokeHandler(req, res) {
    let client;
    try {
      if (!isUuidV4(req.params.deviceId)) throw new DeviceBridgeProtocolError(400, "INVALID_IDENTIFIER", "Device identifier is invalid");
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length !== 0) {
        throw new DeviceBridgeProtocolError(400, "INVALID_BODY", "Device revoke request must be an empty object");
      }

      const revokedAt = new Date();
      client = await pool.connect();
      await client.query("BEGIN");
      const device = await client.query(
        `SELECT device_id, enrollment_state, revoked_at
         FROM device_bridge_devices WHERE device_id=$1 FOR UPDATE`,
        [req.params.deviceId]
      );
      const row = device.rows[0];
      if (!row) throw new DeviceBridgeProtocolError(404, "DEVICE_NOT_FOUND", "Device was not found");

      await client.query(
        `SELECT key_id FROM device_bridge_keys
         WHERE device_id=$1 AND revoked_at IS NULL FOR UPDATE`,
        [req.params.deviceId]
      );

      if (row.enrollment_state === "REVOKED" && row.revoked_at) {
        await client.query("COMMIT");
        return res.status(200).json({
          ok: true,
          protocol_version: 1,
          device_id: req.params.deviceId,
          enrollment_state: "REVOKED",
          revoked_at: new Date(row.revoked_at).toISOString()
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
      if (!(error instanceof DeviceBridgeProtocolError)) console.error("Device Bridge admin device revocation failed.");
      return res.status(status).json(protocolErrorBody(error));
    } finally {
      client?.release();
    }
  };
}

export { COMMAND_EXPIRY_MS };
