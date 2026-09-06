import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  TINDER_COLLECTION_WINDOW_MAX_MS,
  TINDER_COLLECTION_WINDOW_MIN_MS,
  TINDER_CONVERSATION_STATE,
  TINDER_INBOUND_BLOCK_REASON,
  TINDER_INBOUND_CLOSED_REASON,
  TINDER_INBOUND_WORK_STATUS,
  TinderInboundQueueError,
  createTinderInboundQueueService
} from "../services/tinder-inbound-queue.js";

const CAPTURE_A = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const CAPTURE_B = "6c7308cf-5d40-423d-913b-c4424f0e4ee0";
const CAPTURE_C = "4d0b6b43-6a5a-4a06-a2d6-d5f2b60b4a2d";
const CAPTURE_OUT = "f3dd4498-1c29-48d2-b953-6c8668dc8fcf";
const WORK_A = "9b2cfc26-586d-4ca8-8b99-b4833d70f7fa";
const WORK_B = "c1d476e1-a5ec-4d65-b0db-c8b029e36cc5";
const EVENT_A = "8e451fcf-397c-4c9b-8f44-b262f4e1ea1f";
const EVENT_B = "8beaeb66-2d4c-43c1-8d86-80ef46445e77";
const EVENT_C = "b25d0091-1e5b-4c6e-b801-78dd57673553";
const DEVICE_A = "e880455d-325c-4f35-9914-823dcb0e0d18";
const THREAD_A = "a".repeat(64);
const THREAD_B = "b".repeat(64);
const NOW = "2026-09-05T20:00:00.000Z";

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function capture({
  captureId = CAPTURE_A,
  deviceId = DEVICE_A,
  contactId = 7,
  thread = THREAD_A,
  fingerprint = "c".repeat(64),
  revision = 2,
  latestRevision = revision,
  identityRevision = 4,
  messages = [{ visible_order: 1, direction: "INCOMING", text: "Hola Marcel" }],
  receivedAt = NOW,
  ...overrides
} = {}) {
  return {
    capture_id: captureId,
    device_id: deviceId,
    resolved_contact_id: contactId,
    capture_safety_status: "SAFE",
    mapping_status: "RESOLVED",
    human_review_status: "CONFIRMED",
    runtime_thread_fingerprint: thread,
    capture_fingerprint: fingerprint,
    capture_revision: revision,
    latest_capture_revision: latestRevision,
    identity_revision: identityRevision,
    visible_messages: messages,
    received_at: receivedAt,
    human_takeover_active: false,
    handoff_active: false,
    auto_reply_enabled: true,
    date_lock_enabled: false,
    manual_review_required: false,
    ...overrides
  };
}

