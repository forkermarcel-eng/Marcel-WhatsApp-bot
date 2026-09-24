import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  TinderMirrorError,
  createTinderConversationMirror,
  largestContiguousOverlap,
  mergeTinderHistory,
  normalizeTinderMirrorPayload,
  selectConservativeConversationMatch
} from "../tinder-mirror/conversation.js";
import {
  getTinderConversationMirrorMigrationDiagnostic,
  migrateTinderConversationMirror,
  preflightTinderConversationMirror
} from "../tinder-mirror/migration.js";
import { createTinderAppiumAdapter } from "../tinder-mirror/appium-adapter.js";

const profile = (attributes = { city: "Example city" }) => ({
  display_name: "Example profile",
  attributes,
  media_refs: []
});

const message = (direction, text, visibleTime = null) => ({
  direction,
  text,
  visible_time: visibleTime,
  visible_status: null
});

function createMemoryPool() {
  const state = {
    devices: new Set(["00000000-0000-4000-8000-000000000001"]),
    conversations: new Map(),
    messages: new Map()
  };
  const rowsForConversation = (conversation) => conversation ? [{ ...conversation }] : [];
  async function query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(normalized)) return { rows: [] };
    if (normalized.startsWith("SELECT device_id FROM device_bridge_devices")) {
      return { rows: state.devices.has(params[0]) ? [{ device_id: params[0] }] : [] };
    }
    if (normalized.includes("FROM tinder_conversation_messages")) {
      const rows = (state.messages.get(params[0]) || []).map((item) => ({ ...item }));
      return { rows };
    }
    if (normalized.includes("FROM tinder_conversations") && normalized.includes("profile->>'display_name'")) {
      const rows = [...state.conversations.values()]
        .filter((item) => item.device_id === params[0] && item.profile.display_name === params[1])
        .map((item) => ({ ...item }));
      return { rows };
    }
    if (normalized.includes("FROM tinder_conversations") && normalized.includes("conversation_id=$1")) {
      return { rows: rowsForConversation(state.conversations.get(params[0])) };
    }
    if (normalized.startsWith("INSERT INTO tinder_conversations")) {
      const [conversationId, deviceId, serializedProfile, timestamp] = params;
      state.conversations.set(conversationId, {
        conversation_id: conversationId,
        device_id: deviceId,
        profile: JSON.parse(serializedProfile),
        history_complete: true,
        profile_synced_at: timestamp,
        history_synced_at: timestamp,
        created_at: timestamp,
        updated_at: timestamp
      });
      return { rows: [] };
    }
    if (normalized.startsWith("DELETE FROM tinder_conversation_messages")) {
      state.messages.set(params[0], []);
      return { rows: [] };
    }
    if (normalized.startsWith("INSERT INTO tinder_conversation_messages")) {
      const [, conversationId, ordinal, direction, text, visibleTime, visibleStatus] = params;
      const rows = state.messages.get(conversationId) || [];
      rows.push({ ordinal, direction, message_text: text, visible_time: visibleTime, visible_status: visibleStatus });
      state.messages.set(conversationId, rows);
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE tinder_conversations")) {
      const [conversationId, serializedProfile, profileChanged, timestamp, historyChanged] = params;
      const existing = state.conversations.get(conversationId);
      existing.profile = JSON.parse(serializedProfile);
      existing.history_complete = true;
      if (profileChanged) existing.profile_synced_at = timestamp;
      if (historyChanged) existing.history_synced_at = timestamp;
      if (profileChanged || historyChanged) existing.updated_at = timestamp;
      return { rows: [] };
    }
    if (normalized.includes("FROM tinder_conversations c") && normalized.includes("COUNT(m.message_id)")) {
      return { rows: [...state.conversations.values()].map((item) => ({ ...item, message_count: (state.messages.get(item.conversation_id) || []).length })) };
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }
  return {
    state,
    async connect() { return { query, release() {} }; },
    query
  };
}

