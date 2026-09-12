import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  T0_DEVICE_CAPABILITIES,
  T1_DEVICE_CAPABILITIES,
  T2_DEVICE_CAPABILITIES,
  T4_DEVICE_CAPABILITIES,
  T4_RESUME_DEVICE_CAPABILITIES,
  T4_RESUME_ATTESTATION_DEVICE_CAPABILITIES,
  T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES,
  T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES,
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
  processHeartbeatTransaction as processHeartbeatTransactionRaw
} from "../device-bridge/heartbeat.js";
import {
  COMMAND_EXPIRY_MS,
  canonicalCommand,
  createAdminCommandHandler,
  createAdminDeviceListHandler,
  createAdminDeviceStatusHandler
} from "../device-bridge/admin.js";

const heartbeatSource = fs.readFileSync(
  new URL("../device-bridge/heartbeat.js", import.meta.url),
  "utf8"
);

const NOW = new Date("2026-09-01T12:34:56.000Z");
const CANONICAL_V8_FOUNDATION = async () => ({ state: "CANONICAL" });
const UPGRADE_REQUIRED_V8_FOUNDATION = async () => ({ state: "UPGRADE_REQUIRED" });
const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const KEY_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const REQUEST_ID = "d2675347-0888-4548-9feb-ae4d71a972cf";
const LOCAL_ATTESTATION_COMMAND_ID = "4dbf2bd9-3d7c-4925-89de-fc0dc62a2fe1";
const INSTALLATION_ID = "c7cb0b92-ad3c-4ec6-88dc-d149ef536c3d";
const CAPABILITIES = T0_DEVICE_CAPABILITIES;

// Most heartbeat fixtures model the pre-V8 canonical predecessor and do not
// emulate the catalog inspector's complete V6 query set.  Keep that explicit:
// callers exercising V8/drift pass their own exact inspector result below.
async function processHeartbeatTransaction(pool, auth, heartbeat, now, options = {}) {
  return processHeartbeatTransactionRaw(pool, auth, heartbeat, now, {
    inspectUnboundInboxConversationSweepFoundation: UPGRADE_REQUIRED_V8_FOUNDATION,
    ...options
  });
}

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

