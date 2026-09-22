import assert from "node:assert/strict";
import test from "node:test";
import {
  TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE,
  TINDER_PRODUCT_CONVERSATION_DISPOSITION,
  TINDER_PRODUCT_CONVERSATION_HISTORY_STATE,
  TINDER_PRODUCT_CONVERSATION_READ_DISPOSITION,
  aggregateTinderProductConversationHistory,
  createPgTinderProductConversationRepository,
  createTinderProductConversationService,
  mergeOrderedTinderMessageHistory,
  orderedDirectionalOverlap
} from "../services/tinder-product-conversation-store.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const THREAD_HINT = "a".repeat(64);

function id(index) {
  return `a565e8a7-ef60-42d0-b19d-${String(index).padStart(12, "0")}`;
}

function messages(...items) {
  return items.map(([direction, text], index) => ({
    visibleOrder: index + 1,
    direction,
    text
  }));
}

function field(value, camelCase, snakeCase) {
  return value?.[camelCase] ?? value?.[snakeCase];
}

function capture(index, sequence, {
  threadHint = THREAD_HINT,
  capturedAt = `2026-09-22T10:${String(index).padStart(2, "0")}:00.000Z`,
  mappingStatus = "NEEDS_HUMAN_MAPPING",
  humanReviewStatus = "PENDING",
  resolvedContactId = null,
  historyComplete = false,
  captureFingerprint = String(index).padStart(64, "c"),
  captureRevision = index,
  schemaVersion = "",
  provenance = null,
  predecessorCaptureFingerprint = null
} = {}) {
  return {
    captureId: id(index),
    deviceId: DEVICE_ID,
    runtimeThreadFingerprint: threadHint,
    visibleMessages: messages(...sequence),
    capturedAt,
    receivedAt: capturedAt,
    mappingStatus,
    humanReviewStatus,
    resolvedContactId,
    historyComplete,
    captureFingerprint,
    captureRevision,
    ...(schemaVersion ? { schemaVersion } : {}),
    ...(provenance ? { provenance } : {}),
    ...(predecessorCaptureFingerprint === null ? {} : { predecessorCaptureFingerprint })
  };
}

function repository({ ready = true } = {}) {
  const conversations = [];
  const captureLinks = new Map();
  return {
    conversations,
    captureLinks,
    async isReady() { return ready; },
    async findCaptureLink(_transaction, { captureId, deviceId }) {
      assert.equal(deviceId, DEVICE_ID, "idempotency lookup must stay inside the capture device scope");
      const conversationId = captureLinks.get(captureId);
      const conversation = conversations.find(value => value.conversationId === conversationId);
      return conversationId ? { conversationId, historyState: conversation.historyState } : null;
    },
    async findCandidates(_transaction, { deviceId, runtimeThreadFingerprint }) {
      return conversations
        .filter(conversation => conversation.deviceId === deviceId
          && conversation.runtimeThreadFingerprintHint === runtimeThreadFingerprint)
        .map(conversation => ({
          conversationId: conversation.conversationId,
          correlationState: conversation.correlationState,
          identityBindingState: conversation.identityBindingState,
          resolvedContactId: conversation.resolvedContactId,
          historyState: conversation.historyState,
          captures: conversation.captures
        }));
    },
    async createConversation(_transaction, record) {
      conversations.push({ ...record, captures: [] });
    },
    async linkCapture(_transaction, record) {
      const existing = captureLinks.get(record.captureId);
      if (existing) return { conversationId: existing };
      const conversation = conversations.find(value => value.conversationId === record.conversationId);
      assert.ok(conversation, "link target must exist");
      captureLinks.set(record.captureId, record.conversationId);
      conversation.captures.push({
        captureId: record.captureId,
        deviceId: conversation.deviceId,
        runtimeThreadFingerprint: conversation.runtimeThreadFingerprintHint,
        visibleMessages: field(record.capture, "visibleMessages", "visible_messages"),
        capturedAt: field(record.capture, "capturedAt", "captured_at"),
        receivedAt: field(record.capture, "receivedAt", "received_at"),
        mappingStatus: field(record.capture, "mappingStatus", "mapping_status"),
        humanReviewStatus: field(record.capture, "humanReviewStatus", "human_review_status"),
        resolvedContactId: field(record.capture, "resolvedContactId", "resolved_contact_id"),
        captureFingerprint: field(record.capture, "captureFingerprint", "capture_fingerprint"),
        captureRevision: field(record.capture, "captureRevision", "capture_revision"),
        schemaVersion: field(record.capture, "schemaVersion", "capture_schema_version"),
        provenance: record.capture.provenance
      });
      return { conversationId: record.conversationId };
    },
    async updateConversation(_transaction, record) {
      const conversation = conversations.find(value => value.conversationId === record.conversationId);
      Object.assign(conversation, record);
    }
  };
}