function createMigrationPool({ failOn = null } = {}) {
  const statements = [];
  const createdTables = new Set();
  const columns = [
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
  ].map(([table_name, column_name, udt_name, is_nullable]) => ({ table_name, column_name, udt_name, is_nullable }));
  const constraints = [
    { table_name: "tinder_conversations", contype: "p", columns: ["conversation_id"], reference_table: null, confdeltype: " ", definition: "PRIMARY KEY (conversation_id)" },
    { table_name: "tinder_conversations", contype: "f", columns: ["device_id"], reference_table: "device_bridge_devices", confdeltype: "r", definition: "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT" },
    { table_name: "tinder_conversations", contype: "c", columns: ["channel"], reference_table: null, confdeltype: " ", definition: "CHECK ((channel = 'tinder'::text))" },
    { table_name: "tinder_conversation_messages", contype: "p", columns: ["message_id"], reference_table: null, confdeltype: " ", definition: "PRIMARY KEY (message_id)" },
    { table_name: "tinder_conversation_messages", contype: "f", columns: ["conversation_id"], reference_table: "tinder_conversations", confdeltype: "r", definition: "FOREIGN KEY (conversation_id) REFERENCES tinder_conversations(conversation_id) ON DELETE RESTRICT" },
    { table_name: "tinder_conversation_messages", contype: "u", columns: ["conversation_id", "ordinal"], reference_table: null, confdeltype: " ", definition: "UNIQUE (conversation_id, ordinal)" },
    { table_name: "tinder_conversation_messages", contype: "c", columns: ["ordinal"], reference_table: null, confdeltype: " ", definition: "CHECK ((ordinal >= 0))" },
    { table_name: "tinder_conversation_messages", contype: "c", columns: ["direction"], reference_table: null, confdeltype: " ", definition: "CHECK ((direction = ANY (ARRAY['INBOUND'::text, 'OUTBOUND'::text])))" }
  ];
  const indexes = [
    { table_name: "tinder_conversations", indexname: "tinder_conversations_device_updated_idx", indexdef: "CREATE INDEX tinder_conversations_device_updated_idx ON public.tinder_conversations USING btree (device_id, updated_at DESC)" },
    { table_name: "tinder_conversation_messages", indexname: "tinder_conversation_messages_conversation_ordinal_idx", indexdef: "CREATE INDEX tinder_conversation_messages_conversation_ordinal_idx ON public.tinder_conversation_messages USING btree (conversation_id, ordinal)" }
  ];
  const allCreated = () => createdTables.size === 2;
  async function query(sql) {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    statements.push(normalized);
    if (failOn && normalized.includes(failOn)) throw new Error("forced migration failure");
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(normalized)) return { rows: [] };
    if (normalized.includes("FROM pg_attribute a")) return { rows: [{ type_name: "uuid", not_null: true, primary_key: true }] };
    if (normalized.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: true }] };
    if (normalized.includes("FROM pg_class c JOIN pg_namespace")) {
      return { rows: allCreated() ? [
        { table_name: "tinder_conversation_messages", relkind: "r" },
        { table_name: "tinder_conversations", relkind: "r" }
      ] : [] };
    }
    if (normalized.includes("FROM information_schema.columns")) return { rows: allCreated() ? columns : [] };
    if (normalized.includes("FROM pg_constraint con")) return { rows: allCreated() ? constraints : [] };
    if (normalized.includes("FROM pg_indexes")) return { rows: allCreated() ? indexes : [] };
    if (normalized.includes("FROM pg_trigger trigger")) return { rows: [{ count: 0 }] };
    if (normalized.includes("SELECT (SELECT COUNT(*)::int FROM tinder_conversations)")) return { rows: [{ conversations: 0, messages: 0 }] };
    if (normalized.startsWith("CREATE TABLE tinder_conversations")) { createdTables.add("tinder_conversations"); return { rows: [] }; }
    if (normalized.startsWith("CREATE TABLE tinder_conversation_messages")) { createdTables.add("tinder_conversation_messages"); return { rows: [] }; }
    if (normalized.startsWith("CREATE INDEX")) return { rows: [] };
    throw new Error(`Unexpected migration SQL: ${normalized}`);
  }
  return {
    statements,
    async connect() { return { query, release() {} }; }
  };
}

