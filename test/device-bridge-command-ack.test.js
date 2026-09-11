import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  commandAckSemanticHash,
  createCommandAckHandler,
  parseAndValidateCommandAck,
  processCommandAckTransaction,
  TINDER_OFFICIAL_APP_RESUME_BLOCKED_ERROR,
  TINDER_OFFICIAL_APP_RESUME_OUTCOME_UNRESOLVED_ERROR,
  TINDER_WRITER_NOT_IMPLEMENTED_ERROR
} from "../device-bridge/command-ack.js";
import {
  T0_DEVICE_CAPABILITIES,
  T1_DEVICE_CAPABILITIES,
  T2_DEVICE_CAPABILITIES,
  T4_DEVICE_CAPABILITIES,
  T4_RESUME_DEVICE_CAPABILITIES,
  T4_RESUME_ATTESTATION_DEVICE_CAPABILITIES,
  T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES,
  T5_DEVICE_CAPABILITIES,
  canonicalRequest,
  sha256Hex
} from "../device-bridge/protocol-v1.js";
import {
  TINDER_SEND_COMMAND_TYPE,
  TINDER_SEND_INTENT_STATE
} from "../services/tinder-manual-send.js";

const NOW = new Date("2026-09-01T12:34:56.000Z");
const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const KEY_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const COMMAND_ID = "2324a0db-c846-41f8-a9f5-3539ca83de00";
const REQUEST_ID = "d2675347-0888-4548-9feb-ae4d71a972cf";

function ackPayload(status, overrides = {}) {
  const defaults = {
    RECEIVED: { result: null, error: null },
    SUCCEEDED: { result: { pong: true }, error: null },
    FAILED: { result: null, error: { code: "COMMAND_EXECUTION_FAILED", message: "Execution failed" } },
    REJECTED: { result: null, error: null },
    EXPIRED: { result: null, error: null }
  }[status];
  return {
    protocol_version: 1,
    command_id: COMMAND_ID,
    sent_at: NOW.toISOString(),
    status,
    occurred_at: NOW.toISOString(),
    ...defaults,
    ...overrides
  };
}

function manualGateAckPayload(type, status, overrides = {}) {
  const result = type === "CONNECT_TINDER"
    ? { tinder_state: "CONNECTED" }
    : type === "DISCONNECT_TINDER"
    ? { tinder_state: "DISCONNECTED" }
    : { conversation_binding_permit: "ARMED" };
  return ackPayload(status, {
    ...(status === "SUCCEEDED" ? { result } : {}),
    ...overrides
  });
}

function visibleChatSyncAckPayload(status, overrides = {}) {
  return ackPayload(status, {
    ...(status === "SUCCEEDED" ? { result: { tinder_visible_chat_sync: "STAGED" } } : {}),
    ...overrides
  });
}

function officialAppResumeAckPayload(status, overrides = {}) {
  return ackPayload(status, {
    ...(status === "SUCCEEDED" ? { result: { official_tinder_app_resume: "INTENT_DISPATCHED" } } : {}),
    ...overrides
  });
}

function ackRequest(payload = ackPayload("RECEIVED"), { requestId = REQUEST_ID, keys, now = NOW } = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const hash = sha256Hex(body);
  const path = `/device-bridge/v1/devices/${DEVICE_ID}/commands/${COMMAND_ID}/ack`;
  const pair = keys || crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const canonical = canonicalRequest({ protocolVersion: 1, method: "POST", path, timestamp: now.toISOString(), requestId, contentSha256: hash });
  const headers = {
    "x-marcel-protocol-version": "1", "x-marcel-device-id": DEVICE_ID,
    "x-marcel-key-id": KEY_ID, "x-marcel-timestamp": now.toISOString(),
    "x-marcel-request-id": requestId, "x-marcel-content-sha256": hash,
    "x-marcel-signature": crypto.sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64url")
  };
  return {
    req: { method: "POST", originalUrl: path, body, params: { deviceId: DEVICE_ID, commandId: COMMAND_ID }, get: name => headers[name.toLowerCase()] },
    keys: pair,
    hash,
    headers
  };
}

