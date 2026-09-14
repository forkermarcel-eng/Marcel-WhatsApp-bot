import assert from "node:assert/strict";
import test from "node:test";
import {
  projectTinderResumedForegroundChatReturnCommandAck,
  stageTinderResumedForegroundChatReturnAfterOfficialResumeAck
} from "../device-bridge/tinder-resumed-foreground-chat-return-command-ack.js";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const RESUME_ID = "22222222-2222-4222-8222-222222222222";
const RETURN_ID = "33333333-3333-4333-8333-333333333333";

const returnCommand = Object.freeze({
  command_id: RETURN_ID,
  device_id: DEVICE_ID,
  command_type: "RETURN_TINDER_RESUMED_FOREGROUND_CHAT_TO_INBOX",
  payload: {}
});

function projectionClient({ state = "ISSUED", deviceId = DEVICE_ID } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql, parameters = []) {
      const text = String(sql);
      queries.push({ text, parameters });
      if (text.startsWith("SELECT command_id")) {
        return { rows: [{ command_id: RETURN_ID, device_id: deviceId, permit_state: state }] };
      }
      if (text.startsWith("UPDATE tinder_resumed_foreground_chat_return_permits")) {
        return { rows: [{ command_id: RETURN_ID }] };
      }
      if (text.startsWith("INSERT INTO tinder_resumed_foreground_chat_return_audit")) return { rows: [] };
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    }
  };
}

function resumeStageClient() {
  const queries = [];
  return {
    queries,
    async query(sql, parameters = []) {
      const text = String(sql);
      queries.push({ text, parameters });
      if (text.startsWith("UPDATE tinder_resumed_foreground_chat_return_permits")) return { rows: [] };
      if (text.includes("FROM tinder_official_app_resume_permits resume")) {
        return { rows: [{ command_id: RESUME_ID, expires_at: "2099-09-14T10:01:00.000Z" }] };
      }
      if (text.includes("SELECT command_id FROM tinder_resumed_foreground_chat_return_permits")) {
        return { rows: [] };
      }
      if (text.includes("SELECT EXISTS") && text.includes("AS active")) return { rows: [{ active: false }] };
      if (text.startsWith("INSERT INTO device_bridge_commands")) return { rows: [{ command_id: parameters[0] }] };
      if (text.startsWith("INSERT INTO tinder_resumed_foreground_chat_return_permits")) {
        return { rows: [{ command_id: parameters[0] }] };
      }
      if (text.startsWith("INSERT INTO tinder_resumed_foreground_chat_return_audit")) return { rows: [{ audit_id: parameters[0] }] };
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    }
  };
}

test("V10 stages only after the exact terminal Resume ACK and writes no identity scope", async () => {
  const client = resumeStageClient();
  const result = await stageTinderResumedForegroundChatReturnAfterOfficialResumeAck(client, {
    command: { command_id: RESUME_ID, device_id: DEVICE_ID, command_type: "RESUME_OFFICIAL_TINDER_APP" },
    ack: { status: "SUCCEEDED", result: { official_tinder_app_resume: "INTENT_DISPATCHED" } },
    foundationReady: true
  });

  assert.deepEqual(result, { status: "QUEUED" });
  const queued = client.queries.find(query => query.text.startsWith("INSERT INTO device_bridge_commands"));
  assert.match(queued.text, /'\{\}'::jsonb/);
  assert.equal(queued.parameters.includes(RESUME_ID), false);
  assert.equal(queued.parameters.some(value => /binding|capture|thread|profile/i.test(String(value))), false);
  assert.equal(client.queries.some(query => query.text.startsWith("INSERT INTO tinder_resumed_foreground_chat_return_permits")), true);
  assert.equal(client.queries.some(query => query.text.startsWith("INSERT INTO tinder_resumed_foreground_chat_return_audit")), true);
});

test("V10 never stages for a non-exact Resume result or unavailable foundation", async () => {
  const client = resumeStageClient();
  const base = { command: { command_id: RESUME_ID, device_id: DEVICE_ID, command_type: "RESUME_OFFICIAL_TINDER_APP" } };
  assert.deepEqual(await stageTinderResumedForegroundChatReturnAfterOfficialResumeAck(client, {
    ...base,
    ack: { status: "SUCCEEDED", result: { official_tinder_app_resume: "INTENT_DISPATCHED" } },
    foundationReady: false
  }), { status: "FOUNDATION_NOT_READY" });
  assert.equal(client.queries.length, 0);

  assert.equal(await stageTinderResumedForegroundChatReturnAfterOfficialResumeAck(client, {
    ...base,
    ack: { status: "SUCCEEDED", result: { official_tinder_app_resume: "INTENT_DISPATCHED", extra: true } },
    foundationReady: true
  }), null);
  assert.equal(client.queries.length, 0);
});

test("V10 exact STAGED ACK changes only its issued permit and appends a content-free audit", async () => {
  const client = projectionClient();
  const result = await projectTinderResumedForegroundChatReturnCommandAck(client, {
    command: returnCommand,
    ack: {
      status: "SUCCEEDED",
      occurred_at: "2026-09-14T10:00:05.000Z",
      result: { tinder_resumed_foreground_chat_return: "STAGED" }
    }
  });
  assert.deepEqual(result, { state: "STAGED" });
  const update = client.queries.find(query => query.text.startsWith("UPDATE"));
  assert.match(update.text, /WHERE command_id=\$1 AND permit_state='ISSUED'/);
  assert.equal(update.text.includes("binding"), false);
  assert.equal(update.text.includes("capture"), false);
  const audit = client.queries.find(query => query.text.startsWith("INSERT INTO tinder_resumed_foreground_chat_return_audit"));
  assert.match(audit.text, /'\{\}'::jsonb/);
  assert.equal(audit.parameters.includes("RETURN_STAGED"), true);
});

test("V10 rejects a malformed success result before changing the permit", async () => {
  const client = projectionClient();
  await assert.rejects(
    projectTinderResumedForegroundChatReturnCommandAck(client, {
      command: returnCommand,
      ack: {
        status: "SUCCEEDED",
        occurred_at: "2026-09-14T10:00:05.000Z",
        result: { tinder_resumed_foreground_chat_return: "STAGED", extra: true }
      }
    }),
    error => error?.code === "TINDER_RESUMED_FOREGROUND_CHAT_RETURN_ACK_INVALID"
  );
  assert.equal(client.queries.filter(query => query.text.startsWith("UPDATE")).length, 0);
});

test("V10 terminal command failure cancels exactly once with a bounded reason", async () => {
  const client = projectionClient();
  const result = await projectTinderResumedForegroundChatReturnCommandAck(client, {
    command: returnCommand,
    ack: { status: "FAILED", occurred_at: "2026-09-14T10:00:05.000Z", result: null }
  });
  assert.deepEqual(result, { state: "CANCELLED" });
  assert.equal(client.queries.some(query => query.text.includes("terminal_reason")
    && query.parameters.includes("COMMAND_FAILED")), true);
});

test("V10 rejects a permit bound to another device before any terminal update", async () => {
  const client = projectionClient({ deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  await assert.rejects(
    projectTinderResumedForegroundChatReturnCommandAck(client, {
      command: returnCommand,
      ack: { status: "FAILED", occurred_at: "2026-09-14T10:00:05.000Z", result: null }
    }),
    error => error?.code === "TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_NOT_FOUND"
  );
  assert.equal(client.queries.filter(query => query.text.startsWith("UPDATE")).length, 0);
});
