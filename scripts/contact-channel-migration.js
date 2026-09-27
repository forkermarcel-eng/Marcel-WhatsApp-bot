import path from "node:path";
import { fileURLToPath } from "node:url";
import { preflightContactChannel, migrateContactChannel } from "../services/contact-channel-migration.js";

export async function runContactChannelMigration({ argv = process.argv.slice(2), environment = process.env,
  createPool = async options => { const { default: pg } = await import("pg"); return new pg.Pool(options); }, logger = console } = {}) {
  if (argv.length !== 1 || !["--preflight","--apply"].includes(argv[0])) { logger.error("CONTACT_CHANNEL_EXPLICIT_MODE_REQUIRED"); return false; }
  if (!environment.DATABASE_URL) { logger.error("CONTACT_CHANNEL_DATABASE_URL_REQUIRED"); return false; }
  let pool;
  try {
    pool = await createPool({ connectionString: environment.DATABASE_URL });
    const result = await (argv[0] === "--apply" ? migrateContactChannel(pool) : preflightContactChannel(pool));
    logger.log(JSON.stringify({ state: result.state, hash: result.hash,
      total: result.total ?? result.counts.total, withJid: result.withJid ?? result.counts.with_jid }));
    return true;
  } catch (error) {
    logger.error(/^CONTACT_CHANNEL_[A-Z_]+$/.test(error.message) ? error.message : "CONTACT_CHANNEL_DATABASE_OPERATION_FAILED");
    return false;
  } finally { await pool?.end().catch(() => {}); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!await runContactChannelMigration()) process.exitCode = 1;
}
