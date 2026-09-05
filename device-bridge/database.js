import { preflightDeviceBridgeAckSchemaForT1Migration } from "./ack-schema.js";
import {
  postcheckDeviceBridgeT1SchemaMigration,
  preflightDeviceBridgeT1SchemaMigration
} from "./t1-schema.js";
import { preflightDeviceBridgeFoundationForT1, REQUIRED_TABLES } from "./schema-readiness.js";

export const T1_MIGRATION_LOCK_TIMEOUT = "5s";
export const T1_MIGRATION_STATEMENT_TIMEOUT = "30s";
export const T1_MIGRATION_IDLE_TRANSACTION_TIMEOUT = "60s";
export const T1_MIGRATION_DIAGNOSTIC_STAGES = Object.freeze([
  "DATABASE_CONNECTION",
  "TRANSACTION_BEGIN",
  "TRANSACTION_SETTINGS",
  "ADVISORY_LOCK",
  "GLOBAL_PREFLIGHT",
  "TABLE_LOCK_ACQUISITION",
  "LOCKED_PREFLIGHT",
  "DDL_EXECUTION",
  "POSTCHECK",
  "COMMIT",
  "ROLLBACK",
  "CLEANUP",
  "UNKNOWN"
]);
const T1_MIGRATION_ADVISORY_LOCK_NAMESPACE = 7421;
const T1_MIGRATION_ADVISORY_LOCK_KEY = 1;
const T1_MIGRATION_DIAGNOSTIC_STAGE_SET = new Set(T1_MIGRATION_DIAGNOSTIC_STAGES);
const T1_MIGRATION_FAILURE_DIAGNOSTICS = new WeakMap();

function boundedStage(value) {
  return T1_MIGRATION_DIAGNOSTIC_STAGE_SET.has(value) ? value : "UNKNOWN";
}

function boundedFailureCode(stage, error) {
  if (stage === "ADVISORY_LOCK" && error?.code === "T1_ADVISORY_LOCK_UNAVAILABLE") {
    return "ADVISORY_LOCK_UNAVAILABLE";
  }
  if (stage === "TABLE_LOCK_ACQUISITION" && error?.code === "55P03") {
    return "LOCK_TIMEOUT";
  }
  if (stage === "COMMIT") return "COMMIT_OUTCOME_UNRESOLVED";
  if (stage === "CLEANUP") return "CLEANUP_FAILED";
  return "DATABASE_OPERATION_FAILED";
}

function attachMigrationFailureDiagnostic(error, {
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
      ? rollbackCompleted
        ? "COMPLETED"
        : "FAILED"
      : "NOT_ATTEMPTED",
    ddl_started: ddlOperationsAttempted > 0
  });
  if (error && (typeof error === "object" || typeof error === "function")) {
    T1_MIGRATION_FAILURE_DIAGNOSTICS.set(error, diagnostic);
  }
  return error;
}

/** Returns only the fixed, non-sensitive diagnostic attached to a runner failure. */
export function getDeviceBridgeT1MigrationFailureDiagnostic(error) {
  const diagnostic = error && typeof error === "object"
    ? T1_MIGRATION_FAILURE_DIAGNOSTICS.get(error)
    : null;
  return diagnostic ? { ...diagnostic } : null;
}

/* ==================================================
DEVICE BRIDGE T1 — EXPLICIT T1-ONLY MIGRATION
================================================== */

async function preflightDeviceBridgeT1Release(client) {
  await preflightDeviceBridgeFoundationForT1(client);
  await preflightDeviceBridgeAckSchemaForT1Migration(client);
  const t1 = await preflightDeviceBridgeT1SchemaMigration(client);
  return { t1 };
}

