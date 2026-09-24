import {
  canonicalCheckDefinition,
  tokenizeSchemaSql
} from "../device-bridge/schema-contract.js";

/*
 * Explicit, additive Block-2 ordering migration.  It deliberately lives
 * beside -- rather than inside -- the two-table mirror migration: the base
 * migration remains its own immutable schema authority.
 *
 * This migration never backfills, rewrites, or deletes conversation data.
 * The two new nullable fields are populated only by a later normal product
 * sync when Tinder exposes a value directly.
 */

export const TINDER_LAST_MESSAGE_ORDER_MIGRATION_STATEMENTS = Object.freeze([
  "ALTER TABLE tinder_conversations ADD COLUMN last_message_visible_time TEXT",
  "ALTER TABLE tinder_conversations ADD COLUMN inbox_position INTEGER",
  `ALTER TABLE tinder_conversations
     ADD CONSTRAINT tinder_conversations_inbox_position_nonnegative_check
     CHECK (inbox_position IS NULL OR inbox_position >= 0)`,
  `CREATE INDEX tinder_conversations_device_inbox_position_idx
     ON tinder_conversations(device_id, inbox_position)`
]);

export const TINDER_LAST_MESSAGE_ORDER_MIGRATION_STAGES = Object.freeze([
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
  "tinder_conversation_messages"
]);
const ADVISORY_LOCK_NAMESPACE = 7421;
const ADVISORY_LOCK_KEY = 24;
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
    updated_at: ["timestamptz", "NO"]
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
  tinder_conversations: Object.freeze({
    ...BASELINE_COLUMNS.tinder_conversations,
    last_message_visible_time: ["text", "YES"],
    inbox_position: ["int4", "YES"]
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
  })
});

const EXPECTED_CHECKS = Object.freeze({
  channel: canonicalCheckDefinition("CHECK (channel = 'tinder')"),
  ordinal: canonicalCheckDefinition("CHECK (ordinal >= 0)"),
  direction: canonicalCheckDefinition("CHECK (direction IN ('INBOUND', 'OUTBOUND'))"),
  inboxPosition: canonicalCheckDefinition("CHECK (inbox_position IS NULL OR inbox_position >= 0)")
});

function canonicalIndexShape(value) {
  const tokens = tokenizeSchemaSql(value);
  const onIndex = tokens.indexOf("on");
  // pg_get_indexdef qualifies the relation with the current schema.  Remove
  // only that tokenized qualifier; never pattern-match inside an index name.
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
  )
});

export class TinderLastMessageOrderMigrationError extends Error {
  constructor(code, message, reason = null) {
    super(message);
    this.name = "TinderLastMessageOrderMigrationError";
    this.code = code;
    this.reason = reason;
  }
}

function fail(code, message, reason = null) {
  throw new TinderLastMessageOrderMigrationError(code, message, reason);
}

function sameColumns(actual, expected) {
  const values = Array.isArray(actual)
    ? actual
    : typeof actual === "string"
      ? actual === "" ? [] : actual.replace(/^\{/, "").replace(/\}$/, "").split(",")
      : [];
  return values.length === expected.length && values.every((value, index) => value === expected[index]);
}

