import {
  canonicalCheckDefinition,
  tokenizeSchemaSql
} from "../device-bridge/schema-contract.js";

/*
 * Operator-owned, additive schema authority. Runtime code never imports or
 * invokes this module. It deliberately leaves the legacy WhatsApp `media`
 * table and every product row unchanged.
 */
export const SHARED_MEDIA_MIGRATION_STATEMENTS = Object.freeze([
  `CREATE TABLE media_assets (
    asset_id UUID PRIMARY KEY,
    source_channel TEXT NOT NULL
      CONSTRAINT media_assets_source_channel_not_blank CHECK (btrim(source_channel) <> ''),
    source_reference TEXT,
    media_type TEXT NOT NULL
      CONSTRAINT media_assets_media_type_check
        CHECK (media_type IN ('image', 'video', 'sticker', 'audio', 'document', 'file')),
    mime_type TEXT,
    storage_key TEXT,
    thumbnail_storage_key TEXT,
    byte_size BIGINT
      CONSTRAINT media_assets_byte_size_nonnegative CHECK (byte_size IS NULL OR byte_size >= 0),
    width INTEGER
      CONSTRAINT media_assets_width_positive CHECK (width IS NULL OR width > 0),
    height INTEGER
      CONSTRAINT media_assets_height_positive CHECK (height IS NULL OR height > 0),
    duration_ms BIGINT
      CONSTRAINT media_assets_duration_nonnegative CHECK (duration_ms IS NULL OR duration_ms >= 0),
    availability TEXT NOT NULL DEFAULT 'AVAILABLE'
      CONSTRAINT media_assets_availability_check CHECK (availability IN ('AVAILABLE', 'UNAVAILABLE')),
    unavailable_reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT media_assets_storage_contract_check CHECK (
      (availability = 'AVAILABLE' AND storage_key IS NOT NULL)
      OR (
        availability = 'UNAVAILABLE'
        AND storage_key IS NULL
        AND thumbnail_storage_key IS NULL
        AND unavailable_reason IS NOT NULL
      )
    )
  )`,
  `CREATE UNIQUE INDEX media_assets_storage_key_unique
    ON media_assets(storage_key)
    WHERE storage_key IS NOT NULL`,
  `CREATE UNIQUE INDEX media_assets_thumbnail_storage_key_unique
    ON media_assets(thumbnail_storage_key)
    WHERE thumbnail_storage_key IS NOT NULL`,
  `CREATE TABLE media_asset_links (
    link_id UUID PRIMARY KEY,
    asset_id UUID NOT NULL
      REFERENCES media_assets(asset_id) ON DELETE RESTRICT,
    owner_channel TEXT NOT NULL
      CONSTRAINT media_asset_links_owner_channel_not_blank CHECK (btrim(owner_channel) <> ''),
    owner_type TEXT NOT NULL
      CONSTRAINT media_asset_links_owner_type_not_blank CHECK (btrim(owner_type) <> ''),
    owner_reference TEXT NOT NULL
      CONSTRAINT media_asset_links_owner_reference_not_blank CHECK (btrim(owner_reference) <> ''),
    relationship_type TEXT NOT NULL DEFAULT 'attachment'
      CONSTRAINT media_asset_links_relationship_type_not_blank CHECK (btrim(relationship_type) <> ''),
    ordinal INTEGER
      CONSTRAINT media_asset_links_ordinal_nonnegative CHECK (ordinal IS NULL OR ordinal >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX media_asset_links_owner_lookup_idx
    ON media_asset_links(owner_channel, owner_type, owner_reference, created_at DESC)`,
  `CREATE INDEX media_asset_links_asset_idx
    ON media_asset_links(asset_id)`
]);

export const SHARED_MEDIA_MIGRATION_STAGES = Object.freeze([
  "DATABASE_CONNECTION",
  "TRANSACTION_BEGIN",
  "TRANSACTION_SETTINGS",
  "ADVISORY_LOCK",
  "PREFLIGHT",
  "LEGACY_MEDIA_LOCK",
  "LOCKED_PREFLIGHT",
  "DDL_EXECUTION",
  "POSTCHECK",
  "COMMIT",
  "ROLLBACK",
  "CLEANUP",
  "UNKNOWN"
]);

const TARGET_TABLES = Object.freeze(["media_assets", "media_asset_links"]);
const ADVISORY_LOCK_NAMESPACE = 7421;
const ADVISORY_LOCK_KEY = 26;
const FAILURE_DIAGNOSTICS = new WeakMap();

