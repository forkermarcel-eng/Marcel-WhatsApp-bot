import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  preflightHumanArmedConversationBindingFoundationMigration
} from "../device-bridge/tinder-human-armed-conversation-binding-foundation-schema.js";
import {
  READ_ONLY_GUARD_CODE,
  withDeviceBridgeReadOnlyTransaction
} from "../device-bridge/read-only-transaction.js";

/* Explicit-only operational preflight. It runs no lock, DDL or write path. */

const FOUNDATION_STATES = new Set(["ABSENT", "CANONICAL"]);
const REASONS = new Set([
  "DATABASE_URL_REQUIRED",
  "DATABASE_CONNECTION_FAILED",
  "READ_ONLY_TRANSACTION_FAILED",
  "HUMAN_ARMED_BINDING_SCHEMA_INCOMPATIBLE",
  "CONVERSATION_BINDING_FOUNDATION_NOT_READY",
  "T1_SCHEMA_NOT_READY",
  "PREFLIGHT_GUARD_BLOCKED",
  "PREFLIGHT_FAILED",
  "CLEANUP_FAILED"
]);

function boundedResult({
  ok,
  reason,
  foundationState = "UNRESOLVED",
  migrationRequired = "UNRESOLVED",
  transaction = "NOT_STARTED",
  rollback = "NOT_ATTEMPTED"
} = {}) {
  return Object.freeze({
    ok: ok === true,
    reason: ok === true && (reason === "ELIGIBLE_FOR_MIGRATION" || reason === "ALREADY_CANONICAL")
      ? reason
      : REASONS.has(reason) ? reason : "PREFLIGHT_FAILED",
    foundation_state: FOUNDATION_STATES.has(foundationState) ? foundationState : "UNRESOLVED",
    migration_required: typeof migrationRequired === "boolean" ? migrationRequired : "UNRESOLVED",
    transaction: transaction === "READ_ONLY_REPEATABLE_READ" ? transaction : "NOT_STARTED",
    rollback: rollback === "COMPLETED" ? rollback : "NOT_ATTEMPTED"
  });
}

function reasonForPreflightError(error) {
  if (error?.code === READ_ONLY_GUARD_CODE) return "PREFLIGHT_GUARD_BLOCKED";
  if (error?.message === "Human-armed conversation binding foundation schema is incompatible.") {
    return "HUMAN_ARMED_BINDING_SCHEMA_INCOMPATIBLE";
  }
  if (error?.message === "Conversation binding foundation schema is not ready.") {
    return "CONVERSATION_BINDING_FOUNDATION_NOT_READY";
  }
  if (error?.message === "Device Bridge T1 schema is not ready.") return "T1_SCHEMA_NOT_READY";
  return "PREFLIGHT_FAILED";
}

function logResult(logger, result) {
  logger.log(
    `Human-armed conversation binding read-only preflight: status=${result.ok ? "PASS" : "FAIL"} `
      + `reason=${result.reason} foundation_state=${result.foundation_state} `
      + `migration_required=${result.migration_required} transaction=${result.transaction} `
      + `rollback=${result.rollback}`
  );
}

export async function runHumanArmedConversationBindingFoundationPreflightCli({
  environment = process.env,
  createPool = async options => {
    const { default: pg } = await import("pg");
    return new pg.Pool(options);
  },
  preflight = preflightHumanArmedConversationBindingFoundationMigration,
  readOnlyTransaction = withDeviceBridgeReadOnlyTransaction,
  logger = console
} = {}) {
  if (!environment.DATABASE_URL) {
    const result = boundedResult({ ok: false, reason: "DATABASE_URL_REQUIRED" });
    logResult(logger, result);
    return result;
  }

  let pool;
  let result;
  let poolCreated = false;
  let enteredValidation = false;
  let validationError;
  try {
    pool = await createPool({ connectionString: environment.DATABASE_URL });
    poolCreated = true;
    const checked = await readOnlyTransaction(pool, async client => {
      enteredValidation = true;
      try {
        return await preflight(client);
      } catch (error) {
        validationError = error;
        throw error;
      }
    });
    const foundationState = checked?.foundation?.state;
    const migrationRequired = checked?.mutate === true;
    if (!FOUNDATION_STATES.has(foundationState)
        || checked?.mutate !== (foundationState === "ABSENT")) {
      result = boundedResult({
        ok: false, reason: "PREFLIGHT_FAILED",
        transaction: "READ_ONLY_REPEATABLE_READ", rollback: "COMPLETED"
      });
    } else {
      result = boundedResult({
        ok: true,
        reason: migrationRequired ? "ELIGIBLE_FOR_MIGRATION" : "ALREADY_CANONICAL",
        foundationState, migrationRequired,
        transaction: "READ_ONLY_REPEATABLE_READ", rollback: "COMPLETED"
      });
    }
  } catch (error) {
    result = boundedResult({
      ok: false,
      reason: validationError && error === validationError
        ? reasonForPreflightError(error)
        : poolCreated ? "READ_ONLY_TRANSACTION_FAILED" : "DATABASE_CONNECTION_FAILED",
      transaction: enteredValidation ? "READ_ONLY_REPEATABLE_READ" : "NOT_STARTED",
      rollback: validationError && error === validationError ? "COMPLETED" : "NOT_ATTEMPTED"
    });
  }
  try {
    await pool?.end();
  } catch {
    result = boundedResult({
      ok: false, reason: "CLEANUP_FAILED",
      transaction: result?.transaction, rollback: result?.rollback
    });
  }
  logResult(logger, result);
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runHumanArmedConversationBindingFoundationPreflightCli();
  if (!result.ok) process.exitCode = 1;
}
