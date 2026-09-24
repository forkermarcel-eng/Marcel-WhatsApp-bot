import {
  canonicalCheckDefinition,
  tokenizeSchemaSql
} from "../device-bridge/schema-contract.js";

/*
 * Explicit, additive Block-2 Match mirror migration. It is deliberately a
 * separate, single-use authority: normal runtime code never creates schema
 * and this migration never reads, rewrites, or deletes product rows.
 */

export const TINDER_MATCH_MIGRATION_STATEMENTS = Object.freeze([
  `ALTER TABLE tinder_conversations
     ADD CONSTRAINT tinder_conversations_conversation_id_device_id_key
     UNIQUE (conversation_id, device_id)`,
  `CREATE TABLE tinder_matches (
     match_id UUID PRIMARY KEY,
     device_id UUID NOT NULL REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT,
     conversation_id UUID NULL,
     tile JSONB NOT NULL,
     carousel_position INTEGER NOT NULL CHECK (carousel_position >= 0),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT tinder_matches_conversation_device_fkey
       FOREIGN KEY (conversation_id, device_id)
       REFERENCES tinder_conversations(conversation_id, device_id)
       ON DELETE RESTRICT
  )`,
  `CREATE INDEX tinder_matches_device_carousel_position_idx
     ON tinder_matches(device_id, carousel_position)`
]);

export const TINDER_MATCH_MIGRATION_STAGES = Object.freeze([
  "DATABASE_CONNECTION",
  "TRANSACTION_BEGIN",
  "TRANSACTION_SETTINGS",
  "ADVISORY_LOCK",
  "PREFLIGHT",
  "TINDER_TABLE_LOCK",
  "LOCKED_PREFLIGHT",
  "DDL_EXECUTION",
  "POSTCHECK",
  "COMMIT",
  "ROLLBACK",
  "CLEANUP",
  "UNKNOWN"
]);

const TARGET_TABLES = Object.freeze([
  "tinder_conversations",
  "tinder_conversation_messages",
  "tinder_matches"
]);
const ADVISORY_LOCK_NAMESPACE = 7421;
const ADVISORY_LOCK_KEY = 25;
const FAILURE_DIAGNOSTICS = new WeakMap();

const BASELINE_COLUMNS = Object.freeze({
  tinder_conversations: Object.freeze({
    conversation_id: ["uuid", "NO"],
    device_id: ["uuid", "NO"],
    channel: ["text", "NO"],
    profile: ["jsonb", "NO"],
    history_complete: ["bool", "NO"],
    profile_synced_at: ["timestamptz", "YES"],
    history_synced_at: ["timestamptz", "YES"],
    created_at: ["timestamptz", "NO"],
    updated_at: ["timestamptz", "NO"],
    last_message_visible_time: ["text", "YES"],
    inbox_position: ["int4", "YES"]
  }),
  tinder_conversation_messages: Object.freeze({
    message_id: ["uuid", "NO"],
    conversation_id: ["uuid", "NO"],
    ordinal: ["int4", "NO"],
    direction: ["text", "NO"],
    message_text: ["text", "NO"],
    visible_time: ["text", "YES"],
    visible_status: ["text", "YES"],
    created_at: ["timestamptz", "NO"]
  })
});

const TARGET_COLUMNS = Object.freeze({
  ...BASELINE_COLUMNS,
  tinder_matches: Object.freeze({
    match_id: ["uuid", "NO"],
    device_id: ["uuid", "NO"],
    conversation_id: ["uuid", "YES"],
    tile: ["jsonb", "NO"],
    carousel_position: ["int4", "NO"],
    created_at: ["timestamptz", "NO"],
    updated_at: ["timestamptz", "NO"]
  })
});

const EXPECTED_DEFAULTS = Object.freeze({
  tinder_conversations: Object.freeze({
    conversation_id: null,
    device_id: null,
    channel: "'tinder'",
    profile: "'{}'",
    history_complete: "false",
    profile_synced_at: null,
    history_synced_at: null,
    created_at: "now",
    updated_at: "now",
    last_message_visible_time: null,
    inbox_position: null
  }),
  tinder_conversation_messages: Object.freeze({
    message_id: null,
    conversation_id: null,
    ordinal: null,
    direction: null,
    message_text: null,
    visible_time: null,
    visible_status: null,
    created_at: "now"
  }),
  tinder_matches: Object.freeze({
    match_id: null,
    device_id: null,
    conversation_id: null,
    tile: null,
    carousel_position: null,
    created_at: "now",
    updated_at: "now"
  })
});

