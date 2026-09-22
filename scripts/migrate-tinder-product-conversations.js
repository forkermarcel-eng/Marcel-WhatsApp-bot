import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getTinderProductConversationMigrationFailureDiagnostic,
  migrateTinderProductConversation
} from "../device-bridge/tinder-product-conversation-migration.js";

/* Explicit DDL CLI. It refuses to apply unless --apply is present. */

const DIAGNOSTIC_STAGES = new Set([
  "CLI_ARGUMENT_VALIDATION",
  "ENVIRONMENT_VALIDATION",
  "DATABASE_CONNECTION",
  "RESULT_VALIDATION",
  ...[
    "MIGRATION_SOURCE_VALIDATION",
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
  ]
]);
const DIAGNOSTIC_CODES = new Set([
  "APPLY_REQUIRED",
  "DATABASE_URL_REQUIRED",
  "DATABASE_CONNECTION_FAILED",
  "COMMIT_CONTRACT_INVALID",
  "DATABASE_OPERATION_FAILED",
  "MIGRATION_SOURCE_INVALID",
  "ADVISORY_LOCK_UNAVAILABLE",
  "LOCK_TIMEOUT",
  "COMMIT_OUTCOME_UNRESOLVED",
  "CLEANUP_FAILED"
]);
const TRANSACTION_STATES = new Set([
  "NOT_STARTED", "UNRESOLVED", "STARTED", "COMMITTED", "COMMIT_OUTCOME_UNKNOWN"
]);
const ROLLBACK_STATES = new Set(["NOT_ATTEMPTED", "UNRESOLVED", "COMPLETED", "FAILED"]);
const PRODUCT_CONVERSATION_REASON_CODES = new Set([
  "TINDER_PRODUCT_CONVERSATION_POSTCHECK_SCHEMA_INVALID"
]);

function boundedDiagnostic(diagnostic = {}) {
  const stage = DIAGNOSTIC_STAGES.has(diagnostic.stage) ? diagnostic.stage : "UNKNOWN";
  const code = DIAGNOSTIC_CODES.has(diagnostic.code) ? diagnostic.code : "DATABASE_OPERATION_FAILED";
  const transaction = TRANSACTION_STATES.has(diagnostic.transaction)
    ? diagnostic.transaction : "UNRESOLVED";
  const rollback = ROLLBACK_STATES.has(diagnostic.rollback)
    ? diagnostic.rollback : "UNRESOLVED";
  const ddlStarted = typeof diagnostic.ddl_started === "boolean"
    ? diagnostic.ddl_started : "UNRESOLVED";
  return Object.freeze({
    stage,
    code,
    transaction,
    rollback,
    ddl_started: ddlStarted,
    ...(PRODUCT_CONVERSATION_REASON_CODES.has(diagnostic.reason)
      ? { reason: diagnostic.reason } : {})
  });
}

function isCommitConfirmed(result) {
  return result?.commitConfirmed === true && typeof result?.migrated === "boolean";
}

function logDiagnostic(logger, diagnostic) {
  const bounded = boundedDiagnostic(diagnostic);
  logger.error(
    `Tinder product conversation migration diagnostic: stage=${bounded.stage}`
      + ` code=${bounded.code} transaction=${bounded.transaction}`
      + ` rollback=${bounded.rollback} ddl_started=${bounded.ddl_started}`
      + (bounded.reason ? ` reason=${bounded.reason}` : "")
  );
}

export async function runTinderProductConversationMigrationCli({
  argv = process.argv.slice(2),
  environment = process.env,
  createPool = async options => { const { default: pg } = await import("pg"); return new pg.Pool(options); },
  migrate = migrateTinderProductConversation,
  getFailureDiagnostic = getTinderProductConversationMigrationFailureDiagnostic,
  logger = console
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 1 || argv[0] !== "--apply") {
    logger.error("Refusing Tinder product conversation migration without --apply.");
    logDiagnostic(logger, { stage: "CLI_ARGUMENT_VALIDATION", code: "APPLY_REQUIRED", transaction: "NOT_STARTED", rollback: "NOT_ATTEMPTED", ddl_started: false });
    return false;
  }
  if (!environment.DATABASE_URL) {
    logger.error("Tinder product conversation migration requires DATABASE_URL.");
    logDiagnostic(logger, { stage: "ENVIRONMENT_VALIDATION", code: "DATABASE_URL_REQUIRED", transaction: "NOT_STARTED", rollback: "NOT_ATTEMPTED", ddl_started: false });
    return false;
  }

  let pool;
  let started = false;
  let result;
  let diagnostic;
  try {
    pool = await createPool({ connectionString: environment.DATABASE_URL });
    started = true;
    result = await migrate(pool);
    if (!isCommitConfirmed(result)) {
      diagnostic = {
        stage: "RESULT_VALIDATION",
        code: "COMMIT_CONTRACT_INVALID",
        transaction: "COMMIT_OUTCOME_UNKNOWN",
        rollback: "UNRESOLVED",
        ddl_started: "UNRESOLVED"
      };
    }
  } catch (error) {
    diagnostic = getFailureDiagnostic(error) || (started
      ? { stage: "UNKNOWN", code: "DATABASE_OPERATION_FAILED", transaction: "UNRESOLVED", rollback: "UNRESOLVED", ddl_started: "UNRESOLVED" }
      : { stage: "DATABASE_CONNECTION", code: "DATABASE_CONNECTION_FAILED", transaction: "NOT_STARTED", rollback: "NOT_ATTEMPTED", ddl_started: false });
  }
  try {
    await pool?.end();
  } catch {
    diagnostic ||= { stage: "CLEANUP", code: "CLEANUP_FAILED", transaction: result ? "COMMITTED" : "UNRESOLVED", rollback: "NOT_ATTEMPTED", ddl_started: result?.migrated === true };
  }
  if (diagnostic) {
    logger.error("Tinder product conversation migration failed.");
    logDiagnostic(logger, diagnostic);
    return false;
  }
  logger.log(`Tinder product conversation migration: COMMIT_CONFIRMED migrated=${result.migrated}`);
  return true;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const success = await runTinderProductConversationMigrationCli();
  if (!success) process.exitCode = 1;
}
