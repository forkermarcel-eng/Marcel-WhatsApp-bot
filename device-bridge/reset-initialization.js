import { markDeviceBridgeReady } from "./readiness.js";

/* ==================================================
DEVICE BRIDGE RESET — GENERIC RUNTIME READINESS

The reset runtime deliberately checks only the generic enrolled-device
foundation it still uses.  It does not inspect any retired command, permit,
capture, or product-schema contract, and it never creates or changes schema.
================================================== */

const RESET_FOUNDATION = Object.freeze({
  device_bridge_devices: Object.freeze([
    "device_id", "installation_id", "display_name", "enrollment_state",
    "bridge_service_state", "app_version_name", "app_version_code",
    "manufacturer", "model", "android_api", "abis", "capabilities",
    "configuration_revision", "last_heartbeat_sequence",
    "last_heartbeat_body_sha256", "last_accepted_heartbeat_at", "revoked_at",
    "revoked_reason", "created_at", "updated_at"
  ]),
  device_bridge_keys: Object.freeze([
    "key_id", "device_id", "algorithm", "public_key_spki_der", "revoked_at"
  ]),
  device_bridge_enrollment_codes: Object.freeze([
    "enrollment_code_id", "code_digest", "display_name", "expires_at", "consumed_at",
    "enrollment_attempt_id", "consumed_installation_id", "consumed_public_key_fingerprint",
    "consumed_device_id", "consumed_key_id", "created_at", "created_by"
  ]),
  device_bridge_commands: Object.freeze([
    "command_id", "device_id", "protocol_version", "command_type", "payload",
    "configuration_revision", "issued_at", "expires_at", "created_by", "delivered_at",
    "terminal_status", "terminal_at"
  ]),
  device_bridge_command_acks: Object.freeze([
    "ack_id", "command_id", "device_id", "status", "occurred_at", "result", "error",
    "body_sha256", "accepted_at"
  ]),
  device_bridge_request_nonces: Object.freeze([
    "auth_subject", "request_id", "content_sha256", "accepted_at", "expires_at"
  ]),
  device_bridge_audit_events: Object.freeze([
    "audit_event_id", "event_type", "request_id", "device_id", "key_id", "command_id",
    "result_code", "http_status", "details", "created_at"
  ])
});

async function assertResetFoundation(client) {
  for (const [table, columns] of Object.entries(RESET_FOUNDATION)) {
    const relation = await client.query(
      "SELECT to_regclass($1) AS relation_name",
      [`public.${table}`]
    );
    if (!relation.rows[0]?.relation_name) {
      throw new Error("Generic Device Bridge foundation is incomplete");
    }
    const found = await client.query(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name = ANY($2::text[])`,
      [table, columns]
    );
    const present = new Set(found.rows.map((row) => row.column_name));
    if (columns.some((column) => !present.has(column))) {
      throw new Error("Generic Device Bridge foundation is incomplete");
    }
  }
}

async function verifyResetDeviceBridgeSchema(pool) {
  const client = await pool.connect();
  try {
    await assertResetFoundation(client);
    return { ready: true };
  } finally {
    client.release();
  }
}

async function initializeResetDeviceBridgeDatabase(
  pool,
  {
    verifySchema = verifyResetDeviceBridgeSchema,
    markReady = markDeviceBridgeReady,
    logger = console
  } = {}
) {
  try {
    await verifySchema(pool);
    markReady();
    logger.log("Generic Device Bridge schema readiness verified.");
    return true;
  } catch {
    logger.error("Generic Device Bridge schema readiness check failed.");
    return false;
  }
}

export {
  RESET_FOUNDATION,
  assertResetFoundation,
  initializeResetDeviceBridgeDatabase,
  verifyResetDeviceBridgeSchema
};