const EXPECTED_CHECKS = Object.freeze({
  channel: canonicalCheckDefinition("CHECK (channel = 'tinder')"),
  ordinal: canonicalCheckDefinition("CHECK (ordinal >= 0)"),
  direction: canonicalCheckDefinition("CHECK (direction IN ('INBOUND', 'OUTBOUND'))"),
  inboxPosition: canonicalCheckDefinition("CHECK (inbox_position IS NULL OR inbox_position >= 0)"),
  carouselPosition: canonicalCheckDefinition("CHECK (carousel_position >= 0)")
});

function canonicalIndexShape(value) {
  const tokens = tokenizeSchemaSql(value);
  const onIndex = tokens.indexOf("on");
  if (onIndex >= 0 && tokens[onIndex + 2] === ".") tokens.splice(onIndex + 1, 2);
  return tokens.filter(token => token !== "(" && token !== ")").join("");
}

const EXPECTED_INDEXES = Object.freeze({
  deviceUpdated: canonicalIndexShape(
    "CREATE INDEX tinder_conversations_device_updated_idx ON tinder_conversations USING btree (device_id, updated_at DESC)"
  ),
  messageOrdinal: canonicalIndexShape(
    "CREATE INDEX tinder_conversation_messages_conversation_ordinal_idx ON tinder_conversation_messages USING btree (conversation_id, ordinal)"
  ),
  deviceInboxPosition: canonicalIndexShape(
    "CREATE INDEX tinder_conversations_device_inbox_position_idx ON tinder_conversations USING btree (device_id, inbox_position)"
  ),
  matchCarouselPosition: canonicalIndexShape(
    "CREATE INDEX tinder_matches_device_carousel_position_idx ON tinder_matches USING btree (device_id, carousel_position)"
  )
});

export class TinderMatchMigrationError extends Error {
  constructor(code, message, reason = null) {
    super(message);
    this.name = "TinderMatchMigrationError";
    this.code = code;
    this.reason = reason;
  }
}

function fail(code, message, reason = null) {
  throw new TinderMatchMigrationError(code, message, reason);
}

function asColumns(actual) {
  if (Array.isArray(actual)) return actual;
  if (typeof actual !== "string" || actual === "") return [];
  return actual.replace(/^\{/, "").replace(/\}$/, "").split(",");
}

function sameColumns(actual, expected) {
  const values = asColumns(actual);
  return values.length === expected.length && values.every((value, index) => value === expected[index]);
}

function exactlyOne(rows, predicate) {
  return rows.filter(predicate).length === 1;
}

function canonicalDefault(value) {
  if (value === null || value === undefined) return null;
  return tokenizeSchemaSql(value).filter(token => token !== "(" && token !== ")").join("");
}

function hasExpectedColumns(columns, expectedColumns) {
  if (columns.length !== Object.keys(expectedColumns).length) return false;
  return Object.entries(expectedColumns).every(([columnName, [type, nullable]]) => {
    const column = columns.find(row => row.column_name === columnName);
    const expectedDefault = EXPECTED_DEFAULTS[column?.table_name]?.[columnName];
    return column?.udt_name === type
      && column?.is_nullable === nullable
      && canonicalDefault(column?.column_default) === expectedDefault;
  });
}

function isExactCheck(row, kind) {
  return canonicalCheckDefinition(row.definition) === EXPECTED_CHECKS[kind];
}

function isRestrictForeignKey(row, columns, referenceTable) {
  return row.contype === "f"
    && sameColumns(row.columns, columns)
    && row.reference_table === referenceTable
    && row.confdeltype === "r"
    && row.confupdtype === "a"
    && row.condeferrable === false
    && row.condeferred === false;
}

