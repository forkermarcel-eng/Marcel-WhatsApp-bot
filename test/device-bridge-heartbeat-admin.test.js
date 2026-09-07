import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  T0_DEVICE_CAPABILITIES,
  T1_DEVICE_CAPABILITIES,
  T2_DEVICE_CAPABILITIES,
  T5_DEVICE_CAPABILITIES,
  canonicalRequest,
  sha256Hex
} from "../device-bridge/protocol-v1.js";
import {
  futureCommandFingerprint,
  hydrateFutureTinderSendCommandPayload,
  sealedFuturePayloadHash,
  sha256Text
} from "../services/tinder-manual-send.js";
import {
  createHeartbeatHandler,
  deriveDeviceStatus,
  parseAndValidateHeartbeat,
  processHeartbeatTransaction
} from "../device-bridge/heartbeat.js";
import {
  COMMAND_EXPIRY_MS,
  canonicalCommand,
  createAdminCommandHandler,
  createAdminDeviceListHandler,
  createAdminDeviceStatusHandler
} from "../device-bridge/admin.js";

const NOW = new Date("2026-09-01T12:34:56.000Z");
const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const KEY_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const REQUEST_ID = "d2675347-0888-4548-9feb-ae4d71a972cf";
const INSTALLATION_ID = "c7cb0b92-ad3c-4ec6-88dc-d149ef536c3d";
const CAPABILITIES = T0_DEVICE_CAPABILITIES;

function heartbeatPayload(overrides = {}) {
  return {
    protocol_version: 1,
    sequence: 1,
    sent_at: NOW.toISOString(),
    app: { version_name: "1.0", version_code: 1 },
    device: { installation_id: INSTALLATION_ID, manufacturer: "ZTE", model: "ZTE Blade A35e", android_api: 35, abis: ["arm64-v8a"] },
    bridge: { service_state: "RUNNING", started_at: "2026-09-01T12:30:00.000Z", last_successful_heartbeat_at: null },
    capabilities: CAPABILITIES,
    tinder_state: "UNKNOWN",
    automation_state: "STOPPED",
    ...overrides
  };
}

function heartbeatRequest(payload = heartbeatPayload(), { requestId = REQUEST_ID, keys, now = NOW } = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const hash = sha256Hex(body);
  const path = `/device-bridge/v1/devices/${DEVICE_ID}/heartbeat`;
  const pair = keys || crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const canonical = canonicalRequest({ protocolVersion: 1, method: "POST", path, timestamp: now.toISOString(), requestId, contentSha256: hash });
  const headers = {
    "x-marcel-protocol-version": "1", "x-marcel-device-id": DEVICE_ID,
    "x-marcel-key-id": KEY_ID, "x-marcel-timestamp": now.toISOString(),
    "x-marcel-request-id": requestId, "x-marcel-content-sha256": hash,
    "x-marcel-signature": crypto.sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64url")
  };
  return {
    req: { method: "POST", originalUrl: path, body, params: { deviceId: DEVICE_ID }, get: name => headers[name.toLowerCase()] },
    keys: pair,
    hash,
    headers
  };
}

function responseRecorder() {
  return { statusCode: null, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}

function commandRow(type, issuedAt, id, overrides = {}) {
  return {
    command_id: id,
    protocol_version: 1,
    command_type: type,
    issued_at: issuedAt,
    expires_at: new Date(issuedAt.valueOf() + 300_000),
    configuration_revision: 1,
    payload: type === "STOP_BRIDGE" ? { reason: "ADMIN_REQUEST" } : {},
    ...overrides
  };
}

function t5Payload(commandId) {
  const stableJson = value => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  };
  const approvedText = "bounded test draft";
  const approvedTextSha256 = sha256Text(approvedText);
  const approvalBindingSha256 = crypto.createHash("sha256").update(stableJson({
    draft_id: "a565e8a7-ef60-42d0-b19d-26e7904390fa",
    draft_revision: 1,
    contact_id: 7,
    capture_id: "6c7308cf-5d40-423d-913b-c4424f0e4ee0",
    capture_fingerprint: "c".repeat(64),
    thread_ref_kind: "runtime_thread_fingerprint_v1",
    thread_ref: "a".repeat(64),
    capture_revision: 3,
    identity_revision: 4,
    text_sha256: approvedTextSha256
  }), "utf8").digest("hex");
  const binding = {
    payload_version: "tinder_t5_send_v1",
    intent_id: "f3dd4498-1c29-48d2-b953-6c8668dc8fcf",
    command_id: commandId,
    approval_id: "4d0b6b43-6a5a-4a06-a2d6-d5f2b60b4a2d",
    draft_id: "a565e8a7-ef60-42d0-b19d-26e7904390fa",
    draft_revision: "1",
    contact_id: "7",
    capture_id: "6c7308cf-5d40-423d-913b-c4424f0e4ee0",
    capture_fingerprint: "c".repeat(64),
    thread_ref_kind: "runtime_thread_fingerprint_v1",
    thread_ref_hash: "a".repeat(64),
    identity_revision: "4",
    approved_text: approvedText,
    approved_text_sha256: approvedTextSha256,
    approval_binding_sha256: approvalBindingSha256,
    delivery_policy_revision: "tinder_manual_send_v1",
    not_before: NOW.toISOString(),
    expires_at: new Date(NOW.valueOf() + 300_000).toISOString(),
    typing_duration_ms: "0"
  };
  const sealedPayloadHash = sealedFuturePayloadHash(binding);
  return {
    ...binding,
    sealed_payload_sha256: sealedPayloadHash,
    command_fingerprint: futureCommandFingerprint({
      commandId,
      intentId: binding.intent_id,
      sealedPayloadHash
    })
  };
}

