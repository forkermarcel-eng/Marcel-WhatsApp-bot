import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  TinderMirrorError,
  createTinderConversationMirror,
  existingSuffixObservedPrefixOverlap,
  largestContiguousOverlap,
  mergeTinderHistory,
  normalizeTinderConversationDeltaPayload,
  normalizeTinderInboxOrder,
  normalizeTinderMirrorPayload,
  normalizeTinderProfile,
  selectConservativeConversationMatch
} from "../tinder-mirror/conversation.js";
import {
  getTinderConversationMirrorMigrationDiagnostic,
  migrateTinderConversationMirror,
  preflightTinderConversationMirror
} from "../tinder-mirror/migration.js";
import {
  createExistingDashboardBearerTransport,
  createTinderAppiumAdapter,
  createTinderAppiumDeltaAdapter
} from "../tinder-mirror/appium-adapter.js";
import {
  classifyBubbleDirection,
  classifyMessageTextNode,
  flattenUiNodes,
  parseUiAutomatorXml,
  screenBounds
} from "../tinder-mirror/appium-ui-observer.js";
import {
  headerProfileTargetFromXml,
  mergeProfileSnapshots,
  observeInboxConversationRowsFromXml,
  observeInboxFromXml,
  observeProfileFromXml
} from "../tinder-mirror/appium-conversation-reader.js";
import {
  createRamOnlyInitialSweepBinding,
  executeInitialInboxPlanEntry,
  planInitialInboxProcessing,
  readBoundedKnownDelta,
  selectStoredDeltaConversation,
  summarizeSameSweepReopens
} from "../scripts/tinder-block2-initial-sync.mjs";

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

const zteScreen = { left: 0, top: 0, right: 576, bottom: 1280, width: 576, height: 1280 };

test("restart delta revalidation refuses name-only, direction mismatch, singleton and ambiguous stored tails", () => {
  const messages = [message("inbound", "First"), message("outbound", "Second")];
  const candidate = { conversation: { id: "existing", profile: { display_name: "Example" } }, messages };
  const viewport = { profile_display_name: "Example", messages: [...messages, message("inbound", "New")] };
  assert.equal(selectStoredDeltaConversation([candidate], viewport), candidate);
  assert.equal(selectStoredDeltaConversation([candidate, { ...candidate, conversation: { ...candidate.conversation, id: "other" } }], viewport), null);
  assert.equal(selectStoredDeltaConversation([candidate], { ...viewport, messages: [message("inbound", "Different")] }), null);
  assert.equal(selectStoredDeltaConversation([candidate], { ...viewport, messages: messages.map(value => ({ ...value, direction: "inbound" })) }), null);
  assert.equal(selectStoredDeltaConversation([{ ...candidate, messages: messages.slice(1) }], { ...viewport, messages: viewport.messages.slice(1) }), null);
});

test("live delta reads only to the stored ordered tail across bounded viewports", async () => {
  const messages = Array.from({ length: 8 }, (_, index) => message(index % 2 ? "outbound" : "inbound", `Example ${index}`));
  const viewport = values => ({ profile_display_name: "Example", messages: values });
  let scrolls = 0;
  const read = await readBoundedKnownDelta({
    knownMessages: messages.slice(0, 3),
    initialViewport: viewport(messages.slice(5)),
    readPrevious: async () => ({
      canScrollMore: true,
      viewport: viewport(++scrolls === 1 ? messages.slice(3, 7) : messages.slice(1, 5))
    })
  });
  assert.equal(scrolls, 2);
  assert.deepEqual(read, messages.slice(1));
  await readBoundedKnownDelta({
    knownMessages: messages.slice(0, 3), initialViewport: viewport(messages.slice(1)),
    readPrevious: async () => assert.fail("Stored tail already visible: no scroll")
  });
});

test("live delta refuses header drift, missing stored tail and exhausted bound", async () => {
  const knownMessages = [message("inbound", "Older A"), message("outbound", "Older B")];
  const initialViewport = { profile_display_name: "Example", messages: [message("inbound", "Newer")] };
  await assert.rejects(readBoundedKnownDelta({ knownMessages, initialViewport,
    readPrevious: async () => ({ canScrollMore: true, viewport: { ...initialViewport, profile_display_name: "Different" } })
  }), /conversation changed/);
  await assert.rejects(readBoundedKnownDelta({ knownMessages, initialViewport,
    readPrevious: async () => ({ canScrollMore: false, viewport: initialViewport })
  }), /boundary without/);
  let scrolls = 0;
  await assert.rejects(readBoundedKnownDelta({ knownMessages, initialViewport, maxGestures: 2,
    readPrevious: async () => { scrolls += 1; return { canScrollMore: true, viewport: initialViewport }; }
  }), /bounded viewports/);
  assert.equal(scrolls, 2);
});

function createMemoryPool() {
  const state = {
    devices: new Set(["00000000-0000-4000-8000-000000000001"]),
    conversations: new Map(),
    messages: new Map(),
    deleteMessageCalls: 0,
    statements: []
  };
  const rowsForConversation = (conversation) => conversation ? [{ ...conversation }] : [];
  async function query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    state.statements.push(normalized);
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(normalized)) return { rows: [] };
    if (normalized.startsWith("SELECT device_id FROM device_bridge_devices")) {
      return { rows: state.devices.has(params[0]) ? [{ device_id: params[0] }] : [] };
    }
    if (normalized.startsWith("SELECT") && normalized.includes("FROM tinder_conversation_messages")) {
      const rows = (state.messages.get(params[0]) || [])
        .slice()
        .sort((left, right) => left.ordinal - right.ordinal)
        .map((item) => ({ ...item }));
      return { rows };
    }
    if (normalized.includes("FROM tinder_conversations") && normalized.includes("profile->>'display_name'")) {
      const rows = [...state.conversations.values()]
        .filter((item) => item.device_id === params[0] && item.profile.display_name === params[1])
        .map((item) => ({ ...item }));
      return { rows };
    }
    if (normalized.includes("FROM tinder_conversations") && normalized.includes("conversation_id=$")) {
      const conversationId = normalized.includes("conversation_id=$2") ? params[1] : params[0];
      return { rows: rowsForConversation(state.conversations.get(conversationId)) };
    }
    if (normalized.startsWith("INSERT INTO tinder_conversations")) {
      const [conversationId, deviceId, serializedProfile, historyComplete, timestamp, lastMessageVisibleTime, inboxPosition] = params;
      state.conversations.set(conversationId, {
        conversation_id: conversationId,
        device_id: deviceId,
        profile: JSON.parse(serializedProfile),
        history_complete: historyComplete,
        profile_synced_at: timestamp,
        history_synced_at: timestamp,
        last_message_visible_time: lastMessageVisibleTime ?? null,
        inbox_position: inboxPosition ?? null,
        created_at: timestamp,
        updated_at: timestamp
      });
      return { rows: [] };
    }
    if (normalized.startsWith("DELETE FROM tinder_conversation_messages")) {
      state.deleteMessageCalls += 1;
      state.messages.set(params[0], []);
      return { rows: [] };
    }
    if (normalized.startsWith("INSERT INTO tinder_conversation_messages")) {
      const [messageId, conversationId, ordinal, direction, text, visibleTime, visibleStatus] = params;
      const rows = state.messages.get(conversationId) || [];
      rows.push({ message_id: messageId, ordinal, direction, message_text: text, visible_time: visibleTime, visible_status: visibleStatus });
      state.messages.set(conversationId, rows);
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE tinder_conversation_messages SET ordinal=ordinal+$2")) {
      const [conversationId, offset] = params;
      for (const row of state.messages.get(conversationId) || []) row.ordinal += offset;
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE tinder_conversation_messages SET ordinal=$3")) {
      const [conversationId, messageId, ordinal, direction, text, visibleTime, visibleStatus] = params;
      const row = (state.messages.get(conversationId) || []).find((item) => item.message_id === messageId);
      if (!row) throw new Error("message row not found");
      Object.assign(row, { ordinal, direction, message_text: text, visible_time: visibleTime, visible_status: visibleStatus });
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE tinder_conversations SET updated_at=$7")) {
      const [conversationId, deviceId, hasVisibleTime, visibleTime, hasInboxPosition, inboxPosition, timestamp] = params;
      const existing = state.conversations.get(conversationId);
      if (!existing || existing.device_id !== deviceId) throw new Error("conversation row not found");
      if (hasVisibleTime) existing.last_message_visible_time = visibleTime;
      if (hasInboxPosition) existing.inbox_position = inboxPosition;
      existing.updated_at = timestamp;
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE tinder_conversations SET last_message_visible_time")) {
      const [conversationId, deviceId, hasVisibleTime, visibleTime, inboxPosition] = params;
      const existing = state.conversations.get(conversationId);
      if (!existing || existing.device_id !== deviceId) throw new Error("conversation row not found");
      if (hasVisibleTime) existing.last_message_visible_time = visibleTime;
      existing.inbox_position = inboxPosition;
      return { rows: [] };
    }
    if (normalized.startsWith("UPDATE tinder_conversations")) {
      const [
        conversationId,
        serializedProfile,
        historyComplete,
        hasVisibleTime,
        visibleTime,
        hasInboxPosition,
        inboxPosition,
        profileChanged,
        timestamp,
        historyChanged,
        completionChanged
      ] = params;
      const existing = state.conversations.get(conversationId);
      existing.profile = JSON.parse(serializedProfile);
      existing.history_complete = historyComplete;
      if (hasVisibleTime) existing.last_message_visible_time = visibleTime;
      if (hasInboxPosition) existing.inbox_position = inboxPosition;
      if (profileChanged) existing.profile_synced_at = timestamp;
      if (historyChanged) existing.history_synced_at = timestamp;
      if (profileChanged || historyChanged || completionChanged) existing.updated_at = timestamp;
      return { rows: [] };
    }
    if (normalized.includes("FROM tinder_conversations c") && normalized.includes("COUNT(m.message_id)")) {
      return {
        rows: [...state.conversations.values()]
          .sort((left, right) => {
            const leftPosition = left.inbox_position ?? Number.POSITIVE_INFINITY;
            const rightPosition = right.inbox_position ?? Number.POSITIVE_INFINITY;
            return leftPosition - rightPosition || left.conversation_id.localeCompare(right.conversation_id);
          })
          .map((item) => ({ ...item, message_count: (state.messages.get(item.conversation_id) || []).length }))
      };
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }
  return {
    state,
    async connect() { return { query, release() {} }; },
    query
  };
}

