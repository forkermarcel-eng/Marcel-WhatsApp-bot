import assert from "node:assert/strict";
import test from "node:test";
import {
  projectTinderVerifiedChatReturnCommandAck,
  stageTinderVerifiedChatReturnAfterOfficialResumeAck
} from "../device-bridge/tinder-verified-chat-return-command-ack.js";

const COMMAND_ID = "55555555-5555-4555-8555-555555555555";
const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const BINDING_ID = "44444444-4444-4444-8444-444444444444";

function client({ state = "ISSUED" } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, parameters = []) {
      const text = String(sql);
      queries.push({ text, parameters });
      if (text.startsWith("SELECT command_id")) {
        return { rows: [{ command_id: COMMAND_ID, device_id: DEVICE_ID,
          binding_id: BINDING_ID, binding_revision: 7, permit_state: state }] };
      }
      if (text.startsWith("UPDATE tinder_verified_chat_return_permits")) {
        return { rows: [{ command_id: COMMAND_ID }] };
      }
      if (text.startsWith("INSERT INTO tinder_verified_chat_return_audit")) return { rows: [] };
      throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    }
  };
}

const command = Object.freeze({ command_id: COMMAND_ID, device_id: DEVICE_ID,
  command_type: "RETURN_TINDER_VERIFIED_CHAT_TO_INBOX", payload: {} });

function resumeStageClient() {
  const queries = [];
  return {
    queries,
    async query(sql, parameters = []) {
      const text = String(sql);
      queries.push({ text, parameters });
      if (text.startsWith("UPDATE tinder_verified_chat_return_permits")) return { rows: [] };
      if (text.includes("FROM tinder_official_app_resume_permits resume")) {
        return { rows: [{
          command_id: COMMAND_ID,
          source_capture_id: "33333333-3333-4333-8333-333333333333",
          binding_id: BINDING_ID,
          binding_revision: 7,
          expires_at: "2099-09-13T10:01:00.000Z"
        }] };
      }
      if (text.includes("SELECT EXISTS") && text.includes("AS active")) return { rows: [{ active: false }] };
      if (text.startsWith("INSERT INTO device_bridge_commands")) return { rows: [{ command_id: parameters[0] }] };
      if (text.startsWith("INSERT INTO tinder_verified_chat_return_permits")) return { rows: [{ command_id: parameters[0] }] };
      if (text.startsWith("INSERT INTO tinder_verified_chat_return_audit")) return { rows: [{ audit_id: parameters[0] }] };
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    }
  };
}

test("a precise terminal Resume ACK automatically creates one separately audited V9 authority", async () => {
  const value = resumeStageClient();
  const result = await stageTinderVerifiedChatReturnAfterOfficialResumeAck(value, {
    command: { command_id: COMMAND_ID, device_id: DEVICE_ID, command_type: "RESUME_OFFICIAL_TINDER_APP" },
    ack: { status: "SUCCEEDED", result: { official_tinder_app_resume: "INTENT_DISPATCHED" } },
    foundationReady: true
  });
  assert.deepEqual(result, { status: "QUEUED" });
  const queued = value.queries.find(query => query.text.startsWith("INSERT INTO device_bridge_commands"));
  assert.match(queued.text, /'\{\}'::jsonb/);
  assert.equal(queued.parameters.includes(BINDING_ID), false);
  assert.equal(queued.parameters.includes("33333333-3333-4333-8333-333333333333"), false);
  assert.equal(value.queries.some(query => query.text.startsWith("INSERT INTO tinder_verified_chat_return_permits")), true);
  assert.equal(value.queries.some(query => query.text.startsWith("INSERT INTO tinder_verified_chat_return_audit")), true);
});

test("a nonterminal or unavailable-foundation Resume ACK cannot create a V9 authority", async () => {
  const value = resumeStageClient();
  assert.equal(await stageTinderVerifiedChatReturnAfterOfficialResumeAck(value, {
    command: { command_id: COMMAND_ID, device_id: DEVICE_ID, command_type: "RESUME_OFFICIAL_TINDER_APP" },
    ack: { status: "SUCCEEDED", result: { official_tinder_app_resume: "INTENT_DISPATCHED" }, extra: true },
    foundationReady: false
  }).then(result => result.status), "FOUNDATION_NOT_READY");
  assert.equal(value.queries.length, 0);
  assert.equal(await stageTinderVerifiedChatReturnAfterOfficialResumeAck(value, {
    command: { command_id: COMMAND_ID, device_id: DEVICE_ID, command_type: "RESUME_OFFICIAL_TINDER_APP" },
    ack: {
      status: "SUCCEEDED",
      result: { official_tinder_app_resume: "INTENT_DISPATCHED", extra: true }
    },
    foundationReady: true
  }), null);
  assert.equal(value.queries.length, 0);
  assert.equal(await stageTinderVerifiedChatReturnAfterOfficialResumeAck(value, {
    command: { command_id: COMMAND_ID, device_id: DEVICE_ID, command_type: "RESUME_OFFICIAL_TINDER_APP" },
    ack: { status: "SUCCEEDED", result: { official_tinder_app_resume: "OPENED" } },
    foundationReady: true
  }), null);
  assert.equal(value.queries.length, 0);
});

test("V9 exact STAGED command ACK updates only its own permit and emits bounded audit", async () => {
  const value = client();
  const result = await projectTinderVerifiedChatReturnCommandAck(value, {
    command,
    ack: { status: "SUCCEEDED", occurred_at: "2026-09-13T10:00:05.000Z", result: { tinder_verified_chat_return: "STAGED" } }
  });
  assert.deepEqual(result, { state: "STAGED" });
  const update = value.queries.find(query => query.text.startsWith("UPDATE"));
  assert.match(update.text, /WHERE command_id=\$1 AND permit_state='ISSUED'/);
  assert.equal(update.text.includes("source_capture_id"), false);
  assert.equal(value.queries.some(query => query.parameters.includes("RETURN_STAGED")), true);
});

test("V9 rejects a non-exact success result before any permit update", async () => {
  const value = client();
  await assert.rejects(
    projectTinderVerifiedChatReturnCommandAck(value, {
      command,
      ack: { status: "SUCCEEDED", occurred_at: "2026-09-13T10:00:05.000Z", result: { tinder_verified_chat_return: "STAGED", extra: true } }
    }),
    error => error?.code === "TINDER_VERIFIED_CHAT_RETURN_ACK_INVALID"
  );
  assert.equal(value.queries.filter(query => query.text.startsWith("UPDATE")).length, 0);
});

test("V9 FAILED terminal ACK cancels with a bounded terminal reason", async () => {
  const value = client();
  const result = await projectTinderVerifiedChatReturnCommandAck(value, {
    command,
    ack: { status: "FAILED", occurred_at: "2026-09-13T10:00:05.000Z", result: null }
  });
  assert.deepEqual(result, { state: "CANCELLED" });
  assert.equal(value.queries.some(query => query.text.includes("terminal_reason") && query.parameters.includes("COMMAND_FAILED")), true);
});
