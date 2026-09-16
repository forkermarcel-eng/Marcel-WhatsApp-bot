import assert from "node:assert/strict";
import test from "node:test";
import {
  createPgTinderOfficialAppResumeRepository,
  createTinderOfficialAppResumeService,
  isExactOfficialAppResumeIntentDispatchedAcknowledgement,
  TinderOfficialAppResumeError,
  TINDER_OFFICIAL_APP_RESUME_ACK_RESULT,
  TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE,
  TINDER_OFFICIAL_APP_RESUME_PERMIT_CONTRACT_VERSION,
  TINDER_OFFICIAL_APP_RESUME_REASON,
  TINDER_OFFICIAL_APP_RESUME_STATUS
} from "../services/tinder-official-app-resume.js";
import { TINDER_OFFICIAL_APP_RESUME_DEVICE_CAPABILITIES } from "../device-bridge/protocol-v1.js";

const DEVICE_ID = "36761d7f-2ac3-4da9-9ad4-7fd381665f1e";
const CAPTURE_ID = "6ebb6d37-8b69-444a-b22d-390b81860026";
const BINDING_ID = "a5dbb10c-6840-4daa-96f7-9f1dc9672e7b";
const COMMAND_ID = "d565e8a7-ef60-42d0-b19d-26e7904390fa";
const NOW = new Date("2026-09-08T12:00:00.000Z");

function runtime(overrides = {}) {
  return {
    online: true,
    enrollment_state: "ACTIVE",
    bridge_service_state: "RUNNING",
    tinder_state: "CONNECTED",
    automation_state: "STOPPED",
    capabilities: TINDER_OFFICIAL_APP_RESUME_DEVICE_CAPABILITIES,
    ...overrides
  };
}

function fixtureRepository({
  deviceRuntime = runtime(),
  activeHumanArmed = false,
  activeVisibleChatSync = false,
  activeResume = false,
  activeAttestation = false,
  activeUnboundInboxSweep = false,
  activeVerifiedChatReturn = false,
  activeResumedForegroundChatReturn = false,
  historicalPermits = [],
  confirmedSource = {
    source_capture_id: CAPTURE_ID,
    binding_id: BINDING_ID,
    binding_revision: 3
  },
  humanBindingDeviceId = DEVICE_ID,
  confirmedSourceForBinding = confirmedSource
} = {}) {
  const state = {
    commands: [], permits: [...historicalPermits], transactions: 0, calls: []
  };
  return {
    state,
    async withTransaction(work) { state.transactions += 1; return work({}); },
    async getDeviceRuntimeForUpdate() { return deviceRuntime; },
    async expireOfficialAppResumePermits(_transaction, input) { state.calls.push({ type: "expire", input }); },
    async findActiveHumanArmedPermitForDevice(_transaction, input) {
      state.calls.push({ type: "human-armed", input });
      return activeHumanArmed;
    },
    async findActiveVisibleChatSyncPermitForDevice(_transaction, input) {
      state.calls.push({ type: "visible-chat-sync", input });
      return activeVisibleChatSync;
    },
    async findActiveOfficialAppResumePermitForDevice(_transaction, input) {
      state.calls.push({ type: "resume", input });
      return activeResume;
    },
    async findActiveLocalConversationAttestationPermitForDevice(_transaction, input) {
      state.calls.push({ type: "local-attestation", input });
      return activeAttestation;
    },
    async findActiveUnboundInboxConversationSweepForDevice(_transaction, input) {
      state.calls.push({ type: "unbound-inbox-sweep", input });
      return activeUnboundInboxSweep;
    },
    async findActiveVerifiedChatReturnPermitForDevice(_transaction, input) {
      state.calls.push({ type: "verified-chat-return", input });
      return activeVerifiedChatReturn;
    },
    async findActiveResumedForegroundChatReturnPermitForDevice(_transaction, input) {
      state.calls.push({ type: "resumed-foreground-chat-return", input });
      return activeResumedForegroundChatReturn;
    },
    async getConfirmedHumanArmedSourceForUpdate(_transaction, input) {
      state.calls.push({ type: "confirmed-human-armed-source", input });
      return confirmedSource;
    },
    async findHumanArmedBindingDeviceId(_transaction, input) {
      state.calls.push({ type: "human-binding-device", input });
      return humanBindingDeviceId;
    },
    async getConfirmedHumanArmedSourceForBindingForUpdate(_transaction, input) {
      state.calls.push({ type: "confirmed-human-binding-source", input });
      return confirmedSourceForBinding;
    },
    async queueOfficialAppResumeCommand(_transaction, command) { state.commands.push(command); },
    async createOfficialAppResumePermit(_transaction, permit) { state.permits.push(permit); }
  };
}