function createMigrationPool({ failOn = null, catalogVariant = false, stringColumns = false } = {}) {
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
    { table_name: "tinder_conversations", contype: "c", columns: ["channel"], reference_table: null, confdeltype: " ", definition: catalogVariant ? "CHECK (((channel)::text = 'tinder'::text))" : "CHECK ((channel = 'tinder'::text))" },
    { table_name: "tinder_conversation_messages", contype: "p", columns: ["message_id"], reference_table: null, confdeltype: " ", definition: "PRIMARY KEY (message_id)" },
    { table_name: "tinder_conversation_messages", contype: "f", columns: ["conversation_id"], reference_table: "tinder_conversations", confdeltype: "r", definition: "FOREIGN KEY (conversation_id) REFERENCES tinder_conversations(conversation_id) ON DELETE RESTRICT" },
    { table_name: "tinder_conversation_messages", contype: "u", columns: ["conversation_id", "ordinal"], reference_table: null, confdeltype: " ", definition: "UNIQUE (conversation_id, ordinal)" },
    { table_name: "tinder_conversation_messages", contype: "c", columns: ["ordinal"], reference_table: null, confdeltype: " ", definition: "CHECK ((ordinal >= 0))" },
    { table_name: "tinder_conversation_messages", contype: "c", columns: ["direction"], reference_table: null, confdeltype: " ", definition: catalogVariant ? "CHECK (((direction)::text = ANY ((ARRAY['INBOUND'::text, 'OUTBOUND'::text])::text[])))" : "CHECK ((direction = ANY (ARRAY['INBOUND'::text, 'OUTBOUND'::text])))" }
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
    if (normalized.includes("FROM pg_constraint con")) return {
      rows: allCreated() ? constraints.map((row) => ({ ...row, columns: stringColumns ? row.columns.join(",") : row.columns })) : []
    };
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
  assert.throws(
    () => normalizeTinderMirrorPayload({
      direct_continuity_repair: true,
      profile: profile(),
      messages: [message("INBOUND", "Hello")],
      history_complete: true
    }),
    (error) => error instanceof TinderMirrorError && error.code === "INVALID_TINDER_MIRROR_PAYLOAD"
  );
});

test("Inbox ordering keeps only direct source labels and a non-negative current position", () => {
  const normalized = normalizeTinderInboxOrder({
    last_message_visible_time: "08:15",
    inbox_position: 0
  }, { requireInboxPosition: true });
  assert.deepEqual(normalized, {
    has_last_message_visible_time: true,
    last_message_visible_time: "08:15",
    has_inbox_position: true,
    inbox_position: 0
  });
  assert.throws(
    () => normalizeTinderInboxOrder({ inbox_position: -1 }, { requireInboxPosition: true }),
    (error) => error instanceof TinderMirrorError && error.code === "INVALID_TINDER_MIRROR_PAYLOAD"
  );
  assert.throws(
    () => normalizeTinderInboxOrder({ inbox_position: null }, { requireInboxPosition: true }),
    (error) => error instanceof TinderMirrorError && error.code === "INVALID_TINDER_MIRROR_PAYLOAD"
  );
  assert.throws(
    () => normalizeTinderInboxOrder({ inbox_position: 1, technical_updated_at: "must-not-cross" }),
    (error) => error instanceof TinderMirrorError && error.code === "INVALID_TINDER_MIRROR_PAYLOAD"
  );
  const payload = normalizeTinderMirrorPayload({
    profile: profile(),
    messages: [message("INBOUND", "Hello")],
    history_complete: false,
    last_message_visible_time: "Heute",
    inbox_position: 3
  });
  assert.equal(payload.last_message_visible_time, "Heute");
  assert.equal(payload.inbox_position, 3);
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

test("a uniquely exact singleton reuses its complete stored product record without name-only matching", () => {
  const observation = normalizeTinderMirrorPayload({
    profile: profile({ city: "Example city", age: "30" }),
    messages: [message("INBOUND", "Only ordinary message")],
    history_complete: false
  });
  const candidate = {
    id: "singleton",
    profile: profile({ city: "Example city", age: "30" }),
    messages: observation.messages
  };
  assert.equal(selectConservativeConversationMatch([candidate], observation), candidate);
  assert.equal(selectConservativeConversationMatch([
    candidate,
    { ...candidate, id: "ambiguous-copy" }
  ], observation), null);
  assert.equal(selectConservativeConversationMatch([
    { ...candidate, profile: profile({ city: "Different city", age: "30" }) }
  ], observation), null);
});

test("Appium adapter holds only RAM sweep continuity and requires a verified oldest boundary before completion", async () => {
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
  adapter.start({
    profile: profile(),
    messages: [message("OUTBOUND", "B"), message("INBOUND", "C")],
    lastMessageVisibleTime: "08:15",
    inboxPosition: 2
  });
  adapter.appendViewport([message("INBOUND", "A"), message("OUTBOUND", "B")]);
  await adapter.resolve();
  await assert.rejects(adapter.persistCompletedHistory(), /verified oldest history boundary/);
  adapter.appendViewport([message("OUTBOUND", "B"), message("INBOUND", "C")]);
  await assert.rejects(adapter.persistCompletedHistory({ oldestBoundaryReached: false }), /verified oldest history boundary/);
  await adapter.persistCompletedHistory({ oldestBoundaryReached: true });
  assert.equal(requests[0].observation.history_complete, false);
  assert.equal(requests[1].observation.history_complete, true);
  assert.equal(requests[1].observation.last_message_visible_time, "08:15");
  assert.equal(requests[1].observation.inbox_position, 2);
  assert.equal(Object.hasOwn(requests[1].observation, "has_last_message_visible_time"), false);
  assert.equal(Object.hasOwn(requests[1].observation, "has_inbox_position"), false);
  assert.deepEqual(requests[1].observation.messages.map((item) => item.text), ["A", "B", "C"]);
  adapter.clear();
  assert.throws(() => adapter.appendViewport([message("INBOUND", "x")]), /No Tinder conversation/);
});

test("Appium adapter carries direct continuity only for an explicitly selected completed-history repair", async () => {
  const requests = [];
  const adapter = createTinderAppiumAdapter({
    deviceId: "00000000-0000-4000-8000-000000000001",
    transport: {
      async resolve(request) { requests.push({ type: "resolve", ...request }); return { action: "READ_HISTORY", conversation: null }; },
      async sync(request) { requests.push({ type: "sync", ...request }); return { created: false, conversation: { id: "00000000-0000-4000-8000-000000000002" } }; }
    }
  });
  adapter.start({
    profile: profile(),
    messages: [message("INBOUND", "Verified current")],
    continuationConversationId: "00000000-0000-4000-8000-000000000002",
    directContinuityRepair: true
  });
  await adapter.persistCompletedHistory({ oldestBoundaryReached: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].type, "sync");
  assert.equal(requests[0].observation.direct_continuity_repair, true);
  assert.equal(requests[0].observation.continuation_conversation_id, "00000000-0000-4000-8000-000000000002");
});

test("history overlap keeps direction corrections from a verified bubble container", () => {
  const existing = [
    message("OUTBOUND", "Older"),
    message("OUTBOUND", "Long incoming"),
    message("OUTBOUND", "Newest")
  ];
  const observed = [
    message("INBOUND", "Older"),
    message("INBOUND", "Long incoming"),
    message("OUTBOUND", "Newest")
  ];
  const merged = mergeTinderHistory(existing, observed);
  assert.deepEqual(merged.map((item) => item.direction), ["INBOUND", "INBOUND", "OUTBOUND"]);
  assert.equal(largestContiguousOverlap(existing, observed), 1);
  assert.equal(largestContiguousOverlap(existing, observed, { identityOnly: true }), 3);
});

test("current ZTE Tinder bubble edges classify wide incoming and right-anchored outgoing containers", () => {
  assert.equal(classifyBubbleDirection({ left: 84, top: 546, right: 492, bottom: 681, width: 408, height: 135 }, zteScreen), "INBOUND");
  assert.equal(classifyBubbleDirection({ left: 84, top: 209, right: 407, bottom: 282, width: 323, height: 73 }, zteScreen), "INBOUND");
  assert.equal(classifyBubbleDirection({ left: 380, top: 341, right: 564, bottom: 414, width: 184, height: 73 }, zteScreen), "OUTBOUND");
  assert.equal(classifyBubbleDirection({ left: 144, top: 740, right: 564, bottom: 937, width: 420, height: 197 }, zteScreen), "OUTBOUND");
  assert.equal(classifyBubbleDirection({ left: 156, top: 315, right: 421, bottom: 341, width: 265, height: 26 }, zteScreen), null);
});

test("class-named UiAutomator2 XML keeps the verified same-bound FrameLayout as a bubble container", () => {
  const root = parseUiAutomatorXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.recyclerview.widget.RecyclerView bounds="[0,152][576,1122]">
          <android.view.ViewGroup bounds="[0,152][576,209]">
            <android.widget.FrameLayout bounds="[144,152][564,200]">
              <android.widget.TextView text="ordinary visible message" bounds="[144,152][564,200]" />
            </android.widget.FrameLayout>
          </android.view.ViewGroup>
        </androidx.recyclerview.widget.RecyclerView>
      </android.widget.FrameLayout>
    </hierarchy>`);
  const text = flattenUiNodes(root).find((node) => node.attributes.text);
  assert.ok(text);
  assert.equal(classifyMessageTextNode(text, screenBounds(root)), "OUTBOUND");
});

test("UiAutomator2 attribute parsing decodes strict HTML5 entities once and preserves native Unicode", () => {
  const root = parseUiAutomatorXml(`
    <hierarchy rotation="0">
      <android.widget.TextView
        text="line one&#10;line two &#x1FAE3; &ouml;"
        content-desc="literal &#38;amp; remains encoded"
        bounds="[0,0][576,1280]" />
    </hierarchy>`);
  const node = flattenUiNodes(root)[0];
  assert.ok(node);
  assert.equal(node.attributes.text, "line one\nline two 🫣 ö");
  assert.equal(node.attributes["content-desc"], "literal &amp; remains encoded");
});

test("Inbox observation excludes semantic Match-/Like-CTA rows without naming a person", () => {
  const rows = observeInboxConversationRowsFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.recyclerview.widget.RecyclerView bounds="[0,225][576,1122]">
          <android.widget.FrameLayout bounds="[0,618][576,726]">
            <android.widget.TextView text="Mag Dich" bounds="[80,630][220,680]" />
            <android.widget.TextView text="Vor kurzem aktiv - jetzt matchen!" bounds="[80,680][500,710]" />
          </android.widget.FrameLayout>
          <android.widget.FrameLayout bounds="[0,726][576,846]">
            <android.widget.TextView text="Ordinary existing message preview" bounds="[80,740][500,800]" />
            <android.widget.TextView text="DU BIST DRAN" bounds="[360,740][540,780]" />
          </android.widget.FrameLayout>
        </androidx.recyclerview.widget.RecyclerView>
      </android.widget.FrameLayout>
    </hierarchy>`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].bounds.top, 726);
});

