import assert from "node:assert/strict";
import test from "node:test";
import {
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_ACK_RESULT,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_ACK_RESULT,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS,
  TinderUnboundInboxConversationSweepError,
  createTinderUnboundInboxConversationSweepService
} from "../services/tinder-unbound-inbox-conversation-sweep.js";
import {
  T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES
} from "../device-bridge/protocol-v1.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const SWEEP_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const READ_COMMAND_ID = "b565e8a7-ef60-42d0-b19d-26e7904390fa";
const RETURN_COMMAND_ID = "c565e8a7-ef60-42d0-b19d-26e7904390fa";
const NEXT_READ_COMMAND_ID = "d565e8a7-ef60-42d0-b19d-26e7904390fa";
const TRANSCRIPT_ID = "e565e8a7-ef60-42d0-b19d-26e7904390fa";
const OBSERVATION_NONCE = "f565e8a7-ef60-42d0-b19d-26e7904390fa";
const AUDIT_IDS = [
  "f565e8a7-ef60-42d0-b19d-26e7904390fa",
  "1565e8a7-ef60-42d0-b19d-26e7904390fa",
  "2565e8a7-ef60-42d0-b19d-26e7904390fa",
  "3565e8a7-ef60-42d0-b19d-26e7904390fa",
  "4565e8a7-ef60-42d0-b19d-26e7904390fa"
];
const NOW = new Date("2026-09-12T12:00:00.000Z");

function runtime(overrides = {}) {
  return {
    online: true, enrollment_state: "ACTIVE", bridge_service_state: "RUNNING",
    tinder_state: "CONNECTED", automation_state: "STOPPED",
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES,
    last_heartbeat_sequence: 17,
    ...overrides
  };
}

function inboxReady() {
  return {
    stage: "INBOX_READY", reason: "NONE", visible_conversation_count: 3, observed_event_count: 2,
    observation_kind: "FRESH_REVIEWED_INBOX_V1", observation_nonce: OBSERVATION_NONCE
  };
}

function freshObservationInput(overrides = {}) {
  return {
    deviceId: DEVICE_ID, heartbeatSequence: 17, inboxNavigation: inboxReady(),
    observationNonce: OBSERVATION_NONCE, ...overrides
  };
}

function activeSweep(overrides = {}) {
  return {
    sweep_id: SWEEP_ID, device_id: DEVICE_ID, sweep_state: "ACTIVE", max_slots: 8,
    next_slot: 1, active_command_id: READ_COMMAND_ID,
    expires_at: "2026-09-12T12:30:00.000Z", ...overrides
  };
}

function stagedRead(overrides = {}) {
  return {
    command_id: READ_COMMAND_ID, sweep_id: SWEEP_ID, device_id: DEVICE_ID,
    slot_ordinal: 1, child_kind: "READ", child_state: "STAGED", transcript_id: null,
    expires_at: "2026-09-12T12:03:00.000Z",
    command_type: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE,
    command_payload: {}, terminal_status: "SUCCEEDED", ack_status: "SUCCEEDED",
    ack_result: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_ACK_RESULT,
    ...overrides
  };
}

function issuedReturn(overrides = {}) {
  return {
    command_id: RETURN_COMMAND_ID, sweep_id: SWEEP_ID, device_id: DEVICE_ID,
    slot_ordinal: 1, child_kind: "RETURN_ONLY", child_state: "ISSUED", transcript_id: null,
    expires_at: "2026-09-12T12:01:30.000Z",
    command_type: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE,
    command_payload: {}, terminal_status: "SUCCEEDED", ack_status: "SUCCEEDED",
    ack_result: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_ACK_RESULT,
    ...overrides
  };
}

