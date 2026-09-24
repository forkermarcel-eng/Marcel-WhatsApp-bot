import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  TinderMirrorError,
  createTinderConversationMirror,
  largestContiguousOverlap,
  mergeTinderHistory,
  normalizeTinderInboxOrder,
  normalizeTinderMirrorPayload,
  selectConservativeConversationMatch
} from "../tinder-mirror/conversation.js";
import {
  getTinderConversationMirrorMigrationDiagnostic,
  migrateTinderConversationMirror,
  preflightTinderConversationMirror
} from "../tinder-mirror/migration.js";
import { createTinderAppiumAdapter } from "../tinder-mirror/appium-adapter.js";
import {
  classifyBubbleDirection,
  classifyMessageTextNode,
  flattenUiNodes,
  parseUiAutomatorXml,
  screenBounds
} from "../tinder-mirror/appium-ui-observer.js";
import {
  headerProfileTargetFromXml,
  observeInboxConversationRowsFromXml,
  observeInboxFromXml,
  observeProfileFromXml
} from "../tinder-mirror/appium-conversation-reader.js";

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

function createMemoryPool() {
  const state = {
    devices: new Set(["00000000-0000-4000-8000-000000000001"]),
    conversations: new Map(),
    messages: new Map(),
    deleteMessageCalls: 0
  };
  const rowsForConversation = (conversation) => conversation ? [{ ...conversation }] : [];
  async function query(sql, params = []) {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
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
          <android.widget.FrameLayout bounds="[0,618][576,726]">
            <android.widget.TextView text="Mag Dich" bounds="[80,630][220,680]" />
            <android.widget.TextView text="Vor kurzem aktiv - jetzt matchen!" bounds="[80,680][500,710]" />
          </android.widget.FrameLayout>
          <android.widget.FrameLayout bounds="[0,726][576,846]">
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
            <android.widget.TextView text="Existing ordinary preview" bounds="[80,740][420,800]" />
            <android.widget.TextView text="08:15" bounds="[460,740][540,780]" />
          </android.widget.FrameLayout>
          <android.widget.FrameLayout bounds="[0,846][576,966]">
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
  assert.deepEqual(observed.scroll_bounds, { left: 0, top: 160, right: 576, bottom: 1120, width: 576, height: 960 });
  assert.doesNotMatch(JSON.stringify(observed), /content-desc/);
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
  assert.match(runner, /async function readProfileToPhysicalBoundary/);
  assert.match(runner, /async function readChatToVerifiedOldestBoundary/);
  assert.match(runner, /const chatScrollPercent = 0\.45/);
  assert.match(runner, /const inboxScrollPercent = 0\.45/);
  assert.match(runner, /function adjacentInboxOverlap/);
  assert.match(runner, /Tinder Inbox scroll did not retain a visible row overlap/);
  assert.match(runner, /scrollUp\(viewport\.scroll_bounds, chatScrollPercent\)/);
  assert.match(runner, /const confirmedAtBoundary = await scrollUp\(viewport\.scroll_bounds, chatScrollPercent\)/);
  assert.match(runner, /await returnToInbox\(\)/);
  assert.match(runner, /synced\.created \? "NEW_MIRRORED" : "KNOWN_COMPLETED"/);
  assert.match(runner, /action: "KNOWN_SKIPPED"/);
  assert.match(runner, /updateInboxOrder/);
  assert.match(runner, /last_message_visible_time_captured/);
  assert.doesNotMatch(runner, /mobile: swipeGesture|directContinuityRepair|TINDER_BLOCK2_DIRECT_REPAIR_CONVERSATION_ID/);
  assert.doesNotMatch(runner, /device\.last_heartbeat|requireDeviceBridgeReady|registerAuthenticatedRequestReplay|verifyAuthenticatedDeviceRequest/);
});