function responseRecorder() {
  return { statusCode: null, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}

function historyRow(ack) {
  return { status: ack.status, occurred_at: ack.occurred_at, result: ack.result, error: ack.error, body_sha256: commandAckSemanticHash(ack), accepted_at: NOW };
}

function ackPool({ request, history = [], terminalStatus = null, commandDeviceId = DEVICE_ID,
  commandType = "PING", revision = 1, deviceRevision = 1, expiresAt = new Date(NOW.valueOf() + 60_000),
  deviceState = "ACTIVE", deviceRevoked = false, keyRevoked = false, missingCommand = false,
  nonceReplay = false, failAudit = false, capabilities = T0_DEVICE_CAPABILITIES,
  commandPayload = {}, tinderIntent = null, visibleChatSyncPermit = null,
  officialAppResumePermit = null, attestationBootstrap = null } = {}) {
  const calls = [];
  const state = {
    nonce: 0, ackInserts: 0, commandUpdates: 0, audits: 0, commits: 0, rollbacks: 0,
    tinderIntent: tinderIntent ? { ...tinderIntent } : null, tinderIntentUpdates: 0, tinderAudits: 0,
    visibleChatSyncPermit: visibleChatSyncPermit ? { ...visibleChatSyncPermit } : null,
    visibleChatSyncPermitUpdates: 0,
    officialAppResumePermit: officialAppResumePermit ? { ...officialAppResumePermit } : null,
    officialAppResumePermitUpdates: 0
  };
  const authRow = {
    device_id: DEVICE_ID, key_id: KEY_ID, enrollment_state: "ACTIVE", device_revoked_at: null,
    key_revoked_at: null, public_key_spki_der: request?.keys.publicKey.export({ type: "spki", format: "der" })
  };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "COMMIT") { state.commits += 1; return { rows: [] }; }
      if (sql === "ROLLBACK") { state.rollbacks += 1; return { rows: [] }; }
      if (sql.includes("FROM device_bridge_devices d") && sql.includes("FOR UPDATE")) return { rows: [{
        device_id: DEVICE_ID, enrollment_state: deviceState, revoked_at: deviceRevoked ? NOW : null,
        configuration_revision: deviceRevision, capabilities,
        key_id: KEY_ID, key_revoked_at: keyRevoked ? NOW : null
      }] };
      if (sql.includes("INSERT INTO device_bridge_request_nonces")) {
        if (nonceReplay) { const error = new Error("duplicate"); error.code = "23505"; throw error; }
        state.nonce += 1; return { rows: [] };
      }
      if (sql.includes("SELECT command_type, payload") && sql.includes("FROM device_bridge_commands")) {
        return { rows: attestationBootstrap ? [attestationBootstrap] : [] };
      }
      if (sql.includes("FROM device_bridge_commands") && sql.includes("FOR UPDATE")) return { rows: missingCommand ? [] : [{
        command_id: COMMAND_ID, device_id: commandDeviceId, command_type: commandType,
        payload: commandPayload,
        configuration_revision: revision, issued_at: new Date(NOW.valueOf() - 60_000),
        expires_at: expiresAt, terminal_status: terminalStatus, terminal_at: terminalStatus ? NOW : null
      }] };
      if (sql.includes("FROM device_bridge_command_acks")) return { rows: history };
      if (sql.includes("INSERT INTO device_bridge_command_acks")) { state.ackInserts += 1; return { rows: [] }; }
      if (sql.includes("UPDATE device_bridge_commands")) { state.commandUpdates += 1; return { rows: [] }; }
      if (sql.includes("FROM tinder_visible_chat_sync_permits") && sql.includes("FOR UPDATE")) {
        return { rows: state.visibleChatSyncPermit ? [{ ...state.visibleChatSyncPermit }] : [] };
      }
      if (sql.includes("UPDATE tinder_visible_chat_sync_permits")) {
        if (!state.visibleChatSyncPermit || state.visibleChatSyncPermit.permit_state !== "ISSUED") return { rows: [] };
        state.visibleChatSyncPermit.permit_state = params[1];
        state.visibleChatSyncPermit.staged_at = params[2];
        state.visibleChatSyncPermit.closed_at = params[3];
        state.visibleChatSyncPermitUpdates += 1;
        return { rows: [{ command_id: COMMAND_ID }] };
      }
      if (sql.includes("FROM tinder_official_app_resume_permits") && sql.includes("FOR UPDATE")) {
        return { rows: state.officialAppResumePermit ? [{ ...state.officialAppResumePermit }] : [] };
      }
      if (sql.includes("UPDATE tinder_official_app_resume_permits")) {
        if (!state.officialAppResumePermit || state.officialAppResumePermit.permit_state !== "ISSUED") return { rows: [] };
        state.officialAppResumePermit.permit_state = params[1];
        state.officialAppResumePermit.dispatched_at = params[2];
        state.officialAppResumePermit.closed_at = params[3];
        state.officialAppResumePermitUpdates += 1;
        return { rows: [{ command_id: COMMAND_ID }] };
      }
      if (sql.includes("FROM tinder_reply_send_intents") && sql.includes("FOR UPDATE")) {
        return { rows: state.tinderIntent ? [{ ...state.tinderIntent }] : [] };
      }
      if (sql.includes("UPDATE tinder_reply_send_intents")) {
        if (!state.tinderIntent) return { rows: [] };
        state.tinderIntent.state = params[1];
        state.tinderIntent.received_at = params[2];
        state.tinderIntent.completed_at = params[3];
        state.tinderIntent.result_code = params[4];
        state.tinderIntentUpdates += 1;
        return { rows: [{ intent_id: state.tinderIntent.intent_id }] };
      }
      if (sql.includes("INSERT INTO tinder_reply_send_audit")) { state.tinderAudits += 1; return { rows: [] }; }
      if (sql.includes("INSERT INTO device_bridge_audit_events")) {
        if (failAudit) throw new Error("simulated audit failure");
        state.audits += 1; return { rows: [] };
      }
      return { rows: [] };
    },
    release() { state.released = true; }
  };
  return {
    pool: {
      async query(sql) { return sql.includes("LEFT JOIN device_bridge_keys") ? { rows: [authRow] } : { rows: [] }; },
      async connect() { return client; }
    },
    calls,
    state
  };
}

function auth(requestId = REQUEST_ID, hash = "a".repeat(64)) {
  return { deviceId: DEVICE_ID, keyId: KEY_ID, requestId, contentSha256: hash };
}

test("valid RECEIVED is accepted and remains non-terminal", async () => {
  const ack = ackPayload("RECEIVED");
  const fake = ackPool();
  const response = await processCommandAckTransaction(fake.pool, auth(), ack, NOW);
  assert.equal(response.status, "RECEIVED");
  assert.equal(fake.state.ackInserts, 1);
  assert.equal(fake.state.commandUpdates, 0);
  assert.equal(fake.state.audits, 1);
});