function heartbeatPool({
  request, sequence = null, bodyHash = null, acceptedAt = null, commands = [], hydrationRows = new Map(),
  failUpdate = false, nonceReplay = false, localAttestationFoundation = false,
  unboundInboxSweepFoundation = false, sweepRuntime = null,
  priorFreshInboxObservation = false, persistedSweepObservation = false,
  activeSweepChild = false, activeSweepParent = false, expiredSweepRows = []
} = {}) {
  const calls = [];
  const state = {
    updates: 0, audits: 0, commits: 0, rollbacks: 0, nonceInserts: 0, hydrationQueries: 0,
    queuedSweepCommands: [], createdSweeps: [], createdSweepSteps: [], sweepAudits: []
  };
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
      if (sql.includes("bridge_service_state") && sql.includes("last_heartbeat_sequence") && sql.includes("FOR UPDATE")) {
        return { rows: sweepRuntime ? [{ ...sweepRuntime }] : [] };
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
      if (sql.includes("to_regclass('tinder_local_conversation_attestation_permits')")) {
        return { rows: [{ relation_name: localAttestationFoundation ? "tinder_local_conversation_attestation_permits" : null }] };
      }
      if (sql.includes("to_regclass('tinder_unbound_inbox_conversation_sweeps')")) {
        return { rows: [{
          sweep_relation: unboundInboxSweepFoundation ? "tinder_unbound_inbox_conversation_sweeps" : null,
          step_relation: unboundInboxSweepFoundation ? "tinder_unbound_inbox_conversation_sweep_steps" : null
        }] };
      }
      if (sql.includes("FROM device_bridge_audit_events e") && sql.includes("observation_nonce")) {
        return { rows: [{ consumed: priorFreshInboxObservation }] };
      }
      if (sql.includes("FROM tinder_unbound_inbox_conversation_sweeps") && sql.includes("inbox_observation_nonce")) {
        return { rows: [{ found: persistedSweepObservation }] };
      }
      if (sql.includes("WITH child_expired AS")) return { rows: expiredSweepRows };
      if (sql.includes("FROM tinder_unbound_inbox_conversation_sweeps")
          && sql.includes("AS active")) {
        return { rows: [{ active: activeSweepParent }] };
      }
      if (sql.includes("AS active") && (sql.includes("permit_state") || sql.includes("sweep_state"))) {
        return { rows: [{ active: false }] };
      }
      if (sql.includes("INSERT INTO device_bridge_commands") && sql.includes("SELECT $1,d.device_id,1,$3,'{}'::jsonb")) {
        const [commandId, deviceId, commandType, expiresAt] = params;
        state.queuedSweepCommands.push({
          command_id: commandId, device_id: deviceId, protocol_version: 1, command_type: commandType,
          issued_at: NOW, expires_at: new Date(expiresAt), configuration_revision: 1, payload: {}
        });
        return { rows: [{ command_id: commandId }] };
      }
      if (sql.includes("INSERT INTO tinder_unbound_inbox_conversation_sweeps")) {
        state.createdSweeps.push({ params });
        return { rows: [{ sweep_id: params[0] }] };
      }
      if (sql.includes("INSERT INTO tinder_unbound_inbox_conversation_sweep_steps")) {
        state.createdSweepSteps.push({ params });
        return { rows: [{ command_id: params[0] }] };
      }
      if (sql.includes("INSERT INTO tinder_unbound_inbox_conversation_sweep_audit")) {
        state.sweepAudits.push({ params });
        return { rows: [{ audit_id: params[0] }] };
      }
      if (sql.includes("FROM device_bridge_commands")) {
        const explicitlyAdminOnly = sql.includes(
          "command_type IN ('PING','REQUEST_STATUS','STOP_BRIDGE')"
        );
        const deliversT1 = sql.includes("CONNECT_TINDER") && sql.includes("DISCONNECT_TINDER");
        const deliversT2 = deliversT1 && sql.includes("ARM_TINDER_CONVERSATION_BINDING");
        const deliversT5 = deliversT2 && sql.includes("SEND_TINDER_DRAFT");
        const deliversT4 = deliversT2 && sql.includes("SYNC_TINDER_VISIBLE_CHAT");
        const deliversT4Resume = deliversT4 && sql.includes("RESUME_OFFICIAL_TINDER_APP");
        const deliversPostChat = deliversT4Resume && sql.includes("STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION");
        const deliversUnboundInboxSweep = deliversPostChat
          && sql.includes("READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT")
          && sql.includes("RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT");
        const allowed = explicitlyAdminOnly
          ? new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE"])
          : deliversUnboundInboxSweep
          ? new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE", "CONNECT_TINDER", "DISCONNECT_TINDER", "ARM_TINDER_CONVERSATION_BINDING", "SYNC_TINDER_VISIBLE_CHAT", "RESUME_OFFICIAL_TINDER_APP", "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION", "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT", "RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT"])
          : deliversPostChat
          ? new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE", "CONNECT_TINDER", "DISCONNECT_TINDER", "ARM_TINDER_CONVERSATION_BINDING", "SYNC_TINDER_VISIBLE_CHAT", "RESUME_OFFICIAL_TINDER_APP", "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION"])
          : deliversT4Resume
          ? new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE", "CONNECT_TINDER", "DISCONNECT_TINDER", "ARM_TINDER_CONVERSATION_BINDING", "SYNC_TINDER_VISIBLE_CHAT", "RESUME_OFFICIAL_TINDER_APP"])
          : deliversT4
          ? new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE", "CONNECT_TINDER", "DISCONNECT_TINDER", "ARM_TINDER_CONVERSATION_BINDING", "SYNC_TINDER_VISIBLE_CHAT"])
          : deliversT5
          ? new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE", "CONNECT_TINDER", "DISCONNECT_TINDER", "ARM_TINDER_CONVERSATION_BINDING", "SEND_TINDER_DRAFT"])
          : deliversT2
          ? new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE", "CONNECT_TINDER", "DISCONNECT_TINDER", "ARM_TINDER_CONVERSATION_BINDING"])
          : deliversT1
          ? new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE", "CONNECT_TINDER", "DISCONNECT_TINDER"])
          : new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE"]);
        return {
          rows: [...commands, ...state.queuedSweepCommands].filter(command => allowed.has(command.command_type)
            && (!deliversPostChat
              || command.command_type !== "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION"
              || (command.payload?.binding_revision && command.payload?.attestation_contract_version === "2"
                && Object.keys(command.payload).length === 2))
            && (!activeSweepChild
              || !sql.includes("active_sweep.active_command_id=active_step.command_id")
              || ["READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT", "RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT"].includes(command.command_type)))
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

test("optional Tinder inbox navigation heartbeat diagnostic is strict and content-free", async () => {
  const diagnostic = {
    stage: "AWAITING_INBOX",
    reason: "NONE",
    visible_conversation_count: 0,
    observed_event_count: 2
  };
  const payload = heartbeatPayload({ tinder_inbox_navigation: diagnostic });
  const request = heartbeatRequest(payload);
  assert.deepEqual(parseAndValidateHeartbeat(request.req).tinder_inbox_navigation, diagnostic);

  const fake = heartbeatPool({ request });
  await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    payload,
    NOW
  );
  const audit = fake.calls.find(call => call.sql.includes("INSERT INTO device_bridge_audit_events"));
  assert.deepEqual(JSON.parse(audit.params[3]), {
    sequence: 1,
    tinder_inbox_navigation: diagnostic
  });
  const update = fake.calls.find(call => call.sql.includes("UPDATE device_bridge_devices"));
  assert.equal(JSON.stringify(update.params).includes("AWAITING_INBOX"), false);

  for (const inboxNavigation of [
    null,
    {},
    { ...diagnostic, stage: "UNBOUNDED" },
    { ...diagnostic, reason: "UNBOUNDED" },
    { ...diagnostic, visible_conversation_count: 9 },
    { ...diagnostic, observed_event_count: -1 },
    { ...diagnostic, extra: "forbidden" }
  ]) {
    const invalid = heartbeatPayload({ tinder_inbox_navigation: inboxNavigation });
    assert.throws(
      () => parseAndValidateHeartbeat(heartbeatRequest(invalid).req),
      error => error.code === "INVALID_DEVICE_STATE"
    );
  }
});

test("a fresh reviewed Inbox observation is atomically consumed and can issue one empty V8 READ child", async () => {
  const observationNonce = "0bfa798e-85ce-4c2e-830e-df8465c58f70";
  const capabilities = T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES;
  const navigation = {
    stage: "INBOX_READY",
    reason: "NONE",
    visible_conversation_count: 2,
    observed_event_count: 3,
    observation_kind: "FRESH_REVIEWED_INBOX_V1",
    observation_nonce: observationNonce
  };
  const payload = heartbeatPayload({ capabilities, tinder_state: "CONNECTED", tinder_inbox_navigation: navigation });
  const request = heartbeatRequest(payload);
  const sweepRuntime = {
    device_id: DEVICE_ID,
    enrollment_state: "ACTIVE",
    revoked_at: null,
    last_heartbeat_sequence: payload.sequence,
    last_accepted_heartbeat_at: NOW,
    bridge_service_state: "RUNNING",
    tinder_state: "CONNECTED",
    automation_state: "STOPPED",
    capabilities
  };
  const fake = heartbeatPool({
    request, unboundInboxSweepFoundation: true, sweepRuntime
  });

  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    payload,
    NOW,
    { inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION }
  );

  const read = response.commands.filter(command => command.type === "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT");
  assert.equal(read.length, 1);
  assert.deepEqual(read[0].payload, {});
  assert.equal(fake.state.createdSweeps.length, 1);
  assert.equal(fake.state.createdSweepSteps.length, 1);
  assert.equal(fake.state.sweepAudits.length, 2);
  const heartbeatAuditIndex = fake.calls.findIndex(call => call.sql.includes("INSERT INTO device_bridge_audit_events"));
  const parentWriteIndex = fake.calls.findIndex(call => call.sql.includes("INSERT INTO tinder_unbound_inbox_conversation_sweeps"));
  assert.ok(heartbeatAuditIndex >= 0 && parentWriteIndex > heartbeatAuditIndex);
  const heartbeatAudit = fake.calls[heartbeatAuditIndex];
  assert.equal(JSON.parse(heartbeatAudit.params[3]).tinder_inbox_navigation.observation_nonce, observationNonce);
  assert.equal(JSON.stringify(response).includes(observationNonce), false);

  const sameSequence = heartbeatPool({
    request, sequence: payload.sequence, bodyHash: request.hash, acceptedAt: NOW,
    unboundInboxSweepFoundation: true, sweepRuntime
  });
  const idempotent = await processHeartbeatTransaction(
    sameSequence.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "ee8e86de-44bd-4dce-82ea-aa995e8d37a4", contentSha256: request.hash },
    payload,
    NOW,
    { inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION }
  );
  assert.equal(idempotent.commands.some(command => command.type === "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT"), false);
  assert.equal(sameSequence.state.createdSweeps.length, 0);

  const freshReplayPayload = heartbeatPayload({
    sequence: 2, capabilities, tinder_state: "CONNECTED", tinder_inbox_navigation: navigation
  });
  const freshReplayRequest = heartbeatRequest(freshReplayPayload, {
    requestId: "eb2a678d-77a8-4d11-864d-c1d56a47b4f8"
  });
  const replayRuntime = { ...sweepRuntime, last_heartbeat_sequence: 2 };
  const replay = heartbeatPool({
    request: freshReplayRequest, sequence: 1, bodyHash: request.hash, acceptedAt: NOW,
    unboundInboxSweepFoundation: true, sweepRuntime: replayRuntime, priorFreshInboxObservation: true
  });
  const replayResponse = await processHeartbeatTransaction(
    replay.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "eb2a678d-77a8-4d11-864d-c1d56a47b4f8", contentSha256: freshReplayRequest.hash },
    freshReplayPayload,
    NOW,
    { inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION }
  );
  assert.equal(replayResponse.commands.some(command => command.type === "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT"), false);
  assert.equal(replay.state.createdSweeps.length, 0);
});

