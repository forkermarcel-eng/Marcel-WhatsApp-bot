import assert from "node:assert/strict";
import test from "node:test";
import { parseAndValidateCommandAck } from "../device-bridge/command-ack.js";
import { projectTinderVisibleChatSyncCommandAck } from "../device-bridge/tinder-visible-chat-sync-command-ack.js";
import { T4_DEVICE_CAPABILITIES } from "../device-bridge/protocol-v1.js";
import { TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE } from "../services/tinder-visible-chat-sync.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const COMMAND_ID = "2324a0db-c846-41f8-a9f5-3539ca83de00";
const NOW = "2026-09-07T12:00:00.000Z";

function ack(overrides = {}) {
  return {
    protocol_version: 1,
    command_id: COMMAND_ID,
    sent_at: NOW,
    status: "SUCCEEDED",
    occurred_at: NOW,
    result: { tinder_visible_chat_sync: "STAGED" },
    error: null,
    ...overrides
  };
}

function request(value) {
  return {
    body: Buffer.from(JSON.stringify(value), "utf8"),
    params: { commandId: COMMAND_ID },
    get(name) { return name === "x-marcel-timestamp" ? NOW : null; }
  };
}

function projectorClient({ permitState = "ISSUED" } = {}) {
  const state = { permitState, stagedAt: null, closedAt: null, calls: [] };
  return {
    state,
    async query(sql, values = []) {
      state.calls.push({ sql: String(sql), values });
      if (String(sql).includes("SELECT command_id, device_id, permit_state")) {
        return { rows: [{ command_id: COMMAND_ID, device_id: DEVICE_ID, permit_state: state.permitState }] };
      }
      if (String(sql).includes("UPDATE tinder_visible_chat_sync_permits")) {
        if (state.permitState !== "ISSUED") return { rows: [] };
        state.permitState = values[1];
        state.stagedAt = values[2];
        state.closedAt = values[3];
        return { rows: [{ command_id: COMMAND_ID }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

test("SYNC_TINDER_VISIBLE_CHAT accepts only an exact terminal STAGED acknowledgement", async () => {
  const parsed = parseAndValidateCommandAck(
    request(ack()),
    TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
    T4_DEVICE_CAPABILITIES
  );
  assert.deepEqual(parsed.result, { tinder_visible_chat_sync: "STAGED" });

  for (const result of [
    { tinder_visible_chat_sync: "COMPLETE" },
    { visible_chat_sync: "STAGED" },
    { tinder_visible_chat_sync: "STAGED", capture_id: COMMAND_ID },
    null
  ]) {
    assert.throws(
      () => parseAndValidateCommandAck(
        request(ack({ result })),
        TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
        T4_DEVICE_CAPABILITIES
      ),
      error => error.code === "INVALID_BODY"
    );
  }
});

test("a terminal staged ACK moves only its separate permit to STAGED", async () => {
  const client = projectorClient();
  const result = await projectTinderVisibleChatSyncCommandAck(client, {
    command: { command_id: COMMAND_ID, device_id: DEVICE_ID, command_type: TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE },
    ack: ack()
  });
  assert.deepEqual(result, { state: "STAGED" });
  assert.equal(client.state.permitState, "STAGED");
  assert.equal(client.state.stagedAt, NOW);
  assert.equal(client.state.closedAt, null);
  assert.equal(client.state.calls.some(call => /capture|identity|fingerprint|visible_name/i.test(call.sql)), false);
});

test("a non-success terminal ACK closes only its separate permit", async () => {
  const client = projectorClient();
  const result = await projectTinderVisibleChatSyncCommandAck(client, {
    command: { command_id: COMMAND_ID, device_id: DEVICE_ID, command_type: TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE },
    ack: ack({ status: "EXPIRED", result: null, error: null })
  });
  assert.deepEqual(result, { state: "CANCELLED" });
  assert.equal(client.state.permitState, "CANCELLED");
  assert.equal(client.state.stagedAt, null);
  assert.equal(client.state.closedAt, NOW);
  assert.equal(client.state.calls.some(call => /capture|identity|fingerprint|visible_name/i.test(call.sql)), false);
});

test("RECEIVED does not stage or complete a visible-chat sync permit", async () => {
  const client = projectorClient();
  const result = await projectTinderVisibleChatSyncCommandAck(client, {
    command: { command_id: COMMAND_ID, device_id: DEVICE_ID, command_type: TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE },
    ack: ack({ status: "RECEIVED", result: null, error: null })
  });
  assert.equal(result, null);
  assert.equal(client.state.permitState, "ISSUED");
  assert.equal(client.state.calls.length, 0);
});
