import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  preflightTinderOfficialAppResumePermitV2Migration,
  TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_PREFLIGHT_ERROR_CODE,
  TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE
} from "../device-bridge/tinder-visible-chat-sync-permit-schema.js";
import {
  validateTinderOfficialAppResumePermitV2MigrationSource
} from "../device-bridge/tinder-official-app-resume-permit-v2-migration.js";
import {
  READ_ONLY_GUARD_CODE,
  withDeviceBridgeReadOnlyTransaction
} from "../device-bridge/read-only-transaction.js";

/* Explicit-only operational preflight. It owns no lock, DDL or write path. */

const FOUNDATION_STATES = new Set([
  TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.UPGRADE_REQUIRED,
  TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.CANONICAL
]);
const REASONS = new Set([
  "MIGRATION_SOURCE_INVALID",
  "DATABASE_URL_REQUIRED",
  "DATABASE_CONNECTION_FAILED",
  "READ_ONLY_TRANSACTION_FAILED",
  "OFFICIAL_APP_RESUME_PERMIT_V2_SCHEMA_INCOMPATIBLE",
  "OFFICIAL_APP_RESUME_PERMIT_V2_ACTIVE_LEGACY_PERMIT",
  "OFFICIAL_APP_RESUME_PERMIT_V2_PREREQUISITE_INSPECTION_FAILED",
  "OFFICIAL_APP_RESUME_PERMIT_V2_V1_CONSTRAINT_INSPECTION_FAILED",
  "OFFICIAL_APP_RESUME_PERMIT_V2_ACTIVE_LEGACY_PERMIT_CHECK_FAILED",
  "PREFLIGHT_GUARD_BLOCKED",
  "PREFLIGHT_FAILED",
  "CLEANUP_FAILED"
]);
const STAGES = new Set([
  "SOURCE_VALIDATION",
  "ENVIRONMENT_VALIDATION",
  "DATABASE_CONNECTION",
  "READ_ONLY_TRANSACTION",
  "READ_ONLY_QUERY_GUARD",
  "PREREQUISITE_INSPECTION",
  "V1_CONSTRAINT_INSPECTION",
  "ACTIVE_LEGACY_PERMIT_CHECK",
  "V2_SCHEMA_INSPECTION",
  "RESULT_VALIDATION",
  "VALIDATION_UNCLASSIFIED",
  "CLEANUP"
]);

function boundedResult({
  ok,
  reason,
  foundationState = "UNRESOLVED",
  migrationRequired = "UNRESOLVED",
  transaction = "NOT_STARTED",
  rollback = "NOT_ATTEMPTED",
  stage = "VALIDATION_UNCLASSIFIED"
} = {}) {
  return Object.freeze({
    ok: ok === true,
    reason: ok === true && (reason === "ELIGIBLE_FOR_MIGRATION" || reason === "ALREADY_CANONICAL")
      ? reason : REASONS.has(reason) ? reason : "PREFLIGHT_FAILED",
    foundation_state: FOUNDATION_STATES.has(foundationState) ? foundationState : "UNRESOLVED",
    migration_required: typeof migrationRequired === "boolean" ? migrationRequired : "UNRESOLVED",
    transaction: transaction === "READ_ONLY_REPEATABLE_READ" ? transaction : "NOT_STARTED",
    rollback: rollback === "COMPLETED" ? rollback : "NOT_ATTEMPTED",
    stage: STAGES.has(stage) ? stage : "VALIDATION_UNCLASSIFIED"
  });
}

