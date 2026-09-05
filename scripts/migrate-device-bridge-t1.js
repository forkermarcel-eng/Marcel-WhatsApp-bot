import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDeviceBridgeT1MigrationFailureDiagnostic,
  migrateDeviceBridgeSchema,
  T1_MIGRATION_DIAGNOSTIC_STAGES
} from "../device-bridge/database.js";

/* ==================================================
DEVICE BRIDGE T1 — EXPLICIT OPERATOR MIGRATION CLI
================================================== */

const CLI_DIAGNOSTIC_STAGES = new Set([
  "CLI_ARGUMENT_VALIDATION",
  "ENVIRONMENT_VALIDATION",
  "COMMIT_CONFIRMED",
  ...T1_MIGRATION_DIAGNOSTIC_STAGES
]);
const CLI_DIAGNOSTIC_CODES = new Set([
  "APPLY_REQUIRED",
  "DATABASE_URL_REQUIRED",
  "DATABASE_CONNECTION_FAILED",
  "MIGRATION_APPLIED",
  "ALREADY_COMPATIBLE",
  "ADVISORY_LOCK_UNAVAILABLE",
  "LOCK_TIMEOUT",
  "COMMIT_OUTCOME_UNRESOLVED",
  "CLEANUP_FAILED",
  "DATABASE_OPERATION_FAILED"
]);
const CLI_TRANSACTION_STATES = new Set([
  "NOT_STARTED",
  "STARTED",
  "COMMITTED",
  "COMMIT_OUTCOME_UNKNOWN",
  "UNRESOLVED"
]);
const CLI_ROLLBACK_STATES = new Set([
  "NOT_ATTEMPTED",
  "COMPLETED",
  "FAILED",
  "UNRESOLVED"
]);

function boundedCliDiagnostic(value, fallback = {}) {
  const stage = CLI_DIAGNOSTIC_STAGES.has(value?.stage)
    ? value.stage
    : fallback.stage || "UNKNOWN";
  const code = CLI_DIAGNOSTIC_CODES.has(value?.code)
    ? value.code
    : fallback.code || "DATABASE_OPERATION_FAILED";
  const transaction = CLI_TRANSACTION_STATES.has(value?.transaction)
    ? value.transaction
    : fallback.transaction || "UNRESOLVED";
  const rollback = CLI_ROLLBACK_STATES.has(value?.rollback)
    ? value.rollback
    : fallback.rollback || "UNRESOLVED";
  const ddlStarted = typeof value?.ddl_started === "boolean"
    ? value.ddl_started
    : fallback.ddl_started ?? "UNRESOLVED";
  return { stage, code, transaction, rollback, ddl_started: ddlStarted };
}

function logBoundedDiagnostic(logger, diagnostic) {
  const value = boundedCliDiagnostic(diagnostic);
  logger.error(
    `Device Bridge T1 migration diagnostic: stage=${value.stage} code=${value.code} `
      + `transaction=${value.transaction} rollback=${value.rollback} ddl_started=${value.ddl_started}`
  );
}

function logSuccessDiagnostic(logger, migrated) {
  logger.log(
    `Device Bridge T1 migration diagnostic: stage=COMMIT_CONFIRMED `
      + `code=${migrated ? "MIGRATION_APPLIED" : "ALREADY_COMPATIBLE"} `
      + `transaction=COMMITTED rollback=NOT_ATTEMPTED ddl_started=${migrated}`
  );
}

export async function runDeviceBridgeT1MigrationCli({
  argv = process.argv.slice(2),
  environment = process.env,
  createPool = async options => {
    const { default: pg } = await import("pg");
    return new pg.Pool(options);
  },
  migrate = migrateDeviceBridgeSchema,
  logger = console
} = {}) {
  if (!argv.includes("--apply")) {
    logger.error("Refusing Device Bridge T1 schema migration without --apply.");
    logBoundedDiagnostic(logger, {
      stage: "CLI_ARGUMENT_VALIDATION",
      code: "APPLY_REQUIRED",
      transaction: "NOT_STARTED",
      rollback: "NOT_ATTEMPTED",
      ddl_started: false
    });
    return false;
  }
  if (!environment.DATABASE_URL) {
    logger.error("Device Bridge T1 schema migration requires DATABASE_URL.");
    logBoundedDiagnostic(logger, {
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
  let migrationCommitted = false;
  let migrationDdlStarted = "UNRESOLVED";
  let migrationResult;
  let failureDiagnostic;
  try {
    pool = await createPool({ connectionString: environment.DATABASE_URL });
    migrationStarted = true;
    const result = await migrate(pool);
    migrationCommitted = true;
    migrationDdlStarted = result.migrated === true;
    migrationResult = result;
  } catch (error) {
    const fallbackDiagnostic = migrationStarted
      ? {
          stage: "UNKNOWN",
          code: "DATABASE_OPERATION_FAILED",
          transaction: "UNRESOLVED",
          rollback: "UNRESOLVED",
          ddl_started: "UNRESOLVED"
        }
      : {
          stage: "DATABASE_CONNECTION",
          code: "DATABASE_CONNECTION_FAILED",
          transaction: "NOT_STARTED",
          rollback: "NOT_ATTEMPTED",
          ddl_started: false
        };
    failureDiagnostic = getDeviceBridgeT1MigrationFailureDiagnostic(error) || fallbackDiagnostic;
  }
  try {
    await pool?.end();
  } catch {
    if (!failureDiagnostic) {
      failureDiagnostic = {
        stage: "CLEANUP",
        code: "CLEANUP_FAILED",
        transaction: migrationCommitted ? "COMMITTED" : migrationStarted ? "UNRESOLVED" : "NOT_STARTED",
        rollback: "NOT_ATTEMPTED",
        ddl_started: migrationDdlStarted
      };
    }
  }
  if (failureDiagnostic) {
    logger.error("Device Bridge T1 schema migration failed.");
    logBoundedDiagnostic(logger, failureDiagnostic);
    return false;
  }
  logger.log(migrationResult.migrated
    ? "Device Bridge T1 schema migration completed."
    : "Device Bridge T1 schema already compatible.");
  logSuccessDiagnostic(logger, migrationResult.migrated === true);
  return true;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const success = await runDeviceBridgeT1MigrationCli();
  if (!success) process.exitCode = 1;
}