function service(repository) {
  return createTinderOfficialAppResumeService(repository, {
    createCommandId: () => COMMAND_ID,
    now: () => NOW
  });
}

test("official-app resume queues one exact empty-payload command and revision-bound durable permit", async () => {
  const repository = fixtureRepository();
  const result = await service(repository).queueOfficialAppResume({
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID
  });

  assert.deepEqual(result, { status: TINDER_OFFICIAL_APP_RESUME_STATUS.QUEUED });
  assert.deepEqual(repository.state.commands, [{
    commandId: COMMAND_ID,
    deviceId: DEVICE_ID,
    commandType: TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE,
    payload: {},
    expiresAt: "2026-09-08T12:02:00.000Z"
  }]);
  assert.deepEqual(repository.state.permits, [{
    commandId: COMMAND_ID,
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID,
    bindingId: BINDING_ID,
    bindingRevision: 3,
    permitContractVersion: TINDER_OFFICIAL_APP_RESUME_PERMIT_CONTRACT_VERSION,
    permitState: "ISSUED",
    expiresAt: "2026-09-08T12:02:00.000Z"
  }]);
  assert.equal(JSON.stringify(result).includes(CAPTURE_ID), false);
  assert.equal(JSON.stringify(repository.state.commands[0].payload), "{}");
});

test("official-app resume rejects extra targeting input before a transaction", async () => {
  const repository = fixtureRepository();
  for (const extra of [
    { visibleName: "M" },
    { threadFingerprint: "a".repeat(64) },
    { component: "com.tinder/.Main" },
    { intent: "android.intent.action.MAIN" }
  ]) {
    await assert.rejects(
      () => service(repository).queueOfficialAppResume({
        deviceId: DEVICE_ID,
        sourceCaptureId: CAPTURE_ID,
        ...extra
      }),
      error => error instanceof TinderOfficialAppResumeError
        && error.code === "INVALID_OFFICIAL_APP_RESUME_REQUEST"
    );
  }
  assert.equal(repository.state.transactions, 0);
  assert.equal(repository.state.commands.length, 0);
});

test("official-app resume conflicts with an active V3 or V4 permit before command creation", async () => {
  const v3Repository = fixtureRepository({ activeHumanArmed: true });
  assert.deepEqual(await service(v3Repository).queueOfficialAppResume({
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID
  }), {
    status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_CONFLICT,
    reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.HUMAN_ARMED_PERMIT_ACTIVE
  });
  assert.equal(v3Repository.state.commands.length, 0);

  const v4Repository = fixtureRepository({ activeVisibleChatSync: true });
  assert.deepEqual(await service(v4Repository).queueOfficialAppResume({
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID
  }), {
    status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_CONFLICT,
    reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.VISIBLE_CHAT_SYNC_PERMIT_ACTIVE
  });
  assert.equal(v4Repository.state.commands.length, 0);
});

test("official-app resume fails closed while an active V8 Inbox sweep owns the locked device", async () => {
  const repository = fixtureRepository({ activeUnboundInboxSweep: true });
  const result = await service(repository).queueOfficialAppResume({
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID
  });

  assert.deepEqual(result, {
    status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_CONFLICT,
    reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE
  });
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.permits.length, 0);
  assert.equal(repository.state.calls.some(call => call.type === "unbound-inbox-sweep"), true);
  assert.equal(repository.state.calls.some(call => call.type === "confirmed-human-armed-source"), false);
});

test("official-app resume permits a distinct new V2 authority after terminal V1 history without mutating it", async () => {
  const historicalPermit = Object.freeze({
    commandId: "legacy-terminal-command",
    sourceCaptureId: CAPTURE_ID,
    permitState: "DISPATCHED",
    permitContractVersion: 1,
    expiresAt: "2026-09-08T11:59:00.000Z"
  });
  const repository = fixtureRepository({ historicalPermits: [historicalPermit] });
  assert.deepEqual(await service(repository).queueOfficialAppResume({
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID
  }), {
    status: TINDER_OFFICIAL_APP_RESUME_STATUS.QUEUED
  });
  assert.equal(repository.state.commands.length, 1);
  assert.equal(repository.state.permits.length, 2);
  assert.equal(repository.state.permits[0], historicalPermit);
  assert.deepEqual(repository.state.permits[0], historicalPermit);
  assert.equal(repository.state.permits[1].permitContractVersion, 2);
  assert.notEqual(repository.state.permits[1].commandId, historicalPermit.commandId);
  assert.equal(repository.state.calls.some(call => call.type === "used-source"), false);
});

