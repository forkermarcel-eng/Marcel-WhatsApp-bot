import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getTinderLastMessageOrderMigrationDiagnostic,
  migrateTinderLastMessageOrder,
  preflightTinderLastMessageOrder
} from "../tinder-mirror/last-message-order-migration.js";
import { runTinderLastMessageOrderCli } from "../scripts/tinder-block2-last-message-order-migration.js";

const baselineColumns = [
  ["tinder_conversations", "conversation_id", "uuid", "NO"],
  ["tinder_conversations", "device_id", "uuid", "NO"],
  ["tinder_conversations", "channel", "text", "NO"],
  ["tinder_conversations", "profile", "jsonb", "NO"],
  ["tinder_conversations", "history_complete", "bool", "NO"],
  ["tinder_conversations", "profile_synced_at", "timestamptz", "YES"],
  ["tinder_conversations", "history_synced_at", "timestamptz", "YES"],
  ["tinder_conversations", "created_at", "timestamptz", "NO"],
  ["tinder_conversations", "updated_at", "timestamptz", "NO"],
  ["tinder_conversation_messages", "message_id", "uuid", "NO"],
  ["tinder_conversation_messages", "conversation_id", "uuid", "NO"],
  ["tinder_conversation_messages", "ordinal", "int4", "NO"],
  ["tinder_conversation_messages", "direction", "text", "NO"],
  ["tinder_conversation_messages", "message_text", "text", "NO"],
  ["tinder_conversation_messages", "visible_time", "text", "YES"],
  ["tinder_conversation_messages", "visible_status", "text", "YES"],
  ["tinder_conversation_messages", "created_at", "timestamptz", "NO"]
].map(([table_name, column_name, udt_name, is_nullable]) => ({
  table_name,
  column_name,
  udt_name,
  is_nullable,
  column_default: ({
    "tinder_conversations.channel": "'tinder'::text",
    "tinder_conversations.profile": "'{}'::jsonb",
    "tinder_conversations.history_complete": "false",
    "tinder_conversations.created_at": "now()",
    "tinder_conversations.updated_at": "now()",
    "tinder_conversation_messages.created_at": "now()"
  })[`${table_name}.${column_name}`] ?? null
}));

