import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  FUTURE_T5_DEVICE_CAPABILITIES,
  TINDER_APPROVAL_STATE,
  TINDER_SEND_COMMAND_TYPE,
  TINDER_SEND_INTENT_STATE,
  TinderManualSendError,
  assertFutureTinderSendPayload,
  createTinderManualSendService,
  createPgTinderManualSendRepository,
  sha256Text
} from "../services/tinder-manual-send.js";
import { DEVICE_BRIDGE_COMMANDS, T1_DEVICE_CAPABILITIES } from "../device-bridge/protocol-v1.js";

const DRAFT_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const CAPTURE_ID = "6c7308cf-5d40-423d-913b-c4424f0e4ee0";
const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const APPROVAL_ID = "4d0b6b43-6a5a-4a06-a2d6-d5f2b60b4a2d";
const INTENT_ID = "f3dd4498-1c29-48d2-b953-6c8668dc8fcf";
const COMMAND_ID = "9b2cfc26-586d-4ca8-8b99-b4833d70f7fa";
const THREAD_A = "a".repeat(64);
const THREAD_B = "b".repeat(64);
const CAPTURE_HASH_A = "c".repeat(64);
const CAPTURE_HASH_B = "d".repeat(64);
const NOW = "2026-09-05T19:00:00.000Z";

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function readySnapshot(overrides = {}) {
  return {
    draft_id: DRAFT_ID,
    draft_status: "DRAFT",
    draft_revision: 1,
    contact_id: 7,
    capture_id: CAPTURE_ID,
    capture_revision: 3,
    latest_capture_revision: 3,
    capture_fingerprint: CAPTURE_HASH_A,
    runtime_thread_fingerprint: THREAD_A,
    draft_identity_revision: 4,
    current_identity_revision: 4,
    original_draft: "Das klingt schön. Ich freue mich darauf.",
    capture_safety_status: "SAFE",
    mapping_status: "RESOLVED",
    human_review_status: "CONFIRMED",
    resolved_contact_id: 7,
    device_id: DEVICE_ID,
    device_enrollment_state: "ACTIVE",
    bridge_service_state: "RUNNING",
    tinder_state: "CONNECTED",
    automation_state: "STOPPED",
    device_capabilities: [...FUTURE_T5_DEVICE_CAPABILITIES],
    last_accepted_heartbeat_at: "2026-09-05T18:59:30.000Z",
    human_takeover_active: false,
    handoff_active: false,
    ...overrides
  };
}

function readyDraftReview(overrides = {}) {
  return {
    draft_id: DRAFT_ID,
    capture_id: CAPTURE_ID,
    draft_revision: 1,
    capture_revision: 3,
    draft_identity_revision: 4,
    draft_status: "DRAFT",
    approval_state: null,
    intent_state: null,
    original_draft: "Das klingt schön. Ich freue mich darauf.",
    control_draft_de: "Das klingt schön. Ich freue mich darauf.",
    source_language: "de",
    model_version: "shared-reply-core-v1",
    created_at: NOW,
    ...overrides
  };
}