// The fake link method needs the capture observation but production persistence
// only needs IDs.  Keep that test-only adapter outside the production API.
function projectableRepository(options) {
  const value = repository(options);
  const original = value.linkCapture;
  value.linkCapture = async (transaction, record) => {
    // The service deliberately passes no content to the production link. The
    // fake's observation is supplied through the current test transaction.
    const supplied = transaction.captures.get(record.captureId);
    return original(transaction, { ...record, capture: supplied });
  };
  value.findPredecessorContinuityCandidates = async (_transaction, {
    deviceId,
    runtimeThreadFingerprint,
    predecessorCaptureFingerprint,
    predecessorCaptureRevision
  }) => conversationsForContinuity(value.conversations, {
    deviceId,
    runtimeThreadFingerprint,
    predecessorCaptureFingerprint,
    predecessorCaptureRevision
  });
  return value;
}

function conversationsForContinuity(conversations, {
  deviceId,
  runtimeThreadFingerprint,
  predecessorCaptureFingerprint,
  predecessorCaptureRevision
}) {
  return conversations.flatMap(conversation => conversation.captures
    .filter(stored => stored.captureFingerprint === predecessorCaptureFingerprint
      && stored.captureRevision === predecessorCaptureRevision)
    .map(stored => ({
      conversationId: conversation.conversationId,
      deviceId: conversation.deviceId,
      runtimeThreadFingerprint: conversation.runtimeThreadFingerprintHint,
      correlationState: conversation.correlationState,
      identityBindingState: conversation.identityBindingState,
      resolvedContactId: conversation.resolvedContactId,
      historyState: conversation.historyState,
      predecessorCaptureFingerprint: stored.captureFingerprint,
      predecessorCapture: stored
    }))
  ).filter(candidate => candidate.deviceId === deviceId
    && candidate.runtimeThreadFingerprint === runtimeThreadFingerprint);
}

function project(service, captureRecord, store) {
  const captureId = field(captureRecord, "captureId", "capture_id");
  return service.projectCapture({ captures: new Map([[captureId, captureRecord]]) }, captureRecord);
}

test("ordered directional overlap merges only a provable viewport edge", () => {
  const older = messages(["INCOMING", "one"], ["OUTGOING", "two"], ["INCOMING", "three"]);
  const newer = messages(["OUTGOING", "two"], ["INCOMING", "three"], ["OUTGOING", "four"]);

  assert.deepEqual(orderedDirectionalOverlap(older, newer), { count: 2, relation: "APPEND_RIGHT" });
  const merged = mergeOrderedTinderMessageHistory(older, newer);
  assert.equal(merged.merged, true);
  assert.deepEqual(merged.messages.map(message => message.text), ["one", "two", "three", "four"]);
});

test("aggregation retains duplicate text at distinct directional positions", () => {
  const aggregate = aggregateTinderProductConversationHistory([
    capture(1, [["INCOMING", "Hi"], ["OUTGOING", "Hi"]]),
    capture(2, [["OUTGOING", "Hi"], ["INCOMING", "Hi"]])
  ]);
  assert.equal(aggregate.unmergedCaptureCount, 0);
  assert.deepEqual(aggregate.messages.map(message => [message.direction, message.text]), [
    ["INCOMING", "Hi"], ["OUTGOING", "Hi"], ["INCOMING", "Hi"]
  ]);
});

