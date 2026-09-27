import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getSharedMediaMigrationDiagnostic,
  migrateSharedMedia,
  preflightSharedMedia
} from "../shared-media/migration.js";
import { runSharedMediaMigrationCli } from "../scripts/shared-media-migration.js";
import { classifyMediaContentCatalog, MEDIA_CONTENT_DDL, applyMediaContent } from "../shared-media/content-migration.js";

function contentCatalog(applied = false) {
  const catalog = { relations: ["media_assets", "media_asset_links"].map(table_name => ({ table_name, relkind: "r" })),
    columns: [...assetColumns, ...linkColumns], constraints: targetConstraints(), indexes: targetIndexes(), triggers: 0 };
  if (applied) {
    catalog.columns.push({ table_name: "media_asset_links", column_name: "context", udt_name: "jsonb", is_nullable: "NO", column_default: "'{}'::jsonb" });
    catalog.constraints.push(check("media_assets", "media_assets_source_sha256_check",
      "CHECK (((metadata ->> 'sourceSha256'::text) IS NULL) OR ((metadata ->> 'sourceSha256'::text) ~ '^[a-f0-9]{64}$'::text))"));
    catalog.indexes.push(...[1,3].map((i,n) => ({ table_name: n ? "media_asset_links" : "media_assets",
      indexname: n ? "media_asset_links_usage_unique" : "media_assets_source_sha256_unique", indexdef: MEDIA_CONTENT_DDL[i] })));
  }
  return structuredClone(catalog);
}

test("content extension accepts only exact baseline or complete additive target", () => {
  assert.equal(classifyMediaContentCatalog(contentCatalog()), "ELIGIBLE_FOR_MIGRATION");
  assert.equal(classifyMediaContentCatalog(contentCatalog(true)), "ALREADY_CANONICAL");
  for (const change of [c => c.columns.at(-1).is_nullable = "YES",
    c => c.indexes.at(-1).indexdef = c.indexes.at(-1).indexdef.replace("UNIQUE", ""),
    c => c.constraints.at(-1).definition = "CHECK (true)", c => c.triggers = 1,
    c => c.columns.shift(), c => c.indexes.pop()]) {
    const drift = contentCatalog(true); change(drift);
    assert.throws(() => classifyMediaContentCatalog(drift), /SCHEMA_DRIFT/);
  }
});

test("content migration is atomic, repeatable and never consolidates existing rows", async () => {
  for (const mode of ["apply", "repeat", "duplicate", "ddl-fail", "postcheck-fail", "commit-unknown"]) {
    let applied = mode === "repeat", executed = 0;
    const statements = [];
    const client = { release() {}, async query(sql) {
      statements.push(sql);
      const catalog = contentCatalog(applied);
      if (sql.includes("c.relname AS table_name")) return { rows: catalog.relations };
      if (sql.includes("information_schema.columns")) return { rows: catalog.columns };
      if (sql.includes("pg_get_constraintdef")) return { rows: catalog.constraints };
      if (sql.includes("pg_get_indexdef")) return { rows: catalog.indexes };
      if (sql.includes("pg_trigger")) return { rows: [{ count: 0 }] };
      if (sql.includes("AS duplicates")) return { rows: [{ duplicates: mode === "duplicate" }] };
      if (sql.includes("count(*)::int FROM media_assets")) return { rows: [{ assets: 2, links: 3, legacyMedia: 14, legacy: 14 }] };
      if (MEDIA_CONTENT_DDL.includes(sql)) {
        if (mode === "ddl-fail") throw Error("DDL_FAILED");
        if (++executed === MEDIA_CONTENT_DDL.length && mode !== "postcheck-fail") applied = true;
      }
      if (sql === "COMMIT" && mode === "commit-unknown") throw Error("connection lost");
      return { rows: [] };
    } };
    const run = () => applyMediaContent({ connect: async () => client });
    if (["apply", "repeat"].includes(mode)) {
      assert.equal((await run()).state, "COMMIT_CONFIRMED");
      assert.equal(executed, mode === "repeat" ? 0 : 4);
    } else {
      await assert.rejects(run);
      assert.equal(statements.includes("ROLLBACK"), mode !== "commit-unknown");
      if (mode === "duplicate") assert.equal(executed, 0);
    }
    assert.equal(statements.some(sql => /^(UPDATE|DELETE|INSERT|DROP|TRUNCATE)\b/i.test(sql)), false);
  }
});