test("partial or unknown V8 schema is inert: it cannot issue or deliver a V8 child", async () => {
  const observationNonce = "7bfa798e-85ce-4c2e-830e-df8465c58f70";
  const capabilities = T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES;
  const payload = heartbeatPayload({
    capabilities,
    tinder_state: "CONNECTED",
    tinder_inbox_navigation: {
      stage: "INBOX_READY",
      reason: "NONE",
      visible_conversation_count: 2,
      observed_event_count: 1,
      observation_kind: "FRESH_REVIEWED_INBOX_V1",
      observation_nonce: observationNonce
    }
  });
  const request = heartbeatRequest(payload, {
    requestId: "8bfa798e-85ce-4c2e-830e-df8465c58f70"
  });
  const fake = heartbeatPool({
    request,
    unboundInboxSweepFoundation: true,
    sweepRuntime: {
      device_id: DEVICE_ID,
      enrollment_state: "ACTIVE",
      revoked_at: null,
      last_heartbeat_sequence: payload.sequence,
      last_accepted_heartbeat_at: NOW,
      bridge_service_state: "RUNNING",
      tinder_state: "CONNECTED",
      automation_state: "STOPPED",
      capabilities
    }
  });
  let inspections = 0;
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "8bfa798e-85ce-4c2e-830e-df8465c58f70", contentSha256: request.hash },
    payload,
    NOW,
    {
      inspectUnboundInboxConversationSweepFoundation: async () => {
        inspections += 1;
        return { state: "INVALID" };
      }
    }
  );

  assert.equal(inspections, 1);
  assert.equal(response.commands.some(command => command.type.includes("UNBOUND_INBOX_CONVERSATION_SWEEP")), false);
  assert.equal(fake.state.createdSweeps.length, 0);
  assert.equal(fake.state.createdSweepSteps.length, 0);
  const selection = fake.calls.find(call => String(call.sql).includes("FROM device_bridge_commands"));
  assert.doesNotMatch(selection.sql, /READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT/);
});

