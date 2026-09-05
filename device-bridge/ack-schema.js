/* ==================================================
DEVICE BRIDGE T0 — ACK SCHEMA COMPATIBILITY
================================================== */

import { canonicalCheckDefinition } from "./schema-contract.js";
import { isDeviceBridgeReadOnlyTransactionClient } from "./read-only-transaction.js";

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

async function completePayloadSemanticClassification(client, row, specification) {
  if (!isEligiblePayloadConstraint(row, specification)) {
    throw new Error("Device Bridge ACK schema compatibility check failed.");
  }
  try {
    // Dynamic loading avoids a static cycle because the bounded classifier
    // imports this module's fixed canonical ACK contract.
    const {
      isCompleteAckPayloadSemanticEquivalence,
      runDeviceBridgeAckPayloadSemanticClassifierWithClient
    } = await import("./ack-payload-semantic-classifier.js");
    const classification = await runDeviceBridgeAckPayloadSemanticClassifierWithClient(client);
    if (!isCompleteAckPayloadSemanticEquivalence(classification)) {
      throw new Error("Device Bridge ACK schema compatibility check failed.");
    }
    return classification;
  } catch (error) {
    if (error?.message === "Device Bridge ACK schema compatibility check failed.") throw error;
    throw new Error("Device Bridge ACK schema compatibility check failed.");
  }
}

async function hasCompatibleAckCheckDefinition(client, row, specification, allowSemanticFallback) {
  if (specification?.id !== "ACK_PAYLOAD_V1" || !allowSemanticFallback) {
    return hasExpectedDefinition(row, specification);
  }
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
  const ready = Boolean(payload && hasExpectedDefinition(payload, payloadSpecification));
  return { ready, constraintName: ready ? payload.conname : null };
}

/**
 * Read-only bounded payload inspection for the explicit ACK
 * canonicalization runner. It intentionally exposes no catalog definition.
 */
export async function inspectDeviceBridgeAckPayloadConstraint(client) {
  const constraints = await readDeviceBridgeAckCheckConstraints(client);
  const payload = findPayloadConstraint(constraints.rows);
  const specification = ACK_REQUIRED_CHECKS.at(-1);
  if (!payload || !isEligiblePayloadConstraint(payload, specification)) {
    return { state: "INVALID", constraintName: null };
  }
  return {
    state: hasExpectedDefinition(payload, specification) ? "CANONICAL" : "NONCANONICAL",
    constraintName: payload.conname
  };
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

export async function assertDeviceBridgeAckDataCompatible(client) {
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
}

async function preflightDeviceBridgeAckSchema(client, allowSemanticFallback) {
  const constraints = await readDeviceBridgeAckCheckConstraints(client);
  if (!await inspectAckColumnTypes(client)) {
    throw new Error("Device Bridge ACK schema compatibility check failed.");
  }
  let validChecks = constraints.rows.length === ACK_REQUIRED_CHECKS.length;
  for (const specification of ACK_REQUIRED_CHECKS) {
    if (!validChecks) break;
    let matches = 0;
    for (const row of constraints.rows) {
      if (await hasCompatibleAckCheckDefinition(client, row, specification, allowSemanticFallback)) matches += 1;
    }
    if (matches !== 1) validChecks = false;
  }
  if (!validChecks) throw new Error("Device Bridge ACK schema compatibility check failed.");
  await assertDeviceBridgeAckDataCompatible(client);
  return { ready: true };
}

/**
 * Read-only preflight for the one explicit ACK canonicalization migration.
 * All non-payload ACK contract pieces remain strict. A noncanonical payload
 * is eligible only after the existing complete 20/20 semantic classifier
 * proves exact equivalence with the fixed canonical rule.
 */
export async function preflightDeviceBridgeAckSchemaForCanonicalization(client) {
  const constraints = await readDeviceBridgeAckCheckConstraints(client);
  if (!await inspectAckColumnTypes(client) || constraints.rows.length !== ACK_REQUIRED_CHECKS.length) {
    throw new Error("Device Bridge ACK schema compatibility check failed.");
  }

  const payloadSpecification = ACK_REQUIRED_CHECKS.at(-1);
  let payload = null;
  for (const specification of ACK_REQUIRED_CHECKS) {
    if (specification.id === "ACK_PAYLOAD_V1") {
      const matches = constraints.rows.filter(row => sameColumns(row.column_names, specification.columns));
      if (matches.length !== 1) {
        throw new Error("Device Bridge ACK schema compatibility check failed.");
      }
      payload = matches[0];
      continue;
    }
    if (constraints.rows.filter(row => hasExpectedDefinition(row, specification)).length !== 1) {
      throw new Error("Device Bridge ACK schema compatibility check failed.");
    }
  }

  let state = "CANONICAL";
  let semanticClassification = null;
  if (!hasExpectedDefinition(payload, payloadSpecification)) {
    state = "NONCANONICAL";
    semanticClassification = await completePayloadSemanticClassification(client, payload, payloadSpecification);
  }

  await assertDeviceBridgeAckDataCompatible(client);
  return {
    ready: true,
    payload: {
      state,
      constraintName: payload.conname,
      semanticClassification
    }
  };
}

/**
 * Strict structural T1-runner preflight. ACK must already be canonical; this
 * path never repairs it and scans current rows before the first T1 DDL.
 */
export async function preflightDeviceBridgeAckSchemaForT1(client) {
  return preflightDeviceBridgeAckSchema(client, false);
}

/**
 * The explicit T1 migration runner reuses the same bounded semantic
 * equivalence check as the protected read-only preflight, but owns its
 * writable transaction itself. The classifier performs only SELECTs through
 * this already-owned client and never begins, commits, rolls back, or releases
 * it.
 */
export async function preflightDeviceBridgeAckSchemaForT1Migration(client) {
  return preflightDeviceBridgeAckSchema(client, true);
}

/**
 * The protected T1 read-only diagnostic preflight owns a fixed read-only
 * transaction and may use the same bounded semantic fallback only through its
 * guarded client.
 */
export async function preflightDeviceBridgeAckSchemaForProtectedT1Preflight(client) {
  if (!isDeviceBridgeReadOnlyTransactionClient(client)) {
    throw new Error("Device Bridge ACK schema compatibility check failed.");
  }
  return preflightDeviceBridgeAckSchema(client, true);
}
