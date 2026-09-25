import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSharedMediaMigrationDiagnostic,
  migrateSharedMedia,
  preflightSharedMedia
} from "../shared-media/migration.js";

function diagnostic(logger, value) {
  logger.error(
    `SHARED_MEDIA_DIAGNOSTIC stage=${value.stage} code=${value.code} `
      + `transaction=${value.transaction} rollback=${value.rollback} ddl_started=${value.ddl_started}`
      + `${value.reason ? ` reason=${value.reason}` : ""}`
  );
}

async function createDefaultPool(options) {
  const { default: pg } = await import("pg");
  return new pg.Pool(options);
}

/**
 * The --apply mode is intentionally explicit and has not been invoked by
 * this change. --preflight is safe read-only catalog validation.
 */
export async function runSharedMediaMigrationCli({
  argv = process.argv.slice(2),
  environment = process.env,
  createPool = createDefaultPool,
  preflight = preflightSharedMedia,
  migrate = migrateSharedMedia,
  logger = console
} = {}) {
  const isPreflight = argv.includes("--preflight");
  const isApply = argv.includes("--apply");
  if ((isPreflight && isApply) || (!isPreflight && !isApply)) {
    diagnostic(logger, {
      stage: "CLI_ARGUMENT_VALIDATION",
      code: isApply ? "INVALID_MODE" : "APPLY_OR_PREFLIGHT_REQUIRED",
      transaction: "NOT_STARTED",
      rollback: "NOT_ATTEMPTED",
      ddl_started: false
    });
    return false;
  }
  if (!environment.DATABASE_URL) {
    diagnostic(logger, {
      stage: "ENVIRONMENT_VALIDATION",
      code: "DATABASE_URL_REQUIRED",
      transaction: "NOT_STARTED",
      rollback: "NOT_ATTEMPTED",
      ddl_started: false
    });
    return false;
  }

  let pool;
  try {
    pool = await createPool({ connectionString: environment.DATABASE_URL });
    if (isPreflight) {
      const result = await preflight(pool);
      logger.log(`SHARED_MEDIA_PREFLIGHT ${result.state}`);
      logger.log(
        `SHARED_MEDIA_COUNTS legacy_media=${result.counts.legacyMedia} assets=${result.counts.assets} links=${result.counts.links}`
      );
      return true;
    }
    const result = await migrate(pool);
    logger.log(
      `SHARED_MEDIA_MIGRATION COMMIT_CONFIRMED state=${result.migrated ? "MIGRATION_APPLIED" : "ALREADY_CANONICAL"}`
    );
    logger.log(
      `SHARED_MEDIA_POSTCHECK legacy_media=${result.postcheck.counts.legacyMedia} assets=${result.postcheck.counts.assets} links=${result.postcheck.counts.links}`
    );
    return true;
  } catch (error) {
    const migrationDiagnostic = getSharedMediaMigrationDiagnostic(error);
    diagnostic(logger, migrationDiagnostic || {
      stage: "DATABASE_OPERATION",
      code: ["SHARED_MEDIA_SCHEMA_INVALID", "SHARED_MEDIA_LEGACY_MEDIA_UNAVAILABLE"].includes(error?.code)
        ? error.code
        : "DATABASE_OPERATION_FAILED",
      transaction: "UNRESOLVED",
      rollback: "UNRESOLVED",
      ddl_started: "UNRESOLVED",
      reason: typeof error?.reason === "string" ? error.reason : null
    });
    return false;
  } finally {
    await pool?.end().catch(() => {});
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const success = await runSharedMediaMigrationCli();
  if (!success) process.exitCode = 1;
}
