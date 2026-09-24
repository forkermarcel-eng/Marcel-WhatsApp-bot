import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  getTinderMatchMigrationDiagnostic,
  migrateTinderMatches,
  preflightTinderMatches
} from "../tinder-mirror/matches-migration.js";
import { runTinderMatchesCli } from "../scripts/tinder-block2-matches-migration.js";

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
  ["tinder_conversations", "last_message_visible_time", "text", "YES"],
  ["tinder_conversations", "inbox_position", "int4", "YES"],
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

const matchColumns = [
  ["match_id", "uuid", "NO"],
  ["device_id", "uuid", "NO"],
  ["conversation_id", "uuid", "YES"],
  ["tile", "jsonb", "NO"],
  ["carousel_position", "int4", "NO"],
  ["created_at", "timestamptz", "NO"],
  ["updated_at", "timestamptz", "NO"]
].map(([column_name, udt_name, is_nullable]) => ({
  table_name: "tinder_matches",
  column_name,
  udt_name,
  is_nullable,
  column_default: ["created_at", "updated_at"].includes(column_name) ? "now()" : null
}));

function baseConstraints() {
  return [
    { table_name: "tinder_conversations", contype: "p", conname: "tinder_conversations_pkey", columns: ["conversation_id"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "PRIMARY KEY (conversation_id)" },
    { table_name: "tinder_conversations", contype: "f", conname: "tinder_conversations_device_id_fkey", columns: ["device_id"], reference_table: "device_bridge_devices", confdeltype: "r", confupdtype: "a", condeferrable: false, condeferred: false, definition: "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT" },
    { table_name: "tinder_conversations", contype: "c", conname: "tinder_conversations_channel_check", columns: ["channel"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "CHECK ((channel = 'tinder'::text))" },
    { table_name: "tinder_conversations", contype: "c", conname: "tinder_conversations_inbox_position_nonnegative_check", columns: ["inbox_position"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "CHECK (((inbox_position IS NULL) OR (inbox_position >= 0)))" },
    { table_name: "tinder_conversation_messages", contype: "p", conname: "tinder_conversation_messages_pkey", columns: ["message_id"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "PRIMARY KEY (message_id)" },
    { table_name: "tinder_conversation_messages", contype: "f", conname: "tinder_conversation_messages_conversation_id_fkey", columns: ["conversation_id"], reference_table: "tinder_conversations", confdeltype: "r", confupdtype: "a", condeferrable: false, condeferred: false, definition: "FOREIGN KEY (conversation_id) REFERENCES tinder_conversations(conversation_id) ON DELETE RESTRICT" },
    { table_name: "tinder_conversation_messages", contype: "u", conname: "tinder_conversation_messages_conversation_id_ordinal_key", columns: ["conversation_id", "ordinal"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "UNIQUE (conversation_id, ordinal)" },
    { table_name: "tinder_conversation_messages", contype: "c", conname: "tinder_conversation_messages_ordinal_check", columns: ["ordinal"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "CHECK ((ordinal >= 0))" },
    { table_name: "tinder_conversation_messages", contype: "c", conname: "tinder_conversation_messages_direction_check", columns: ["direction"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "CHECK ((direction = ANY (ARRAY['INBOUND'::text, 'OUTBOUND'::text])))" }
  ];
}

function targetConstraints() {
  return [
    { table_name: "tinder_conversations", contype: "u", conname: "tinder_conversations_conversation_id_device_id_key", columns: ["conversation_id", "device_id"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "UNIQUE (conversation_id, device_id)" },
    { table_name: "tinder_matches", contype: "p", conname: "tinder_matches_pkey", columns: ["match_id"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "PRIMARY KEY (match_id)" },
    { table_name: "tinder_matches", contype: "f", conname: "tinder_matches_device_id_fkey", columns: ["device_id"], reference_table: "device_bridge_devices", confdeltype: "r", confupdtype: "a", condeferrable: false, condeferred: false, definition: "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT" },
    { table_name: "tinder_matches", contype: "f", conname: "tinder_matches_conversation_device_fkey", columns: ["conversation_id", "device_id"], reference_table: "tinder_conversations", confdeltype: "r", confupdtype: "a", condeferrable: false, condeferred: false, definition: "FOREIGN KEY (conversation_id, device_id) REFERENCES tinder_conversations(conversation_id, device_id) ON DELETE RESTRICT" },
    { table_name: "tinder_matches", contype: "c", conname: "tinder_matches_carousel_position_check", columns: ["carousel_position"], reference_table: null, confdeltype: " ", confupdtype: " ", condeferrable: false, condeferred: false, definition: "CHECK ((carousel_position >= 0))" }
  ];
}

function createMigrationPool({ target = false, failOn = null, lockError = false, extraIndex = false, includeNotNullConstraints = false, rowCountDrift = false } = {}) {
  const statements = [];
  const applied = new Set(target ? ["parent_unique", "table", "index"] : []);
  const counts = { conversations: 13, messages: 79, matches: 0 };
  const isTarget = () => ["parent_unique", "table", "index"].every(item => applied.has(item));
  const columns = () => [
    ...baselineColumns,
    ...(applied.has("table") ? matchColumns : [])
  ];
  const constraints = () => [
    ...baseConstraints(),
    ...(includeNotNullConstraints ? [{
      table_name: "tinder_conversations",
      contype: "n",
      conname: "tinder_conversations_profile_not_null",
      columns: ["profile"],
      reference_table: null,
      confdeltype: " ",
      confupdtype: " ",
      condeferrable: false,
      condeferred: false,
      definition: "NOT NULL profile"
    }] : []),
    ...(isTarget() ? targetConstraints() : [])
  ];
  const indexes = () => [
    { table_name: "tinder_conversations", indexname: "tinder_conversations_device_updated_idx", indexdef: "CREATE INDEX tinder_conversations_device_updated_idx ON public.tinder_conversations USING btree (device_id, updated_at DESC)" },
    { table_name: "tinder_conversation_messages", indexname: "tinder_conversation_messages_conversation_ordinal_idx", indexdef: "CREATE INDEX tinder_conversation_messages_conversation_ordinal_idx ON public.tinder_conversation_messages USING btree (conversation_id, ordinal)" },
    { table_name: "tinder_conversations", indexname: "tinder_conversations_device_inbox_position_idx", indexdef: "CREATE INDEX tinder_conversations_device_inbox_position_idx ON public.tinder_conversations USING btree (device_id, inbox_position)" },
    ...(applied.has("index") ? [{ table_name: "tinder_matches", indexname: "tinder_matches_device_carousel_position_idx", indexdef: "CREATE INDEX tinder_matches_device_carousel_position_idx ON public.tinder_matches USING btree (device_id, carousel_position)" }] : []),
    ...(extraIndex ? [{ table_name: "tinder_conversations", indexname: "unexpected_tinder_index", indexdef: "CREATE INDEX unexpected_tinder_index ON public.tinder_conversations USING btree (updated_at)" }] : [])
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
    if (normalized.includes("FROM pg_attribute a")) return { rows: [{ type_name: "uuid", not_null: true, primary_key: true }] };
    if (normalized.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: true }] };
    if (normalized.includes("FROM pg_class c JOIN pg_namespace")) {
      return { rows: [
        { table_name: "tinder_conversation_messages", relkind: "r" },
        { table_name: "tinder_conversations", relkind: "r" },
        ...(applied.has("table") ? [{ table_name: "tinder_matches", relkind: "r" }] : [])
      ] };
    }
    if (normalized.includes("FROM information_schema.columns")) return { rows: columns() };
    if (normalized.includes("FROM pg_constraint con")) {
      const rows = constraints();
      return { rows: normalized.includes("con.contype IN ('p','f','u','c')")
        ? rows.filter(row => ["p", "f", "u", "c"].includes(row.contype))
        : rows };
    }
    if (normalized.includes("FROM pg_index index_entry")) return { rows: indexes() };
    if (normalized.includes("FROM pg_trigger trigger")) return { rows: [{ count: 0 }] };
    if (normalized.startsWith("SELECT (SELECT COUNT(*)::int FROM tinder_conversations)")) return { rows: [{ ...counts }] };
    if (normalized.startsWith("LOCK TABLE tinder_conversations")) return { rows: [] };
    if (normalized.startsWith("ALTER TABLE tinder_conversations ADD CONSTRAINT tinder_conversations_conversation_id_device_id_key")) {
      applied.add("parent_unique");
      return { rows: [] };
    }
    if (normalized.startsWith("CREATE TABLE tinder_matches")) {
      applied.add("table");
      if (rowCountDrift) counts.messages += 1;
      return { rows: [] };
    }
    if (normalized.startsWith("CREATE INDEX tinder_matches_device_carousel_position_idx")) {
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

test("Match preflight accepts the exact post-order baseline without writing", async () => {
  const pool = createMigrationPool();
  const result = await preflightTinderMatches(pool);
  assert.equal(result.state, "ELIGIBLE_FOR_MIGRATION");
  assert.deepEqual(result.counts, { conversations: 13, messages: 79, matches: 0 });
  assert.ok(pool.statements.includes("BEGIN READ ONLY"));
  assert.equal(pool.statements.some(statement => /^(ALTER|CREATE|LOCK TABLE)/.test(statement)), false);
});

test("Match preflight ignores implicit PostgreSQL NOT NULL catalog constraints", async () => {
  const pool = createMigrationPool({ includeNotNullConstraints: true });
  const result = await preflightTinderMatches(pool);
  assert.equal(result.state, "ELIGIBLE_FOR_MIGRATION");
  assert.ok(pool.statements.some(statement => statement.includes("con.contype IN ('p','f','u','c')")));
});

test("Match migration locks only predecessor tables, applies additive DDL, and commits after canonical postcheck", async () => {
  const pool = createMigrationPool();
  const result = await migrateTinderMatches(pool);
  assert.equal(result.migrated, true);
  assert.equal(result.postcheck.state, "ALREADY_CANONICAL");
  assert.deepEqual(result.postcheck.counts, { conversations: 13, messages: 79, matches: 0 });
  assert.equal(pool.isTarget(), true);
  assert.ok(pool.statements.includes("LOCK TABLE tinder_conversations, tinder_conversation_messages IN ACCESS EXCLUSIVE MODE"));
  assert.equal(pool.statements.some(statement => /LOCK TABLE.*tinder_matches/.test(statement)), false);
  assert.equal(pool.statements.filter(statement => /^(ALTER|CREATE TABLE|CREATE INDEX)/.test(statement)).length, 3);
  assert.equal(pool.statements.at(-1), "COMMIT");
  assert.equal(pool.statements.some(statement => statement.startsWith("ROLLBACK")), false);
});

test("already-canonical Match schema is an apply no-op", async () => {
  const pool = createMigrationPool({ target: true });
  const result = await migrateTinderMatches(pool);
  assert.equal(result.migrated, false);
  assert.equal(result.postcheck.state, "ALREADY_CANONICAL");
  assert.equal(pool.statements.some(statement => /^(ALTER|CREATE TABLE|CREATE INDEX)/.test(statement)), false);
  assert.ok(pool.statements.includes("COMMIT"));
});

test("strict preflight rejects unexpected catalog indexes", async () => {
  const pool = createMigrationPool({ extraIndex: true });
  await assert.rejects(
    preflightTinderMatches(pool),
    error => error?.code === "TINDER_MATCH_SCHEMA_INVALID" && error?.reason === "INDEXES"
  );
  assert.equal(pool.statements.some(statement => /^(ALTER|CREATE|LOCK TABLE)/.test(statement)), false);
});

test("DDL failure rolls back with bounded diagnostic and no commit", async () => {
  const pool = createMigrationPool({ failOn: "CREATE TABLE tinder_matches" });
  let failure;
  try {
    await migrateTinderMatches(pool);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.ok(pool.statements.some(statement => statement.startsWith("ROLLBACK")));
  assert.deepEqual(getTinderMatchMigrationDiagnostic(failure), {
    stage: "DDL_EXECUTION",
    code: "DATABASE_OPERATION_FAILED",
    transaction: "STARTED",
    rollback: "COMPLETED",
    ddl_started: true,
    reason: null
  });
});

test("postcheck fails closed if an additive apply changes existing product-row counts", async () => {
  const pool = createMigrationPool({ rowCountDrift: true });
  await assert.rejects(
    migrateTinderMatches(pool),
    error => error?.code === "TINDER_MATCH_SCHEMA_INVALID" && error?.reason === "ROW_COUNT_DRIFT"
  );
  assert.ok(pool.statements.some(statement => statement.startsWith("ROLLBACK")));
  assert.equal(pool.statements.includes("COMMIT"), false);
});

test("existing-table lock failure rolls back before DDL", async () => {
  const pool = createMigrationPool({ lockError: true });
  let failure;
  try {
    await migrateTinderMatches(pool);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.ok(pool.statements.some(statement => statement.startsWith("ROLLBACK")));
  assert.deepEqual(getTinderMatchMigrationDiagnostic(failure), {
    stage: "TINDER_TABLE_LOCK",
    code: "LOCK_TIMEOUT",
    transaction: "STARTED",
    rollback: "COMPLETED",
    ddl_started: false,
    reason: null
  });
});

test("CLI has only explicit preflight/apply modes and emits no product content", async () => {
  const events = [];
  const logger = {
    log(value) { events.push(["log", value]); },
    error(value) { events.push(["error", value]); }
  };
  const pool = createMigrationPool({ target: true });
  const result = await runTinderMatchesCli({
    argv: ["--preflight"],
    environment: { DATABASE_URL: "postgres://not-a-real-server" },
    createPool: async () => pool,
    logger
  });
  assert.equal(result, true);
  assert.ok(events.some(([, value]) => value === "TINDER_MATCH_PREFLIGHT ALREADY_CANONICAL"));
  assert.equal(events.some(([, value]) => /name|tile|profile|message_text/i.test(value)), false);
});

test("the fixed SQL source is additive schema-only DDL", () => {
  const source = readFileSync(new URL("../migrations/20260924_tinder_matches.sql", import.meta.url), "utf8");
  const executable = source.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n");
  assert.match(source, /ADD CONSTRAINT tinder_conversations_conversation_id_device_id_key/);
  assert.match(source, /CREATE TABLE tinder_matches/);
  assert.match(source, /FOREIGN KEY \(conversation_id, device_id\)/);
  assert.match(source, /CREATE INDEX tinder_matches_device_carousel_position_idx/);
  assert.doesNotMatch(
    executable,
    /(?:^|[;\n])\s*(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE|DROP)\b|CASCADE|CREATE\s+TRIGGER|CREATE\s+FUNCTION/i
  );
});
