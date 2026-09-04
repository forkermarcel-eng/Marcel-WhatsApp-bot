/* ==================================================
DEVICE BRIDGE T1 â€” ADDITIVE SCHEMA COMPATIBILITY
================================================== */

export const T1_TINDER_STATE_CONSTRAINT_NAME = "device_bridge_devices_tinder_state_check_v1";
export const T1_COMMAND_TYPE_CONSTRAINT_NAME = "device_bridge_commands_command_type_check_v1";

export const T1_TINDER_STATE_CHECK_EXPRESSION = `
  tinder_state IN ('DISCONNECTED', 'CONNECTING', 'CONNECTED', 'AUTH_REQUIRED', 'REVIEW_REQUIRED', 'UNKNOWN')
`;

export const T1_COMMAND_TYPE_CHECK_EXPRESSION = `
  command_type IN ('PING', 'REQUEST_STATUS', 'STOP_BRIDGE', 'CONNECT_TINDER', 'DISCONNECT_TINDER')
`;

const SCHEMA_CONSTRAINTS = Object.freeze([
  Object.freeze({
    table: "device_bridge_devices",
    column: "tinder_state",
    name: T1_TINDER_STATE_CONSTRAINT_NAME,
    expression: T1_TINDER_STATE_CHECK_EXPRESSION
  }),
  Object.freeze({
    table: "device_bridge_commands",
    column: "command_type",
    name: T1_COMMAND_TYPE_CONSTRAINT_NAME,
    expression: T1_COMMAND_TYPE_CHECK_EXPRESSION
  })
]);

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function hasExactlyColumn(row, column) {
  return Array.isArray(row.column_names) && row.column_names.length === 1 && row.column_names[0] === column;
}

async function ensureColumnConstraint(client, specification) {
  await client.query(`LOCK TABLE ${specification.table} IN ACCESS EXCLUSIVE MODE`);

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
    WHERE c.conrelid = '${specification.table}'::regclass
      AND c.contype = 'c'
  `);

  const matches = constraints.rows.filter(row => hasExactlyColumn(row, specification.column));
  if (matches.length !== 1 || matches[0].convalidated !== true) {
    throw new Error("Device Bridge T1 schema compatibility check failed.");
  }

  const current = matches[0];
  if (current.conname === specification.name) return false;

  const compatibility = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM ${specification.table}
      WHERE NOT (${specification.expression})
    ) AS incompatible
  `);
  if (compatibility.rows[0]?.incompatible !== false) {
    throw new Error("Device Bridge data is incompatible with the T1 extension.");
  }

  await client.query(
    `ALTER TABLE ${specification.table} DROP CONSTRAINT ${quoteIdentifier(current.conname)}`
  );
  await client.query(`
    ALTER TABLE ${specification.table}
    ADD CONSTRAINT ${specification.name}
    CHECK (${specification.expression})
  `);
  return true;
}

export async function ensureDeviceBridgeT1Schema(client) {
  const migrations = [];
  for (const specification of SCHEMA_CONSTRAINTS) {
    migrations.push(await ensureColumnConstraint(client, specification));
  }
  return { migrated: migrations.some(Boolean) };
}