function fixtureRepository({ snapshot = readySnapshot(), review = readyDraftReview(), approvals = [], intents = [] } = {}) {
  const state = {
    snapshot: copy(snapshot),
    review: copy(review),
    approvals: copy(approvals),
    intents: copy(intents),
    audits: [],
    operations: []
  };
  const repository = {
    state,
    async withTransaction(work) { return work(repository); },
    async lockDraftSnapshot(_transaction, draftId) {
      return draftId === state.snapshot.draft_id ? copy(state.snapshot) : null;
    },
    async findCurrentDraftReviewByCapture(captureId) {
      return captureId === state.snapshot.capture_id ? copy(state.review) : null;
    },
    async findApprovalForDraftRevision(_transaction, draftId, revision) {
      return copy(state.approvals.find(item => item.draft_id === draftId && Number(item.draft_revision) === Number(revision)) || null);
    },
    async findActiveApprovalForDraft(_transaction, draftId) {
      const items = state.approvals
        .filter(item => item.draft_id === draftId && item.state === "ACTIVE")
        .sort((left, right) => String(right.approved_at).localeCompare(String(left.approved_at)));
      return copy(items[0] || null);
    },
    async insertApproval(_transaction, approval) {
      const row = {
        approval_id: approval.approvalId,
        draft_id: approval.draftId,
        draft_revision: approval.draftRevision,
        contact_id: approval.contactId,
        capture_id: approval.captureId,
        capture_fingerprint: approval.captureFingerprint,
        thread_ref_kind: approval.threadRefKind,
        runtime_thread_fingerprint: approval.runtimeThreadFingerprint,
        capture_revision: approval.captureRevision,
        identity_revision: approval.identityRevision,
        approved_text_sha256: approval.approvedTextSha256,
        approval_binding_sha256: approval.approvalBindingSha256,
        approved_by: approval.approvedBy,
        approved_at: approval.approvedAt,
        state: approval.state
      };
      state.operations.push("insertApproval");
      state.approvals.push(row);
      return copy(row);
    },
    async updateDraftStatus(_transaction, draftId, status, staleReason) {
      assert.equal(draftId, state.snapshot.draft_id);
      state.operations.push(`draft:${status}`);
      state.snapshot.draft_status = status;
      state.snapshot.stale_reason = staleReason;
      return copy(state.snapshot);
    },
    async invalidateApproval(_transaction, approvalId, patch) {
      const approval = state.approvals.find(item => item.approval_id === approvalId);
      assert.ok(approval, "approval must exist before invalidation");
      approval.state = patch.state;
      approval.invalidated_reason = patch.reasonCode;
      approval.invalidated_at = patch.changedAt;
      state.operations.push(`approval:${patch.state}`);
      return copy(approval);
    },
    async findIntentForApproval(_transaction, approvalId) {
      return copy(state.intents.find(item => item.approval_id === approvalId) || null);
    },
    async insertIntent(_transaction, intent) {
      const row = {
        intent_id: intent.intentId,
        approval_id: intent.approvalId,
        draft_id: intent.draftId,
        draft_revision: intent.draftRevision,
        contact_id: intent.contactId,
        capture_id: intent.captureId,
        capture_fingerprint: intent.captureFingerprint,
        thread_ref_kind: intent.threadRefKind,
        runtime_thread_fingerprint: intent.runtimeThreadFingerprint,
        identity_revision: intent.identityRevision,
        command_id: intent.commandId,
        command_type: intent.commandType,
        protocol_version: intent.protocolVersion,
        approved_text_sha256: intent.approvedTextSha256,
        approval_binding_sha256: intent.approvalBindingSha256,
        delivery_policy_revision: intent.deliveryPolicyRevision,
        not_before: intent.notBefore,
        expires_at: intent.expiresAt,
        typing_duration_ms: intent.typingDurationMs,
        state: intent.state,
        received_at: intent.receivedAt,
        completed_at: intent.completedAt,
        result_code: intent.resultCode,
        created_at: intent.createdAt
      };
      state.operations.push("insertIntent");
      state.intents.push(row);
      return copy(row);
    },
    async updateIntent(_transaction, intentId, patch) {
      const intent = state.intents.find(item => item.intent_id === intentId);
      assert.ok(intent, "intent must exist before update");
      if (Object.hasOwn(patch, "state")) intent.state = patch.state;
      if (Object.hasOwn(patch, "receivedAt")) intent.received_at = patch.receivedAt;
      if (Object.hasOwn(patch, "completedAt")) intent.completed_at = patch.completedAt;
      if (Object.hasOwn(patch, "resultCode")) intent.result_code = patch.resultCode;
      state.operations.push(`intent:${intent.state}`);
      return copy(intent);
    },
    async findIntentByCommand(_transaction, commandId) {
      return copy(state.intents.find(item => item.command_id === commandId) || null);
    },
    async insertAudit(_transaction, entry) {
      state.audits.push(copy(entry));
      return copy(entry);
    }
  };
  return repository;
}

