import assert from "node:assert/strict";
import test from "node:test";
import {
  TINDER_CONVERSATION_MESSAGE_LIMIT,
  TINDER_LATEST_CONFIRMED_CONVERSATION_LIMIT,
  TINDER_READABLE_CONVERSATION_HISTORY_SCOPE,
  TINDER_READABLE_CONVERSATION_LIMIT,
  TinderConversationProductReadError,
  createPgTinderConversationProductReadRepository,
  createPgTinderReadableConversationProductReadRepository,
  createTinderConversationProductReadService,
  createTinderReadableConversationProductReadService,
  normalizeLatestConfirmedConversationDetail,
  normalizeLatestConfirmedConversationListItem,
  normalizeLatestConfirmedOfficialAppResume,
  normalizeLatestConfirmedVerifiedChatReturn,
  normalizeTinderReadableConversationDetail,
  normalizeTinderReadableConversationList,
  normalizeVisibleChatSync
} from "../services/tinder-conversation-product-read.js";

const CAPTURE_ID = "6c7308cf-5d40-423d-913b-c4424f0e4ee0";
const CONVERSATION_ID = "8e44b221-8e1a-4f18-832d-28e211d26d1c";

function capture(overrides = {}) {
  return {
    capture_id: CAPTURE_ID,
    capture_safety_status: "SAFE",
    mapping_status: "RESOLVED",
    human_review_status: "CONFIRMED",
    source_package: "com.tinder",
    visible_thread_metadata: {
      visible_name: "Sandry",
      thread_fingerprint: "private-thread-fingerprint"
    },
    visible_messages: [
      { visible_order: 1, direction: "INCOMING", text: "Hallo", source_class_name: "private-class" },
      { visible_order: 2, direction: "OUTGOING", text: "Hi", source_class_name: "private-class" }
    ],
    captured_at: "2026-09-07T12:30:00.000Z",
    device_id: "e880455d-325c-4f35-9914-823dcb0e0d18",
    capture_revision: 3,
    capture_fingerprint: "private-capture-fingerprint",
    resolved_contact_id: 9,
    provenance: { private: true },
    ...overrides
  };
}

function readableConversation(overrides = {}) {
  return {
    conversation_handle: CONVERSATION_ID,
    visible_name: "Unzugeordnet",
    observed_at: "2026-09-22T12:30:00.000Z",
    identity_state: "UNASSIGNED",
    identity_review: "PENDING",
    history_scope: "AGGREGATED_PARTIAL",
    messages: [
      { direction: "INCOMING", text: "Hallo" },
      { direction: "OUTGOING", text: "Hi" }
    ],
    ...overrides
  };
}

test("conversation product list/detail project only explicit public fields", () => {
  const row = capture();

  assert.deepEqual(normalizeLatestConfirmedConversationListItem(row), {
    capture_id: CAPTURE_ID,
    visible_name: "Sandry",
    captured_at: "2026-09-07T12:30:00.000Z"
  });
  assert.deepEqual(normalizeLatestConfirmedConversationDetail(row), {
    capture_id: CAPTURE_ID,
    visible_name: "Sandry",
    captured_at: "2026-09-07T12:30:00.000Z",
    messages: [
      { direction: "INCOMING", text: "Hallo" },
      { direction: "OUTGOING", text: "Hi" }
    ]
  });

  const product = JSON.stringify(normalizeLatestConfirmedConversationDetail(row));
  for (const privateValue of [
    "private-thread-fingerprint", "private-class", "private-capture-fingerprint",
    "resolved_contact_id", "device_id", "capture_revision", "provenance"
  ]) {
    assert.equal(product.includes(privateValue), false, privateValue);
  }
  assert.equal(product.includes("visible_order"), false);
});

