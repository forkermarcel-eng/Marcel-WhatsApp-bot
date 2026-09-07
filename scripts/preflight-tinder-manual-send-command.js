import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  preflightTinderManualSendCommandMigration
} from "../device-bridge/tinder-manual-send-command-schema.js";
import {
  READ_ONLY_GUARD_CODE,
  withDeviceBridgeReadOnlyTransaction
} from "../device-bridge/read-only-transaction.js";

/* Explicit-only operational preflight. No lock, DDL or write path exists. */

const COMMAND_STATES = new Set(["LEGACY", "CANONICAL"]);
const REASONS = new Set([
  "DATABASE_URL_REQUIRED",
  "DATABASE_CONNECTION_FAILED",
  "READ_ONLY_TRANSACTION_FAILED",
  "T5_MANUAL_SEND_COMMAND_SCHEMA_INCOMPATIBLE",
  "T5_MANUAL_SEND_FOUNDATION_NOT_READY",
  "PREFLIGHT_GUARD_BLOCKED",
  "PREFLIGHT_FAILED",
  "CLEANUP_FAILED"
]);

function boundedResult({
  ok,
  reason,
  commandState = "UNRESOLVED",
  migrationRequired = "UNRESOLVED",
  transaction = "NOT_STARTED",
  rollback = "NOT_ATTEMPTED"
} = {}) {
  return Object.freeze({
    ok: ok === true,
    reason: ok === true && (reason === "ELIGIBLE_FOR_MIGRATION" || reason === "ALREADY_CANONICAL")
      ? reason : REASONS.has(reason) ? reason : "PREFLIGHT_FAILED",
    command_state: COMMAND_STATES.has(commandState) ? commandState : "UNRESOLVED",
    migration_required: typeof migrationRequired === "boolean" ? migrationRequired : "UNRESOLVED",
    transaction: transaction === "READ_ONLY_REPEATABLE_READ" ? transaction : "NOT_STARTED",
    rollback: rollback === "COMPLETED" ? rollback : "NOT_ATTEMPTED"
  });
}

function reasonForPreflightError(error) {
  if (error?.code === READ_ONLY_GUARD_CODE) return "PREFLIGHT_GUARD_BLOCKED";
  if (error?.message === "T5 Tinder manual-send command schema is incompatible." ||
      error?.message === "Device Bridge data is incompatible with the T5 command extension.") {
    return "T5_MANUAL_SEND_COMMAND_SCHEMA_INCOMPATIBLE";
  }
  if (error?.message === "T5 Tinder manual-send foundation schema is not ready.") {
    return "T5_MANUAL_SEND_FOUNDATION_NOT_READY";
  }
  return "PREFLIGHT_FAILED";
}

function logResult(logger, result) {
  logger.log(
    `T5 signed send-command read-only preflight: status=${result.ok ? "PASS" : "FAIL"} `
      + `reason=${result.reason} command_state=${result.command_state} `
      + `migration_required=${result.migration_required} transaction=${result.transaction} `
      + `rollback=${result.rollback}`
  );
}

export async function runTinderManualSendCommandPreflightCli({
  environment = process.env,
  createPool = async options => {
    const { default: pg } = await import("pg");
    return new pg.Pool(options);
  },
  preflight = preflightTinderManualSendCommandMigration,
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
    const commandState = checked?.command?.state;
    const migrationRequired = checked?.mutate === true;
    if (!COMMAND_STATES.has(commandState) || checked?.mutate !== (commandState === "LEGACY")) {
      result = boundedResult({
        ok: false, reason: "PREFLIGHT_FAILED",
        transaction: "READ_ONLY_REPEATABLE_READ", rollback: "COMPLETED"
      });
    } else {
      result = boundedResult({
        ok: true,
        reason: migrationRequired ? "ELIGIBLE_FOR_MIGRATION" : "ALREADY_CANONICAL",
        commandState, migrationRequired,
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
  const result = await runTinderManualSendCommandPreflightCli();
  if (!result.ok) process.exitCode = 1;
}