test("an offline rejection creates no Resume authority and a later fresh request remains separate", async () => {
  const deviceRuntime = runtime({ online: false });
  const historicalPermit = Object.freeze({
    commandId: "legacy-terminal-command",
    sourceCaptureId: CAPTURE_ID,
    permitState: "DISPATCHED",
    permitContractVersion: 1,
    expiresAt: "2026-09-08T11:59:00.000Z"
  });
  const repository = fixtureRepository({
    deviceRuntime,
    historicalPermits: [historicalPermit]
  });

  assert.deepEqual(await service(repository).queueOfficialAppResume({
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID
  }), {
    status: TINDER_OFFICIAL_APP_RESUME_STATUS.DEVICE_NOT_READY,
    reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.DEVICE_OFFLINE
  });
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.permits.length, 1);
  assert.equal(repository.state.permits[0], historicalPermit);
  assert.deepEqual(repository.state.calls, []);

  deviceRuntime.online = true;
  assert.deepEqual(await service(repository).queueOfficialAppResume({
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID
  }), { status: TINDER_OFFICIAL_APP_RESUME_STATUS.QUEUED });
  assert.equal(repository.state.commands.length, 1);
  assert.equal(repository.state.permits.length, 2);
  assert.equal(repository.state.permits[0], historicalPermit);
  assert.equal(repository.state.permits[1].permitContractVersion, 2);
  assert.notEqual(repository.state.permits[1].commandId, historicalPermit.commandId);
});

test("official-app resume blocks a new permit while another Resume authority is active", async () => {
  const repository = fixtureRepository({ activeResume: true });
  assert.deepEqual(await service(repository).queueOfficialAppResume({
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID
  }), {
    status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_CONFLICT,
    reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.RESUME_PERMIT_ACTIVE
  });
  assert.equal(repository.state.commands.length, 0);
});

test("official-app resume refuses concurrent attestation and return authorities before source or command writes", async () => {
  for (const [fixture, reasonCode] of [
    [{ activeAttestation: true }, TINDER_OFFICIAL_APP_RESUME_REASON.LOCAL_CONVERSATION_ATTESTATION_PERMIT_ACTIVE],
    [{ activeVerifiedChatReturn: true }, TINDER_OFFICIAL_APP_RESUME_REASON.VERIFIED_CHAT_RETURN_PERMIT_ACTIVE],
    [{ activeResumedForegroundChatReturn: true }, TINDER_OFFICIAL_APP_RESUME_REASON.RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_ACTIVE]
  ]) {
    const repository = fixtureRepository(fixture);
    assert.deepEqual(await service(repository).queueOfficialAppResume({
      deviceId: DEVICE_ID,
      sourceCaptureId: CAPTURE_ID
    }), {
      status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_CONFLICT,
      reasonCode
    });
    assert.equal(repository.state.commands.length, 0);
    assert.equal(repository.state.calls.some(call => call.type === "confirmed-human-armed-source"), false);
  }
});

test("official-app resume refuses a source that is no longer covered by the current human-confirmed binding", async () => {
  const repository = fixtureRepository({ confirmedSource: null });
  assert.deepEqual(await service(repository).queueOfficialAppResume({
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID
  }), {
    status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.SOURCE_CAPTURE_NOT_CONFIRMED
  });
  assert.equal(repository.state.commands.length, 0);
});

