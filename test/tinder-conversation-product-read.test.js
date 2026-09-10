import assert from "node:assert/strict";
import test from "node:test";
import {
  TINDER_CONVERSATION_MESSAGE_LIMIT,
  TINDER_LATEST_CONFIRMED_CONVERSATION_LIMIT,
  TinderConversationProductReadError,
  createPgTinderConversationProductReadRepository,
  createTinderConversationProductReadService,
  normalizeLatestConfirmedConversationDetail,
  normalizeLatestConfirmedConversationListItem,
  normalizeLatestConfirmedOfficialAppResume,
  normalizeVisibleChatSync
} from "../services/tinder-conversation-product-read.js";

const CAPTURE_ID = "6c7308cf-5d40-423d-913b-c4424f0e4ee0";

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

  assert.equal(calls.length, 4);
  const [list, detail, visibleChatSync, officialAppResume] = calls;
  for (const query of [list.text, detail.text, visibleChatSync.text, officialAppResume.text]) {
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
});