test("selected detail may project a latest bounded V4 transcript without merging technical fields", () => {
  const detail = normalizeLatestConfirmedConversationDetail(capture(), {
    received_at: "2026-09-07T12:35:00.000Z",
    layout_schema_version: "tinder-zte-visible-chat-scroll-v1",
    segment_count: 3,
    overlap_count: 5,
    visible_messages: [
      { visible_order: 1, direction: "INCOMING", text: "Ältere Nachricht" },
      { visible_order: 2, direction: "OUTGOING", text: "Neuere Nachricht" }
    ]
  });

  assert.deepEqual(detail.visible_chat_sync, {
    received_at: "2026-09-07T12:35:00.000Z",
    layout_schema_version: "tinder-zte-visible-chat-scroll-v1",
    segment_count: 3,
    overlap_count: 5,
    messages: [
      { direction: "INCOMING", text: "Ältere Nachricht" },
      { direction: "OUTGOING", text: "Neuere Nachricht" }
    ]
  });
  assert.throws(
    () => normalizeVisibleChatSync({
      received_at: "2026-09-07T12:35:00.000Z",
      layout_schema_version: "tinder-zte-visible-chat-scroll-v1",
      segment_count: 3,
      overlap_count: 5,
      messages: [{ visible_order: 1, direction: "INCOMING", text: "Ältere Nachricht" }],
      command_id: "must-not-be-projected"
    }),
    TinderConversationProductReadError
  );
  assert.deepEqual(detail.messages, [
    { direction: "INCOMING", text: "Hallo" },
    { direction: "OUTGOING", text: "Hi" }
  ]);
});

test("official app resume detail exposes only a bounded one-shot outcome", () => {
  const now = new Date("2026-09-10T01:50:00.000Z");
  const cases = [
    [{ permit_state: "NOT_REQUESTED", expires_at: null }, "NOT_REQUESTED"],
    [{ permit_state: "ISSUED", expires_at: "2026-09-10T01:50:01.000Z" }, "PENDING"],
    [{ permit_state: "ISSUED", expires_at: "2026-09-10T01:50:00.000Z" }, "EXPIRED"],
    [{ permit_state: "DISPATCHED", expires_at: "2026-09-10T01:50:01.000Z" }, "DISPATCHED"],
    [{ permit_state: "CANCELLED", expires_at: "2026-09-10T01:50:01.000Z" }, "CANCELLED"],
    [{ permit_state: "EXPIRED", expires_at: "2026-09-10T01:50:01.000Z" }, "EXPIRED"]
  ];
  for (const [row, status] of cases) {
    assert.deepEqual(normalizeLatestConfirmedOfficialAppResume(row, now), { status });
  }
  assert.equal(normalizeLatestConfirmedOfficialAppResume(undefined, now), undefined);
  assert.equal(normalizeLatestConfirmedOfficialAppResume(null, now), undefined);
  for (const malformed of [
    { permit_state: "ISSUED", expires_at: null },
    { permit_state: "UNKNOWN", expires_at: "2026-09-10T01:50:01.000Z" },
    { permit_state: "DISPATCHED", expires_at: "2026-09-10T01:50:01.000Z", command_id: "private" }
  ]) {
    assert.throws(() => normalizeLatestConfirmedOfficialAppResume(malformed, now), TinderConversationProductReadError);
  }
});

test("verified-chat return detail exposes only a bounded lifecycle outcome", () => {
  const now = new Date("2026-09-13T12:00:00.000Z");
  const cases = [
    [{ permit_state: "NOT_REQUESTED", expires_at: null }, "NOT_REQUESTED"],
    [{ permit_state: "ISSUED", expires_at: "2026-09-13T12:00:01.000Z" }, "PENDING"],
    [{ permit_state: "ISSUED", expires_at: "2026-09-13T12:00:00.000Z" }, "EXPIRED"],
    [{ permit_state: "STAGED", expires_at: "2026-09-13T12:00:01.000Z" }, "STAGED"],
    [{ permit_state: "STAGED", expires_at: "2026-09-13T12:00:00.000Z" }, "EXPIRED"],
    [{ permit_state: "RETURNED", expires_at: "2026-09-13T12:00:01.000Z" }, "RETURNED"],
    [{ permit_state: "CANCELLED", expires_at: "2026-09-13T12:00:01.000Z" }, "CANCELLED"],
    [{ permit_state: "EXPIRED", expires_at: "2026-09-13T12:00:01.000Z" }, "EXPIRED"]
  ];
  for (const [row, status] of cases) {
    assert.deepEqual(normalizeLatestConfirmedVerifiedChatReturn(row, now), { status });
  }
  assert.equal(normalizeLatestConfirmedVerifiedChatReturn(undefined, now), undefined);
  assert.equal(normalizeLatestConfirmedVerifiedChatReturn(null, now), undefined);
  for (const malformed of [
    { permit_state: "ISSUED", expires_at: null },
    { permit_state: "UNKNOWN", expires_at: "2026-09-13T12:00:01.000Z" },
    {
      permit_state: "STAGED",
      expires_at: "2026-09-13T12:00:01.000Z",
      command_id: "must-not-be-projected"
    }
  ]) {
    assert.throws(() => normalizeLatestConfirmedVerifiedChatReturn(malformed, now), TinderConversationProductReadError);
  }
});