test("RECEIVED transitions to SUCCEEDED and FAILED", async () => {
  for (const status of ["SUCCEEDED", "FAILED"]) {
    const received = ackPayload("RECEIVED");
    const ack = ackPayload(status);
    const fake = ackPool({ history: [historyRow(received)] });
    await processCommandAckTransaction(fake.pool, auth(), ack, NOW);
    assert.equal(fake.state.commandUpdates, 1);
    assert.equal(fake.state.commits, 1);
  }
});

test("T1 CONNECT_TINDER and DISCONNECT_TINDER use exact terminal results after RECEIVED", async () => {
  for (const type of ["CONNECT_TINDER", "DISCONNECT_TINDER"]) {
    const received = manualGateAckPayload(type, "RECEIVED");
    const succeeded = manualGateAckPayload(type, "SUCCEEDED");
    const fake = ackPool({
      commandType: type,
      capabilities: T1_DEVICE_CAPABILITIES,
      history: [historyRow(received)]
    });
    const response = await processCommandAckTransaction(fake.pool, auth(), succeeded, NOW);
    assert.equal(response.status, "SUCCEEDED");
    assert.equal(fake.state.commandUpdates, 1);
    assert.equal(fake.state.audits, 1);
  }
});

test("T1 command acknowledgement rejects incompatible devices and malformed success results", async () => {
  await assert.rejects(
    () => processCommandAckTransaction(
      ackPool({ commandType: "CONNECT_TINDER", capabilities: T0_DEVICE_CAPABILITIES }).pool,
      auth(),
      manualGateAckPayload("CONNECT_TINDER", "RECEIVED"),
      NOW
    ),
    error => error.code === "DEVICE_CAPABILITY_UNSUPPORTED"
  );

  assert.doesNotThrow(() => parseAndValidateCommandAck(
    ackRequest(manualGateAckPayload("CONNECT_TINDER", "SUCCEEDED")).req,
    "CONNECT_TINDER",
    T1_DEVICE_CAPABILITIES
  ));
  for (const [type, result] of [
    ["CONNECT_TINDER", null],
    ["CONNECT_TINDER", { tinder_state: "DISCONNECTED" }],
    ["DISCONNECT_TINDER", { tinder_state: "CONNECTED" }],
    ["DISCONNECT_TINDER", { tinder_state: "DISCONNECTED", injected: true }]
  ]) {
    assert.throws(() => parseAndValidateCommandAck(
      ackRequest(manualGateAckPayload(type, "SUCCEEDED", { result })).req,
      type,
      T1_DEVICE_CAPABILITIES
    ), error => error.code === "INVALID_BODY");
  }
});

test("T2 human-armed conversation acknowledgement is exact and capability-gated", async () => {
  const received = manualGateAckPayload("ARM_TINDER_CONVERSATION_BINDING", "RECEIVED");
  const succeeded = manualGateAckPayload("ARM_TINDER_CONVERSATION_BINDING", "SUCCEEDED");
  const fake = ackPool({
    commandType: "ARM_TINDER_CONVERSATION_BINDING",
    capabilities: T2_DEVICE_CAPABILITIES,
    history: [historyRow(received)]
  });
  const response = await processCommandAckTransaction(fake.pool, auth(), succeeded, NOW);
  assert.equal(response.status, "SUCCEEDED");
  assert.equal(fake.state.commandUpdates, 1);

  await assert.rejects(
    () => processCommandAckTransaction(
      ackPool({
        commandType: "ARM_TINDER_CONVERSATION_BINDING",
        capabilities: T1_DEVICE_CAPABILITIES
      }).pool,
      auth(),
      received,
      NOW
    ),
    error => error.code === "DEVICE_CAPABILITY_UNSUPPORTED"
  );

  assert.doesNotThrow(() => parseAndValidateCommandAck(
    ackRequest(succeeded).req,
    "ARM_TINDER_CONVERSATION_BINDING",
    T2_DEVICE_CAPABILITIES
  ));
  for (const result of [
    null,
    { conversation_binding_permit: "UNARMED" },
    { conversation_binding_permit: "ARMED", injected: true },
    { tinder_state: "CONNECTED" }
  ]) {
    assert.throws(() => parseAndValidateCommandAck(
      ackRequest(manualGateAckPayload("ARM_TINDER_CONVERSATION_BINDING", "SUCCEEDED", { result })).req,
      "ARM_TINDER_CONVERSATION_BINDING",
      T2_DEVICE_CAPABILITIES
    ), error => error.code === "INVALID_BODY");
  }
});