const assetColumns = [
  ["asset_id", "uuid", "NO", null],
  ["source_channel", "text", "NO", null],
  ["source_reference", "text", "YES", null],
  ["media_type", "text", "NO", null],
  ["mime_type", "text", "YES", null],
  ["storage_key", "text", "YES", null],
  ["thumbnail_storage_key", "text", "YES", null],
  ["byte_size", "int8", "YES", null],
  ["width", "int4", "YES", null],
  ["height", "int4", "YES", null],
  ["duration_ms", "int8", "YES", null],
  ["availability", "text", "NO", "'AVAILABLE'::text"],
  ["unavailable_reason", "text", "YES", null],
  ["metadata", "jsonb", "NO", "'{}'::jsonb"],
  ["created_at", "timestamptz", "NO", "now()"]
].map(([column_name, udt_name, is_nullable, column_default]) => ({
  table_name: "media_assets", column_name, udt_name, is_nullable, column_default
}));

const linkColumns = [
  ["link_id", "uuid", "NO", null],
  ["asset_id", "uuid", "NO", null],
  ["owner_channel", "text", "NO", null],
  ["owner_type", "text", "NO", null],
  ["owner_reference", "text", "NO", null],
  ["relationship_type", "text", "NO", "'attachment'::text"],
  ["ordinal", "int4", "YES", null],
  ["created_at", "timestamptz", "NO", "now()"]
].map(([column_name, udt_name, is_nullable, column_default]) => ({
  table_name: "media_asset_links", column_name, udt_name, is_nullable, column_default
}));

function check(table_name, conname, definition) {
  return {
    table_name,
    contype: "c",
    conname,
    columns: [],
    reference_table: null,
    confdeltype: " ",
    confupdtype: " ",
    condeferrable: false,
    condeferred: false,
    definition
  };
}

function targetConstraints() {
  return [
    {
      table_name: "media_assets", contype: "p", conname: "media_assets_pkey", columns: ["asset_id"],
      reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false,
      definition: "PRIMARY KEY (asset_id)"
    },
    check("media_assets", "media_assets_source_channel_not_blank", "CHECK ((btrim(source_channel) <> ''::text))"),
    check("media_assets", "media_assets_media_type_check", "CHECK ((media_type = ANY (ARRAY['image'::text, 'video'::text, 'sticker'::text, 'audio'::text, 'document'::text, 'file'::text])))"),
    check("media_assets", "media_assets_byte_size_nonnegative", "CHECK (((byte_size IS NULL) OR (byte_size >= 0)))"),
    check("media_assets", "media_assets_width_positive", "CHECK (((width IS NULL) OR (width > 0)))"),
    check("media_assets", "media_assets_height_positive", "CHECK (((height IS NULL) OR (height > 0)))"),
    check("media_assets", "media_assets_duration_nonnegative", "CHECK (((duration_ms IS NULL) OR (duration_ms >= 0)))"),
    check("media_assets", "media_assets_availability_check", "CHECK ((availability = ANY (ARRAY['AVAILABLE'::text, 'UNAVAILABLE'::text])))"),
    check("media_assets", "media_assets_storage_contract_check", "CHECK (((availability = 'AVAILABLE'::text) AND (storage_key IS NOT NULL)) OR ((availability = 'UNAVAILABLE'::text) AND (storage_key IS NULL) AND (thumbnail_storage_key IS NULL) AND (unavailable_reason IS NOT NULL)))"),
    {
      table_name: "media_asset_links", contype: "p", conname: "media_asset_links_pkey", columns: ["link_id"],
      reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false,
      definition: "PRIMARY KEY (link_id)"
    },
    {
      table_name: "media_asset_links", contype: "f", conname: "media_asset_links_asset_id_fkey", columns: ["asset_id"],
      reference_table: "media_assets", confdeltype: "r", confupdtype: "a", condeferrable: false, condeferred: false,
      definition: "FOREIGN KEY (asset_id) REFERENCES media_assets(asset_id) ON DELETE RESTRICT"
    },
    check("media_asset_links", "media_asset_links_owner_channel_not_blank", "CHECK ((btrim(owner_channel) <> ''::text))"),
    check("media_asset_links", "media_asset_links_owner_type_not_blank", "CHECK ((btrim(owner_type) <> ''::text))"),
    check("media_asset_links", "media_asset_links_owner_reference_not_blank", "CHECK ((btrim(owner_reference) <> ''::text))"),
    check("media_asset_links", "media_asset_links_relationship_type_not_blank", "CHECK ((btrim(relationship_type) <> ''::text))"),
    check("media_asset_links", "media_asset_links_ordinal_nonnegative", "CHECK (((ordinal IS NULL) OR (ordinal >= 0)))")
  ];
}

