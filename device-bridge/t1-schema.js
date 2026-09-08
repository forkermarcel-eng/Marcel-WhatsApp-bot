/* ==================================================
DEVICE BRIDGE T1 — EXPLICIT SCHEMA MIGRATION
================================================== */

import { canonicalCheckDefinition } from "./schema-contract.js";

export const T1_TINDER_STATE_CONSTRAINT_NAME = "device_bridge_devices_tinder_state_check_v1";
export const T1_COMMAND_TYPE_CONSTRAINT_NAME = "device_bridge_commands_command_type_check_v1";
// A later exact command-type superset remains T1-compatible for all existing
// runtime/readiness callers.  It is named separately so only its own explicit
// human-armed migration may create it.
export const T2_HUMAN_ARMED_COMMAND_TYPE_CONSTRAINT_NAME =
  "device_bridge_commands_command_type_check_v2";
// T5 owns the next exact superset.  T1/T2 readiness may accept it as a
// forward-compatible command vocabulary, but only the dedicated T5 runner
// may create it.
export const T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CONSTRAINT_NAME =
  "device_bridge_commands_command_type_check_v3";
// V4 owns the next exact superset. It only adds the staged visible-chat sync
// vocabulary; it must never reinterpret the V3 human-binding permit.
export const T4_TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE_CONSTRAINT_NAME =
  "device_bridge_commands_command_type_check_v4";
// V5 adds only the separately authorized standard-official-app resume
// vocabulary. It does not grant a device the T5 manual-send capability.
export const TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME =
  "device_bridge_commands_command_type_check_v5";

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
const T2_HUMAN_ARMED_COMMAND_TYPES = Object.freeze([
  ...FINAL_COMMAND_TYPES,
  "ARM_TINDER_CONVERSATION_BINDING"
]);
const T5_TINDER_MANUAL_SEND_COMMAND_TYPES = Object.freeze([
  ...T2_HUMAN_ARMED_COMMAND_TYPES,
  "SEND_TINDER_DRAFT"
]);
const T4_TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPES = Object.freeze([
  ...T5_TINDER_MANUAL_SEND_COMMAND_TYPES,
  "SYNC_TINDER_VISIBLE_CHAT"
]);
export const TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPES = Object.freeze([
  ...T4_TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPES,
  "RESUME_OFFICIAL_TINDER_APP"
]);

export const T1_TINDER_STATE_CHECK_EXPRESSION = `
  tinder_state IN ('DISCONNECTED', 'CONNECTING', 'CONNECTED', 'AUTH_REQUIRED', 'REVIEW_REQUIRED', 'UNKNOWN')
`;

export const T1_COMMAND_TYPE_CHECK_EXPRESSION = `
  command_type IN ('PING', 'REQUEST_STATUS', 'STOP_BRIDGE', 'CONNECT_TINDER', 'DISCONNECT_TINDER')
`;

export const T2_HUMAN_ARMED_COMMAND_TYPE_CHECK_EXPRESSION = `
  command_type IN ('PING', 'REQUEST_STATUS', 'STOP_BRIDGE', 'CONNECT_TINDER', 'DISCONNECT_TINDER', 'ARM_TINDER_CONVERSATION_BINDING')
`;

export const T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CHECK_EXPRESSION = `
  command_type IN ('PING', 'REQUEST_STATUS', 'STOP_BRIDGE', 'CONNECT_TINDER', 'DISCONNECT_TINDER', 'ARM_TINDER_CONVERSATION_BINDING', 'SEND_TINDER_DRAFT')
`;

export const T4_TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE_CHECK_EXPRESSION = `
  command_type IN ('PING', 'REQUEST_STATUS', 'STOP_BRIDGE', 'CONNECT_TINDER', 'DISCONNECT_TINDER', 'ARM_TINDER_CONVERSATION_BINDING', 'SEND_TINDER_DRAFT', 'SYNC_TINDER_VISIBLE_CHAT')
`;

