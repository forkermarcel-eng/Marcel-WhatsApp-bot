import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getTinderMatchMigrationDiagnostic,
  migrateTinderMatches,
  preflightTinderMatches
} from "../tinder-mirror/matches-migration.js";

function diagnostic(logger, value) {
  logger.error(
    `TINDER_MATCH_DIAGNOSTIC stage=${value.stage} code=${value.code} `
      + `transaction=${value.transaction} rollback=${value.rollback} ddl_started=${value.ddl_started}`
      + `${value.reason ? ` reason=${value.reason}` : ""}`
  );
}

async function createDefaultPool(options) {
  const { default: pg } = await import("pg");
  return new pg.Pool(options);
}

export async function runTinderMatchesCli({
  argv = process.argv.slice(2),
  environment = process.env,
  createPool = createDefaultPool,
  preflight = preflightTinderMatches,
  migrate = migrateTinderMatches,
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
      logger.log(`TINDER_MATCH_PREFLIGHT ${result.state}`);
      logger.log(
        `TINDER_MATCH_COUNTS conversations=${result.counts.conversations} messages=${result.counts.messages} matches=${result.counts.matches}`
      );
      return true;
    }
    const result = await migrate(pool);
    logger.log(
      `TINDER_MATCH_MIGRATION COMMIT_CONFIRMED state=${result.migrated ? "MIGRATION_APPLIED" : "ALREADY_CANONICAL"}`
    );
    logger.log(
      `TINDER_MATCH_POSTCHECK conversations=${result.postcheck.counts.conversations} messages=${result.postcheck.counts.messages} matches=${result.postcheck.counts.matches}`
    );
    return true;
  } catch (error) {
    const migrationDiagnostic = getTinderMatchMigrationDiagnostic(error);
    diagnostic(logger, migrationDiagnostic || {
      stage: "DATABASE_OPERATION",
      code: ["TINDER_MATCH_SCHEMA_INVALID", "TINDER_MATCH_FOUNDATION_INVALID"].includes(error?.code)
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
  const success = await runTinderMatchesCli();
  if (!success) process.exitCode = 1;
}