function targetIndexes() {
  return [
    {
      table_name: "media_assets", indexname: "media_assets_storage_key_unique",
      indexdef: "CREATE UNIQUE INDEX media_assets_storage_key_unique ON public.media_assets USING btree (storage_key) WHERE (storage_key IS NOT NULL)"
    },
    {
      table_name: "media_assets", indexname: "media_assets_thumbnail_storage_key_unique",
      indexdef: "CREATE UNIQUE INDEX media_assets_thumbnail_storage_key_unique ON public.media_assets USING btree (thumbnail_storage_key) WHERE (thumbnail_storage_key IS NOT NULL)"
    },
    {
      table_name: "media_asset_links", indexname: "media_asset_links_owner_lookup_idx",
      indexdef: "CREATE INDEX media_asset_links_owner_lookup_idx ON public.media_asset_links USING btree (owner_channel, owner_type, owner_reference, created_at DESC)"
    },
    {
      table_name: "media_asset_links", indexname: "media_asset_links_asset_idx",
      indexdef: "CREATE INDEX media_asset_links_asset_idx ON public.media_asset_links USING btree (asset_id)"
    }
  ];
}

function createMigrationPool({ target = false, failOn = null, rowCountDrift = false, legacyMissing = false } = {}) {
  const statements = [];
  const applied = new Set(target ? ["assets", "storage-index", "thumbnail-index", "links", "owner-index", "asset-index"] : []);
  const counts = { legacy_media: 14, assets: 0, links: 0 };
  const isTarget = () => ["assets", "storage-index", "thumbnail-index", "links", "owner-index", "asset-index"].every((item) => applied.has(item));
  async function query(sql) {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    statements.push(normalized);
    if (failOn && normalized.includes(failOn)) throw new Error("forced migration failure");
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(normalized)) return { rows: [] };
    if (normalized.includes("relation.relname = 'media'")) return { rows: [{ available: !legacyMissing }] };
    if (normalized.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: true }] };
    if (normalized.includes("FROM pg_class c JOIN pg_namespace n")) {
      return { rows: isTarget() ? [
        { table_name: "media_asset_links", relkind: "r" },
        { table_name: "media_assets", relkind: "r" }
      ] : [] };
    }
    if (normalized.includes("FROM information_schema.columns")) return { rows: isTarget() ? [...assetColumns, ...linkColumns] : [] };
    if (normalized.includes("FROM pg_constraint con")) return { rows: isTarget() ? targetConstraints() : [] };
    if (normalized.includes("FROM pg_index index_entry")) return { rows: isTarget() ? targetIndexes() : [] };
    if (normalized.includes("FROM pg_trigger trigger")) return { rows: [{ count: 0 }] };
    if (normalized.startsWith("SELECT (SELECT COUNT(*)::int FROM media)")) {
      return { rows: [{
        legacy_media: counts.legacy_media,
        ...(isTarget() ? { assets: counts.assets, links: counts.links } : {})
      }] };
    }
    if (normalized === "LOCK TABLE media IN ACCESS SHARE MODE") return { rows: [] };
    if (normalized.startsWith("CREATE TABLE media_assets")) {
      applied.add("assets");
      if (rowCountDrift) counts.legacy_media += 1;
      return { rows: [] };
    }
    if (normalized.startsWith("CREATE UNIQUE INDEX media_assets_storage_key_unique")) {
      applied.add("storage-index");
      return { rows: [] };
    }
    if (normalized.startsWith("CREATE UNIQUE INDEX media_assets_thumbnail_storage_key_unique")) {
      applied.add("thumbnail-index");
      return { rows: [] };
    }
    if (normalized.startsWith("CREATE TABLE media_asset_links")) {
      applied.add("links");
      return { rows: [] };
    }
    if (normalized.startsWith("CREATE INDEX media_asset_links_owner_lookup_idx")) {
      applied.add("owner-index");
      return { rows: [] };
    }
    if (normalized.startsWith("CREATE INDEX media_asset_links_asset_idx")) {
      applied.add("asset-index");
      return { rows: [] };
    }
    throw new Error(`Unexpected migration SQL: ${normalized}`);
  }
  return {
    statements,
    isTarget,
    async connect() { return { query, release() {} }; },
    async end() {}
  };
}

test("shared-media preflight is read-only and accepts the empty additive baseline", async () => {
  const pool = createMigrationPool();
  const result = await preflightSharedMedia(pool);
  assert.equal(result.state, "ELIGIBLE_FOR_MIGRATION");
  assert.deepEqual(result.counts, { legacyMedia: 14, assets: 0, links: 0 });
  assert.ok(pool.statements.includes("BEGIN READ ONLY"));
  assert.equal(pool.statements.some((statement) => /^(CREATE|LOCK TABLE)/.test(statement)), false);
});

