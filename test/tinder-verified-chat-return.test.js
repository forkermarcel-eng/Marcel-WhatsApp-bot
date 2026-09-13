import assert from "node:assert/strict";
import test from "node:test";
import {
  createPgTinderVerifiedChatReturnRepository,
  createTinderVerifiedChatReturnService,
  isExactVerifiedChatReturnStagedAcknowledgement,
  TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE
} from "../services/tinder-verified-chat-return.js";

const IDs = Object.freeze({
  device: "11111111-1111-4111-8111-111111111111",
  resume: "22222222-2222-4222-8222-222222222222",
  source: "33333333-3333-4333-8333-333333333333",
  binding: "44444444-4444-4444-8444-444444444444",
  command: "55555555-5555-4555-8555-555555555555",
  audit: "66666666-6666-4666-8666-666666666666"
});
const NOW = new Date("2026-09-13T10:00:00.000Z");

function repository({ conflict = false, valid = true } = {}) {
  const calls = [];
  let permit = null;
  return {
    calls,
    get permit() { return permit; },
    async withTransaction(work) { return work({}); },
    async withReadOnlyTransaction(work) { return work({}); },
    async expireVerifiedChatReturnPermits() { calls.push("expire"); },
    async findActiveHumanArmedPermitForDevice() { return false; },
    async findActiveVisibleChatSyncPermitForDevice() { return false; },
    async findActiveOfficialAppResumePermitForDevice() { return false; },
    async findActiveLocalConversationAttestationPermitForDevice() { return false; },
    async findActiveUnboundInboxConversationSweepForDevice() { return conflict; },
    async findActiveVerifiedChatReturnPermitForDevice() { return false; },
    async getDispatchedOfficialAppResumeForUpdate() {
      return { command_id: IDs.resume, source_capture_id: IDs.source, binding_id: IDs.binding,
        binding_revision: 7, expires_at: "2026-09-13T10:01:00.000Z" };
    },
    async queueVerifiedChatReturnCommand(_tx, command) { calls.push({ command }); },
    async createVerifiedChatReturnPermit(_tx, input) {
      permit = { command_id: input.commandId, device_id: input.deviceId, binding_id: input.bindingId,
        binding_revision: input.bindingRevision, permit_state: "ISSUED", expires_at: input.expiresAt };
      calls.push({ permit: input });
    },
    async appendVerifiedChatReturnAudit(_tx, audit) { calls.push({ audit }); },
    async getVerifiedChatReturnPermitForUpdate(_tx, commandId) {
      return permit?.command_id === commandId ? permit : null;
    },
    async revalidateVerifiedChatReturnPermitForUpdate() { return valid; },
    async markVerifiedChatReturnReturned(_tx, { commandId }) {
      assert.equal(commandId, permit.command_id);
      permit.permit_state = "RETURNED";
    },
    async findLatestVerifiedChatReturnForSourceReadOnly() { return permit; }
  };
}

test("V9 stages a new separately audited empty-payload command only from dispatched Resume facts", async () => {
  const repo = repository();
  const service = createTinderVerifiedChatReturnService(repo, {
    now: () => NOW,
    createCommandId: () => IDs.command,
    createAuditId: () => IDs.audit
  });
  const result = await service.stageVerifiedChatReturnForDispatchedResume({}, {
    deviceId: IDs.device, resumeCommandId: IDs.resume
  });
  assert.deepEqual(result, { status: "QUEUED" });
  const command = repo.calls.find(call => call.command)?.command;
  assert.deepEqual(command.payload, {});
  assert.equal(command.commandType, TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE);
  assert.equal(command.expiresAt, "2026-09-13T10:01:00.000Z");
  assert.equal(Object.keys(command).includes("bindingId"), false);
  assert.equal(Object.keys(command).includes("sourceCaptureId"), false);
  const audit = repo.calls.find(call => call.audit)?.audit;
  assert.equal(audit.action, "RETURN_ISSUED");
  assert.deepEqual(audit.details, {});
});

test("V9 does not issue a return authority while an incompatible active authority exists", async () => {
  const repo = repository({ conflict: true });
  const service = createTinderVerifiedChatReturnService(repo, { now: () => NOW });
  const result = await service.stageVerifiedChatReturnForDispatchedResume({}, {
    deviceId: IDs.device, resumeCommandId: IDs.resume
  });
  assert.deepEqual(result, { status: "PERMIT_CONFLICT", reasonCode: "UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE" });
  assert.equal(repo.calls.some(call => call.command), false);
});