function hasBaseConstraints(constraints) {
  const conversations = constraints.filter(row => row.table_name === "tinder_conversations");
  const messages = constraints.filter(row => row.table_name === "tinder_conversation_messages");
  return exactlyOne(conversations, row => row.contype === "p" && sameColumns(row.columns, ["conversation_id"]))
    && exactlyOne(conversations, row => isRestrictForeignKey(row, ["device_id"], "device_bridge_devices"))
    && exactlyOne(conversations, row => row.contype === "c" && isExactCheck(row, "channel"))
    && exactlyOne(conversations, row => row.contype === "c" && isExactCheck(row, "inboxPosition"))
    && exactlyOne(messages, row => row.contype === "p" && sameColumns(row.columns, ["message_id"]))
    && exactlyOne(messages, row => isRestrictForeignKey(row, ["conversation_id"], "tinder_conversations"))
    && exactlyOne(messages, row => row.contype === "u" && sameColumns(row.columns, ["conversation_id", "ordinal"]))
    && exactlyOne(messages, row => row.contype === "c" && isExactCheck(row, "ordinal"))
    && exactlyOne(messages, row => row.contype === "c" && isExactCheck(row, "direction"));
}

function hasTargetConstraints(constraints) {
  const conversations = constraints.filter(row => row.table_name === "tinder_conversations");
  const matches = constraints.filter(row => row.table_name === "tinder_matches");
  return exactlyOne(conversations, row => row.contype === "u"
    && row.conname === "tinder_conversations_conversation_id_device_id_key"
    && sameColumns(row.columns, ["conversation_id", "device_id"]))
    && exactlyOne(matches, row => row.contype === "p" && sameColumns(row.columns, ["match_id"]))
    && exactlyOne(matches, row => isRestrictForeignKey(row, ["device_id"], "device_bridge_devices"))
    && exactlyOne(matches, row => row.contype === "f"
      && row.conname === "tinder_matches_conversation_device_fkey"
      && sameColumns(row.columns, ["conversation_id", "device_id"])
      && row.reference_table === "tinder_conversations"
      && row.confdeltype === "r" && row.confupdtype === "a"
      && row.condeferrable === false && row.condeferred === false)
    && exactlyOne(matches, row => row.contype === "c" && isExactCheck(row, "carouselPosition"));
}

function hasExpectedIndexes(indexes, target) {
  const expected = target
    ? [
      EXPECTED_INDEXES.deviceUpdated,
      EXPECTED_INDEXES.messageOrdinal,
      EXPECTED_INDEXES.deviceInboxPosition,
      EXPECTED_INDEXES.matchCarouselPosition
    ]
    : [
      EXPECTED_INDEXES.deviceUpdated,
      EXPECTED_INDEXES.messageOrdinal,
      EXPECTED_INDEXES.deviceInboxPosition
    ];
  return indexes.length === expected.length
    && expected.every(shape => indexes.filter(row => canonicalIndexShape(row.indexdef) === shape).length === 1);
}

function catalogState(catalog) {
  if (catalog.relations.length === 0) return { state: "BASELINE_MISSING", reason: "RELATIONS" };
  const relationNames = catalog.relations.map(row => row.table_name).sort();
  const hasBaselineRelations = relationNames.join(",") === "tinder_conversation_messages,tinder_conversations";
  const hasTargetRelations = relationNames.join(",") === "tinder_conversation_messages,tinder_conversations,tinder_matches";
  if ((!hasBaselineRelations && !hasTargetRelations) || catalog.relations.some(row => row.relkind !== "r")) {
    return { state: "INVALID", reason: "RELATIONS" };
  }

  const baselineColumnsExact = Object.entries(BASELINE_COLUMNS).every(([table, expected]) =>
    hasExpectedColumns(catalog.columns.filter(row => row.table_name === table), expected)
  );
  if (!baselineColumnsExact) return { state: "INVALID", reason: "COLUMN_SHAPE" };
  const target = hasTargetRelations;
  if (target && !hasExpectedColumns(
    catalog.columns.filter(row => row.table_name === "tinder_matches"),
    TARGET_COLUMNS.tinder_matches
  )) return { state: "INVALID", reason: "MATCH_COLUMN_SHAPE" };

  const expectedConstraintCount = target ? 14 : 9;
  if (catalog.constraints.length !== expectedConstraintCount || !hasBaseConstraints(catalog.constraints)) {
    return { state: "INVALID", reason: "CONSTRAINTS" };
  }
  if (target !== hasTargetConstraints(catalog.constraints)) {
    return { state: "INVALID", reason: "MATCH_CONSTRAINTS" };
  }
  if (!hasExpectedIndexes(catalog.indexes, target)) return { state: "INVALID", reason: "INDEXES" };
  if (Number(catalog.triggers) !== 0) return { state: "INVALID", reason: "TRIGGERS" };
  return { state: target ? "ALREADY_CANONICAL" : "ELIGIBLE_FOR_MIGRATION", reason: null };
}

