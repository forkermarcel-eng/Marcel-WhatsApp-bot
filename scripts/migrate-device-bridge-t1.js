import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateDeviceBridgeSchema } from "../device-bridge/database.js";

/* ==================================================
DEVICE BRIDGE T1 — EXPLICIT OPERATOR MIGRATION CLI
================================================== */

export async function runDeviceBridgeT1MigrationCli({
  argv = process.argv.slice(2),
  environment = process.env,
  createPool = async options => {
    const { default: pg } = await import("pg");
    return new pg.Pool(options);
  },
  migrate = migrateDeviceBridgeSchema,
  logger = console
} = {}) {
  if (!argv.includes("--apply")) {
    logger.error("Refusing Device Bridge T1 schema migration without --apply.");
    return false;
  }
  if (!environment.DATABASE_URL) {
    logger.error("Device Bridge T1 schema migration requires DATABASE_URL.");
    return false;
  }

  let pool;
  try {
    pool = await createPool({ connectionString: environment.DATABASE_URL });
    const result = await migrate(pool);
    logger.log(result.migrated
      ? "Device Bridge T1 schema migration completed."
      : "Device Bridge T1 schema already compatible.");
    return true;
  } catch {
    logger.error("Device Bridge T1 schema migration failed.");
    return false;
  } finally {
    await pool?.end();
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const success = await runDeviceBridgeT1MigrationCli();
  if (!success) process.exitCode = 1;
}