export const TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CHECK_EXPRESSION = `
  command_type IN ('PING', 'REQUEST_STATUS', 'STOP_BRIDGE', 'CONNECT_TINDER', 'DISCONNECT_TINDER', 'ARM_TINDER_CONVERSATION_BINDING', 'SEND_TINDER_DRAFT', 'SYNC_TINDER_VISIBLE_CHAT', 'RESUME_OFFICIAL_TINDER_APP')
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
    finalValues: FINAL_COMMAND_TYPES,
    forwardCompatibleName: T2_HUMAN_ARMED_COMMAND_TYPE_CONSTRAINT_NAME,
    forwardCompatibleExpression: T2_HUMAN_ARMED_COMMAND_TYPE_CHECK_EXPRESSION,
    forwardCompatibleValues: T2_HUMAN_ARMED_COMMAND_TYPES,
    futureCompatibleName: T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CONSTRAINT_NAME,
    futureCompatibleExpression: T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CHECK_EXPRESSION,
    futureCompatibleValues: T5_TINDER_MANUAL_SEND_COMMAND_TYPES,
    latestCompatibleName: T4_TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE_CONSTRAINT_NAME,
    latestCompatibleExpression: T4_TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE_CHECK_EXPRESSION,
    latestCompatibleValues: T4_TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPES,
    newestCompatibleName: TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME,
    newestCompatibleExpression: TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CHECK_EXPRESSION,
    newestCompatibleValues: TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPES
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
    return {
      specification,
      state: "FINAL",
      constraintName: current.conname,
      compatibilityExpression: specification.expression
    };
  }
  if (current.conname === specification.forwardCompatibleName
      && hasExactCheckDefinition(current.constraint_definition, specification.forwardCompatibleExpression)) {
    return {
      specification,
      state: "FINAL",
      constraintName: current.conname,
      compatibilityExpression: specification.forwardCompatibleExpression
    };
  }
  if (current.conname === specification.futureCompatibleName
      && hasExactCheckDefinition(current.constraint_definition, specification.futureCompatibleExpression)) {
    return {
      specification,
      state: "FINAL",
      constraintName: current.conname,
      compatibilityExpression: specification.futureCompatibleExpression
    };
  }
  if (current.conname === specification.latestCompatibleName
      && hasExactCheckDefinition(current.constraint_definition, specification.latestCompatibleExpression)) {
    return {
      specification,
      state: "FINAL",
      constraintName: current.conname,
      compatibilityExpression: specification.latestCompatibleExpression
    };
  }
  if (current.conname === specification.newestCompatibleName
      && hasExactCheckDefinition(current.constraint_definition, specification.newestCompatibleExpression)) {
    return {
      specification,
      state: "FINAL",
      constraintName: current.conname,
      compatibilityExpression: specification.newestCompatibleExpression
    };
  }
  const legacyExpression = `${specification.column} IN (${specification.legacyValues.map(value => `'${value}'`).join(", ")})`;
  if (current.conname === specification.legacyName && hasExactCheckDefinition(current.constraint_definition, legacyExpression)) {
    return {
      specification,
      state: "LEGACY",
      constraintName: current.conname,
      compatibilityExpression: legacyExpression
    };
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
  if (new Set(inspection.constraints.map(item => item.state)).size !== 1) {
    throw new Error("Device Bridge T1 schema migration requires one unambiguous constraint state.");
  }

  const steps = [];
  for (const item of inspection.constraints) {
    const compatibility = await client.query(`
      SELECT EXISTS (
        SELECT 1
        FROM ${item.specification.table}
        WHERE (${item.compatibilityExpression ?? item.specification.expression}) IS NOT TRUE
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
  const postcheck = await preflightDeviceBridgeT1SchemaMigration(client);
  if (postcheck.steps.some(step => step.mutate)) {
    throw new Error("Device Bridge T1 schema postcheck failed.");
  }
  return { ready: true, constraints: postcheck.steps };
}