test("heartbeat uses the strict V8 schema inspector, never a relation-presence shortcut", () => {
  assert.match(heartbeatSource, /inspectTinderUnboundInboxConversationSweepSchema/);
  assert.match(
    heartbeatSource,
    /inspection\?\.state === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE\.CANONICAL/
  );
  assert.doesNotMatch(
    heartbeatSource,
    /to_regclass\('tinder_unbound_inbox_conversation_sweeps'\)/
  );
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

test("V4 visible-chat sync command is delivered only to the exact V4 profile with an empty payload", async () => {
  const command = commandRow(
    "SYNC_TINDER_VISIBLE_CHAT",
    new Date(NOW.valueOf() - 1000),
    "4f444444-4444-4444-8444-444444444444"
  );
  const t5Payload = heartbeatPayload({ capabilities: T5_DEVICE_CAPABILITIES, tinder_state: "CONNECTED" });
  const t5Request = heartbeatRequest(t5Payload);
  const t5 = heartbeatPool({ request: t5Request, commands: [command] });
  const t5Response = await processHeartbeatTransaction(
    t5.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: t5Request.hash },
    t5Payload,
    NOW
  );
  assert.deepEqual(t5Response.commands, []);
  assert.doesNotMatch(t5.calls.find(call => call.sql.includes("FROM device_bridge_commands")).sql, /SYNC_TINDER_VISIBLE_CHAT/);

  const v4Payload = heartbeatPayload({ capabilities: T4_DEVICE_CAPABILITIES, tinder_state: "CONNECTED" });
  const v4Request = heartbeatRequest(v4Payload);
  const v4 = heartbeatPool({ request: v4Request, commands: [command] });
  const v4Response = await processHeartbeatTransaction(
    v4.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: v4Request.hash },
    v4Payload,
    NOW
  );
  assert.deepEqual(v4Response.commands, [{
    command_id: command.command_id,
    protocol_version: 1,
    type: "SYNC_TINDER_VISIBLE_CHAT",
    issued_at: command.issued_at.toISOString(),
    expires_at: command.expires_at.toISOString(),
    configuration_revision: 1,
    payload: {}
  }]);
  assert.match(v4.calls.find(call => call.sql.includes("FROM device_bridge_commands")).sql, /SYNC_TINDER_VISIBLE_CHAT/);
  assert.doesNotMatch(v4.calls.find(call => call.sql.includes("FROM device_bridge_commands")).sql, /SEND_TINDER_DRAFT/);
});

test("official Tinder-app resume command is delivered only to the exact resume profile with an empty payload", async () => {
  const command = commandRow(
    "RESUME_OFFICIAL_TINDER_APP",
    new Date(NOW.valueOf() - 1000),
    "4a444444-4444-4444-8444-444444444444"
  );
  const v4Payload = heartbeatPayload({ capabilities: T4_DEVICE_CAPABILITIES, tinder_state: "CONNECTED" });
  const v4Request = heartbeatRequest(v4Payload);
  const v4 = heartbeatPool({ request: v4Request, commands: [command] });
  const v4Response = await processHeartbeatTransaction(
    v4.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: v4Request.hash },
    v4Payload,
    NOW
  );
  assert.deepEqual(v4Response.commands, []);
  assert.doesNotMatch(v4.calls.find(call => call.sql.includes("FROM device_bridge_commands")).sql, /RESUME_OFFICIAL_TINDER_APP/);

  const resumePayload = heartbeatPayload({ capabilities: T4_RESUME_DEVICE_CAPABILITIES, tinder_state: "CONNECTED" });
  const resumeRequest = heartbeatRequest(resumePayload);
  const resume = heartbeatPool({ request: resumeRequest, commands: [command] });
  const resumeResponse = await processHeartbeatTransaction(
    resume.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: resumeRequest.hash },
    resumePayload,
    NOW
  );
  assert.deepEqual(resumeResponse.commands, [{
    command_id: command.command_id,
    protocol_version: 1,
    type: "RESUME_OFFICIAL_TINDER_APP",
    issued_at: command.issued_at.toISOString(),
    expires_at: command.expires_at.toISOString(),
    configuration_revision: 1,
    payload: {}
  }]);
  const query = resume.calls.find(call => call.sql.includes("FROM device_bridge_commands"));
  assert.match(query.sql, /RESUME_OFFICIAL_TINDER_APP/);
  assert.doesNotMatch(query.sql, /SEND_TINDER_DRAFT/);
  assert.doesNotMatch(JSON.stringify(resumeResponse), /package|component|uri|chat|capture|identity/i);
});

