import { createHash } from "node:crypto";

export const CONTACT_CHANNEL_DDL = "ALTER TABLE contacts ALTER COLUMN whatsapp_jid DROP NOT NULL";
export const CONTACT_CHANNEL_MIGRATION_HASH = createHash("sha256").update(CONTACT_CHANNEL_DDL).digest("hex");

export async function inspectContactChannelSchema(client) {
  const column = await client.query(`SELECT data_type, is_nullable FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='contacts' AND column_name='whatsapp_jid'`);
  if (column.rows.length !== 1 || column.rows[0].data_type !== "text") throw new Error("CONTACT_CHANNEL_SCHEMA_DRIFT");
  const unique = await client.query(`SELECT i.indexrelid::regclass::text AS name, pg_get_indexdef(i.indexrelid) AS definition
    FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attname='whatsapp_jid'
    WHERE i.indrelid='contacts'::regclass AND i.indisunique AND i.indisvalid AND i.indisready
      AND i.indnkeyatts=1 AND i.indkey[0]=a.attnum AND i.indpred IS NULL AND i.indexprs IS NULL
    ORDER BY i.indexrelid`);
  if (!unique.rows.length || unique.rows.some(row => /NULLS NOT DISTINCT/i.test(row.definition))) {
    throw new Error("CONTACT_CHANNEL_UNIQUE_CONTRACT_MISSING");
  }
  const rows = await client.query(`SELECT count(*)::int AS total,
    count(whatsapp_jid)::int AS with_jid,
    md5(COALESCE(string_agg(md5(row_to_json(c)::text), '' ORDER BY id),'')) AS digest FROM contacts c`);
  return { state: column.rows[0].is_nullable === "YES" ? "ALREADY_CANONICAL" : "ELIGIBLE_FOR_MIGRATION",
    counts: rows.rows[0], unique: unique.rows, hash: CONTACT_CHANNEL_MIGRATION_HASH };
}

export async function preflightContactChannel(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await inspectContactChannelSchema(client);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function migrateContactChannel(pool) {
  const client = await pool.connect();
  let commitAttempted = false, discard = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT pg_advisory_xact_lock(7421, 28)");
    await client.query("LOCK TABLE contacts IN ACCESS EXCLUSIVE MODE");
    const before = await inspectContactChannelSchema(client);
    if (before.state === "ELIGIBLE_FOR_MIGRATION") await client.query(CONTACT_CHANNEL_DDL);
    const after = await inspectContactChannelSchema(client);
    if (after.state !== "ALREADY_CANONICAL" || JSON.stringify(before.counts) !== JSON.stringify(after.counts)
      || JSON.stringify(before.unique) !== JSON.stringify(after.unique)) throw new Error("CONTACT_CHANNEL_POSTCHECK_FAILED");
    commitAttempted = true;
    await client.query("COMMIT");
    return { state: "COMMIT_CONFIRMED", migrated: before.state !== "ALREADY_CANONICAL",
      hash: CONTACT_CHANNEL_MIGRATION_HASH, total: after.counts.total, withJid: after.counts.with_jid };
  } catch (error) {
    if (commitAttempted) { discard = true; throw new Error("CONTACT_CHANNEL_COMMIT_OUTCOME_UNKNOWN", { cause: error }); }
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}