function fixtureRepository({ runtimeRow = runtime(), conflicts = {}, sweepRow = activeSweep(), stepRow = stagedRead(), priorObservation = false, persistedObservation = false, expiredRows = [] } = {}) {
  const state = { commands: [], sweeps: [], steps: [], audits: [], runtimeRow, conflicts, sweepRow, stepRow, priorObservation, persistedObservation, expiredRows, accepted: [], stopped: [] };
  const repository = {
    state,
    async withTransaction(work) { return work({}); },
    async getDeviceRuntimeForUpdate() { return state.runtimeRow; },
    async findPriorFreshReviewedInboxObservationForDevice() { return state.priorObservation; },
    async findUnboundInboxConversationSweepByObservationNonceForDevice() { return state.persistedObservation; },
    async expireUnboundInboxConversationSweepForDevice() { return state.expiredRows; },
    async findActiveHumanArmedPermitForDevice() { return conflicts.human === true; },
    async findActiveVisibleChatSyncPermitForDevice() { return conflicts.v4 === true; },
    async findActiveOfficialAppResumePermitForDevice() { return conflicts.resume === true; },
    async findActiveLocalConversationAttestationForDevice() { return conflicts.attestation === true; },
    async findActiveUnboundInboxConversationSweepForDevice() { return conflicts.sweep === true; },
    async queueUnboundInboxConversationSweepCommand(_transaction, command) { state.commands.push(command); },
    async createUnboundInboxConversationSweep(_transaction, sweep) { state.sweeps.push(sweep); },
    async createUnboundInboxConversationSweepStep(_transaction, step) { state.steps.push(step); },
    async setUnboundInboxConversationSweepActiveStep(_transaction, update) {
      state.sweepRow = { ...state.sweepRow, active_command_id: update.commandId, next_slot: update.nextSlot };
    },
    async getUnboundInboxConversationSweepForUpdate() { return state.sweepRow; },
    async getUnboundInboxConversationSweepForDeviceForUpdate() { return state.sweepRow; },
    async getUnboundInboxConversationSweepStepForUpdate(_transaction, commandId) {
      return commandId === state.stepRow?.command_id ? state.stepRow : null;
    },
    async stageUnboundInboxConversationSweepReadStep(_transaction, input) {
      if (state.stepRow?.command_id !== input.commandId || state.stepRow.child_state !== "ISSUED") return false;
      state.stepRow = { ...state.stepRow, child_state: "STAGED" }; return true;
    },
    async stageUnboundInboxConversationSweepReturnStep(_transaction, input) {
      if (state.stepRow?.command_id !== input.commandId || state.stepRow.child_state !== "ISSUED") return false;
      state.stepRow = { ...state.stepRow, child_state: "RETURN_STAGED" }; return true;
    },
    async acceptUnboundInboxConversationSweepReadStep(_transaction, input) {
      if (state.stepRow?.command_id !== input.commandId || state.stepRow.child_state !== "STAGED") return false;
      state.stepRow = { ...state.stepRow, child_state: "TRANSCRIPT_ACCEPTED", transcript_id: input.transcriptId }; state.accepted.push(input); return true;
    },
    async acceptUnboundInboxConversationSweepReturnStep(_transaction, input) {
      if (state.stepRow?.command_id !== input.commandId || state.stepRow.child_state !== "RETURN_STAGED") return false;
      state.stepRow = { ...state.stepRow, child_state: "RETURN_ACCEPTED" }; state.accepted.push(input); return true;
    },
    async cancelUnboundInboxConversationSweepStepAndStop(_transaction, input) { state.stopped.push(input); return true; },
    async completeUnboundInboxConversationSweep() { return true; },
    async insertUnboundInboxConversationSweepAudit(_transaction, audit) { state.audits.push(audit); }
  };
  return repository;
}

function service(repository, { commandIndex = 0 } = {}) {
  let auditIndex = 0;
  return createTinderUnboundInboxConversationSweepService(repository, {
    createSweepId: () => SWEEP_ID,
    createCommandId: () => [READ_COMMAND_ID, RETURN_COMMAND_ID, NEXT_READ_COMMAND_ID][commandIndex++],
    createAuditId: () => AUDIT_IDS[auditIndex++], now: () => NOW
  });
}

test("V8 sweep starts only at fresh INBOX_READY with one empty READ child and no parent/slot data in its command", async () => {
  const repository = fixtureRepository();
  const result = await service(repository).startUnboundInboxConversationSweepFromFreshInboxObservation({}, freshObservationInput());
  assert.deepEqual(result, { status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS.QUEUED });
  assert.deepEqual(repository.state.commands, [{
    commandId: READ_COMMAND_ID, deviceId: DEVICE_ID,
    commandType: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE,
    payload: {}, expiresAt: "2026-09-12T12:03:00.000Z"
  }]);
  assert.equal(repository.state.sweeps[0].activeCommandId, READ_COMMAND_ID);
  assert.equal(repository.state.sweeps[0].inboxObservationNonce, OBSERVATION_NONCE);
  assert.deepEqual(repository.state.steps, [{
    commandId: READ_COMMAND_ID, sweepId: SWEEP_ID, deviceId: DEVICE_ID,
    slotOrdinal: 1, childKind: "READ", childState: "ISSUED", expiresAt: "2026-09-12T12:03:00.000Z"
  }]);
  assert.equal(JSON.stringify(repository.state.commands[0]).includes("sweep"), false);
});

