import assert from "node:assert/strict";
import test from "node:test";
import {
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_ACK_RESULT,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_ACK_RESULT,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE,
  createTinderUnboundInboxConversationSweepService
} from "../services/tinder-unbound-inbox-conversation-sweep.js";
import {
  TinderUnboundInboxConversationSweepStoreError,
  createTinderUnboundInboxConversationSweepStore,
  normalizeTinderUnboundInboxConversationSweepTranscript
} from "../services/tinder-unbound-inbox-conversation-sweep-store.js";
import {
  createAuthenticatedUnboundInboxConversationSweepStore,
  createTinderUnboundInboxConversationSweepTranscriptIngressHandler,
  parseSignedUnboundInboxConversationSweepTranscriptRequest
} from "../device-bridge/tinder-unbound-inbox-conversation-sweep-ingress.js";
import {
  createAuthenticatedUnboundInboxConversationSweepReturnService,
  createTinderUnboundInboxConversationSweepReturnIngressHandler,
  parseSignedUnboundInboxConversationSweepReturnRequest
} from "../device-bridge/tinder-unbound-inbox-conversation-sweep-return-ingress.js";
import {
  T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES
} from "../device-bridge/protocol-v1.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const SWEEP_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const READ_COMMAND_ID = "b565e8a7-ef60-42d0-b19d-26e7904390fa";
const RETURN_COMMAND_ID = "c565e8a7-ef60-42d0-b19d-26e7904390fa";
const TRANSCRIPT_ID = "d565e8a7-ef60-42d0-b19d-26e7904390fa";
const NOW = new Date("2026-09-12T12:00:00.000Z");

function transcript(overrides = {}) {
  return {
    schema_version: "tinder-unbound-inbox-conversation-sweep-transcript-v1",
    command_id: READ_COMMAND_ID,
    source_package: "com.tinder",
    layout_schema_version: "tinder-zte-visible-chat-scroll-v1",
    sync_started_at: "2026-09-12T12:00:10.000Z",
    sync_completed_at: "2026-09-12T12:00:50.000Z",
    initial_visible_node_count: 27,
    final_visible_node_count: 29,
    segment_count: 2,
    overlap_count: 2,
    transcript_fingerprint: "a".repeat(64),
    messages: [
      { visible_order: 1, text: "synthetic inbound", direction: "INBOUND", source_class_name: "android.view.View" },
      { visible_order: 2, text: "synthetic outbound", direction: "OUTBOUND", source_class_name: "android.view.View" }
    ],
    safety_status: "SAFE",
    ...overrides
  };
}

function stagedRead() {
  return {
    command_id: READ_COMMAND_ID, sweep_id: SWEEP_ID, device_id: DEVICE_ID,
    slot_ordinal: 1, child_kind: "READ", child_state: "STAGED", transcript_id: null,
    expires_at: "2026-09-12T12:03:00.000Z",
    command_type: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE,
    command_payload: {}, terminal_status: "SUCCEEDED", ack_status: "SUCCEEDED",
    ack_result: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_ACK_RESULT
  };
}

function activeSweep() {
  return {
    sweep_id: SWEEP_ID, device_id: DEVICE_ID, sweep_state: "ACTIVE", max_slots: 8,
    next_slot: 1, active_command_id: READ_COMMAND_ID,
    expires_at: "2026-09-12T12:30:00.000Z"
  };
}