test("V4 visible-chat sync acknowledgement atomically stages only its separate permit", async () => {
  const received = visibleChatSyncAckPayload("RECEIVED");
  const succeeded = visibleChatSyncAckPayload("SUCCEEDED");
  const fake = ackPool({
    commandType: "SYNC_TINDER_VISIBLE_CHAT",
    capabilities: T4_DEVICE_CAPABILITIES,
    history: [historyRow(received)],
    visibleChatSyncPermit: {
      command_id: COMMAND_ID,
      device_id: DEVICE_ID,
      permit_state: "ISSUED"
    }
  });
  const response = await processCommandAckTransaction(fake.pool, auth(), succeeded, NOW);
  assert.equal(response.status, "SUCCEEDED");
  assert.equal(fake.state.commandUpdates, 1);
  assert.equal(fake.state.visibleChatSyncPermitUpdates, 1);
  assert.equal(fake.state.visibleChatSyncPermit.permit_state, "STAGED");
  assert.equal(fake.state.visibleChatSyncPermit.staged_at, NOW.toISOString());
  assert.equal(fake.state.visibleChatSyncPermit.closed_at, null);
  const insertedAck = fake.calls.findIndex(call => call.sql.includes("INSERT INTO device_bridge_command_acks"));
  const projectedPermit = fake.calls.findIndex(call => call.sql.includes("UPDATE tinder_visible_chat_sync_permits"));
  const commit = fake.calls.findIndex(call => call.sql === "COMMIT");
  assert.ok(insertedAck >= 0 && projectedPermit > insertedAck && commit > projectedPermit);
  assert.equal(fake.calls.some(call => /capture|identity|visible_name|fingerprint/i.test(call.sql)), false);

  await assert.rejects(
    () => processCommandAckTransaction(
      ackPool({
        commandType: "SYNC_TINDER_VISIBLE_CHAT",
        capabilities: T2_DEVICE_CAPABILITIES,
        visibleChatSyncPermit: { command_id: COMMAND_ID, device_id: DEVICE_ID, permit_state: "ISSUED" }
      }).pool,
      auth(),
      visibleChatSyncAckPayload("REJECTED"),
      NOW
    ),
    error => error.code === "DEVICE_CAPABILITY_UNSUPPORTED"
  );
});

test("an attested V4 payload rejects legacy and downgraded profiles before it can stage", async () => {
  const attestedPayload = {
    local_conversation_attestation: "4dbf2bd9-3d7c-4925-89de-fc0dc62a2fe1",
    binding_revision: "3"
  };
  for (const capabilities of [
    T4_RESUME_DEVICE_CAPABILITIES,
    T4_RESUME_ATTESTATION_DEVICE_CAPABILITIES
  ]) {
    await assert.rejects(
      () => processCommandAckTransaction(
        ackPool({
          commandType: "SYNC_TINDER_VISIBLE_CHAT",
          commandPayload: attestedPayload,
          capabilities,
          visibleChatSyncPermit: { command_id: COMMAND_ID, device_id: DEVICE_ID, permit_state: "ISSUED" }
        }).pool,
        auth(),
        visibleChatSyncAckPayload("RECEIVED"),
        NOW
      ),
      error => error.code === "DEVICE_CAPABILITY_UNSUPPORTED"
    );
  }

  const compatible = ackPool({
    commandType: "SYNC_TINDER_VISIBLE_CHAT",
    commandPayload: attestedPayload,
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES,
    visibleChatSyncPermit: { command_id: COMMAND_ID, device_id: DEVICE_ID, permit_state: "ISSUED" },
    attestationBootstrap: {
      command_type: "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION",
      payload: { binding_revision: "3", attestation_contract_version: "2" }
    }
  });
  const response = await processCommandAckTransaction(
    compatible.pool,
    auth(),
    visibleChatSyncAckPayload("RECEIVED"),
    NOW
  );
  assert.equal(response.status, "RECEIVED");
  assert.equal(compatible.state.commits, 1);
});

test("post-chat ACKs reject legacy V1 bootstrap provenance even on a V2-capable runtime", async () => {
  const stage = ackPool({
    commandType: "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION",
    commandPayload: { binding_revision: "3" },
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES
  });
  await assert.rejects(
    () => processCommandAckTransaction(stage.pool, auth(), ackPayload("RECEIVED"), NOW),
    error => error.code === "COMMAND_CONTRACT_UNSUPPORTED"
  );
  assert.equal(stage.state.ackInserts, 0);

  const sync = ackPool({
    commandType: "SYNC_TINDER_VISIBLE_CHAT",
    commandPayload: {
      local_conversation_attestation: "4dbf2bd9-3d7c-4925-89de-fc0dc62a2fe1",
      binding_revision: "3"
    },
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES,
    visibleChatSyncPermit: { command_id: COMMAND_ID, device_id: DEVICE_ID, permit_state: "ISSUED" },
    attestationBootstrap: {
      command_type: "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION",
      payload: { binding_revision: "3" }
    }
  });
  await assert.rejects(
    () => processCommandAckTransaction(sync.pool, auth(), visibleChatSyncAckPayload("RECEIVED"), NOW),
    error => error.code === "COMMAND_CONTRACT_UNSUPPORTED"
  );
  assert.equal(sync.state.ackInserts, 0);
});

