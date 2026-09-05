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
    async findCaptureByFingerprint(_transaction, { deviceId, runtimeThreadFingerprint, captureFingerprint }) {
      return rows.find((row) => row.deviceId === deviceId
        && row.runtimeThreadFingerprint === runtimeThreadFingerprint
        && row.captureFingerprint === captureFingerprint) || null;
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

test("an identical signed-capture fingerprint is idempotent within its device thread", async () => {
  const repository = fixtureRepository();
  const store = createTinderCaptureStore(repository, {
    createCaptureId: () => CAPTURE_ID,
    now: () => new Date("2026-09-04T18:01:00.000Z")
  });
  const input = { deviceId: DEVICE_ID, capture: safeCapture(), provenance: { source: "android_visible_chat", protocolVersion: 1 } };
  const first = await store.storeSafeCapture(input);
  const second = await store.storeSafeCapture(input);
  assert.equal(first, second);
  assert.equal(repository.rows.length, 1);
  assert.equal(first.captureRevision, 1);
});

test("fingerprint deduplication occurs only after the existing per-thread lock hook", async () => {
  const events = [];
  const existing = Object.freeze({ captureId: CAPTURE_ID, captureRevision: 1 });
  const repository = {
    async withTransaction(work) { return work({}); },
    async nextCaptureRevision() {
      events.push("thread-lock-and-revision");
      return 2;
    },
    async findCaptureByFingerprint() {
      events.push("fingerprint-lookup");
      assert.deepEqual(events, ["thread-lock-and-revision", "fingerprint-lookup"]);
      return existing;
    },
    async insertCapture() { assert.fail("a locked duplicate must not insert"); },
    async findCaptureById() { return null; }
  };
  const store = createTinderCaptureStore(repository, {
    createCaptureId: () => CAPTURE_ID,
    now: () => new Date("2026-09-04T18:01:00.000Z")
  });

  const result = await store.storeSafeCapture({
    deviceId: DEVICE_ID,
    capture: safeCapture(),
    provenance: { source: "android_visible_chat", protocolVersion: 1 }
  });

  assert.equal(result, existing);
  assert.deepEqual(events, ["thread-lock-and-revision", "fingerprint-lookup"]);
});

test("the PostgreSQL adapter locks a thread before duplicate lookup and never inserts a locked duplicate", async () => {
  const calls = [];
  const existing = { capture_id: CAPTURE_ID, capture_revision: 1 };
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{ locked: true }] };
      if (sql.includes("MAX(capture_revision)")) return { rows: [{ next_revision: 2 }] };
      if (sql.includes("WHERE device_id = $1") && sql.includes("capture_fingerprint = $3")) {
        return { rows: [existing] };
      }
      if (sql.includes("INSERT INTO tinder_visible_chat_captures")) {
        assert.fail("a duplicate found under the lock must not insert");
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {}
  };
  const repository = createPgTinderCaptureRepository({
    async connect() { return client; },
    async query() { return { rows: [] }; }
  });
  const store = createTinderCaptureStore(repository, {
    createCaptureId: () => CAPTURE_ID,
    now: () => new Date("2026-09-04T18:01:00.000Z")
  });

  const result = await store.storeSafeCapture({
    deviceId: DEVICE_ID,
    capture: safeCapture(),
    provenance: { source: "android_visible_chat", protocolVersion: 1 }
  });
  assert.equal(result, existing);
  const lockIndex = calls.findIndex(call => call.sql.includes("pg_advisory_xact_lock"));
  const fingerprintIndex = calls.findIndex(call => call.sql.includes("capture_fingerprint = $3"));
  assert.ok(lockIndex >= 0);
  assert.ok(fingerprintIndex > lockIndex);
  assert.equal(calls.some(call => call.sql.includes("INSERT INTO tinder_visible_chat_captures")), false);
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