test("V8 sweep children are delivered only to the exact V8 profile and an active exact-empty child", async () => {
  const command = commandRow(
    "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT",
    new Date(NOW.valueOf() - 1_000),
    "5a444444-4444-4444-8444-444444444444"
  );

  const v8Payload = heartbeatPayload({
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED"
  });
  const v8Request = heartbeatRequest(v8Payload, {
    requestId: "6a444444-4444-4444-8444-444444444444"
  });
  const v8 = heartbeatPool({
    request: v8Request,
    commands: [command],
    localAttestationFoundation: true,
    unboundInboxSweepFoundation: true
  });
  const v8Response = await processHeartbeatTransaction(
    v8.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "6a444444-4444-4444-8444-444444444444", contentSha256: v8Request.hash },
    v8Payload,
    NOW,
    { inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION }
  );
  assert.deepEqual(v8Response.commands, [{
    command_id: command.command_id,
    protocol_version: 1,
    type: "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT",
    issued_at: command.issued_at.toISOString(),
    expires_at: command.expires_at.toISOString(),
    configuration_revision: 1,
    payload: {}
  }]);
  const selection = v8.calls.find(call => String(call.sql).includes("FROM device_bridge_commands"));
  assert.match(selection.sql, /READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT/);
  assert.match(selection.sql, /RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT/);
  assert.match(selection.sql, /step\.child_state='ISSUED'/);
  assert.match(selection.sql, /device_bridge_commands\.payload='\{\}'::jsonb/);
  assert.doesNotMatch(JSON.stringify(v8Response.commands[0].payload), /contact|binding|capture|row|slot|sweep|thread/i);
});

test("an active V8 child is delivered alone, never batched with another nonterminal Tinder command", async () => {
  const read = commandRow(
    "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT",
    new Date(NOW.valueOf() - 1_000),
    "7a444444-4444-4444-8444-444444444444"
  );
  const resume = commandRow(
    "RESUME_OFFICIAL_TINDER_APP",
    new Date(NOW.valueOf() - 900),
    "8a444444-4444-4444-8444-444444444444"
  );
  const payload = heartbeatPayload({
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED"
  });
  const request = heartbeatRequest(payload, {
    requestId: "9a444444-4444-4444-8444-444444444444"
  });
  const fake = heartbeatPool({
    request,
    commands: [read, resume],
    localAttestationFoundation: true,
    unboundInboxSweepFoundation: true,
    activeSweepChild: true
  });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "9a444444-4444-4444-8444-444444444444", contentSha256: request.hash },
    payload,
    NOW,
    { inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION }
  );

  assert.deepEqual(response.commands.map(command => command.type), [
    "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT"
  ]);
  const selection = fake.calls.find(call => String(call.sql).includes("FROM device_bridge_commands"));
  assert.match(selection.sql, /active_sweep\.active_command_id=active_step\.command_id/);
  assert.match(selection.sql, /OR command_type IN \('READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT','RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT'\)/);
});

test("an expired V8 child is terminalized and audited before delivery, so an older dynamic command is withheld", async () => {
  const olderResume = commandRow(
    "RESUME_OFFICIAL_TINDER_APP",
    new Date(NOW.valueOf() - 1_000),
    "aa444444-4444-4444-8444-444444444444"
  );
  const expiredChildCommandId = "ab444444-4444-4444-8444-444444444444";
  const payload = heartbeatPayload({
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED"
  });
  const request = heartbeatRequest(payload, {
    requestId: "ac444444-4444-4444-8444-444444444444"
  });
  const fake = heartbeatPool({
    request,
    commands: [olderResume],
    localAttestationFoundation: true,
    unboundInboxSweepFoundation: true,
    expiredSweepRows: [{
      sweep_id: "ad444444-4444-4444-8444-444444444444",
      device_id: DEVICE_ID,
      sweep_state: "STOPPED",
      max_slots: 8,
      next_slot: 1,
      active_command_id: null,
      expires_at: new Date(NOW.valueOf() + 60_000),
      expired_command_id: expiredChildCommandId,
      expired_slot_ordinal: 1
    }]
  });

  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "ac444444-4444-4444-8444-444444444444", contentSha256: request.hash },
    payload,
    NOW,
    { inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION }
  );

  assert.deepEqual(response.commands, []);
  assert.equal(
    fake.calls.some(call => String(call.sql).includes("SELECT command_id, protocol_version, command_type, issued_at, expires_at")),
    false
  );
  assert.equal(fake.state.sweepAudits.length, 1);
  assert.deepEqual(fake.state.sweepAudits[0].params.slice(2, 8), [
    expiredChildCommandId, DEVICE_ID, 1, null,
    "CHILD_EXPIRED", "CHILD_EXPIRED"
  ]);
});