test("a unique two-message overlap updates one unassigned product conversation", async () => {
  const repo = projectableRepository();
  const service = createTinderProductConversationService(repo, {
    createConversationId: () => id(101),
    now: () => new Date("2026-09-22T12:00:00.000Z")
  });
  const first = capture(1, [["INCOMING", "one"], ["OUTGOING", "two"], ["INCOMING", "three"]]);
  const second = capture(2, [["OUTGOING", "two"], ["INCOMING", "three"], ["OUTGOING", "four"]]);

  assert.equal((await project(service, first)).disposition, TINDER_PRODUCT_CONVERSATION_DISPOSITION.CREATED);
  const result = await project(service, second);

  assert.equal(result.disposition, TINDER_PRODUCT_CONVERSATION_DISPOSITION.UPDATED);
  assert.equal(repo.conversations.length, 1);
  assert.equal(repo.conversations[0].correlationState, TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.CORRELATED);
  assert.equal(repo.conversations[0].captures.length, 2);
});

test("a completed initial capture advances only the existing Conversation history state", async () => {
  const repo = projectableRepository();
  const service = createTinderProductConversationService(repo, {
    createConversationId: () => id(105),
    now: () => new Date("2026-09-22T12:00:00.000Z")
  });
  const result = await project(service, capture(10, [
    ["INCOMING", "one"], ["OUTGOING", "two"]
  ], { historyComplete: true }));

  assert.equal(result.disposition, TINDER_PRODUCT_CONVERSATION_DISPOSITION.CREATED);
  assert.equal(result.historyState, TINDER_PRODUCT_CONVERSATION_HISTORY_STATE.COMPLETE);
  assert.equal(result.readDisposition, TINDER_PRODUCT_CONVERSATION_READ_DISPOSITION.FULL_READ_REQUIRED);
  assert.equal(repo.conversations[0].historyState, TINDER_PRODUCT_CONVERSATION_HISTORY_STATE.COMPLETE);
});

test("a contained viewport of a completed Conversation is unchanged and never downgrades history", async () => {
  const repo = projectableRepository();
  const service = createTinderProductConversationService(repo, {
    createConversationId: () => id(106),
    now: () => new Date("2026-09-22T12:00:00.000Z")
  });
  await project(service, capture(11, [
    ["INCOMING", "one"], ["OUTGOING", "two"], ["INCOMING", "three"]
  ], { historyComplete: true }));
  const result = await project(service, capture(12, [
    ["OUTGOING", "two"], ["INCOMING", "three"]
  ]));

  assert.equal(result.disposition, TINDER_PRODUCT_CONVERSATION_DISPOSITION.UPDATED);
  assert.equal(result.historyState, TINDER_PRODUCT_CONVERSATION_HISTORY_STATE.COMPLETE);
  assert.equal(result.readDisposition, TINDER_PRODUCT_CONVERSATION_READ_DISPOSITION.UNCHANGED);
  assert.equal(repo.conversations[0].historyState, TINDER_PRODUCT_CONVERSATION_HISTORY_STATE.COMPLETE);
});

test("an overlap-proven append to a completed Conversation is a bounded delta", async () => {
  const repo = projectableRepository();
  const service = createTinderProductConversationService(repo, {
    createConversationId: () => id(107),
    now: () => new Date("2026-09-22T12:00:00.000Z")
  });
  await project(service, capture(13, [
    ["INCOMING", "one"], ["OUTGOING", "two"], ["INCOMING", "three"]
  ], { historyComplete: true }));
  const result = await project(service, capture(14, [
    ["OUTGOING", "two"], ["INCOMING", "three"], ["OUTGOING", "four"]
  ]));

  assert.equal(result.disposition, TINDER_PRODUCT_CONVERSATION_DISPOSITION.UPDATED);
  assert.equal(result.historyState, TINDER_PRODUCT_CONVERSATION_HISTORY_STATE.COMPLETE);
  assert.equal(result.readDisposition, TINDER_PRODUCT_CONVERSATION_READ_DISPOSITION.DELTA_ACCEPTED);
});