test("V9 receipt revalidates durable facts before terminal RETURNED", async () => {
  const repo = repository();
  const service = createTinderVerifiedChatReturnService(repo, {
    now: () => NOW,
    createCommandId: () => IDs.command,
    createAuditId: () => IDs.audit
  });
  await service.stageVerifiedChatReturnForDispatchedResume({}, { deviceId: IDs.device, resumeCommandId: IDs.resume });
  repo.permit.permit_state = "STAGED";
  const result = await service.acceptSignedReturnReceipt({
    commandId: IDs.command, deviceId: IDs.device, status: "RETURNED"
  });
  assert.deepEqual(result, { status: "ACCEPTED" });
  assert.equal(repo.permit.permit_state, "RETURNED");
});

test("V9 receipt fails closed when current binding facts no longer revalidate", async () => {
  const repo = repository({ valid: false });
  const service = createTinderVerifiedChatReturnService(repo, {
    now: () => NOW,
    createCommandId: () => IDs.command,
    createAuditId: () => IDs.audit
  });
  await service.stageVerifiedChatReturnForDispatchedResume({}, { deviceId: IDs.device, resumeCommandId: IDs.resume });
  repo.permit.permit_state = "STAGED";
  await assert.rejects(
    service.acceptSignedReturnReceipt({ commandId: IDs.command, deviceId: IDs.device, status: "RETURNED" }),
    error => error?.code === "CURRENT_BINDING_INVALID"
  );
  assert.equal(repo.permit.permit_state, "STAGED");
});

test("V9 receipt rejects after the capped Resume parent expiry without reopening the child", async () => {
  let currentTime = NOW;
  const repo = repository();
  const service = createTinderVerifiedChatReturnService(repo, {
    now: () => currentTime,
    createCommandId: () => IDs.command,
    createAuditId: () => IDs.audit
  });
  await service.stageVerifiedChatReturnForDispatchedResume({}, {
    deviceId: IDs.device, resumeCommandId: IDs.resume
  });
  // The child was capped to the exact parent expiry, rather than receiving
  // an independently renewable window.
  assert.equal(repo.permit.expires_at, "2026-09-13T10:01:00.000Z");
  repo.permit.permit_state = "STAGED";
  currentTime = new Date("2026-09-13T10:01:00.000Z");
  await assert.rejects(
    service.acceptSignedReturnReceipt({
      commandId: IDs.command, deviceId: IDs.device, status: "RETURNED"
    }),
    error => error?.code === "PERMIT_EXPIRED"
  );
  // Receipt cannot turn an expired child into RETURNED; heartbeat owns the
  // separate immutable EXPIRED transition and content-free expiry audit.
  assert.equal(repo.permit.permit_state, "STAGED");
});

test("V9 heartbeat terminalization is parent-independent and writes only a bounded expiry audit", async () => {
  const queries = [];
  const pgRepository = createPgTinderVerifiedChatReturnRepository({
    async connect() { throw new Error("not used by direct repository method"); },
    async query() { throw new Error("not used by direct repository method"); }
  });
  const client = {
    async query(sql, parameters = []) {
      const text = String(sql);
      queries.push({ text, parameters });
      if (text.startsWith("UPDATE tinder_verified_chat_return_permits")) {
        return { rows: [{
          command_id: IDs.command,
          device_id: IDs.device,
          binding_id: IDs.binding,
          binding_revision: 7
        }] };
      }
      if (text.startsWith("INSERT INTO tinder_verified_chat_return_audit")) {
        return { rows: [{ audit_id: IDs.audit }] };
      }
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    }
  };
  const expired = await pgRepository.expireVerifiedChatReturnPermits(client, {
    deviceId: IDs.device,
    expiredAt: "2026-09-13T10:01:00.000Z"
  });
  assert.equal(expired, 1);
  const transition = queries[0];
  assert.match(transition.text, /permit_state='EXPIRED'/);
  assert.doesNotMatch(transition.text, /tinder_official_app_resume_permits|resume_command_id/i);
  const audit = queries[1];
  assert.match(audit.text, /'RETURN_EXPIRED','PERMIT_EXPIRED','SERVER','EXPIRY'/);
  assert.equal(JSON.stringify(audit.parameters).match(/source_capture|fingerprint|message|secret|token/i), null);
});

test("V9 staged command ACK result is exact and content-free", () => {
  assert.equal(isExactVerifiedChatReturnStagedAcknowledgement({ tinder_verified_chat_return: "STAGED" }), true);
  assert.equal(isExactVerifiedChatReturnStagedAcknowledgement({ tinder_verified_chat_return: "STAGED", extra: true }), false);
  assert.equal(isExactVerifiedChatReturnStagedAcknowledgement({ tinder_verified_chat_return: "RETURNED" }), false);
});
