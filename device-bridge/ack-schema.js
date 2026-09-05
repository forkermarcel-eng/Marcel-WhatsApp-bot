/* ==================================================
DEVICE BRIDGE T0 — ACK SCHEMA COMPATIBILITY
================================================== */

import { canonicalCheckDefinition } from "./schema-contract.js";

export const ACK_FOUNDATION_TABLE = "device_bridge_command_acks";
export const FINAL_ACK_CONSTRAINT_NAME = "device_bridge_command_acks_payload_check_v1";

export const FINAL_ACK_CHECK_EXPRESSION = `
  (status = 'RECEIVED' AND result IS NULL AND error IS NULL)
  OR (status = 'SUCCEEDED' AND error IS NULL)
  OR (status = 'FAILED' AND result IS NULL AND error IS NOT NULL)
  OR (status = 'REJECTED' AND result IS NULL)
  OR (status = 'EXPIRED' AND result IS NULL AND error IS NULL)
`;

const ACK_STATUS_VALUES = Object.freeze(["RECEIVED", "SUCCEEDED", "FAILED", "REJECTED", "EXPIRED"]);
const ACK_CONSTRAINT_COLUMNS = ["error", "result", "status"];
export const ACK_REQUIRED_CHECKS = Object.freeze([
  Object.freeze({
    id: "ACK_STATUS_VALUES",
    columns: ["status"],
    expression: `status IN (${ACK_STATUS_VALUES.map(value => `'${value}'`).join(", ")})`
  }),
  Object.freeze({
    id: "ACK_RESULT_OBJECT",
    columns: ["result"],
    expression: "result IS NULL OR jsonb_typeof(result) = 'object'"
  }),
  Object.freeze({
    id: "ACK_ERROR_OBJECT",
    columns: ["error"],
    expression: "error IS NULL OR jsonb_typeof(error) = 'object'"
  }),
  Object.freeze({
    id: "ACK_BODY_SHA256",
    columns: ["body_sha256"],
    expression: "body_sha256 ~ '^[0-9a-f]{64}$'"
  }),
  Object.freeze({
    id: "ACK_PAYLOAD_V1",
    name: FINAL_ACK_CONSTRAINT_NAME,
    columns: ACK_CONSTRAINT_COLUMNS,
    expression: FINAL_ACK_CHECK_EXPRESSION
  })
]);
export const ACK_REQUIRED_COLUMN_TYPES = Object.freeze({ status: "text", result: "jsonb", error: "jsonb" });

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sameColumns(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((column, index) => column === expected[index]);
}

function hasExpectedDefinition(row, specification) {
  try {
    return sameColumns(row.column_names, specification.columns)
      && (!specification.name || row.conname === specification.name)
      && row.convalidated === true
      && row.condeferrable === false
      && row.condeferred === false
      && canonicalCheckDefinition(row.constraint_definition) === canonicalCheckDefinition(specification.expression);
  } catch {
    return false;
  }
}

export function hasExpectedAckCheckDefinition(row, specification) {
  return hasExpectedDefinition(row, specification);
}

function isEligiblePayloadConstraint(row, specification) {
  return specification?.id === "ACK_PAYLOAD_V1"
    && sameColumns(row?.column_names, specification.columns)
    && row?.conname === specification.name
    && row?.convalidated === true
    && row?.condeferrable === false
    && row?.condeferred === false;
}

async function hasSemanticallyEquivalentPayloadDefinition(client, row, specification) {
  if (hasExpectedDefinition(row, specification)) return true;
  if (!isEligiblePayloadConstraint(row, specification)) return false;

  try {
    // This fallback is only reached after the strict structural comparison
    // fails. Dynamic loading avoids a static cycle because the bounded
    // classifier shares this module's canonical ACK contract constants.
    const {
      isCompleteAckPayloadSemanticEquivalence,
      runDeviceBridgeAckPayloadSemanticClassifierWithClient
    } = await import("./ack-payload-semantic-classifier.js");
    const classification = await runDeviceBridgeAckPayloadSemanticClassifierWithClient(client);
    return isCompleteAckPayloadSemanticEquivalence(classification);
  } catch {
    return false;
  }
}

