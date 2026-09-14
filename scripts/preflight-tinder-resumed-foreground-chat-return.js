import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { preflightTinderResumedForegroundChatReturnMigration, TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE } from "../device-bridge/tinder-resumed-foreground-chat-return-schema.js";
import { validateTinderResumedForegroundChatReturnMigrationSource } from "../device-bridge/tinder-resumed-foreground-chat-return-migration.js";
import { READ_ONLY_GUARD_CODE, withDeviceBridgeReadOnlyTransaction } from "../device-bridge/read-only-transaction.js";

const STATES = new Set(["UPGRADE_REQUIRED", "CANONICAL"]);
const REASONS = new Set(["MIGRATION_SOURCE_INVALID","DATABASE_URL_REQUIRED","DATABASE_CONNECTION_FAILED","READ_ONLY_TRANSACTION_FAILED","RESUMED_FOREGROUND_CHAT_RETURN_SCHEMA_INCOMPATIBLE","ACTIVE_PERMIT_BLOCKED","PREFLIGHT_GUARD_BLOCKED","PREFLIGHT_FAILED","CLEANUP_FAILED"]);
const STAGES = new Set(["SOURCE_VALIDATION","ENVIRONMENT_VALIDATION","DATABASE_CONNECTION","READ_ONLY_TRANSACTION","READ_ONLY_QUERY_GUARD","SCHEMA_INSPECTION","RESULT_VALIDATION","VALIDATION_UNCLASSIFIED","CLEANUP"]);
function result({ ok, reason, foundationState = "UNRESOLVED", migrationRequired = "UNRESOLVED", transaction = "NOT_STARTED", rollback = "NOT_ATTEMPTED", stage = "VALIDATION_UNCLASSIFIED" } = {}) {
  return Object.freeze({ ok: ok === true, reason: ok === true && (reason === "ELIGIBLE_FOR_MIGRATION" || reason === "ALREADY_CANONICAL") ? reason : REASONS.has(reason) ? reason : "PREFLIGHT_FAILED", foundation_state: STATES.has(foundationState) ? foundationState : "UNRESOLVED", migration_required: typeof migrationRequired === "boolean" ? migrationRequired : "UNRESOLVED", transaction: transaction === "READ_ONLY_REPEATABLE_READ" ? transaction : "NOT_STARTED", rollback: rollback === "COMPLETED" ? rollback : "NOT_ATTEMPTED", stage: STAGES.has(stage) ? stage : "VALIDATION_UNCLASSIFIED" });
}
function reasonFor(error) {
  if (error?.code === READ_ONLY_GUARD_CODE) return { reason: "PREFLIGHT_GUARD_BLOCKED", stage: "READ_ONLY_QUERY_GUARD" };
  if (error?.code === "TINDER_RESUMED_FOREGROUND_CHAT_RETURN_ACTIVE_PERMIT") return { reason: "ACTIVE_PERMIT_BLOCKED", stage: "SCHEMA_INSPECTION" };
  if (error?.message === "Tinder resumed foreground chat return schema is incompatible.") return { reason: "RESUMED_FOREGROUND_CHAT_RETURN_SCHEMA_INCOMPATIBLE", stage: "SCHEMA_INSPECTION" };
  return { reason: "PREFLIGHT_FAILED", stage: "VALIDATION_UNCLASSIFIED" };
}
function log(logger, value) { logger.log(`Tinder resumed foreground chat return read-only preflight: status=${value.ok ? "PASS" : "FAIL"} reason=${value.reason} foundation_state=${value.foundation_state} migration_required=${value.migration_required} transaction=${value.transaction} rollback=${value.rollback} stage=${value.stage}`); }
export async function runTinderResumedForegroundChatReturnPreflightCli({ environment = process.env, createPool = async options => { const { default: pg } = await import("pg"); return new pg.Pool(options); }, preflight = preflightTinderResumedForegroundChatReturnMigration, readMigrationSource = () => readFileSync(new URL("../migrations/20260914_tinder_resumed_foreground_chat_return_permit_v10.sql", import.meta.url), "utf8"), validateMigrationSource = validateTinderResumedForegroundChatReturnMigrationSource, readOnlyTransaction = withDeviceBridgeReadOnlyTransaction, logger = console } = {}) {
  try { validateMigrationSource(readMigrationSource()); } catch { const value = result({ ok: false, reason: "MIGRATION_SOURCE_INVALID", stage: "SOURCE_VALIDATION" }); log(logger, value); return value; }
  if (!environment.DATABASE_URL) { const value = result({ ok: false, reason: "DATABASE_URL_REQUIRED", stage: "ENVIRONMENT_VALIDATION" }); log(logger, value); return value; }
  let pool; let created = false; let entered = false; let validationError; let value;
  try { pool = await createPool({ connectionString: environment.DATABASE_URL }); created = true; const checked = await readOnlyTransaction(pool, async client => { entered = true; try { return await preflight(client); } catch (error) { validationError = error; throw error; } }); const state = checked?.foundation?.state; const required = checked?.mutate === true; value = STATES.has(state) && required === (state === TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.UPGRADE_REQUIRED) ? result({ ok: true, reason: required ? "ELIGIBLE_FOR_MIGRATION" : "ALREADY_CANONICAL", foundationState: state, migrationRequired: required, transaction: "READ_ONLY_REPEATABLE_READ", rollback: "COMPLETED", stage: "RESULT_VALIDATION" }) : result({ ok: false, reason: "PREFLIGHT_FAILED", transaction: "READ_ONLY_REPEATABLE_READ", rollback: "COMPLETED", stage: "RESULT_VALIDATION" }); }
  catch (error) { const diagnostic = validationError && error === validationError ? reasonFor(error) : null; value = result({ ok: false, reason: diagnostic?.reason || (created ? "READ_ONLY_TRANSACTION_FAILED" : "DATABASE_CONNECTION_FAILED"), transaction: entered ? "READ_ONLY_REPEATABLE_READ" : "NOT_STARTED", rollback: validationError && error === validationError ? "COMPLETED" : "NOT_ATTEMPTED", stage: diagnostic?.stage || (created ? "READ_ONLY_TRANSACTION" : "DATABASE_CONNECTION") }); }
  try { await pool?.end(); } catch { value = result({ ok: false, reason: "CLEANUP_FAILED", transaction: value?.transaction, rollback: value?.rollback, stage: "CLEANUP" }); }
  log(logger, value); return value;
}
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) { const value = await runTinderResumedForegroundChatReturnPreflightCli(); if (!value.ok) process.exitCode = 1; }