test("thin mirror payload only accepts ordinary product fields", () => {
  const normalized = normalizeTinderMirrorPayload({
    profile: profile(),
    messages: [message("INBOUND", "Hello"), message("OUTBOUND", "Hi")],
    history_complete: false
  });
  assert.equal(normalized.profile.display_name, "Example profile");
  assert.equal(normalized.messages.length, 2);
  assert.throws(
    () => normalizeTinderMirrorPayload({
      profile: profile(),
      messages: [message("INBOUND", "Hello")],
      history_complete: false,
      appium_element_id: "must-not-cross-the-adapter"
    }),
    (error) => error instanceof TinderMirrorError && error.code === "INVALID_TINDER_MIRROR_PAYLOAD"
  );
});

test("history merge uses ordered overlap and retains repeated equal messages at different positions", () => {
  const existing = [message("INBOUND", "A"), message("OUTBOUND", "B"), message("INBOUND", "A")];
  const observed = [message("OUTBOUND", "B"), message("INBOUND", "A"), message("OUTBOUND", "C")];
  const merged = mergeTinderHistory(existing, observed);
  assert.deepEqual(merged.map((item) => item.text), ["A", "B", "A", "C"]);
  assert.equal(largestContiguousOverlap(existing, observed), 2);
  assert.throws(
    () => mergeTinderHistory(existing, [message("INBOUND", "Unrelated")]),
    (error) => error instanceof TinderMirrorError && error.code === "TINDER_HISTORY_OVERLAP_UNVERIFIED"
  );
});

test("a profile name alone never reuses a conversation", () => {
  const observation = normalizeTinderMirrorPayload({
    profile: profile(),
    messages: [message("INBOUND", "One"), message("OUTBOUND", "Two")],
    history_complete: false
  });
  const candidate = {
    id: "candidate",
    profile: { display_name: "Example profile", attributes: {}, media_refs: [] },
    messages: observation.messages
  };
  assert.equal(selectConservativeConversationMatch([candidate], observation), null);
});

test("exactly one compatible normal product record with ordered history is reusable", () => {
  const observation = normalizeTinderMirrorPayload({
    profile: profile({ city: "Example city", age: "30" }),
    messages: [message("INBOUND", "One"), message("OUTBOUND", "Two"), message("INBOUND", "Three")],
    history_complete: false
  });
  const candidate = {
    id: "candidate",
    profile: profile({ city: "Example city", age: "30" }),
    messages: observation.messages
  };
  assert.equal(selectConservativeConversationMatch([candidate], observation), candidate);
  assert.equal(selectConservativeConversationMatch([candidate, { ...candidate, id: "ambiguous" }], observation), null);
  assert.equal(selectConservativeConversationMatch([
    { ...candidate, profile: profile({ city: "Different city", age: "30" }) }
  ], observation), null);
});

test("Appium adapter holds only RAM sweep continuity and persists a completed assembled history", async () => {
  const requests = [];
  const adapter = createTinderAppiumAdapter({
    deviceId: "00000000-0000-4000-8000-000000000001",
    transport: {
      async resolve(request) {
        requests.push({ type: "resolve", ...request });
        return { action: "READ_HISTORY", conversation: null };
      },
      async sync(request) {
        requests.push({ type: "sync", ...request });
        return { conversation: { id: "00000000-0000-4000-8000-000000000002" } };
      }
    }
  });
  adapter.start({ profile: profile(), messages: [message("OUTBOUND", "B"), message("INBOUND", "C")] });
  adapter.appendViewport([message("INBOUND", "A"), message("OUTBOUND", "B")]);
  await adapter.resolve();
  await adapter.persistCompletedHistory();
  assert.equal(requests[0].observation.history_complete, false);
  assert.equal(requests[1].observation.history_complete, true);
  assert.deepEqual(requests[1].observation.messages.map((item) => item.text), ["A", "B", "C"]);
  adapter.clear();
  assert.throws(() => adapter.appendViewport([message("INBOUND", "x")]), /No Tinder conversation/);
});