function fixtureService({ repository = fixtureRepository(), deliveryPolicy, ids = {} } = {}) {
  const service = createTinderManualSendService({
    repository,
    now: () => new Date(NOW),
    createApprovalId: () => ids.approvalId || APPROVAL_ID,
    createIntentId: () => ids.intentId || INTENT_ID,
    createCommandId: () => ids.commandId || COMMAND_ID,
    deliveryPolicy: deliveryPolicy || (async () => ({
      revision: "delivery-policy-v1",
      notBefore: "2026-09-05T19:00:00.000Z",
      expiresAt: "2026-09-05T19:10:00.000Z",
      typingDurationMs: 1250
    }))
  });
  return { service, repository };
}

async function approveAndReserve(options = {}) {
  const fixture = fixtureService(options);
  await fixture.service.approveDraft({ draftId: DRAFT_ID });
  const intent = await fixture.service.reserveApprovedSend({ draftId: DRAFT_ID });
  return { ...fixture, intent };
}

test("T5 keeps an unapproved T4 draft fail-closed and creates no future command intent", async () => {
  const { service, repository } = fixtureService();
  await assert.rejects(
    () => service.reserveApprovedSend({ draftId: DRAFT_ID }),
    (error) => error instanceof TinderManualSendError && error.code === "DRAFT_NOT_APPROVED"
  );
  assert.equal(repository.state.approvals.length, 0);
  assert.equal(repository.state.intents.length, 0);
});

test("an explicit server-bound approval reserves exactly one sealed future SEND_TINDER_DRAFT intent", async () => {
  const { service, repository } = fixtureService();
  const approval = await service.approveDraft({ draftId: DRAFT_ID });
  const intent = await service.reserveApprovedSend({ draftId: DRAFT_ID });

  assert.deepEqual(approval, {
    approvalId: APPROVAL_ID,
    draftId: DRAFT_ID,
    draftRevision: 1,
    state: "ACTIVE",
    approvedAt: NOW,
    idempotent: false
  });
  assert.equal(intent.intentId, INTENT_ID);
  assert.equal(intent.commandId, COMMAND_ID);
  assert.equal(intent.state, "PENDING_T5_WRITER");
  assert.equal(intent.idempotent, false);
  assert.equal(repository.state.approvals.length, 1);
  assert.equal(repository.state.intents.length, 1);
  assert.equal(repository.state.intents[0].command_type, TINDER_SEND_COMMAND_TYPE);
  assert.equal(repository.state.operations.includes("insertIntent"), true);
  assert.equal(Object.hasOwn(repository.state, "deviceBridgeCommands"), false);
});

test("approval and reservation double-clicks are idempotent and never make another intent", async () => {
  const { service, repository } = fixtureService();
  const firstApproval = await service.approveDraft({ draftId: DRAFT_ID });
  const secondApproval = await service.approveDraft({ draftId: DRAFT_ID });
  assert.equal(firstApproval.idempotent, false);
  assert.equal(secondApproval.idempotent, true);

  const firstIntent = await service.reserveApprovedSend({ draftId: DRAFT_ID });
  const secondIntent = await service.reserveApprovedSend({ draftId: DRAFT_ID });
  assert.equal(firstIntent.idempotent, false);
  assert.equal(secondIntent.idempotent, true);
  assert.equal(secondIntent.intentId, firstIntent.intentId);
  assert.equal(repository.state.approvals.length, 1);
  assert.equal(repository.state.intents.length, 1);
});

test("changed text invalidates an approval and blocks a future command reservation", async () => {
  const { service, repository } = fixtureService();
  await service.approveDraft({ draftId: DRAFT_ID });
  repository.state.snapshot.original_draft = "Ein später veränderter Text.";
  await assert.rejects(
    () => service.reserveApprovedSend({ draftId: DRAFT_ID }),
    (error) => error instanceof TinderManualSendError && error.code === "APPROVAL_BINDING_CHANGED"
  );
  assert.equal(repository.state.approvals[0].state, TINDER_APPROVAL_STATE.INVALIDATED);
  assert.equal(repository.state.intents.length, 0);
});