test("human-bound official-app resume derives the current source only after the binding handle is accepted", async () => {
  const historicalPermit = Object.freeze({
    commandId: "legacy-terminal-command",
    sourceCaptureId: CAPTURE_ID,
    permitState: "DISPATCHED",
    permitContractVersion: 1,
    expiresAt: "2026-09-08T11:59:00.000Z"
  });
  const repository = fixtureRepository({ historicalPermits: [historicalPermit] });

  assert.deepEqual(await service(repository).queueOfficialAppResumeForHumanBinding({
    bindingId: BINDING_ID
  }), { status: TINDER_OFFICIAL_APP_RESUME_STATUS.QUEUED });

  assert.deepEqual(repository.state.commands, [{
    commandId: COMMAND_ID,
    deviceId: DEVICE_ID,
    commandType: TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE,
    payload: {},
    expiresAt: "2026-09-08T12:02:00.000Z"
  }]);
  assert.equal(repository.state.permits.length, 2);
  assert.equal(repository.state.permits[0], historicalPermit);
  assert.deepEqual(repository.state.permits[1], {
    commandId: COMMAND_ID,
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID,
    bindingId: BINDING_ID,
    bindingRevision: 3,
    permitContractVersion: TINDER_OFFICIAL_APP_RESUME_PERMIT_CONTRACT_VERSION,
    permitState: "ISSUED",
    expiresAt: "2026-09-08T12:02:00.000Z"
  });
  const deviceLookup = repository.state.calls.findIndex(call => call.type === "human-binding-device");
  const sourceLookup = repository.state.calls.findIndex(call => call.type === "confirmed-human-binding-source");
  assert.ok(deviceLookup >= 0 && sourceLookup > deviceLookup);
  assert.deepEqual(repository.state.calls[deviceLookup].input, { bindingId: BINDING_ID });
  assert.deepEqual(repository.state.calls[sourceLookup].input, { bindingId: BINDING_ID, deviceId: DEVICE_ID });
  assert.equal(JSON.stringify(repository.state.commands[0]).includes(CAPTURE_ID), false);
});

test("human-bound official-app resume rejects browser targeting and fails closed for absent or ambiguous current sources", async () => {
  const invalidRepository = fixtureRepository();
  for (const input of [
    {},
    { bindingId: BINDING_ID, captureId: CAPTURE_ID },
    { bindingId: BINDING_ID, deviceId: DEVICE_ID },
    { bindingId: BINDING_ID, threadFingerprint: "a".repeat(64) }
  ]) {
    await assert.rejects(
      () => service(invalidRepository).queueOfficialAppResumeForHumanBinding(input),
      error => error instanceof TinderOfficialAppResumeError
        && error.code === "INVALID_OFFICIAL_APP_RESUME_REQUEST"
    );
  }
  assert.equal(invalidRepository.state.transactions, 0);
  assert.equal(invalidRepository.state.commands.length, 0);

  for (const confirmedSourceForBinding of [null, []]) {
    const repository = fixtureRepository({ confirmedSourceForBinding });
    assert.deepEqual(await service(repository).queueOfficialAppResumeForHumanBinding({ bindingId: BINDING_ID }), {
      status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.RESUME_CONTEXT_UNAVAILABLE_OR_AMBIGUOUS
    });
    assert.equal(repository.state.commands.length, 0);
    assert.equal(repository.state.permits.length, 0);
  }

  const missingBinding = fixtureRepository({ humanBindingDeviceId: null });
  assert.deepEqual(await service(missingBinding).queueOfficialAppResumeForHumanBinding({ bindingId: BINDING_ID }), {
    status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.RESUME_CONTEXT_UNAVAILABLE_OR_AMBIGUOUS
  });
  assert.equal(missingBinding.state.calls.some(call => call.type === "confirmed-human-binding-source"), false);
});

test("official-app resume PostgreSQL adapter locks the current human-confirmed binding snapshot", async () => {
  const calls = [];
  const repository = createPgTinderOfficialAppResumeRepository({
    async connect() { throw new Error("not used by this focused repository query"); },
    async query() { throw new Error("not used by this focused repository query"); }
  });
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [{
        source_capture_id: CAPTURE_ID,
        binding_id: BINDING_ID,
        binding_revision: 3
      }] };
    }
  };
  assert.deepEqual(await repository.getConfirmedHumanArmedSourceForUpdate(client, {
    sourceCaptureId: CAPTURE_ID,
    deviceId: DEVICE_ID
  }), {
    source_capture_id: CAPTURE_ID,
    binding_id: BINDING_ID,
    binding_revision: 3
  });
  assert.match(calls[0].sql, /contact_human_armed_conversation_bindings/i);
  assert.match(calls[0].sql, /permit\.binding_revision\s*=\s*binding\.binding_revision/i);
  assert.match(calls[0].sql, /capture\.capture_revision\s*=\s*\(\s*SELECT MAX\(newer\.capture_revision\)/s);
  assert.match(calls[0].sql, /FOR UPDATE OF binding, permit, capture/i);
  assert.deepEqual(calls[0].parameters, [CAPTURE_ID, DEVICE_ID, "tinder_human_armed_conversation_v1"]);
});