function fixtureRepository({ captures = [capture()] } = {}) {
  const state = {
    captures: new Map(captures.map((item) => [item.capture_id, copy(item)])),
    workItems: [],
    events: [],
    audits: [],
    locks: [],
    methodCalls: []
  };

  function activeWork({ deviceId, runtimeThreadFingerprint }) {
    return state.workItems.find((item) => item.device_id === deviceId &&
      item.runtime_thread_fingerprint === runtimeThreadFingerprint &&
      ["COLLECTING", "ELIGIBLE_FOR_NEXT_STAGE", "BLOCKED"].includes(item.queue_status)) || null;
  }

  function captureForWork(item) {
    const raw = copy(state.captures.get(item.capture_id));
    return {
      ...item,
      capture_resolved_contact_id: raw.resolved_contact_id,
      capture_identity_revision: raw.identity_revision,
      capture_safety_status: raw.capture_safety_status,
      mapping_status: raw.mapping_status,
      human_review_status: raw.human_review_status,
      visible_messages: raw.visible_messages,
      human_takeover_active: raw.human_takeover_active,
      handoff_active: raw.handoff_active,
      received_at: raw.received_at,
      auto_reply_enabled: raw.auto_reply_enabled,
      date_lock_enabled: raw.date_lock_enabled,
      manual_review_required: raw.manual_review_required,
      latest_capture_revision: raw.latest_capture_revision
    };
  }

  const repository = {
    state,
    async withTransaction(work) { return work(repository); },
    async getCaptureWithContactForUpdate(_transaction, captureId) {
      state.methodCalls.push("getCaptureWithContactForUpdate");
      return copy(state.captures.get(captureId) || null);
    },
    async lockThread(_transaction, value) {
      state.locks.push(copy(value));
    },
    async findCaptureFrameEventForUpdate(_transaction, dedupKey) {
      const event = state.events.find((item) => item.dedup_key === dedupKey);
      if (!event) return null;
      return copy(state.workItems.find((item) => item.work_item_id === event.work_item_id));
    },
    async findActiveWorkItemForThreadForUpdate(_transaction, input) {
      return copy(activeWork(input));
    },
    async insertWorkItem(_transaction, record) {
      const row = {
        work_item_id: record.workItemId,
        channel: "tinder",
        device_id: record.capture.deviceId,
        contact_id: record.capture.contactId,
        capture_id: record.capture.captureId,
        capture_fingerprint: record.capture.captureFingerprint,
        runtime_thread_fingerprint: record.capture.runtimeThreadFingerprint,
        capture_revision: record.capture.captureRevision,
        identity_revision: record.capture.identityRevision,
        latest_inbound_message_fingerprint: record.terminal.messageFingerprint,
        conversation_state: record.conversationState,
        queue_status: record.queueStatus,
        block_reason: record.blockReason,
        closed_reason: null,
        collection_window_ms: record.collectionWindowMs,
        collection_started_at: record.collectionStartedAt,
        eligible_at: record.eligibleAt,
        last_verified_inbound_at: record.capture.receivedAt
      };
      state.workItems.push(row);
      return copy(row);
    },
    async resetWorkItemForInbound(_transaction, workItemId, record) {
      const row = state.workItems.find((item) => item.work_item_id === workItemId);
      Object.assign(row, {
        contact_id: record.capture.contactId,
        capture_id: record.capture.captureId,
        capture_fingerprint: record.capture.captureFingerprint,
        capture_revision: record.capture.captureRevision,
        identity_revision: record.capture.identityRevision,
        latest_inbound_message_fingerprint: record.terminal.messageFingerprint,
        conversation_state: record.conversationState,
        queue_status: record.queueStatus,
        block_reason: record.blockReason,
        closed_reason: null,
        collection_window_ms: record.collectionWindowMs,
        collection_started_at: record.collectionStartedAt,
        eligible_at: record.eligibleAt,
        last_verified_inbound_at: record.capture.receivedAt
      });
      return copy(row);
    },
    async refreshWorkItemWithoutWindowReset(_transaction, workItemId, record) {
      const row = state.workItems.find((item) => item.work_item_id === workItemId);
      Object.assign(row, {
        capture_id: record.capture.captureId,
        capture_fingerprint: record.capture.captureFingerprint,
        capture_revision: record.capture.captureRevision,
        identity_revision: record.capture.identityRevision
      });
      if (record.queueStatus === "BLOCKED") {
        row.queue_status = "BLOCKED";
        row.conversation_state = record.conversationState;
        row.block_reason = record.blockReason;
      }
      return copy(row);
    },
    async closeWorkItem(_transaction, workItemId, patch) {
      const row = state.workItems.find((item) => item.work_item_id === workItemId);
      row.queue_status = "CLOSED";
      row.conversation_state = patch.conversationState;
      row.closed_reason = patch.reason;
      row.block_reason = null;
      if (patch.capture) {
        row.capture_id = patch.capture.captureId;
        row.capture_fingerprint = patch.capture.captureFingerprint;
        row.capture_revision = patch.capture.captureRevision;
        row.identity_revision = patch.capture.identityRevision;
      }
      return copy(row);
    },
    async insertCaptureFrameEvent(_transaction, event) {
      const row = {
        event_id: event.eventId,
        work_item_id: event.workItemId,
        capture_id: event.capture.captureId,
        dedup_key: event.terminal.captureFrameDedupKey
      };
      if (state.events.some((item) => item.dedup_key === row.dedup_key)) return null;
      state.events.push(row);
      return copy(row);
    },
    async insertAudit(_transaction, entry) {
      state.audits.push(copy(entry));
    },
    async findDueWorkItemsForUpdate(_transaction, asOf) {
      return state.workItems
        .filter((item) => item.queue_status === "COLLECTING" && item.eligible_at <= asOf)
        .map(captureForWork);
    },
    async markWorkItemEligible(_transaction, workItemId) {
      const row = state.workItems.find((item) => item.work_item_id === workItemId);
      row.queue_status = "ELIGIBLE_FOR_NEXT_STAGE";
      row.block_reason = null;
      return copy(row);
    },
    async markWorkItemBlocked(_transaction, workItemId, patch) {
      const row = state.workItems.find((item) => item.work_item_id === workItemId);
      row.queue_status = "BLOCKED";
      row.conversation_state = patch.conversationState;
      row.block_reason = patch.reason;
      return copy(row);
    }
  };
  return repository;
}

