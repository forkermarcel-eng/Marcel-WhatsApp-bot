import assert from "node:assert/strict";
import test from "node:test";
import {
  createTinderResumedForegroundChatReturnService,
  isExactResumedForegroundChatReturnStagedAcknowledgement,
  TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE
} from "../services/tinder-resumed-foreground-chat-return.js";

const IDS = Object.freeze({
  device: "11111111-1111-4111-8111-111111111111",
  resume: "22222222-2222-4222-8222-222222222222",
  command: "33333333-3333-4333-8333-333333333333",
  audit: "44444444-4444-4444-8444-444444444444"
});
const NOW = new Date("2026-09-14T10:00:00.000Z");

function repository({
  activeV9 = false,
  valid = true,
  expiresAt = "2026-09-14T10:01:00.000Z",
  existingChild = false,
  activeMethod = null
} = {}) {
  const calls = [];
  let permit = null;
  return {
    calls,
    get permit() { return permit; },
    async withTransaction(work) { return work({}); },
    async expireResumedForegroundChatReturnPermits() { calls.push("expire"); return 0; },
    async findActiveHumanArmedPermitForDevice() { return activeMethod === "human"; },
    async findActiveVisibleChatSyncPermitForDevice() { return activeMethod === "visible"; },
    async findActiveOfficialAppResumePermitForDevice() { return activeMethod === "resume"; },
    async findActiveLocalConversationAttestationPermitForDevice() { return activeMethod === "attestation"; },
    async findActiveUnboundInboxConversationSweepForDevice() { return activeMethod === "sweep"; },
    async findActiveVerifiedChatReturnPermitForDevice() { return activeV9; },
    async findActiveResumedForegroundChatReturnPermitForDevice() { return false; },
    async getTerminalOfficialAppResumeForUpdate() {
      return { command_id: IDS.resume, expires_at: expiresAt };
    },
    async findResumedForegroundChatReturnForResumeForUpdate() { return existingChild ? { command_id: IDS.command } : null; },
    async queueResumedForegroundChatReturnCommand(_transaction, command) {
      calls.push({ command });
    },
    async createResumedForegroundChatReturnPermit(_transaction, input) {
      permit = {
        command_id: input.commandId,
        device_id: input.deviceId,
        resume_command_id: input.resumeCommandId,
        permit_state: "ISSUED",
        expires_at: input.expiresAt
      };
      calls.push({ permit: input });
    },
    async appendResumedForegroundChatReturnAudit(_transaction, audit) {
      calls.push({ audit });
    },
    async getResumedForegroundChatReturnPermitForUpdate(_transaction, commandId) {
      return permit?.command_id === commandId ? permit : null;
    },
    async revalidateResumedForegroundChatReturnPermitForUpdate() { return valid; },
    async markResumedForegroundChatReturnReturned(_transaction, { commandId }) {
      assert.equal(commandId, permit.command_id);
      permit.permit_state = "RETURNED";
    }
  };
}

function service(repositoryValue, now = () => NOW) {
  return createTinderResumedForegroundChatReturnService(repositoryValue, {
    now,
    createCommandId: () => IDS.command,
    createAuditId: () => IDS.audit
  });
}

test("V10 creates one exact empty-payload identity-free child of a terminal Resume", async () => {
  const repo = repository();
  const result = await service(repo).stageResumedForegroundChatReturnForDispatchedResume({}, {
    deviceId: IDS.device,
    resumeCommandId: IDS.resume
  });
  assert.deepEqual(result, { status: "QUEUED" });
  const command = repo.calls.find(value => value.command)?.command;
  assert.equal(command.commandType, TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE);
  assert.deepEqual(command.payload, {});
  assert.equal(command.expiresAt, "2026-09-14T10:01:00.000Z");
  assert.deepEqual(Object.keys(command).sort(), ["commandId", "commandType", "deviceId", "expiresAt", "payload"]);
  const permit = repo.calls.find(value => value.permit)?.permit;
  assert.deepEqual(Object.keys(permit).sort(), [
    "commandId", "deviceId", "expiresAt", "permitContractVersion", "resumeCommandId"
  ]);
  const audit = repo.calls.find(value => value.audit)?.audit;
  assert.equal(audit.action, "RETURN_ISSUED");
  assert.deepEqual(audit.details, {});
});

test("V10 blocks a live V9 authority rather than issuing a sibling child", async () => {
  const repo = repository({ activeV9: true });
  const result = await service(repo).stageResumedForegroundChatReturnForDispatchedResume({}, {
    deviceId: IDS.device,
    resumeCommandId: IDS.resume
  });
  assert.deepEqual(result, {
    status: "PERMIT_CONFLICT",
    reasonCode: "VERIFIED_CHAT_RETURN_PERMIT_ACTIVE"
  });
  assert.equal(repo.calls.some(value => value.command), false);
});

