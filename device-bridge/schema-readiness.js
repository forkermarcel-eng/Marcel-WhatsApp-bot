import { assertDeviceBridgeAckSchemaReady } from "./ack-schema.js";
import { assertDeviceBridgeT1SchemaReady } from "./t1-schema.js";

/* ==================================================
DEVICE BRIDGE — READ-ONLY RUNTIME SCHEMA READINESS
================================================== */

const REQUIRED_TABLES = Object.freeze([
  "device_bridge_devices",
  "device_bridge_keys",
  "device_bridge_enrollment_codes",
  "device_bridge_commands",
  "device_bridge_command_acks",
  "device_bridge_request_nonces",
  "device_bridge_audit_events"
]);

async function assertDeviceBridgeFoundationTables(client) {
  for (const table of REQUIRED_TABLES) {
    const result = await client.query("SELECT to_regclass($1) AS relation_name", [table]);
    if (!result.rows[0]?.relation_name) {
      throw new Error("Device Bridge schema is not ready.");
    }
  }
}

/**
 * Runtime startup check. It is deliberately read-only: no transaction,
 * locks, DDL, row updates, or migration helper is invoked here.
 */
export async function verifyDeviceBridgeSchema(pool) {
  const client = await pool.connect();
  try {
    await assertDeviceBridgeFoundationTables(client);
    await assertDeviceBridgeT1SchemaReady(client);
    await assertDeviceBridgeAckSchemaReady(client);
    return { ready: true };
  } finally {
    client.release();
  }
}

export { REQUIRED_TABLES };
