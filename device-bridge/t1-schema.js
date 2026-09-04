/* ==================================================
DEVICE BRIDGE T1 — EXPLICIT SCHEMA MIGRATION
================================================== */

import { canonicalCheckDefinition } from "./schema-contract.js";

export const T1_TINDER_STATE_CONSTRAINT_NAME = "device_bridge_devices_tinder_state_check_v1";
export const T1_COMMAND_TYPE_CONSTRAINT_NAME = "device_bridge_commands_command_type_check_v1";

const LEGACY_T1_TINDER_STATE_CONSTRAINT_NAME = "device_bridge_devices_tinder_state_check";
const LEGACY_T1_COMMAND_TYPE_CONSTRAINT_NAME = "device_bridge_commands_command_type_check";

const LEGACY_TINDER_STATES = Object.freeze([
  "DISCONNECTED",
  "CONNECTED",
  "AUTH_REQUIRED",
  "REVIEW_REQUIRED",
  "UNKNOWN"
]);
const FINAL_TINDER_STATES = Object.freeze([
  "DISCONNECTED",
  "CONNECTING",
  "CONNECTED",
  "AUTH_REQUIRED",
  "REVIEW_REQUIRED",
  "UNKNOWN"
]);
const LEGACY_COMMAND_TYPES = Object.freeze(["PING", "REQUEST_STATUS", "STOP_BRIDGE"]);
const FINAL_COMMAND_TYPES = Object.freeze([
  "PING",
  "REQUEST_STATUS",
  "STOP_BRIDGE",
  "CONNECT_TINDER",
  "DISCONNECT_TINDER"
]);

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
    legacyName: LEGACY_T1_TINDER_STATE_CONSTRAINT_NAME,
    expression: T1_TINDER_STATE_CHECK_EXPRESSION,
    legacyValues: LEGACY_TINDER_STATES,
    finalValues: FINAL_TINDER_STATES
  }),
  Object.freeze({
    table: "device_bridge_commands",
    column: "command_type",
    name: T1_COMMAND_TYPE_CONSTRAINT_NAME,
    legacyName: LEGACY_T1_COMMAND_TYPE_CONSTRAINT_NAME,
    expression: T1_COMMAND_TYPE_CHECK_EXPRESSION,
    legacyValues: LEGACY_COMMAND_TYPES,
    finalValues: FINAL_COMMAND_TYPES
  })
]);

function hasExactlyColumn(row, column) {
  return Array.isArray(row.column_names) && row.column_names.length === 1 && row.column_names[0] === column;
}

function hasExactCheckDefinition(definition, expected) {
  try {
    return canonicalCheckDefinition(definition) === canonicalCheckDefinition(expected);
  } catch {
    return false;
  }
}

async function inspectColumnConstraint(client, specification) {
  const constraints = await client.query(`
    SELECT c.conname, c.convalidated, c.condeferrable, c.condeferred,
      pg_get_constraintdef(c.oid, true) AS constraint_definition,
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
  if (matches.length !== 1 || matches[0].convalidated !== true || matches[0].condeferrable !== false || matches[0].condeferred !== false) {
    return { specification, state: "INVALID", constraintName: null };
  }

  const current = matches[0];
  if (current.conname === specification.name && hasExactCheckDefinition(current.constraint_definition, specification.expression)) {
    return { specification, state: "FINAL", constraintName: current.conname };
  }
  const legacyExpression = `${specification.column} IN (${specification.legacyValues.map(value => `'${value}'`).join(", ")})`;
  if (current.conname === specification.legacyName && hasExactCheckDefinition(current.constraint_definition, legacyExpression)) {
    return { specification, state: "LEGACY", constraintName: current.conname };
  }
  return { specification, state: "INVALID", constraintName: null };
}

/** Read-only runtime inspection. It never locks or changes schema. */
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

/** Read-only T1 constraint and row preflight. */
export async function preflightDeviceBridgeT1SchemaMigration(client) {
  const inspection = await inspectDeviceBridgeT1Schema(client);
  if (inspection.constraints.some(item => item.state === "INVALID")) {
    throw new Error("Device Bridge T1 schema compatibility check failed.");
  }

  const steps = [];
  for (const item of inspection.constraints) {
    const compatibility = await client.query(`
      SELECT EXISTS (
        SELECT 1
        FROM ${item.specification.table}
        WHERE (${item.specification.expression}) IS NOT TRUE
      ) AS incompatible
    `);
    if (compatibility.rows[0]?.incompatible !== false) {
      throw new Error("Device Bridge data is incompatible with the T1 extension.");
    }
    steps.push({ ...item, mutate: item.state === "LEGACY" });
  }

  return { steps };
}

export async function postcheckDeviceBridgeT1SchemaMigration(client) {
  const postcheck = await inspectDeviceBridgeT1Schema(client);
  if (!postcheck.ready) throw new Error("Device Bridge T1 schema postcheck failed.");
  return postcheck;
}