function repositoryFixture({ storedTranscript = null } = {}) {
  const state = {
    step: stagedRead(), sweep: activeSweep(), inserted: [], consumed: [], commands: [],
    steps: [], audits: []
  };
  const repository = {
    state,
    async withTransaction(work) { return work({}); },
    async getDeviceRuntimeForUpdate() { return null; },
    async findPriorFreshReviewedInboxObservationForDevice() { return false; },
    async findUnboundInboxConversationSweepByObservationNonceForDevice() { return false; },
    async expireUnboundInboxConversationSweepForDevice() { return []; },
    async findActiveHumanArmedPermitForDevice() { return false; },
    async findActiveVisibleChatSyncPermitForDevice() { return false; },
    async findActiveOfficialAppResumePermitForDevice() { return false; },
    async findActiveLocalConversationAttestationForDevice() { return false; },
    async findActiveUnboundInboxConversationSweepForDevice() { return false; },
    async queueUnboundInboxConversationSweepCommand(_transaction, input) { state.commands.push(input); },
    async createUnboundInboxConversationSweep(_transaction, input) { state.sweep = input; },
    async createUnboundInboxConversationSweepStep(_transaction, input) { state.steps.push(input); },
    async setUnboundInboxConversationSweepActiveStep(_transaction, input) {
      state.sweep = { ...state.sweep, active_command_id: input.commandId, next_slot: input.nextSlot };
    },
    async getUnboundInboxConversationSweepForUpdate() { return state.sweep; },
    async getUnboundInboxConversationSweepForDeviceForUpdate() { return state.sweep; },
    async getUnboundInboxConversationSweepStepForUpdate(_transaction, commandId) {
      return commandId === state.step.command_id ? state.step : null;
    },
    async stageUnboundInboxConversationSweepReadStep() { return false; },
    async stageUnboundInboxConversationSweepReturnStep() { return false; },
    async acceptUnboundInboxConversationSweepReadStep(_transaction, input) {
      if (input.commandId !== state.step.command_id || state.step.child_state !== "STAGED") return false;
      state.step = {
        ...state.step, child_state: "TRANSCRIPT_ACCEPTED", transcript_id: input.transcriptId,
        accepted_at: input.acceptedAt, closed_at: input.acceptedAt, terminal_reason: "TRANSCRIPT_ACCEPTED"
      };
      state.consumed.push(input);
      return true;
    },
    async acceptUnboundInboxConversationSweepReturnStep() { return false; },
    async cancelUnboundInboxConversationSweepStepAndStop() { return false; },
    async completeUnboundInboxConversationSweep() { return false; },
    async insertUnboundInboxConversationSweepAudit(_transaction, input) { state.audits.push(input); },
    async insertUnboundInboxConversationSweepTranscript(_transaction, input) {
      state.inserted.push(input);
      return storedTranscript || {
        transcript_id: input.transcriptId,
        mapping_status: "NEEDS_HUMAN_MAPPING",
        human_review_status: "PENDING"
      };
    }
  };
  return repository;
}

function store(repository) {
  let commandIndex = 0;
  let auditIndex = 0;
  const auditIds = [
    "e565e8a7-ef60-42d0-b19d-26e7904390fa",
    "f565e8a7-ef60-42d0-b19d-26e7904390fa"
  ];
  return createTinderUnboundInboxConversationSweepStore(repository, {
    now: () => NOW,
    createTranscriptId: () => TRANSCRIPT_ID,
    createSweepService: repo => createTinderUnboundInboxConversationSweepService(repo, {
      now: () => NOW,
      createCommandId: () => [RETURN_COMMAND_ID][commandIndex++],
      createAuditId: () => auditIds[auditIndex++]
    })
  });
}

test("V8 transcript grammar is distinct, bounded, and rejects V4 or identity-shaped fields", () => {
  const normalized = normalizeTinderUnboundInboxConversationSweepTranscript(transcript());
  assert.equal(normalized.commandId, READ_COMMAND_ID);
  assert.deepEqual(normalized.messages, [
    { visibleOrder: 1, direction: "INBOUND", text: "synthetic inbound" },
    { visibleOrder: 2, direction: "OUTBOUND", text: "synthetic outbound" }
  ]);
  for (const invalidValue of [
    { ...transcript(), capture_id: "6ebb6d37-8b69-444a-b22d-390b81860026" },
    { ...transcript(), binding_id: "6ebb6d37-8b69-444a-b22d-390b81860026" },
    { ...transcript(), contact_id: 7 },
    { ...transcript(), thread_fingerprint: "a".repeat(64) },
    { ...transcript(), messages: [{ ...transcript().messages[0], direction: "INCOMING" }] },
    { ...transcript(), segment_count: 9 },
    { ...transcript(), layout_schema_version: "tinder-visible-chat-sync-v1" }
  ]) {
    assert.throws(
      () => normalizeTinderUnboundInboxConversationSweepTranscript(invalidValue),
      error => error instanceof TinderUnboundInboxConversationSweepStoreError
    );
  }
});