test("semantic Inbox observation exposes only the verified vertical Inbox container and keeps CTA rows out", () => {
  const inbox = observeInboxFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.recyclerview.widget.RecyclerView bounds="[0,225][576,1122]">
          <android.widget.FrameLayout bounds="[0,546][576,618]">
            <android.widget.TextView text="Nachrichten" bounds="[32,560][230,604]" />
          </android.widget.FrameLayout>
          <android.widget.FrameLayout bounds="[0,618][576,726]">
            <android.view.View clickable="true" bounds="[0,618][576,726]" />
            <android.widget.TextView text="Mag Dich" bounds="[80,630][220,680]" />
            <android.widget.TextView text="Vor kurzem aktiv - jetzt matchen!" bounds="[80,680][500,710]" />
          </android.widget.FrameLayout>
          <android.widget.FrameLayout bounds="[0,726][576,846]">
            <android.view.View clickable="true" bounds="[0,726][576,846]" />
            <android.widget.TextView text="Existing ordinary preview" bounds="[80,740][500,800]" />
            <android.widget.TextView text="DU BIST DRAN" bounds="[360,740][540,780]" />
          </android.widget.FrameLayout>
        </androidx.recyclerview.widget.RecyclerView>
        <androidx.recyclerview.widget.RecyclerView bounds="[0,160][576,216]">
          <android.widget.FrameLayout bounds="[0,160][120,216]">
            <android.widget.TextView text="Tile" bounds="[8,168][110,204]" />
          </android.widget.FrameLayout>
        </androidx.recyclerview.widget.RecyclerView>
      </android.widget.FrameLayout>
    </hierarchy>`);
  assert.ok(inbox);
  assert.deepEqual(inbox.scroll_bounds, { left: 0, top: 225, right: 576, bottom: 1122, width: 576, height: 897 });
  assert.equal(inbox.rows.length, 1);
  assert.equal(inbox.rows[0].bounds.top, 726);
});

test("semantic Inbox preserves one unparsed Tinder time label but refuses an ambiguous row label", () => {
  const inbox = observeInboxFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.recyclerview.widget.RecyclerView bounds="[0,225][576,1122]">
          <android.widget.FrameLayout bounds="[0,726][576,846]">
            <android.view.View clickable="true" bounds="[0,726][576,846]" />
            <android.widget.TextView text="Existing ordinary preview" bounds="[80,740][420,800]" />
            <android.widget.TextView text="08:15" bounds="[460,740][540,780]" />
          </android.widget.FrameLayout>
          <android.widget.FrameLayout bounds="[0,846][576,966]">
            <android.view.View clickable="true" bounds="[0,846][576,966]" />
            <android.widget.TextView text="Another ordinary preview" bounds="[80,860][420,920]" />
            <android.widget.TextView text="Heute" bounds="[430,860][500,900]" />
            <android.widget.TextView text="08:15" bounds="[500,860][560,900]" />
          </android.widget.FrameLayout>
        </androidx.recyclerview.widget.RecyclerView>
      </android.widget.FrameLayout>
    </hierarchy>`);
  assert.ok(inbox);
  assert.equal(inbox.rows.length, 2);
  assert.equal(inbox.rows[0].last_message_visible_time, "08:15");
  assert.equal(inbox.rows[1].last_message_visible_time, null);
});