test("V8 sweep fails closed for stale Inbox evidence, competing authority, and injected start input", async () => {
  await assert.rejects(
    () => service(fixtureRepository()).startUnboundInboxConversationSweepFromFreshInboxObservation({}, freshObservationInput({
      inboxNavigation: { ...inboxReady(), stage: "AWAITING_INBOX" }
    })),
    error => error instanceof TinderUnboundInboxConversationSweepError && error.code === "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_OBSERVATION"
  );
  const conflict = fixtureRepository({ conflicts: { attestation: true } });
  assert.deepEqual(await service(conflict).startUnboundInboxConversationSweepFromFreshInboxObservation({}, freshObservationInput()), {
    status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS.PERMIT_CONFLICT,
    reasonCode: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.ATTESTATION_ACTIVE
  });
  const duplicate = fixtureRepository({ priorObservation: true });
  assert.deepEqual(await service(duplicate).startUnboundInboxConversationSweepFromFreshInboxObservation({}, freshObservationInput()), {
    status: "INERT"
  });
  assert.equal(duplicate.state.commands.length, 0);
  await assert.rejects(
    () => service(fixtureRepository()).startUnboundInboxConversationSweepFromFreshInboxObservation({}, { deviceId: DEVICE_ID, maxSlots: 8 }),
    error => error instanceof TinderUnboundInboxConversationSweepError && error.code === "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_OBSERVATION"
  );
});

test("expiry preserves exact child command and slot provenance, while parent expiry remains parent-scoped", async () => {
  const stoppedSweep = activeSweep({ sweep_state: "STOPPED", active_command_id: null });
  const childExpiry = fixtureRepository({
    sweepRow: stoppedSweep,
    expiredRows: [{
      ...stoppedSweep,
      expired_command_id: READ_COMMAND_ID,
      expired_slot_ordinal: 1
    }]
  });
  assert.deepEqual(await service(childExpiry).getBoundedSweepStatus({ deviceId: DEVICE_ID }), {
    status: "STOPPED"
  });
  assert.deepEqual(childExpiry.state.audits, [
    {
      auditId: AUDIT_IDS[0], sweepId: SWEEP_ID, commandId: READ_COMMAND_ID,
      deviceId: DEVICE_ID, slotOrdinal: 1, transcriptId: null,
      action: "CHILD_EXPIRED", actor: "SERVER_EXPIRY", source: "SERVER_MAINTENANCE",
      reasonCode: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.CHILD_EXPIRED,
      details: {}
    }
  ]);

  const expiredSweep = activeSweep({ sweep_state: "EXPIRED", active_command_id: null });
  const parentExpiry = fixtureRepository({ sweepRow: expiredSweep, expiredRows: [{ ...expiredSweep }] });
  assert.deepEqual(await service(parentExpiry).getBoundedSweepStatus({ deviceId: DEVICE_ID }), {
    status: "EXPIRED"
  });
  assert.deepEqual(parentExpiry.state.audits[0], {
    auditId: AUDIT_IDS[0], sweepId: SWEEP_ID, commandId: null,
    deviceId: DEVICE_ID, slotOrdinal: null, transcriptId: null,
    action: "SWEEP_EXPIRED", actor: "SERVER_EXPIRY", source: "SERVER_MAINTENANCE",
    reasonCode: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.SWEEP_EXPIRED,
    details: {}
  });
});

test("heartbeat expiry exposes only a bounded child-expired fact after preserving exact audit provenance", async () => {
  const stoppedSweep = activeSweep({ sweep_state: "STOPPED", active_command_id: null });
  const repository = fixtureRepository({
    sweepRow: stoppedSweep,
    expiredRows: [{
      ...stoppedSweep,
      expired_command_id: READ_COMMAND_ID,
      expired_slot_ordinal: 1
    }]
  });
  const result = await service(repository).expireUnboundInboxConversationSweepForHeartbeat({}, {
    deviceId: DEVICE_ID
  });
  assert.deepEqual(result, { childExpired: true, active: false });
  assert.deepEqual(repository.state.audits[0], {
    auditId: AUDIT_IDS[0], sweepId: SWEEP_ID, commandId: READ_COMMAND_ID,
    deviceId: DEVICE_ID, slotOrdinal: 1, transcriptId: null,
    action: "CHILD_EXPIRED", actor: "SERVER_EXPIRY", source: "SERVER_MAINTENANCE",
    reasonCode: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.CHILD_EXPIRED,
    details: {}
  });
});

