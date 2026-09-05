import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDeviceBridgeAckCanonicalizationFailureDiagnostic,
  migrateDeviceBridgeAckCanonicalization
} from "../device-bridge/ack-canonicalization.js";

/* ==================================================
DEVICE BRIDGE — EXPLICIT ACK_PAYLOAD_V1 CLI
================================================== */

function boundedDiagnostic(value, fallback = {}) {
  const stages = new Set([
    "CLI_ARGUMENT_VALIDATION",
    "ENVIRONMENT_VALIDATION",
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
  const codes = new Set([
    "APPLY_REQUIRED",
    "DATABASE_URL_REQUIRED",
    "DATABASE_CONNECTION_FAILED",
    "ADVISORY_LOCK_UNAVAILABLE",
    "LOCK_TIMEOUT",
    "COMMIT_OUTCOME_UNRESOLVED",
    "CLEANUP_FAILED",
    "DATABASE_OPERATION_FAILED"
  ]);
  const transactions = new Set(["NOT_STARTED", "STARTED", "COMMITTED", "COMMIT_OUTCOME_UNKNOWN", "UNRESOLVED"]);
  const rollbacks = new Set(["NOT_ATTEMPTED", "COMPLETED", "FAILED", "UNRESOLVED"]);
  return {
    stage: stages.has(value?.stage) ? value.stage : fallback.stage || "UNKNOWN",
    code: codes.has(value?.code) ? value.code : fallback.code || "DATABASE_OPERATION_FAILED",
    transaction: transactions.has(value?.transaction) ? value.transaction : fallback.transaction || "UNRESOLVED",
    rollback: rollbacks.has(value?.rollback) ? value.rollback : fallback.rollback || "UNRESOLVED",
    ddl_started: typeof value?.ddl_started === "boolean" ? value.ddl_started : fallback.ddl_started ?? "UNRESOLVED"
  };
}

function logBoundedDiagnostic(logger, diagnostic) {
  const value = boundedDiagnostic(diagnostic);
  logger.error(
    `Device Bridge ACK canonicalization diagnostic: stage=${value.stage} code=${value.code} `
      + `transaction=${value.transaction} rollback=${value.rollback} ddl_started=${value.ddl_started}`
  );
}

export async function runDeviceBridgeAckCanonicalizationCli({
  argv = process.argv.slice(2),
  environment = process.env,
  createPool = async options => {
    const { default: pg } = await import("pg");
    return new pg.Pool(options);
  },
  migrate = migrateDeviceBridgeAckCanonicalization,
  logger = console
} = {}) {
  if (!argv.includes("--apply")) {
    logger.error("Refusing Device Bridge ACK canonicalization without --apply.");
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
    logger.error("Device Bridge ACK canonicalization requires DATABASE_URL.");
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
  let result;
  let failureDiagnostic;
  try {
    pool = await createPool({ connectionString: environment.DATABASE_URL });
    migrationStarted = true;
    result = await migrate(pool);
    migrationCommitted = true;
    migrationDdlStarted = result?.migrated === true;
  } catch (error) {
    failureDiagnostic = getDeviceBridgeAckCanonicalizationFailureDiagnostic(error) || (migrationStarted
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
        });
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
    logger.error("Device Bridge ACK canonicalization failed.");
    logBoundedDiagnostic(logger, failureDiagnostic);
    return false;
  }
  logger.log(result.migrated
    ? "Device Bridge ACK canonicalization completed."
    : "Device Bridge ACK schema already canonical.");
  logger.log(
    `Device Bridge ACK canonicalization diagnostic: stage=COMMIT code=${result.migrated ? "MIGRATION_APPLIED" : "ALREADY_CANONICAL"} `
      + `transaction=COMMITTED rollback=NOT_ATTEMPTED ddl_started=${result.migrated === true}`
  );
  return true;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const success = await runDeviceBridgeAckCanonicalizationCli();
  if (!success) process.exitCode = 1;
}