test("semantic Inbox observation refuses a conversation screen with a composer", () => {
  const inbox = observeInboxFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.recyclerview.widget.RecyclerView bounds="[0,160][576,1080]">
          <android.widget.FrameLayout bounds="[0,700][576,820]">
            <android.widget.TextView text="Visible ordinary text" bounds="[80,730][500,790]" />
          </android.widget.FrameLayout>
        </androidx.recyclerview.widget.RecyclerView>
        <android.widget.EditText bounds="[70,1120][500,1200]" />
      </android.widget.FrameLayout>
    </hierarchy>`);
  assert.equal(inbox, null);
});

test("profile navigation accepts only the described header avatar of a verified conversation", () => {
  const source = `
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <android.widget.ImageView clickable="true" content-desc="back" bounds="[20,58][70,108]" />
        <android.widget.ImageView clickable="true" content-desc="profile" bounds="[112,52][172,112]" />
        <android.widget.TextView text="Example Profile" bounds="[200,68][390,116]" />
        <android.widget.ImageView clickable="true" content-desc="menu" bounds="[480,52][536,108]" />
        <androidx.recyclerview.widget.RecyclerView bounds="[0,160][576,1080]">
          <android.widget.FrameLayout bounds="[0,500][576,610]">
            <android.widget.FrameLayout bounds="[80,510][430,590]">
              <android.widget.TextView text="Visible ordinary message" bounds="[96,528][410,572]" />
            </android.widget.FrameLayout>
          </android.widget.FrameLayout>
        </androidx.recyclerview.widget.RecyclerView>
        <android.widget.EditText bounds="[70,1120][500,1200]" />
      </android.widget.FrameLayout>
    </hierarchy>`;
  assert.deepEqual(headerProfileTargetFromXml(source), { left: 112, top: 52, right: 172, bottom: 112, width: 60, height: 60 });
  assert.equal(headerProfileTargetFromXml(source.replace('content-desc="profile"', 'content-desc=""')), null);
});

test("profile observation accepts the real ScrollView and ViewPager surface with direct chat continuity", () => {
  const observed = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,740]">
            <androidx.viewpager.widget.ViewPager bounds="[0,160][576,600]" />
            <android.widget.TextView text="Visible profile detail" bounds="[40,310][500,360]" />
            <android.widget.TextView clickable="true" text="Control label" bounds="[40,650][300,700]" />
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, { expectedDisplayName: "Example Profile" });
  assert.ok(observed);
  assert.deepEqual(observed.profile, {
    display_name: "Example Profile",
    attributes: { visible_profile_01: "Visible profile detail" },
    media_refs: []
  });
  assert.equal(Object.keys(observed.profile.attributes).some((key) => key.startsWith("structured_profile_")), false);
  assert.deepEqual(observed.scroll_bounds, { left: 0, top: 160, right: 576, bottom: 1120, width: 576, height: 960 });
  assert.deepEqual(observed.media_bounds, { left: 0, top: 160, right: 576, bottom: 600, width: 576, height: 440 });
  assert.doesNotMatch(JSON.stringify(observed), /content-desc/);
});

test("profile observation adds deterministic visible heading-to-value pairs without replacing the ordered fallback", () => {
  const observed = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,900]">
            <androidx.viewpager.widget.ViewPager bounds="[0,160][576,600]" />
            <android.widget.TextView heading="true" text="Visible section one" bounds="[40,620][500,660]" />
            <android.widget.TextView text="Visible value one" bounds="[40,668][500,712]" />
            <android.widget.TextView heading="true" text="Visible section two" bounds="[40,730][500,770]" />
            <android.widget.TextView text="Visible value two" bounds="[40,778][500,822]" />
            <android.widget.TextView clickable="true" text="Non profile control" bounds="[40,840][500,880]" />
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, { expectedDisplayName: "Example Profile" });
  assert.ok(observed);
  assert.deepEqual(observed.profile.attributes, {
    visible_profile_01: "Visible section one",
    visible_profile_02: "Visible value one",
    visible_profile_03: "Visible section two",
    visible_profile_04: "Visible value two",
    structured_profile_01_label: "Visible section one",
    structured_profile_01_value: "Visible value one",
    structured_profile_02_label: "Visible section two",
    structured_profile_02_value: "Visible value two",
    profile_section_01: "Visible section one",
    profile_section_02: "Visible section two"
  });
});

test("profile section headings do not consume the following structured field label", () => {
  const observed = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,900]">
            <androidx.viewpager.widget.ViewPager bounds="[0,160][576,600]" />
            <android.widget.TextView heading="true" text="Visible section context" bounds="[40,620][500,660]" />
            <android.widget.LinearLayout bounds="[24,670][552,772]">
              <android.widget.TextView text="Visible field label" bounds="[40,682][500,718]" />
              <android.widget.TextView text="Visible field value" bounds="[40,724][500,760]" />
            </android.widget.LinearLayout>
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, { expectedDisplayName: "Example Profile" });
  assert.ok(observed);
  assert.deepEqual(observed.profile.attributes, {
    visible_profile_01: "Visible section context",
    visible_profile_02: "Visible field label",
    visible_profile_03: "Visible field value",
    structured_profile_01_label: "Visible field label",
    structured_profile_01_value: "Visible field value",
    profile_section_01: "Visible section context"
  });
});

test("generic profile projection retains header, section context, container fields, compact chips, and ordered raw fallback", () => {
  const observed = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,980]">
            <androidx.viewpager.widget.ViewPager bounds="[0,160][576,600]" />
            <android.widget.TextView text="Generic Person, 29" bounds="[36,510][360,556]" />
            <android.widget.TextView heading="true" text="Generic context" bounds="[36,620][480,658]" />
            <android.widget.TextView text="Generic section value" bounds="[36,666][500,706]" />
            <android.widget.LinearLayout bounds="[24,724][552,790]">
              <android.widget.TextView text="Generic label" bounds="[36,738][240,776]" />
              <android.widget.TextView text="Generic value" bounds="[290,738][530,776]" />
            </android.widget.LinearLayout>
            <android.widget.FrameLayout clickable="true" bounds="[24,810][172,860]">
              <android.widget.TextView text="Compact tag one" bounds="[38,820][158,850]" />
            </android.widget.FrameLayout>
            <android.widget.FrameLayout clickable="true" bounds="[184,810][342,860]">
              <android.widget.TextView text="Compact tag two" bounds="[198,820][328,850]" />
            </android.widget.FrameLayout>
            <android.widget.TextView clickable="true" text="Wide non-profile control" bounds="[24,882][552,930]" />
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, { expectedDisplayName: "Generic Person" });
  assert.ok(observed);
  assert.deepEqual(observed.profile.attributes, {
    visible_profile_01: "Generic Person, 29",
    visible_profile_02: "Generic context",
    visible_profile_03: "Generic section value",
    visible_profile_04: "Generic label",
    visible_profile_05: "Generic value",
    visible_profile_06: "Compact tag one",
    visible_profile_07: "Compact tag two",
    structured_profile_01_label: "Generic context",
    structured_profile_01_value: "Generic section value",
    structured_profile_02_label: "Generic label",
    structured_profile_02_value: "Generic value",
    header_profile_name: "Generic Person",
    header_profile_age: "29",
    profile_section_01: "Generic context",
    profile_chip_01: "Compact tag one",
    profile_chip_02: "Compact tag two"
  });
  assert.doesNotMatch(JSON.stringify(observed), /Wide non-profile control/);
});

test("generic profile projection retains every compact direct-view chip in one visible collection", () => {
  const chips = Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3);
    const column = index % 3;
    const left = 28 + column * 176;
    const top = 640 + row * 68;
    const right = left + 154;
    const bottom = top + 46;
    return `<android.view.View clickable="true" text="Visible tag ${index + 1}" bounds="[${left},${top}][${right},${bottom}]" />`;
  }).join("\n");
  const observed = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,1120]">
            <androidx.viewpager.widget.ViewPager bounds="[0,160][576,600]" />
            ${chips}
            <android.widget.TextView clickable="true" text="Lone compact action" bounds="[28,1032][184,1078]" />
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, { expectedDisplayName: "Example Profile" });
  assert.ok(observed);
  const attributes = observed.profile.attributes;
  assert.deepEqual(
    Object.entries(attributes)
      .filter(([key]) => /^profile_chip_\d{2}$/.test(key))
      .map(([, value]) => value),
    Array.from({ length: 9 }, (_, index) => `Visible tag ${index + 1}`)
  );
  assert.doesNotMatch(JSON.stringify(attributes), /Lone compact action/);
});

test("generic profile projection retains compact chip text inside a wide clickable collection wrapper", () => {
  const chips = Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3);
    const column = index % 3;
    const left = 28 + column * 176;
    const top = 640 + row * 68;
    const right = left + 154;
    const bottom = top + 46;
    return `<android.widget.TextView text="Visible wrapped tag ${index + 1}" bounds="[${left},${top}][${right},${bottom}]" />`;
  }).join("\n");
  const observed = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,1120]">
            <androidx.viewpager.widget.ViewPager bounds="[0,160][576,600]" />
            <android.view.ViewGroup clickable="true" bounds="[20,628][556,860]">
              ${chips}
            </android.view.ViewGroup>
            <android.view.ViewGroup clickable="true" bounds="[20,900][556,952]">
              <android.widget.TextView text="Lone wrapped action" bounds="[28,908][184,946]" />
            </android.view.ViewGroup>
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, { expectedDisplayName: "Example Profile" });
  assert.ok(observed);
  assert.deepEqual(
    Object.entries(observed.profile.attributes)
      .filter(([key]) => /^profile_chip_\d{2}$/.test(key))
      .map(([, value]) => value),
    Array.from({ length: 9 }, (_, index) => `Visible wrapped tag ${index + 1}`)
  );
  assert.doesNotMatch(JSON.stringify(observed.profile.attributes), /Lone wrapped action/);
});

test("generic profile projection retains an inert compact chip collection but excludes an isolated field", () => {
  const chips = Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3);
    const column = index % 3;
    const left = 28 + column * 176;
    const top = 640 + row * 68;
    const right = left + 154;
    const bottom = top + 46;
    return `<android.widget.FrameLayout bounds="[${left},${top}][${right},${bottom}]"><android.widget.TextView text="Visible inert tag ${index + 1}" bounds="[${left},${top}][${right},${bottom}]" /></android.widget.FrameLayout>`;
  }).join("\n");
  const observed = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,1120]">
            <androidx.viewpager.widget.ViewPager bounds="[0,160][576,600]" />
            ${chips}
            <android.widget.FrameLayout bounds="[28,940][354,986]"><android.widget.TextView text="Isolated profile field" bounds="[28,940][354,986]" /></android.widget.FrameLayout>
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, { expectedDisplayName: "Example Profile" });
  assert.ok(observed);
  assert.deepEqual(
    Object.entries(observed.profile.attributes)
      .filter(([key]) => /^profile_chip_\d{2}$/.test(key))
      .map(([, value]) => value),
    Array.from({ length: 9 }, (_, index) => `Visible inert tag ${index + 1}`)
  );
  assert.doesNotMatch(
    JSON.stringify(Object.fromEntries(Object.entries(observed.profile.attributes)
      .filter(([key]) => /^profile_chip_\d{2}$/.test(key)))),
    /Isolated profile field/
  );
});

test("profile observation exposes only one local numbered expansion control directly below a dense compact chip collection", () => {
  const chips = Array.from({ length: 8 }, (_, index) => {
    const row = Math.floor(index / 3);
    const column = index % 3;
    const left = 28 + column * 176;
    const top = 640 + row * 68;
    const right = left + 154;
    const bottom = top + 46;
    return `<android.widget.FrameLayout bounds="[${left},${top}][${right},${bottom}]"><android.widget.TextView text="Visible collapsed tag ${index + 1}" bounds="[${left},${top}][${right},${bottom}]" /></android.widget.FrameLayout>`;
  }).join("\n");
  const observed = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,1120]">
            <androidx.viewpager.widget.ViewPager bounds="[0,160][576,600]" />
            ${chips}
            <android.widget.FrameLayout clickable="true" bounds="[24,854][552,910]"><android.widget.TextView text="Show all 9" bounds="[160,866][416,900]" /></android.widget.FrameLayout>
            <android.widget.FrameLayout clickable="true" bounds="[24,932][552,980]"><android.widget.TextView text="Normal profile action" bounds="[160,940][416,970]" /></android.widget.FrameLayout>
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, { expectedDisplayName: "Example Profile" });
  assert.ok(observed);
  assert.deepEqual(observed.chip_expansion_bounds, { left: 24, top: 854, right: 552, bottom: 910, width: 528, height: 56 });
  assert.equal(Object.keys(observed.profile.attributes).filter((key) => /^profile_chip_\d{2}$/.test(key)).length, 8);
});

test("generic profile projection accepts separate neighbouring name and age header nodes", () => {
  const observed = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,760]">
            <androidx.viewpager.widget.ViewPager bounds="[0,160][576,600]" />
            <android.widget.TextView text="Separate header" bounds="[36,510][300,556]" />
            <android.widget.TextView text="31" bounds="[320,510][370,556]" />
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, { expectedDisplayName: "Separate header" });
  assert.ok(observed);
  assert.deepEqual(observed.profile.attributes, {
    visible_profile_01: "Separate header",
    visible_profile_02: "31",
    header_profile_name: "Separate header",
    header_profile_age: "31"
  });
});

test("generic profile projection reads a split media header outside the scrollable profile body", () => {
  const observed = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <android.widget.TextView text="External header," bounds="[36,108][270,154]" />
        <android.widget.TextView text="36" bounds="[290,108][340,154]" />
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,760]">
            <androidx.viewpager.widget.ViewPager bounds="[0,160][576,600]" />
            <android.widget.TextView text="Visible profile detail" bounds="[40,620][500,666]" />
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, { expectedDisplayName: "External header" });
  assert.ok(observed);
  assert.deepEqual(observed.profile.attributes, {
    visible_profile_01: "Visible profile detail",
    header_profile_name: "External header",
    header_profile_age: "36"
  });
});

test("directly continuous profile viewports retain ordered fallback values and structured pairs", () => {
  const opening = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,760]">
            <androidx.viewpager.widget.ViewPager bounds="[0,160][576,600]" />
            <android.widget.TextView heading="true" text="Opening label" bounds="[40,620][500,660]" />
            <android.widget.TextView text="Opening value" bounds="[40,668][500,712]" />
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, { expectedDisplayName: "Example Profile" });
  const continued = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,760]">
            <android.widget.TextView heading="true" text="Later label" bounds="[40,620][500,660]" />
            <android.widget.TextView text="Later value" bounds="[40,668][500,712]" />
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, {
    expectedDisplayName: "Example Profile",
    continuedProfileScroll: true,
    expectedScrollBounds: { left: 0, top: 160, right: 576, bottom: 1120, width: 576, height: 960 }
  });
  assert.ok(opening);
  assert.ok(continued);
  assert.deepEqual(mergeProfileSnapshots(opening.profile, continued.profile).attributes, {
    visible_profile_01: "Opening label",
    visible_profile_02: "Opening value",
    visible_profile_03: "Later label",
    visible_profile_04: "Later value",
    structured_profile_01_label: "Opening label",
    structured_profile_01_value: "Opening value",
    structured_profile_02_label: "Later label",
    structured_profile_02_value: "Later value",
    profile_section_01: "Opening label",
    profile_section_02: "Later label"
  });
});

test("directly continuous profile viewports retain verified header and compact chips", () => {
  const opening = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,760]">
            <androidx.viewpager.widget.ViewPager bounds="[0,160][576,600]" />
            <android.widget.TextView text="Long profile, 33" bounds="[36,510][360,556]" />
            <android.widget.FrameLayout clickable="true" bounds="[24,630][180,680]">
              <android.widget.TextView text="Opening compact chip" bounds="[38,640][166,670]" />
            </android.widget.FrameLayout>
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, { expectedDisplayName: "Long profile" });
  const continued = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,760]">
            <android.widget.FrameLayout clickable="true" bounds="[24,630][180,680]">
              <android.widget.TextView text="Later compact chip" bounds="[38,640][166,670]" />
            </android.widget.FrameLayout>
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, {
    expectedDisplayName: "Long profile",
    continuedProfileScroll: true,
    expectedScrollBounds: { left: 0, top: 160, right: 576, bottom: 1120, width: 576, height: 960 }
  });
  assert.ok(opening);
  assert.ok(continued);
  assert.deepEqual(mergeProfileSnapshots(opening.profile, continued.profile).attributes, {
    visible_profile_01: "Long profile, 33",
    visible_profile_02: "Opening compact chip",
    visible_profile_03: "Later compact chip",
    header_profile_name: "Long profile",
    header_profile_age: "33",
    profile_chip_01: "Opening compact chip",
    profile_chip_02: "Later compact chip"
  });
});

test("profile normalization admits the expanded bounded generic profile projection", () => {
  const attributes = Object.fromEntries([
    ...Array.from({ length: 32 }, (_, index) => [
      `visible_profile_${String(index + 1).padStart(2, "0")}`,
      `Visible value ${index + 1}`
    ]),
    ...Array.from({ length: 32 }, (_, index) => [
      `structured_profile_${String(index + 1).padStart(2, "0")}_label`,
      `Visible label ${index + 1}`
    ]),
    ...Array.from({ length: 32 }, (_, index) => [
      `structured_profile_${String(index + 1).padStart(2, "0")}_value`,
      `Visible paired value ${index + 1}`
    ])
  ]);
  const normalized = normalizeTinderProfile({
    display_name: "Example Profile",
    attributes,
    media_refs: []
  });
  assert.equal(Object.keys(normalized.attributes).length, 96);
  const expanded = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [
    `generic_projection_${String(index + 1).padStart(3, "0")}`,
    `Visible generic value ${index + 1}`
  ]));
  assert.equal(Object.keys(normalizeTinderProfile({
    display_name: "Example Profile",
    attributes: expanded,
    media_refs: []
  }).attributes).length, 256);
  assert.throws(
    () => normalizeTinderProfile({
      display_name: "Example Profile",
      attributes: { ...expanded, extra_visible_value: "Beyond the bounded projection" },
      media_refs: []
    }),
    (error) => error instanceof TinderMirrorError && error.code === "INVALID_TINDER_MIRROR_PAYLOAD"
  );
});

test("profile observation refuses a ScrollView without the required regular media region", () => {
  const observed = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.TextView text="Visible profile detail" bounds="[40,310][500,360]" />
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, { expectedDisplayName: "Example Profile" });
  assert.equal(observed, null);
});

test("a verified profile scroll may keep the same profile body after its opening ViewPager has scrolled off-screen", () => {
  const observed = observeProfileFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.TextView text="Older visible profile detail" bounds="[40,310][500,360]" />
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`, {
    expectedDisplayName: "Example Profile",
    continuedProfileScroll: true,
    expectedScrollBounds: { left: 0, top: 160, right: 576, bottom: 1120, width: 576, height: 960 }
  });
  assert.ok(observed);
  assert.deepEqual(observed.profile.attributes, { visible_profile_01: "Older visible profile detail" });
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
  assert.equal(pool.state.deleteMessageCalls, 0);
});