test("shared-media migration adds only empty target tables and preserves legacy row count", async () => {
  const pool = createMigrationPool();
  const result = await migrateSharedMedia(pool);
  assert.equal(result.migrated, true);
  assert.equal(result.postcheck.state, "ALREADY_CANONICAL");
  assert.deepEqual(result.postcheck.counts, { legacyMedia: 14, assets: 0, links: 0 });
  assert.equal(pool.isTarget(), true);
  assert.ok(pool.statements.includes("LOCK TABLE media IN ACCESS SHARE MODE"));
  assert.equal(pool.statements.filter((statement) => /^(CREATE TABLE|CREATE (?:UNIQUE )?INDEX)/.test(statement)).length, 6);
  assert.equal(pool.statements.at(-1), "COMMIT");
  assert.equal(pool.statements.some((statement) => /^(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/.test(statement)), false);
});

test("already canonical shared-media schema is an apply no-op", async () => {
  const pool = createMigrationPool({ target: true });
  const result = await migrateSharedMedia(pool);
  assert.equal(result.migrated, false);
  assert.equal(result.postcheck.state, "ALREADY_CANONICAL");
  assert.equal(pool.statements.some((statement) => /^(CREATE TABLE|CREATE (?:UNIQUE )?INDEX)/.test(statement)), false);
});

test("migration fails closed if additive DDL changes legacy WhatsApp media count", async () => {
  const pool = createMigrationPool({ rowCountDrift: true });
  await assert.rejects(
    migrateSharedMedia(pool),
    (error) => error?.code === "SHARED_MEDIA_SCHEMA_INVALID" && error?.reason === "LEGACY_ROW_COUNT_DRIFT"
  );
  assert.ok(pool.statements.includes("ROLLBACK"));
  assert.equal(pool.statements.includes("COMMIT"), false);
});

test("legacy media absence blocks the migration before DDL", async () => {
  const pool = createMigrationPool({ legacyMissing: true });
  await assert.rejects(
    preflightSharedMedia(pool),
    (error) => error?.code === "SHARED_MEDIA_LEGACY_MEDIA_UNAVAILABLE"
  );
  assert.equal(pool.statements.some((statement) => /^CREATE/.test(statement)), false);
});

test("DDL failure produces bounded diagnostics and rollback", async () => {
  const pool = createMigrationPool({ failOn: "CREATE TABLE media_assets" });
  let failure;
  try {
    await migrateSharedMedia(pool);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.deepEqual(getSharedMediaMigrationDiagnostic(failure), {
    stage: "DDL_EXECUTION",
    code: "DATABASE_OPERATION_FAILED",
    transaction: "STARTED",
    rollback: "COMPLETED",
    ddl_started: true,
    reason: null
  });
  assert.ok(pool.statements.includes("ROLLBACK"));
});

test("CLI requires an explicit mode and only reports non-content counts", async () => {
  const events = [];
  const logger = { log(value) { events.push(["log", value]); }, error(value) { events.push(["error", value]); } };
  const pool = createMigrationPool({ target: true });
  const success = await runSharedMediaMigrationCli({
    argv: ["--preflight"],
    environment: { DATABASE_URL: "postgres://not-a-real-server" },
    createPool: async () => pool,
    logger
  });
  assert.equal(success, true);
  assert.ok(events.some(([, value]) => value === "SHARED_MEDIA_PREFLIGHT ALREADY_CANONICAL"));
  assert.equal(events.some(([, value]) => /profile:|message:|storage_key|mime_type/i.test(value)), false);
  const invalid = await runSharedMediaMigrationCli({ argv: [], environment: {}, logger });
  assert.equal(invalid, false);
});

test("fixed SQL is additive and does not change legacy WhatsApp media", () => {
  const source = readFileSync(new URL("../migrations/20260925_shared_media_foundation.sql", import.meta.url), "utf8");
  const executable = source.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
  assert.match(executable, /CREATE TABLE media_assets/);
  assert.match(executable, /CREATE TABLE media_asset_links/);
  assert.match(executable, /REFERENCES media_assets\(asset_id\) ON DELETE RESTRICT/);
  assert.doesNotMatch(executable, /(?:^|[;\n])\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE|DROP|ALTER\s+TABLE\s+media\b|CREATE\s+TRIGGER|CREATE\s+FUNCTION)\b/i);
});