test("one completed initial thread is created once and a later exact reopen skips history", async () => {
  const pool = createMemoryPool();
  const mirror = createTinderConversationMirror({
    pool,
    now: () => new Date("2026-09-24T10:00:00.000Z"),
    idFactory: () => "00000000-0000-4000-8000-000000000099"
  });
  const payload = {
    profile: profile({ city: "Example city", age: "30" }),
    messages: [message("INBOUND", "One"), message("OUTBOUND", "Two"), message("INBOUND", "Three")],
    history_complete: true
  };
  const before = await mirror.resolve({ deviceId: "00000000-0000-4000-8000-000000000001", payload: { ...payload, history_complete: false } });
  assert.equal(before.action, "READ_HISTORY");
  const created = await mirror.sync({ deviceId: "00000000-0000-4000-8000-000000000001", payload });
  assert.equal(created.created, true);
  assert.equal(created.conversation.message_count, 3);
  const reopened = await mirror.resolve({ deviceId: "00000000-0000-4000-8000-000000000001", payload: { ...payload, history_complete: false } });
  assert.equal(reopened.action, "SKIP_HISTORY");
  assert.equal(reopened.conversation.id, created.conversation.id);
  const syncedAgain = await mirror.sync({ deviceId: "00000000-0000-4000-8000-000000000001", payload });
  assert.equal(syncedAgain.created, false);
  assert.equal(syncedAgain.history_changed, false);
  assert.equal((await mirror.list()).length, 1);
  assert.equal((await mirror.detail(created.conversation.id)).messages.length, 3);
});

test("migration is additive, device-bound and has no retired prototype machinery", () => {
  const migration = readFileSync(new URL("../migrations/20260924_tinder_conversation_mirror.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE tinder_conversations/);
  assert.match(migration, /CREATE TABLE tinder_conversation_messages/);
  assert.match(migration, /REFERENCES device_bridge_devices\(device_id\) ON DELETE RESTRICT/);
  assert.match(migration, /REFERENCES tinder_conversations\(conversation_id\) ON DELETE RESTRICT/);
  assert.doesNotMatch(migration, /ON DELETE CASCADE|CREATE TRIGGER|CREATE FUNCTION/i);
});

test("migration preflight is read-only and a fresh two-table apply commits only after its catalog postcheck", async () => {
  const preflightPool = createMigrationPool();
  const preflight = await preflightTinderConversationMirror(preflightPool);
  assert.equal(preflight.state, "ELIGIBLE_FOR_MIGRATION");
  assert.equal(preflightPool.statements.some((statement) => statement.startsWith("CREATE")), false);
  assert.ok(preflightPool.statements.includes("BEGIN READ ONLY"));

  const pool = createMigrationPool();
  const result = await migrateTinderConversationMirror(pool);
  assert.equal(result.migrated, true);
  assert.equal(result.postcheck.state, "ALREADY_CANONICAL");
  assert.equal(pool.statements.filter((statement) => statement.startsWith("CREATE ")).length, 4);
  assert.equal(pool.statements.at(-1), "COMMIT");
  assert.equal(pool.statements.some((statement) => statement.startsWith("ROLLBACK")), false);
});

test("migration rolls back before commit if a DDL statement fails", async () => {
  const pool = createMigrationPool({ failOn: "CREATE INDEX tinder_conversations_device_updated_idx" });
  let failure;
  try {
    await migrateTinderConversationMirror(pool);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.ok(pool.statements.some((statement) => statement.startsWith("ROLLBACK")));
  assert.deepEqual(getTinderConversationMirrorMigrationDiagnostic(failure), {
    stage: "DDL_EXECUTION",
    code: "DATABASE_OPERATION_FAILED",
    transaction: "STARTED",
    rollback: "COMPLETED",
    ddl_started: true,
    reason: null
  });
});

test("new mirror routes use existing dashboard transport without a bridge gate", () => {
  const routes = readFileSync(new URL("../tinder-mirror/routes.js", import.meta.url), "utf8");
  assert.match(routes, /dashboardApiAuthorized/);
  assert.doesNotMatch(routes, /requireDeviceBridgeReady|registerAuthenticatedRequestReplay|verifyAuthenticatedDeviceRequest/);
  assert.match(routes, /\/dashboard-api\/tinder\/conversations/);
});
