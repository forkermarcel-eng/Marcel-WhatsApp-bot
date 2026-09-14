import assert from "node:assert/strict";
import test from "node:test";
import {
  createAuthenticatedTinderResumedForegroundChatReturnService,
  createTinderResumedForegroundChatReturnIngressHandler,
  parseSignedTinderResumedForegroundChatReturnRequest,
  TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PATH_SUFFIX
} from "../device-bridge/tinder-resumed-foreground-chat-return-ingress.js";
import { TinderResumedForegroundChatReturnError } from "../services/tinder-resumed-foreground-chat-return.js";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const COMMAND_ID = "44444444-4444-4444-8444-444444444444";

function request(value) {
  return { body: Buffer.from(JSON.stringify(value), "utf8") };
}

function response() {
  return {
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

const RECEIPT = Object.freeze({
  protocol_version: 1,
  tinder_resumed_foreground_chat_return: {
    schema_version: "tinder-resumed-foreground-chat-return-receipt-v1",
    command_id: COMMAND_ID,
    status: "RETURNED"
  }
});

test("V10 signed receipt grammar is exact, content-free, and has the fixed ingress suffix", () => {
  assert.equal(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PATH_SUFFIX, "/tinder-resumed-foreground-chat-returns");
  assert.deepEqual(parseSignedTinderResumedForegroundChatReturnRequest(request(RECEIPT)), {
    commandId: COMMAND_ID,
    status: "RETURNED"
  });
});

test("V10 signed receipt rejects identity, transcript, and arbitrary fields fail closed", () => {
  for (const extra of [
    { binding_id: "55555555-5555-4555-8555-555555555555" },
    { capture_id: "55555555-5555-4555-8555-555555555555" },
    { transcript: [] },
    { message: "not allowed" }
  ]) {
    assert.throws(() => parseSignedTinderResumedForegroundChatReturnRequest(request({
      ...RECEIPT,
      tinder_resumed_foreground_chat_return: {
        ...RECEIPT.tinder_resumed_foreground_chat_return,
        ...extra
      }
    })), error => error?.code === "INVALID_TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REQUEST");
  }
});

test("V10 authenticated receipt foundation drift rolls back before device/replay/receipt writes", async () => {
  const calls = [];
  const client = {
    async query(sql) { calls.push(String(sql)); return { rows: [] }; },
    release() { calls.push("RELEASE"); }
  };
  const repository = {
    async withTransaction(work) { return work(client); },
    async expireResumedForegroundChatReturnPermits() {},
    async findActiveHumanArmedPermitForDevice() { return false; },
    async findActiveVisibleChatSyncPermitForDevice() { return false; },
    async findActiveOfficialAppResumePermitForDevice() { return false; },
    async findActiveLocalConversationAttestationPermitForDevice() { return false; },
    async findActiveUnboundInboxConversationSweepForDevice() { return false; },
    async findActiveVerifiedChatReturnPermitForDevice() { return false; },
    async findActiveResumedForegroundChatReturnPermitForDevice() { return false; },
    async getTerminalOfficialAppResumeForUpdate() { return null; },
    async findResumedForegroundChatReturnForResumeForUpdate() { return null; },
    async queueResumedForegroundChatReturnCommand() {},
    async createResumedForegroundChatReturnPermit() {},
    async appendResumedForegroundChatReturnAudit() {},
    async getResumedForegroundChatReturnPermitForUpdate() { return null; },
    async revalidateResumedForegroundChatReturnPermitForUpdate() { return false; },
    async markResumedForegroundChatReturnReturned() {}
  };
  const service = createAuthenticatedTinderResumedForegroundChatReturnService(
    { async connect() { return client; } },
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID },
    {
      createRepository: () => repository,
      assertFoundationReady: async () => { throw new Error("catalog drift"); }
    }
  );

  await assert.rejects(
    service.acceptSignedReturnReceipt({ commandId: COMMAND_ID, deviceId: DEVICE_ID, status: "RETURNED" }),
    error => error?.code === "TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_NOT_READY"
  );
  assert.deepEqual(calls, ["BEGIN", "ROLLBACK", "RELEASE"]);
});

test("V10 ingress exposes only bounded accepted result and never forwards a raw receipt", async () => {
  let acceptedInput = null;
  const handler = createTinderResumedForegroundChatReturnIngressHandler({}, {
    now: () => new Date("2026-09-14T10:00:00.000Z"),
    async verifyRequest() {
      return { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID };
    },
    createAuthenticatedService() {
      return {
        async acceptSignedReturnReceipt(input) {
          acceptedInput = input;
          return { status: "ACCEPTED", ignored: "not exposed" };
        }
      };
    }
  });
  const req = {
    ...request(RECEIPT),
    params: { deviceId: DEVICE_ID },
    get(name) { return name === "x-marcel-request-id" ? REQUEST_ID : undefined; }
  };
  const res = response();
  await handler(req, res);
  assert.deepEqual(acceptedInput, { commandId: COMMAND_ID, deviceId: DEVICE_ID, status: "RETURNED" });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body.tinder_resumed_foreground_chat_return, { status: "ACCEPTED" });
  assert.equal(JSON.stringify(res.body).includes(COMMAND_ID), false);
  assert.equal(JSON.stringify(res.body).includes(DEVICE_ID), false);
});

test("V10 ingress maps a service rejection to its bounded code without a raw error", async () => {
  const handler = createTinderResumedForegroundChatReturnIngressHandler({}, {
    async verifyRequest() { return { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID }; },
    createAuthenticatedService() {
      return {
        async acceptSignedReturnReceipt() {
          throw new TinderResumedForegroundChatReturnError(
            "sensitive database detail", "PERMIT_RESUME_MISMATCH", 409
          );
        }
      };
    }
  });
  const req = {
    ...request(RECEIPT), params: { deviceId: DEVICE_ID },
    get(name) { return name === "x-marcel-request-id" ? REQUEST_ID : undefined; }
  };
  const res = response();
  await handler(req, res);
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.stringify(res.body).includes("sensitive database detail"), false);
});