function t5Descriptor(commandId) {
  const { approved_text: _approvedText, ...descriptor } = t5Payload(commandId);
  return { ...descriptor, payload_version: "tinder_t5_send_descriptor_v1" };
}

function t5HydrationRow(command, { snapshot: snapshotOverrides = {}, approval: approvalOverrides = {}, intent: intentOverrides = {} } = {}) {
  const payload = t5Payload(command.command_id);
  const expiresAt = new Date(payload.expires_at);
  return {
    command: {
      ...command,
      device_id: DEVICE_ID,
      payload: command.payload,
      expires_at: expiresAt,
      terminal_status: null
    },
    snapshot: {
      draft_id: payload.draft_id,
      draft_status: "APPROVED",
      draft_revision: Number(payload.draft_revision),
      contact_id: Number(payload.contact_id),
      capture_id: payload.capture_id,
      runtime_thread_fingerprint: payload.thread_ref_hash,
      capture_revision: 3,
      draft_identity_revision: Number(payload.identity_revision),
      original_draft: payload.approved_text,
      current_identity_revision: Number(payload.identity_revision),
      capture_fingerprint: payload.capture_fingerprint,
      capture_safety_status: "SAFE",
      mapping_status: "RESOLVED",
      human_review_status: "CONFIRMED",
      resolved_contact_id: Number(payload.contact_id),
      device_id: DEVICE_ID,
      human_takeover_active: false,
      handoff_active: false,
      device_enrollment_state: "ACTIVE",
      bridge_service_state: "RUNNING",
      tinder_state: "CONNECTED",
      automation_state: "STOPPED",
      configuration_revision: 1,
      device_capabilities: T5_DEVICE_CAPABILITIES,
      last_accepted_heartbeat_at: new Date(NOW.valueOf() - 30_000),
      latest_capture_revision: 3,
      ...snapshotOverrides
    },
    approval: {
      approval_id: payload.approval_id,
      draft_id: payload.draft_id,
      draft_revision: Number(payload.draft_revision),
      contact_id: Number(payload.contact_id),
      capture_id: payload.capture_id,
      capture_fingerprint: payload.capture_fingerprint,
      thread_ref_kind: payload.thread_ref_kind,
      runtime_thread_fingerprint: payload.thread_ref_hash,
      capture_revision: 3,
      identity_revision: Number(payload.identity_revision),
      approved_text_sha256: payload.approved_text_sha256,
      approval_binding_sha256: payload.approval_binding_sha256,
      approved_by: "marcel_dashboard",
      approved_at: NOW,
      state: "ACTIVE",
      ...approvalOverrides
    },
    intent: {
      intent_id: payload.intent_id,
      approval_id: payload.approval_id,
      draft_id: payload.draft_id,
      draft_revision: Number(payload.draft_revision),
      contact_id: Number(payload.contact_id),
      capture_id: payload.capture_id,
      capture_fingerprint: payload.capture_fingerprint,
      thread_ref_kind: payload.thread_ref_kind,
      runtime_thread_fingerprint: payload.thread_ref_hash,
      identity_revision: Number(payload.identity_revision),
      command_id: payload.command_id,
      command_type: "SEND_TINDER_DRAFT",
      protocol_version: 1,
      approved_text_sha256: payload.approved_text_sha256,
      approval_binding_sha256: payload.approval_binding_sha256,
      delivery_policy_revision: payload.delivery_policy_revision,
      not_before: payload.not_before,
      expires_at: payload.expires_at,
      typing_duration_ms: Number(payload.typing_duration_ms),
      state: "PENDING_T5_WRITER",
      received_at: null,
      completed_at: null,
      result_code: null,
      created_at: new Date(NOW.valueOf() - 1000),
      ...intentOverrides
    }
  };
}