test("conversation product reader rejects unconfirmed, stale-shape, and malformed message records", () => {
  for (const row of [
    capture({ mapping_status: "NEEDS_HUMAN_MAPPING" }),
    capture({ human_review_status: "PENDING" }),
    capture({ capture_safety_status: "UNSAFE" }),
    capture({ source_package: "other.package" }),
    capture({ visible_messages: [{ visible_order: 2, direction: "INCOMING", text: "out of order" }, { visible_order: 1, direction: "OUTGOING", text: "bad" }] }),
    capture({ visible_messages: [{ visible_order: 1, direction: "SIDEWAYS", text: "bad" }] }),
    capture({ visible_messages: [] })
  ]) {
    assert.throws(
      () => normalizeLatestConfirmedConversationDetail(row),
      (error) => error instanceof TinderConversationProductReadError
    );
  }
});

test("conversation product service preserves bounds and does not make a list a message reader", async () => {
  const listRows = [capture()];
  let receivedCaptureId = null;
  const service = createTinderConversationProductReadService({
    async findLatestConfirmedConversations() { return listRows; },
    async findLatestConfirmedConversationByCaptureId(captureId) {
      receivedCaptureId = captureId;
      return capture();
    },
    async findLatestConfirmedVisibleChatSyncByCaptureId(captureId) {
      assert.equal(captureId, CAPTURE_ID);
      return {
        received_at: new Date("2026-09-07T12:35:00.000Z"),
        layout_schema_version: "tinder-zte-visible-chat-scroll-v1",
        segment_count: 1,
        overlap_count: 0,
        visible_messages: [{ visible_order: 1, direction: "INCOMING", text: "Synchronisiert" }]
      };
    }
  });

  const list = await service.listLatestConfirmedConversations();
  assert.deepEqual(list, [{
    capture_id: CAPTURE_ID,
    visible_name: "Sandry",
    captured_at: "2026-09-07T12:30:00.000Z"
  }]);
  assert.equal(JSON.stringify(list).includes("Hallo"), false);

  const detail = await service.getLatestConfirmedConversation(CAPTURE_ID);
  assert.equal(receivedCaptureId, CAPTURE_ID);
  assert.deepEqual(detail.messages, [
    { direction: "INCOMING", text: "Hallo" },
    { direction: "OUTGOING", text: "Hi" }
  ]);
  assert.deepEqual(detail.visible_chat_sync.messages, [{ direction: "INCOMING", text: "Synchronisiert" }]);

  const oversizedService = createTinderConversationProductReadService({
    async findLatestConfirmedConversations() {
      return Array.from({ length: TINDER_LATEST_CONFIRMED_CONVERSATION_LIMIT + 1 }, capture);
    },
    async findLatestConfirmedConversationByCaptureId() { return null; }
  });
  await assert.rejects(() => oversizedService.listLatestConfirmedConversations(), TinderConversationProductReadError);

  assert.throws(
    () => normalizeLatestConfirmedConversationDetail(capture({
      visible_messages: Array.from({ length: TINDER_CONVERSATION_MESSAGE_LIMIT + 1 }, (_, index) => ({
        visible_order: index + 1,
        direction: "INCOMING",
        text: "bounded"
      }))
    })),
    TinderConversationProductReadError
  );
});

