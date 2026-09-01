/* ==================================================
DEVICE BRIDGE T0 — ACK SCHEMA COMPATIBILITY
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

export async function ensureDeviceBridgeAckSchema(client) {
  await client.query("LOCK TABLE device_bridge_command_acks IN ACCESS EXCLUSIVE MODE");

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

  const ackConstraints = constraints.rows.filter(row =>
    Array.isArray(row.column_names) &&
    row.column_names.length === ACK_CONSTRAINT_COLUMNS.length &&
    row.column_names.every((column, index) => column === ACK_CONSTRAINT_COLUMNS[index])
  );

  if (ackConstraints.length !== 1) {
    throw new Error("Device Bridge ACK schema compatibility check failed.");
  }

  const current = ackConstraints[0];
  if (current.conname === FINAL_ACK_CONSTRAINT_NAME) {
    if (current.convalidated !== true) {
      throw new Error("Device Bridge ACK schema compatibility check failed.");
    }
    return { migrated: false };
  }

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

  await client.query(
    `ALTER TABLE device_bridge_command_acks DROP CONSTRAINT ${quoteIdentifier(current.conname)}`
  );
  await client.query(`
    ALTER TABLE device_bridge_command_acks
    ADD CONSTRAINT ${FINAL_ACK_CONSTRAINT_NAME}
    CHECK (${FINAL_ACK_CHECK_EXPRESSION})
  `);

  return { migrated: true };
}
