import {
  assertDeviceBridgeAckDataCompatible,
  FINAL_ACK_CHECK_EXPRESSION,
  FINAL_ACK_CONSTRAINT_NAME,
  preflightDeviceBridgeAckSchemaForCanonicalization,
  preflightDeviceBridgeAckSchemaForT1
} from "./ack-schema.js";
import { preflightDeviceBridgeFoundationForT1 } from "./schema-readiness.js";

/* ==================================================
DEVICE BRIDGE — EXPLICIT ACK_PAYLOAD_V1 CANONICALIZATION
================================================== */

export const ACK_CANONICALIZATION_LOCK_TIMEOUT = "5s";
export const ACK_CANONICALIZATION_STATEMENT_TIMEOUT = "30s";
export const ACK_CANONICALIZATION_IDLE_TRANSACTION_TIMEOUT = "60s";
export const ACK_CANONICALIZATION_DIAGNOSTIC_STAGES = Object.freeze([
  "DATABASE_CONNECTION",
  "TRANSACTION_BEGIN",
  "TRANSACTION_SETTINGS",
  "ADVISORY_LOCK",
  "GLOBAL_PREFLIGHT",
  "ACK_TABLE_LOCK",
  "LOCKED_PREFLIGHT",
  "DDL_EXECUTION",
  "POSTCHECK",
  "COMMIT",
  "ROLLBACK",
  "CLEANUP",
  "UNKNOWN"
]);

const ADVISORY_LOCK_NAMESPACE = 7421;
const ADVISORY_LOCK_KEY = 1;
const DIAGNOSTIC_STAGE_SET = new Set(ACK_CANONICALIZATION_DIAGNOSTIC_STAGES);
const FAILURE_DIAGNOSTICS = new WeakMap();

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function boundedStage(value) {
  return DIAGNOSTIC_STAGE_SET.has(value) ? value : "UNKNOWN";
}

function boundedFailureCode(stage, error) {
  if (stage === "ADVISORY_LOCK" && error?.code === "ACK_CANONICALIZATION_ADVISORY_LOCK_UNAVAILABLE") {
    return "ADVISORY_LOCK_UNAVAILABLE";
  }
  if (stage === "ACK_TABLE_LOCK" && error?.code === "55P03") return "LOCK_TIMEOUT";
  if (stage === "COMMIT") return "COMMIT_OUTCOME_UNRESOLVED";
  if (stage === "CLEANUP") return "CLEANUP_FAILED";
  return "DATABASE_OPERATION_FAILED";
}

function attachFailureDiagnostic(error, {
  stage,
  transactionStarted,
  commitAttempted,
  commitConfirmed,
  rollbackAttempted,
  rollbackCompleted,
  ddlOperationsAttempted
}) {
  const diagnostic = Object.freeze({
    stage: boundedStage(stage),
    code: boundedFailureCode(stage, error),
    transaction: commitConfirmed
      ? "COMMITTED"
      : commitAttempted
        ? "COMMIT_OUTCOME_UNKNOWN"
        : transactionStarted
          ? "STARTED"
          : stage === "TRANSACTION_BEGIN"
            ? "UNRESOLVED"
            : "NOT_STARTED",
    rollback: rollbackAttempted
      ? rollbackCompleted ? "COMPLETED" : "FAILED"
      : "NOT_ATTEMPTED",
    ddl_started: ddlOperationsAttempted > 0
  });
  if (error && (typeof error === "object" || typeof error === "function")) {
    FAILURE_DIAGNOSTICS.set(error, diagnostic);
  }
  return error;
}

/** Returns only fixed, non-sensitive state for an explicit migration failure. */
export function getDeviceBridgeAckCanonicalizationFailureDiagnostic(error) {
  const diagnostic = error && typeof error === "object"
    ? FAILURE_DIAGNOSTICS.get(error)
    : null;
  return diagnostic ? { ...diagnostic } : null;
}

async function configureTransaction(client) {
  await client.query(`SET LOCAL lock_timeout = '${ACK_CANONICALIZATION_LOCK_TIMEOUT}'`);
  await client.query(`SET LOCAL statement_timeout = '${ACK_CANONICALIZATION_STATEMENT_TIMEOUT}'`);
  await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${ACK_CANONICALIZATION_IDLE_TRANSACTION_TIMEOUT}'`);
}