const EXPECTED_COLUMNS = Object.freeze({
  media_assets: Object.freeze({
    asset_id: ["uuid", "NO", null],
    source_channel: ["text", "NO", null],
    source_reference: ["text", "YES", null],
    media_type: ["text", "NO", null],
    mime_type: ["text", "YES", null],
    storage_key: ["text", "YES", null],
    thumbnail_storage_key: ["text", "YES", null],
    byte_size: ["int8", "YES", null],
    width: ["int4", "YES", null],
    height: ["int4", "YES", null],
    duration_ms: ["int8", "YES", null],
    availability: ["text", "NO", "'AVAILABLE'"],
    unavailable_reason: ["text", "YES", null],
    metadata: ["jsonb", "NO", "'{}'"],
    created_at: ["timestamptz", "NO", "now"]
  }),
  media_asset_links: Object.freeze({
    link_id: ["uuid", "NO", null],
    asset_id: ["uuid", "NO", null],
    owner_channel: ["text", "NO", null],
    owner_type: ["text", "NO", null],
    owner_reference: ["text", "NO", null],
    relationship_type: ["text", "NO", "'attachment'"],
    ordinal: ["int4", "YES", null],
    created_at: ["timestamptz", "NO", "now"]
  })
});

const EXPECTED_CHECKS = Object.freeze({
  "media_assets_source_channel_not_blank": canonicalCheckDefinition("CHECK (btrim(source_channel) <> '')"),
  "media_assets_media_type_check": canonicalCheckDefinition("CHECK (media_type IN ('image', 'video', 'sticker', 'audio', 'document', 'file'))"),
  "media_assets_byte_size_nonnegative": canonicalCheckDefinition("CHECK (byte_size IS NULL OR byte_size >= 0)"),
  "media_assets_width_positive": canonicalCheckDefinition("CHECK (width IS NULL OR width > 0)"),
  "media_assets_height_positive": canonicalCheckDefinition("CHECK (height IS NULL OR height > 0)"),
  "media_assets_duration_nonnegative": canonicalCheckDefinition("CHECK (duration_ms IS NULL OR duration_ms >= 0)"),
  "media_assets_availability_check": canonicalCheckDefinition("CHECK (availability IN ('AVAILABLE', 'UNAVAILABLE'))"),
  "media_assets_storage_contract_check": canonicalCheckDefinition(
    "CHECK ((availability = 'AVAILABLE' AND storage_key IS NOT NULL) OR (availability = 'UNAVAILABLE' AND storage_key IS NULL AND thumbnail_storage_key IS NULL AND unavailable_reason IS NOT NULL))"
  ),
  "media_asset_links_owner_channel_not_blank": canonicalCheckDefinition("CHECK (btrim(owner_channel) <> '')"),
  "media_asset_links_owner_type_not_blank": canonicalCheckDefinition("CHECK (btrim(owner_type) <> '')"),
  "media_asset_links_owner_reference_not_blank": canonicalCheckDefinition("CHECK (btrim(owner_reference) <> '')"),
  "media_asset_links_relationship_type_not_blank": canonicalCheckDefinition("CHECK (btrim(relationship_type) <> '')"),
  "media_asset_links_ordinal_nonnegative": canonicalCheckDefinition("CHECK (ordinal IS NULL OR ordinal >= 0)")
});

function canonicalDefault(value) {
  if (value === null || value === undefined) return null;
  return tokenizeSchemaSql(value).filter((token) => token !== "(" && token !== ")").join("");
}

function columns(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value === "") return [];
  return value.replace(/^\{/, "").replace(/\}$/, "").split(",");
}

function sameColumns(actual, expected) {
  const values = columns(actual);
  return values.length === expected.length && values.every((value, index) => value === expected[index]);
}

function exactlyOne(rows, predicate) {
  return rows.filter(predicate).length === 1;
}

function canonicalIndexShape(value) {
  const tokens = tokenizeSchemaSql(value);
  const on = tokens.indexOf("on");
  if (on >= 0 && tokens[on + 2] === ".") tokens.splice(on + 1, 2);
  return tokens.filter((token) => token !== "(" && token !== ")").join("");
}