test("a changed revision invalidates the old approval and cannot reuse it", async () => {
  const { service, repository } = fixtureService();
  await service.approveDraft({ draftId: DRAFT_ID });
  repository.state.snapshot.draft_revision = 2;
  repository.state.snapshot.draft_status = "DRAFT";
  repository.state.snapshot.original_draft = "Neu formulierte Draft-Revision.";
  await assert.rejects(
    () => service.reserveApprovedSend({ draftId: DRAFT_ID }),
    (error) => error instanceof TinderManualSendError && error.code === "DRAFT_NOT_APPROVED"
  );
  assert.equal(repository.state.approvals[0].state, TINDER_APPROVAL_STATE.INVALIDATED);
  assert.equal(repository.state.approvals[0].invalidated_reason, "DRAFT_REVISION_CHANGED");
  assert.equal(repository.state.intents.length, 0);
});

test("a durable T5 review returns only the bounded current draft projection", async () => {
  const repository = fixtureRepository({
    review: readyDraftReview({
      contact_id: 7,
      device_id: DEVICE_ID,
      runtime_thread_fingerprint: THREAD_A,
      capture_fingerprint: CAPTURE_HASH_A,
      approval_id: APPROVAL_ID,
      intent_id: INTENT_ID,
      payload: { approved_text: "must not leave service" }
    })
  });
  const { service } = fixtureService({ repository });
  const review = await service.getDraftReviewForCapture({ captureId: CAPTURE_ID });
  assert.deepEqual(review, {
    draftId: DRAFT_ID,
    captureId: CAPTURE_ID,
    draftRevision: 1,
    captureRevision: 3,
    identityRevision: 4,
    status: "DRAFT",
    approvalState: null,
    intentState: null,
    originalDraft: "Das klingt schön. Ich freue mich darauf.",
    controlDraftDe: "Das klingt schön. Ich freue mich darauf.",
    sourceLanguage: "de",
    modelVersion: "shared-reply-core-v1",
    createdAt: NOW
  });
  assert.equal(JSON.stringify(review).includes(THREAD_A), false);
  assert.equal(JSON.stringify(review).includes(CAPTURE_HASH_A), false);
  assert.equal(JSON.stringify(review).includes(APPROVAL_ID), false);
  assert.equal(JSON.stringify(review).includes(INTENT_ID), false);
  assert.equal(JSON.stringify(review).includes("must not leave service"), false);
});

test("a durable T5 review preserves terminal approval state but never makes a send decision", async () => {
  const repository = fixtureRepository({
    review: readyDraftReview({ draft_status: "APPROVED", approval_state: "CANCELLED", intent_state: null })
  });
  const { service } = fixtureService({ repository });
  const review = await service.getDraftReviewForCapture({ captureId: CAPTURE_ID });
  assert.equal(review.status, "APPROVED");
  assert.equal(review.approvalState, "CANCELLED");
  assert.equal(review.intentState, null);
  assert.equal(repository.state.operations.length, 0);
  assert.equal(repository.state.approvals.length, 0);
  assert.equal(repository.state.intents.length, 0);
});

test("a missing or stale current draft review fails closed without creating a draft", async () => {
  const repository = fixtureRepository({ review: null });
  const { service } = fixtureService({ repository });
  await assert.rejects(
    () => service.getDraftReviewForCapture({ captureId: CAPTURE_ID }),
    (error) => error instanceof TinderManualSendError && error.code === "DRAFT_REVIEW_NOT_FOUND"
  );
  assert.equal(repository.state.operations.length, 0);
  assert.equal(repository.state.approvals.length, 0);
  assert.equal(repository.state.intents.length, 0);
});

test("a changed current capture identity revision blocks a fresh approval before any T5 write", async () => {
  const repository = fixtureRepository({
    snapshot: readySnapshot({ current_identity_revision: 5 })
  });
  const { service } = fixtureService({ repository });
  await assert.rejects(
    () => service.approveDraft({ draftId: DRAFT_ID }),
    (error) => error instanceof TinderManualSendError && error.code === "IDENTITY_REVISION_CHANGED"
  );
  assert.equal(repository.state.approvals.length, 0);
  assert.equal(repository.state.intents.length, 0);
  assert.deepEqual(repository.state.operations, []);
});