function reasonForPreflightError(error) {
  if (error?.code === READ_ONLY_GUARD_CODE) {
    return { reason: "PREFLIGHT_GUARD_BLOCKED", stage: "READ_ONLY_QUERY_GUARD" };
  }
  if (error?.code === "TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_ACTIVE_LEGACY_PERMIT") {
    return { reason: "OFFICIAL_APP_RESUME_PERMIT_V2_ACTIVE_LEGACY_PERMIT", stage: "ACTIVE_LEGACY_PERMIT_CHECK" };
  }
  if (error?.code === TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_PREFLIGHT_ERROR_CODE.PREREQUISITE_INSPECTION_FAILED) {
    return { reason: "OFFICIAL_APP_RESUME_PERMIT_V2_PREREQUISITE_INSPECTION_FAILED", stage: "PREREQUISITE_INSPECTION" };
  }
  if (error?.code === TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_PREFLIGHT_ERROR_CODE.V1_CONSTRAINT_INSPECTION_FAILED) {
    return { reason: "OFFICIAL_APP_RESUME_PERMIT_V2_V1_CONSTRAINT_INSPECTION_FAILED", stage: "V1_CONSTRAINT_INSPECTION" };
  }
  if (error?.code === TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_PREFLIGHT_ERROR_CODE.ACTIVE_LEGACY_PERMIT_CHECK_FAILED) {
    return { reason: "OFFICIAL_APP_RESUME_PERMIT_V2_ACTIVE_LEGACY_PERMIT_CHECK_FAILED", stage: "ACTIVE_LEGACY_PERMIT_CHECK" };
  }
  if (error?.message === "Tinder official-app resume permit V2 schema is incompatible.") {
    return { reason: "OFFICIAL_APP_RESUME_PERMIT_V2_SCHEMA_INCOMPATIBLE", stage: "V2_SCHEMA_INSPECTION" };
  }
  return { reason: "PREFLIGHT_FAILED", stage: "VALIDATION_UNCLASSIFIED" };
}

function logResult(logger, result) {
  logger.log(
    `Tinder official-app resume permit V2 read-only preflight: status=${result.ok ? "PASS" : "FAIL"} `
      + `reason=${result.reason} foundation_state=${result.foundation_state} `
      + `migration_required=${result.migration_required} transaction=${result.transaction} `
      + `rollback=${result.rollback} stage=${result.stage}`
  );
}

export async function runTinderOfficialAppResumePermitV2PreflightCli({
  environment = process.env,
  createPool = async options => {
    const { default: pg } = await import("pg");
    return new pg.Pool(options);
  },
  preflight = preflightTinderOfficialAppResumePermitV2Migration,
  readMigrationSource = () => readFileSync(
    new URL("../migrations/20260910_tinder_official_app_resume_permit_v2.sql", import.meta.url),
    "utf8"
  ),
  validateMigrationSource = validateTinderOfficialAppResumePermitV2MigrationSource,
  readOnlyTransaction = withDeviceBridgeReadOnlyTransaction,
  logger = console
} = {}) {
  try {
    validateMigrationSource(readMigrationSource());
  } catch {
    const result = boundedResult({
      ok: false, reason: "MIGRATION_SOURCE_INVALID", stage: "SOURCE_VALIDATION"
    });
    logResult(logger, result);
    return result;
  }
  if (!environment.DATABASE_URL) {
    const result = boundedResult({
      ok: false, reason: "DATABASE_URL_REQUIRED", stage: "ENVIRONMENT_VALIDATION"
    });
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
        || checked?.mutate !== (foundationState === TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.UPGRADE_REQUIRED)) {
      result = boundedResult({
        ok: false, reason: "PREFLIGHT_FAILED",
        transaction: "READ_ONLY_REPEATABLE_READ", rollback: "COMPLETED",
        stage: "RESULT_VALIDATION"
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
    const diagnostic = validationError && error === validationError
      ? reasonForPreflightError(error)
      : null;
    result = boundedResult({
      ok: false,
      reason: diagnostic?.reason || (poolCreated ? "READ_ONLY_TRANSACTION_FAILED" : "DATABASE_CONNECTION_FAILED"),
      transaction: enteredValidation ? "READ_ONLY_REPEATABLE_READ" : "NOT_STARTED",
      rollback: validationError && error === validationError ? "COMPLETED" : "NOT_ATTEMPTED",
      stage: diagnostic?.stage || (poolCreated ? "READ_ONLY_TRANSACTION" : "DATABASE_CONNECTION")
    });
  }
  try {
    await pool?.end();
  } catch {
    result = boundedResult({
      ok: false, reason: "CLEANUP_FAILED",
      transaction: result?.transaction, rollback: result?.rollback, stage: "CLEANUP"
    });
  }
  logResult(logger, result);
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runTinderOfficialAppResumePermitV2PreflightCli();
  if (!result.ok) process.exitCode = 1;
}
