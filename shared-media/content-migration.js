import { createHash } from "node:crypto";
import { catalogState, readSharedMediaCatalog } from "./migration.js";
import { tokenizeSchemaSql } from "../device-bridge/schema-contract.js";

// Extends, never replaces or backfills, the existing shared-media foundation.
export const MEDIA_CONTENT_DDL = Object.freeze([
  "ALTER TABLE media_asset_links ADD COLUMN context JSONB NOT NULL DEFAULT '{}'::jsonb",
  `CREATE UNIQUE INDEX media_assets_source_sha256_unique
     ON media_assets ((metadata->>'sourceSha256'))
     WHERE metadata->>'sourceSha256' IS NOT NULL`,
  `ALTER TABLE media_assets ADD CONSTRAINT media_assets_source_sha256_check
     CHECK (metadata->>'sourceSha256' IS NULL OR metadata->>'sourceSha256' ~ '^[a-f0-9]{64}$')`,
  `CREATE UNIQUE INDEX media_asset_links_usage_unique
     ON media_asset_links (asset_id, owner_channel, owner_type, owner_reference,
       relationship_type, (COALESCE(ordinal, -1)))`
]);
export const MEDIA_CONTENT_MIGRATION_HASH = createHash("sha256").update(MEDIA_CONTENT_DDL.join(";\n")).digest("hex");

function indexShape(sql) {
  const tokens = tokenizeSchemaSql(sql);
  const on = tokens.indexOf("on");
  if (tokens[on + 2] === ".") tokens.splice(on + 1, 2);
  return tokens.filter(t => !["(", ")", "using", "btree"].includes(t))
    .map(t => t === "'-1'" ? "-1" : t).join("");
}

export function classifyMediaContentCatalog(catalog) {
  if (catalogState(catalog).state === "ALREADY_CANONICAL") return "ELIGIBLE_FOR_MIGRATION";
  const column = catalog.columns.filter(c => c.table_name === "media_asset_links" && c.column_name === "context");
  const checks = catalog.constraints.filter(c => c.conname === "media_assets_source_sha256_check");
  const names = ["media_assets_source_sha256_unique", "media_asset_links_usage_unique"];
  const indexes = catalog.indexes.filter(i => names.includes(i.indexname));
  if (column.length !== 1 || column[0].udt_name !== "jsonb" || column[0].is_nullable !== "NO"
    || column[0].column_default !== "'{}'::jsonb" || checks.length !== 1
    || checks[0].table_name !== "media_assets" || checks[0].contype !== "c"
    || indexShape(checks[0].definition) !== indexShape(
      "CHECK (metadata->>'sourceSha256' IS NULL OR metadata->>'sourceSha256' ~ '^[a-f0-9]{64}$')")
    || indexes.length !== 2 || ![1,3].every((ddl, n) => indexes.some(i =>
      i.indexname === names[n] && indexShape(i.indexdef) === indexShape(MEDIA_CONTENT_DDL[ddl])))) {
    throw new Error("MEDIA_CONTENT_SCHEMA_DRIFT");
  }
  const baseline = { ...catalog,
    columns: catalog.columns.filter(c => c !== column[0]),
    constraints: catalog.constraints.filter(c => c !== checks[0]),
    indexes: catalog.indexes.filter(i => !names.includes(i.indexname)) };
  if (catalogState(baseline).state !== "ALREADY_CANONICAL") throw new Error("MEDIA_CONTENT_SCHEMA_DRIFT");
  return "ALREADY_CANONICAL";
}

export async function preflightMediaContent(pool) {
  // Existing foundation must be present and exactly canonical. Do not create it
  // implicitly, tolerate drift, or silently consolidate historical links.
  const state = classifyMediaContentCatalog(await readSharedMediaCatalog(pool));
  const duplicates = await pool.query(`SELECT EXISTS (
    SELECT 1 FROM media_asset_links GROUP BY asset_id, owner_channel, owner_type,
    owner_reference, relationship_type, COALESCE(ordinal,-1) HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM media_assets WHERE metadata->>'sourceSha256' IS NOT NULL
    GROUP BY metadata->>'sourceSha256' HAVING count(*) > 1
  ) AS duplicates`);
  if (duplicates.rows[0]?.duplicates !== false) throw new Error("MEDIA_CONTENT_DUPLICATES_REQUIRE_SEPARATE_DECISION");
  const counts = await pool.query(`SELECT
    (SELECT count(*)::int FROM media_assets) AS assets,
    (SELECT count(*)::int FROM media_asset_links) AS links,
    (SELECT count(*)::int FROM media) AS "legacyMedia"`);
  return { state, counts: counts.rows[0],
    hash: MEDIA_CONTENT_MIGRATION_HASH };
}

export async function applyMediaContent(pool) {
  const client = await pool.connect();
  let commitAttempted = false;
  let discard = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT pg_advisory_xact_lock(7421, 27)");
    await client.query("LOCK TABLE media_assets, media_asset_links IN ACCESS EXCLUSIVE MODE");
    const before = await preflightMediaContent(client);
    if (before.state === "ELIGIBLE_FOR_MIGRATION") {
      for (const sql of MEDIA_CONTENT_DDL) await client.query(sql);
    }
    const count = await client.query(`SELECT
      (SELECT count(*)::int FROM media_assets) AS assets,
      (SELECT count(*)::int FROM media_asset_links) AS links,
      (SELECT count(*)::int FROM media) AS legacy`);
    if (count.rows[0]?.assets !== before.counts.assets || count.rows[0]?.links !== before.counts.links
      || count.rows[0]?.legacy !== before.counts.legacyMedia) throw new Error("MEDIA_CONTENT_COUNT_DRIFT");
    const after = await preflightMediaContent(client);
    if (after.state !== "ALREADY_CANONICAL") {
      throw new Error("MEDIA_CONTENT_POSTCHECK_FAILED");
    }
    commitAttempted = true;
    await client.query("COMMIT");
    return { state: "COMMIT_CONFIRMED", hash: MEDIA_CONTENT_MIGRATION_HASH, counts: count.rows[0] };
  } catch (error) {
    if (commitAttempted) { discard = true; throw new Error("MEDIA_CONTENT_COMMIT_OUTCOME_UNKNOWN", { cause: error }); }
    try { await client.query("ROLLBACK"); } catch { discard = true; }
    throw error;
  } finally { client.release(discard); }
}