test("READ transcript acceptance atomically queues a distinct 90-second empty RETURN_ONLY child", async () => {
  const repository = fixtureRepository();
  const sweepService = service(repository, { commandIndex: 1 });
  const staged = await sweepService.authorizeIncomingSweepTranscript({}, { commandId: READ_COMMAND_ID, deviceId: DEVICE_ID });
  assert.deepEqual(staged, { status: "STAGED", authorization: { commandId: READ_COMMAND_ID, deviceId: DEVICE_ID } });
  const result = await sweepService.consumeAuthorizedSweepTranscript({}, { authorization: staged.authorization, transcriptId: TRANSCRIPT_ID });
  assert.deepEqual(result, { status: "RETURN_QUEUED" });
  assert.deepEqual(repository.state.accepted, [{ commandId: READ_COMMAND_ID, transcriptId: TRANSCRIPT_ID, acceptedAt: NOW.toISOString() }]);
  assert.deepEqual(repository.state.commands, [{
    commandId: RETURN_COMMAND_ID, deviceId: DEVICE_ID,
    commandType: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE,
    payload: {}, expiresAt: "2026-09-12T12:01:30.000Z"
  }]);
  assert.equal(repository.state.audits.some(audit => audit.transcriptId === TRANSCRIPT_ID && audit.action === "READ_TRANSCRIPT_ACCEPTED"), true);
});

test("only a separately signed RETURNED receipt queues the next READ slot, while bounded terminal outcomes stop rather than retry", async () => {
  const repository = fixtureRepository({ sweepRow: activeSweep({ active_command_id: RETURN_COMMAND_ID }), stepRow: issuedReturn() });
  const sweepService = service(repository);
  const success = await sweepService.projectSweepChildAcknowledgement({}, {
    command: { command_id: RETURN_COMMAND_ID, device_id: DEVICE_ID, command_type: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE },
    ack: { status: "SUCCEEDED", occurred_at: NOW.toISOString(), result: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_ACK_RESULT }
  });
  assert.deepEqual(success, { state: "STAGED" });
  assert.equal(repository.state.commands.length, 0);
  const accepted = await sweepService.acceptSignedSweepReturnReceipt({
    commandId: RETURN_COMMAND_ID, deviceId: DEVICE_ID, status: "RETURNED"
  });
  assert.deepEqual(accepted, { status: "READ_QUEUED" });
  assert.deepEqual(repository.state.commands, [{
    commandId: READ_COMMAND_ID, deviceId: DEVICE_ID,
    commandType: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE,
    payload: {}, expiresAt: "2026-09-12T12:03:00.000Z"
  }]);

  const stoppedRepository = fixtureRepository({ stepRow: stagedRead({ child_state: "ISSUED", terminal_status: "", ack_status: "", ack_result: null }) });
  const stopped = await service(stoppedRepository).projectSweepChildAcknowledgement({}, {
    command: { command_id: READ_COMMAND_ID, device_id: DEVICE_ID, command_type: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE },
    ack: { status: "FAILED", occurred_at: NOW.toISOString(), error: { code: "TINDER_UNBOUND_INBOX_SWEEP_OUTCOME_UNRESOLVED" } }
  });
  assert.deepEqual(stopped, { state: "STOPPED" });
  assert.equal(stoppedRepository.state.stopped[0].reasonCode, TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.UNKNOWN_OUTCOME);
  assert.equal(stoppedRepository.state.commands.length, 0);
});

test("a missing same-process reviewed Inbox snapshot closes the V8 child rather than recreating a baseline", async () => {
  const repository = fixtureRepository({ stepRow: stagedRead({ child_state: "ISSUED", terminal_status: "", ack_status: "", ack_result: null }) });
  const result = await service(repository).projectSweepChildAcknowledgement({}, {
    command: { command_id: READ_COMMAND_ID, device_id: DEVICE_ID, command_type: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE },
    ack: {
      status: "FAILED", occurred_at: NOW.toISOString(),
      error: {
        code: "TINDER_UNBOUND_INBOX_SWEEP_LOCAL_CONTEXT_UNAVAILABLE",
        message: "Unbound Inbox sweep local Inbox context is unavailable"
      }
    }
  });
  assert.deepEqual(result, { state: "STOPPED" });
  assert.equal(repository.state.stopped[0].reasonCode, TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.RUNTIME_GATE_LOST);
});
