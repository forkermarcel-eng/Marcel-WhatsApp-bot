import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  preflightTinderVerifiedChatReturnMigration,
  TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE
} from "../device-bridge/tinder-verified-chat-return-schema.js";
import {
  validateTinderVerifiedChatReturnMigrationSource
} from "../device-bridge/tinder-verified-chat-return-migration.js";
import {
  READ_ONLY_GUARD_CODE,
  withDeviceBridgeReadOnlyTransaction
} from "../device-bridge/read-only-transaction.js";

/* Explicit V9 preflight. It is rollback-only and cannot apply schema. */

const STATES = new Set([
  TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.UPGRADE_REQUIRED,
  TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.CANONICAL
]);
const REASONS = new Set([
  "MIGRATION_SOURCE_INVALID", "DATABASE_URL_REQUIRED", "DATABASE_CONNECTION_FAILED",
  "READ_ONLY_TRANSACTION_FAILED", "VERIFIED_CHAT_RETURN_SCHEMA_INCOMPATIBLE",
  "ACTIVE_PERMIT_BLOCKED", "PREFLIGHT_GUARD_BLOCKED", "PREFLIGHT_FAILED", "CLEANUP_FAILED"
]);
const STAGES = new Set([
  "SOURCE_VALIDATION", "ENVIRONMENT_VALIDATION", "DATABASE_CONNECTION", "READ_ONLY_TRANSACTION",
  "READ_ONLY_QUERY_GUARD", "SCHEMA_INSPECTION", "RESULT_VALIDATION", "VALIDATION_UNCLASSIFIED", "CLEANUP"
]);

function boundedResult({ ok, reason, foundationState = "UNRESOLVED", migrationRequired = "UNRESOLVED", transaction = "NOT_STARTED", rollback = "NOT_ATTEMPTED", stage = "VALIDATION_UNCLASSIFIED" } = {}) {
  return Object.freeze({
    ok: ok === true,
    reason: ok === true && (reason === "ELIGIBLE_FOR_MIGRATION" || reason === "ALREADY_CANONICAL")
      ? reason : REASONS.has(reason) ? reason : "PREFLIGHT_FAILED",
    foundation_state: STATES.has(foundationState) ? foundationState : "UNRESOLVED",
    migration_required: typeof migrationRequired === "boolean" ? migrationRequired : "UNRESOLVED",
    transaction: transaction === "READ_ONLY_REPEATABLE_READ" ? transaction : "NOT_STARTED",
    rollback: rollback === "COMPLETED" ? rollback : "NOT_ATTEMPTED",
    stage: STAGES.has(stage) ? stage : "VALIDATION_UNCLASSIFIED"
  });
}

function reasonFor(error) {
  if (error?.code === READ_ONLY_GUARD_CODE) return { reason: "PREFLIGHT_GUARD_BLOCKED", stage: "READ_ONLY_QUERY_GUARD" };
  if (error?.code === "TINDER_VERIFIED_CHAT_RETURN_ACTIVE_PERMIT") return { reason: "ACTIVE_PERMIT_BLOCKED", stage: "SCHEMA_INSPECTION" };
  if (error?.message === "Tinder verified chat return schema is incompatible.") return { reason: "VERIFIED_CHAT_RETURN_SCHEMA_INCOMPATIBLE", stage: "SCHEMA_INSPECTION" };
  return { reason: "PREFLIGHT_FAILED", stage: "VALIDATION_UNCLASSIFIED" };
}

function logResult(logger, result) {
  logger.log(`Tinder verified chat return read-only preflight: status=${result.ok ? "PASS" : "FAIL"} reason=${result.reason} foundation_state=${result.foundation_state} migration_required=${result.migration_required} transaction=${result.transaction} rollback=${result.rollback} stage=${result.stage}`);
}

export async function runTinderVerifiedChatReturnPreflightCli({
  environment = process.env,
  createPool = async options => { const { default: pg } = await import("pg"); return new pg.Pool(options); },
  preflight = preflightTinderVerifiedChatReturnMigration,
  readMigrationSource = () => readFileSync(new URL("../migrations/20260913_tinder_verified_chat_return_permit_v9.sql", import.meta.url), "utf8"),
  validateMigrationSource = validateTinderVerifiedChatReturnMigrationSource,
  readOnlyTransaction = withDeviceBridgeReadOnlyTransaction,
  logger = console
} = {}) {
  try { validateMigrationSource(readMigrationSource()); } catch {
    const result = boundedResult({ ok: false, reason: "MIGRATION_SOURCE_INVALID", stage: "SOURCE_VALIDATION" }); logResult(logger, result); return result;
  }
  if (!environment.DATABASE_URL) {
    const result = boundedResult({ ok: false, reason: "DATABASE_URL_REQUIRED", stage: "ENVIRONMENT_VALIDATION" }); logResult(logger, result); return result;
  }
  let pool; let poolCreated = false; let entered = false; let validationError; let result;
  try {
    pool = await createPool({ connectionString: environment.DATABASE_URL }); poolCreated = true;
    const checked = await readOnlyTransaction(pool, async client => {
      entered = true;
      try { return await preflight(client); } catch (error) { validationError = error; throw error; }
    });
    const state = checked?.foundation?.state;
    const migrationRequired = checked?.mutate === true;
    result = STATES.has(state) && migrationRequired === (state === TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.UPGRADE_REQUIRED)
      ? boundedResult({ ok: true, reason: migrationRequired ? "ELIGIBLE_FOR_MIGRATION" : "ALREADY_CANONICAL", foundationState: state, migrationRequired, transaction: "READ_ONLY_REPEATABLE_READ", rollback: "COMPLETED", stage: "RESULT_VALIDATION" })
      : boundedResult({ ok: false, reason: "PREFLIGHT_FAILED", transaction: "READ_ONLY_REPEATABLE_READ", rollback: "COMPLETED", stage: "RESULT_VALIDATION" });
  } catch (error) {
    const diagnostic = validationError && error === validationError ? reasonFor(error) : null;
    result = boundedResult({ ok: false, reason: diagnostic?.reason || (poolCreated ? "READ_ONLY_TRANSACTION_FAILED" : "DATABASE_CONNECTION_FAILED"), transaction: entered ? "READ_ONLY_REPEATABLE_READ" : "NOT_STARTED", rollback: validationError && error === validationError ? "COMPLETED" : "NOT_ATTEMPTED", stage: diagnostic?.stage || (poolCreated ? "READ_ONLY_TRANSACTION" : "DATABASE_CONNECTION") });
  }
  try { await pool?.end(); } catch { result = boundedResult({ ok: false, reason: "CLEANUP_FAILED", transaction: result?.transaction, rollback: result?.rollback, stage: "CLEANUP" }); }
  logResult(logger, result);
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runTinderVerifiedChatReturnPreflightCli();
  if (!result.ok) process.exitCode = 1;
}
