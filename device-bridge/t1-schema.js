/* ==================================================
DEVICE BRIDGE T1 — EXPLICIT SCHEMA MIGRATION
================================================== */

export const T1_TINDER_STATE_CONSTRAINT_NAME = "device_bridge_devices_tinder_state_check_v1";
export const T1_COMMAND_TYPE_CONSTRAINT_NAME = "device_bridge_commands_command_type_check_v1";

export const T1_TINDER_STATE_CHECK_EXPRESSION = `
  tinder_state IN ('DISCONNECTED', 'CONNECTING', 'CONNECTED', 'AUTH_REQUIRED', 'REVIEW_REQUIRED', 'UNKNOWN')
`;

export const T1_COMMAND_TYPE_CHECK_EXPRESSION = `
  command_type IN ('PING', 'REQUEST_STATUS', 'STOP_BRIDGE', 'CONNECT_TINDER', 'DISCONNECT_TINDER')
`;

export const T1_SCHEMA_CONSTRAINTS = Object.freeze([
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

async function inspectColumnConstraint(client, specification) {
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
    return { specification, state: "INVALID", constraintName: null };
  }

  return {
    specification,
    state: matches[0].conname === specification.name ? "FINAL" : "LEGACY",
    constraintName: matches[0].conname
  };
}

/**
 * Read-only runtime inspection. It never locks or changes schema.
 */
export async function inspectDeviceBridgeT1Schema(client) {
  const constraints = [];
  for (const specification of T1_SCHEMA_CONSTRAINTS) {
    constraints.push(await inspectColumnConstraint(client, specification));
  }
  return {
    ready: constraints.every(item => item.state === "FINAL"),
    constraints
  };
}

export async function assertDeviceBridgeT1SchemaReady(client) {
  const inspection = await inspectDeviceBridgeT1Schema(client);
  if (!inspection.ready) throw new Error("Device Bridge T1 schema is not ready.");
  return inspection;
}

/**
 * Explicit migration preflight. It locks and validates every affected table
 * before any constraint mutation is issued.
 */
export async function preflightDeviceBridgeT1SchemaMigration(client) {
  for (const specification of T1_SCHEMA_CONSTRAINTS) {
    await client.query(`LOCK TABLE ${specification.table} IN ACCESS EXCLUSIVE MODE`);
  }

  const inspection = await inspectDeviceBridgeT1Schema(client);
  if (inspection.constraints.some(item => item.state === "INVALID")) {
    throw new Error("Device Bridge T1 schema compatibility check failed.");
  }

  const steps = [];
  for (const item of inspection.constraints) {
    if (item.state === "FINAL") {
      steps.push({ ...item, mutate: false });
      continue;
    }
    const compatibility = await client.query(`
      SELECT EXISTS (
        SELECT 1
        FROM ${item.specification.table}
        WHERE NOT (${item.specification.expression})
      ) AS incompatible
    `);
    if (compatibility.rows[0]?.incompatible !== false) {
      throw new Error("Device Bridge data is incompatible with the T1 extension.");
    }
    steps.push({ ...item, mutate: true });
  }

  return { steps };
}

/**
 * Mutating path for the explicit migration runner only. The caller owns the
 * surrounding PostgreSQL transaction.
 */
export async function migrateDeviceBridgeT1Schema(client) {
  const preflight = await preflightDeviceBridgeT1SchemaMigration(client);
  for (const step of preflight.steps) {
    if (!step.mutate) continue;
    await client.query(
      `ALTER TABLE ${step.specification.table} DROP CONSTRAINT ${quoteIdentifier(step.constraintName)}`
    );
    await client.query(`
      ALTER TABLE ${step.specification.table}
      ADD CONSTRAINT ${step.specification.name}
      CHECK (${step.specification.expression})
    `);
  }

  const postcheck = await inspectDeviceBridgeT1Schema(client);
  if (!postcheck.ready) throw new Error("Device Bridge T1 schema postcheck failed.");
  return { migrated: preflight.steps.some(step => step.mutate) };
}
