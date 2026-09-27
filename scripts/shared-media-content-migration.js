import path from "node:path";
import { fileURLToPath } from "node:url";
import { preflightMediaContent, applyMediaContent } from "../shared-media/content-migration.js";

export async function runMediaContentMigration({ argv = process.argv.slice(2), environment = process.env,
  createPool = async options => { const { default: pg } = await import("pg"); return new pg.Pool(options); }, logger = console } = {}) {
  if (argv.length !== 1 || !["--preflight", "--apply"].includes(argv[0])) {
    logger.error("MEDIA_CONTENT_EXPLICIT_MODE_REQUIRED"); return false;
  }
  if (!environment.DATABASE_URL) { logger.error("MEDIA_CONTENT_DATABASE_URL_REQUIRED"); return false; }
  let pool, client;
  try {
    pool = await createPool({ connectionString: environment.DATABASE_URL });
    let result;
    if (argv[0] === "--preflight") {
      client = await pool.connect();
      await client.query("BEGIN READ ONLY");
      result = await preflightMediaContent(client);
      await client.query("COMMIT");
    } else result = await applyMediaContent(pool);
    logger.log(JSON.stringify(result));
    return true;
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    // SQL/connection errors can contain credentials or row contents. Never log them.
    const known = ["MEDIA_CONTENT_SCHEMA_DRIFT", "MEDIA_CONTENT_DUPLICATES_REQUIRE_SEPARATE_DECISION",
      "MEDIA_CONTENT_COUNT_DRIFT", "MEDIA_CONTENT_POSTCHECK_FAILED", "MEDIA_CONTENT_COMMIT_OUTCOME_UNKNOWN"];
    logger.error(known.includes(error.message) ? error.message : "MEDIA_CONTENT_DATABASE_OPERATION_FAILED");
    return false;
  } finally { client?.release(); await pool?.end().catch(() => {}); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!await runMediaContentMigration()) process.exitCode = 1;
}
