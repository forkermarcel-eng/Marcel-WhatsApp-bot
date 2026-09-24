import { compactSchemaSql, tokenizeSchemaSql } from "../device-bridge/schema-contract.js";

/*
 * Block 2's only schema authority. This is deliberately separate from the
 * runtime mirror: it creates the two additive product tables once, inside one
 * operator-owned transaction, after a catalog-only preflight.
 */

export const TINDER_MIRROR_MIGRATION_STATEMENTS = Object.freeze([
  `CREATE TABLE tinder_conversations (
    conversation_id UUID PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT,
    channel TEXT NOT NULL DEFAULT 'tinder' CHECK (channel = 'tinder'),
    profile JSONB NOT NULL DEFAULT '{}'::jsonb,
    history_complete BOOLEAN NOT NULL DEFAULT FALSE,
    profile_synced_at TIMESTAMPTZ,
    history_synced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX tinder_conversations_device_updated_idx
     ON tinder_conversations(device_id, updated_at DESC)`,
  `CREATE TABLE tinder_conversation_messages (
    message_id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES tinder_conversations(conversation_id) ON DELETE RESTRICT,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    direction TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
    message_text TEXT NOT NULL,
    visible_time TEXT,
    visible_status TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (conversation_id, ordinal)
  )`,
  `CREATE INDEX tinder_conversation_messages_conversation_ordinal_idx
     ON tinder_conversation_messages(conversation_id, ordinal)`
]);

const TARGET_TABLES = Object.freeze(["tinder_conversations", "tinder_conversation_messages"]);
const EXPECTED_COLUMNS = Object.freeze({
  tinder_conversations: Object.freeze({
    conversation_id: ["uuid", "NO"], device_id: ["uuid", "NO"], channel: ["text", "NO"],
    profile: ["jsonb", "NO"], history_complete: ["bool", "NO"], profile_synced_at: ["timestamptz", "YES"],
    history_synced_at: ["timestamptz", "YES"], created_at: ["timestamptz", "NO"], updated_at: ["timestamptz", "NO"]
  }),
  tinder_conversation_messages: Object.freeze({
    message_id: ["uuid", "NO"], conversation_id: ["uuid", "NO"], ordinal: ["int4", "NO"],
    direction: ["text", "NO"], message_text: ["text", "NO"], visible_time: ["text", "YES"],
    visible_status: ["text", "YES"], created_at: ["timestamptz", "NO"]
  })
});

export const TINDER_MIRROR_MIGRATION_STAGES = Object.freeze([
  "DATABASE_CONNECTION", "TRANSACTION_BEGIN", "TRANSACTION_SETTINGS", "ADVISORY_LOCK", "PREFLIGHT",
  "LOCKED_PREFLIGHT", "DDL_EXECUTION", "POSTCHECK", "COMMIT", "ROLLBACK", "CLEANUP", "UNKNOWN"
]);

const MIGRATION_LOCK_NAMESPACE = 7421;
const MIGRATION_LOCK_KEY = 22;
const FAILURE_DIAGNOSTICS = new WeakMap();

export class TinderMirrorMigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TinderMirrorMigrationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TinderMirrorMigrationError(code, message);
}

function canonicalCheckShape(value) {
  let tokens = tokenizeSchemaSql(value);
  if (tokens[0] === "check" && tokens[1] === "(" && tokens.at(-1) === ")") tokens = tokens.slice(2, -1);
  const compact = tokens.filter((token) => token !== "(" && token !== ")").join("");
  const anyArray = compact.match(/^([a-z_][a-z0-9_$]*)=anyarray\[(.*)\]$/);
  return anyArray ? `${anyArray[1]}in${anyArray[2]}` : compact;
}

function canonicalIndexShape(value) {
  return compactSchemaSql(value).replace(/on(?:[a-z_][a-z0-9_$]*\.)+/g, "on");
}

