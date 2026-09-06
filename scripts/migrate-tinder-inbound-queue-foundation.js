import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getTinderInboundQueueFoundationMigrationFailureDiagnostic,
  migrateTinderInboundQueueFoundation,
  T6_INBOUND_QUEUE_MIGRATION_DIAGNOSTIC_STAGES
} from "../device-bridge/tinder-inbound-queue-foundation-migration.js";

/* ==================================================
T6 — EXPLICIT INBOUND QUEUE FOUNDATION CLI

This command is deliberately unrouted and absent from application startup.
It can mutate a database only after an explicit --apply invocation.
================================================== */

const STAGES = new Set([
  "CLI_ARGUMENT_VALIDATION",
  "ENVIRONMENT_VALIDATION",
  "COMMIT_CONFIRMED",
  ...T6_INBOUND_QUEUE_MIGRATION_DIAGNOSTIC_STAGES
]);
const CODES = new Set([
  "APPLY_REQUIRED",
  "DATABASE_URL_REQUIRED",
  "DATABASE_CONNECTION_FAILED",
  "MIGRATION_SOURCE_INVALID",
  "MIGRATION_APPLIED",
  "ALREADY_CANONICAL",
  "ADVISORY_LOCK_UNAVAILABLE",
  "LOCK_TIMEOUT",
  "COMMIT_OUTCOME_UNRESOLVED",
  "CLEANUP_FAILED",
  "DATABASE_OPERATION_FAILED"
]);
const TRANSACTION_STATES = new Set([
  "NOT_STARTED",
  "STARTED",
  "COMMITTED",
  "COMMIT_OUTCOME_UNKNOWN",
  "UNRESOLVED"
]);
const ROLLBACK_STATES = new Set([
  "NOT_ATTEMPTED",
  "COMPLETED",
  "FAILED",
  "UNRESOLVED"
]);

function boundedDiagnostic(value, fallback = {}) {
  return {
    stage: STAGES.has(value?.stage) ? value.stage : fallback.stage || "UNKNOWN",
    code: CODES.has(value?.code) ? value.code : fallback.code || "DATABASE_OPERATION_FAILED",
    transaction: TRANSACTION_STATES.has(value?.transaction)
      ? value.transaction : fallback.transaction || "UNRESOLVED",
    rollback: ROLLBACK_STATES.has(value?.rollback)
      ? value.rollback : fallback.rollback || "UNRESOLVED",
    ddl_started: typeof value?.ddl_started === "boolean"
      ? value.ddl_started : fallback.ddl_started ?? "UNRESOLVED"
  };
}

function logDiagnostic(logger, diagnostic) {
  const value = boundedDiagnostic(diagnostic);
  logger.error(
    `T6 Tinder inbound queue migration diagnostic: stage=${value.stage} code=${value.code} `
      + `transaction=${value.transaction} rollback=${value.rollback} ddl_started=${value.ddl_started}`
  );
}

export async function runTinderInboundQueueFoundationMigrationCli({
  argv = process.argv.slice(2),
  environment = process.env,
  createPool = async options => {
    const { default: pg } = await import("pg");
    return new pg.Pool(options);
  },
  migrate = migrateTinderInboundQueueFoundation,
  logger = console
} = {}) {
  if (!argv.includes("--apply")) {
    logger.error("Refusing T6 Tinder inbound queue migration without --apply.");
    logDiagnostic(logger, {
      stage: "CLI_ARGUMENT_VALIDATION",
      code: "APPLY_REQUIRED",
      transaction: "NOT_STARTED",
      rollback: "NOT_ATTEMPTED",
      ddl_started: false
    });
    return false;
  }
  if (!environment.DATABASE_URL) {
    logger.error("T6 Tinder inbound queue migration requires DATABASE_URL.");
    logDiagnostic(logger, {
      stage: "ENVIRONMENT_VALIDATION",
      code: "DATABASE_URL_REQUIRED",
      transaction: "NOT_STARTED",
      rollback: "NOT_ATTEMPTED",
      ddl_started: false
    });
    return false;
  }

  let pool;
  let migrationStarted = false;
  let committed = false;
  let ddlStarted = "UNRESOLVED";
  let result;
  let diagnostic;
  try {
    pool = await createPool({ connectionString: environment.DATABASE_URL });
    migrationStarted = true;
    result = await migrate(pool);
    committed = true;
    ddlStarted = result?.migrated === true;
  } catch (error) {
    diagnostic = getTinderInboundQueueFoundationMigrationFailureDiagnostic(error) || (migrationStarted
      ? { stage: "UNKNOWN", code: "DATABASE_OPERATION_FAILED", transaction: "UNRESOLVED", rollback: "UNRESOLVED", ddl_started: "UNRESOLVED" }
      : { stage: "DATABASE_CONNECTION", code: "DATABASE_CONNECTION_FAILED", transaction: "NOT_STARTED", rollback: "NOT_ATTEMPTED", ddl_started: false });
  }
  try {
    await pool?.end();
  } catch {
    if (!diagnostic) {
      diagnostic = {
        stage: "CLEANUP",
        code: "CLEANUP_FAILED",
        transaction: committed ? "COMMITTED" : migrationStarted ? "UNRESOLVED" : "NOT_STARTED",
        rollback: "NOT_ATTEMPTED",
        ddl_started: ddlStarted
      };
    }
  }
  if (diagnostic) {
    logger.error("T6 Tinder inbound queue migration failed.");
    logDiagnostic(logger, diagnostic);
    return false;
  }
  logger.log(result.migrated
    ? "T6 Tinder inbound queue migration completed."
    : "T6 Tinder inbound queue foundation already canonical.");
  logger.log(
    `T6 Tinder inbound queue migration diagnostic: stage=COMMIT_CONFIRMED code=${result.migrated ? "MIGRATION_APPLIED" : "ALREADY_CANONICAL"} `
      + `transaction=COMMITTED rollback=NOT_ATTEMPTED ddl_started=${result.migrated === true}`
  );
  return true;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const success = await runTinderInboundQueueFoundationMigrationCli();
  if (!success) process.exitCode = 1;
}