test("official Tinder app resume ACK is exact, capability-gated, and projects only its dedicated permit", async () => {
  const received = officialAppResumeAckPayload("RECEIVED");
  const succeeded = officialAppResumeAckPayload("SUCCEEDED");
  const fake = ackPool({
    commandType: "RESUME_OFFICIAL_TINDER_APP",
    capabilities: T4_RESUME_DEVICE_CAPABILITIES,
    history: [historyRow(received)],
    officialAppResumePermit: {
      command_id: COMMAND_ID,
      device_id: DEVICE_ID,
      permit_state: "ISSUED"
    }
  });
  const response = await processCommandAckTransaction(fake.pool, auth(), succeeded, NOW);
  assert.equal(response.status, "SUCCEEDED");
  assert.equal(fake.state.commandUpdates, 1);
  assert.equal(fake.state.officialAppResumePermitUpdates, 1);
  assert.equal(fake.state.officialAppResumePermit.permit_state, "DISPATCHED");
  assert.equal(fake.state.officialAppResumePermit.dispatched_at, NOW.toISOString());
  assert.equal(fake.state.officialAppResumePermit.closed_at, null);
  const insertedAck = fake.calls.findIndex(call => call.sql.includes("INSERT INTO device_bridge_command_acks"));
  const projectedPermit = fake.calls.findIndex(call => call.sql.includes("UPDATE tinder_official_app_resume_permits"));
  const commit = fake.calls.findIndex(call => call.sql === "COMMIT");
  assert.ok(insertedAck >= 0 && projectedPermit > insertedAck && commit > projectedPermit);
  assert.equal(fake.calls.some(call => /source_capture_id|capture|identity|visible_name|fingerprint|package|component/i.test(call.sql)), false);

  for (const result of [
    null,
    { official_tinder_app_resume: "OPENED" },
    { official_tinder_app_resume: "INTENT_DISPATCHED", package: "com.tinder" }
  ]) {
    assert.throws(() => parseAndValidateCommandAck(
      ackRequest(officialAppResumeAckPayload("SUCCEEDED", { result })).req,
      "RESUME_OFFICIAL_TINDER_APP",
      T4_RESUME_DEVICE_CAPABILITIES
    ), error => error.code === "INVALID_BODY");
  }
  await assert.rejects(
    () => processCommandAckTransaction(
      ackPool({
        commandType: "RESUME_OFFICIAL_TINDER_APP",
        capabilities: T4_DEVICE_CAPABILITIES,
        officialAppResumePermit: { command_id: COMMAND_ID, device_id: DEVICE_ID, permit_state: "ISSUED" }
      }).pool,
      auth(),
      officialAppResumeAckPayload("RECEIVED"),
      NOW
    ),
    error => error.code === "DEVICE_CAPABILITY_UNSUPPORTED"
  );
});

test("official Tinder app resume closes a post-receipt local block as bounded FAILED and never permits it for another command", async () => {
  for (const error of [
    TINDER_OFFICIAL_APP_RESUME_BLOCKED_ERROR,
    TINDER_OFFICIAL_APP_RESUME_OUTCOME_UNRESOLVED_ERROR
  ]) {
    const failed = officialAppResumeAckPayload("FAILED", { error });
    assert.doesNotThrow(() => parseAndValidateCommandAck(
      ackRequest(failed).req,
      "RESUME_OFFICIAL_TINDER_APP",
      T4_RESUME_DEVICE_CAPABILITIES
    ));
    assert.throws(() => parseAndValidateCommandAck(
      ackRequest(failed).req,
      "PING",
      T0_DEVICE_CAPABILITIES
    ), error => error.code === "INVALID_BODY");
  }

  const failed = officialAppResumeAckPayload("FAILED", {
    error: TINDER_OFFICIAL_APP_RESUME_BLOCKED_ERROR
  });
  const fake = ackPool({
    commandType: "RESUME_OFFICIAL_TINDER_APP",
    capabilities: T4_RESUME_DEVICE_CAPABILITIES,
    history: [historyRow(officialAppResumeAckPayload("RECEIVED"))],
    officialAppResumePermit: {
      command_id: COMMAND_ID,
      device_id: DEVICE_ID,
      permit_state: "ISSUED"
    }
  });
  const response = await processCommandAckTransaction(fake.pool, auth(), failed, NOW);
  assert.equal(response.status, "FAILED");
  assert.equal(fake.state.commandUpdates, 1);
  assert.equal(fake.state.officialAppResumePermitUpdates, 1);
  assert.equal(fake.state.officialAppResumePermit.permit_state, "CANCELLED");
  assert.equal(fake.state.officialAppResumePermit.dispatched_at, null);
  assert.equal(fake.state.officialAppResumePermit.closed_at, NOW.toISOString());
});

test("official Tinder app resume cannot record a late success after RECEIVED, while a late bounded failure still closes its permit", async () => {
  const expiredAt = new Date(NOW.valueOf() - 1);
  const received = officialAppResumeAckPayload("RECEIVED");
  const succeeded = officialAppResumeAckPayload("SUCCEEDED");
  const lateSuccess = ackPool({
    commandType: "RESUME_OFFICIAL_TINDER_APP",
    capabilities: T4_RESUME_DEVICE_CAPABILITIES,
    expiresAt: expiredAt,
    history: [historyRow(received)],
    officialAppResumePermit: {
      command_id: COMMAND_ID,
      device_id: DEVICE_ID,
      permit_state: "ISSUED"
    }
  });
  await assert.rejects(
    () => processCommandAckTransaction(lateSuccess.pool, auth(), succeeded, NOW),
    error => error.code === "COMMAND_EXPIRED"
  );
  assert.equal(lateSuccess.state.ackInserts, 0);
  assert.equal(lateSuccess.state.commandUpdates, 0);
  assert.equal(lateSuccess.state.officialAppResumePermitUpdates, 0);

  const failed = officialAppResumeAckPayload("FAILED", {
    error: TINDER_OFFICIAL_APP_RESUME_BLOCKED_ERROR
  });
  const lateFailure = ackPool({
    commandType: "RESUME_OFFICIAL_TINDER_APP",
    capabilities: T4_RESUME_DEVICE_CAPABILITIES,
    expiresAt: expiredAt,
    history: [historyRow(received)],
    officialAppResumePermit: {
      command_id: COMMAND_ID,
      device_id: DEVICE_ID,
      permit_state: "ISSUED"
    }
  });
  const response = await processCommandAckTransaction(lateFailure.pool, auth(), failed, NOW);
  assert.equal(response.status, "FAILED");
  assert.equal(lateFailure.state.officialAppResumePermit.permit_state, "CANCELLED");
});