test("a changed current identity revision atomically invalidates an existing approval", async () => {
  const { service, repository } = fixtureService();
  await service.approveDraft({ draftId: DRAFT_ID });
  repository.state.snapshot.current_identity_revision = 5;

  await assert.rejects(
    () => service.approveDraft({ draftId: DRAFT_ID }),
    (error) => error instanceof TinderManualSendError && error.code === "IDENTITY_REVISION_CHANGED"
  );

  assert.equal(repository.state.approvals[0].state, TINDER_APPROVAL_STATE.INVALIDATED);
  assert.equal(repository.state.approvals[0].invalidated_reason, "IDENTITY_REVISION_CHANGED");
  assert.equal(repository.state.intents.length, 0);
  assert.equal(repository.state.audits.at(-1).action, "APPROVAL_INVALIDATED");
  assert.equal(repository.state.audits.at(-1).reasonCode, "IDENTITY_REVISION_CHANGED");
});

test("changed thread, capture fingerprint, contact, capture revision, identity, or stale source fail closed", async () => {
  const cases = [
    ["APPROVAL_BINDING_CHANGED", { runtime_thread_fingerprint: THREAD_B }],
    ["APPROVAL_BINDING_CHANGED", { capture_fingerprint: CAPTURE_HASH_B }],
    ["IDENTITY_NOT_CONFIRMED", { resolved_contact_id: 8 }],
    ["NEWER_CAPTURE_REVISION", { latest_capture_revision: 4 }],
    ["IDENTITY_REVISION_CHANGED", { current_identity_revision: 5 }],
    ["CAPTURE_NOT_SAFE", { capture_safety_status: "UNSAFE" }],
    ["IDENTITY_NOT_CONFIRMED", { mapping_status: "CONFLICT" }],
    ["HUMAN_TAKEOVER_ACTIVE", { human_takeover_active: true }],
    ["HANDOFF_ACTIVE", { handoff_active: true }]
  ];
  for (const [code, overrides] of cases) {
    const repository = fixtureRepository();
    const { service } = fixtureService({ repository });
    await service.approveDraft({ draftId: DRAFT_ID });
    Object.assign(repository.state.snapshot, overrides);
    await assert.rejects(
      () => service.reserveApprovedSend({ draftId: DRAFT_ID }),
      (error) => error instanceof TinderManualSendError && error.code === code,
      code
    );
    assert.equal(repository.state.intents.length, 0, code);
  }
});

test("the production T5 snapshot query projects draft and current capture identity revisions separately", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(String(sql));
      return { rows: /FOR UPDATE OF draft, capture, device/.test(String(sql)) ? [readySnapshot()] : [] };
    },
    release() {}
  };
  const repository = createPgTinderManualSendRepository({
    async query(sql) {
      queries.push(String(sql));
      return { rows: [] };
    },
    async connect() { return client; }
  });
  await repository.withTransaction(async (transaction) => repository.lockDraftSnapshot(transaction, DRAFT_ID));
  const snapshotQuery = queries.find((sql) => /FROM tinder_reply_drafts draft/.test(sql));
  assert.ok(snapshotQuery);
  assert.match(snapshotQuery, /draft\.identity_revision\s+AS\s+draft_identity_revision/i);
  assert.match(snapshotQuery, /capture\.identity_revision\s+AS\s+current_identity_revision/i);
  await repository.findCurrentDraftReviewByCapture(CAPTURE_ID);
  const reviewQuery = queries.find((sql) => /LEFT JOIN LATERAL/.test(sql));
  assert.ok(reviewQuery);
  assert.match(reviewQuery, /ELSE 'STALE'/);
  assert.match(reviewQuery, /draft\.status = 'APPROVED' AND approval\.state = 'ACTIVE'/);
});

