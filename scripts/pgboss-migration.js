import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PG_BOSS_VERSION,
  getPgBossMigrationDiagnostic,
  migratePgBossSchema,
  preflightPgBossSchema
} from "../tinder-mirror/pg-boss-migration.js";

function diagnostic(logger, value) {
  logger.error(
    `PGBOSS_DIAGNOSTIC stage=${value.stage} code=${value.code} transaction=${value.transaction} `
      + `rollback=${value.rollback} ddl_started=${value.ddl_started}`
      + `${value.reason ? ` reason=${value.reason}` : ""}`
  );
}

async function createDefaultPool(options) {
  const { default: pg } = await import("pg");
  return new pg.Pool(options);
}

export async function runPgBossMigrationCli({
  argv = process.argv.slice(2),
  environment = process.env,
  createPool = createDefaultPool,
  preflight = preflightPgBossSchema,
  migrate = migratePgBossSchema,
  logger = console
} = {}) {
  const isPreflight = argv.length === 1 && argv[0] === "--preflight";
  const isApply = argv.length === 1 && argv[0] === "--apply";
  if (!isPreflight && !isApply) {
    diagnostic(logger, {
      stage: "CLI_ARGUMENT_VALIDATION",
      code: "APPLY_OR_PREFLIGHT_REQUIRED",
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
      logger.log(`PGBOSS_PREFLIGHT ${result.state} version=${PG_BOSS_VERSION}`);
      logger.log(`PGBOSS_COUNTS jobs=${result.counts.jobs} queue=${result.counts.queue}`);
      return true;
    }
    const result = await migrate(pool);
    logger.log(
      `PGBOSS_MIGRATION COMMIT_CONFIRMED state=${result.migrated ? "MIGRATION_APPLIED" : "ALREADY_CANONICAL"}`
    );
    logger.log(`PGBOSS_POSTCHECK jobs=${result.postcheck.counts.jobs} queue=${result.postcheck.counts.queue}`);
    return true;
  } catch (error) {
    diagnostic(logger, getPgBossMigrationDiagnostic(error) || {
      stage: "DATABASE_OPERATION",
      code: error?.code || "DATABASE_OPERATION_FAILED",
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
  const success = await runPgBossMigrationCli();
  if (!success) process.exitCode = 1;
}