test("T5 accepts only direct blocked-writer REJECTED and atomically cancels its sealed intent", async () => {
  const rejected = ackPayload("REJECTED", { error: TINDER_WRITER_NOT_IMPLEMENTED_ERROR });
  const fake = ackPool({
    commandType: TINDER_SEND_COMMAND_TYPE,
    capabilities: T5_DEVICE_CAPABILITIES,
    tinderIntent: {
      intent_id: "f3dd4498-1c29-48d2-b953-6c8668dc8fcf",
      approval_id: "4d0b6b43-6a5a-4a06-a2d6-d5f2b60b4a2d",
      draft_id: "a565e8a7-ef60-42d0-b19d-26e7904390fa",
      state: TINDER_SEND_INTENT_STATE.PENDING_T5_WRITER,
      received_at: null
    }
  });
  const response = await processCommandAckTransaction(fake.pool, auth(), rejected, NOW);
  assert.equal(response.status, "REJECTED");
  assert.equal(fake.state.commandUpdates, 1);
  assert.equal(fake.state.tinderIntentUpdates, 1);
  assert.equal(fake.state.tinderIntent.state, TINDER_SEND_INTENT_STATE.CANCELLED);
  assert.equal(fake.state.tinderIntent.result_code, "TINDER_WRITER_NOT_IMPLEMENTED");
  assert.equal(fake.state.tinderAudits, 1);
  assert.equal(fake.state.commits, 1);
  const ackInsert = fake.calls.findIndex(call => call.sql.includes("INSERT INTO device_bridge_command_acks"));
  const intentUpdate = fake.calls.findIndex(call => call.sql.includes("UPDATE tinder_reply_send_intents"));
  const commit = fake.calls.findIndex(call => call.sql === "COMMIT");
  assert.ok(ackInsert >= 0 && intentUpdate > ackInsert && commit > intentUpdate);

  const duplicate = ackPool({
    commandType: TINDER_SEND_COMMAND_TYPE,
    capabilities: T5_DEVICE_CAPABILITIES,
    history: [historyRow(rejected)],
    tinderIntent: {
      intent_id: "f3dd4498-1c29-48d2-b953-6c8668dc8fcf",
      approval_id: "4d0b6b43-6a5a-4a06-a2d6-d5f2b60b4a2d",
      draft_id: "a565e8a7-ef60-42d0-b19d-26e7904390fa",
      state: TINDER_SEND_INTENT_STATE.CANCELLED,
      received_at: null
    }
  });
  const duplicateResponse = await processCommandAckTransaction(duplicate.pool, auth("4dbf2bd9-3d7c-4925-89de-fc0dc62a2fe1"), rejected, NOW);
  assert.equal(duplicateResponse.status, "REJECTED");
  assert.equal(duplicate.state.ackInserts, 0);
  assert.equal(duplicate.state.tinderIntentUpdates, 0);
  assert.equal(duplicate.state.tinderAudits, 0);
});

test("T5 rejects generic errors, receipt/success transitions, and non-T5 capability profiles fail closed", async () => {
  const intent = {
    intent_id: "f3dd4498-1c29-48d2-b953-6c8668dc8fcf",
    approval_id: "4d0b6b43-6a5a-4a06-a2d6-d5f2b60b4a2d",
    draft_id: "a565e8a7-ef60-42d0-b19d-26e7904390fa",
    state: TINDER_SEND_INTENT_STATE.PENDING_T5_WRITER,
    received_at: null
  };
  const cases = [
    [ackPayload("REJECTED", { error: { code: "COMMAND_REJECTED", message: "Command was rejected" } }), T5_DEVICE_CAPABILITIES, "INVALID_BODY"],
    [ackPayload("RECEIVED"), T5_DEVICE_CAPABILITIES, "INVALID_BODY"],
    [ackPayload("SUCCEEDED", { result: null }), T5_DEVICE_CAPABILITIES, "INVALID_BODY"],
    [ackPayload("REJECTED", { error: TINDER_WRITER_NOT_IMPLEMENTED_ERROR }), T2_DEVICE_CAPABILITIES, "DEVICE_CAPABILITY_UNSUPPORTED"]
  ];
  for (const [ack, capabilities, code] of cases) {
    await assert.rejects(
      () => processCommandAckTransaction(
        ackPool({ commandType: TINDER_SEND_COMMAND_TYPE, capabilities, tinderIntent: intent }).pool,
        auth(), ack, NOW
      ),
      error => error.code === code
    );
  }
});

test("NONE transitions directly to REJECTED and EXPIRED", async () => {
  for (const status of ["REJECTED", "EXPIRED"]) {
    const expired = status === "EXPIRED";
    const fake = ackPool({ expiresAt: new Date(NOW.valueOf() + (expired ? -1 : 60_000)) });
    await processCommandAckTransaction(fake.pool, auth(), ackPayload(status), NOW);
    assert.equal(fake.state.commandUpdates, 1);
  }
});

test("NONE to SUCCEEDED or FAILED is rejected", async () => {
  for (const status of ["SUCCEEDED", "FAILED"]) {
    await assert.rejects(() => processCommandAckTransaction(ackPool().pool, auth(), ackPayload(status), NOW), error => error.code === "INVALID_ACK_TRANSITION");
  }
});