const EXPECTED_INDEXES = Object.freeze({
  media_assets_storage_key_unique: canonicalIndexShape(
    "CREATE UNIQUE INDEX media_assets_storage_key_unique ON media_assets USING btree (storage_key) WHERE storage_key IS NOT NULL"
  ),
  media_assets_thumbnail_storage_key_unique: canonicalIndexShape(
    "CREATE UNIQUE INDEX media_assets_thumbnail_storage_key_unique ON media_assets USING btree (thumbnail_storage_key) WHERE thumbnail_storage_key IS NOT NULL"
  ),
  media_asset_links_owner_lookup_idx: canonicalIndexShape(
    "CREATE INDEX media_asset_links_owner_lookup_idx ON media_asset_links USING btree (owner_channel, owner_type, owner_reference, created_at DESC)"
  ),
  media_asset_links_asset_idx: canonicalIndexShape(
    "CREATE INDEX media_asset_links_asset_idx ON media_asset_links USING btree (asset_id)"
  )
});

export class SharedMediaMigrationError extends Error {
  constructor(code, message, reason = null) {
    super(message);
    this.name = "SharedMediaMigrationError";
    this.code = code;
    this.reason = reason;
  }
}
function fail(code, message, reason = null) {
  throw new SharedMediaMigrationError(code, message, reason);
}

function hasExpectedColumns(actual, expected) {
  if (actual.length !== Object.keys(expected).length) return false;
  return Object.entries(expected).every(([name, [type, nullable, defaultValue]]) => {
    const row = actual.find((entry) => entry.column_name === name);
    return row?.udt_name === type
      && row?.is_nullable === nullable
      && canonicalDefault(row?.column_default) === defaultValue;
  });
}

function hasExpectedConstraints(constraints) {
  const expectedCount = 16;
  if (constraints.length !== expectedCount) return false;
  const primaryAssets = exactlyOne(constraints, (row) => row.table_name === "media_assets"
    && row.contype === "p" && sameColumns(row.columns, ["asset_id"]));
  const primaryLinks = exactlyOne(constraints, (row) => row.table_name === "media_asset_links"
    && row.contype === "p" && sameColumns(row.columns, ["link_id"]));
  const assetForeignKey = exactlyOne(constraints, (row) => row.table_name === "media_asset_links"
    && row.contype === "f" && row.reference_table === "media_assets"
    && row.confdeltype === "r" && row.confupdtype === "a"
    && row.condeferrable === false && row.condeferred === false
    && sameColumns(row.columns, ["asset_id"]));
  const checks = Object.entries(EXPECTED_CHECKS).every(([name, expected]) => exactlyOne(constraints, (row) => row.conname === name
    && row.contype === "c" && canonicalCheckDefinition(row.definition) === expected));
  return primaryAssets && primaryLinks && assetForeignKey && checks;
}

function hasExpectedIndexes(indexes) {
  return indexes.length === Object.keys(EXPECTED_INDEXES).length
    && Object.entries(EXPECTED_INDEXES).every(([name, shape]) => indexes.filter((row) => row.indexname === name
      && canonicalIndexShape(row.indexdef) === shape).length === 1);
}

function catalogState(catalog) {
  if (catalog.relations.length === 0) return { state: "ELIGIBLE_FOR_MIGRATION", reason: null };
  const names = catalog.relations.map((row) => row.table_name).sort().join(",");
  if (names !== "media_asset_links,media_assets" || catalog.relations.some((row) => row.relkind !== "r")) {
    return { state: "INVALID", reason: "RELATIONS" };
  }
  if (!Object.entries(EXPECTED_COLUMNS).every(([table, expected]) =>
    hasExpectedColumns(catalog.columns.filter((row) => row.table_name === table), expected)
  )) return { state: "INVALID", reason: "COLUMN_SHAPE" };
  if (!hasExpectedConstraints(catalog.constraints)) return { state: "INVALID", reason: "CONSTRAINTS" };
  if (!hasExpectedIndexes(catalog.indexes)) return { state: "INVALID", reason: "INDEXES" };
  if (Number(catalog.triggers) !== 0) return { state: "INVALID", reason: "TRIGGERS" };
  return { state: "ALREADY_CANONICAL", reason: null };
}