test("conversation product service keeps the launcher outcome bounded and optional", async () => {
  const service = createTinderConversationProductReadService({
    async findLatestConfirmedConversations() { return []; },
    async findLatestConfirmedConversationByCaptureId() { return capture(); },
    async findLatestConfirmedOfficialAppResumeByCaptureId(captureId) {
      assert.equal(captureId, CAPTURE_ID);
      return { permit_state: "DISPATCHED", expires_at: "2026-09-10T01:51:00.000Z" };
    }
  });
  const detail = await service.getLatestConfirmedConversation(CAPTURE_ID);
  assert.deepEqual(detail.official_app_resume, { status: "DISPATCHED" });
  const rendered = JSON.stringify(detail.official_app_resume);
  for (const forbidden of ["command_id", "device_id", "source_capture_id", "expires_at", "ack"]) {
    assert.equal(rendered.includes(forbidden), false);
  }
});

test("conversation product service keeps the verified-chat return status bounded and optional", async () => {
  const service = createTinderConversationProductReadService({
    async findLatestConfirmedConversations() { return []; },
    async findLatestConfirmedConversationByCaptureId() { return capture(); },
    async findLatestConfirmedVerifiedChatReturnByCaptureId(captureId) {
      assert.equal(captureId, CAPTURE_ID);
      return { permit_state: "STAGED", expires_at: "2999-09-13T12:00:01.000Z" };
    }
  });
  const detail = await service.getLatestConfirmedConversation(CAPTURE_ID);
  assert.deepEqual(detail.verified_chat_return, { status: "STAGED" });
  const rendered = JSON.stringify(detail.verified_chat_return);
  for (const forbidden of [
    "command_id", "device_id", "source_capture_id", "binding_id", "binding_revision",
    "resume_command_id", "expires_at", "terminal_reason", "ack"
  ]) {
    assert.equal(rendered.includes(forbidden), false);
  }
});

test("readable Conversation projection requires a durable public thread and may remain unassigned", () => {
  const pending = readableConversation();
  assert.deepEqual(normalizeTinderReadableConversationList([{
    conversation_handle: pending.conversation_handle,
    visible_name: pending.visible_name,
    observed_at: pending.observed_at,
    identity_state: pending.identity_state,
    identity_review: pending.identity_review,
    history_scope: pending.history_scope
  }]), [{
    conversation_handle: CONVERSATION_ID,
    visible_name: "Unzugeordnet",
    observed_at: "2026-09-22T12:30:00.000Z",
    identity_state: "UNASSIGNED",
    identity_review: "PENDING",
    history_scope: TINDER_READABLE_CONVERSATION_HISTORY_SCOPE
  }]);
  const detail = normalizeTinderReadableConversationDetail(pending);
  assert.equal(detail.history_scope, "AGGREGATED_PARTIAL");
  assert.deepEqual(detail.messages, [
    { direction: "INCOMING", text: "Hallo" },
    { direction: "OUTGOING", text: "Hi" }
  ]);
  assert.throws(
    () => normalizeTinderReadableConversationDetail({
      ...pending,
      conversation_handle: CAPTURE_ID,
      capture_id: CAPTURE_ID
    }),
    TinderConversationProductReadError
  );
});

test("readable Conversation service is device-scoped, bounded, and requires durable projections", async () => {
  const calls = [];
  const service = createTinderReadableConversationProductReadService({
    async findReadableConversations(input) {
      calls.push({ kind: "list", input });
      const { messages, ...item } = readableConversation();
      return [item];
    },
    async findReadableConversationByHandle(input) {
      calls.push({ kind: "detail", input });
      return input.conversationHandle === CONVERSATION_ID ? readableConversation() : null;
    }
  });

  const deviceId = "e880455d-325c-4f35-9914-823dcb0e0d18";
  const list = await service.listReadableConversations(deviceId);
  const detail = await service.getReadableConversation(deviceId, CONVERSATION_ID);
  assert.deepEqual(calls, [
    { kind: "list", input: { deviceId } },
    { kind: "detail", input: { deviceId, conversationHandle: CONVERSATION_ID } }
  ]);
  assert.equal(JSON.stringify(list).includes("Hallo"), false);
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.history_scope, "AGGREGATED_PARTIAL");

  const oversized = createTinderReadableConversationProductReadService({
    async findReadableConversations() {
      return Array.from({ length: TINDER_READABLE_CONVERSATION_LIMIT + 1 }, () => {
        const { messages, ...item } = readableConversation();
        return item;
      });
    },
    async findReadableConversationByHandle() { return null; }
  });
  await assert.rejects(() => oversized.listReadableConversations(deviceId), TinderConversationProductReadError);
  assert.equal(await service.getReadableConversation(deviceId, "f5e4136c-2904-4d1e-9843-8332849601fd"), null);
});