function fixtureService({ repository = fixtureRepository(), windows = [180000, 240000], clock = NOW } = {}) {
  let index = 0;
  const workIds = [WORK_A, WORK_B];
  const eventIds = [EVENT_A, EVENT_B, EVENT_C];
  return {
    repository,
    service: createTinderInboundQueueService({
      repository,
      now: () => new Date(clock),
      createWorkItemId: () => workIds.shift() || "fa0e4f6a-a23e-4d49-8c43-0c7cd7fc075b",
      createEventId: () => eventIds.shift() || "d025b5db-3953-44dd-aee1-cd36dba1290a",
      drawCollectionWindowMs: () => windows[index++]
    })
  };
}

test("T6 accepts only a server-owned capture ID and creates one confirmed inbound work item", async () => {
  const { service, repository } = fixtureService();
  await assert.rejects(
    () => service.recordVerifiedCapture({ captureId: CAPTURE_A, contactId: 99 }),
    (error) => error instanceof TinderInboundQueueError && error.code === "INVALID_T6_QUEUE_INPUT"
  );

  const result = await service.recordVerifiedCapture({ captureId: CAPTURE_A });
  assert.equal(result.contactId, 7);
  assert.equal(result.conversationState, TINDER_CONVERSATION_STATE.WAITING_FOR_US);
  assert.equal(result.queueStatus, TINDER_INBOUND_WORK_STATUS.COLLECTING);
  assert.equal(result.collectionWindowMs, TINDER_COLLECTION_WINDOW_MIN_MS);
  assert.equal(result.eligibleAt, "2026-09-05T20:03:00.000Z");
  assert.equal(repository.state.workItems.length, 1);
  assert.equal(repository.state.events.length, 1);
  assert.deepEqual(repository.state.locks, [{ deviceId: DEVICE_A, runtimeThreadFingerprint: THREAD_A }]);
});

test("T6 rejects unsafe, unresolved, stale, and terminal-unknown captures without queueing message truth", async () => {
  const cases = [
    ["CAPTURE_NOT_SAFE", { capture_safety_status: "UNSAFE" }],
    ["IDENTITY_NOT_CONFIRMED", { mapping_status: "NEEDS_HUMAN_MAPPING" }],
    ["IDENTITY_NOT_CONFIRMED", { human_review_status: "PENDING" }],
    ["CAPTURE_REVISION_STALE", { latest_capture_revision: 3 }],
    ["TERMINAL_DIRECTION_UNKNOWN", { visible_messages: [{ visible_order: 1, direction: "UNKNOWN", text: "Unclear" }] }]
  ];
  for (const [code, overrides] of cases) {
    const repository = fixtureRepository({ captures: [capture(overrides)] });
    const { service } = fixtureService({ repository });
    await assert.rejects(
      () => service.recordVerifiedCapture({ captureId: CAPTURE_A }),
      (error) => error instanceof TinderInboundQueueError && error.code === code,
      code
    );
    assert.equal(repository.state.workItems.length, 0, code);
    assert.equal(repository.state.events.length, 0, code);
  }
});