const EXPECTED_CHECKS = Object.freeze({
  channel: canonicalCheckShape("CHECK (channel = 'tinder')"),
  ordinal: canonicalCheckShape("CHECK (ordinal >= 0)"),
  direction: canonicalCheckShape("CHECK (direction IN ('INBOUND', 'OUTBOUND'))")
});
const EXPECTED_INDEXES = Object.freeze({
  conversation: canonicalIndexShape("ON tinder_conversations USING btree (device_id, updated_at DESC)"),
  message: canonicalIndexShape("ON tinder_conversation_messages USING btree (conversation_id, ordinal)")
});

function sameColumns(actual, expected) {
  const values = Array.isArray(actual) ? actual : [];
  return values.length === expected.length && values.every((value, index) => value === expected[index]);
}

function isExactCheck(row, kind) {
  return canonicalCheckShape(row.definition) === EXPECTED_CHECKS[kind];
}

function hasSingle(rows, predicate) {
  return rows.filter(predicate).length === 1;
}

function targetCatalogFailureReason({ relations, columns, constraints, indexes, triggers }) {
  if (relations.length !== 2 || relations.some((row) => row.relkind !== "r")) return "RELATIONS";
  for (const [table, expectedColumns] of Object.entries(EXPECTED_COLUMNS)) {
    const actual = columns.filter((row) => row.table_name === table);
    if (actual.length !== Object.keys(expectedColumns).length) return "COLUMN_COUNT";
    for (const [column, [type, nullable]] of Object.entries(expectedColumns)) {
      const row = actual.find((item) => item.column_name === column);
      if (!row || row.udt_name !== type || row.is_nullable !== nullable) return "COLUMN_SHAPE";
    }
  }
  const onConversations = constraints.filter((row) => row.table_name === "tinder_conversations");
  const onMessages = constraints.filter((row) => row.table_name === "tinder_conversation_messages");
  if (!hasSingle(onConversations, (row) => row.contype === "p" && sameColumns(row.columns, ["conversation_id"]))) return "CONVERSATION_PRIMARY_KEY";
  if (!hasSingle(onConversations, (row) => row.contype === "f" && sameColumns(row.columns, ["device_id"])
    && row.reference_table === "device_bridge_devices" && row.confdeltype === "r")) return "CONVERSATION_DEVICE_FK";
  if (!hasSingle(onConversations, (row) => row.contype === "c" && isExactCheck(row, "channel"))) return "CONVERSATION_CHANNEL_CHECK";
  if (!hasSingle(onMessages, (row) => row.contype === "p" && sameColumns(row.columns, ["message_id"]))) return "MESSAGE_PRIMARY_KEY";
  if (!hasSingle(onMessages, (row) => row.contype === "f" && sameColumns(row.columns, ["conversation_id"])
    && row.reference_table === "tinder_conversations" && row.confdeltype === "r")) return "MESSAGE_CONVERSATION_FK";
  if (!hasSingle(onMessages, (row) => row.contype === "u" && sameColumns(row.columns, ["conversation_id", "ordinal"]))) return "MESSAGE_ORDINAL_UNIQUE";
  if (!hasSingle(onMessages, (row) => row.contype === "c" && isExactCheck(row, "ordinal"))) return "MESSAGE_ORDINAL_CHECK";
  if (!hasSingle(onMessages, (row) => row.contype === "c" && isExactCheck(row, "direction"))) return "MESSAGE_DIRECTION_CHECK";
  const conversationIndex = indexes.find((row) => row.indexname === "tinder_conversations_device_updated_idx");
  const messageIndex = indexes.find((row) => row.indexname === "tinder_conversation_messages_conversation_ordinal_idx");
  if (!conversationIndex || !messageIndex) return "INDEX_MISSING";
  if (!canonicalIndexShape(conversationIndex.indexdef).includes(EXPECTED_INDEXES.conversation)) return "CONVERSATION_INDEX";
  if (!canonicalIndexShape(messageIndex.indexdef).includes(EXPECTED_INDEXES.message)) return "MESSAGE_INDEX";
  return Number(triggers) === 0 ? null : "TRIGGERS";
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
    fail("TINDER_CONVERSATION_MIRROR_FOUNDATION_INVALID", "The ordinary device foundation is unavailable.");
  }
}