test("readable Conversation reader requires the durable foundation and never promotes a raw capture", async () => {
  const calls = [];
  const repository = createPgTinderReadableConversationProductReadRepository({
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [] };
    }
  }, {
    async inspectProductSchema() {
      return { state: "ABSENT" };
    }
  });
  const deviceId = "e880455d-325c-4f35-9914-823dcb0e0d18";

  await assert.rejects(
    () => repository.findReadableConversations({ deviceId }),
    (error) => error?.code === "TINDER_PRODUCT_CONVERSATION_PRODUCT_READ_NOT_READY"
  );
  await assert.rejects(
    () => repository.findReadableConversationByHandle({ deviceId, conversationHandle: CAPTURE_ID }),
    (error) => error?.code === "TINDER_PRODUCT_CONVERSATION_PRODUCT_READ_NOT_READY"
  );
  assert.equal(calls.length, 0);
});

test("canonical product foundation returns a stable Conversation handle and aggregated linked history", async () => {
  const conversationId = "8e44b221-8e1a-4f18-832d-28e211d26d1c";
  const deviceId = "e880455d-325c-4f35-9914-823dcb0e0d18";
  const threadFingerprint = "a".repeat(64);
  const durableRows = [
    {
      conversation_handle: conversationId,
      identity_binding_state: "UNASSIGNED",
      correlation_state: "CORRELATED",
      history_state: "PARTIAL",
      last_observed_at: "2026-09-22T12:31:00.000Z",
      capture_id: CAPTURE_ID,
      device_id: deviceId,
      runtime_thread_fingerprint: threadFingerprint,
      visible_thread_metadata: { visible_name: "Unzugeordnet" },
      visible_messages: [
        { visible_order: 1, direction: "INCOMING", text: "Hallo" },
        { visible_order: 2, direction: "OUTGOING", text: "Hi" }
      ],
      mapping_status: "NEEDS_HUMAN_MAPPING",
      human_review_status: "PENDING",
      capture_resolved_contact_id: null,
      captured_at: "2026-09-22T12:30:00.000Z",
      received_at: "2026-09-22T12:30:00.000Z"
    },
    {
      conversation_handle: conversationId,
      identity_binding_state: "UNASSIGNED",
      correlation_state: "CORRELATED",
      history_state: "PARTIAL",
      last_observed_at: "2026-09-22T12:31:00.000Z",
      capture_id: "9b9627f4-3da4-445f-bf27-cf450d9fd20f",
      device_id: deviceId,
      runtime_thread_fingerprint: threadFingerprint,
      visible_thread_metadata: { visible_name: "Unzugeordnet" },
      visible_messages: [
        { visible_order: 1, direction: "OUTGOING", text: "Hi" },
        { visible_order: 2, direction: "INCOMING", text: "Neu" }
      ],
      mapping_status: "NEEDS_HUMAN_MAPPING",
      human_review_status: "PENDING",
      capture_resolved_contact_id: null,
      captured_at: "2026-09-22T12:31:00.000Z",
      received_at: "2026-09-22T12:31:00.000Z"
    }
  ];
  const calls = [];
  const repository = createPgTinderReadableConversationProductReadRepository({
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes("FROM tinder_thread_conversations conversation")) {
        if (text.includes("WITH latest_capture")) return { rows: [durableRows[1]] };
        return { rows: durableRows };
      }
      // Canonical rows are already linked; the observation fallback must not
      // duplicate them as capture-shaped list items.
      return { rows: [] };
    }
  }, {
    async inspectProductSchema() {
      return { state: "CANONICAL" };
    }
  });

  const list = await repository.findReadableConversations({ deviceId });
  const detail = await repository.findReadableConversationByHandle({ deviceId, conversationHandle: conversationId });
  assert.deepEqual(list, [{
    conversation_handle: conversationId,
    visible_name: "Unzugeordnet",
    observed_at: "2026-09-22T12:31:00.000Z",
    identity_state: "UNASSIGNED",
    identity_review: "PENDING",
    history_scope: "AGGREGATED_PARTIAL"
  }]);
  assert.deepEqual(detail.messages, [
    { direction: "INCOMING", text: "Hallo" },
    { direction: "OUTGOING", text: "Hi" },
    { direction: "INCOMING", text: "Neu" }
  ]);
  assert.equal(detail.conversation_handle, conversationId);
  assert.equal(detail.history_scope, "AGGREGATED_PARTIAL");
  const durableCalls = calls.filter(({ text }) => text.includes("FROM tinder_thread_conversations conversation"));
  for (const call of durableCalls) {
    assert.match(call.text, /tinder_thread_conversations/);
    assert.match(call.text, /tinder_thread_conversation_capture_links/);
    assert.doesNotMatch(call.text, /DISTINCT ON \(c\.device_id, c\.runtime_thread_fingerprint\)/);
  }
  assert.ok(durableCalls.some(({ text }) => text.includes("latest_capture.device_id = conversation.device_id")));
  assert.ok(durableCalls.some(({ text }) => text.includes("capture.device_id = conversation.device_id")));
});