async function postcheckDeviceBridgeT1Release(client) {
  await preflightDeviceBridgeFoundationForT1(client);
  await preflightDeviceBridgeAckSchemaForT1Migration(client);
  await postcheckDeviceBridgeT1SchemaMigration(client);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

/**
 * Locks every verified foundation relation after the first read-only pass,
 * then the same full preflight is repeated under those locks. Locks are not
 * DDL; they eliminate a schema TOCTOU window before the two allowed ALTERs.
 */
async function lockVerifiedDeviceBridgeFoundation(client) {
  for (const table of REQUIRED_TABLES) {
    await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
  }
}

async function runDeviceBridgeT1PreDdlPath(client, setStage = () => {}) {
  setStage("TRANSACTION_SETTINGS");
  await configureT1MigrationTransaction(client);
  setStage("ADVISORY_LOCK");
  await acquireT1MigrationAdvisoryLock(client);
  setStage("GLOBAL_PREFLIGHT");
  await preflightDeviceBridgeT1Release(client);
  setStage("TABLE_LOCK_ACQUISITION");
  await lockVerifiedDeviceBridgeFoundation(client);
  setStage("LOCKED_PREFLIGHT");
  return preflightDeviceBridgeT1Release(client);
}

/**
 * These settings are transaction-local, so the explicit migration cannot
 * alter shared Railway/PostgreSQL defaults. The advisory lock rejects a
 * concurrent runner instead of waiting ambiguously or retrying automatically.
 */
async function configureT1MigrationTransaction(client) {
  await client.query(`SET LOCAL lock_timeout = '${T1_MIGRATION_LOCK_TIMEOUT}'`);
  await client.query(`SET LOCAL statement_timeout = '${T1_MIGRATION_STATEMENT_TIMEOUT}'`);
  await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${T1_MIGRATION_IDLE_TRANSACTION_TIMEOUT}'`);
}

async function acquireT1MigrationAdvisoryLock(client) {
  const advisory = await client.query(
    `SELECT pg_try_advisory_xact_lock(${T1_MIGRATION_ADVISORY_LOCK_NAMESPACE}, ${T1_MIGRATION_ADVISORY_LOCK_KEY}) AS acquired`
  );
  if (advisory.rows[0]?.acquired !== true) {
    const error = new Error("Device Bridge T1 migration is already running.");
    error.code = "T1_ADVISORY_LOCK_UNAVAILABLE";
    throw error;
  }
}

/**
 * The only mutating statements reachable from the explicit T1 runner:
 * - device_bridge_devices: legacy tinder_state CHECK -> _v1 (CONNECTING)
 * - device_bridge_commands: legacy command_type CHECK -> _v1 (CONNECT/DISCONNECT)
 * Both require ACCESS EXCLUSIVE because PostgreSQL replaces a table CHECK.
 */
async function applyVerifiedT1SchemaPlan(client, preflight, markDdlAttempt = () => {}) {
  for (const step of preflight.steps) {
    if (!step.mutate) continue;
    markDdlAttempt();
    await client.query(
      `ALTER TABLE ${step.specification.table} DROP CONSTRAINT ${quoteIdentifier(step.constraintName)}`
    );
    markDdlAttempt();
    await client.query(`
      ALTER TABLE ${step.specification.table}
      ADD CONSTRAINT ${step.specification.name}
      CHECK (${step.specification.expression})
    `);
  }
  return { migrated: preflight.steps.some(step => step.mutate) };
}

/**
 * Runs the exact T1 runner path through its second locked preflight, then
 * always rolls back before any T1 DDL. It is intentionally un-routed and is
 * only for explicitly configured local integration validation.
 */
export async function validateDeviceBridgeT1PreDdl(pool) {
  let client;
  let transactionStarted = false;
  let discardClient = false;
  let releaseError;
  let stage = "DATABASE_CONNECTION";
  let rollbackAttempted = false;
  let rollbackCompleted = false;
  try {
    stage = "DATABASE_CONNECTION";
    client = await pool.connect();
    stage = "TRANSACTION_BEGIN";
    await client.query("BEGIN");
    transactionStarted = true;
    await runDeviceBridgeT1PreDdlPath(client, nextStage => {
      stage = nextStage;
    });
    stage = "ROLLBACK";
    rollbackAttempted = true;
    await client.query("ROLLBACK");
    rollbackCompleted = true;
    return { validated: true };
  } catch (error) {
    releaseError = error;
    const failedStage = stage;
    if (transactionStarted && !rollbackAttempted) {
      rollbackAttempted = true;
      try {
        await client.query("ROLLBACK");
        rollbackCompleted = true;
      } catch {
        discardClient = true;
      }
    } else {
      discardClient = true;
    }
    throw attachMigrationFailureDiagnostic(error, {
      stage: failedStage,
      transactionStarted,
      commitAttempted: false,
      commitConfirmed: false,
      rollbackAttempted,
      rollbackCompleted,
      ddlOperationsAttempted: 0
    });
  } finally {
    try {
      client?.release(discardClient ? releaseError : undefined);
    } catch (error) {
      throw attachMigrationFailureDiagnostic(error, {
        stage: "CLEANUP",
        transactionStarted,
        commitAttempted: false,
        commitConfirmed: false,
        rollbackAttempted,
        rollbackCompleted,
        ddlOperationsAttempted: 0
      });
    }
  }
}

/**
 * The explicit CLI target. It never bootstraps or repairs the Device Bridge
 * foundation or ACK schema. Before the first ALTER it performs a complete
 * read-only preflight, locks the already-verified foundation, then repeats
 * the same read-only preflight under those locks before the two T1 checks.
 */
export async function migrateDeviceBridgeSchema(pool) {
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
    stage = "DATABASE_CONNECTION";
    client = await pool.connect();
    stage = "TRANSACTION_BEGIN";
    await client.query("BEGIN");
    transactionStarted = true;
    const lockedPreflight = await runDeviceBridgeT1PreDdlPath(client, nextStage => {
      stage = nextStage;
    });
    stage = "DDL_EXECUTION";
    const result = await applyVerifiedT1SchemaPlan(client, lockedPreflight.t1, () => {
      ddlOperationsAttempted += 1;
    });
    stage = "POSTCHECK";
    await postcheckDeviceBridgeT1Release(client);
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
      // A failed BEGIN/COMMIT has an unknown connection/transaction outcome;
      // discard the client and require a separate operator decision, never a
      // blind retry in this invocation.
      discardClient = true;
    }
    throw attachMigrationFailureDiagnostic(error, {
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
      throw attachMigrationFailureDiagnostic(error, {
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