async function acquireAdvisoryLock(client) {
  const result = await client.query(
    `SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE}, ${ADVISORY_LOCK_KEY}) AS acquired`
  );
  if (result.rows[0]?.acquired !== true) {
    const error = new Error("Device Bridge schema migration is already running.");
    error.code = "ACK_CANONICALIZATION_ADVISORY_LOCK_UNAVAILABLE";
    throw error;
  }
}

async function preflightAckCanonicalization(client) {
  await preflightDeviceBridgeFoundationForT1(client);
  return preflightDeviceBridgeAckSchemaForCanonicalization(client);
}

async function lockAckTable(client) {
  await client.query("LOCK TABLE device_bridge_command_acks IN ACCESS EXCLUSIVE MODE");
}

async function applyAckPayloadCanonicalization(client, payload, markDdlAttempt = () => {}) {
  if (payload.state === "CANONICAL") return { migrated: false };
  if (payload.state !== "NONCANONICAL" || payload.constraintName !== FINAL_ACK_CONSTRAINT_NAME) {
    throw new Error("Device Bridge ACK schema compatibility check failed.");
  }
  markDdlAttempt();
  await client.query(
    `ALTER TABLE device_bridge_command_acks DROP CONSTRAINT ${quoteIdentifier(payload.constraintName)}`
  );
  markDdlAttempt();
  await client.query(`
    ALTER TABLE device_bridge_command_acks
    ADD CONSTRAINT ${FINAL_ACK_CONSTRAINT_NAME}
    CHECK (${FINAL_ACK_CHECK_EXPRESSION})
  `);
  return { migrated: true };
}

async function postcheckAckCanonicalization(client) {
  await preflightDeviceBridgeAckSchemaForT1(client);
  await preflightDeviceBridgeFoundationForT1(client);
  await assertDeviceBridgeAckDataCompatible(client);
}

/**
 * The only ACK_PAYLOAD_V1 mutation authority. It is explicit, un-routed, and
 * transaction-owned; startup and the protected diagnostics never import it.
 */
export async function migrateDeviceBridgeAckCanonicalization(pool) {
  let client;
  let transactionStarted = false;
  let commitAttempted = false;
  let commitConfirmed = false;
  let discardClient = false;
  let releaseError;
  let stage = "DATABASE_CONNECTION";
  let rollbackAttempted = false;
  let rollbackCompleted = false;
  let ddlOperationsAttempted = 0;

  try {
    client = await pool.connect();
    stage = "TRANSACTION_BEGIN";
    await client.query("BEGIN");
    transactionStarted = true;
    stage = "TRANSACTION_SETTINGS";
    await configureTransaction(client);
    stage = "ADVISORY_LOCK";
    await acquireAdvisoryLock(client);
    stage = "GLOBAL_PREFLIGHT";
    await preflightAckCanonicalization(client);
    stage = "ACK_TABLE_LOCK";
    await lockAckTable(client);
    stage = "LOCKED_PREFLIGHT";
    const lockedPreflight = await preflightAckCanonicalization(client);
    stage = "DDL_EXECUTION";
    const result = await applyAckPayloadCanonicalization(client, lockedPreflight.payload, () => {
      ddlOperationsAttempted += 1;
    });
    stage = "POSTCHECK";
    await postcheckAckCanonicalization(client);
    stage = "COMMIT";
    commitAttempted = true;
    await client.query("COMMIT");
    commitConfirmed = true;
    return result;
  } catch (error) {
    releaseError = error;
    const failedStage = stage;
    if (transactionStarted && !commitAttempted) {
      rollbackAttempted = true;
      try {
        await client.query("ROLLBACK");
        rollbackCompleted = true;
      } catch {
        discardClient = true;
      }
    } else {
      // After a failed BEGIN/COMMIT the outcome is not safely knowable. The
      // client is discarded and a later operator decision is required.
      discardClient = true;
    }
    throw attachFailureDiagnostic(error, {
      stage: failedStage,
      transactionStarted,
      commitAttempted,
      commitConfirmed,
      rollbackAttempted,
      rollbackCompleted,
      ddlOperationsAttempted
    });
  } finally {
    try {
      client?.release(discardClient ? releaseError : undefined);
    } catch (error) {
      throw attachFailureDiagnostic(error, {
        stage: "CLEANUP",
        transactionStarted,
        commitAttempted,
        commitConfirmed,
        rollbackAttempted,
        rollbackCompleted,
        ddlOperationsAttempted
      });
    }
  }
}
