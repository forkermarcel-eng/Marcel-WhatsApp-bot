import assert from "node:assert/strict";
import test from "node:test";
import {
  TINDER_CAPTURE_MAPPING_STATUS,
  TINDER_CAPTURE_REVIEW_STATUS,
  TinderCaptureValidationError,
  createPgTinderCaptureRepository,
  createTinderCaptureStore,
  validateSafeVisibleChatCapture
} from "../services/tinder-capture-store.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const CAPTURE_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";

function safeCapture(overrides = {}) {
  return {
    captureMetadata: {
      schemaVersion: "tinder-visible-chat-v1",
      sourcePackage: "com.tinder",
      capturedAt: "2026-09-04T18:00:00.000Z",
      visibleNodeCount: 9,
      captureFingerprint: "a".repeat(64)
    },
    visibleThreadMetadata: {
      visibleName: "Sandry",
      threadFingerprint: "b".repeat(64),
      headerClassName: "fixture.ThreadHeader"
    },
    visibleMessages: [
      { visibleOrder: 1, text: "Hola", direction: "INCOMING", sourceClassName: "fixture.Incoming" },
      { visibleOrder: 2, text: "Hola", direction: "OUTGOING", sourceClassName: "fixture.Outgoing" }
    ],
    safetyStatus: "SAFE",
    ...overrides
  };
}

function fixtureRepository() {
  const rows = [];
  let revision = 0;
  return {
    rows,
    async withTransaction(work) { return work({}); },
    async nextCaptureRevision() { revision += 1; return revision; },
    async insertCapture(_transaction, record) {
      rows.push(record);
      return record;
    },
    async findCaptureById(captureId) {
      return rows.find((row) => row.captureId === captureId) || null;
    }
  };
}

test("a safe T2 capture is stored with server-owned state and no contact identity", async () => {
  const repository = fixtureRepository();
  const store = createTinderCaptureStore(repository, {
    createCaptureId: () => CAPTURE_ID,
    now: () => new Date("2026-09-04T18:01:00.000Z")
  });

  const stored = await store.storeSafeCapture({
    deviceId: DEVICE_ID,
    capture: safeCapture(),
    provenance: { source: "android_visible_chat", protocolVersion: 2 }
  });

  assert.equal(stored.captureId, CAPTURE_ID);
  assert.equal(stored.captureRevision, 1);
  assert.equal(stored.mappingStatus, TINDER_CAPTURE_MAPPING_STATUS.NEEDS_HUMAN_MAPPING);
  assert.equal(stored.humanReviewStatus, TINDER_CAPTURE_REVIEW_STATUS.PENDING);
  assert.equal(stored.resolvedContactId, null);
  assert.equal(stored.provenance.source, "android_visible_chat");
  assert.equal(Object.hasOwn(stored, "whatsappJid"), false);
  assert.equal(Object.hasOwn(stored, "contactId"), false);
  assert.equal(await store.getCapture(CAPTURE_ID), stored);
});

test("unsafe or injected captures fail before a persistence transaction", async () => {
  for (const capture of [
    safeCapture({ safetyStatus: "BLOCKED_UNKNOWN_STRUCTURE" }),
    safeCapture({ contactId: 7 }),
    safeCapture({ whatsappJid: "person@example.invalid" }),
    safeCapture({ resolvedContactId: 7 })
  ]) {
    const repository = fixtureRepository();
    const store = createTinderCaptureStore(repository, { createCaptureId: () => CAPTURE_ID });
    await assert.rejects(
      () => store.storeSafeCapture({ deviceId: DEVICE_ID, capture }),
      TinderCaptureValidationError
    );
    assert.equal(repository.rows.length, 0);
  }
});

test("capture validation preserves only visible ordered messages and known directions", () => {
  const normalized = validateSafeVisibleChatCapture(safeCapture());
  assert.deepEqual(
    normalized.visibleMessages.map((message) => [message.visibleOrder, message.direction]),
    [[1, "INCOMING"], [2, "OUTGOING"]]
  );

  assert.throws(
    () => validateSafeVisibleChatCapture(safeCapture({
      visibleMessages: [{ visibleOrder: 1, text: "x", direction: "SIDEWAYS" }]
    })),
    TinderCaptureValidationError
  );
  assert.throws(
    () => validateSafeVisibleChatCapture(safeCapture({
      visibleMessages: [{ visibleOrder: 2, text: "x", direction: "UNKNOWN" }, { visibleOrder: 1, text: "y", direction: "INCOMING" }]
    })),
    TinderCaptureValidationError
  );
});

test("the PostgreSQL capture adapter writes only the dedicated Tinder capture table", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/INSERT INTO tinder_visible_chat_captures/.test(sql)) return { rows: [{ capture_id: CAPTURE_ID }] };
      return { rows: [{ next_revision: 1 }] };
    },
    release() {}
  };
  const repository = createPgTinderCaptureRepository({
    async connect() { return client; },
    async query() { return { rows: [] }; }
  });

  await repository.insertCapture(client, {
    captureId: CAPTURE_ID,
    deviceId: DEVICE_ID,
    schemaVersion: "tinder-visible-chat-v1",
    sourcePackage: "com.tinder",
    captureSafetyStatus: "SAFE",
    runtimeThreadFingerprint: "b".repeat(64),
    captureFingerprint: "a".repeat(64),
    captureRevision: 1,
    visibleThreadMetadata: { visibleName: "Sandry", threadFingerprint: "b".repeat(64) },
    visibleMessages: [{ visibleOrder: 1, text: "Hola", direction: "INCOMING" }],
    mappingStatus: "NEEDS_HUMAN_MAPPING",
    humanReviewStatus: "PENDING",
    resolvedContactId: null,
    provenance: { source: "android_visible_chat" },
    capturedAt: "2026-09-04T18:00:00.000Z",
    receivedAt: "2026-09-04T18:01:00.000Z"
  });

  const insert = calls.find((call) => /INSERT INTO tinder_visible_chat_captures/.test(call.sql));
  assert.ok(insert);
  assert.doesNotMatch(insert.sql, /INSERT INTO messages/i);
  assert.doesNotMatch(insert.sql, /whatsapp_jid/i);
});