function baseConstraints() {
  return [
    { table_name: "tinder_conversations", contype: "p", conname: "tinder_conversations_pkey", columns: ["conversation_id"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "PRIMARY KEY (conversation_id)" },
    { table_name: "tinder_conversations", contype: "f", conname: "tinder_conversations_device_id_fkey", columns: ["device_id"], reference_table: "device_bridge_devices", confdeltype: "r", confupdtype: "a", condeferrable: false, condeferred: false, definition: "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT" },
    { table_name: "tinder_conversations", contype: "c", conname: "tinder_conversations_channel_check", columns: ["channel"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "CHECK ((channel = 'tinder'::text))" },
    { table_name: "tinder_conversation_messages", contype: "p", conname: "tinder_conversation_messages_pkey", columns: ["message_id"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "PRIMARY KEY (message_id)" },
    { table_name: "tinder_conversation_messages", contype: "f", conname: "tinder_conversation_messages_conversation_id_fkey", columns: ["conversation_id"], reference_table: "tinder_conversations", confdeltype: "r", confupdtype: "a", condeferrable: false, condeferred: false, definition: "FOREIGN KEY (conversation_id) REFERENCES tinder_conversations(conversation_id) ON DELETE RESTRICT" },
    { table_name: "tinder_conversation_messages", contype: "u", conname: "tinder_conversation_messages_conversation_id_ordinal_key", columns: ["conversation_id", "ordinal"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "UNIQUE (conversation_id, ordinal)" },
    { table_name: "tinder_conversation_messages", contype: "c", conname: "tinder_conversation_messages_ordinal_check", columns: ["ordinal"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "CHECK ((ordinal >= 0))" },
    { table_name: "tinder_conversation_messages", contype: "c", conname: "tinder_conversation_messages_direction_check", columns: ["direction"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "CHECK ((direction = ANY (ARRAY['INBOUND'::text, 'OUTBOUND'::text])))" }
  ];
}

function createMigrationPool({ target = false, failOn = null, lockError = false, extraIndex = false } = {}) {
  const statements = [];
  const applied = new Set(target ? ["visible", "position", "check", "index"] : []);
  const counts = { conversations: 3, messages: 21 };
  const isTarget = () => ["visible", "position", "check", "index"].every(item => applied.has(item));
  const columns = () => [
    ...baselineColumns,
    ...(applied.has("visible") ? [{ table_name: "tinder_conversations", column_name: "last_message_visible_time", udt_name: "text", is_nullable: "YES", column_default: null }] : []),
    ...(applied.has("position") ? [{ table_name: "tinder_conversations", column_name: "inbox_position", udt_name: "int4", is_nullable: "YES", column_default: null }] : [])
  ];
  const constraints = () => [
    ...baseConstraints(),
    ...(applied.has("check") ? [{
      table_name: "tinder_conversations",
      contype: "c",
      conname: "tinder_conversations_inbox_position_nonnegative_check",
      columns: ["inbox_position"],
      reference_table: null,
      confdeltype: " ",
      confupdtype: " ",
      condeferrable: false,
      condeferred: false,
      definition: "CHECK (((inbox_position IS NULL) OR (inbox_position >= 0)))"
    }] : [])
  ];
  const indexes = () => [
    {
      table_name: "tinder_conversations",
      indexname: "tinder_conversations_device_updated_idx",
      indexdef: "CREATE INDEX tinder_conversations_device_updated_idx ON public.tinder_conversations USING btree (device_id, updated_at DESC)"
    },
    {
      table_name: "tinder_conversation_messages",
      indexname: "tinder_conversation_messages_conversation_ordinal_idx",
      indexdef: "CREATE INDEX tinder_conversation_messages_conversation_ordinal_idx ON public.tinder_conversation_messages USING btree (conversation_id, ordinal)"
    },
    ...(applied.has("index") ? [{
      table_name: "tinder_conversations",
      indexname: "tinder_conversations_device_inbox_position_idx",
      indexdef: "CREATE INDEX tinder_conversations_device_inbox_position_idx ON public.tinder_conversations USING btree (device_id, inbox_position)"
    }] : []),
    ...(extraIndex ? [{
      table_name: "tinder_conversations",
      indexname: "unexpected_tinder_index",
      indexdef: "CREATE INDEX unexpected_tinder_index ON public.tinder_conversations USING btree (updated_at)"
    }] : [])
  ];
  async function query(sql) {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    statements.push(normalized);
    if (failOn && normalized.includes(failOn)) throw new Error("forced migration failure");
    if (lockError && normalized.startsWith("LOCK TABLE tinder_conversations")) {
      const error = new Error("forced lock timeout");
      error.code = "55P03";
      throw error;
    }
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(normalized)) return { rows: [] };
    if (normalized.includes("FROM pg_attribute a")) {
      return { rows: [{ type_name: "uuid", not_null: true, primary_key: true }] };
    }
    if (normalized.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: true }] };
    if (normalized.includes("FROM pg_class c JOIN pg_namespace")) {
      return { rows: [
        { table_name: "tinder_conversation_messages", relkind: "r" },
        { table_name: "tinder_conversations", relkind: "r" }
      ] };
    }
    if (normalized.includes("FROM information_schema.columns")) return { rows: columns() };
    if (normalized.includes("FROM pg_constraint con")) return { rows: constraints() };
    if (normalized.includes("FROM pg_index index_entry")) return { rows: indexes() };
    if (normalized.includes("FROM pg_trigger trigger")) return { rows: [{ count: 0 }] };
    if (normalized.includes("SELECT (SELECT COUNT(*)::int FROM tinder_conversations)")) {
      return { rows: [{ ...counts }] };
    }
    if (normalized.includes("COUNT(*) FILTER (WHERE last_message_visible_time IS NOT NULL)")) {
      return { rows: [{ visible_time_values: 0, inbox_position_values: 0 }] };
    }
    if (normalized.startsWith("LOCK TABLE tinder_conversations")) return { rows: [] };
    if (normalized.startsWith("ALTER TABLE tinder_conversations ADD COLUMN last_message_visible_time TEXT")) {
      applied.add("visible");
      return { rows: [] };
    }
    if (normalized.startsWith("ALTER TABLE tinder_conversations ADD COLUMN inbox_position INTEGER")) {
      applied.add("position");
      return { rows: [] };
    }
    if (normalized.includes("ADD CONSTRAINT tinder_conversations_inbox_position_nonnegative_check")) {
      applied.add("check");
      return { rows: [] };
    }
    if (normalized.startsWith("CREATE INDEX tinder_conversations_device_inbox_position_idx")) {
      applied.add("index");
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

test("ordering preflight accepts only the exact two-table baseline without writing", async () => {
  const pool = createMigrationPool();
  const result = await preflightTinderLastMessageOrder(pool);
  assert.equal(result.state, "ELIGIBLE_FOR_MIGRATION");
  assert.deepEqual(result.counts, { conversations: 3, messages: 21 });
  assert.ok(pool.statements.includes("BEGIN READ ONLY"));
  assert.equal(pool.statements.some(statement => /^(ALTER|CREATE|LOCK TABLE)/.test(statement)), false);
});

test("ordering migration locks the existing two tables, adds only nullable fields, and commits after canonical postcheck", async () => {
  const pool = createMigrationPool();
  const result = await migrateTinderLastMessageOrder(pool);
  assert.equal(result.migrated, true);
  assert.equal(result.postcheck.state, "ALREADY_CANONICAL");
  assert.deepEqual(result.postcheck.counts, { conversations: 3, messages: 21 });
  assert.equal(pool.isTarget(), true);
  assert.ok(pool.statements.includes("LOCK TABLE tinder_conversations, tinder_conversation_messages IN ACCESS EXCLUSIVE MODE"));
  assert.equal(pool.statements.filter(statement => /^(ALTER|CREATE INDEX)/.test(statement)).length, 4);
  assert.equal(pool.statements.at(-1), "COMMIT");
  assert.equal(pool.statements.some(statement => statement.startsWith("ROLLBACK")), false);
  assert.ok(pool.statements.some(statement => statement.includes("COUNT(*) FILTER (WHERE last_message_visible_time IS NOT NULL)")));
});

test("already-upgraded exact target is a no-op apply", async () => {
  const pool = createMigrationPool({ target: true });
  const result = await migrateTinderLastMessageOrder(pool);
  assert.equal(result.migrated, false);
  assert.equal(result.postcheck.state, "ALREADY_CANONICAL");
  assert.equal(pool.statements.some(statement => /^(ALTER|CREATE INDEX)/.test(statement)), false);
  assert.ok(pool.statements.includes("COMMIT"));
});

test("unexpected user indexes fail strict baseline-versus-target preflight", async () => {
  const pool = createMigrationPool({ extraIndex: true });
  await assert.rejects(
    preflightTinderLastMessageOrder(pool),
    error => error?.code === "TINDER_LAST_MESSAGE_ORDER_SCHEMA_INVALID" && error?.reason === "INDEXES"
  );
  assert.equal(pool.statements.some(statement => /^(ALTER|CREATE INDEX)/.test(statement)), false);
});

test("a DDL failure rolls back and retains a bounded diagnostic", async () => {
  const pool = createMigrationPool({ failOn: "ADD COLUMN inbox_position" });
  let failure;
  try {
    await migrateTinderLastMessageOrder(pool);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.ok(pool.statements.some(statement => statement.startsWith("ROLLBACK")));
  assert.deepEqual(getTinderLastMessageOrderMigrationDiagnostic(failure), {
    stage: "DDL_EXECUTION",
    code: "DATABASE_OPERATION_FAILED",
    transaction: "STARTED",
    rollback: "COMPLETED",
    ddl_started: true,
    reason: null
  });
});

test("a table-lock failure rolls back before DDL and reports LOCK_TIMEOUT", async () => {
  const pool = createMigrationPool({ lockError: true });
  let failure;
  try {
    await migrateTinderLastMessageOrder(pool);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.ok(pool.statements.some(statement => statement.startsWith("ROLLBACK")));
  assert.deepEqual(getTinderLastMessageOrderMigrationDiagnostic(failure), {
    stage: "TINDER_TABLE_LOCK",
    code: "LOCK_TIMEOUT",
    transaction: "STARTED",
    rollback: "COMPLETED",
    ddl_started: false,
    reason: null
  });
});

test("CLI uses explicit preflight/apply modes and emits bounded output", async () => {
  const events = [];
  const logger = {
    log(value) { events.push(["log", value]); },
    error(value) { events.push(["error", value]); }
  };
  const pool = createMigrationPool({ target: true });
  const result = await runTinderLastMessageOrderCli({
    argv: ["--preflight"],
    environment: { DATABASE_URL: "postgres://not-a-real-server" },
    createPool: async () => pool,
    logger
  });
  assert.equal(result, true);
  assert.ok(events.some(([, value]) => value === "TINDER_LAST_MESSAGE_ORDER_PREFLIGHT ALREADY_CANONICAL"));
  assert.equal(events.some(([, value]) => /name|message_text|profile/i.test(value)), false);
});

test("the fixed SQL source is strictly additive and has no data path", () => {
  const source = readFileSync(new URL("../migrations/20260924_tinder_conversation_last_message_order.sql", import.meta.url), "utf8");
  const executable = source.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n");
  assert.match(source, /ADD COLUMN last_message_visible_time TEXT/);
  assert.match(source, /ADD COLUMN inbox_position INTEGER/);
  assert.match(source, /CHECK \(inbox_position IS NULL OR inbox_position >= 0\)/);
  assert.match(source, /CREATE INDEX tinder_conversations_device_inbox_position_idx/);
  assert.doesNotMatch(executable, /UPDATE|INSERT|DELETE|TRUNCATE|DROP|CASCADE|CREATE TRIGGER|CREATE FUNCTION/i);
});
