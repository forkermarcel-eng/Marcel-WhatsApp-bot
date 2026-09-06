import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTACT_CONVERSATION_BINDING_MIGRATION_DIAGNOSTIC_STAGES,
  getContactConversationBindingFoundationMigrationFailureDiagnostic,
  migrateContactConversationBindingFoundation
} from "../device-bridge/contact-conversation-binding-foundation-migration.js";

/* Explicit-only CLI. It is absent from normal startup and deployment hooks. */

const STAGES = new Set([
  "CLI_ARGUMENT_VALIDATION",
  "ENVIRONMENT_VALIDATION",
  "COMMIT_CONFIRMED",
  ...CONTACT_CONVERSATION_BINDING_MIGRATION_DIAGNOSTIC_STAGES
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
const TRANSACTIONS = new Set(["NOT_STARTED", "STARTED", "COMMITTED", "COMMIT_OUTCOME_UNKNOWN", "UNRESOLVED"]);
const ROLLBACKS = new Set(["NOT_ATTEMPTED", "COMPLETED", "FAILED", "UNRESOLVED"]);

function boundedDiagnostic(value, fallback = {}) {
  return {
    stage: STAGES.has(value?.stage) ? value.stage : fallback.stage || "UNKNOWN",
    code: CODES.has(value?.code) ? value.code : fallback.code || "DATABASE_OPERATION_FAILED",
    transaction: TRANSACTIONS.has(value?.transaction)
      ? value.transaction : fallback.transaction || "UNRESOLVED",
    rollback: ROLLBACKS.has(value?.rollback)
      ? value.rollback : fallback.rollback || "UNRESOLVED",
    ddl_started: typeof value?.ddl_started === "boolean"
      ? value.ddl_started : fallback.ddl_started ?? "UNRESOLVED"
  };
}

function logDiagnostic(logger, diagnostic) {
  const value = boundedDiagnostic(diagnostic);
  logger.error(
    `Conversation binding migration diagnostic: stage=${value.stage} code=${value.code} `
      + `transaction=${value.transaction} rollback=${value.rollback} ddl_started=${value.ddl_started}`
  );
}

export async function runContactConversationBindingFoundationMigrationCli({
  argv = process.argv.slice(2),
  environment = process.env,
  createPool = async options => {
    const { default: pg } = await import("pg");
    return new pg.Pool(options);
  },
  migrate = migrateContactConversationBindingFoundation,
  getFailureDiagnostic = getContactConversationBindingFoundationMigrationFailureDiagnostic,
  logger = console
} = {}) {
  if (!argv.includes("--apply")) {
    logger.error("Refusing conversation binding migration without --apply.");
    logDiagnostic(logger, {
      stage: "CLI_ARGUMENT_VALIDATION", code: "APPLY_REQUIRED",
      transaction: "NOT_STARTED", rollback: "NOT_ATTEMPTED", ddl_started: false
    });
    return false;
  }
  if (!environment.DATABASE_URL) {
    logger.error("Conversation binding migration requires DATABASE_URL.");
    logDiagnostic(logger, {
      stage: "ENVIRONMENT_VALIDATION", code: "DATABASE_URL_REQUIRED",
      transaction: "NOT_STARTED", rollback: "NOT_ATTEMPTED", ddl_started: false
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
    diagnostic = getFailureDiagnostic(error) || (migrationStarted
      ? { stage: "UNKNOWN", code: "DATABASE_OPERATION_FAILED", transaction: "UNRESOLVED", rollback: "UNRESOLVED", ddl_started: "UNRESOLVED" }
      : { stage: "DATABASE_CONNECTION", code: "DATABASE_CONNECTION_FAILED", transaction: "NOT_STARTED", rollback: "NOT_ATTEMPTED", ddl_started: false });
  }
  try {
    await pool?.end();
  } catch {
    if (!diagnostic) {
      diagnostic = {
        stage: "CLEANUP", code: "CLEANUP_FAILED",
        transaction: committed ? "COMMITTED" : migrationStarted ? "UNRESOLVED" : "NOT_STARTED",
        rollback: "NOT_ATTEMPTED", ddl_started: ddlStarted
      };
    }
  }
  if (diagnostic) {
    logger.error("Conversation binding migration failed.");
    logDiagnostic(logger, diagnostic);
    return false;
  }
  logger.log(result.migrated
    ? "Conversation binding migration completed."
    : "Conversation binding foundation already canonical.");
  logger.log(
    `Conversation binding migration diagnostic: stage=COMMIT_CONFIRMED `
      + `code=${result.migrated ? "MIGRATION_APPLIED" : "ALREADY_CANONICAL"} `
      + `transaction=COMMITTED rollback=NOT_ATTEMPTED ddl_started=${result.migrated === true}`
  );
  return true;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const success = await runContactConversationBindingFoundationMigrationCli();
  if (!success) process.exitCode = 1;
}
