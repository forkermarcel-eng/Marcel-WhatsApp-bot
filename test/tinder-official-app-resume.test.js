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
  historicalPermits = [],
  confirmedSource = {
    source_capture_id: CAPTURE_ID,
    binding_id: BINDING_ID,
    binding_revision: 3
  }
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
    async getConfirmedHumanArmedSourceForUpdate(_transaction, input) {
      state.calls.push({ type: "confirmed-human-armed-source", input });
      return confirmedSource;
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