async function assertDeviceFoundation(client) {
  const result = await client.query(`
    SELECT a.atttypid::regtype::text AS type_name, a.attnotnull AS not_null,
      EXISTS (
        SELECT 1 FROM pg_constraint con
        WHERE con.conrelid = 'device_bridge_devices'::regclass
          AND con.contype = 'p' AND con.conkey = ARRAY[a.attnum]::smallint[]
      ) AS primary_key
    FROM pg_attribute a
    WHERE a.attrelid = 'device_bridge_devices'::regclass AND a.attname = 'device_id'
      AND a.attnum > 0 AND NOT a.attisdropped
  `);
  const row = result.rows[0];
  if (!row || row.type_name !== "uuid" || row.not_null !== true || row.primary_key !== true) {
    fail("TINDER_MATCH_FOUNDATION_INVALID", "The ordinary device foundation is unavailable.");
  }
}

async function readCatalog(client) {
  const relations = await client.query(`
    SELECT c.relname AS table_name, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])
    ORDER BY c.relname
  `, [TARGET_TABLES]);
  const columns = await client.query(`
    SELECT table_name, column_name, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name=ANY($1::text[])
    ORDER BY table_name, ordinal_position
  `, [TARGET_TABLES]);
  const constraints = await client.query(`
    SELECT rel.relname AS table_name, con.contype, con.conname,
      COALESCE((SELECT string_agg(attr.attname, ',' ORDER BY key.ordinal)
        FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinal)
        JOIN pg_attribute attr ON attr.attrelid=con.conrelid AND attr.attnum=key.attnum), '') AS columns,
      ref.relname AS reference_table, con.confdeltype, con.confupdtype,
      con.condeferrable, con.condeferred, pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
    JOIN pg_namespace namespace ON namespace.oid=rel.relnamespace
    LEFT JOIN pg_class ref ON ref.oid=con.confrelid
    WHERE namespace.nspname=current_schema() AND rel.relname=ANY($1::text[])
      -- Implicit PostgreSQL NOT NULL catalog constraints are represented by
      -- contype=n. Column nullability is checked independently above.
      AND con.contype IN ('p','f','u','c')
    ORDER BY rel.relname, con.conname
  `, [TARGET_TABLES]);
  const indexes = await client.query(`
    SELECT relation.relname AS table_name, index_relation.relname AS indexname,
      pg_get_indexdef(index_relation.oid) AS indexdef
    FROM pg_index index_entry
    JOIN pg_class relation ON relation.oid=index_entry.indrelid
    JOIN pg_class index_relation ON index_relation.oid=index_entry.indexrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    LEFT JOIN pg_constraint constraint_entry ON constraint_entry.conindid=index_entry.indexrelid
    WHERE namespace.nspname=current_schema() AND relation.relname=ANY($1::text[])
      AND constraint_entry.oid IS NULL
    ORDER BY relation.relname, index_relation.relname
  `, [TARGET_TABLES]);
  const triggers = await client.query(`
    SELECT COUNT(*)::int AS count FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid=trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname=current_schema() AND relation.relname=ANY($1::text[])
      AND NOT trigger.tgisinternal
  `, [TARGET_TABLES]);
  return {
    relations: relations.rows,
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    triggers: triggers.rows[0]?.count ?? -1
  };
}

async function productCounts(client, includeMatches) {
  const result = await client.query(includeMatches
    ? `SELECT (SELECT COUNT(*)::int FROM tinder_conversations) AS conversations,
        (SELECT COUNT(*)::int FROM tinder_conversation_messages) AS messages,
        (SELECT COUNT(*)::int FROM tinder_matches) AS matches`
    : `SELECT (SELECT COUNT(*)::int FROM tinder_conversations) AS conversations,
        (SELECT COUNT(*)::int FROM tinder_conversation_messages) AS messages`
  );
  const row = result.rows[0] || {};
  return Object.freeze({
    conversations: Number(row.conversations),
    messages: Number(row.messages),
    matches: includeMatches ? Number(row.matches) : 0
  });
}