test("a noncanonical V8 foundation never falls back to deliver older dynamic Tinder commands", async () => {
  const olderResume = commandRow(
    "RESUME_OFFICIAL_TINDER_APP",
    new Date(NOW.valueOf() - 1_000),
    "ae444444-4444-4444-8444-444444444444"
  );
  const payload = heartbeatPayload({
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED"
  });
  const request = heartbeatRequest(payload, {
    requestId: "af444444-4444-4444-8444-444444444444"
  });
  const fake = heartbeatPool({ request, commands: [olderResume] });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "af444444-4444-4444-8444-444444444444", contentSha256: request.hash },
    payload,
    NOW,
    { inspectUnboundInboxConversationSweepFoundation: async () => ({ state: "INVALID" }) }
  );

  assert.deepEqual(response.commands, []);
  const selection = fake.calls.find(call => String(call.sql).includes("SELECT command_id, protocol_version, command_type, issued_at, expires_at"));
  assert.ok(selection);
  assert.match(selection.sql, /command_type IN \('PING','REQUEST_STATUS','STOP_BRIDGE'\)/);
  assert.doesNotMatch(selection.sql, /tinder_unbound_inbox_conversation_sweeps/);
});

test("an INVALID V8 catalog suppresses legacy dynamic delivery even after capability downgrade", async () => {
  const olderResume = commandRow(
    "RESUME_OFFICIAL_TINDER_APP",
    new Date(NOW.valueOf() - 1_000),
    "af444444-4444-4444-8444-444444444445"
  );
  const payload = heartbeatPayload({
    // The active parent may have been issued by an earlier V8-capable
    // runtime.  A later legacy profile must not use INVALID catalog state to
    // bypass serial execution and receive an unrelated old command.
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED"
  });
  const request = heartbeatRequest(payload, {
    requestId: "bf444444-4444-4444-8444-444444444444"
  });
  const fake = heartbeatPool({
    request,
    commands: [olderResume],
    localAttestationFoundation: true
  });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "bf444444-4444-4444-8444-444444444444", contentSha256: request.hash },
    payload,
    NOW,
    { inspectUnboundInboxConversationSweepFoundation: async () => ({ state: "INVALID" }) }
  );
  assert.deepEqual(response.commands, []);
  const selection = fake.calls.find(call => String(call.sql).includes("SELECT command_id, protocol_version, command_type, issued_at, expires_at"));
  assert.ok(selection);
  assert.match(selection.sql, /command_type IN \('PING','REQUEST_STATUS','STOP_BRIDGE'\)/);
});

test("an active V8 parent suppresses legacy dynamic delivery after a capability downgrade", async () => {
  const olderResume = commandRow(
    "RESUME_OFFICIAL_TINDER_APP",
    new Date(NOW.valueOf() - 1_000),
    "b0444444-4444-4444-8444-444444444444"
  );
  const payload = heartbeatPayload({
    // This profile deliberately lacks the V8 capability: it models a later
    // heartbeat from an older runtime after a V8 parent was already issued.
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED"
  });
  const request = heartbeatRequest(payload, {
    requestId: "b1444444-4444-4444-8444-444444444444"
  });
  const fake = heartbeatPool({
    request,
    commands: [olderResume],
    localAttestationFoundation: true,
    activeSweepParent: true
  });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "b1444444-4444-4444-8444-444444444444", contentSha256: request.hash },
    payload,
    NOW,
    { inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION }
  );

  assert.deepEqual(response.commands, []);
  const selection = fake.calls.find(call => String(call.sql).includes("SELECT command_id, protocol_version, command_type, issued_at, expires_at"));
  assert.ok(selection);
  assert.match(selection.sql, /command_type IN \('PING','REQUEST_STATUS','STOP_BRIDGE'\)/);
  const expiry = fake.calls.find(call => String(call.sql).includes("WITH child_expired AS"));
  assert.ok(expiry);
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

