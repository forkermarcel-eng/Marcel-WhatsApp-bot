import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getTinderVisibleChatSyncPermitMigrationFailureDiagnostic,
  migrateTinderVisibleChatSyncPermitFoundation,
  TINDER_VISIBLE_CHAT_SYNC_PERMIT_MIGRATION_DIAGNOSTIC_REASONS,
  TINDER_VISIBLE_CHAT_SYNC_PERMIT_MIGRATION_DIAGNOSTIC_STAGES
} from "../device-bridge/tinder-visible-chat-sync-permit-migration.js";

/* Explicit DDL CLI. It is inert without --apply and never runs at startup. */

const STAGES = new Set(["CLI_ARGUMENT_VALIDATION", "ENVIRONMENT_VALIDATION", "COMMIT_CONFIRMED",
  ...TINDER_VISIBLE_CHAT_SYNC_PERMIT_MIGRATION_DIAGNOSTIC_STAGES]);
const CODES = new Set(["APPLY_REQUIRED", "DATABASE_URL_REQUIRED", "DATABASE_CONNECTION_FAILED",
  "MIGRATION_SOURCE_INVALID", "MIGRATION_APPLIED", "ALREADY_CANONICAL", "ADVISORY_LOCK_UNAVAILABLE",
  "LOCK_TIMEOUT", "COMMIT_OUTCOME_UNRESOLVED", "CLEANUP_FAILED", "DATABASE_OPERATION_FAILED"]);
const REASONS = new Set(TINDER_VISIBLE_CHAT_SYNC_PERMIT_MIGRATION_DIAGNOSTIC_REASONS);
const TRANSACTIONS = new Set(["NOT_STARTED", "STARTED", "COMMITTED", "COMMIT_OUTCOME_UNKNOWN", "UNRESOLVED"]);
const ROLLBACKS = new Set(["NOT_ATTEMPTED", "COMPLETED", "FAILED", "UNRESOLVED"]);

function boundedDiagnostic(value, fallback = {}) {
  return {
    stage: STAGES.has(value?.stage) ? value.stage : fallback.stage || "UNKNOWN",
    code: CODES.has(value?.code) ? value.code : fallback.code || "DATABASE_OPERATION_FAILED",
    transaction: TRANSACTIONS.has(value?.transaction) ? value.transaction : fallback.transaction || "UNRESOLVED",
    rollback: ROLLBACKS.has(value?.rollback) ? value.rollback : fallback.rollback || "UNRESOLVED",
    ddl_started: typeof value?.ddl_started === "boolean" ? value.ddl_started : fallback.ddl_started ?? "UNRESOLVED",
    ...(REASONS.has(value?.reason) ? { reason: value.reason } : {})
  };
}

function logDiagnostic(logger, diagnostic) {
  const value = boundedDiagnostic(diagnostic);
  logger.error(
    `Tinder visible-chat sync migration diagnostic: stage=${value.stage} code=${value.code} `
      + `transaction=${value.transaction} rollback=${value.rollback} ddl_started=${value.ddl_started}`
      + (value.reason ? ` reason=${value.reason}` : "")
  );
}

export async function runTinderVisibleChatSyncMigrationCli({
  argv = process.argv.slice(2),
  environment = process.env,
  createPool = async options => {
    const { default: pg } = await import("pg");
    return new pg.Pool(options);
  },
  migrate = migrateTinderVisibleChatSyncPermitFoundation,
  getFailureDiagnostic = getTinderVisibleChatSyncPermitMigrationFailureDiagnostic,
  logger = console
} = {}) {
  if (!argv.includes("--apply")) {
    logger.error("Refusing Tinder visible-chat sync migration without --apply.");
    logDiagnostic(logger, { stage: "CLI_ARGUMENT_VALIDATION", code: "APPLY_REQUIRED", transaction: "NOT_STARTED", rollback: "NOT_ATTEMPTED", ddl_started: false });
    return false;
  }
  if (!environment.DATABASE_URL) {
    logger.error("Tinder visible-chat sync migration requires DATABASE_URL.");
    logDiagnostic(logger, { stage: "ENVIRONMENT_VALIDATION", code: "DATABASE_URL_REQUIRED", transaction: "NOT_STARTED", rollback: "NOT_ATTEMPTED", ddl_started: false });
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
    diagnostic = getFailureDiagnostic(error) || (migrationStarted
      ? { stage: "UNKNOWN", code: "DATABASE_OPERATION_FAILED", transaction: "UNRESOLVED", rollback: "UNRESOLVED", ddl_started: "UNRESOLVED" }
      : { stage: "DATABASE_CONNECTION", code: "DATABASE_CONNECTION_FAILED", transaction: "NOT_STARTED", rollback: "NOT_ATTEMPTED", ddl_started: false });
  }
  try {
    await pool?.end();
  } catch {
    if (!diagnostic) diagnostic = {
      stage: "CLEANUP", code: "CLEANUP_FAILED",
      transaction: committed ? "COMMITTED" : migrationStarted ? "UNRESOLVED" : "NOT_STARTED",
      rollback: "NOT_ATTEMPTED", ddl_started: ddlStarted
    };
  }
  if (diagnostic) {
    logger.error("Tinder visible-chat sync migration failed.");
    logDiagnostic(logger, diagnostic);
    return false;
  }
  logger.log(result.migrated
    ? "Tinder visible-chat sync migration completed."
    : "Tinder visible-chat sync foundation already canonical.");
  logger.log(
    `Tinder visible-chat sync migration diagnostic: stage=COMMIT_CONFIRMED `
      + `code=${result.migrated ? "MIGRATION_APPLIED" : "ALREADY_CANONICAL"} `
      + `transaction=COMMITTED rollback=NOT_ATTEMPTED ddl_started=${result.migrated === true}`
  );
  return true;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const success = await runTinderVisibleChatSyncMigrationCli();
  if (!success) process.exitCode = 1;
}