function exactlyOne(rows, predicate) {
  return rows.filter(predicate).length === 1;
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

function canonicalDefault(value) {
  if (value === null || value === undefined) return null;
  return tokenizeSchemaSql(value).filter(token => token !== "(" && token !== ")").join("");
}

function isExactCheck(row, kind) {
  return canonicalCheckDefinition(row.definition) === EXPECTED_CHECKS[kind];
}

function hasBaseConstraints(constraints) {
  const conversations = constraints.filter(row => row.table_name === "tinder_conversations");
  const messages = constraints.filter(row => row.table_name === "tinder_conversation_messages");
  return exactlyOne(conversations, row => row.contype === "p" && sameColumns(row.columns, ["conversation_id"]))
    && exactlyOne(conversations, row => row.contype === "f"
      && sameColumns(row.columns, ["device_id"])
      && row.reference_table === "device_bridge_devices"
      && row.confdeltype === "r" && row.confupdtype === "a"
      && row.condeferrable === false && row.condeferred === false)
    && exactlyOne(conversations, row => row.contype === "c" && isExactCheck(row, "channel"))
    && exactlyOne(messages, row => row.contype === "p" && sameColumns(row.columns, ["message_id"]))
    && exactlyOne(messages, row => row.contype === "f"
      && sameColumns(row.columns, ["conversation_id"])
      && row.reference_table === "tinder_conversations"
      && row.confdeltype === "r" && row.confupdtype === "a"
      && row.condeferrable === false && row.condeferred === false)
    && exactlyOne(messages, row => row.contype === "u" && sameColumns(row.columns, ["conversation_id", "ordinal"]))
    && exactlyOne(messages, row => row.contype === "c" && isExactCheck(row, "ordinal"))
    && exactlyOne(messages, row => row.contype === "c" && isExactCheck(row, "direction"));
}

function hasExpectedIndexes(indexes, target) {
  const expected = target
    ? [EXPECTED_INDEXES.deviceUpdated, EXPECTED_INDEXES.messageOrdinal, EXPECTED_INDEXES.deviceInboxPosition]
    : [EXPECTED_INDEXES.deviceUpdated, EXPECTED_INDEXES.messageOrdinal];
  return indexes.length === expected.length
    && expected.every(shape => indexes.filter(row => canonicalIndexShape(row.indexdef) === shape).length === 1);
}

function catalogState(catalog) {
  if (catalog.relations.length === 0) return { state: "BASELINE_MISSING", reason: "RELATIONS" };
  if (catalog.relations.length !== 2 || catalog.relations.some(row => row.relkind !== "r")) {
    return { state: "INVALID", reason: "RELATIONS" };
  }

  const conversationColumns = catalog.columns.filter(row => row.table_name === "tinder_conversations");
  const messageColumns = catalog.columns.filter(row => row.table_name === "tinder_conversation_messages");
  const isBaseline = hasExpectedColumns(conversationColumns, BASELINE_COLUMNS.tinder_conversations)
    && hasExpectedColumns(messageColumns, BASELINE_COLUMNS.tinder_conversation_messages);
  const isTarget = hasExpectedColumns(conversationColumns, TARGET_COLUMNS.tinder_conversations)
    && hasExpectedColumns(messageColumns, TARGET_COLUMNS.tinder_conversation_messages);
  if (!isBaseline && !isTarget) return { state: "INVALID", reason: "COLUMN_SHAPE" };

  const expectedConstraintCount = isTarget ? 9 : 8;
  if (catalog.constraints.length !== expectedConstraintCount || !hasBaseConstraints(catalog.constraints)) {
    return { state: "INVALID", reason: "CONSTRAINTS" };
  }
  const orderingChecks = catalog.constraints.filter(row => row.table_name === "tinder_conversations"
    && row.contype === "c" && isExactCheck(row, "inboxPosition"));
  if (isTarget) {
    if (orderingChecks.length !== 1
      || orderingChecks[0].conname !== "tinder_conversations_inbox_position_nonnegative_check") {
      return { state: "INVALID", reason: "INBOX_POSITION_CHECK" };
    }
  } else if (orderingChecks.length !== 0) {
    return { state: "INVALID", reason: "INBOX_POSITION_CHECK" };
  }

  if (!hasExpectedIndexes(catalog.indexes, isTarget)) {
    return { state: "INVALID", reason: "INDEXES" };
  }
  if (Number(catalog.triggers) !== 0) return { state: "INVALID", reason: "TRIGGERS" };
  return { state: isTarget ? "ALREADY_CANONICAL" : "ELIGIBLE_FOR_MIGRATION", reason: null };
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
    fail("TINDER_LAST_MESSAGE_ORDER_FOUNDATION_INVALID", "The ordinary device foundation is unavailable.");
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
      -- PostgreSQL 18 also exposes implicit NOT NULL constraints (contype=n)
      -- here. Column nullability is checked separately, so only ordinary
      -- schema constraints belong to this canonical comparison.
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

async function mirrorCounts(client) {
  const result = await client.query(`
    SELECT (SELECT COUNT(*)::int FROM tinder_conversations) AS conversations,
      (SELECT COUNT(*)::int FROM tinder_conversation_messages) AS messages
  `);
  const row = result.rows[0] || {};
  return Object.freeze({ conversations: Number(row.conversations), messages: Number(row.messages) });
}

async function addedColumnsPopulatedCounts(client) {
  const result = await client.query(`
    SELECT COUNT(*) FILTER (WHERE last_message_visible_time IS NOT NULL)::int AS visible_time_values,
      COUNT(*) FILTER (WHERE inbox_position IS NOT NULL)::int AS inbox_position_values
    FROM tinder_conversations
  `);
  const row = result.rows[0] || {};
  return Object.freeze({
    visible_time_values: Number(row.visible_time_values),
    inbox_position_values: Number(row.inbox_position_values)
  });
}

export async function inspectTinderLastMessageOrderSchema(client) {
  await assertDeviceFoundation(client);
  const catalog = await readCatalog(client);
  const checked = catalogState(catalog);
  if (checked.state === "BASELINE_MISSING") {
    fail(
      "TINDER_LAST_MESSAGE_ORDER_SCHEMA_INVALID",
      "The Block-2 conversation mirror baseline is unavailable.",
      checked.reason
    );
  }
  if (checked.state === "INVALID") {
    fail(
      "TINDER_LAST_MESSAGE_ORDER_SCHEMA_INVALID",
      "The Block-2 conversation mirror schema is neither the exact baseline nor the exact ordering target.",
      checked.reason
    );
  }
  return Object.freeze({ state: checked.state, counts: await mirrorCounts(client) });
}

export async function preflightTinderLastMessageOrder(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result = await inspectTinderLastMessageOrderSchema(client);
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
  if (["TINDER_LAST_MESSAGE_ORDER_SCHEMA_INVALID", "TINDER_LAST_MESSAGE_ORDER_FOUNDATION_INVALID"].includes(error?.code)) {
    return error.code;
  }
  if (stage === "ADVISORY_LOCK" && error?.code === "TINDER_LAST_MESSAGE_ORDER_ADVISORY_LOCK_UNAVAILABLE") {
    return error.code;
  }
  if (stage === "TINDER_TABLE_LOCK" && error?.code === "55P03") return "LOCK_TIMEOUT";
  if (stage === "COMMIT") return "COMMIT_OUTCOME_UNRESOLVED";
  if (stage === "CLEANUP") return "CLEANUP_FAILED";
  return "DATABASE_OPERATION_FAILED";
}

function attachDiagnostic(error, state) {
  const diagnostic = Object.freeze({
    stage: TINDER_LAST_MESSAGE_ORDER_MIGRATION_STAGES.includes(state.stage) ? state.stage : "UNKNOWN",
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
  if (error && (typeof error === "object" || typeof error === "function")) {
    FAILURE_DIAGNOSTICS.set(error, diagnostic);
  }
  return error;
}

export function getTinderLastMessageOrderMigrationDiagnostic(error) {
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
    const error = new Error("Tinder last-message ordering migration is already running.");
    error.code = "TINDER_LAST_MESSAGE_ORDER_ADVISORY_LOCK_UNAVAILABLE";
    throw error;
  }
}

async function lockTinderMirrorTables(client) {
  await client.query("LOCK TABLE tinder_conversations, tinder_conversation_messages IN ACCESS EXCLUSIVE MODE");
}

/**
 * The only authority to add the nullable source-time and Inbox-order fields.
 * It never runs during application start and does not write product rows.
 */
export async function migrateTinderLastMessageOrder(pool) {
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
    const preflight = await inspectTinderLastMessageOrderSchema(client);
    state.stage = "TINDER_TABLE_LOCK";
    await lockTinderMirrorTables(client);
    state.stage = "LOCKED_PREFLIGHT";
    const lockedPreflight = await inspectTinderLastMessageOrderSchema(client);
    if (lockedPreflight.state !== preflight.state) {
      fail(
        "TINDER_LAST_MESSAGE_ORDER_SCHEMA_INVALID",
        "Tinder conversation schema changed during locked preflight.",
        "PREFLIGHT_DRIFT"
      );
    }

    let migrated = false;
    if (lockedPreflight.state === "ELIGIBLE_FOR_MIGRATION") {
      state.stage = "DDL_EXECUTION";
      for (const statement of TINDER_LAST_MESSAGE_ORDER_MIGRATION_STATEMENTS) {
        state.ddlStarted = true;
        await client.query(statement);
      }
      migrated = true;
    }

    state.stage = "POSTCHECK";
    const postcheck = await inspectTinderLastMessageOrderSchema(client);
    if (postcheck.state !== "ALREADY_CANONICAL") {
      fail(
        "TINDER_LAST_MESSAGE_ORDER_SCHEMA_INVALID",
        "Tinder last-message ordering postcheck did not reach canonical state.",
        "POSTCHECK_STATE"
      );
    }
    if (postcheck.counts.conversations !== lockedPreflight.counts.conversations
      || postcheck.counts.messages !== lockedPreflight.counts.messages) {
      fail(
        "TINDER_LAST_MESSAGE_ORDER_SCHEMA_INVALID",
        "The additive ordering migration changed existing Tinder row counts.",
        "ROW_COUNT_DRIFT"
      );
    }
    if (migrated) {
      const populated = await addedColumnsPopulatedCounts(client);
      if (populated.visible_time_values !== 0 || populated.inbox_position_values !== 0) {
        fail(
          "TINDER_LAST_MESSAGE_ORDER_SCHEMA_INVALID",
          "The additive ordering migration populated existing Tinder rows.",
          "UNEXPECTED_DATA_MUTATION"
        );
      }
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
