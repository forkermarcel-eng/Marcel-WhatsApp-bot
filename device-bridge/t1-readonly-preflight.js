import {
  inspectDeviceBridgeFoundationTables,
  preflightDeviceBridgeFoundationForT1
} from "./schema-readiness.js";
import { preflightDeviceBridgeAckSchemaForT1 } from "./ack-schema.js";
import {
  inspectDeviceBridgeT1Schema,
  preflightDeviceBridgeT1SchemaMigration
} from "./t1-schema.js";

/* ==================================================
DEVICE BRIDGE T1 — PROTECTED READ-ONLY PREFLIGHT
================================================== */

const CONSTRAINT_STATES = new Set(["LEGACY", "FINAL", "INVALID"]);
const READ_ONLY_GUARD_CODE = "READ_ONLY_QUERY_REJECTED";

function emptyResult() {
  return {
    foundation: { present: null, compatible: null },
    ack: { present: null, compatible: null },
    t1: {
      legacy_tinder_state_constraint: "NOT_CHECKED",
      legacy_command_type_constraint: "NOT_CHECKED",
      incompatible_rows: null,
      preflight_pass: false
    },
    preflight_pass: false,
    reason_code: null
  };
}

function constraintState(value) {
  return CONSTRAINT_STATES.has(value) ? value : "INVALID";
}

function applyT1Inspection(result, inspection) {
  for (const item of inspection?.constraints || []) {
    const state = constraintState(item?.state);
    if (item?.specification?.column === "tinder_state") {
      result.t1.legacy_tinder_state_constraint = state;
    }
    if (item?.specification?.column === "command_type") {
      result.t1.legacy_command_type_constraint = state;
    }
  }
}

function queryText(statement) {
  if (typeof statement === "string") return statement;
  if (statement && typeof statement.text === "string") return statement.text;
  return "";
}

function isSelectOnly(statement) {
  return /^\s*SELECT\b/i.test(queryText(statement));
}

function reasonCode(stage, error) {
  if (error?.code === READ_ONLY_GUARD_CODE) return "PREFLIGHT_GUARD_BLOCKED";
  const message = error instanceof Error ? error.message : "";

  if (stage === "foundation") {
    if (message === "Device Bridge T1 migration requires a complete existing foundation.") {
      return "FOUNDATION_MISSING";
    }
    if (message === "Device Bridge T1 foundation compatibility check failed.") {
      return "FOUNDATION_INCOMPATIBLE";
    }
  }
  if (stage === "ack") {
    if (message === "Device Bridge ACK data is incompatible with Protocol V1.") {
      return "ACK_ROWS_INCOMPATIBLE";
    }
    if (message === "Device Bridge ACK schema compatibility check failed.") {
      return "ACK_INCOMPATIBLE";
    }
  }
  if (stage === "t1") {
    if (message === "Device Bridge data is incompatible with the T1 extension.") {
      return "T1_ROWS_INCOMPATIBLE";
    }
    if (message === "Device Bridge T1 schema compatibility check failed.") {
      return "T1_CONSTRAINT_INCOMPATIBLE";
    }
  }
  return "PREFLIGHT_UNAVAILABLE";
}

function markFoundationPresence(result, inspection) {
  result.foundation.present = inspection?.ready === true;
  if (inspection?.ready !== true) {
    result.foundation.compatible = false;
    if (Array.isArray(inspection?.missing) && inspection.missing.includes("device_bridge_command_acks")) {
      result.ack.present = false;
      result.ack.compatible = false;
    }
  }
}

/**
 * Runs the existing T1 Foundation, ACK and schema preflights in one fixed
 * read-only transaction. The optional dependencies are an internal test seam;
 * HTTP callers never supply functions or SQL.
 */
export async function runDeviceBridgeT1ReadOnlyPreflight(pool, dependencies = {}) {
  const inspectFoundation = dependencies.inspectFoundation || inspectDeviceBridgeFoundationTables;
  const preflightFoundation = dependencies.preflightFoundation || preflightDeviceBridgeFoundationForT1;
  const preflightAck = dependencies.preflightAck || preflightDeviceBridgeAckSchemaForT1;
  const inspectT1 = dependencies.inspectT1 || inspectDeviceBridgeT1Schema;
  const preflightT1 = dependencies.preflightT1 || preflightDeviceBridgeT1SchemaMigration;
  const result = emptyResult();
  let client;
  let rawQuery;
  let originalQuery;
  let transactionStarted = false;
  let stage = "connect";

  try {
    client = await pool.connect();
    rawQuery = client.query.bind(client);

    stage = "begin";
    await rawQuery("BEGIN");
    transactionStarted = true;
    stage = "transaction";
    await rawQuery("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");

    originalQuery = client.query;
    client.query = (...args) => {
      if (!isSelectOnly(args[0])) {
        const error = new Error("Read-only preflight rejected a non-SELECT query.");
        error.code = READ_ONLY_GUARD_CODE;
        throw error;
      }
      return rawQuery(...args);
    };

    stage = "foundation-presence";
    const foundationPresence = await inspectFoundation(client);
    markFoundationPresence(result, foundationPresence);

    stage = "foundation";
    await preflightFoundation(client);
    result.foundation.present = true;
    result.foundation.compatible = true;

    stage = "ack";
    result.ack.present = true;
    await preflightAck(client);
    result.ack.compatible = true;

    stage = "t1-inspection";
    applyT1Inspection(result, await inspectT1(client));

    stage = "t1";
    await preflightT1(client);
    result.t1.incompatible_rows = false;
    result.t1.preflight_pass = true;
    result.preflight_pass = true;
    return result;
  } catch (error) {
    result.preflight_pass = false;
    result.t1.preflight_pass = false;
    result.reason_code = reasonCode(stage, error);
    if (result.reason_code === "FOUNDATION_MISSING" || result.reason_code === "FOUNDATION_INCOMPATIBLE") {
      result.foundation.compatible = false;
    }
    if (result.reason_code === "ACK_INCOMPATIBLE" || result.reason_code === "ACK_ROWS_INCOMPATIBLE") {
      result.ack.present = true;
      result.ack.compatible = false;
    }
    if (result.reason_code === "T1_ROWS_INCOMPATIBLE") {
      result.t1.incompatible_rows = true;
    }
    return result;
  } finally {
    if (client && originalQuery) client.query = originalQuery;
    if (transactionStarted) await rawQuery("ROLLBACK").catch(() => {});
    client?.release();
  }
}

export { READ_ONLY_GUARD_CODE };