test("durable detail remains partial when a linked capture cannot be placed by ordered overlap", async () => {
  const deviceId = "e880455d-325c-4f35-9914-823dcb0e0d18";
  const conversationId = CONVERSATION_ID;
  const common = {
    conversation_handle: conversationId,
    identity_binding_state: "UNASSIGNED",
    correlation_state: "CORRELATED",
    history_state: "COMPLETE",
    last_observed_at: "2026-09-22T12:31:00.000Z",
    device_id: deviceId,
    runtime_thread_fingerprint: "b".repeat(64),
    visible_thread_metadata: { visible_name: "Unzugeordnet" },
    mapping_status: "NEEDS_HUMAN_MAPPING",
    human_review_status: "PENDING",
    capture_resolved_contact_id: null
  };
  const rows = [
    {
      ...common,
      capture_id: CAPTURE_ID,
      visible_messages: [
        { visible_order: 1, direction: "INCOMING", text: "Hallo" },
        { visible_order: 2, direction: "OUTGOING", text: "Hi" }
      ],
      captured_at: "2026-09-22T12:30:00.000Z",
      received_at: "2026-09-22T12:30:00.000Z"
    },
    {
      ...common,
      capture_id: "9b9627f4-3da4-445f-bf27-cf450d9fd20f",
      visible_messages: [
        { visible_order: 1, direction: "INCOMING", text: "Nicht platzierbar" },
        { visible_order: 2, direction: "OUTGOING", text: "Weiter" }
      ],
      captured_at: "2026-09-22T12:31:00.000Z",
      received_at: "2026-09-22T12:31:00.000Z"
    }
  ];
  const repository = createPgTinderReadableConversationProductReadRepository({
    async query() { return { rows }; }
  }, {
    async inspectProductSchema() { return { state: "CANONICAL" }; }
  });

  const detail = await repository.findReadableConversationByHandle({ deviceId, conversationHandle: conversationId });
  assert.equal(detail.history_scope, "AGGREGATED_PARTIAL");
  assert.deepEqual(detail.messages, [
    { direction: "INCOMING", text: "Hallo" },
    { direction: "OUTGOING", text: "Hi" }
  ]);
});