function statusRow(lastAccepted = null, capabilities = CAPABILITIES, tinderState = "UNKNOWN", inboxNavigation = null) {
  return {
    device_id: DEVICE_ID, display_name: "ZTE Blade A35e", enrollment_state: "ACTIVE",
    created_at: NOW,
    last_accepted_heartbeat_at: lastAccepted, app_version_name: "1.0", app_version_code: "1",
    bridge_service_state: "RUNNING", tinder_state: tinderState, automation_state: "STOPPED", capabilities,
    configuration_revision: 1,
    inbox_navigation: inboxNavigation
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

test("admin status projects the bounded post-chat compatibility bit without raw capability data", async () => {
  for (const [capabilities, expected] of [
    [T4_RESUME_ATTESTATION_DEVICE_CAPABILITIES, false],
    [T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES, true]
  ]) {
    const pool = { async query() { return { rows: [statusRow(NOW, capabilities, "CONNECTED")] }; } };
    const res = responseRecorder();
    await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
    assert.equal(res.body.device.tinder_local_conversation_attestation_post_chat_capable, expected);
    assert.equal(JSON.stringify(res.body).includes("TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_V2"), false);
    assert.equal(JSON.stringify(res.body).includes("capabilities"), false);
  }
});

test("admin status projects only the newest bounded inbox navigation heartbeat diagnostic", async () => {
  const diagnostic = {
    stage: "BLOCKED",
    reason: "ACCESSIBILITY_UNBOUND",
    visible_conversation_count: 0,
    observed_event_count: 3
  };
  let sql = "";
  const acceptedNow = new Date();
  const pool = {
    async query(query) {
      sql = query;
      return { rows: [statusRow(acceptedNow, T4_RESUME_DEVICE_CAPABILITIES, "CONNECTED", diagnostic)] };
    }
  };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.deepEqual(res.body.device.inbox_navigation, diagnostic);
  assert.match(sql, /device_bridge_audit_events/);
  assert.match(sql, /HEARTBEAT_ACCEPTED/);
  assert.match(sql, /tinder_inbox_navigation/);
  assert.match(sql, /ORDER BY e\.created_at DESC, e\.audit_event_id DESC/);
  assert.equal(JSON.stringify(res.body.device).includes("details"), false);
});

test("admin status strips a valid fresh Inbox observation nonce while preserving bounded navigation state", async () => {
  const diagnostic = {
    stage: "INBOX_READY",
    reason: "NONE",
    visible_conversation_count: 2,
    observed_event_count: 3,
    observation_kind: "FRESH_REVIEWED_INBOX_V1",
    observation_nonce: "0bfa798e-85ce-4c2e-830e-df8465c58f70"
  };
  const acceptedNow = new Date();
  const pool = {
    async query() {
      return { rows: [statusRow(acceptedNow, T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES, "CONNECTED", diagnostic)] };
    }
  };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.deepEqual(res.body.device.inbox_navigation, {
    stage: "INBOX_READY", reason: "NONE", visible_conversation_count: 2, observed_event_count: 3
  });
  assert.equal(JSON.stringify(res.body).includes(diagnostic.observation_nonce), false);
  assert.equal(JSON.stringify(res.body).includes(diagnostic.observation_kind), false);
});

test("admin status never projects a stale inbox navigation diagnostic for an offline device", async () => {
  const diagnostic = {
    stage: "BLOCKED",
    reason: "ACCESSIBILITY_UNBOUND",
    visible_conversation_count: 0,
    observed_event_count: 3
  };
  const offlineAt = new Date(Date.now() - 91_000);
  const pool = {
    async query() {
      return { rows: [statusRow(offlineAt, T4_RESUME_DEVICE_CAPABILITIES, "CONNECTED", diagnostic)] };
    }
  };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.equal(res.body.device.device_status, "OFFLINE");
  assert.equal(res.body.device.inbox_navigation, null);
});

test("missing or malformed inbox navigation audit data is unavailable, never stale", async () => {
  for (const diagnostic of [
    undefined,
    { stage: "BLOCKED", reason: "ACCESSIBILITY_UNBOUND", visible_conversation_count: 0 },
    { stage: "BLOCKED", reason: "ACCESSIBILITY_UNBOUND", visible_conversation_count: 9, observed_event_count: 0 }
  ]) {
    const pool = {
      async query() {
        return { rows: [statusRow(NOW, T4_RESUME_DEVICE_CAPABILITIES, "CONNECTED", diagnostic)] };
      }
    };
    const res = responseRecorder();
    await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
    assert.equal(res.body.device.inbox_navigation, null);
  }
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

test("official-app resume delivery revalidates a V2 binding snapshot without requiring V2 columns before migration", () => {
  assert.match(heartbeatSource, /COALESCE\(to_jsonb\(resume_permit\)->>'permit_contract_version', '1'\) = '1'/);
  assert.match(heartbeatSource, /to_jsonb\(resume_permit\)->>'permit_contract_version' = '2'/);
  assert.match(heartbeatSource, /binding\.binding_id::text=to_jsonb\(resume_permit\)->>'binding_id'/);
  assert.match(heartbeatSource, /binding\.binding_revision::text=to_jsonb\(resume_permit\)->>'binding_revision'/);
  assert.match(heartbeatSource, /binding\.binding_state='CONFIRMED'/);
  assert.match(heartbeatSource, /binding_permit\.permit_state='CONSUMED'/);
  assert.match(heartbeatSource, /binding_permit\.consumed_capture_id=resume_permit\.source_capture_id/);
  assert.match(heartbeatSource, /source_capture\.human_review_status='CONFIRMED'/);
  assert.match(heartbeatSource, /resume_permit\.expires_at>\$2/);
  assert.doesNotMatch(heartbeatSource, /resume_permit\.(?:binding_id|binding_revision|permit_contract_version)/);
});

test("post-chat attestation heartbeat remains healthy before the local-proof schema exists", async () => {
  const request = heartbeatRequest(heartbeatPayload({
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED"
  }));
  const staged = commandRow("STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION", NOW, LOCAL_ATTESTATION_COMMAND_ID, {
    payload: { binding_revision: "3", attestation_contract_version: "2" }
  });
  const fake = heartbeatPool({ request, commands: [staged] });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    heartbeatPayload({ capabilities: T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES, tinder_state: "CONNECTED" }),
    NOW
  );
  assert.deepEqual(response.commands, []);
  assert.equal(fake.state.commits, 1);
  assert.equal(fake.calls.some(call => /FROM\s+tinder_local_conversation_attestation_permits/i.test(String(call.sql))), false);
  assert.equal(fake.calls.some(call => String(call.sql).includes("to_regclass('tinder_local_conversation_attestation_permits')")), true);
});

test("legacy V1 attestation profile cannot receive a new post-chat command even when the foundation exists", async () => {
  const payload = heartbeatPayload({
    capabilities: T4_RESUME_ATTESTATION_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED"
  });
  const request = heartbeatRequest(payload);
  const staged = commandRow("STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION", NOW, LOCAL_ATTESTATION_COMMAND_ID, {
    payload: { binding_revision: "3", attestation_contract_version: "2" }
  });
  const fake = heartbeatPool({ request, commands: [staged], localAttestationFoundation: true });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    payload,
    NOW
  );
  assert.deepEqual(response.commands, []);
  assert.equal(fake.calls.some(call => String(call.sql).includes("to_regclass('tinder_local_conversation_attestation_permits')")), false);
  assert.equal(fake.calls.some(call => /FROM\s+tinder_local_conversation_attestation_permits/i.test(String(call.sql))), false);
});

test("exact post-chat profile can receive the exact opaque bootstrap after the foundation is present", async () => {
  const payload = heartbeatPayload({
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED"
  });
  const request = heartbeatRequest(payload);
  const staged = commandRow("STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION", NOW, LOCAL_ATTESTATION_COMMAND_ID, {
    payload: { binding_revision: "3", attestation_contract_version: "2" }
  });
  const fake = heartbeatPool({ request, commands: [staged], localAttestationFoundation: true });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    payload,
    NOW
  );
  assert.deepEqual(response.commands, [{
    command_id: LOCAL_ATTESTATION_COMMAND_ID,
    protocol_version: 1,
    type: "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION",
    issued_at: NOW.toISOString(),
    expires_at: new Date(NOW.valueOf() + 300_000).toISOString(),
    configuration_revision: 1,
    payload: { binding_revision: "3", attestation_contract_version: "2" }
  }]);
  assert.equal(fake.calls.some(call => /FROM\s+tinder_local_conversation_attestation_permits/i.test(String(call.sql))), true);
});

test("a V2-capable heartbeat does not deliver a historical one-field bootstrap", async () => {
  const payload = heartbeatPayload({
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED"
  });
  const request = heartbeatRequest(payload);
  const historic = commandRow("STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION", NOW, LOCAL_ATTESTATION_COMMAND_ID, {
    payload: { binding_revision: "3" }
  });
  const fake = heartbeatPool({ request, commands: [historic], localAttestationFoundation: true });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    payload,
    NOW
  );
  assert.deepEqual(response.commands, []);
  const selection = fake.calls.find(call => String(call.sql).includes("FROM device_bridge_commands"));
  assert.match(selection.sql, /payload \? 'attestation_contract_version'/);
  assert.match(selection.sql, /payload->>'attestation_contract_version'='2'/);
});