function heartbeatPool({ request, sequence = null, bodyHash = null, acceptedAt = null, commands = [], hydrationRows = new Map(), failUpdate = false, nonceReplay = false } = {}) {
  const calls = [];
  const state = { updates: 0, audits: 0, commits: 0, rollbacks: 0, nonceInserts: 0, hydrationQueries: 0 };
  const authRow = {
    device_id: DEVICE_ID, key_id: KEY_ID, enrollment_state: "ACTIVE",
    device_revoked_at: null, key_revoked_at: null,
    public_key_spki_der: request?.keys.publicKey.export({ type: "spki", format: "der" })
  };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "COMMIT") { state.commits += 1; return { rows: [] }; }
      if (sql === "ROLLBACK") { state.rollbacks += 1; return { rows: [] }; }
      if (sql.includes("jsonb_build_object") && sql.includes("tinder_reply_send_intents")) {
        state.hydrationQueries += 1;
        const row = hydrationRows.get(params[0]) || null;
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("FOR UPDATE") && sql.includes("device_bridge_devices")) return { rows: [{
        device_id: DEVICE_ID, installation_id: INSTALLATION_ID, enrollment_state: "ACTIVE", revoked_at: null,
        key_id: KEY_ID, key_revoked_at: null,
        last_heartbeat_sequence: sequence, last_heartbeat_body_sha256: bodyHash,
        last_accepted_heartbeat_at: acceptedAt
      }] };
      if (sql.includes("INSERT INTO device_bridge_request_nonces")) {
        if (nonceReplay) { const error = new Error("duplicate"); error.code = "23505"; throw error; }
        state.nonceInserts += 1; return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE device_bridge_devices")) {
        if (failUpdate) throw new Error("simulated update failure");
        state.updates += 1; return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO device_bridge_audit_events")) { state.audits += 1; return { rowCount: 1, rows: [] }; }
      if (sql.includes("FROM device_bridge_commands")) {
        const deliversT1 = sql.includes("CONNECT_TINDER") && sql.includes("DISCONNECT_TINDER");
        const deliversT2 = deliversT1 && sql.includes("ARM_TINDER_CONVERSATION_BINDING");
        const deliversT5 = deliversT2 && sql.includes("SEND_TINDER_DRAFT");
        const allowed = deliversT5
          ? new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE", "CONNECT_TINDER", "DISCONNECT_TINDER", "ARM_TINDER_CONVERSATION_BINDING", "SEND_TINDER_DRAFT"])
          : deliversT2
          ? new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE", "CONNECT_TINDER", "DISCONNECT_TINDER", "ARM_TINDER_CONVERSATION_BINDING"])
          : deliversT1
          ? new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE", "CONNECT_TINDER", "DISCONNECT_TINDER"])
          : new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE"]);
        return {
          rows: commands.filter(command => allowed.has(command.command_type))
        };
      }
      return { rows: [] };
    },
    release() { state.released = true; }
  };
  return {
    pool: {
      async query(sql) { if (sql.includes("LEFT JOIN device_bridge_keys")) return { rows: [authRow] }; return { rows: [] }; },
      async connect() { return client; }
    },
    calls,
    state
  };
}

test("valid signed heartbeat reaches handler and returns Protocol V1 response", async () => {
  const current = new Date();
  const payload = heartbeatPayload({ sent_at: current.toISOString() });
  const request = heartbeatRequest(payload, { now: current });
  const fake = heartbeatPool({ request });
  const res = responseRecorder();
  await createHeartbeatHandler(fake.pool)(request.req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.protocol_version, 1);
  assert.equal(fake.state.commits, 1);
});

test("heartbeat validation preserves T0 and accepts only the exact T1 state profile", () => {
  assert.doesNotThrow(() => parseAndValidateHeartbeat(heartbeatRequest().req));
  for (const tinderState of ["DISCONNECTED", "CONNECTING", "CONNECTED", "AUTH_REQUIRED", "REVIEW_REQUIRED", "UNKNOWN"]) {
    assert.doesNotThrow(() => parseAndValidateHeartbeat(heartbeatRequest(heartbeatPayload({
      capabilities: T1_DEVICE_CAPABILITIES,
      tinder_state: tinderState
    })).req));
  }
  for (const payload of [
    heartbeatPayload({ tinder_state: "CONNECTED" }),
    heartbeatPayload({ capabilities: T1_DEVICE_CAPABILITIES, tinder_state: "NOT_A_STATE" }),
    heartbeatPayload({ automation_state: "RUNNING" }),
    heartbeatPayload({ capabilities: [...CAPABILITIES].reverse() }),
    heartbeatPayload({ capabilities: [...T1_DEVICE_CAPABILITIES, "TINDER_VISIBLE_CHAT_READ_V1"] })
  ]) assert.throws(() => parseAndValidateHeartbeat(heartbeatRequest(payload).req), error => error.code === "INVALID_DEVICE_STATE");
});

