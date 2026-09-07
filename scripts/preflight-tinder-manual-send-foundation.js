import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  preflightTinderManualSendFoundationMigration
} from "../device-bridge/tinder-manual-send-foundation-schema.js";
import {
  READ_ONLY_GUARD_CODE,
  withDeviceBridgeReadOnlyTransaction
} from "../device-bridge/read-only-transaction.js";

/* Explicit-only operational preflight. It runs no lock, DDL or write path. */

const MANUAL_SEND_STATES = new Set(["ABSENT", "CANONICAL"]);
const REASONS = new Set([
  "DATABASE_URL_REQUIRED",
  "DATABASE_CONNECTION_FAILED",
  "READ_ONLY_TRANSACTION_FAILED",
  "T5_MANUAL_SEND_FOUNDATION_SCHEMA_INCOMPATIBLE",
  "T4_DRAFT_BASE_NOT_READY",
  "T3_IDENTITY_NOT_READY",
  "PREFLIGHT_GUARD_BLOCKED",
  "PREFLIGHT_FAILED",
  "CLEANUP_FAILED"
]);

function boundedResult({
  ok,
  reason,
  manualSendState = "UNRESOLVED",
  migrationRequired = "UNRESOLVED",
  transaction = "NOT_STARTED",
  rollback = "NOT_ATTEMPTED"
} = {}) {
  return Object.freeze({
    ok: ok === true,
    reason: ok === true && (reason === "ELIGIBLE_FOR_MIGRATION" || reason === "ALREADY_CANONICAL")
      ? reason
      : REASONS.has(reason) ? reason : "PREFLIGHT_FAILED",
    manual_send_state: MANUAL_SEND_STATES.has(manualSendState) ? manualSendState : "UNRESOLVED",
    migration_required: typeof migrationRequired === "boolean" ? migrationRequired : "UNRESOLVED",
    transaction: transaction === "READ_ONLY_REPEATABLE_READ" ? transaction : "NOT_STARTED",
    rollback: rollback === "COMPLETED" ? rollback : "NOT_ATTEMPTED"
  });
}

function reasonForPreflightError(error) {
  if (error?.code === READ_ONLY_GUARD_CODE) return "PREFLIGHT_GUARD_BLOCKED";
  if (error?.message === "T5 Tinder manual-send foundation schema is incompatible.") {
    return "T5_MANUAL_SEND_FOUNDATION_SCHEMA_INCOMPATIBLE";
  }
  if (error?.message === "T4 Tinder draft foundation base schema is not ready.") {
    return "T4_DRAFT_BASE_NOT_READY";
  }
  if (error?.message === "T3 identity foundation schema is not ready.") {
    return "T3_IDENTITY_NOT_READY";
  }
  return "PREFLIGHT_FAILED";
}

function logResult(logger, result) {
  logger.log(
    `T5 Tinder manual-send read-only preflight: status=${result.ok ? "PASS" : "FAIL"} `
      + `reason=${result.reason} manual_send_state=${result.manual_send_state} `
      + `migration_required=${result.migration_required} transaction=${result.transaction} `
      + `rollback=${result.rollback}`
  );
}

export async function runTinderManualSendFoundationPreflightCli({
  environment = process.env,
  createPool = async options => {
    const { default: pg } = await import("pg");
    return new pg.Pool(options);
  },
  preflight = preflightTinderManualSendFoundationMigration,
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
    const manualSendState = checked?.manualSend?.state;
    const migrationRequired = checked?.mutate === true;
    if (!MANUAL_SEND_STATES.has(manualSendState) || checked?.mutate !== (manualSendState === "ABSENT")) {
      result = boundedResult({
        ok: false,
        reason: "PREFLIGHT_FAILED",
        transaction: "READ_ONLY_REPEATABLE_READ",
        rollback: "COMPLETED"
      });
    } else {
      result = boundedResult({
        ok: true,
        reason: migrationRequired ? "ELIGIBLE_FOR_MIGRATION" : "ALREADY_CANONICAL",
        manualSendState,
        migrationRequired,
        transaction: "READ_ONLY_REPEATABLE_READ",
        rollback: "COMPLETED"
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
      ok: false,
      reason: "CLEANUP_FAILED",
      transaction: result?.transaction,
      rollback: result?.rollback
    });
  }

  logResult(logger, result);
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runTinderManualSendFoundationPreflightCli();
  if (!result.ok) process.exitCode = 1;
}