test("terminal states cannot transition", async () => {
  for (const [current, next] of [["SUCCEEDED", "FAILED"], ["FAILED", "SUCCEEDED"], ["REJECTED", "RECEIVED"], ["EXPIRED", "RECEIVED"]]) {
    const fake = ackPool({ terminalStatus: current, history: [historyRow(ackPayload(current))] });
    await assert.rejects(() => processCommandAckTransaction(fake.pool, auth(), ackPayload(next), NOW), error => error.code === "INVALID_ACK_TRANSITION");
  }
});

test("semantic retry with new request id is idempotent without audit or terminalization", async () => {
  const ack = ackPayload("SUCCEEDED");
  const fake = ackPool({ terminalStatus: "SUCCEEDED", history: [historyRow(ack)] });
  const response = await processCommandAckTransaction(fake.pool, auth("4dbf2bd9-3d7c-4925-89de-fc0dc62a2fe1"), ack, NOW);
  assert.equal(response.status, "SUCCEEDED");
  assert.equal(fake.state.ackInserts, 0);
  assert.equal(fake.state.commandUpdates, 0);
  assert.equal(fake.state.audits, 0);
  assert.equal(fake.state.nonce, 1);
});

test("same request id is transport replay", async () => {
  const fake = ackPool({ nonceReplay: true });
  await assert.rejects(() => processCommandAckTransaction(fake.pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "REQUEST_REPLAYED");
  assert.equal(fake.state.ackInserts, 0);
});

test("same status with changed occurred_at, result or error is not idempotent", async () => {
  const original = ackPayload("RECEIVED");
  for (const changed of [
    ackPayload("RECEIVED", { occurred_at: "2026-09-01T12:34:55.000Z" }),
    ackPayload("FAILED", { error: { code: "COMMAND_EXECUTION_FAILED", message: "Another failure" } })
  ]) {
    const existing = changed.status === "FAILED" ? ackPayload("FAILED") : original;
    const fake = ackPool({ terminalStatus: changed.status === "FAILED" ? "FAILED" : null, history: [historyRow(existing)] });
    await assert.rejects(() => processCommandAckTransaction(fake.pool, auth(), changed, NOW), error => error.code === "INVALID_ACK_TRANSITION");
  }
});

test("body and URL command identifiers must match", () => {
  const input = ackRequest(ackPayload("RECEIVED", { command_id: crypto.randomUUID() }));
  assert.throws(() => parseAndValidateCommandAck(input.req), error => error.code === "COMMAND_DEVICE_MISMATCH");
});

test("missing, foreign, unsupported and wrong-revision commands are rejected", async () => {
  await assert.rejects(() => processCommandAckTransaction(ackPool({ missingCommand: true }).pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "COMMAND_NOT_FOUND");
  await assert.rejects(() => processCommandAckTransaction(ackPool({ commandDeviceId: crypto.randomUUID() }).pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "COMMAND_DEVICE_MISMATCH");
  await assert.rejects(() => processCommandAckTransaction(ackPool({ commandType: "UNKNOWN" }).pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "COMMAND_TYPE_UNSUPPORTED");
  await assert.rejects(() => processCommandAckTransaction(ackPool({ revision: 2 }).pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "CONFIGURATION_REVISION_UNSUPPORTED");
});

test("revoked device and revoked key fail closed inside transaction", async () => {
  await assert.rejects(() => processCommandAckTransaction(ackPool({ deviceRevoked: true }).pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "DEVICE_REVOKED");
  await assert.rejects(() => processCommandAckTransaction(ackPool({ keyRevoked: true }).pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "KEY_REVOKED");
});

test("signed ack handler rejects bad signature and manipulated body", async () => {
  const current = new Date();
  const input = ackRequest(undefined, { now: current });
  const fake = ackPool({ request: input });
  input.headers["x-marcel-signature"] = "invalid-signature";
  const badSignature = responseRecorder();
  await createCommandAckHandler(fake.pool)(input.req, badSignature);
  assert.equal(badSignature.statusCode, 401);
  assert.equal(badSignature.body.error.code, "SIGNATURE_INVALID");

  const manipulated = ackRequest(undefined, { now: current });
  manipulated.req.body = Buffer.concat([manipulated.req.body, Buffer.from(" ")]);
  const badBody = responseRecorder();
  await createCommandAckHandler(ackPool({ request: manipulated }).pool)(manipulated.req, badBody);
  assert.equal(badBody.body.error.code, "BODY_HASH_MISMATCH");
});

test("sent_at mismatch is rejected", () => {
  const input = ackRequest(ackPayload("RECEIVED", { sent_at: "2026-09-01T12:34:55.000Z" }));
  assert.throws(() => parseAndValidateCommandAck(input.req), error => error.code === "INVALID_BODY");
});

test("expired command accepts first EXPIRED but rejects first RECEIVED", async () => {
  const expiry = new Date(NOW.valueOf() - 1);
  await processCommandAckTransaction(ackPool({ expiresAt: expiry }).pool, auth(), ackPayload("EXPIRED"), NOW);
  await assert.rejects(() => processCommandAckTransaction(ackPool({ expiresAt: expiry }).pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "COMMAND_EXPIRED");
});

test("T1 command expiry and semantic duplicate acknowledgement retain canonical behavior", async () => {
  const expired = new Date(NOW.valueOf() - 1);
  await processCommandAckTransaction(
    ackPool({ commandType: "CONNECT_TINDER", capabilities: T1_DEVICE_CAPABILITIES, expiresAt: expired }).pool,
    auth(),
    manualGateAckPayload("CONNECT_TINDER", "EXPIRED"),
    NOW
  );
  const success = manualGateAckPayload("DISCONNECT_TINDER", "SUCCEEDED");
  const fake = ackPool({
    commandType: "DISCONNECT_TINDER",
    capabilities: T1_DEVICE_CAPABILITIES,
    terminalStatus: "SUCCEEDED",
    history: [historyRow(success)]
  });
  const response = await processCommandAckTransaction(
    fake.pool,
    auth("4dbf2bd9-3d7c-4925-89de-fc0dc62a2fe1"),
    success,
    NOW
  );
  assert.equal(response.status, "SUCCEEDED");
  assert.equal(fake.state.ackInserts, 0);
});

test("RECEIVED command remains deliverable while terminal command is excluded", () => {
  const heartbeat = fs.readFileSync(new URL("../device-bridge/heartbeat.js", import.meta.url), "utf8");
  assert.match(heartbeat, /terminal_status IS NULL/);
  const ack = fs.readFileSync(new URL("../device-bridge/command-ack.js", import.meta.url), "utf8");
  assert.match(ack, /if \(TERMINAL_STATUSES\.has\(ack\.status\)\)/);
  assert.equal(/UPDATE device_bridge_commands/.test(ack.slice(0, ack.indexOf("TERMINAL_STATUSES.has(ack.status)"))), false);
});

test("DB failure rolls nonce, ack, command update and audit back", async () => {
  const fake = ackPool({ history: [historyRow(ackPayload("RECEIVED"))], failAudit: true });
  await assert.rejects(() => processCommandAckTransaction(fake.pool, auth(), ackPayload("SUCCEEDED"), NOW));
  assert.equal(fake.state.nonce, 1);
  assert.equal(fake.state.ackInserts, 1);
  assert.equal(fake.state.commandUpdates, 1);
  assert.equal(fake.state.commits, 0);
  assert.equal(fake.state.rollbacks, 1);
});

test("RECEIVED and EXPIRED require null result/error", () => {
  for (const status of ["RECEIVED", "EXPIRED"]) {
    assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload(status, { result: { injected: true } })).req));
    assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload(status, { error: { code: "ERROR", message: "x" } })).req));
  }
});

test("SUCCEEDED accepts only small command-specific T0 results or null", () => {
  assert.doesNotThrow(() => parseAndValidateCommandAck(ackRequest(ackPayload("SUCCEEDED")).req, "PING"));
  assert.doesNotThrow(() => parseAndValidateCommandAck(ackRequest(ackPayload("SUCCEEDED", { result: null })).req, "PING"));
  assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload("SUCCEEDED", { result: { token: "forbidden" } })).req, "PING"));
  assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload("SUCCEEDED", { result: { text: "x".repeat(2000) } })).req, "PING"));
});