test("T1 heartbeat persists the local Tinder state without deriving it from online state", async () => {
  const payload = heartbeatPayload({ capabilities: T1_DEVICE_CAPABILITIES, tinder_state: "CONNECTED" });
  const request = heartbeatRequest(payload);
  const fake = heartbeatPool({ request });
  await processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash }, payload, NOW);
  const update = fake.calls.find(call => call.sql.includes("UPDATE device_bridge_devices"));
  assert.equal(update.params[9], "CONNECTED");
  assert.equal(update.params[10], 1);
});

test("heartbeat sequence 1 and higher sequence update exactly once", async () => {
  for (const [previous, next] of [[null, 1], [1, 2]]) {
    const request = heartbeatRequest(heartbeatPayload({ sequence: next }));
    const fake = heartbeatPool({ request, sequence: previous });
    const response = await processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash }, heartbeatPayload({ sequence: next }), NOW);
    assert.equal(response.accepted_at, NOW.toISOString());
    assert.equal(fake.state.updates, 1);
    assert.equal(fake.state.audits, 1);
  }
});

test("same sequence and same hash is idempotent with new request id", async () => {
  const retryId = "4dbf2bd9-3d7c-4925-89de-fc0dc62a2fe1";
  const request = heartbeatRequest(heartbeatPayload({ sequence: 4 }), { requestId: retryId });
  const originalAcceptedAt = new Date(NOW.valueOf() - 5000);
  const fake = heartbeatPool({ request, sequence: 4, bodyHash: request.hash, acceptedAt: originalAcceptedAt });
  const response = await processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: retryId, contentSha256: request.hash }, heartbeatPayload({ sequence: 4 }), NOW);
  assert.equal(response.accepted_at, originalAcceptedAt.toISOString());
  assert.equal(response.server_time, NOW.toISOString());
  assert.equal(fake.state.updates, 0);
  assert.equal(fake.state.audits, 0);
  assert.equal(fake.state.nonceInserts, 1);
});

test("same sequence with another hash and smaller sequence conflict", async () => {
  for (const [sequence, hash] of [[4, "b".repeat(64)], [3, "a".repeat(64)]]) {
    const request = heartbeatRequest(heartbeatPayload({ sequence }));
    const fake = heartbeatPool({ request, sequence: 4, bodyHash: hash, acceptedAt: NOW });
    await assert.rejects(() => processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash }, heartbeatPayload({ sequence }), NOW), error => error.code === "HEARTBEAT_SEQUENCE_CONFLICT");
    assert.equal(fake.state.rollbacks, 1);
  }
});

test("same request id replay rolls back before heartbeat update", async () => {
  const request = heartbeatRequest();
  const fake = heartbeatPool({ request, nonceReplay: true });
  await assert.rejects(() => processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash }, heartbeatPayload(), NOW), error => error.code === "REQUEST_REPLAYED");
  assert.equal(fake.state.updates, 0);
  assert.equal(fake.state.rollbacks, 1);
});

test("database failure rolls nonce and heartbeat back together logically", async () => {
  const request = heartbeatRequest();
  const fake = heartbeatPool({ request, failUpdate: true });
  await assert.rejects(() => processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash }, heartbeatPayload(), NOW));
  assert.equal(fake.state.nonceInserts, 1);
  assert.equal(fake.state.commits, 0);
  assert.equal(fake.state.rollbacks, 1);
});

test("ONLINE/OFFLINE derives only from server accepted time", () => {
  assert.equal(deriveDeviceStatus(null, NOW), "OFFLINE");
  assert.equal(deriveDeviceStatus(new Date(NOW.valueOf() - 90_000), NOW), "ONLINE");
  assert.equal(deriveDeviceStatus(new Date(NOW.valueOf() - 90_001), NOW), "OFFLINE");
  const payload = heartbeatPayload({ sent_at: "2020-01-01T00:00:00.000Z" });
  assert.equal(payload.sent_at.includes("2020"), true);
  assert.equal(deriveDeviceStatus(new Date(NOW.valueOf() - 1000), NOW), "ONLINE");
});