test("an old exact completed singleton pair remains untouched instead of producing a third record", async () => {
  const pool = createMemoryPool();
  const mirror = createTinderConversationMirror({
    pool,
    now: () => new Date("2026-09-24T10:00:00.000Z"),
    idFactory: () => "00000000-0000-4000-8000-000000000099"
  });
  const payload = {
    profile: profile({ city: "Example city", age: "30" }),
    messages: [message("INBOUND", "Only ordinary message", "09:30")],
    history_complete: true
  };
  const first = await mirror.sync({ deviceId: "00000000-0000-4000-8000-000000000001", payload });
  const duplicateId = "00000000-0000-4000-8000-000000000098";
  const originalConversation = pool.state.conversations.get(first.conversation.id);
  const originalMessages = pool.state.messages.get(first.conversation.id);
  pool.state.conversations.set(duplicateId, { ...originalConversation, conversation_id: duplicateId });
  pool.state.messages.set(duplicateId, originalMessages.map((row) => ({
    ...row,
    message_id: "00000000-0000-4000-8000-000000000097",
    conversation_id: duplicateId
  })));
  const before = {
    conversations: [...pool.state.conversations.values()].map((row) => ({ ...row })).sort((a, b) => a.conversation_id.localeCompare(b.conversation_id)),
    messages: [...pool.state.messages.entries()].map(([id, rows]) => [id, rows.map((row) => ({ ...row }))]).sort(([a], [b]) => a.localeCompare(b))
  };

  const resolved = await mirror.resolve({
    deviceId: "00000000-0000-4000-8000-000000000001",
    payload: { ...payload, history_complete: false }
  });
  assert.equal(resolved.action, "READ_HISTORY");
  const noOp = await mirror.sync({ deviceId: "00000000-0000-4000-8000-000000000001", payload });
  const after = {
    conversations: [...pool.state.conversations.values()].map((row) => ({ ...row })).sort((a, b) => a.conversation_id.localeCompare(b.conversation_id)),
    messages: [...pool.state.messages.entries()].map(([id, rows]) => [id, rows.map((row) => ({ ...row }))]).sort(([a], [b]) => a.localeCompare(b))
  };

  assert.equal(noOp.skipped_existing_ambiguous_singleton, true);
  assert.equal(noOp.conversation, null);
  assert.equal(pool.state.conversations.size, 2);
  assert.equal(pool.state.deleteMessageCalls, 0);
  assert.deepEqual(after, before);
});

test("current verified Inbox order is persisted without resubmitting a known history", async () => {
  const pool = createMemoryPool();
  let sequence = 0;
  const mirror = createTinderConversationMirror({
    pool,
    now: () => new Date("2026-09-24T10:00:00.000Z"),
    idFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
  });
  const first = await mirror.sync({
    deviceId: "00000000-0000-4000-8000-000000000001",
    payload: {
      profile: profile({ city: "One" }),
      messages: [message("INBOUND", "One"), message("OUTBOUND", "Two")],
      history_complete: true,
      last_message_visible_time: "08:15",
      inbox_position: 3
    }
  });
  const second = await mirror.sync({
    deviceId: "00000000-0000-4000-8000-000000000001",
    payload: {
      profile: profile({ city: "Two" }),
      messages: [message("INBOUND", "Three"), message("OUTBOUND", "Four")],
      history_complete: true,
      inbox_position: 1
    }
  });
  const beforeMessages = pool.state.messages.get(first.conversation.id).map((row) => ({ ...row }));
  const refreshed = await mirror.updateInboxOrder({
    deviceId: "00000000-0000-4000-8000-000000000001",
    conversationId: first.conversation.id,
    inboxOrder: { last_message_visible_time: "09:30", inbox_position: 0 }
  });
  assert.equal(refreshed.changed, true);
  assert.equal(refreshed.conversation.last_message_visible_time, "09:30");
  assert.equal(refreshed.conversation.inbox_position, 0);
  assert.deepEqual(pool.state.messages.get(first.conversation.id), beforeMessages);
  const sourceOmitted = await mirror.sync({
    deviceId: "00000000-0000-4000-8000-000000000001",
    payload: {
      profile: profile({ city: "One" }),
      messages: [message("INBOUND", "One"), message("OUTBOUND", "Two")],
      history_complete: true
    }
  });
  assert.equal(sourceOmitted.conversation.last_message_visible_time, "09:30");
  assert.equal(sourceOmitted.conversation.inbox_position, 0);
  assert.deepEqual((await mirror.list()).map((item) => item.id), [first.conversation.id, second.conversation.id]);
  const detail = await mirror.detail(first.conversation.id);
  assert.equal(detail.conversation.last_message_visible_time, "09:30");
  assert.equal(detail.conversation.inbox_position, 0);
});

test("completed corrective re-sync preserves an existing conversation and message rows while adding older history", async () => {
  const pool = createMemoryPool();
  const mirror = createTinderConversationMirror({
    pool,
    now: () => new Date("2026-09-24T10:00:00.000Z"),
    idFactory: () => "00000000-0000-4000-8000-000000000099"
  });
  const initial = {
    profile: profile({ city: "Example city", age: "30" }),
    messages: [message("OUTBOUND", "Current A"), message("OUTBOUND", "Current B")],
    history_complete: true
  };
  const created = await mirror.sync({ deviceId: "00000000-0000-4000-8000-000000000001", payload: initial });
  const originalRows = pool.state.messages.get(created.conversation.id).map((row) => ({ ...row }));

  const corrected = {
    profile: initial.profile,
    messages: [
      message("INBOUND", "Older A"),
      message("INBOUND", "Current A"),
      message("OUTBOUND", "Current B")
    ],
    history_complete: true
  };
  const result = await mirror.sync({ deviceId: "00000000-0000-4000-8000-000000000001", payload: corrected });
  const rows = pool.state.messages.get(created.conversation.id).slice().sort((left, right) => left.ordinal - right.ordinal);

  assert.equal(result.created, false);
  assert.equal(result.conversation.id, created.conversation.id);
  assert.equal(result.history_changed, true);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].message_id, originalRows[0].message_id);
  assert.equal(rows[2].message_id, originalRows[1].message_id);
  assert.equal(rows[1].direction, "INBOUND");
  assert.equal(pool.state.deleteMessageCalls, 0);

  const unchanged = await mirror.sync({ deviceId: "00000000-0000-4000-8000-000000000001", payload: corrected });
  assert.equal(unchanged.created, false);
  assert.equal(unchanged.history_changed, false);
  assert.equal(pool.state.messages.get(created.conversation.id).length, 3);
  assert.equal(pool.state.deleteMessageCalls, 0);
});

test("a selected existing continuation fails closed instead of creating a second conversation", async () => {
  const pool = createMemoryPool();
  const mirror = createTinderConversationMirror({
    pool,
    now: () => new Date("2026-09-24T10:00:00.000Z"),
    idFactory: () => "00000000-0000-4000-8000-000000000099"
  });
  const initial = {
    profile: profile({ city: "Example city", age: "30" }),
    messages: [message("INBOUND", "One"), message("OUTBOUND", "Two")],
    history_complete: true
  };
  const created = await mirror.sync({ deviceId: "00000000-0000-4000-8000-000000000001", payload: initial });
  await assert.rejects(
    mirror.sync({
      deviceId: "00000000-0000-4000-8000-000000000001",
      payload: {
        continuation_conversation_id: created.conversation.id,
        profile: initial.profile,
        messages: [message("INBOUND", "Unrelated one"), message("OUTBOUND", "Unrelated two")],
        history_complete: true
      }
    }),
    (error) => error instanceof TinderMirrorError && error.code === "TINDER_CONTINUATION_UNVERIFIED"
  );
  assert.equal((await mirror.list()).length, 1);
  assert.equal(pool.state.deleteMessageCalls, 0);
});

test("a selected exact profile refresh replaces only the selected profile JSON without writing messages", async () => {
  const pool = createMemoryPool();
  const fixedNow = new Date("2026-09-25T10:00:00.000Z");
  const mirror = createTinderConversationMirror({ pool, now: () => fixedNow });
  const deviceId = "00000000-0000-4000-8000-000000000001";
  const storedProfile = profile({
    structured_profile_01_label: "Old field label",
    structured_profile_01_value: "Old field value",
    structured_profile_02_label: "Stale ordinal label",
    structured_profile_02_value: "Stale ordinal value"
  });
  const storedMessages = [
    message("INBOUND", "Stored older", "Yesterday"),
    message("OUTBOUND", "Stored newest", "Today")
  ];
  const created = await mirror.sync({
    deviceId,
    payload: { profile: storedProfile, messages: storedMessages, history_complete: true }
  });
  const conversationId = created.conversation.id;
  const beforeMessages = structuredClone(pool.state.messages.get(conversationId));
  const beforeConversation = structuredClone(pool.state.conversations.get(conversationId));
  const statementCount = pool.state.statements.length;
  const refreshedProfile = profile({
    structured_profile_01_label: "Current field label",
    structured_profile_01_value: "Current field value"
  });

  const result = await mirror.sync({
    deviceId,
    payload: {
      continuation_conversation_id: conversationId,
      profile_refresh: true,
      profile: refreshedProfile,
      messages: storedMessages,
      history_complete: true
    }
  });

  assert.equal(result.created, false);
  assert.equal(result.history_changed, false);
  assert.equal(result.conversation.id, conversationId);
  assert.deepEqual(pool.state.conversations.get(conversationId).profile, refreshedProfile);
  assert.deepEqual(pool.state.messages.get(conversationId), beforeMessages);
  assert.equal(pool.state.conversations.get(conversationId).history_complete, beforeConversation.history_complete);
  assert.deepEqual(pool.state.conversations.get(conversationId).history_synced_at, beforeConversation.history_synced_at);
  assert.equal(
    pool.state.statements.slice(statementCount).some((statement) => /(?:INSERT INTO|UPDATE|DELETE FROM) tinder_conversation_messages/.test(statement)),
    false
  );
});