test("attested heartbeat delivery is bound to a live dedicated proof and the current source", () => {
  // These predicates are intentionally in the single command-selection query:
  // Android must not even observe a V2 reader command for an invalidated,
  // expired, rebound, non-attested, or malformed bootstrap proof.
  for (const required of [
    /attestation_permit\.permit_state='ISSUED'/,
    /attestation_permit\.permit_state='ATTESTED'/,
    /attestation_permit\.expires_at>\$2/,
    /attestation_command\.command_type='\$\{TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE\}'/,
    /attestation_command\.payload=jsonb_build_object\(\s*'binding_revision', attestation_permit\.binding_revision::text,\s*'attestation_contract_version', '\$\{TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_VERSION\}'\s*\)/s,
    /sync_permit\.permit_contract_version=2/,
    /attestation_permit\.binding_revision=sync_permit\.binding_revision/,
    /binding\.binding_revision=sync_permit\.binding_revision/,
    /binding\.binding_state='CONFIRMED'/,
    /binding_permit\.permit_state='CONSUMED'/,
    /source_capture\.capture_revision = \(\s*SELECT MAX\(newer\.capture_revision\)/,
    /device_bridge_commands\.payload=jsonb_build_object\(\s*'local_conversation_attestation', sync_permit\.attestation_command_id::text,\s*'binding_revision', sync_permit\.binding_revision::text\s*\)/s
  ]) assert.match(heartbeatSource, required);
});

test("Block 3 admin routes reuse dashboard auth/readiness", () => {
  const source = fs.readFileSync(new URL("../device-bridge/block3-routes.js", import.meta.url), "utf8");
  assert.match(source, /dashboardApiReady\(res\)/);
  assert.match(source, /dashboardApiAuthorized\(req\)/);
  assert.match(source, /requireDeviceBridgeReady\(res\)/);
  assert.match(source, /devices\/:deviceId\/heartbeat/);
});