test("heartbeat response has fixed configuration and ACTIVE directive", async () => {
  const request = heartbeatRequest();
  const fake = heartbeatPool({ request });
  const response = await processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash }, heartbeatPayload(), NOW);
  assert.deepEqual(response.configuration, { heartbeat_interval_seconds: 30, offline_after_seconds: 90, signature_window_seconds: 300, configuration_revision: 1 });
  assert.equal(response.device_directive, "CONTINUE");
  assert.equal(response.server_time, NOW.toISOString());
});

test("command delivery is device-scoped, ordered, bounded and non-terminalizing", async () => {
  const first = commandRow("PING", new Date(NOW.valueOf() - 2000), "11111111-1111-4111-8111-111111111111");
  const second = commandRow("STOP_BRIDGE", new Date(NOW.valueOf() - 1000), "22222222-2222-4222-8222-222222222222");
  const request = heartbeatRequest();
  const fake = heartbeatPool({ request, commands: [first, second] });
  const response = await processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash }, heartbeatPayload(), NOW);
  assert.deepEqual(response.commands.map(command => command.command_id), [first.command_id, second.command_id]);
  assert.deepEqual(response.commands[1].payload, { reason: "ADMIN_REQUEST" });
  const query = fake.calls.find(call => call.sql.includes("FROM device_bridge_commands"));
  assert.equal(query.params[0], DEVICE_ID);
  assert.equal(query.params[2], 50);
  assert.match(query.sql, /expires_at>\$2/);
  assert.match(query.sql, /ORDER BY issued_at ASC, command_id ASC/);
  assert.equal(fake.calls.some(call => /UPDATE device_bridge_commands/.test(call.sql)), false);
});

test("T1 command delivery is capability-gated against the current heartbeat profile", async () => {
  const command = commandRow("CONNECT_TINDER", new Date(NOW.valueOf() - 1000), "33333333-3333-4333-8333-333333333333");
  const t0Request = heartbeatRequest();
  const t0 = heartbeatPool({ request: t0Request, commands: [command] });
  const t0Response = await processHeartbeatTransaction(t0.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: t0Request.hash }, heartbeatPayload(), NOW);
  const t0Query = t0.calls.find(call => call.sql.includes("FROM device_bridge_commands"));
  assert.doesNotMatch(t0Query.sql, /CONNECT_TINDER/);
  assert.deepEqual(t0Response.commands, []);

  const t1Payload = heartbeatPayload({ capabilities: T1_DEVICE_CAPABILITIES, tinder_state: "DISCONNECTED" });
  const t1Request = heartbeatRequest(t1Payload);
  const t1 = heartbeatPool({ request: t1Request, commands: [command] });
  const response = await processHeartbeatTransaction(t1.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: t1Request.hash }, t1Payload, NOW);
  const t1Query = t1.calls.find(call => call.sql.includes("FROM device_bridge_commands"));
  assert.match(t1Query.sql, /CONNECT_TINDER/);
  assert.equal(response.commands[0].type, "CONNECT_TINDER");
  assert.deepEqual(response.commands[0].payload, {});
});

test("T2 human-armed conversation command is delivered only to the exact T2 profile", async () => {
  const command = commandRow(
    "ARM_TINDER_CONVERSATION_BINDING",
    new Date(NOW.valueOf() - 1000),
    "44444444-4444-4444-8444-444444444444"
  );
  const t1Payload = heartbeatPayload({ capabilities: T1_DEVICE_CAPABILITIES, tinder_state: "CONNECTED" });
  const t1Request = heartbeatRequest(t1Payload);
  const t1 = heartbeatPool({ request: t1Request, commands: [command] });
  const t1Response = await processHeartbeatTransaction(
    t1.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: t1Request.hash },
    t1Payload,
    NOW
  );
  assert.deepEqual(t1Response.commands, []);
  assert.doesNotMatch(t1.calls.find(call => call.sql.includes("FROM device_bridge_commands")).sql, /ARM_TINDER_CONVERSATION_BINDING/);

  const t2Payload = heartbeatPayload({ capabilities: T2_DEVICE_CAPABILITIES, tinder_state: "CONNECTED" });
  const t2Request = heartbeatRequest(t2Payload);
  const t2 = heartbeatPool({ request: t2Request, commands: [command] });
  const t2Response = await processHeartbeatTransaction(
    t2.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: t2Request.hash },
    t2Payload,
    NOW
  );
  assert.equal(t2Response.commands.length, 1);
  assert.equal(t2Response.commands[0].type, "ARM_TINDER_CONVERSATION_BINDING");
  assert.deepEqual(t2Response.commands[0].payload, {});
  assert.match(t2.calls.find(call => call.sql.includes("FROM device_bridge_commands")).sql, /ARM_TINDER_CONVERSATION_BINDING/);
});