async function hasCompatibleAckCheckDefinition(client, row, specification) {
  if (specification?.id !== "ACK_PAYLOAD_V1") return hasExpectedDefinition(row, specification);
  return hasSemanticallyEquivalentPayloadDefinition(client, row, specification);
}

export async function readDeviceBridgeAckCheckConstraints(client) {
  return client.query(`
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
    WHERE c.conrelid = '${ACK_FOUNDATION_TABLE}'::regclass
      AND c.contype = 'c'
  `);
}

function findPayloadConstraint(rows) {
  const matches = rows.filter(row => sameColumns(row.column_names, ACK_CONSTRAINT_COLUMNS));
  return matches.length === 1 ? matches[0] : null;
}

/** Read-only inspection for runtime readiness. */
export async function inspectDeviceBridgeAckSchema(client) {
  const constraints = await readDeviceBridgeAckCheckConstraints(client);
  const payload = findPayloadConstraint(constraints.rows);
  const payloadSpecification = ACK_REQUIRED_CHECKS.at(-1);
  const ready = Boolean(payload && await hasCompatibleAckCheckDefinition(client, payload, payloadSpecification));
  return { ready, constraintName: ready ? payload.conname : null };
}

export async function assertDeviceBridgeAckSchemaReady(client) {
  const inspection = await inspectDeviceBridgeAckSchema(client);
  if (!inspection.ready) throw new Error("Device Bridge ACK schema is not ready.");
  return inspection;
}

async function inspectAckColumnTypes(client) {
  const result = await client.query(`
    SELECT column_name, udt_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'device_bridge_command_acks'
      AND column_name = ANY($1::text[])
  `, [Object.keys(ACK_REQUIRED_COLUMN_TYPES)]);
  const actual = new Map(result.rows.map(row => [row.column_name, row.udt_name]));
  return Object.entries(ACK_REQUIRED_COLUMN_TYPES).every(([column, type]) => actual.get(column) === type);
}

/**
 * Read-only T1-runner preflight. ACK must already be canonical; this path
 * never repairs it and scans current rows before the first T1 DDL.
 */
export async function preflightDeviceBridgeAckSchemaForT1(client) {
  const constraints = await readDeviceBridgeAckCheckConstraints(client);
  let validChecks = constraints.rows.length === ACK_REQUIRED_CHECKS.length;
  for (const specification of ACK_REQUIRED_CHECKS) {
    if (!validChecks) break;
    let matches = 0;
    for (const row of constraints.rows) {
      if (await hasCompatibleAckCheckDefinition(client, row, specification)) matches += 1;
    }
    if (matches !== 1) validChecks = false;
  }
  if (!validChecks) throw new Error("Device Bridge ACK schema compatibility check failed.");
  if (!await inspectAckColumnTypes(client)) {
    throw new Error("Device Bridge ACK schema compatibility check failed.");
  }
  const compatibility = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM device_bridge_command_acks
      WHERE (${FINAL_ACK_CHECK_EXPRESSION}) IS NOT TRUE
    ) AS incompatible
  `);
  if (compatibility.rows[0]?.incompatible !== false) {
    throw new Error("Device Bridge ACK data is incompatible with Protocol V1.");
  }
  return { ready: true };
}

/** Separate ACK migration helper; the T1 runner never imports or calls it. */
export async function preflightDeviceBridgeAckSchemaMigration(client) {
  await client.query("LOCK TABLE device_bridge_command_acks IN ACCESS EXCLUSIVE MODE");
  const constraints = await readDeviceBridgeAckCheckConstraints(client);
  const current = findPayloadConstraint(constraints.rows);
  if (!current || current.convalidated !== true) {
    throw new Error("Device Bridge ACK schema compatibility check failed.");
  }
  if (current.conname === FINAL_ACK_CONSTRAINT_NAME) return { mutate: false, constraintName: current.conname };

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
  return { mutate: true, constraintName: current.conname };
}

/** Separate ACK migration helper; it is intentionally outside the T1 runner. */
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