export async function inspectTinderMatchSchema(client) {
  await assertDeviceFoundation(client);
  const catalog = await readCatalog(client);
  const checked = catalogState(catalog);
  if (checked.state === "BASELINE_MISSING") {
    fail("TINDER_MATCH_SCHEMA_INVALID", "The Block-2 mirror baseline is unavailable.", checked.reason);
  }
  if (checked.state === "INVALID") {
    fail(
      "TINDER_MATCH_SCHEMA_INVALID",
      "The Block-2 Match schema is neither the exact baseline nor the exact target.",
      checked.reason
    );
  }
  return Object.freeze({
    state: checked.state,
    counts: await productCounts(client, checked.state === "ALREADY_CANONICAL")
  });
}

export async function preflightTinderMatches(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await inspectTinderMatchSchema(client);
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
  if (["TINDER_MATCH_SCHEMA_INVALID", "TINDER_MATCH_FOUNDATION_INVALID"].includes(error?.code)) return error.code;
  if (stage === "ADVISORY_LOCK" && error?.code === "TINDER_MATCH_ADVISORY_LOCK_UNAVAILABLE") return error.code;
  if (stage === "TINDER_TABLE_LOCK" && error?.code === "55P03") return "LOCK_TIMEOUT";
  if (stage === "COMMIT") return "COMMIT_OUTCOME_UNRESOLVED";
  if (stage === "CLEANUP") return "CLEANUP_FAILED";
  return "DATABASE_OPERATION_FAILED";
}

function attachDiagnostic(error, state) {
  const diagnostic = Object.freeze({
    stage: TINDER_MATCH_MIGRATION_STAGES.includes(state.stage) ? state.stage : "UNKNOWN",
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

export function getTinderMatchMigrationDiagnostic(error) {
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
    const error = new Error("Tinder Match migration is already running.");
    error.code = "TINDER_MATCH_ADVISORY_LOCK_UNAVAILABLE";
    throw error;
  }
}

async function lockExistingMirrorTables(client) {
  // Never lock the target relation before CREATE TABLE: it does not exist in
  // the only eligible baseline. These are the existing predecessor tables.
  await client.query("LOCK TABLE tinder_conversations, tinder_conversation_messages IN ACCESS EXCLUSIVE MODE");
}

/**
 * The only authority to add Tinder Match storage. It does not insert, update,
 * delete, backfill, or otherwise mutate Tinder product rows.
 */
export async function migrateTinderMatches(pool) {
  let client;
  const state = {
    stage: "DATABASE_CONNECTION",
    transactionStarted: false,
    commitAttempted: false,
    commitConfirmed: false,
    rollbackAttempted: false,
    rollbackCompleted: false,
    ddlStarted: false
  };
  let releaseError;
  let discardClient = false;
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
    const preflight = await inspectTinderMatchSchema(client);
    state.stage = "TINDER_TABLE_LOCK";
    await lockExistingMirrorTables(client);
    state.stage = "LOCKED_PREFLIGHT";
    const lockedPreflight = await inspectTinderMatchSchema(client);
    if (lockedPreflight.state !== preflight.state) {
      fail("TINDER_MATCH_SCHEMA_INVALID", "Tinder Match schema changed during locked preflight.", "PREFLIGHT_DRIFT");
    }

    let migrated = false;
    if (lockedPreflight.state === "ELIGIBLE_FOR_MIGRATION") {
      state.stage = "DDL_EXECUTION";
      for (const statement of TINDER_MATCH_MIGRATION_STATEMENTS) {
        state.ddlStarted = true;
        await client.query(statement);
      }
      migrated = true;
    }

    state.stage = "POSTCHECK";
    const postcheck = await inspectTinderMatchSchema(client);
    if (postcheck.state !== "ALREADY_CANONICAL") {
      fail("TINDER_MATCH_SCHEMA_INVALID", "Tinder Match postcheck did not reach canonical state.", "POSTCHECK_STATE");
    }
    if (postcheck.counts.conversations !== lockedPreflight.counts.conversations
      || postcheck.counts.messages !== lockedPreflight.counts.messages) {
      fail("TINDER_MATCH_SCHEMA_INVALID", "The additive Match migration changed existing Tinder row counts.", "ROW_COUNT_DRIFT");
    }
    if (migrated && postcheck.counts.matches !== 0) {
      fail("TINDER_MATCH_SCHEMA_INVALID", "The Match migration created product Match rows.", "UNEXPECTED_DATA_MUTATION");
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