test("human-bound resume repository resolves exactly one current source without ordering or browser-owned authority", async () => {
  const calls = [];
  const repository = createPgTinderOfficialAppResumeRepository({
    async connect() { throw new Error("not used by this focused repository query"); },
    async query() { throw new Error("not used by this focused repository query"); }
  });
  const client = {
    async query(sql, parameters) {
      calls.push({ sql: String(sql), parameters });
      if (String(sql).includes("SELECT device_id")) return { rows: [{ device_id: DEVICE_ID }] };
      return { rows: [{
        source_capture_id: CAPTURE_ID,
        binding_id: BINDING_ID,
        binding_revision: 3
      }] };
    }
  };
  assert.equal(await repository.findHumanArmedBindingDeviceId(client, { bindingId: BINDING_ID }), DEVICE_ID);
  assert.deepEqual(await repository.getConfirmedHumanArmedSourceForBindingForUpdate(client, {
    bindingId: BINDING_ID,
    deviceId: DEVICE_ID
  }), {
    source_capture_id: CAPTURE_ID,
    binding_id: BINDING_ID,
    binding_revision: 3
  });
  const sourceQuery = calls.at(-1);
  assert.match(sourceQuery.sql, /binding\.binding_id=\$1/i);
  assert.match(sourceQuery.sql, /binding\.device_id=\$2/i);
  assert.match(sourceQuery.sql, /permit\.binding_revision\s*=\s*binding\.binding_revision/i);
  assert.match(sourceQuery.sql, /LIMIT 2\s+FOR UPDATE OF binding, permit, capture/is);
  assert.doesNotMatch(sourceQuery.sql, /ORDER BY/i);
  assert.doesNotMatch(sourceQuery.sql, /visible_name|contact_name|captured_at/i);
  // The existing source contract may correlate to its latest stored capture
  // revision by the opaque runtime fingerprint; it never selects or returns
  // a source based on that value.
  assert.match(sourceQuery.sql, /capture\.capture_revision = \(\s*SELECT MAX\(newer\.capture_revision\)[\s\S]*?runtime_thread_fingerprint/s);
  assert.deepEqual(sourceQuery.parameters, [BINDING_ID, DEVICE_ID, "tinder_human_armed_conversation_v1"]);
});

test("a stale V2 reader tuple does not block a fresh launcher-only Resume permit", async () => {
  const calls = [];
  const repository = createPgTinderOfficialAppResumeRepository({
    async connect() { throw new Error("not used by this focused repository query"); },
    async query() { throw new Error("not used by this focused repository query"); }
  });
  const client = {
    async query(sql, parameters) {
      calls.push({ sql: String(sql), parameters });
      if (String(sql).includes("to_regclass")) {
        return { rows: [{ relation_name: "tinder_local_conversation_attestation_permits" }] };
      }
      return { rows: [{ active: false }] };
    }
  };
  assert.equal(await repository.findActiveVisibleChatSyncPermitForDevice(client, {
    deviceId: DEVICE_ID,
    now: NOW.toISOString()
  }), false);
  const sql = calls.at(-1).sql;
  // V1 remains a live conflict. V2 is one only when its proof *and* the
  // currently confirmed source tuple remain valid; a stale/rebound proof is
  // reader-denied elsewhere and must not strand launcher-only Resume.
  for (const required of [
    /sync_permit\.permit_contract_version=1/,
    /sync_permit\.permit_contract_version=2/,
    /attestation\.permit_state='ATTESTED'/,
    /binding\.binding_revision=sync_permit\.binding_revision/,
    /binding\.binding_state='CONFIRMED'/,
    /binding_permit\.consumed_capture_id=sync_permit\.source_capture_id/,
    /source_capture\.capture_revision = \(\s*SELECT MAX\(newer\.capture_revision\)/s
  ]) assert.match(sql, required);
});

test("official-app resume acknowledgement accepts only the exact dispatch receipt", () => {
  assert.equal(isExactOfficialAppResumeIntentDispatchedAcknowledgement(
    TINDER_OFFICIAL_APP_RESUME_ACK_RESULT
  ), true);
  assert.equal(isExactOfficialAppResumeIntentDispatchedAcknowledgement({
    official_tinder_app_resume: "INTENT_DISPATCHED",
    extra: true
  }), false);
  assert.equal(isExactOfficialAppResumeIntentDispatchedAcknowledgement({
    official_tinder_app_resume: "OPENED"
  }), false);
});