test("same hint without overlap remains separate instead of merging by a visible label", async () => {
  const repo = projectableRepository();
  let next = 110;
  const service = createTinderProductConversationService(repo, {
    createConversationId: () => id(next++),
    now: () => new Date("2026-09-22T12:00:00.000Z")
  });

  await project(service, capture(3, [["INCOMING", "first"], ["OUTGOING", "reply"]]));
  const result = await project(service, capture(4, [["INCOMING", "different"], ["OUTGOING", "thread"]]));

  assert.equal(result.disposition, TINDER_PRODUCT_CONVERSATION_DISPOSITION.CREATED);
  assert.equal(repo.conversations.length, 2);
  assert.ok(repo.conversations.every(value => value.correlationState === TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.PROVISIONAL));
});

test("multiple overlap candidates make a new ambiguous conversation instead of a false merge", async () => {
  const repo = projectableRepository();
  let next = 120;
  const service = createTinderProductConversationService(repo, {
    createConversationId: () => id(next++),
    now: () => new Date("2026-09-22T12:00:00.000Z")
  });
  const common = [["INCOMING", "one"], ["OUTGOING", "two"]];
  await project(service, capture(5, common));
  // A second preexisting candidate is deliberately injected as a separately
  // correlated technical record with the same hint and transcript.
  repo.conversations.push({
    conversationId: id(130),
    deviceId: DEVICE_ID,
    runtimeThreadFingerprintHint: THREAD_HINT,
    correlationState: "PROVISIONAL",
    identityBindingState: "UNASSIGNED",
    resolvedContactId: null,
    historyState: "PARTIAL",
    captures: [capture(6, common)]
  });
  repo.captureLinks.set(id(6), id(130));

  const result = await project(service, capture(7, [...common, ["INCOMING", "three"]]));
  assert.equal(result.disposition, TINDER_PRODUCT_CONVERSATION_DISPOSITION.CREATED);
  assert.equal(repo.conversations.length, 3);
  assert.equal(repo.conversations[2].correlationState, TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.AMBIGUOUS);
});

test("an already linked capture is explicitly idempotent and does not mutate history", async () => {
  const repo = projectableRepository();
  const service = createTinderProductConversationService(repo, {
    createConversationId: () => id(140),
    now: () => new Date("2026-09-22T12:00:00.000Z")
  });
  const first = capture(8, [["INCOMING", "one"], ["OUTGOING", "two"]]);
  await project(service, first);
  const again = await project(service, first);
  assert.equal(again.disposition, TINDER_PRODUCT_CONVERSATION_DISPOSITION.IDEMPOTENT_DUPLICATE);
  assert.equal(again.historyState, TINDER_PRODUCT_CONVERSATION_HISTORY_STATE.PARTIAL);
  assert.equal(again.readDisposition, TINDER_PRODUCT_CONVERSATION_READ_DISPOSITION.UNCHANGED);
  assert.equal(repo.conversations.length, 1);
  assert.equal(repo.conversations[0].captures.length, 1);
});