test("all runtime gate blockers deny reservation before an intent is inserted", async () => {
  const cases = [
    ["DEVICE_OFFLINE", { last_accepted_heartbeat_at: "2026-09-05T18:57:00.000Z" }],
    ["DEVICE_ENROLLMENT_INACTIVE", { device_enrollment_state: "PENDING" }],
    ["T5_WRITER_UNAVAILABLE", { device_capabilities: [...T1_DEVICE_CAPABILITIES] }],
    ["BRIDGE_NOT_RUNNING", { bridge_service_state: "STOPPED" }],
    ["TINDER_GATE_NOT_CONNECTED", { tinder_state: "DISCONNECTED" }],
    ["TINDER_AUTH_REQUIRED", { tinder_state: "AUTH_REQUIRED" }],
    ["TINDER_REVIEW_REQUIRED", { tinder_state: "REVIEW_REQUIRED" }],
    ["TINDER_STATE_UNKNOWN", { tinder_state: "UNKNOWN" }],
    ["AUTOMATION_NOT_STOPPED", { automation_state: "RUNNING" }]
  ];
  for (const [code, overrides] of cases) {
    const repository = fixtureRepository({ snapshot: readySnapshot(overrides) });
    const { service } = fixtureService({ repository });
    await service.approveDraft({ draftId: DRAFT_ID });
    await assert.rejects(
      () => service.reserveApprovedSend({ draftId: DRAFT_ID }),
      (error) => error instanceof TinderManualSendError && error.code === code,
      code
    );
    assert.equal(repository.state.intents.length, 0, code);
  }
});

test("a missing shared Delivery Policy blocks the sealed intent without inventing timing", async () => {
  const { service, repository } = fixtureService({ deliveryPolicy: async () => null });
  await service.approveDraft({ draftId: DRAFT_ID });
  await assert.rejects(
    () => service.reserveApprovedSend({ draftId: DRAFT_ID }),
    (error) => error instanceof TinderManualSendError && error.code === "DELIVERY_POLICY_UNAVAILABLE"
  );
  assert.equal(repository.state.intents.length, 0);
});

test("the future payload is server-derived, scalar-only, exact, and excludes credentials or UI instructions", async () => {
  const { service, repository } = await approveAndReserve();
  const command = await service.buildReservedFutureCommand({ draftId: DRAFT_ID });
  assert.equal(command.commandId, COMMAND_ID);
  assert.equal(command.commandType, "SEND_TINDER_DRAFT");
  assert.deepEqual(Object.keys(command.payload).sort(), [
    "approval_binding_sha256", "approval_id", "approved_text", "approved_text_sha256",
    "capture_fingerprint", "capture_id", "command_fingerprint", "command_id", "contact_id",
    "delivery_policy_revision", "draft_id", "draft_revision", "expires_at", "identity_revision",
    "intent_id", "not_before", "payload_version", "sealed_payload_sha256", "thread_ref_hash",
    "thread_ref_kind", "typing_duration_ms"
  ].sort());
  assert.equal(command.payload.thread_ref_kind, "runtime_thread_fingerprint_v1");
  assert.equal(command.payload.intent_id, INTENT_ID);
  assert.equal(command.payload.command_id, COMMAND_ID);
  assert.equal(command.payload.payload_version, "tinder_t5_send_v1");
  assert.equal(command.payload.approved_text_sha256, sha256Text(repository.state.snapshot.original_draft));
  assert.equal(assertFutureTinderSendPayload(command.payload), true);
  assert.throws(
    () => assertFutureTinderSendPayload({ ...command.payload, intent_id: APPROVAL_ID }),
    (error) => error instanceof TinderManualSendError && error.code === "INVALID_SEND_COMMAND_PAYLOAD"
  );
  assert.throws(
    () => assertFutureTinderSendPayload({ ...command.payload, sealed_payload_sha256: "0".repeat(64) }),
    (error) => error instanceof TinderManualSendError && error.code === "INVALID_SEND_COMMAND_PAYLOAD"
  );
  assert.equal(JSON.stringify(command.payload).match(/token|credential|password|selector|url|browser|instruction/i), null);
  assert.throws(
    () => assertFutureTinderSendPayload({ ...command.payload, selector: "unsafe" }),
    (error) => error instanceof TinderManualSendError && error.code === "INVALID_SEND_COMMAND_PAYLOAD"
  );
});