test("REQUEST_STATUS permits T1 state reporting only for the exact T1 capability profile", () => {
  const status = ackPayload("SUCCEEDED", {
    result: {
      device_status: {
        bridge_service_state: "RUNNING",
        tinder_state: "AUTH_REQUIRED",
        automation_state: "STOPPED"
      }
    }
  });
  assert.throws(() => parseAndValidateCommandAck(
    ackRequest(status).req,
    "REQUEST_STATUS",
    T0_DEVICE_CAPABILITIES
  ), error => error.code === "INVALID_BODY");
  assert.doesNotThrow(() => parseAndValidateCommandAck(
    ackRequest(status).req,
    "REQUEST_STATUS",
    T1_DEVICE_CAPABILITIES
  ));
});

test("FAILED and REJECTED errors are strictly bounded", () => {
  assert.doesNotThrow(() => parseAndValidateCommandAck(ackRequest(ackPayload("FAILED")).req));
  assert.doesNotThrow(() => parseAndValidateCommandAck(ackRequest(ackPayload("REJECTED")).req));
  assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload("FAILED", { error: { code: "BAD", message: "x".repeat(257) } })).req));
  assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload("FAILED", { error: { code: "BAD", message: "token leaked" } })).req));
  assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload("FAILED", { error: { code: "BAD", message: "x", stack: "forbidden" } })).req));
  assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload("FAILED", { error: { code: "COMMAND_EXECUTION_FAILED", message: "Contains personal text" } })).req));
});

test("response and audit contain no raw result/error or sensitive data", async () => {
  const ack = ackPayload("FAILED");
  const fake = ackPool({ history: [historyRow(ackPayload("RECEIVED"))] });
  const response = await processCommandAckTransaction(fake.pool, auth(), ack, NOW);
  const serialized = JSON.stringify(response);
  for (const value of ["result", "error", "signature", "token", "cookie", "public_key"]) assert.equal(serialized.includes(value), false);
  const audit = fake.calls.find(call => call.sql.includes("device_bridge_audit_events"));
  assert.equal(JSON.stringify(audit).includes("Execution failed"), false);
});

test("ack route is registered through the existing raw/auth route stack", () => {
  const routes = fs.readFileSync(new URL("../device-bridge/block3-routes.js", import.meta.url), "utf8");
  assert.match(routes, /devices\/:deviceId\/commands\/:commandId\/ack/);
  const source = fs.readFileSync(new URL("../device-bridge/command-ack.js", import.meta.url), "utf8");
  assert.match(source, /verifyAuthenticatedDeviceRequest/);
  assert.match(source, /registerAuthenticatedRequestReplay\(client, auth, now\)/);
});