test("a one-message passive probe continuity links the following complete full read to one Conversation", async () => {
  const repo = projectableRepository();
  const service = createTinderProductConversationService(repo, {
    createConversationId: () => id(146),
    now: () => new Date("2026-09-22T12:00:00.000Z")
  });
  const probe = capture(16, [["INCOMING", "newest"]], {
    captureFingerprint: "1".repeat(64),
    schemaVersion: "tinder-visible-chat-v2",
    provenance: { source: "android_visible_chat", protocolVersion: 1, readChannel: "PASSIVE_READ" }
  });
  const full = capture(17, [["INCOMING", "older"], ["INCOMING", "newest"]], {
    captureFingerprint: "2".repeat(64),
    schemaVersion: "tinder-visible-chat-v2",
    provenance: { source: "android_visible_chat", protocolVersion: 1, readChannel: "PASSIVE_READ" },
    predecessorCaptureFingerprint: probe.captureFingerprint,
    historyComplete: true
  });

  const probed = await project(service, probe);
  assert.equal(probed.disposition, TINDER_PRODUCT_CONVERSATION_DISPOSITION.CREATED);
  assert.equal(probed.historyState, TINDER_PRODUCT_CONVERSATION_HISTORY_STATE.PARTIAL);

  // PostgreSQL returns the durable capture schema under its database column
  // name. The transient predecessor still has to remain eligible when the
  // product projector receives that real stored-row shape.
  const pgShapedFull = {
    ...full,
    capture_schema_version: full.schemaVersion
  };
  delete pgShapedFull.schemaVersion;
  const result = await project(service, pgShapedFull);
  assert.equal(result.disposition, TINDER_PRODUCT_CONVERSATION_DISPOSITION.UPDATED);
  assert.equal(result.historyState, TINDER_PRODUCT_CONVERSATION_HISTORY_STATE.COMPLETE);
  assert.equal(repo.conversations.length, 1);
  assert.equal(repo.conversations[0].captures.length, 2);
});

test("a stale passive probe cannot bridge over a newer capture revision", async () => {
  const repo = projectableRepository();
  let nextConversation = 148;
  const service = createTinderProductConversationService(repo, {
    createConversationId: () => id(nextConversation++),
    now: () => new Date("2026-09-22T12:00:00.000Z")
  });
  const provenance = { source: "android_visible_chat", protocolVersion: 1, readChannel: "PASSIVE_READ" };
  const probe = capture(20, [["INCOMING", "newest"]], {
    captureFingerprint: "5".repeat(64),
    captureRevision: 1,
    schemaVersion: "tinder-visible-chat-v2",
    provenance
  });
  const intervening = capture(21, [["INCOMING", "unrelated"]], {
    captureFingerprint: "6".repeat(64),
    captureRevision: 2,
    schemaVersion: "tinder-visible-chat-v2",
    provenance
  });
  const staleFull = capture(22, [["INCOMING", "older"], ["INCOMING", "newest"]], {
    captureFingerprint: "7".repeat(64),
    captureRevision: 3,
    schemaVersion: "tinder-visible-chat-v2",
    provenance,
    predecessorCaptureFingerprint: probe.captureFingerprint,
    historyComplete: true
  });

  await project(service, probe);
  await project(service, intervening);
  await assert.rejects(
    () => project(service, staleFull),
    error => error.code === "TINDER_PRODUCT_CONVERSATION_CONTINUITY_INVALID"
  );

  assert.equal(repo.conversations.length, 2);
  assert.deepEqual(repo.conversations.map(conversation => conversation.captures.length), [1, 1]);
});

test("an invalid immediate predecessor cannot fall through into a second Conversation", async () => {
  const repo = projectableRepository();
  const service = createTinderProductConversationService(repo, {
    createConversationId: () => id(147),
    now: () => new Date("2026-09-22T12:00:00.000Z")
  });
  await project(service, capture(18, [["INCOMING", "newest"]], {
    captureFingerprint: "3".repeat(64),
    schemaVersion: "tinder-visible-chat-v2",
    provenance: { source: "android_visible_chat", protocolVersion: 1, readChannel: "PASSIVE_READ" }
  }));

  await assert.rejects(
    () => project(service, capture(19, [["INCOMING", "older"], ["INCOMING", "newest"]], {
      captureFingerprint: "4".repeat(64),
      schemaVersion: "tinder-visible-chat-v2",
      provenance: { source: "android_visible_chat", protocolVersion: 1, readChannel: "PASSIVE_READ" },
      predecessorCaptureFingerprint: "f".repeat(64),
      historyComplete: true
    })),
    error => error.code === "TINDER_PRODUCT_CONVERSATION_CONTINUITY_INVALID"
  );
  assert.equal(repo.conversations.length, 1);
  assert.equal(repo.conversations[0].captures.length, 1);
});