test("terminal success blocks a second send and terminal failure/rejection/ambiguity remain terminal without retry", async () => {
  const outcomes = [
    ["SENT", "SENT"],
    ["FAILED", "FAILED"],
    ["REJECTED", "CANCELLED"],
    ["SEND_RESULT_UNKNOWN", "SEND_RESULT_UNKNOWN"]
  ];
  for (const [outcome, expectedState] of outcomes) {
    const { service, repository } = await approveAndReserve();
    const result = await service.recordFutureSendOutcome({ commandId: COMMAND_ID, outcome });
    assert.equal(result.state, expectedState, outcome);
    const repeated = await service.recordFutureSendOutcome({ commandId: COMMAND_ID, outcome });
    assert.equal(repeated.idempotent, true, outcome);
    await assert.rejects(
      () => service.reserveApprovedSend({ draftId: DRAFT_ID }),
      (error) => error instanceof TinderManualSendError && error.code === "SEND_ATTEMPT_ALREADY_TERMINAL",
      outcome
    );
    assert.equal(repository.state.intents.length, 1, outcome);
  }
});

test("a received future command followed by failure or cancellation is SEND_RESULT_UNKNOWN and never retried", async () => {
  const { service, repository } = await approveAndReserve();
  const received = await service.recordFutureSendOutcome({ commandId: COMMAND_ID, outcome: "RECEIVED" });
  assert.equal(received.state, "DISPATCHING");
  const unknown = await service.recordFutureSendOutcome({ commandId: COMMAND_ID, outcome: "FAILED" });
  assert.equal(unknown.state, "SEND_RESULT_UNKNOWN");
  await assert.rejects(
    () => service.reserveApprovedSend({ draftId: DRAFT_ID }),
    (error) => error instanceof TinderManualSendError && error.code === "SEND_ATTEMPT_ALREADY_TERMINAL"
  );
  assert.equal(repository.state.intents.length, 1);
});

test("manual cancellation is safe before receipt and never falsely rolls back a received command", async () => {
  const first = await approveAndReserve();
  const cancelled = await first.service.cancelApprovedSend({ draftId: DRAFT_ID });
  assert.equal(cancelled.state, "CANCELLED");
  assert.equal(first.repository.state.approvals[0].state, "CANCELLED");

  const second = await approveAndReserve();
  await second.service.recordFutureSendOutcome({ commandId: COMMAND_ID, outcome: "RECEIVED" });
  const unknown = await second.service.cancelApprovedSend({ draftId: DRAFT_ID });
  assert.equal(unknown.state, "SEND_RESULT_UNKNOWN");
  assert.equal(second.repository.state.approvals[0].state, "INVALIDATED");
});

test("T5 is a sealed future contract: active Protocol V1, heartbeat/ACK/admin, and T1 runner do not expose SEND_TINDER_DRAFT", () => {
  assert.equal(DEVICE_BRIDGE_COMMANDS.includes("SEND_TINDER_DRAFT"), false);
  assert.equal(FUTURE_T5_DEVICE_CAPABILITIES.includes("TINDER_DRAFT_SEND_V1"), true);
  const root = new URL("..", import.meta.url);
  const heartbeat = readFileSync(new URL("../device-bridge/heartbeat.js", import.meta.url), "utf8");
  const ack = readFileSync(new URL("../device-bridge/command-ack.js", import.meta.url), "utf8");
  const admin = readFileSync(new URL("../device-bridge/admin.js", import.meta.url), "utf8");
  const t1 = readFileSync(new URL("../device-bridge/t1-schema.js", import.meta.url), "utf8");
  const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const source = readFileSync(new URL("../services/tinder-manual-send.js", import.meta.url), "utf8");
  assert.doesNotMatch(heartbeat, /SEND_TINDER_DRAFT/);
  assert.doesNotMatch(ack, /SEND_TINDER_DRAFT/);
  assert.doesNotMatch(admin, /SEND_TINDER_DRAFT/);
  assert.doesNotMatch(t1, /SEND_TINDER_DRAFT/);
  assert.doesNotMatch(index, /20260905_tinder_manual_send_foundation\.sql/);
  assert.doesNotMatch(source, /fetch\(|playwright|chromium|sendMessage|from\s+["'][^"']*accessibility/i);
  assert.equal(root.pathname.length > 0, true);
});
