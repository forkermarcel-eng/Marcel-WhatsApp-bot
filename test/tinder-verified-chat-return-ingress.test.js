import assert from "node:assert/strict";
import test from "node:test";
import {
  createAuthenticatedTinderVerifiedChatReturnService,
  parseSignedTinderVerifiedChatReturnRequest,
  TINDER_VERIFIED_CHAT_RETURN_PATH_SUFFIX,
  TINDER_VERIFIED_CHAT_RETURN_RECEIPT_JSON_SHAPE
} from "../device-bridge/tinder-verified-chat-return-ingress.js";

const COMMAND_ID = "55555555-5555-4555-8555-555555555555";

function request(value) {
  return { body: Buffer.from(JSON.stringify(value), "utf8") };
}

test("V9 signed receipt grammar is exact and contains no durable scope facts", () => {
  assert.equal(TINDER_VERIFIED_CHAT_RETURN_PATH_SUFFIX, "/tinder-verified-chat-returns");
  assert.deepEqual(Object.keys(TINDER_VERIFIED_CHAT_RETURN_RECEIPT_JSON_SHAPE.tinder_verified_chat_return).sort(), ["command_id", "schema_version", "status"]);
  assert.deepEqual(parseSignedTinderVerifiedChatReturnRequest(request({
    protocol_version: 1,
    tinder_verified_chat_return: {
      schema_version: "tinder-verified-chat-return-receipt-v1",
      command_id: COMMAND_ID,
      status: "RETURNED"
    }
  })), { commandId: COMMAND_ID, status: "RETURNED" });
});

test("V9 signed receipt rejects scope/content fields fail closed", () => {
  assert.throws(() => parseSignedTinderVerifiedChatReturnRequest(request({
    protocol_version: 1,
    tinder_verified_chat_return: {
      schema_version: "tinder-verified-chat-return-receipt-v1",
      command_id: COMMAND_ID,
      status: "RETURNED",
      binding_revision: 7
    }
  })), error => error?.code === "INVALID_TINDER_VERIFIED_CHAT_RETURN_REQUEST");
});

test("V9 receipt foundation drift fails closed before any durable receipt operation", async () => {
  const calls = [];
  const client = {
    async query(sql) { calls.push(String(sql)); return { rows: [] }; },
    release() { calls.push("RELEASE"); }
  };
  const repository = {
    async withTransaction(work) { return work(client); },
    async withReadOnlyTransaction(work) { return work(client); },
    async expireVerifiedChatReturnPermits() {},
    async findActiveHumanArmedPermitForDevice() { return false; },
    async findActiveVisibleChatSyncPermitForDevice() { return false; },
    async findActiveOfficialAppResumePermitForDevice() { return false; },
    async findActiveLocalConversationAttestationPermitForDevice() { return false; },
    async findActiveUnboundInboxConversationSweepForDevice() { return false; },
    async findActiveVerifiedChatReturnPermitForDevice() { return false; },
    async getDispatchedOfficialAppResumeForUpdate() { return null; },
    async queueVerifiedChatReturnCommand() {},
    async createVerifiedChatReturnPermit() {},
    async appendVerifiedChatReturnAudit() {},
    async getVerifiedChatReturnPermitForUpdate() { return null; },
    async revalidateVerifiedChatReturnPermitForUpdate() { return false; },
    async markVerifiedChatReturnReturned() {},
    async findLatestVerifiedChatReturnForSourceReadOnly() { return null; }
  };
  const service = createAuthenticatedTinderVerifiedChatReturnService(
    { async connect() { return client; } },
    { deviceId: "11111111-1111-4111-8111-111111111111", keyId: "22222222-2222-4222-8222-222222222222", requestId: "33333333-3333-4333-8333-333333333333" },
    {
      createRepository: () => repository,
      assertFoundationReady: async () => { throw new Error("catalog drift"); }
    }
  );
  await assert.rejects(
    service.acceptSignedReturnReceipt({
      commandId: COMMAND_ID,
      deviceId: "11111111-1111-4111-8111-111111111111",
      status: "RETURNED"
    }),
    error => error?.code === "TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_NOT_READY"
  );
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK", "RELEASE"]);
});