test("a duplicate capture frame and a semantically identical retry never redraw a collection window", async () => {
  const identicalRetry = capture({
    captureId: CAPTURE_B,
    fingerprint: "d".repeat(64),
    revision: 3,
    latestRevision: 3
  });
  const repository = fixtureRepository({ captures: [capture(), identicalRetry] });
  const { service } = fixtureService({ repository, windows: [180000, 240000] });
  const first = await service.recordVerifiedCapture({ captureId: CAPTURE_A });
  const duplicate = await service.recordVerifiedCapture({ captureId: CAPTURE_A });
  const retry = await service.recordVerifiedCapture({ captureId: CAPTURE_B });

  assert.equal(first.idempotent, false);
  assert.equal(duplicate.idempotent, true);
  assert.equal(retry.idempotent, true);
  assert.equal(repository.state.workItems.length, 1);
  assert.equal(repository.state.events.length, 2, "one persisted frame event per distinct verified capture frame");
  assert.equal(repository.state.workItems[0].collection_window_ms, 180000);
  assert.equal(repository.state.workItems[0].eligible_at, "2026-09-05T20:03:00.000Z");
});

test("a new service instance preserves the persisted deadline and performs no startup/history scan", async () => {
  const repository = fixtureRepository();
  const { service } = fixtureService({ repository });
  await service.recordVerifiedCapture({ captureId: CAPTURE_A });
  const callsBeforeRestart = repository.state.methodCalls.length;
  const restarted = createTinderInboundQueueService({
    repository,
    now: () => new Date("2026-09-05T20:02:00.000Z"),
    drawCollectionWindowMs: () => 240000
  });
  assert.equal(repository.state.methodCalls.length, callsBeforeRestart, "construction performs no DB scan");
  const repeat = await restarted.recordVerifiedCapture({ captureId: CAPTURE_A });
  assert.equal(repeat.idempotent, true);
  assert.equal(repository.state.workItems.length, 1);
  assert.equal(repository.state.workItems[0].eligible_at, "2026-09-05T20:03:00.000Z");
});

test("a new inbound in the same thread discards the old timer and draws a fresh full 3–4 minute window", async () => {
  const second = capture({
    captureId: CAPTURE_B,
    fingerprint: "d".repeat(64),
    revision: 3,
    latestRevision: 3,
    messages: [
      { visible_order: 1, direction: "INCOMING", text: "Hola Marcel" },
      { visible_order: 2, direction: "INCOMING", text: "¿Sigues ahí?" }
    ]
  });
  const repository = fixtureRepository({ captures: [capture(), second] });
  const { service } = fixtureService({ repository, windows: [180000, 240000] });
  await service.recordVerifiedCapture({ captureId: CAPTURE_A });
  const reset = await service.recordVerifiedCapture({ captureId: CAPTURE_B });

  assert.equal(reset.idempotent, false);
  assert.equal(repository.state.workItems.length, 1);
  assert.equal(reset.captureId, CAPTURE_B);
  assert.equal(reset.collectionWindowMs, TINDER_COLLECTION_WINDOW_MAX_MS);
  assert.equal(reset.eligibleAt, "2026-09-05T20:04:00.000Z");
  assert.equal(repository.state.audits.at(-1).action, "COLLECTION_WINDOW_RESET");
});

test("different contacts and threads retain isolated work items", async () => {
  const other = capture({
    captureId: CAPTURE_C,
    contactId: 8,
    thread: THREAD_B,
    fingerprint: "e".repeat(64),
    revision: 1,
    identityRevision: 1,
    messages: [{ visible_order: 1, direction: "INCOMING", text: "Hey" }]
  });
  const repository = fixtureRepository({ captures: [capture(), other] });
  const { service } = fixtureService({ repository });
  await service.recordVerifiedCapture({ captureId: CAPTURE_A });
  await service.recordVerifiedCapture({ captureId: CAPTURE_C });

  assert.equal(repository.state.workItems.length, 2);
  assert.deepEqual(repository.state.workItems.map((item) => item.contact_id).sort(), [7, 8]);
});

