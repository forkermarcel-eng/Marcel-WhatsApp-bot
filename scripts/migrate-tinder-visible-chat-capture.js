import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getTinderVisibleChatCaptureMigrationFailureDiagnostic,
  migrateTinderVisibleChatCaptureSchema,
  T2_CAPTURE_MIGRATION_DIAGNOSTIC_STAGES
} from "../device-bridge/tinder-visible-chat-capture-migration.js";

/* ==================================================
T2 — EXPLICIT VISIBLE-CHAT CAPTURE TABLE CLI
================================================== */

const CLI_DIAGNOSTIC_STAGES = new Set([
  "CLI_ARGUMENT_VALIDATION",
  "ENVIRONMENT_VALIDATION",
  "COMMIT_CONFIRMED",
  ...T2_CAPTURE_MIGRATION_DIAGNOSTIC_STAGES
]);
const CLI_DIAGNOSTIC_CODES = new Set([
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

function boundedDiagnostic(value, fallback = {}) {
  return {
    stage: CLI_DIAGNOSTIC_STAGES.has(value?.stage) ? value.stage : fallback.stage || "UNKNOWN",
    code: CLI_DIAGNOSTIC_CODES.has(value?.code) ? value.code : fallback.code || "DATABASE_OPERATION_FAILED",
    transaction: CLI_TRANSACTION_STATES.has(value?.transaction) ? value.transaction : fallback.transaction || "UNRESOLVED",
    rollback: CLI_ROLLBACK_STATES.has(value?.rollback) ? value.rollback : fallback.rollback || "UNRESOLVED",
    ddl_started: typeof value?.ddl_started === "boolean" ? value.ddl_started : fallback.ddl_started ?? "UNRESOLVED"
  };
}

function loggerDiagnostic(logger, diagnostic) {
  const value = boundedDiagnostic(diagnostic);
  logger.error(
    `T2 visible-chat migration diagnostic: stage=${value.stage} code=${value.code} `
      + `transaction=${value.transaction} rollback=${value.rollback} ddl_started=${value.ddl_started}`
  );
}

export async function runTinderVisibleChatCaptureMigrationCli({
  argv = process.argv.slice(2),
  environment = process.env,
  createPool = async options => {
    const { default: pg } = await import("pg");
    return new pg.Pool(options);
  },
  migrate = migrateTinderVisibleChatCaptureSchema,
  logger = console
} = {}) {
  if (!argv.includes("--apply")) {
    logger.error("Refusing T2 visible-chat migration without --apply.");
    loggerDiagnostic(logger, {
      stage: "CLI_ARGUMENT_VALIDATION",
      code: "APPLY_REQUIRED",
      transaction: "NOT_STARTED",
      rollback: "NOT_ATTEMPTED",
      ddl_started: false
    });
    return false;
  }
  if (!environment.DATABASE_URL) {
    logger.error("T2 visible-chat migration requires DATABASE_URL.");
    loggerDiagnostic(logger, {
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
    diagnostic = getTinderVisibleChatCaptureMigrationFailureDiagnostic(error) || (migrationStarted
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
    logger.error("T2 visible-chat migration failed.");
    loggerDiagnostic(logger, diagnostic);
    return false;
  }
  logger.log(result.migrated
    ? "T2 visible-chat migration completed."
    : "T2 visible-chat capture schema already canonical.");
  logger.log(
    `T2 visible-chat migration diagnostic: stage=COMMIT_CONFIRMED code=${result.migrated ? "MIGRATION_APPLIED" : "ALREADY_CANONICAL"} `
      + `transaction=COMMITTED rollback=NOT_ATTEMPTED ddl_started=${result.migrated === true}`
  );
  return true;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const success = await runTinderVisibleChatCaptureMigrationCli();
  if (!success) process.exitCode = 1;
}