test("a profile refresh rejects any changed selected history, history state, display name, or missing continuation", async () => {
  const pool = createMemoryPool();
  const mirror = createTinderConversationMirror({ pool });
  const deviceId = "00000000-0000-4000-8000-000000000001";
  const initialProfile = profile({ structured_profile_01_label: "Existing", structured_profile_01_value: "Profile" });
  const messages = [message("INBOUND", "One"), message("OUTBOUND", "Two")];
  const created = await mirror.sync({
    deviceId,
    payload: { profile: initialProfile, messages, history_complete: true }
  });
  const conversationId = created.conversation.id;
  const beforeConversation = structuredClone(pool.state.conversations.get(conversationId));
  const beforeMessages = structuredClone(pool.state.messages.get(conversationId));
  const refresh = (overrides = {}) => mirror.sync({
    deviceId,
    payload: {
      continuation_conversation_id: conversationId,
      profile_refresh: true,
      profile: profile({ structured_profile_01_label: "Current", structured_profile_01_value: "Profile" }),
      messages,
      history_complete: true,
      ...overrides
    }
  });

  await assert.rejects(
    refresh({ messages: [message("INBOUND", "Changed"), message("OUTBOUND", "Two")] }),
    (error) => error instanceof TinderMirrorError && error.code === "TINDER_PROFILE_REFRESH_UNVERIFIED"
  );
  await assert.rejects(
    refresh({ history_complete: false }),
    (error) => error instanceof TinderMirrorError && error.code === "TINDER_HISTORY_NOT_COMPLETE"
  );
  await assert.rejects(
    refresh({ profile: { ...profile(), display_name: "Different profile" } }),
    (error) => error instanceof TinderMirrorError && error.code === "TINDER_PROFILE_REFRESH_UNVERIFIED"
  );
  await assert.rejects(
    mirror.sync({
      deviceId,
      payload: {
        profile_refresh: true,
        profile: profile(),
        messages,
        history_complete: true
      }
    }),
    (error) => error instanceof TinderMirrorError && error.code === "INVALID_TINDER_MIRROR_PAYLOAD"
  );
  assert.deepEqual(pool.state.conversations.get(conversationId), beforeConversation);
  assert.deepEqual(pool.state.messages.get(conversationId), beforeMessages);
});

test("a selected direct-continuity repair replaces only that existing conversation history in place", async () => {
  const pool = createMemoryPool();
  const mirror = createTinderConversationMirror({
    pool,
    now: () => new Date("2026-09-24T10:00:00.000Z"),
    idFactory: () => "00000000-0000-4000-8000-000000000099"
  });
  const initial = {
    profile: profile({ city: "Example city", age: "30" }),
    messages: [message("OUTBOUND", "Incorrect old one"), message("INBOUND", "Incorrect old two")],
    history_complete: true
  };
  const created = await mirror.sync({ deviceId: "00000000-0000-4000-8000-000000000001", payload: initial });
  const repairedMessages = [
    message("INBOUND", "Real oldest"),
    message("OUTBOUND", "Real middle"),
    message("INBOUND", "Real newest")
  ];

  const repaired = await mirror.sync({
    deviceId: "00000000-0000-4000-8000-000000000001",
    payload: {
      continuation_conversation_id: created.conversation.id,
      direct_continuity_repair: true,
      profile: initial.profile,
      messages: repairedMessages,
      history_complete: true
    }
  });

  const rows = pool.state.messages.get(created.conversation.id).slice().sort((left, right) => left.ordinal - right.ordinal);
  assert.equal(repaired.created, false);
  assert.equal(repaired.conversation.id, created.conversation.id);
  assert.equal(repaired.history_changed, true);
  assert.deepEqual(rows.map((row) => ({ direction: row.direction, text: row.message_text })), repairedMessages.map(({ direction, text }) => ({ direction, text })));
  assert.deepEqual(pool.state.conversations.get(created.conversation.id).profile, initial.profile);
  assert.equal((await mirror.list()).length, 1);
  assert.equal(pool.state.deleteMessageCalls, 1);

  await assert.rejects(
    mirror.sync({
      deviceId: "00000000-0000-4000-8000-000000000001",
      payload: {
        continuation_conversation_id: "00000000-0000-4000-8000-000000000098",
        direct_continuity_repair: true,
        profile: initial.profile,
        messages: repairedMessages,
        history_complete: true
      }
    }),
    (error) => error instanceof TinderMirrorError && error.code === "TINDER_CONTINUATION_UNVERIFIED"
  );
  assert.equal((await mirror.list()).length, 1);

  await assert.rejects(
    mirror.sync({
      deviceId: "00000000-0000-4000-8000-000000000001",
      payload: {
        continuation_conversation_id: created.conversation.id,
        direct_continuity_repair: true,
        profile: profile({ city: "Different city", age: "30" }),
        messages: repairedMessages,
        history_complete: true
      }
    }),
    (error) => error instanceof TinderMirrorError && error.code === "TINDER_CONTINUATION_UNVERIFIED"
  );
  assert.equal((await mirror.list()).length, 1);

  await assert.rejects(
    mirror.resolve({
      deviceId: "00000000-0000-4000-8000-000000000001",
      payload: {
        continuation_conversation_id: created.conversation.id,
        direct_continuity_repair: true,
        profile: initial.profile,
        messages: repairedMessages,
        history_complete: false
      }
    }),
    (error) => error instanceof TinderMirrorError && error.code === "TINDER_DIRECT_CONTINUITY_REPAIR_SYNC_ONLY"
  );
});