test("a linked duplicate of a completed Conversation is unchanged", async () => {
  const repo = projectableRepository();
  const service = createTinderProductConversationService(repo, {
    createConversationId: () => id(145),
    now: () => new Date("2026-09-22T12:00:00.000Z")
  });
  const complete = capture(15, [["INCOMING", "one"], ["OUTGOING", "two"]], {
    historyComplete: true
  });
  await project(service, complete);
  const duplicate = await project(service, complete);

  assert.equal(duplicate.disposition, TINDER_PRODUCT_CONVERSATION_DISPOSITION.IDEMPOTENT_DUPLICATE);
  assert.equal(duplicate.historyState, TINDER_PRODUCT_CONVERSATION_HISTORY_STATE.COMPLETE);
  assert.equal(duplicate.readDisposition, TINDER_PRODUCT_CONVERSATION_READ_DISPOSITION.UNCHANGED);
});

test("a missing product schema never blocks immutable capture provenance", async () => {
  const repo = projectableRepository({ ready: false });
  const service = createTinderProductConversationService(repo, { createConversationId: () => id(150) });
  const result = await project(service, capture(9, [["INCOMING", "one"]]));
  assert.deepEqual(result, {
    disposition: TINDER_PRODUCT_CONVERSATION_DISPOSITION.NOT_READY,
    conversationId: null,
    historyState: null,
    readDisposition: TINDER_PRODUCT_CONVERSATION_READ_DISPOSITION.FULL_READ_REQUIRED
  });
  assert.equal(repo.conversations.length, 0);
});

test("the PostgreSQL adapter scopes idempotency and conflict links to one device", async () => {
  const calls = [];
  const adapter = createPgTinderProductConversationRepository({
    async query() { throw new Error("pool query must not be used directly"); }
  });
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      // First query is the device-scoped idempotency read. The second is the
      // INSERT ... SELECT; its empty result deliberately exercises the
      // conflict lookup. The last response is a valid same-device conflict.
      if (calls.length < 3) return { rows: [] };
      return { rows: [{ conversation_id: id(160) }] };
    }
  };

  assert.equal(await adapter.findCaptureLink(client, {
    captureId: id(159),
    deviceId: DEVICE_ID
  }), null);
  const linked = await adapter.linkCapture(client, {
    conversationId: id(160),
    captureId: id(159),
    linkMethod: "INITIAL",
    linkedAt: "2026-09-22T12:00:00.000Z"
  });

  assert.equal(linked.conversation_id, id(160));
  assert.equal(calls[0].values[1], DEVICE_ID);
  assert.match(calls[0].text, /conversation\.device_id = \$2/);
  assert.match(calls[0].text, /capture\.device_id = conversation\.device_id/);
  assert.match(calls[1].text, /conversation\.device_id = capture\.device_id/);
  assert.match(calls[2].text, /capture\.device_id = conversation\.device_id/);
});

test("the PostgreSQL predecessor lookup locks and accepts only the exact prior revision", async () => {
  const calls = [];
  const adapter = createPgTinderProductConversationRepository({
    async query() { throw new Error("pool query must not be used directly"); }
  });
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [] };
    }
  };

  const candidates = await adapter.findPredecessorContinuityCandidates(client, {
    deviceId: DEVICE_ID,
    runtimeThreadFingerprint: THREAD_HINT,
    predecessorCaptureFingerprint: "8".repeat(64),
    predecessorCaptureRevision: 12
  });

  assert.deepEqual(candidates, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /predecessor\.capture_revision = \$4/);
  assert.match(calls[0].text, /FOR UPDATE OF predecessor, conversation/);
  assert.deepEqual(calls[0].values, [
    DEVICE_ID,
    THREAD_HINT,
    "8".repeat(64),
    12,
    "tinder-visible-chat-v2",
    "PASSIVE_READ"
  ]);
});