test("T5 persists only a descriptor and transiently hydrates a full signed envelope only for the exact T5 heartbeat profile", async () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const command = commandRow("SEND_TINDER_DRAFT", new Date(NOW.valueOf() - 1000), id, {
    payload: t5Descriptor(id),
    expires_at: new Date(NOW.valueOf() + 300_000)
  });
  const t2Payload = heartbeatPayload({ capabilities: T2_DEVICE_CAPABILITIES, tinder_state: "CONNECTED" });
  const t2Request = heartbeatRequest(t2Payload);
  const t2 = heartbeatPool({ request: t2Request, commands: [command] });
  const t2Response = await processHeartbeatTransaction(
    t2.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: t2Request.hash }, t2Payload, NOW
  );
  assert.deepEqual(t2Response.commands, []);

  const t5PayloadBody = heartbeatPayload({ capabilities: T5_DEVICE_CAPABILITIES, tinder_state: "CONNECTED" });
  const t5Request = heartbeatRequest(t5PayloadBody);
  const t5 = heartbeatPool({
    request: t5Request,
    commands: [command],
    hydrationRows: new Map([[id, t5HydrationRow(command)]])
  });
  const source = t5HydrationRow(command);
  assert.doesNotThrow(() => hydrateFutureTinderSendCommandPayload({ ...source, now: NOW }));
  const t5Response = await processHeartbeatTransaction(
    t5.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: t5Request.hash }, t5PayloadBody, NOW
  );
  assert.equal(t5Response.commands.length, 1);
  assert.equal(t5Response.commands[0].type, "SEND_TINDER_DRAFT");
  assert.equal(t5Response.commands[0].payload.command_id, id);
  assert.equal(t5Response.commands[0].payload.approved_text, "bounded test draft");
  assert.equal(Object.hasOwn(command.payload, "approved_text"), false);
  assert.equal(t5.state.hydrationQueries, 1);
  assert.equal(JSON.stringify(t5.calls).includes("bounded test draft"), false);

  const redeliveryPayloadBody = heartbeatPayload({
    sequence: 2,
    capabilities: T5_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED"
  });
  const redeliveryRequest = heartbeatRequest(redeliveryPayloadBody, {
    requestId: "7d267534-0888-4548-9feb-ae4d71a972cf"
  });
  const redelivery = heartbeatPool({
    request: redeliveryRequest,
    commands: [command],
    hydrationRows: new Map([[id, t5HydrationRow(command)]])
  });
  const redeliveryResponse = await processHeartbeatTransaction(
    redelivery.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "7d267534-0888-4548-9feb-ae4d71a972cf", contentSha256: redeliveryRequest.hash },
    redeliveryPayloadBody,
    NOW
  );
  assert.deepEqual(redeliveryResponse.commands[0].payload, t5Response.commands[0].payload);
  assert.equal(Object.hasOwn(command.payload, "approved_text"), false);

  const malformed = commandRow("SEND_TINDER_DRAFT", new Date(NOW.valueOf() - 500), "66666666-6666-4666-8666-666666666666", {
    payload: { ...t5Descriptor("66666666-6666-4666-8666-666666666666"), command_fingerprint: "0".repeat(64) },
    expires_at: new Date(NOW.valueOf() + 300_000)
  });
  const malformedRequest = heartbeatRequest(t5PayloadBody, { requestId: "7d267534-0888-4548-9feb-ae4d71a972cf" });
  const malformedPool = heartbeatPool({
    request: malformedRequest,
    commands: [malformed],
    hydrationRows: new Map([[
      malformed.command_id,
      t5HydrationRow(malformed)
    ]])
  });
  const malformedResponse = await processHeartbeatTransaction(
    malformedPool.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "7d267534-0888-4548-9feb-ae4d71a972cf", contentSha256: malformedRequest.hash },
    t5PayloadBody,
    NOW
  );
  assert.deepEqual(malformedResponse.commands, []);
});