test("an exact selected singleton continuation corrects direction in place without creating a conversation", async () => {
  const pool = createMemoryPool();
  const mirror = createTinderConversationMirror({
    pool,
    now: () => new Date("2026-09-24T10:00:00.000Z"),
    idFactory: () => "00000000-0000-4000-8000-000000000099"
  });
  const initial = {
    profile: profile({ city: "Example city", age: "30" }),
    messages: [message("OUTBOUND", "Only ordinary message")],
    history_complete: true
  };
  const created = await mirror.sync({ deviceId: "00000000-0000-4000-8000-000000000001", payload: initial });
  const originalRow = pool.state.messages.get(created.conversation.id)[0];

  const corrected = await mirror.sync({
    deviceId: "00000000-0000-4000-8000-000000000001",
    payload: {
      continuation_conversation_id: created.conversation.id,
      profile: initial.profile,
      messages: [message("INBOUND", "Only ordinary message")],
      history_complete: true
    }
  });

  const rows = pool.state.messages.get(created.conversation.id);
  assert.equal(corrected.created, false);
  assert.equal(corrected.conversation.id, created.conversation.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_id, originalRow.message_id);
  assert.equal(rows[0].direction, "INBOUND");
  assert.equal((await mirror.list()).length, 1);
  assert.equal(pool.state.deleteMessageCalls, 0);

  await assert.rejects(
    mirror.sync({
      deviceId: "00000000-0000-4000-8000-000000000001",
      payload: {
        continuation_conversation_id: created.conversation.id,
        profile: initial.profile,
        messages: [message("INBOUND", "Different ordinary message")],
        history_complete: true
      }
    }),
    (error) => error instanceof TinderMirrorError && error.code === "TINDER_CONTINUATION_UNVERIFIED"
  );
  assert.equal((await mirror.list()).length, 1);
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

test("postcheck accepts harmless PostgreSQL cast and schema qualification rendering without weakening the contract", async () => {
  const pool = createMigrationPool({ catalogVariant: true, stringColumns: true });
  const result = await migrateTinderConversationMirror(pool);
  assert.equal(result.migrated, true);
  assert.equal(result.postcheck.state, "ALREADY_CANONICAL");
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
  assert.match(routes, /\/dashboard-api\/tinder\/conversations\/:conversationId\/delta/);
  assert.match(routes, /mirror\.appendDelta/);
  assert.match(routes, /\/inbox-order/);
  assert.match(routes, /updateInboxOrder/);
});

test("corrective history runner binds the installed device version without a Bridge state gate", () => {
  const runner = readFileSync(new URL("../scripts/tinder-block2-correct-existing-history.mjs", import.meta.url), "utf8");
  assert.match(runner, /TINDER_DEVICE_VERSION_CODE/);
  assert.match(runner, /app_version_code/);
  assert.doesNotMatch(runner, /device\.enrollment_state|device\.bridge_service_state|device\.device_status|device\.last_heartbeat/i);
});

test("corrective history runner revalidates a fresh Inbox row and waits for the chat before marking it processed", () => {
  const runner = readFileSync(new URL("../scripts/tinder-block2-correct-existing-history.mjs", import.meta.url), "utf8");
  assert.match(runner, /async function freshInboxRow/);
  assert.match(runner, /async function waitForOpenedConversation/);
  assert.match(runner, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.match(runner, /processedRows\.add\(next\.ram_key\);/);
  assert.doesNotMatch(runner, /processedRows\.add\(next\.ram_key\);\s*await tap/);
});

test("corrective history runner requires the real UiAutomator chat-scroll boundary before COMPLETE", () => {
  const runner = readFileSync(new URL("../scripts/tinder-block2-correct-existing-history.mjs", import.meta.url), "utf8");
  assert.match(runner, /script: "mobile: scrollGesture"/);
  assert.doesNotMatch(runner, /mobile: swipeGesture|unchangedViewportStreak/);
  assert.match(runner, /percent: 0\.45/);
  assert.match(runner, /typeof canScrollMore !== "boolean"/);
  assert.match(runner, /await sleep\(boundarySettleMilliseconds\)/);
  assert.match(runner, /const confirmedAtBoundary = await scrollUp\(viewport\.scroll_bounds\)/);
  assert.match(runner, /if \(confirmedAtBoundary \|\| !sameObservedViewport\(settled, confirmed\)\) continue/);
  assert.ok(runner.indexOf("const resolved = await adapter.resolve()") > runner.indexOf("const confirmedAtBoundary = await scrollUp"));
});

test("corrective runner uses an existing continuation and never turns a mismatch into a new conversation", () => {
  const runner = readFileSync(new URL("../scripts/tinder-block2-correct-existing-history.mjs", import.meta.url), "utf8");
  assert.match(runner, /continuationConversationId: existing\.id/);
  assert.doesNotMatch(runner, /isVerifiedUnchangedSingleton/);
  assert.match(runner, /const resolvedExisting = resolved\?\.conversation\?\.id === existing\.id/);
  assert.match(runner, /history_persisted: false/);
  assert.match(runner, /threads_unrevalidated/);
  assert.ok(runner.indexOf("const resolved = await adapter.resolve()") < runner.indexOf("const synced = await adapter.persistCompletedHistory"));
});

test("corrective runner limits direct history replacement to one explicitly selected existing target", () => {
  const runner = readFileSync(new URL("../scripts/tinder-block2-correct-existing-history.mjs", import.meta.url), "utf8");
  assert.match(runner, /TINDER_BLOCK2_DIRECT_REPAIR_CONVERSATION_ID/);
  assert.match(runner, /const directContinuityRepair = directRepairConversationId === existing\.id/);
  assert.match(runner, /if \(!directContinuityRepair\) \{/);
  assert.match(runner, /directContinuityRepair/);
});

test("corrective runner plans only overlap-capable unique existing records before an Inbox tap", () => {
  const runner = readFileSync(new URL("../scripts/tinder-block2-correct-existing-history.mjs", import.meta.url), "utf8");
  assert.match(runner, /function correctionPlan\(conversations\)/);
  assert.match(runner, /Number\(conversation\?\.message_count\) >= 2/);
  assert.match(runner, /names\.get\(conversation\?\.profile\?\.display_name\) === 1/);
  assert.match(runner, /function uniquelyVisibleRowForPlan\(rows, existing\)/);
  assert.match(runner, /rowContainsExactVisibleName/);
  assert.match(runner, /for \(const existing of plan\)/);
  assert.match(runner, /openPlannedConversation\(existing, processedRows\)/);
  assert.doesNotMatch(runner, /rows\.find\(\(row\) => !processedRows\.has\(row\.ram_key\)\)/);
});

test("normal initial mirror is a separate Appium Inbox loop with CTA exclusion, safe profile return, and physical history completion", () => {
  const runner = readFileSync(new URL("../scripts/tinder-block2-initial-sync.mjs", import.meta.url), "utf8");
  assert.match(runner, /observeInboxFromXml/);
  assert.match(runner, /headerProfileTargetFromXml/);
  assert.match(runner, /observeProfileFromXml/);
  assert.match(runner, /async function openFreshRow/);
  assert.match(runner, /viewport\?\.profile_display_name/);
  assert.match(runner, /conversationWithoutHeader/);
  assert.match(runner, /async function readProfileToPhysicalBoundary/);
  assert.match(runner, /async function readChatToVerifiedOldestBoundary/);
  assert.match(runner, /const chatScrollPercent = 0\.45/);
  assert.match(runner, /const inboxScrollPercent = 0\.05/);
  assert.match(runner, /function nextInboxOverlap/);
  assert.match(runner, /function sameInboxRowSlots/);
  assert.match(runner, /function carryProcessedInboxRows/);
  assert.match(runner, /const processedConversationIds = new Set\(\)/);
  assert.match(runner, /first_observed_in_sweep/);
  assert.match(runner, /function adjacentInboxOverlap/);
  assert.match(runner, /Tinder Inbox scroll did not establish direct local continuity/);
  assert.match(runner, /const scrollTowardTop/);
  assert.match(runner, /const scrollTowardBottom/);
  assert.match(runner, /scrollTowardTop\(viewport\.scroll_bounds, chatScrollPercent\)/);
  assert.match(runner, /const confirmedAtBoundary = await scrollTowardTop\(viewport\.scroll_bounds, chatScrollPercent\)/);
  assert.match(runner, /scrollTowardBottom\(before\.scroll_bounds, inboxScrollPercent\)/);
  assert.match(runner, /await returnToInbox\(\)/);
  assert.match(runner, /synced\.created \? "NEW_MIRRORED" : "KNOWN_COMPLETED"/);
  assert.match(runner, /action: "KNOWN_UNCHANGED"/);
  assert.match(runner, /action: "KNOWN_REVALIDATED"/);
  assert.match(runner, /export function planInitialInboxProcessing/);
  assert.match(runner, /updateInboxOrder/);
  assert.match(runner, /last_message_visible_time_captured/);
  assert.doesNotMatch(runner, /mobile: swipeGesture|directContinuityRepair|TINDER_BLOCK2_DIRECT_REPAIR_CONVERSATION_ID/);
  assert.doesNotMatch(runner, /device\.last_heartbeat|requireDeviceBridgeReady|registerAuthenticatedRequestReplay|verifyAuthenticatedDeviceRequest/);
  assert.doesNotMatch(runner, /const pageKeys = new Set\(\)/);
});

test("initial import discovers the full Inbox before it can open a thread, and consumes each RAM-only inventory entry once", () => {
  const runner = readFileSync(new URL("../scripts/tinder-block2-initial-sync.mjs", import.meta.url), "utf8");
  const discoveryStart = runner.indexOf("async function discoverInboxInventory()");
  const processingStart = runner.indexOf("async function processDiscoveredInboxInventory");
  const mainStart = runner.indexOf("const deviceId = await resolveDeviceId()");
  assert.ok(discoveryStart >= 0);
  assert.ok(processingStart > discoveryStart);
  assert.ok(mainStart > processingStart);

  const discovery = runner.slice(discoveryStart, processingStart);
  const processing = runner.slice(processingStart, mainStart);
  assert.match(discovery, /inventory\.push\(inventoryEntryFromRow\(row, inventory\.length\)\)/);
  assert.match(discovery, /reconcileProcessedInboxRows/);
  assert.doesNotMatch(discovery, /openReadAndMirror|openInitialProfile|readProfileToPhysicalBoundary|readChatToVerifiedOldestBoundary|\btap\(/);

  assert.match(processing, /const processedInventoryOrdinals = new Set\(\)/);
  assert.match(processing, /if \(processedInventoryOrdinals\.has\(planned\.inbox_position\)\)/);
  assert.match(processing, /sameTransientInboxRow\(row, planned\.observed_row\)/);
  assert.match(processing, /await executeInitialInboxPlanEntry/);
  assert.match(processing, /threadOpens \+= Number\(result\.thread_opened\)/);
  assert.match(processing, /requireDirectContinuity: true/);
  assert.match(processing, /const sameSweep = summarizeSameSweepReopens\(results\)/);
  assert.match(processing, /same_sweep_reopens: sameSweep\.same_sweep_reopens/);
  assert.match(processing, /same_sweep_reopens_verified: sameSweep\.same_sweep_reopens_verified/);
  assert.match(runner, /const discovery = await discoverInboxInventory\(\);/);
  assert.match(runner, /const initialProcessingPlan = planInitialInboxProcessing\(/);
  assert.match(runner, /initialProcessingPlan/);
  assert.match(runner, /discovery_thread_opens: 0/);
  assert.match(runner, /discovery_history_reads: 0/);
  assert.match(runner, /discovery_profile_reads: 0/);
});

function initialInboxInventoryRow(inboxPosition, displayName, visibleTime) {
  return Object.freeze({
    inbox_position: inboxPosition,
    last_message_visible_time: visibleTime,
    observed_row: Object.freeze({
      ram_key: JSON.stringify({ texts: [displayName, "Visible latest message", visibleTime] })
    })
  });
}

test("100 RAM-bound unchanged Inbox rows take the order-only path with zero opens, profile reads, and history reads", async () => {
  const inventory = Array.from({ length: 100 }, (_, index) => {
    const visibleTime = `09:${String(index % 60).padStart(2, "0")}`;
    return initialInboxInventoryRow(index, `Known ${index + 1}`, visibleTime);
  });
  const ramBindings = inventory.map((entry, index) => createRamOnlyInitialSweepBinding({
    observedRow: entry.observed_row,
    conversationId: `known-${index + 1}`
  }));
  const plan = planInitialInboxProcessing({ inventory, ramBindings });
  assert.equal(plan.length, 100);
  assert.ok(plan.every((entry) => entry.action === "KNOWN_UNCHANGED"));

  const processedConversationIds = new Set();
  const counters = { threadOpens: 0, profileReads: 0, historyReads: 0, orderUpdates: 0 };
  for (const [index, entry] of inventory.entries()) {
    const result = await executeInitialInboxPlanEntry({
      plan: plan[index],
      deviceId: "test-device",
      row: entry.observed_row,
      inboxPosition: entry.inbox_position,
      processedConversationIds,
      ramBindings,
      openAndMirror: async () => {
        counters.threadOpens += 1;
        throw new Error("a known unchanged Inbox row must not open a thread");
      },
      mirrorKnownUnchanged: async ({ conversationId }) => {
        counters.orderUpdates += 1;
        processedConversationIds.add(conversationId);
        return Object.freeze({
          thread_opened: false,
          initial_profile_reads: 0,
          full_history_read: false,
          same_sweep_reopen: false
        });
      }
    });
    counters.threadOpens += Number(result.thread_opened);
    counters.profileReads += result.initial_profile_reads;
    counters.historyReads += Number(result.full_history_read);
  }
  assert.deepEqual(counters, { threadOpens: 0, profileReads: 0, historyReads: 0, orderUpdates: 100 });
  assert.equal(processedConversationIds.size, 100);
});

test("unbound persisted-looking and duplicate RAM rows cannot be called known unchanged", () => {
  const inventory = [
    initialInboxInventoryRow(0, "Same Name", "09:00"),
    initialInboxInventoryRow(1, "Same Name", "09:00")
  ];
  // A caller can supply old product-shaped data, but it is not an explicit
  // same-process capability and is ignored by the planner.
  const plan = planInitialInboxProcessing({
    inventory,
    conversations: [
      { id: "persisted-a", profile: { display_name: "Same Name" }, last_message_visible_time: "09:00" }
    ]
  });
  assert.deepEqual(plan.map((entry) => entry.action), ["INITIAL_READ_REQUIRED", "INITIAL_READ_REQUIRED"]);

  const duplicateProjectionBinding = createRamOnlyInitialSweepBinding({
    observedRow: inventory[0].observed_row,
    conversationId: "known-once"
  });
  const duplicatePlan = planInitialInboxProcessing({ inventory, ramBindings: [duplicateProjectionBinding] });
  assert.deepEqual(duplicatePlan.map((entry) => entry.action), ["INITIAL_READ_REQUIRED", "INITIAL_READ_REQUIRED"]);
  assert.throws(
    () => planInitialInboxProcessing({
      inventory: [inventory[0]],
      ramBindings: [{ observed_row_ram_key: inventory[0].observed_row.ram_key, conversation_id: "forged" }]
    }),
    /in-process RAM-only binding/
  );
});

test("a new Inbox row has exactly one initial profile-plus-full-history path", async () => {
  const inventory = [initialInboxInventoryRow(0, "New profile", "09:30")];
  const [plan] = planInitialInboxProcessing({ inventory });
  assert.equal(plan.action, "INITIAL_READ_REQUIRED");

  const processedConversationIds = new Set();
  const counters = { initialPaths: 0, threadOpens: 0, profileReads: 0, historyReads: 0 };
  const result = await executeInitialInboxPlanEntry({
    plan,
    deviceId: "test-device",
    row: inventory[0].observed_row,
    inboxPosition: 0,
    processedConversationIds,
    mirrorKnownUnchanged: async () => {
      throw new Error("a new Inbox row must not use the known unchanged path");
    },
    openAndMirror: async () => {
      counters.initialPaths += 1;
      return Object.freeze({
        thread_opened: true,
        initial_profile_reads: 1,
        full_history_read: true,
        same_sweep_reopen: false
      });
    }
  });
  counters.threadOpens += Number(result.thread_opened);
  counters.profileReads += result.initial_profile_reads;
  counters.historyReads += Number(result.full_history_read);
  assert.deepEqual(counters, { initialPaths: 1, threadOpens: 1, profileReads: 1, historyReads: 1 });

  const runner = readFileSync(new URL("../scripts/tinder-block2-initial-sync.mjs", import.meta.url), "utf8");
  const openStart = runner.indexOf("async function openReadAndMirror");
  const openEnd = runner.indexOf("async function verifiedInboxTop", openStart);
  const openPath = runner.slice(openStart, openEnd);
  assert.equal((openPath.match(/await openInitialProfile\(expectedDisplayName\)/g) || []).length, 1);
    assert.match(openPath, /readCompleteLiveMatchProfile\(/);
  assert.doesNotMatch(openPath, /secondProfileState/);
});

test("direct same-sweep row continuity skips without reopening, while an unresolved result cannot claim zero", async () => {
  const row = initialInboxInventoryRow(0, "Continuous row", "09:45").observed_row;
  const [plan] = planInitialInboxProcessing({
    inventory: [{ inbox_position: 0, observed_row: row }]
  });
  const processedConversationIds = new Set(["continuous-conversation"]);
  const binding = createRamOnlyInitialSweepBinding({ observedRow: row, conversationId: "continuous-conversation" });
  let opened = 0;
  const result = await executeInitialInboxPlanEntry({
    plan,
    deviceId: "test-device",
    row,
    inboxPosition: 0,
    processedConversationIds,
    ramBindings: [binding],
    openAndMirror: async () => {
      opened += 1;
      throw new Error("a direct same-sweep continuity must never reopen");
    }
  });
  assert.equal(opened, 0);
  assert.equal(result.action, "SAME_SWEEP_CONTINUITY_SKIPPED");
  assert.deepEqual(
    summarizeSameSweepReopens([{ same_sweep_reopen: false }, result]),
    { same_sweep_reopens: 0, same_sweep_reopens_verified: true }
  );
  assert.deepEqual(
    summarizeSameSweepReopens([{ same_sweep_reopen: null }]),
    { same_sweep_reopens: null, same_sweep_reopens_verified: false }
  );
});

test("a selected known Conversation appends only an ordered live delta tail without changing profile or history state", async () => {
  const pool = createMemoryPool();
  const fixedNow = new Date("2026-09-25T10:00:00.000Z");
  const mirror = createTinderConversationMirror({ pool, now: () => fixedNow });
  const deviceId = "00000000-0000-4000-8000-000000000001";
  const initial = await mirror.sync({
    deviceId,
    payload: {
      profile: profile({ city: "Existing profile data" }),
      messages: [message("INBOUND", "Stored older"), message("OUTBOUND", "Stored newest", "10:01")],
      history_complete: true
    }
  });
  const conversationId = initial.conversation.id;
  const before = { ...pool.state.conversations.get(conversationId), profile: structuredClone(pool.state.conversations.get(conversationId).profile) };

  const result = await mirror.appendDelta({
    deviceId,
    conversationId,
    payload: {
      messages: [message("OUTBOUND", "Stored newest", "10:01"), message("INBOUND", "New live message")],
      last_message_visible_time: "Jetzt",
      inbox_position: 0
    }
  });

  assert.equal(existingSuffixObservedPrefixOverlap(
    [message("INBOUND", "Stored older"), message("OUTBOUND", "Stored newest", "10:01")],
    [message("OUTBOUND", "Stored newest", "10:01"), message("INBOUND", "New live message")]
  ), 1);
  assert.equal(result.appended_messages, 1);
  assert.equal(result.ordering_changed, true);
  assert.equal(result.conversation.id, conversationId);
  assert.equal(result.conversation.history_complete, true);
  assert.deepEqual(
    pool.state.messages.get(conversationId).sort((left, right) => left.ordinal - right.ordinal)
      .map((row) => ({ direction: row.direction, text: row.message_text })),
    [
      { direction: "INBOUND", text: "Stored older" },
      { direction: "OUTBOUND", text: "Stored newest" },
      { direction: "INBOUND", text: "New live message" }
    ]
  );
  const after = pool.state.conversations.get(conversationId);
  assert.deepEqual(after.profile, before.profile);
  assert.equal(after.history_complete, before.history_complete);
  assert.equal(after.profile_synced_at, before.profile_synced_at);
  assert.equal(after.history_synced_at, before.history_synced_at);
  assert.equal(after.last_message_visible_time, "Jetzt");
  assert.equal(after.inbox_position, 0);
  assert.equal(pool.state.conversations.size, 1);
  assert.equal(pool.state.deleteMessageCalls, 0);
});

test("a repeated unlabeled one-message delta overlap fails closed without inserts", async () => {
  const pool = createMemoryPool();
  const mirror = createTinderConversationMirror({ pool });
  const deviceId = "00000000-0000-4000-8000-000000000001";
  const initial = await mirror.sync({
    deviceId,
    payload: {
      profile: profile(),
      messages: [message("INBOUND", "Same text"), message("INBOUND", "Same text")],
      history_complete: true
    }
  });
  const conversationId = initial.conversation.id;
  const beforeMessages = structuredClone(pool.state.messages.get(conversationId));
  const statementsBefore = pool.state.statements.length;

  await assert.rejects(
    mirror.appendDelta({
      deviceId,
      conversationId,
      payload: {
        messages: [message("INBOUND", "Same text"), message("OUTBOUND", "A later message")]
      }
    }),
    (error) => error instanceof TinderMirrorError && error.code === "TINDER_DELTA_OVERLAP_UNVERIFIED"
  );

  assert.deepEqual(pool.state.messages.get(conversationId), beforeMessages);
  assert.equal(
    pool.state.statements.slice(statementsBefore).some((statement) => statement.startsWith("INSERT INTO tinder_conversation_messages")),
    false
  );
});

test("a two-message ordered live delta overlap remains sufficient without visible labels", async () => {
  const pool = createMemoryPool();
  const mirror = createTinderConversationMirror({ pool });
  const deviceId = "00000000-0000-4000-8000-000000000001";
  const initial = await mirror.sync({
    deviceId,
    payload: {
      profile: profile(),
      messages: [message("INBOUND", "Oldest"), message("OUTBOUND", "Prior"), message("INBOUND", "Newest")],
      history_complete: true
    }
  });

  const result = await mirror.appendDelta({
    deviceId,
    conversationId: initial.conversation.id,
    payload: {
      messages: [message("OUTBOUND", "Prior"), message("INBOUND", "Newest"), message("OUTBOUND", "New live message")]
    }
  });

  assert.equal(result.appended_messages, 1);
  assert.equal(pool.state.messages.get(initial.conversation.id).length, 4);
});

test("a targeted delta rejects profile/full-history fields and rolls back a viewport without an ordered stored suffix", async () => {
  assert.throws(
    () => normalizeTinderConversationDeltaPayload({
      profile: profile(),
      messages: [message("INBOUND", "Not a message-only delta")]
    }),
    (error) => error instanceof TinderMirrorError && error.code === "INVALID_TINDER_DELTA_PAYLOAD"
  );

  const pool = createMemoryPool();
  const mirror = createTinderConversationMirror({ pool });
  const deviceId = "00000000-0000-4000-8000-000000000001";
  const initial = await mirror.sync({
    deviceId,
    payload: {
      profile: profile(),
      messages: [message("INBOUND", "Stored older"), message("OUTBOUND", "Stored newest")],
      history_complete: true
    }
  });
  const conversationId = initial.conversation.id;
  const beforeConversation = structuredClone(pool.state.conversations.get(conversationId));
  const beforeMessages = structuredClone(pool.state.messages.get(conversationId));
  const statementsBefore = pool.state.statements.length;

  await assert.rejects(
    mirror.appendDelta({
      deviceId,
      conversationId,
      payload: { messages: [message("INBOUND", "Unrelated live message")] }
    }),
    (error) => error instanceof TinderMirrorError && error.code === "TINDER_DELTA_OVERLAP_UNVERIFIED"
  );

  assert.deepEqual(pool.state.conversations.get(conversationId), beforeConversation);
  assert.deepEqual(pool.state.messages.get(conversationId), beforeMessages);
  assert.equal(pool.state.conversations.size, 1);
  assert.equal(pool.state.deleteMessageCalls, 0);
  assert.ok(pool.state.statements.slice(statementsBefore).includes("ROLLBACK"));
  assert.equal(
    pool.state.statements.slice(statementsBefore).some((statement) => statement.startsWith("INSERT INTO tinder_conversation_messages")),
    false
  );
});

test("the Appium delta adapter and existing dashboard bearer transport carry only the narrow selected viewport", async () => {
  const requests = [];
  const transport = createExistingDashboardBearerTransport({
    baseUrl: "https://dashboard.example",
    bearerToken: "existing-dashboard-bearer",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ ok: true, appended_messages: 1 }) };
    }
  });
  const deviceId = "00000000-0000-4000-8000-000000000001";
  const conversationId = "00000000-0000-4000-8000-000000000002";
  const adapter = createTinderAppiumDeltaAdapter({ deviceId, conversationId, transport });
  await adapter.persistViewport({
    messages: [message("OUTBOUND", "Stored newest"), message("INBOUND", "New live message")],
    lastMessageVisibleTime: "Jetzt",
    inboxPosition: 0
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://dashboard.example/dashboard-api/tinder/conversations/${conversationId}/delta`);
  assert.equal(requests[0].options.headers.Authorization, "Bearer existing-dashboard-bearer");
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(Object.keys(body).sort(), ["delta", "device_id"]);
  assert.deepEqual(Object.keys(body.delta).sort(), ["inbox_position", "last_message_visible_time", "messages"]);
  assert.equal(Object.hasOwn(body.delta, "profile"), false);
  assert.equal(Object.hasOwn(body.delta, "history_complete"), false);
  await assert.rejects(
    adapter.persistViewport({
      messages: [message("INBOUND", "No profile allowed")],
      profile: profile()
    }),
    /cannot include profile or history fields/
  );
});