test("V8 transcript ingress atomically persists PENDING/null-contact data, consumes READ, and queues one empty RETURN", async () => {
  const repository = repositoryFixture();
  const result = await store(repository).storeStagedUnboundInboxConversationSweepTranscript({
    deviceId: DEVICE_ID, transcript: transcript()
  });
  assert.deepEqual(result, { status: "ACCEPTED" });
  assert.equal(repository.state.inserted.length, 1);
  assert.deepEqual(repository.state.inserted[0].messages, [
    { visibleOrder: 1, direction: "INBOUND", text: "synthetic inbound" },
    { visibleOrder: 2, direction: "OUTBOUND", text: "synthetic outbound" }
  ]);
  for (const field of ["captureId", "sourceCaptureId", "bindingId", "contactId", "threadFingerprint"]) {
    assert.equal(Object.hasOwn(repository.state.inserted[0], field), false);
  }
  assert.deepEqual(repository.state.consumed, [{
    commandId: READ_COMMAND_ID, transcriptId: TRANSCRIPT_ID, acceptedAt: NOW.toISOString()
  }]);
  assert.deepEqual(repository.state.commands, [{
    commandId: RETURN_COMMAND_ID, deviceId: DEVICE_ID,
    commandType: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE,
    payload: {}, expiresAt: "2026-09-12T12:01:30.000Z"
  }]);
  assert.equal(repository.state.audits.some(audit => audit.action === "READ_TRANSCRIPT_ACCEPTED"), true);
  assert.equal(repository.state.audits.some(audit => audit.action === "RETURN_ISSUED"), true);
});

test("the exact signed V8 parser result reaches the store without a second wire-shape parse", async () => {
  const repository = repositoryFixture();
  const parsed = parseSignedUnboundInboxConversationSweepTranscriptRequest({
    body: new TextEncoder().encode(JSON.stringify({
      protocol_version: 1,
      unbound_inbox_sweep_read: transcript()
    }))
  });

  assert.deepEqual(await store(repository).storeStagedUnboundInboxConversationSweepTranscript({
    deviceId: DEVICE_ID,
    transcript: parsed
  }), { status: "ACCEPTED" });
  assert.equal(repository.state.inserted.length, 1);
  assert.deepEqual(repository.state.inserted[0].messages, [
    { visibleOrder: 1, direction: "INBOUND", text: "synthetic inbound" },
    { visibleOrder: 2, direction: "OUTBOUND", text: "synthetic outbound" }
  ]);
});

test("V8 refuses a non-PENDING persistence response before the READ child can be consumed", async () => {
  const repository = repositoryFixture({ storedTranscript: {
    transcript_id: TRANSCRIPT_ID, mapping_status: "RESOLVED", human_review_status: "CONFIRMED"
  } });
  await assert.rejects(
    () => store(repository).storeStagedUnboundInboxConversationSweepTranscript({ deviceId: DEVICE_ID, transcript: transcript() }),
    error => error instanceof TinderUnboundInboxConversationSweepStoreError
      && error.code === "UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_WRITE_FAILED"
  );
  assert.equal(repository.state.consumed.length, 0);
  assert.equal(repository.state.commands.length, 0);
});

function response() {
  return {
    statusCode: null, body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    get() { return "request-id"; }
  };
}

function foundationGatePool() {
  const state = { began: 0, rolledBack: 0, committed: 0, replayWrites: 0, released: false };
  const client = {
    async query(sql) {
      if (sql === "BEGIN") { state.began += 1; return { rows: [] }; }
      if (sql === "ROLLBACK") { state.rolledBack += 1; return { rows: [] }; }
      if (sql === "COMMIT") { state.committed += 1; return { rows: [] }; }
      if (sql.includes("device_bridge_request_nonces")) state.replayWrites += 1;
      return { rows: [] };
    },
    release() { state.released = true; }
  };
  return { state, pool: { async connect() { return client; } } };
}

const V8_AUTH = Object.freeze({
  deviceId: DEVICE_ID,
  keyId: "test-key",
  requestId: "e565e8a7-ef60-42d0-b19d-26e7904390fa",
  contentSha256: "a".repeat(64)
});