test("the exact 3:00 and 4:00 minute limits are accepted while unsafe window values fail closed", async () => {
  for (const milliseconds of [TINDER_COLLECTION_WINDOW_MIN_MS, TINDER_COLLECTION_WINDOW_MAX_MS]) {
    const { service, repository } = fixtureService({ windows: [milliseconds] });
    const result = await service.recordVerifiedCapture({ captureId: CAPTURE_A });
    assert.equal(result.collectionWindowMs, milliseconds);
    assert.equal(repository.state.workItems.length, 1);
  }
  const { service, repository } = fixtureService({ windows: [TINDER_COLLECTION_WINDOW_MIN_MS - 1] });
  await assert.rejects(
    () => service.recordVerifiedCapture({ captureId: CAPTURE_A }),
    (error) => error instanceof TinderInboundQueueError && error.code === "INVALID_COLLECTION_WINDOW"
  );
  assert.equal(repository.state.workItems.length, 0);
});

test("only an explicit future-worker call advances a quiet window to eligibility and it never drafts or sends", async () => {
  const repository = fixtureRepository();
  const { service } = fixtureService({ repository, clock: NOW });
  await service.recordVerifiedCapture({ captureId: CAPTURE_A });
  assert.deepEqual(await service.advanceDueCollectionWindows(), []);
  assert.equal(repository.state.workItems[0].queue_status, "COLLECTING");

  const dueService = createTinderInboundQueueService({
    repository,
    now: () => new Date("2026-09-05T20:03:00.000Z"),
    drawCollectionWindowMs: () => 180000
  });
  const outcomes = await dueService.advanceDueCollectionWindows();
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].queueStatus, "ELIGIBLE_FOR_NEXT_STAGE");
  assert.equal(repository.state.methodCalls.includes("createDraft"), false);
  assert.equal(Object.hasOwn(repository.state, "commands"), false);
});

test("locks remain visible but blocked and a lock introduced during collection blocks the due transition", async () => {
  const lockCases = [
    [TINDER_INBOUND_BLOCK_REASON.HUMAN_TAKEOVER_ACTIVE, { human_takeover_active: true }],
    [TINDER_INBOUND_BLOCK_REASON.HANDOFF_ACTIVE, { handoff_active: true }],
    [TINDER_INBOUND_BLOCK_REASON.AUTO_REPLY_DISABLED, { auto_reply_enabled: false }],
    [TINDER_INBOUND_BLOCK_REASON.DATE_LOCK_ACTIVE, { date_lock_enabled: true }],
    [TINDER_INBOUND_BLOCK_REASON.MANUAL_REVIEW_REQUIRED, { manual_review_required: true }]
  ];
  for (const [reason, overrides] of lockCases) {
    const repository = fixtureRepository({ captures: [capture(overrides)] });
    const { service } = fixtureService({ repository });
    const result = await service.recordVerifiedCapture({ captureId: CAPTURE_A });
    assert.equal(result.queueStatus, "BLOCKED", reason);
    assert.equal(result.blockReason, reason);
  }

  const repository = fixtureRepository();
  const { service } = fixtureService({ repository });
  await service.recordVerifiedCapture({ captureId: CAPTURE_A });
  repository.state.captures.get(CAPTURE_A).date_lock_enabled = true;
  const dueService = createTinderInboundQueueService({ repository, now: () => new Date("2026-09-05T20:03:00.000Z") });
  const [blocked] = await dueService.advanceDueCollectionWindows();
  assert.equal(blocked.queueStatus, "BLOCKED");
  assert.equal(blocked.blockReason, "DATE_LOCK_ACTIVE");
});