test("V10 preserves one-child-per-Resume immutability before any new command write", async () => {
  const repo = repository({ existingChild: true });
  const result = await service(repo).stageResumedForegroundChatReturnForDispatchedResume({}, {
    deviceId: IDS.device,
    resumeCommandId: IDS.resume
  });
  assert.deepEqual(result, {
    status: "PERMIT_NOT_AVAILABLE",
    reasonCode: "RESUME_NOT_DISPATCHED"
  });
  assert.equal(repo.calls.some(value => value.command), false);
});

test("V10 blocks each active incompatible authority before issuing a generic return permit", async () => {
  const cases = [
    ["human", "HUMAN_ARMED_PERMIT_ACTIVE"],
    ["visible", "VISIBLE_CHAT_SYNC_PERMIT_ACTIVE"],
    ["resume", "RESUME_PERMIT_ACTIVE"],
    ["attestation", "LOCAL_CONVERSATION_ATTESTATION_ACTIVE"],
    ["sweep", "UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE"]
  ];
  for (const [activeMethod, reasonCode] of cases) {
    const repo = repository({ activeMethod });
    const result = await service(repo).stageResumedForegroundChatReturnForDispatchedResume({}, {
      deviceId: IDS.device,
      resumeCommandId: IDS.resume
    });
    assert.deepEqual(result, { status: "PERMIT_CONFLICT", reasonCode });
    assert.equal(repo.calls.some(value => value.command), false);
  }
});

test("V10 classifies an exact expired Resume parent before any command write", async () => {
  const repo = repository({ expiresAt: "2026-09-14T10:00:00.000Z" });
  const result = await service(repo).stageResumedForegroundChatReturnForDispatchedResume({}, {
    deviceId: IDS.device,
    resumeCommandId: IDS.resume
  });
  assert.deepEqual(result, { status: "PERMIT_NOT_AVAILABLE", reasonCode: "RESUME_EXPIRED" });
  assert.equal(repo.calls.some(value => value.command), false);
});

test("V10 receipt revalidates only its durable Resume/device scope before RETURNED", async () => {
  const repo = repository();
  const instance = service(repo);
  await instance.stageResumedForegroundChatReturnForDispatchedResume({}, {
    deviceId: IDS.device,
    resumeCommandId: IDS.resume
  });
  repo.permit.permit_state = "STAGED";
  assert.deepEqual(await instance.acceptSignedReturnReceipt({
    commandId: IDS.command,
    deviceId: IDS.device,
    status: "RETURNED"
  }), { status: "ACCEPTED" });
  assert.equal(repo.permit.permit_state, "RETURNED");
});

test("V10 rejects a stale current Resume scope without changing its staged permit", async () => {
  const repo = repository({ valid: false });
  const instance = service(repo);
  await instance.stageResumedForegroundChatReturnForDispatchedResume({}, {
    deviceId: IDS.device,
    resumeCommandId: IDS.resume
  });
  repo.permit.permit_state = "STAGED";
  await assert.rejects(
    instance.acceptSignedReturnReceipt({
      commandId: IDS.command,
      deviceId: IDS.device,
      status: "RETURNED"
    }),
    error => error?.code === "PERMIT_RESUME_MISMATCH"
  );
  assert.equal(repo.permit.permit_state, "STAGED");
});

test("V10 receipt rejects non-staged and already terminal permits without a transition", async () => {
  const repo = repository();
  const instance = service(repo);
  await instance.stageResumedForegroundChatReturnForDispatchedResume({}, {
    deviceId: IDS.device,
    resumeCommandId: IDS.resume
  });
  await assert.rejects(
    instance.acceptSignedReturnReceipt({ commandId: IDS.command, deviceId: IDS.device, status: "RETURNED" }),
    error => error?.code === "PERMIT_NOT_STAGED"
  );
  assert.equal(repo.permit.permit_state, "ISSUED");
  repo.permit.permit_state = "RETURNED";
  await assert.rejects(
    instance.acceptSignedReturnReceipt({ commandId: IDS.command, deviceId: IDS.device, status: "RETURNED" }),
    error => error?.code === "RETURN_ALREADY_TERMINAL"
  );
  assert.equal(repo.permit.permit_state, "RETURNED");
});

test("V10 receipt rejects a mismatched device without modifying the staged permit", async () => {
  const repo = repository();
  const instance = service(repo);
  await instance.stageResumedForegroundChatReturnForDispatchedResume({}, {
    deviceId: IDS.device,
    resumeCommandId: IDS.resume
  });
  repo.permit.permit_state = "STAGED";
  await assert.rejects(
    instance.acceptSignedReturnReceipt({
      commandId: IDS.command,
      deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "RETURNED"
    }),
    error => error?.code === "PERMIT_DEVICE_MISMATCH"
  );
  assert.equal(repo.permit.permit_state, "STAGED");
});

test("V10 STAGED acknowledgement has a single content-free exact form", () => {
  assert.equal(isExactResumedForegroundChatReturnStagedAcknowledgement({
    tinder_resumed_foreground_chat_return: "STAGED"
  }), true);
  assert.equal(isExactResumedForegroundChatReturnStagedAcknowledgement({
    tinder_resumed_foreground_chat_return: "STAGED",
    identity: "not-allowed"
  }), false);
});