async function assertLegacyMediaFoundation(client) {
  const result = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = current_schema()
        AND relation.relname = 'media'
        AND relation.relkind = 'r'
    ) AS available
  `);
  if (result.rows[0]?.available !== true) {
    fail("SHARED_MEDIA_LEGACY_MEDIA_UNAVAILABLE", "The legacy WhatsApp media table is unavailable.");
  }
}

async function readCatalog(client) {
  const relations = await client.query(`
    SELECT c.relname AS table_name, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[])
    ORDER BY c.relname
  `, [TARGET_TABLES]);
  const columnRows = await client.query(`
    SELECT table_name, column_name, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
    ORDER BY table_name, ordinal_position
  `, [TARGET_TABLES]);
  const constraintRows = await client.query(`
    SELECT rel.relname AS table_name, con.contype, con.conname,
      COALESCE((SELECT string_agg(attr.attname, ',' ORDER BY key.ordinal)
        FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinal)
        JOIN pg_attribute attr ON attr.attrelid = con.conrelid AND attr.attnum = key.attnum), '') AS columns,
      ref.relname AS reference_table, con.confdeltype, con.confupdtype,
      con.condeferrable, con.condeferred, pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace namespace ON namespace.oid = rel.relnamespace
    LEFT JOIN pg_class ref ON ref.oid = con.confrelid
    WHERE namespace.nspname = current_schema() AND rel.relname = ANY($1::text[])
      AND con.contype IN ('p', 'f', 'u', 'c')
    ORDER BY rel.relname, con.conname
  `, [TARGET_TABLES]);
  const indexRows = await client.query(`
    SELECT relation.relname AS table_name, index_relation.relname AS indexname,
      pg_get_indexdef(index_relation.oid) AS indexdef
    FROM pg_index index_entry
    JOIN pg_class relation ON relation.oid = index_entry.indrelid
    JOIN pg_class index_relation ON index_relation.oid = index_entry.indexrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_constraint constraint_entry ON constraint_entry.conindid = index_entry.indexrelid
    WHERE namespace.nspname = current_schema() AND relation.relname = ANY($1::text[])
      AND constraint_entry.oid IS NULL
    ORDER BY relation.relname, index_relation.relname
  `, [TARGET_TABLES]);
  const triggers = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema() AND relation.relname = ANY($1::text[])
      AND NOT trigger.tgisinternal
  `, [TARGET_TABLES]);
  return {
    relations: relations.rows,
    columns: columnRows.rows,
    constraints: constraintRows.rows,
    indexes: indexRows.rows,
    triggers: triggers.rows[0]?.count ?? -1
  };
}

async function counts(client, includeShared) {
  const result = await client.query(includeShared
    ? `SELECT
        (SELECT COUNT(*)::int FROM media) AS legacy_media,
        (SELECT COUNT(*)::int FROM media_assets) AS assets,
        (SELECT COUNT(*)::int FROM media_asset_links) AS links`
    : `SELECT (SELECT COUNT(*)::int FROM media) AS legacy_media`);
  const row = result.rows[0] || {};
  return Object.freeze({
    legacyMedia: Number(row.legacy_media),
    assets: includeShared ? Number(row.assets) : 0,
    links: includeShared ? Number(row.links) : 0
  });
}

export async function inspectSharedMediaSchema(client) {
  await assertLegacyMediaFoundation(client);
  const catalog = await readCatalog(client);
  const state = catalogState(catalog);
  if (state.state === "INVALID") {
    fail("SHARED_MEDIA_SCHEMA_INVALID", "Shared media schema is neither the empty baseline nor the canonical target.", state.reason);
  }
  return Object.freeze({
    state: state.state,
    counts: await counts(client, state.state === "ALREADY_CANONICAL")
  });
}

