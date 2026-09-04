/* ==================================================
DEVICE BRIDGE T0 — EXPLICIT ACK SCHEMA MIGRATION
================================================== */

export const FINAL_ACK_CONSTRAINT_NAME = "device_bridge_command_acks_payload_check_v1";

export const FINAL_ACK_CHECK_EXPRESSION = `
  (status = 'RECEIVED' AND result IS NULL AND error IS NULL)
  OR (status = 'SUCCEEDED' AND error IS NULL)
  OR (status = 'FAILED' AND result IS NULL AND error IS NOT NULL)
  OR (status = 'REJECTED' AND result IS NULL)
  OR (status = 'EXPIRED' AND result IS NULL AND error IS NULL)
`;

const ACK_CONSTRAINT_COLUMNS = ["error", "result", "status"];

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

/**
 * Read-only runtime inspection. It never locks or changes schema.
 */
export async function inspectDeviceBridgeAckSchema(client) {
  const constraints = await client.query(`
    SELECT c.conname, c.convalidated,
      ARRAY(
        SELECT a.attname::text
        FROM unnest(c.conkey) AS key(attnum)
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid AND a.attnum = key.attnum
        ORDER BY a.attname
      ) AS column_names
    FROM pg_constraint c
    WHERE c.conrelid = 'device_bridge_command_acks'::regclass
      AND c.contype = 'c'
  `);

  const matches = constraints.rows.filter(row =>
    Array.isArray(row.column_names) &&
    row.column_names.length === ACK_CONSTRAINT_COLUMNS.length &&
    row.column_names.every((column, index) => column === ACK_CONSTRAINT_COLUMNS[index])
  );
  if (matches.length !== 1 || matches[0].convalidated !== true) {
    return { ready: false, constraintName: null };
  }
  return {
    ready: matches[0].conname === FINAL_ACK_CONSTRAINT_NAME,
    constraintName: matches[0].conname
  };
}

export async function assertDeviceBridgeAckSchemaReady(client) {
  const inspection = await inspectDeviceBridgeAckSchema(client);
  if (!inspection.ready) throw new Error("Device Bridge ACK schema is not ready.");
  return inspection;
}

export async function preflightDeviceBridgeAckSchemaMigration(client) {
  await client.query("LOCK TABLE device_bridge_command_acks IN ACCESS EXCLUSIVE MODE");
  const inspection = await inspectDeviceBridgeAckSchema(client);
  if (!inspection.constraintName) {
    throw new Error("Device Bridge ACK schema compatibility check failed.");
  }
  if (inspection.ready) return { mutate: false, constraintName: inspection.constraintName };

  const compatibility = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM device_bridge_command_acks
      WHERE NOT (${FINAL_ACK_CHECK_EXPRESSION})
    ) AS incompatible
  `);
  if (compatibility.rows[0]?.incompatible !== false) {
    throw new Error("Device Bridge ACK data is incompatible with Protocol V1.");
  }
  return { mutate: true, constraintName: inspection.constraintName };
}

/**
 * Mutating path for the explicit migration runner only. The caller owns the
 * surrounding PostgreSQL transaction.
 */
export async function migrateDeviceBridgeAckSchema(client) {
  const preflight = await preflightDeviceBridgeAckSchemaMigration(client);
  if (preflight.mutate) {
    await client.query(
      `ALTER TABLE device_bridge_command_acks DROP CONSTRAINT ${quoteIdentifier(preflight.constraintName)}`
    );
    await client.query(`
      ALTER TABLE device_bridge_command_acks
      ADD CONSTRAINT ${FINAL_ACK_CONSTRAINT_NAME}
      CHECK (${FINAL_ACK_CHECK_EXPRESSION})
    `);
  }
  const postcheck = await inspectDeviceBridgeAckSchema(client);
  if (!postcheck.ready) throw new Error("Device Bridge ACK schema postcheck failed.");
  return { migrated: preflight.mutate };
}