test("Postgres reader selects only the latest safe resolved confirmed capture and never selects technical fields", async () => {
  const calls = [];
  const repository = createPgTinderConversationProductReadRepository({
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [] };
    }
  });

  await repository.findLatestConfirmedConversations();
  await repository.findLatestConfirmedConversationByCaptureId(CAPTURE_ID);
  await repository.findLatestConfirmedVisibleChatSyncByCaptureId(CAPTURE_ID);
  await repository.findLatestConfirmedOfficialAppResumeByCaptureId(CAPTURE_ID);
  await repository.findLatestConfirmedVerifiedChatReturnByCaptureId(CAPTURE_ID);

  assert.equal(calls.length, 5);
  const [list, detail, visibleChatSync, officialAppResume, verifiedChatReturn] = calls;
  for (const query of [list.text, detail.text, visibleChatSync.text, officialAppResume.text, verifiedChatReturn.text]) {
    assert.match(query, /capture_safety_status = 'SAFE'/);
    assert.match(query, /mapping_status = 'RESOLVED'/);
    assert.match(query, /human_review_status = 'CONFIRMED'/);
    assert.match(query, /resolved_contact_id IS NOT NULL/);
    assert.match(query, /MAX\(newer\.capture_revision\)/);
    assert.match(query, /newer\.device_id = c\.device_id/);
    assert.match(query, /newer\.runtime_thread_fingerprint = c\.runtime_thread_fingerprint/);
  }
  assert.match(list.text, /LIMIT \$1/);
  assert.deepEqual(list.values, [TINDER_LATEST_CONFIRMED_CONVERSATION_LIMIT]);
  assert.match(detail.text, /c\.capture_id = \$1/);
  assert.deepEqual(detail.values, [CAPTURE_ID]);
  assert.match(detail.text, /c\.visible_messages/);
  assert.doesNotMatch(detail.text, /SELECT \*/);
  const selectedColumns = detail.text.slice(0, detail.text.indexOf("FROM tinder_visible_chat_captures"));
  assert.doesNotMatch(selectedColumns, /c\.device_id/);
  assert.doesNotMatch(selectedColumns, /c\.runtime_thread_fingerprint/);
  assert.doesNotMatch(selectedColumns, /c\.capture_fingerprint/);
  assert.doesNotMatch(selectedColumns, /c\.resolved_contact_id/);
  assert.match(visibleChatSync.text, /FROM tinder_visible_chat_sync_transcripts s/);
  assert.match(visibleChatSync.text, /s\.visible_messages/);
  assert.doesNotMatch(visibleChatSync.text, /s\.command_id/);
  assert.doesNotMatch(visibleChatSync.text, /s\.device_id/);
  assert.doesNotMatch(visibleChatSync.text, /s\.transcript_fingerprint/);
  assert.match(officialAppResume.text, /LEFT JOIN LATERAL/i);
  assert.match(officialAppResume.text, /FROM tinder_official_app_resume_permits/i);
  assert.match(officialAppResume.text, /ORDER BY created_at DESC, command_id DESC/i);
  assert.match(officialAppResume.text, /LIMIT 1/i);
  assert.match(officialAppResume.text, /COALESCE\(p\.permit_state, 'NOT_REQUESTED'\)/i);
  assert.deepEqual(officialAppResume.values, [CAPTURE_ID]);
  const resumeColumns = officialAppResume.text.slice(0, officialAppResume.text.indexOf("FROM tinder_visible_chat_captures"));
  assert.doesNotMatch(resumeColumns, /p\.command_id/);
  assert.doesNotMatch(resumeColumns, /p\.device_id/);
  assert.doesNotMatch(resumeColumns, /p\.source_capture_id/);

  assert.match(verifiedChatReturn.text, /LEFT JOIN LATERAL/i);
  assert.match(verifiedChatReturn.text, /FROM tinder_verified_chat_return_permits/i);
  assert.match(verifiedChatReturn.text, /ORDER BY created_at DESC, command_id DESC/i);
  assert.match(verifiedChatReturn.text, /LIMIT 1/i);
  assert.match(verifiedChatReturn.text, /COALESCE\(p\.permit_state, 'NOT_REQUESTED'\)/i);
  assert.deepEqual(verifiedChatReturn.values, [CAPTURE_ID]);
  const returnColumns = verifiedChatReturn.text.slice(0, verifiedChatReturn.text.indexOf("FROM tinder_visible_chat_captures"));
  for (const forbidden of [
    "p.command_id", "p.device_id", "p.source_capture_id", "p.binding_id", "p.binding_revision",
    "p.resume_command_id", "terminal_reason"
  ]) {
    assert.doesNotMatch(returnColumns, new RegExp(forbidden.replace(".", "\\.")));
  }
});

test("missing optional launcher foundation remains unavailable rather than fresh", async () => {
  const repository = createPgTinderConversationProductReadRepository({
    async query() {
      const error = new Error("relation unavailable");
      error.code = "42P01";
      throw error;
    }
  });
  assert.equal(await repository.findLatestConfirmedOfficialAppResumeByCaptureId(CAPTURE_ID), undefined);
  assert.equal(await repository.findLatestConfirmedVerifiedChatReturnByCaptureId(CAPTURE_ID), undefined);
});