export async function preflightSharedMedia(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await inspectSharedMediaSchema(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function diagnosticCode(stage, error) {
  if (["SHARED_MEDIA_SCHEMA_INVALID", "SHARED_MEDIA_LEGACY_MEDIA_UNAVAILABLE"].includes(error?.code)) return error.code;
  if (stage === "ADVISORY_LOCK" && error?.code === "SHARED_MEDIA_ADVISORY_LOCK_UNAVAILABLE") {
    return error.code;
  }
  if (stage === "LEGACY_MEDIA_LOCK" && error?.code === "55P03") return "LOCK_TIMEOUT";
  if (stage === "COMMIT") return "COMMIT_OUTCOME_UNRESOLVED";
  if (stage === "CLEANUP") return "CLEANUP_FAILED";
  return "DATABASE_OPERATION_FAILED";
}

function attachDiagnostic(error, state) {
  const diagnostic = Object.freeze({
    stage: SHARED_MEDIA_MIGRATION_STAGES.includes(state.stage) ? state.stage : "UNKNOWN",
    code: diagnosticCode(state.stage, error),
    transaction: state.commitConfirmed
      ? "COMMITTED"
      : state.commitAttempted
        ? "COMMIT_OUTCOME_UNKNOWN"
        : state.transactionStarted
          ? "STARTED"
          : "NOT_STARTED",
    rollback: state.rollbackAttempted ? state.rollbackCompleted ? "COMPLETED" : "FAILED" : "NOT_ATTEMPTED",
    ddl_started: state.ddlStarted,
    reason: typeof error?.reason === "string" ? error.reason : null
  });
  if (error && (typeof error === "object" || typeof error === "function")) FAILURE_DIAGNOSTICS.set(error, diagnostic);
  return error;
}

export function getSharedMediaMigrationDiagnostic(error) {
  const diagnostic = error && typeof error === "object" ? FAILURE_DIAGNOSTICS.get(error) : null;
  return diagnostic ? { ...diagnostic } : null;
}

async function configureMigrationTransaction(client) {
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '30s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
}

async function acquireMigrationLock(client) {
  const result = await client.query(
    `SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE}, ${ADVISORY_LOCK_KEY}) AS acquired`
  );
  if (result.rows[0]?.acquired !== true) {
    const error = new Error("Shared media migration is already running.");
    error.code = "SHARED_MEDIA_ADVISORY_LOCK_UNAVAILABLE";
    throw error;
  }
}

async function lockLegacyMedia(client) {
  // The existing WhatsApp media table is read-only from this migration. This
  // lock only prevents concurrent destructive schema drift while preflight
  // and postcheck prove it was not changed.
  await client.query("LOCK TABLE media IN ACCESS SHARE MODE");
}

/**
 * Explicit, single-use local/production operator command. It creates empty
 * shared tables only; it never migrates or alters legacy WhatsApp media rows.
 */
export async function migrateSharedMedia(pool) {
  let client;
  let releaseError;
  let discardClient = false;
  const state = {
    stage: "DATABASE_CONNECTION",
    transactionStarted: false,
    commitAttempted: false,
    commitConfirmed: false,
    rollbackAttempted: false,
    rollbackCompleted: false,
    ddlStarted: false
  };
  try {
    client = await pool.connect();
    state.stage = "TRANSACTION_BEGIN";
    await client.query("BEGIN");
    state.transactionStarted = true;
    state.stage = "TRANSACTION_SETTINGS";
    await configureMigrationTransaction(client);
    state.stage = "ADVISORY_LOCK";
    await acquireMigrationLock(client);
    state.stage = "PREFLIGHT";
    const preflight = await inspectSharedMediaSchema(client);
    state.stage = "LEGACY_MEDIA_LOCK";
    await lockLegacyMedia(client);
    state.stage = "LOCKED_PREFLIGHT";
    const lockedPreflight = await inspectSharedMediaSchema(client);
    if (lockedPreflight.state !== preflight.state || lockedPreflight.counts.legacyMedia !== preflight.counts.legacyMedia) {
      fail("SHARED_MEDIA_SCHEMA_INVALID", "Shared media baseline changed during locked preflight.", "PREFLIGHT_DRIFT");
    }

    let migrated = false;
    if (lockedPreflight.state === "ELIGIBLE_FOR_MIGRATION") {
      state.stage = "DDL_EXECUTION";
      for (const statement of SHARED_MEDIA_MIGRATION_STATEMENTS) {
        state.ddlStarted = true;
        await client.query(statement);
      }
      migrated = true;
    }

    state.stage = "POSTCHECK";
    const postcheck = await inspectSharedMediaSchema(client);
    if (postcheck.state !== "ALREADY_CANONICAL") {
      fail("SHARED_MEDIA_SCHEMA_INVALID", "Shared media postcheck did not reach canonical state.", "POSTCHECK_STATE");
    }
    if (postcheck.counts.legacyMedia !== lockedPreflight.counts.legacyMedia) {
      fail("SHARED_MEDIA_SCHEMA_INVALID", "The additive migration changed legacy WhatsApp media rows.", "LEGACY_ROW_COUNT_DRIFT");
    }
    if (migrated && (postcheck.counts.assets !== 0 || postcheck.counts.links !== 0)) {
      fail("SHARED_MEDIA_SCHEMA_INVALID", "The additive migration created shared media product rows.", "UNEXPECTED_DATA_MUTATION");
    }

    state.stage = "COMMIT";
    state.commitAttempted = true;
    await client.query("COMMIT");
    state.commitConfirmed = true;
    return Object.freeze({ migrated, postcheck });
  } catch (error) {
    releaseError = error;
    const failedStage = state.stage;
    if (state.transactionStarted && !state.commitAttempted) {
      state.rollbackAttempted = true;
      try {
        await client.query("ROLLBACK");
        state.rollbackCompleted = true;
      } catch {
        discardClient = true;
      }
    } else {
      discardClient = true;
    }
    state.stage = failedStage;
    throw attachDiagnostic(error, state);
  } finally {
    try {
      client?.release(discardClient ? releaseError : undefined);
    } catch (error) {
      state.stage = "CLEANUP";
      throw attachDiagnostic(error, state);
    }
  }
}