async function readTargetCatalog(client) {
  const relations = await client.query(`
    SELECT c.relname AS table_name, c.relkind
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[]) ORDER BY c.relname
  `, [TARGET_TABLES]);
  const columns = await client.query(`
    SELECT table_name, column_name, udt_name, is_nullable
    FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name=ANY($1::text[])
    ORDER BY table_name, ordinal_position
  `, [TARGET_TABLES]);
  const constraints = await client.query(`
    SELECT rel.relname AS table_name, con.contype, con.conname,
      ARRAY(SELECT attr.attname FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ordinal)
        JOIN pg_attribute attr ON attr.attrelid=con.conrelid AND attr.attnum=key.attnum ORDER BY key.ordinal) AS columns,
      ref.relname AS reference_table, con.confdeltype, pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_constraint con JOIN pg_class rel ON rel.oid=con.conrelid
    JOIN pg_namespace namespace ON namespace.oid=rel.relnamespace LEFT JOIN pg_class ref ON ref.oid=con.confrelid
    WHERE namespace.nspname=current_schema() AND rel.relname=ANY($1::text[]) ORDER BY rel.relname, con.conname
  `, [TARGET_TABLES]);
  const indexes = await client.query(`
    SELECT tablename AS table_name, indexname, indexdef FROM pg_indexes
    WHERE schemaname=current_schema() AND tablename=ANY($1::text[]) ORDER BY tablename, indexname
  `, [TARGET_TABLES]);
  const triggers = await client.query(`
    SELECT COUNT(*)::int AS count FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid=trigger.tgrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname=current_schema() AND relation.relname=ANY($1::text[]) AND NOT trigger.tgisinternal
  `, [TARGET_TABLES]);
  return { relations: relations.rows, columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows, triggers: triggers.rows[0]?.count ?? -1 };
}

async function targetCounts(client) {
  const result = await client.query(`
    SELECT (SELECT COUNT(*)::int FROM tinder_conversations) AS conversations,
      (SELECT COUNT(*)::int FROM tinder_conversation_messages) AS messages
  `);
  const row = result.rows[0] || {};
  return { conversations: Number(row.conversations), messages: Number(row.messages) };
}

export async function inspectTinderConversationMirrorSchema(client) {
  await assertDeviceFoundation(client);
  const catalog = await readTargetCatalog(client);
  if (catalog.relations.length === 0) return Object.freeze({ state: "ELIGIBLE_FOR_MIGRATION", counts: null });
  const catalogFailure = targetCatalogFailureReason(catalog);
  if (catalog.relations.length !== 2 || catalogFailure) {
    const error = new TinderMirrorMigrationError(
      "TINDER_CONVERSATION_MIRROR_SCHEMA_INVALID",
      "Tinder conversation mirror schema is not canonical."
    );
    error.reason = catalogFailure || "RELATIONS";
    throw error;
  }
  return Object.freeze({ state: "ALREADY_CANONICAL", counts: await targetCounts(client) });
}

export async function preflightTinderConversationMirror(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await inspectTinderConversationMirrorSchema(client);
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
  if (["TINDER_CONVERSATION_MIRROR_SCHEMA_INVALID", "TINDER_CONVERSATION_MIRROR_FOUNDATION_INVALID"].includes(error?.code)) return error.code;
  if (stage === "ADVISORY_LOCK" && error?.code === "TINDER_CONVERSATION_MIRROR_ADVISORY_LOCK_UNAVAILABLE") return error.code;
  if (stage === "COMMIT") return "COMMIT_OUTCOME_UNRESOLVED";
  if (stage === "CLEANUP") return "CLEANUP_FAILED";
  return "DATABASE_OPERATION_FAILED";
}