test("V8 ingress and return fail before replay or lifecycle work when the exact catalog is not canonical", async () => {
  for (const kind of ["TRANSCRIPT", "RETURN"]) {
    const fixture = foundationGatePool();
    let lifecycleWork = 0;
    const assertion = async () => { throw new Error("catalog drift"); };
    const factory = kind === "TRANSCRIPT"
      ? createAuthenticatedUnboundInboxConversationSweepStore(fixture.pool, V8_AUTH, {
        now: () => NOW,
        assertFoundationReady: assertion,
        createRepository() { return {}; },
        createStore(repository) {
          return { async storeStagedUnboundInboxConversationSweepTranscript() {
            return repository.withTransaction(async () => { lifecycleWork += 1; return { status: "ACCEPTED" }; });
          } };
        }
      })
      : createAuthenticatedUnboundInboxConversationSweepReturnService(fixture.pool, V8_AUTH, {
        now: () => NOW,
        assertFoundationReady: assertion,
        createRepository() { return {}; },
        createService(repository) {
          return { async acceptSignedSweepReturnReceipt() {
            return repository.withTransaction(async () => { lifecycleWork += 1; return { status: "READ_QUEUED" }; });
          } };
        }
      });
    await assert.rejects(
      () => kind === "TRANSCRIPT"
        ? factory.storeStagedUnboundInboxConversationSweepTranscript({ deviceId: DEVICE_ID, transcript: transcript() })
        : factory.acceptSignedSweepReturnReceipt({ commandId: RETURN_COMMAND_ID, deviceId: DEVICE_ID, status: "RETURNED" }),
      error => error.code === "TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_NOT_READY"
    );
    assert.equal(lifecycleWork, 0);
    assert.equal(fixture.state.replayWrites, 0);
    assert.equal(fixture.state.began, 1);
    assert.equal(fixture.state.committed, 0);
    assert.equal(fixture.state.rolledBack, 1);
    assert.equal(fixture.state.released, true);
  }
});

test("V8 signed transcript and return receipts use separate exact envelopes and expose no IDs or transcript data", async () => {
  const encodedTranscript = new TextEncoder().encode(JSON.stringify({
    protocol_version: 1, unbound_inbox_sweep_read: transcript()
  }));
  assert.equal(parseSignedUnboundInboxConversationSweepTranscriptRequest({ body: encodedTranscript }).commandId, READ_COMMAND_ID);
  assert.throws(() => parseSignedUnboundInboxConversationSweepTranscriptRequest({
    body: new TextEncoder().encode(JSON.stringify({ protocol_version: 1, sync: transcript() }))
  }));
  const encodedReturn = new TextEncoder().encode(JSON.stringify({
    protocol_version: 1,
    unbound_inbox_sweep_return: {
      schema_version: "tinder-unbound-inbox-conversation-sweep-return-receipt-v1",
      command_id: RETURN_COMMAND_ID,
      status: "RETURNED"
    }
  }));
  assert.deepEqual(parseSignedUnboundInboxConversationSweepReturnRequest({ body: encodedReturn }), {
    commandId: RETURN_COMMAND_ID, status: "RETURNED"
  });

  const transcriptHandler = createTinderUnboundInboxConversationSweepTranscriptIngressHandler({}, {
    now: () => NOW,
    async verifyRequest() { return { deviceId: DEVICE_ID, keyId: "test-key" }; },
    createAuthenticatedStore() { return { async storeStagedUnboundInboxConversationSweepTranscript() { return { status: "ACCEPTED" }; } }; }
  });
  const transcriptResponse = response();
  await transcriptHandler({ params: { deviceId: DEVICE_ID }, body: encodedTranscript, get() { return "request-id"; } }, transcriptResponse);
  assert.equal(transcriptResponse.statusCode, 201);
  assert.deepEqual(transcriptResponse.body, {
    ok: true, protocol_version: 1, server_time: NOW.toISOString(),
    unbound_inbox_sweep_read: { status: "ACCEPTED" }
  });

  const returnHandler = createTinderUnboundInboxConversationSweepReturnIngressHandler({}, {
    now: () => NOW,
    async verifyRequest() { return { deviceId: DEVICE_ID, keyId: "test-key" }; },
    createAuthenticatedService() { return { async acceptSignedSweepReturnReceipt() { return { status: "READ_QUEUED" }; } }; }
  });
  const returnResponse = response();
  await returnHandler({ params: { deviceId: DEVICE_ID }, body: encodedReturn, get() { return "request-id"; } }, returnResponse);
  assert.equal(returnResponse.statusCode, 201);
  assert.deepEqual(returnResponse.body, {
    ok: true, protocol_version: 1, server_time: NOW.toISOString(),
    unbound_inbox_sweep_return: { status: "ACCEPTED" }
  });
  const rendered = JSON.stringify({ transcript: transcriptResponse.body, return: returnResponse.body });
  for (const forbidden of [DEVICE_ID, READ_COMMAND_ID, RETURN_COMMAND_ID, "synthetic inbound", "a".repeat(64)]) {
    assert.equal(rendered.includes(forbidden), false);
  }
});