test("T5 heartbeat omits a descriptor when freshly locked source shows newer capture, identity, takeover, handoff, draft, or approval drift", async () => {
  const t5PayloadBody = heartbeatPayload({ capabilities: T5_DEVICE_CAPABILITIES, tinder_state: "CONNECTED" });
  const driftCases = [
    ["newer capture", { snapshot: { latest_capture_revision: 4 } }],
    ["identity", { snapshot: { current_identity_revision: 5 } }],
    ["takeover", { snapshot: { human_takeover_active: true } }],
    ["handoff", { snapshot: { handoff_active: true } }],
    ["draft", { snapshot: { original_draft: "current draft changed" } }],
    ["approval", { approval: { state: "CANCELLED" } }]
  ];
  const commandIds = [
    "77777777-7777-4777-8777-777777777777",
    "88888888-8888-4888-8888-888888888888",
    "99999999-9999-4999-8999-999999999999",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
  ];
  const requestIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
    "55555555-5555-4555-8555-555555555555",
    "66666666-6666-4666-8666-666666666666"
  ];
  for (const [index, [name, overrides]] of driftCases.entries()) {
    // Use fixed valid UUIDs, while changing the request identifier for each
    // isolated signed heartbeat.  The command descriptor remains untouched.
    const commandId = commandIds[index];
    const command = commandRow("SEND_TINDER_DRAFT", new Date(NOW.valueOf() - 1000), commandId, {
      payload: t5Descriptor(commandId),
      expires_at: new Date(NOW.valueOf() + 300_000)
    });
    const requestId = requestIds[index];
    const request = heartbeatRequest(t5PayloadBody, { requestId });
    const fake = heartbeatPool({
      request,
      commands: [command],
      hydrationRows: new Map([[commandId, t5HydrationRow(command, overrides)]])
    });
    const response = await processHeartbeatTransaction(
      fake.pool,
      { deviceId: DEVICE_ID, keyId: KEY_ID, requestId, contentSha256: request.hash },
      t5PayloadBody,
      NOW
    );
    assert.deepEqual(response.commands, [], name);
    assert.equal(fake.state.hydrationQueries, 1, name);
    assert.equal(JSON.stringify(fake.calls).includes("bounded test draft"), false, name);
    assert.equal(fake.calls.some(call => /UPDATE\s+device_bridge_commands|UPDATE\s+tinder_reply_send|INSERT\s+INTO\s+tinder_reply_send/i.test(call.sql)), false, name);
  }
});

function statusRow(lastAccepted = null, capabilities = CAPABILITIES, tinderState = "UNKNOWN") {
  return {
    device_id: DEVICE_ID, display_name: "ZTE Blade A35e", enrollment_state: "ACTIVE",
    created_at: NOW,
    last_accepted_heartbeat_at: lastAccepted, app_version_name: "1.0", app_version_code: "1",
    bridge_service_state: "RUNNING", tinder_state: tinderState, automation_state: "STOPPED", capabilities,
    configuration_revision: 1
  };
}

test("admin list and status expose separated states without sensitive key data", async () => {
  const pool = { async query(sql) { return { rows: [statusRow()] }; } };
  const listRes = responseRecorder();
  await createAdminDeviceListHandler(pool)({}, listRes);
  assert.equal(listRes.body.devices[0].device_status, "OFFLINE");
  assert.equal(listRes.body.devices[0].enrolled_at, NOW.toISOString());
  const statusRes = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, statusRes);
  assert.equal(statusRes.body.device.tinder_state, "UNKNOWN");
  assert.equal(statusRes.body.device.automation_state, "STOPPED");
  assert.equal(statusRes.body.device.tinder_manual_gate_capable, false);
  const serialized = JSON.stringify(statusRes.body);
  for (const field of ["public_key", "signature", "enrollment_code", "key_id"]) assert.equal(serialized.includes(field), false);
});

test("admin status exposes only the derived T1 capability flag", async () => {
  const pool = { async query() { return { rows: [statusRow(NOW, T1_DEVICE_CAPABILITIES, "CONNECTED")] }; } };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.equal(res.body.device.tinder_manual_gate_capable, true);
  assert.equal(JSON.stringify(res.body).includes("TINDER_MANUAL_GATE_V1"), false);
});

function commandPool({
  active = true,
  failAudit = false,
  capabilities = CAPABILITIES,
  lastAcceptedHeartbeatAt = new Date(),
  bridgeServiceState = "RUNNING",
  tinderState = "DISCONNECTED"
} = {}) {
  const calls = [];
  const state = { commit: false, rollback: false };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "COMMIT") { state.commit = true; return { rows: [] }; }
      if (sql === "ROLLBACK") { state.rollback = true; return { rows: [] }; }
      if (sql.includes("FOR UPDATE")) return { rows: [{
        device_id: DEVICE_ID,
        enrollment_state: active ? "ACTIVE" : "REVOKED",
        revoked_at: active ? null : NOW,
        configuration_revision: 1,
        capabilities,
        last_accepted_heartbeat_at: lastAcceptedHeartbeatAt,
        bridge_service_state: bridgeServiceState,
        tinder_state: tinderState
      }] };
      if (sql.includes("COMMAND_CREATED") && failAudit) throw new Error("simulated audit failure");
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  return { pool: { async connect() { return client; } }, calls, state };
}