function attachDiagnostic(error, state) {
  const diagnostic = Object.freeze({
    stage: TINDER_MIRROR_MIGRATION_STAGES.includes(state.stage) ? state.stage : "UNKNOWN",
    code: diagnosticCode(state.stage, error),
    transaction: state.commitConfirmed ? "COMMITTED" : state.commitAttempted ? "COMMIT_OUTCOME_UNKNOWN" : state.transactionStarted ? "STARTED" : "NOT_STARTED",
    rollback: state.rollbackAttempted ? state.rollbackCompleted ? "COMPLETED" : "FAILED" : "NOT_ATTEMPTED",
    ddl_started: state.ddlStarted,
    reason: typeof error?.reason === "string" ? error.reason : null
  });
  if (error && (typeof error === "object" || typeof error === "function")) FAILURE_DIAGNOSTICS.set(error, diagnostic);
  return error;
}

export function getTinderConversationMirrorMigrationDiagnostic(error) {
  const diagnostic = error && typeof error === "object" ? FAILURE_DIAGNOSTICS.get(error) : null;
  return diagnostic ? { ...diagnostic } : null;
}

async function configureMigrationTransaction(client) {
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '30s'");
  await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
}

async function acquireMigrationLock(client) {
  const result = await client.query(`SELECT pg_try_advisory_xact_lock(${MIGRATION_LOCK_NAMESPACE}, ${MIGRATION_LOCK_KEY}) AS acquired`);
  if (result.rows[0]?.acquired !== true) {
    const error = new Error("Tinder conversation mirror migration is already running.");
    error.code = "TINDER_CONVERSATION_MIRROR_ADVISORY_LOCK_UNAVAILABLE";
    throw error;
  }
}

/* Explicit, single-use DDL authority; application startup never imports it. */
export async function migrateTinderConversationMirror(pool) {
  let client;
  const state = { stage: "DATABASE_CONNECTION", transactionStarted: false, commitAttempted: false, commitConfirmed: false, rollbackAttempted: false, rollbackCompleted: false, ddlStarted: false };
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
    const preflight = await inspectTinderConversationMirrorSchema(client);
    state.stage = "LOCKED_PREFLIGHT";
    const lockedPreflight = await inspectTinderConversationMirrorSchema(client);
    if (lockedPreflight.state !== preflight.state) fail("TINDER_CONVERSATION_MIRROR_SCHEMA_INVALID", "Tinder conversation mirror schema changed during preflight.");
    let migrated = false;
    if (lockedPreflight.state === "ELIGIBLE_FOR_MIGRATION") {
      state.stage = "DDL_EXECUTION";
      for (const statement of TINDER_MIRROR_MIGRATION_STATEMENTS) {
        state.ddlStarted = true;
        await client.query(statement);
      }
      migrated = true;
    }
    state.stage = "POSTCHECK";
    const postcheck = await inspectTinderConversationMirrorSchema(client);
    if (postcheck.state !== "ALREADY_CANONICAL") fail("TINDER_CONVERSATION_MIRROR_SCHEMA_INVALID", "Tinder conversation mirror postcheck did not reach canonical state.");
    if (migrated && (postcheck.counts.conversations !== 0 || postcheck.counts.messages !== 0)) {
      fail("TINDER_CONVERSATION_MIRROR_SCHEMA_INVALID", "New Tinder conversation mirror tables are not empty.");
    }
    state.stage = "COMMIT";
    state.commitAttempted = true;
    await client.query("COMMIT");
    state.commitConfirmed = true;
    return Object.freeze({ migrated, postcheck });
  } catch (error) {
    releaseError = error;
    const failed = state.stage;
    if (state.transactionStarted && !state.commitAttempted) {
      state.rollbackAttempted = true;
      try { await client.query("ROLLBACK"); state.rollbackCompleted = true; } catch { discardClient = true; }
    } else {
      discardClient = true;
    }
    state.stage = failed;
    throw attachDiagnostic(error, state);
  } finally {
    try { client?.release(discardClient ? releaseError : undefined); } catch (error) { state.stage = "CLEANUP"; throw attachDiagnostic(error, state); }
  }
}