test("a newer capture or changed confirmed identity discovered at due time blocks context refresh instead of becoming eligible", async () => {
  const repository = fixtureRepository();
  const { service } = fixtureService({ repository });
  await service.recordVerifiedCapture({ captureId: CAPTURE_A });
  repository.state.captures.get(CAPTURE_A).latest_capture_revision = 3;
  const staleService = createTinderInboundQueueService({ repository, now: () => new Date("2026-09-05T20:03:00.000Z") });
  const [stale] = await staleService.advanceDueCollectionWindows();
  assert.equal(stale.queueStatus, "BLOCKED");
  assert.equal(stale.blockReason, "CONTEXT_REFRESH_REQUIRED");

  const freshRepository = fixtureRepository();
  const { service: freshService } = fixtureService({ repository: freshRepository });
  await freshService.recordVerifiedCapture({ captureId: CAPTURE_A });
  const current = freshRepository.state.captures.get(CAPTURE_A);
  current.resolved_contact_id = 8;
  current.identity_revision = 5;
  const remapService = createTinderInboundQueueService({ repository: freshRepository, now: () => new Date("2026-09-05T20:03:00.000Z") });
  const [remapped] = await remapService.advanceDueCollectionWindows();
  assert.equal(remapped.queueStatus, "BLOCKED");
  assert.equal(remapped.blockReason, "CONTEXT_REFRESH_REQUIRED");
});

test("a verified terminal outgoing closes the open work item as WAITING_FOR_HER and a later inbound opens a fresh cycle", async () => {
  const outbound = capture({
    captureId: CAPTURE_OUT,
    fingerprint: "f".repeat(64),
    revision: 3,
    latestRevision: 3,
    messages: [
      { visible_order: 1, direction: "INCOMING", text: "Hola Marcel" },
      { visible_order: 2, direction: "OUTGOING", text: "Hola, Sandry" }
    ]
  });
  const laterInbound = capture({
    captureId: CAPTURE_B,
    fingerprint: "d".repeat(64),
    revision: 4,
    latestRevision: 4,
    messages: [
      { visible_order: 1, direction: "INCOMING", text: "Hola Marcel" },
      { visible_order: 2, direction: "OUTGOING", text: "Hola, Sandry" },
      { visible_order: 3, direction: "INCOMING", text: "Qué bien" }
    ]
  });
  const repository = fixtureRepository({ captures: [capture(), outbound, laterInbound] });
  const { service } = fixtureService({ repository });
  await service.recordVerifiedCapture({ captureId: CAPTURE_A });
  const closed = await service.recordVerifiedCapture({ captureId: CAPTURE_OUT });
  assert.equal(closed.queueStatus, "CLOSED");
  assert.equal(closed.conversationState, "WAITING_FOR_HER");
  assert.equal(closed.closedReason, TINDER_INBOUND_CLOSED_REASON.VERIFIED_OUTBOUND);

  const reopened = await service.recordVerifiedCapture({ captureId: CAPTURE_B });
  assert.equal(reopened.conversationState, "WAITING_FOR_US");
  assert.equal(reopened.queueStatus, "COLLECTING");
  assert.equal(repository.state.workItems.length, 2);
});

test("a changed confirmed identity closes the old item rather than silently rebinding it", async () => {
  const remapped = capture({
    captureId: CAPTURE_B,
    contactId: 8,
    fingerprint: "d".repeat(64),
    revision: 3,
    latestRevision: 3,
    identityRevision: 5,
    messages: [{ visible_order: 1, direction: "INCOMING", text: "Neue Zuordnung" }]
  });
  const repository = fixtureRepository({ captures: [capture(), remapped] });
  const { service } = fixtureService({ repository });
  await service.recordVerifiedCapture({ captureId: CAPTURE_A });
  const replacement = await service.recordVerifiedCapture({ captureId: CAPTURE_B });
  assert.equal(repository.state.workItems.length, 2);
  assert.equal(repository.state.workItems[0].queue_status, "CLOSED");
  assert.equal(repository.state.workItems[0].conversation_state, "DORMANT");
  assert.equal(repository.state.workItems[0].closed_reason, "IDENTITY_CHANGED");
  assert.equal(replacement.contactId, 8);
});

test("T6 has no startup scanner, Android/UI listener, draft generation, command, or network path", () => {
  const source = readFileSync(new URL("../services/tinder-inbound-queue.js", import.meta.url), "utf8");
  const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\(|playwright|chromium|accessibility|notification listener|sendMessage|sendTinder|generateSharedReply|createDraft|device_bridge_commands/i);
  assert.doesNotMatch(index, /20260905_tinder_inbound_queue_foundation\.sql/);
  assert.doesNotMatch(index, /createTinderInboundQueueService/);
});