test("admin creates canonical PING, REQUEST_STATUS and STOP_BRIDGE commands", async () => {
  for (const type of ["PING", "REQUEST_STATUS", "STOP_BRIDGE"]) {
    const fake = commandPool();
    const res = responseRecorder();
    await createAdminCommandHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body: { type } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.command.type, type);
    assert.deepEqual(res.body.command.payload, type === "STOP_BRIDGE" ? { reason: "ADMIN_REQUEST" } : {});
    assert.equal(new Date(res.body.command.expires_at) - new Date(res.body.command.issued_at), COMMAND_EXPIRY_MS[type]);
    assert.equal(fake.state.commit, true);
  }
});

test("admin creates only canonical T1 manual-gate commands for a compatible running device", async () => {
  for (const type of ["CONNECT_TINDER", "DISCONNECT_TINDER"]) {
    const fake = commandPool({ capabilities: T1_DEVICE_CAPABILITIES, tinderState: "DISCONNECTED" });
    const res = responseRecorder();
    await createAdminCommandHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body: { type } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.command.type, type);
    assert.deepEqual(res.body.command.payload, {});
    assert.equal(new Date(res.body.command.expires_at) - new Date(res.body.command.issued_at), COMMAND_EXPIRY_MS[type]);
    assert.equal(fake.state.commit, true);
  }
});

test("admin fails T1 commands closed for capability, online, bridge and unsafe-connect gates", async () => {
  const cases = [
    [{ capabilities: CAPABILITIES }, "DEVICE_CAPABILITY_UNSUPPORTED"],
    [{ capabilities: T1_DEVICE_CAPABILITIES, lastAcceptedHeartbeatAt: new Date(Date.now() - 91_000) }, "DEVICE_OFFLINE"],
    [{ capabilities: T1_DEVICE_CAPABILITIES, bridgeServiceState: "STOPPED" }, "BRIDGE_NOT_RUNNING"],
    [{ capabilities: T1_DEVICE_CAPABILITIES, tinderState: "UNKNOWN" }, "TINDER_STATE_UNSAFE"]
  ];
  for (const [options, code] of cases) {
    const fake = commandPool(options);
    const res = responseRecorder();
    await createAdminCommandHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body: { type: "CONNECT_TINDER" } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error.code, code);
    assert.equal(fake.calls.some(call => call.sql.includes("INSERT INTO device_bridge_commands")), false);
  }

  const disconnect = commandPool({ capabilities: T1_DEVICE_CAPABILITIES, tinderState: "REVIEW_REQUIRED" });
  const res = responseRecorder();
  await createAdminCommandHandler(disconnect.pool)({ params: { deviceId: DEVICE_ID }, body: { type: "DISCONNECT_TINDER" } }, res);
  assert.equal(res.statusCode, 201);
});

test("admin cannot inject type, payload or expires_at", async () => {
  for (const body of [{ type: "UNKNOWN" }, { type: "PING", payload: { injected: true } }, { type: "PING", expires_at: NOW.toISOString() }]) {
    const fake = commandPool();
    const res = responseRecorder();
    await createAdminCommandHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(fake.calls.length, 0);
  }
  assert.throws(() => canonicalCommand("UNKNOWN"), error => error.code === "COMMAND_TYPE_UNSUPPORTED");
});

test("command insert and audit are atomic and audit contains no sensitive values", async () => {
  const fake = commandPool({ failAudit: true });
  const res = responseRecorder();
  const originalError = console.error;
  console.error = () => {};
  try {
    await createAdminCommandHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body: { type: "PING" } }, res);
  } finally {
    console.error = originalError;
  }
  assert.equal(res.statusCode, 500);
  assert.equal(fake.state.commit, false);
  assert.equal(fake.state.rollback, true);
  const audit = fake.calls.find(call => call.sql.includes("COMMAND_CREATED"));
  assert.equal(JSON.stringify(audit).match(/signature|public_key|enrollment_code|secret|cookie/i), null);
});

test("Block 3 admin routes reuse dashboard auth/readiness", () => {
  const source = fs.readFileSync(new URL("../device-bridge/block3-routes.js", import.meta.url), "utf8");
  assert.match(source, /dashboardApiReady\(res\)/);
  assert.match(source, /dashboardApiAuthorized\(req\)/);
  assert.match(source, /requireDeviceBridgeReady\(res\)/);
  assert.match(source, /devices\/:deviceId\/heartbeat/);
});
