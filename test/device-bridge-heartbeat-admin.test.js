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
  T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_RETURN_DEVICE_CAPABILITIES,
  T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_RETURN_FOREGROUND_RETURN_DEVICE_CAPABILITIES,
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
  processHeartbeatTransaction as processHeartbeatTransactionRaw,
  TINDER_DISCOVERY_V16_STATES
} from "../device-bridge/heartbeat.js";
import {
  COMMAND_EXPIRY_MS,
  canonicalCommand,
  createAdminCommandHandler,
  createAdminDeviceListHandler,
  createAdminDeviceStatusHandler
} from "../device-bridge/admin.js";
import {
  TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_CLASS_FAMILIES,
  TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ROLE_COUNTS,
  TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_VIEW_ID_STATES
} from "../device-bridge/tinder-official-resume-schema-evidence-contract.js";

const heartbeatSource = fs.readFileSync(
  new URL("../device-bridge/heartbeat.js", import.meta.url),
  "utf8"
);

const NOW = new Date("2026-09-01T12:34:56.000Z");
const CANONICAL_V8_FOUNDATION = async () => ({ state: "CANONICAL" });
const UPGRADE_REQUIRED_V8_FOUNDATION = async () => ({ state: "UPGRADE_REQUIRED" });
const UPGRADE_REQUIRED_V9_FOUNDATION = async () => ({ state: "UPGRADE_REQUIRED" });
const UPGRADE_REQUIRED_V10_FOUNDATION = async () => ({ state: "UPGRADE_REQUIRED" });
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
  const {
    inspectUnboundInboxConversationSweepFoundation: inspectV8Foundation = UPGRADE_REQUIRED_V8_FOUNDATION,
    inspectUnboundInboxConversationSweepRuntimeFoundation,
    inspectVerifiedChatReturnFoundation = UPGRADE_REQUIRED_V9_FOUNDATION,
    inspectResumedForegroundChatReturnFoundation = UPGRADE_REQUIRED_V10_FOUNDATION,
    ...otherOptions
  } = options;
  return processHeartbeatTransactionRaw(pool, auth, heartbeat, now, {
    ...otherOptions,
    inspectUnboundInboxConversationSweepFoundation: inspectV8Foundation,
    // A direct V8 fixture is its own proof. V9-only tests inject a retained
    // V8 runtime inspector explicitly; the production code only invokes it
    // after the exact V9 successor was found canonical.
    inspectUnboundInboxConversationSweepRuntimeFoundation:
      inspectUnboundInboxConversationSweepRuntimeFoundation
      || (async () => ({ state: "INVALID" })),
    // Most fixtures intentionally model the predecessor catalog only. A V9
    // upgrade-required response preserves that historical command surface;
    // V9-specific tests inject CANONICAL explicitly.
    inspectVerifiedChatReturnFoundation,
    inspectResumedForegroundChatReturnFoundation
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

function schemaEvidenceCounts(fields, values = {}) {
  return Object.fromEntries(fields.map(field => [field, values[field] || 0]));
}

function officialResumeSchemaEvidence(overrides = {}) {
  const value = {
    evidence_version: "tinder-official-resume-schema-profile-v1",
    safety_status: "BLOCKED_UNKNOWN_STRUCTURE",
    tree_truncated: false,
    visible_node_count: 4,
    maximum_visible_depth: 3,
    class_family_counts: schemaEvidenceCounts(
      TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_CLASS_FAMILIES,
      { TEXT_VIEW: 1, EDIT_TEXT: 1, RECYCLER_VIEW: 1, FRAME_LAYOUT: 1 }),
    view_id_state_counts: schemaEvidenceCounts(
      TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_VIEW_ID_STATES,
      { ABSENT: 2, STATIC_TINDER_ID: 2 }),
    role_counts: schemaEvidenceCounts(
      TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ROLE_COUNTS,
      { HEADER_CONTAINER: 1, MESSAGE_LIST: 1, COMPOSER_CONTAINER: 1,
        COMPOSER_EDITABLE: 1, MESSAGE_TEXT_LEAF: 1 }),
    relation_flags: {
      header_before_message_list: true,
      message_list_before_composer: true,
      message_list_has_text_leaf: true,
      composer_has_editable_leaf: true,
      has_clickable_node: true,
      has_long_clickable_node: false,
      has_scrollable_node: true,
      has_text_present_node: true,
      has_content_description_present_node: false
    }
  };
  return { ...value, ...overrides };
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
  failUpdate = false, failUpdateCode = null, nonceReplay = false, localAttestationFoundation = false,
  unboundInboxSweepFoundation = false, sweepRuntime = null,
  priorFreshInboxObservation = false, persistedSweepObservation = false,
  activeSweepChild = false, activeSweepParent = false, expiredSweepRows = [],
  activeVerifiedChatReturnPermit = false, expiredVerifiedChatReturnRows = [],
  activeResumedForegroundChatReturnPermit = false,
  expiredResumedForegroundChatReturnRows = [],
  coordinatorRuntime = null,
  activeIssuedCoordinatorSweep = null,
  coordinatorChildCommandValid = true,
  coordinatorRows = [],
  nonCoordinatorPendingConnect = false,
  coordinatorQueueResult = true,
  coordinatorDeliveryValid = true,
  schemaEvidenceAlreadyReported = false,
  schemaEvidenceCandidateCount = 0,
  schemaEvidenceAuditFailure = false
} = {}) {
  const calls = [];
  const state = {
    updates: 0, audits: 0, commits: 0, rollbacks: 0, nonceInserts: 0, hydrationQueries: 0,
    queuedSweepCommands: [], createdSweeps: [], createdSweepSteps: [], sweepAudits: [],
    verifiedChatReturnAudits: [], resumedForegroundChatReturnAudits: [],
    coordinatorCommands: [], coordinatorAudits: []
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
      if (sql.includes("last_accepted_heartbeat_at") && sql.includes("automation_state")
          && sql.includes("FROM device_bridge_devices") && sql.includes("FOR UPDATE")) {
        return { rows: coordinatorRuntime ? [{ ...coordinatorRuntime }] : [] };
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
      if (sql.includes("schema_evidence_candidate_count")
          && sql.includes("paired_audit")) {
        if (schemaEvidenceAuditFailure) {
          const error = new Error("simulated schema evidence audit failure");
          error.code = "XX000";
          throw error;
        }
        const inserted = schemaEvidenceCandidateCount === 1 && !schemaEvidenceAlreadyReported;
        if (inserted) {
          state.audits += 1;
          state.schemaEvidenceAudit = { params };
        }
        return { rows: [{
          schema_evidence_candidate_count: schemaEvidenceCandidateCount,
          schema_evidence_already_reported: schemaEvidenceAlreadyReported,
          schema_evidence_inserted: inserted
        }] };
      }
      if (sql.includes("UPDATE device_bridge_devices")) {
        if (failUpdate) {
          const error = new Error("simulated update failure");
          if (typeof failUpdateCode === "string") error.code = failUpdateCode;
          throw error;
        }
        state.updates += 1; return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO device_bridge_audit_events")
          && sql.includes("jsonb_build_object('sweep_id',$4::text)")) {
        state.coordinatorAudits.push({ params });
        return { rows: [{ audit_event_id: 1 }] };
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
      if (sql.includes("FROM device_bridge_audit_events audit")
          && sql.includes("audit.details=jsonb_build_object('sweep_id',$3::text)")) {
        return { rows: coordinatorRows };
      }
      if (sql.includes("command.command_type='CONNECT_TINDER'")
          && sql.includes("audit.event_type=$3")
          && sql.includes("command.created_by=$4")) {
        return { rows: [{ active: nonCoordinatorPendingConnect }] };
      }
      if (sql.includes("FROM tinder_unbound_inbox_conversation_sweeps") && sql.includes("inbox_observation_nonce")) {
        return { rows: [{ found: persistedSweepObservation }] };
      }
      if (sql.includes("FROM tinder_unbound_inbox_conversation_sweeps sweep")
          && sql.includes("FOR UPDATE OF sweep, step")
          && sql.includes("step.child_state='ISSUED'")) {
        return { rows: activeIssuedCoordinatorSweep && coordinatorChildCommandValid
          ? [{ ...activeIssuedCoordinatorSweep }] : [] };
      }
      if (sql.includes("WITH child_expired AS")) return { rows: expiredSweepRows };
      if (sql.includes("UPDATE tinder_verified_chat_return_permits")
          && sql.includes("RETURNING command_id, device_id, binding_id, binding_revision")) {
        return { rows: expiredVerifiedChatReturnRows };
      }
      if (sql.includes("INSERT INTO tinder_verified_chat_return_audit")) {
        state.verifiedChatReturnAudits.push({ params });
        return { rows: [{ audit_id: params[0] }] };
      }
      if (sql.includes("UPDATE tinder_resumed_foreground_chat_return_permits")
          && sql.includes("RETURNING command_id, device_id")) {
        return { rows: expiredResumedForegroundChatReturnRows };
      }
      if (sql.includes("INSERT INTO tinder_resumed_foreground_chat_return_audit")) {
        state.resumedForegroundChatReturnAudits.push({ params });
        return { rows: [{ audit_id: params[0] }] };
      }
      if (sql.includes("INSERT INTO device_bridge_commands") && sql.includes("LEAST($4::timestamptz")
          && sql.includes("tinder_unbound_inbox_conversation_sweeps sweep")) {
        if (!coordinatorQueueResult) return { rows: [] };
        const [commandId, deviceId, sweepId, expiresAt] = params;
        state.coordinatorCommands.push({
          command_id: commandId, device_id: deviceId, protocol_version: 1,
          command_type: "CONNECT_TINDER", issued_at: NOW, expires_at: new Date(expiresAt),
          configuration_revision: 1, payload: {}, sweep_id: sweepId,
          created_by: "server_tinder_unbound_inbox_sweep_gate_recovery"
        });
        return { rows: [{ command_id: commandId }] };
      }
      if (sql.includes("FROM tinder_unbound_inbox_conversation_sweeps")
          && sql.includes("AS active")) {
        return { rows: [{ active: activeSweepParent }] };
      }
      if (sql.includes("FROM tinder_verified_chat_return_permits") && sql.includes("AS active")) {
        return { rows: [{ active: activeVerifiedChatReturnPermit }] };
      }
      if (sql.includes("FROM tinder_resumed_foreground_chat_return_permits") && sql.includes("AS active")) {
        return { rows: [{ active: activeResumedForegroundChatReturnPermit }] };
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
        ) || sql.includes("AND command_type IN ('PING','REQUEST_STATUS','STOP_BRIDGE')");
        const deliversT1 = sql.includes("CONNECT_TINDER") && sql.includes("DISCONNECT_TINDER");
        const deliversT2 = deliversT1 && sql.includes("ARM_TINDER_CONVERSATION_BINDING");
        const deliversT5 = deliversT2 && sql.includes("SEND_TINDER_DRAFT");
        const deliversT4 = deliversT2 && sql.includes("SYNC_TINDER_VISIBLE_CHAT");
        const deliversT4Resume = deliversT4 && sql.includes("RESUME_OFFICIAL_TINDER_APP");
        const deliversPostChat = deliversT4Resume && sql.includes("STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION");
        const deliversUnboundInboxSweep = deliversPostChat
          && sql.includes("READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT")
          && sql.includes("RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT");
        const deliversVerifiedChatReturn = deliversUnboundInboxSweep
          && sql.includes("RETURN_TINDER_VERIFIED_CHAT_TO_INBOX");
        const deliversResumedForegroundChatReturn = deliversVerifiedChatReturn
          && sql.includes("RETURN_TINDER_RESUMED_FOREGROUND_CHAT_TO_INBOX");
        const allowed = explicitlyAdminOnly
          ? new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE"])
          : deliversResumedForegroundChatReturn
          ? new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE", "CONNECT_TINDER", "DISCONNECT_TINDER", "ARM_TINDER_CONVERSATION_BINDING", "SYNC_TINDER_VISIBLE_CHAT", "RESUME_OFFICIAL_TINDER_APP", "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION", "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT", "RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT", "RETURN_TINDER_VERIFIED_CHAT_TO_INBOX", "RETURN_TINDER_RESUMED_FOREGROUND_CHAT_TO_INBOX"])
          : deliversVerifiedChatReturn
          ? new Set(["PING", "REQUEST_STATUS", "STOP_BRIDGE", "CONNECT_TINDER", "DISCONNECT_TINDER", "ARM_TINDER_CONVERSATION_BINDING", "SYNC_TINDER_VISIBLE_CHAT", "RESUME_OFFICIAL_TINDER_APP", "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION", "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT", "RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT", "RETURN_TINDER_VERIFIED_CHAT_TO_INBOX"])
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
        const candidates = [...commands, ...state.queuedSweepCommands, ...state.coordinatorCommands];
        return {
          rows: candidates.filter(command => allowed.has(command.command_type)
            && (!sql.includes("AND command_id=$4") || command.command_id === params[3])
            && (!sql.includes("created_by IS DISTINCT FROM 'server_tinder_unbound_inbox_sweep_gate_recovery'")
              || command.created_by !== "server_tinder_unbound_inbox_sweep_gate_recovery"
              || coordinatorDeliveryValid)
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
  const response = await processHeartbeatTransaction(
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
  assert.deepEqual(response.commands, []);
  assert.equal(fake.state.createdSweeps.length, 0);
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

test("terminal Tinder discovery V16 state is exact, content-free, and observational", async () => {
  const diagnostic = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "BASE_STRUCTURE_REJECTED"
  };
  const payload = heartbeatPayload({ tinder_inbox_navigation: diagnostic });
  const request = heartbeatRequest(payload);
  assert.deepEqual(parseAndValidateHeartbeat(request.req).tinder_inbox_navigation, diagnostic);
  assert.deepEqual(TINDER_DISCOVERY_V16_STATES, [
    "NOT_EVALUATED",
    "BASE_STRUCTURE_REJECTED",
    "LABEL_MATCH_COUNT_REJECTED",
    "TARGET_PARENT_REJECTED",
    "TARGET_ACTION_REJECTED",
    "STRICT_CHAT_LABEL_INBOX_CANDIDATE"
  ]);
  for (const state of TINDER_DISCOVERY_V16_STATES) {
    const candidate = { ...diagnostic, discovery_v16_state: state };
    assert.deepEqual(
      parseAndValidateHeartbeat(heartbeatRequest(
        heartbeatPayload({ tinder_inbox_navigation: candidate })
      ).req).tinder_inbox_navigation,
      candidate
    );
  }

  const fake = heartbeatPool({ request });
  const response = await processHeartbeatTransaction(
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
  assert.deepEqual(response.commands, []);
  assert.equal(fake.state.createdSweeps.length, 0);

  for (const inboxNavigation of [
    { ...diagnostic, discovery_v16_state: "UNBOUNDED" },
    { ...diagnostic, stage: "INBOX_READY", reason: "NONE" },
    { ...diagnostic, reason: "UNKNOWN_INBOX_STRUCTURE" },
    { ...diagnostic, observation_kind: "FRESH_REVIEWED_INBOX_V1" }
  ]) {
    const invalid = heartbeatPayload({ tinder_inbox_navigation: inboxNavigation });
    assert.throws(
      () => parseAndValidateHeartbeat(heartbeatRequest(invalid).req),
      error => error.code === "INVALID_DEVICE_STATE"
    );
  }
});

test("terminal Tinder discovery V16 selector counters are exact, capped, and observational", async () => {
  const diagnostic = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "LABEL_MATCH_COUNT_REJECTED",
    discovery_v16_raw_selector_match_count: 2,
    discovery_v16_qualified_selector_match_count: 0
  };
  const payload = heartbeatPayload({ tinder_inbox_navigation: diagnostic });
  const request = heartbeatRequest(payload);
  assert.deepEqual(parseAndValidateHeartbeat(request.req).tinder_inbox_navigation, diagnostic);

  const fake = heartbeatPool({ request });
  const response = await processHeartbeatTransaction(
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
  assert.deepEqual(response.commands, []);
  assert.equal(fake.state.createdSweeps.length, 0);

  for (const inboxNavigation of [
    { ...diagnostic, discovery_v16_raw_selector_match_count: -1 },
    { ...diagnostic, discovery_v16_raw_selector_match_count: 3 },
    { ...diagnostic, discovery_v16_raw_selector_match_count: 1.5 },
    { ...diagnostic, discovery_v16_qualified_selector_match_count: 3 },
    { ...diagnostic, stage: "INBOX_READY", reason: "NONE" },
    { ...diagnostic, observation_kind: "FRESH_REVIEWED_INBOX_V1" },
    (() => {
      const { discovery_v16_qualified_selector_match_count, ...withoutPair } = diagnostic;
      return withoutPair;
    })()
  ]) {
    const invalid = heartbeatPayload({ tinder_inbox_navigation: inboxNavigation });
    assert.throws(
      () => parseAndValidateHeartbeat(heartbeatRequest(invalid).req),
      error => error.code === "INVALID_DEVICE_STATE"
    );
  }
});

test("terminal Tinder discovery V16 may add only the finite direct-static V2 branch", async () => {
  const diagnostic = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "LABEL_MATCH_COUNT_REJECTED",
    discovery_v16_raw_selector_match_count: 2,
    discovery_v16_qualified_selector_match_count: 0,
    direct_static_v2_state: "DIRECT_CHILD_SET_REJECTED"
  };
  const payload = heartbeatPayload({ tinder_inbox_navigation: diagnostic });
  const request = heartbeatRequest(payload);
  assert.deepEqual(parseAndValidateHeartbeat(request.req).tinder_inbox_navigation, diagnostic);

  const fake = heartbeatPool({ request });
  const response = await processHeartbeatTransaction(
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
  assert.deepEqual(response.commands, []);
  assert.equal(fake.state.createdSweeps.length, 0);

  for (const inboxNavigation of [
    { ...diagnostic, direct_static_v2_state: "UNBOUNDED" },
    { ...diagnostic, stage: "INBOX_READY", reason: "NONE" },
    (() => {
      const { discovery_v16_qualified_selector_match_count, ...withoutCounter } = diagnostic;
      return withoutCounter;
    })(),
    (() => {
      const { discovery_v16_raw_selector_match_count,
        discovery_v16_qualified_selector_match_count, ...withoutCounters } = diagnostic;
      return withoutCounters;
    })()
  ]) {
    const invalid = heartbeatPayload({ tinder_inbox_navigation: inboxNavigation });
    assert.throws(
      () => parseAndValidateHeartbeat(heartbeatRequest(invalid).req),
      error => error.code === "INVALID_DEVICE_STATE"
    );
  }
});

test("terminal Tinder discovery V17 requires the exact V2 and V16 zero-count shape", async () => {
  const diagnostic = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "LABEL_MATCH_COUNT_REJECTED",
    discovery_v16_raw_selector_match_count: 0,
    discovery_v16_qualified_selector_match_count: 0,
    direct_static_v2_state: "DIRECT_CHILD_SET_REJECTED",
    discovery_v17_carrier_relation_state: "EXACT_CARRIER_FOUR_DIRECT_CHILDREN"
  };
  const payload = heartbeatPayload({ tinder_inbox_navigation: diagnostic });
  const request = heartbeatRequest(payload);
  assert.deepEqual(parseAndValidateHeartbeat(request.req).tinder_inbox_navigation, diagnostic);

  const fake = heartbeatPool({ request });
  const response = await processHeartbeatTransaction(
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
  assert.deepEqual(response.commands, []);

  for (const inboxNavigation of [
    { ...diagnostic, discovery_v17_carrier_relation_state: "UNBOUNDED" },
    { ...diagnostic, discovery_v16_state: "BASE_STRUCTURE_REJECTED" },
    { ...diagnostic, discovery_v16_raw_selector_match_count: 1 },
    { ...diagnostic, discovery_v16_qualified_selector_match_count: 1 },
    { ...diagnostic, stage: "INBOX_READY", reason: "NONE" },
    (() => {
      const { direct_static_v2_state, ...withoutV2 } = diagnostic;
      return withoutV2;
    })()
  ]) {
    assert.throws(
      () => parseAndValidateHeartbeat(heartbeatRequest(
        heartbeatPayload({ tinder_inbox_navigation: inboxNavigation })).req),
      error => error.code === "INVALID_DEVICE_STATE"
    );
  }
});

test("terminal Tinder discovery V18 requires the exact V16 zero and V17 negative chain", async () => {
  const diagnostic = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "LABEL_MATCH_COUNT_REJECTED",
    discovery_v16_raw_selector_match_count: 0,
    discovery_v16_qualified_selector_match_count: 0,
    direct_static_v2_state: "DIRECT_CHILD_SET_REJECTED",
    discovery_v17_carrier_relation_state: "NO_EXACT_CARRIER_IN_FOUR_CHILD_WINDOW",
    discovery_v18_singleton_grandchild_relation_state:
      "EXACT_CARRIER_SINGLETON_GRANDCHILD"
  };
  const payload = heartbeatPayload({ tinder_inbox_navigation: diagnostic });
  const request = heartbeatRequest(payload);
  assert.deepEqual(parseAndValidateHeartbeat(request.req).tinder_inbox_navigation, diagnostic);

  const fake = heartbeatPool({ request });
  const response = await processHeartbeatTransaction(
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
  assert.deepEqual(response.commands, []);

  for (const inboxNavigation of [
    { ...diagnostic, discovery_v18_singleton_grandchild_relation_state: "UNBOUNDED" },
    { ...diagnostic, discovery_v17_carrier_relation_state: "DIRECT_CHILD_CARDINALITY_OVER_FOUR" },
    { ...diagnostic, discovery_v16_raw_selector_match_count: 1 },
    { ...diagnostic, stage: "INBOX_READY", reason: "NONE" },
    (() => {
      const { discovery_v17_carrier_relation_state, ...withoutV17 } = diagnostic;
      return withoutV17;
    })()
  ]) {
    assert.throws(
      () => parseAndValidateHeartbeat(heartbeatRequest(
        heartbeatPayload({ tinder_inbox_navigation: inboxNavigation })).req),
      error => error.code === "INVALID_DEVICE_STATE"
    );
  }
});

test("terminal Tinder discovery V19 requires the exact V18 cardinality-rejection chain", async () => {
  const diagnostic = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "LABEL_MATCH_COUNT_REJECTED",
    discovery_v16_raw_selector_match_count: 0,
    discovery_v16_qualified_selector_match_count: 0,
    direct_static_v2_state: "DIRECT_CHILD_SET_REJECTED",
    discovery_v17_carrier_relation_state: "NO_EXACT_CARRIER_IN_FOUR_CHILD_WINDOW",
    discovery_v18_singleton_grandchild_relation_state:
      "SINGLETON_GRANDCHILD_CARDINALITY_REJECTED",
    discovery_v19_singleton_wrapper_shape_state: "WRAPPER_BRANCHING"
  };
  const payload = heartbeatPayload({ tinder_inbox_navigation: diagnostic });
  const request = heartbeatRequest(payload);
  assert.deepEqual(parseAndValidateHeartbeat(request.req).tinder_inbox_navigation, diagnostic);

  const fake = heartbeatPool({ request });
  const response = await processHeartbeatTransaction(
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
  assert.deepEqual(response.commands, []);

  for (const inboxNavigation of [
    { ...diagnostic, discovery_v19_singleton_wrapper_shape_state: "UNBOUNDED" },
    { ...diagnostic, discovery_v18_singleton_grandchild_relation_state:
      "EXACT_CARRIER_SINGLETON_GRANDCHILD" },
    { ...diagnostic, discovery_v17_carrier_relation_state: "DIRECT_CHILD_CARDINALITY_OVER_FOUR" },
    { ...diagnostic, discovery_v16_raw_selector_match_count: 1 },
    { ...diagnostic, stage: "INBOX_READY", reason: "NONE" },
    (() => {
      const { discovery_v18_singleton_grandchild_relation_state, ...withoutV18 } = diagnostic;
      return withoutV18;
    })()
  ]) {
    assert.throws(
      () => parseAndValidateHeartbeat(heartbeatRequest(
        heartbeatPayload({ tinder_inbox_navigation: inboxNavigation })).req),
      error => error.code === "INVALID_DEVICE_STATE"
    );
  }
});

test("terminal Tinder discovery V20 is an independent exact base-and-counters branch", async () => {
  const diagnostic = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v20_five_structural_chat_state: "LABEL_MATCH_COUNT_REJECTED",
    discovery_v20_raw_selector_match_count: 0,
    discovery_v20_qualified_selector_match_count: 0
  };
  const payload = heartbeatPayload({ tinder_inbox_navigation: diagnostic });
  const request = heartbeatRequest(payload);
  assert.deepEqual(parseAndValidateHeartbeat(request.req).tinder_inbox_navigation, diagnostic);

  const fake = heartbeatPool({ request });
  const response = await processHeartbeatTransaction(
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
  assert.deepEqual(response.commands, []);

  for (const inboxNavigation of [
    { ...diagnostic, discovery_v20_five_structural_chat_state: "UNBOUNDED" },
    { ...diagnostic, discovery_v20_five_structural_chat_state: "NOT_EVALUATED" },
    { ...diagnostic, discovery_v20_raw_selector_match_count: 3 },
    { ...diagnostic, discovery_v20_qualified_selector_match_count: 1 },
    { ...diagnostic, stage: "INBOX_READY", reason: "NONE" },
    { ...diagnostic, discovery_v19_singleton_wrapper_shape_state: "WRAPPER_EMPTY" },
    (() => {
      const { discovery_v20_qualified_selector_match_count, ...withoutQualifiedCount } = diagnostic;
      return withoutQualifiedCount;
    })()
  ]) {
    assert.throws(
      () => parseAndValidateHeartbeat(heartbeatRequest(
        heartbeatPayload({ tinder_inbox_navigation: inboxNavigation })).req),
      error => error.code === "INVALID_DEVICE_STATE"
    );
  }
});

test("terminal Tinder discovery V20 anchor states require zero selector counters", () => {
  const base = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v20_raw_selector_match_count: 0,
    discovery_v20_qualified_selector_match_count: 0
  };
  for (const state of [
    "ANCHOR_TRAVERSAL_INCOMPLETE",
    "ANCHOR_PARENT_ABSENT",
    "ANCHOR_PARENT_ARITY_ABSENT",
    "ANCHOR_PARENT_PACKAGE_PATH_ABSENT",
    "ANCHOR_PARENT_VISIBILITY_ABSENT",
    "ANCHOR_PARENT_LOWER_BAND_ABSENT",
    "ANCHOR_PARENT_NONINTERACTIVE_SHAPE_ABSENT",
    "ANCHOR_ARITY_VARIANT_PARENT_REVALIDATION_REJECTED",
    "ANCHOR_ARITY_VARIANT_UNPROVEN_EXTRA_REJECTED",
    "ANCHOR_ARITY_VARIANT_STRICT_BRANCH_COUNT_REJECTED",
    "ANCHOR_ARITY_VARIANT_PRIVATE_LEAF_DUPLICATE_REJECTED",
    "ANCHOR_ARITY_VARIANT_BRANCH_SET_REJECTED",
    "ANCHOR_ARITY_VARIANT_V5_GROUP_REJECTED",
    "ANCHOR_STRICT_PROOF_ABSENT",
    "ANCHOR_STRICT_PROOF_AMBIGUOUS"
  ]) {
    const diagnostic = {
      ...base,
      discovery_v20_five_structural_chat_state: state
    };
    assert.deepEqual(parseAndValidateHeartbeat(heartbeatRequest(
      heartbeatPayload({ tinder_inbox_navigation: diagnostic })).req).tinder_inbox_navigation,
    diagnostic);
    for (const [rawCount, qualifiedCount] of [[1, 0], [1, 1], [0, 1]]) {
      assert.throws(
        () => parseAndValidateHeartbeat(heartbeatRequest(heartbeatPayload({
          tinder_inbox_navigation: {
            ...diagnostic,
            discovery_v20_raw_selector_match_count: rawCount,
            discovery_v20_qualified_selector_match_count: qualifiedCount
          }
        })).req),
        error => error.code === "INVALID_DEVICE_STATE"
      );
    }
  }
});

test("optional official resume handoff heartbeat diagnostic is exact, content-free, and observational", async () => {
  const diagnostic = { stage: "BLOCKED", reason: "OFFICIAL_FOREGROUND_NOT_OBSERVED" };
  const payload = heartbeatPayload({ tinder_official_resume_handoff: diagnostic });
  const request = heartbeatRequest(payload);
  assert.deepEqual(parseAndValidateHeartbeat(request.req).tinder_official_resume_handoff, diagnostic);

  const fake = heartbeatPool({ request });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    payload,
    NOW
  );
  const audit = fake.calls.find(call => call.sql.includes("INSERT INTO device_bridge_audit_events"));
  assert.deepEqual(JSON.parse(audit.params[3]), {
    sequence: 1,
    tinder_official_resume_handoff: diagnostic
  });
  assert.deepEqual(response.commands, []);
  const update = fake.calls.find(call => call.sql.includes("UPDATE device_bridge_devices"));
  const serialized = JSON.stringify({ update: update?.params, response });
  for (const value of ["BLOCKED", "OFFICIAL_FOREGROUND_NOT_OBSERVED"]) {
    assert.equal(serialized.includes(value), false);
  }

  for (const invalidDiagnostic of [
    null,
    {},
    { ...diagnostic, stage: "IDLE" },
    { ...diagnostic, reason: "raw exception" },
    { ...diagnostic, permit: "forbidden" },
    { ...diagnostic, text: "forbidden" }
  ]) {
    const invalid = heartbeatPayload({ tinder_official_resume_handoff: invalidDiagnostic });
    assert.throws(
      () => parseAndValidateHeartbeat(heartbeatRequest(invalid).req),
      error => error.code === "INVALID_DEVICE_STATE"
    );
  }
});

test("optional official-resume schema evidence is aggregate-only and requires its exact terminal handoff", async () => {
  const handoff = { stage: "BLOCKED", reason: "UNREVIEWED_OFFICIAL_SURFACE" };
  const evidence = officialResumeSchemaEvidence();
  const payload = heartbeatPayload({
    capabilities: T4_RESUME_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED",
    tinder_official_resume_handoff: handoff,
    tinder_official_resume_schema_evidence: evidence
  });
  const request = heartbeatRequest(payload);
  assert.deepEqual(parseAndValidateHeartbeat(request.req)
    .tinder_official_resume_schema_evidence, evidence);

  const fake = heartbeatPool({ request, schemaEvidenceCandidateCount: 1 });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    payload,
    NOW
  );
  const audit = fake.calls.find(call => call.sql.includes("INSERT INTO device_bridge_audit_events"));
  assert.match(audit.sql, /WITH current_resume_candidates/i);
  assert.match(audit.sql, /JOIN device_bridge_command_acks resume_ack/i);
  assert.match(audit.sql, /resume_ack\.status='SUCCEEDED'/i);
  assert.match(audit.sql, /official_tinder_app_resume/i);
  assert.match(audit.sql, /key_id, command_id, result_code, http_status, details/i);
  assert.deepEqual(JSON.parse(audit.params[4]), {
    tinder_official_resume_handoff: handoff,
    tinder_official_resume_schema_evidence: evidence
  });
  assert.deepEqual(response.commands, []);
  const update = fake.calls.find(call => call.sql.includes("UPDATE device_bridge_devices"));
  const serialized = JSON.stringify({ audit: audit.params[4], update: update?.params, response });
  for (const forbidden of ["raw_accessibility_tree", "node_shapes", "fingerprint",
    "package_name", "view_id_token", "class_name", "sequence"]) {
    assert.equal(serialized.includes(forbidden), false);
  }

  for (const invalidPayload of [
    heartbeatPayload({ tinder_official_resume_schema_evidence: evidence }),
    heartbeatPayload({
      tinder_official_resume_handoff: { stage: "BLOCKED", reason: "STRUCTURAL_SAFETY_REJECTED" },
      tinder_official_resume_schema_evidence: evidence
    }),
    heartbeatPayload({
      tinder_official_resume_handoff: handoff,
      tinder_official_resume_schema_evidence: { ...evidence, node_shapes: [] }
    })
  ]) {
    assert.throws(
      () => parseAndValidateHeartbeat(heartbeatRequest(invalidPayload).req),
      error => error.code === "INVALID_DEVICE_STATE"
    );
  }
});

test("official-resume schema evidence is exact-once, server-provenanced, and action-isolated", async () => {
  const handoff = { stage: "BLOCKED", reason: "UNREVIEWED_OFFICIAL_SURFACE" };
  const payload = heartbeatPayload({
    capabilities: T4_RESUME_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED",
    tinder_official_resume_handoff: handoff,
    tinder_official_resume_schema_evidence: officialResumeSchemaEvidence(),
    // A valid fresh observation would normally be able to start V8. The
    // schema-evidence branch must not consult or consume it.
    tinder_inbox_navigation: {
      stage: "INBOX_READY",
      reason: "NONE",
      visible_conversation_count: 1,
      observed_event_count: 1,
      observation_kind: "REVIEWED_INBOX_READY",
      observation_nonce: "b4e25555-1111-4111-8111-111111111111"
    }
  });
  const request = heartbeatRequest(payload);
  const fake = heartbeatPool({
    request,
    schemaEvidenceCandidateCount: 1,
    commands: [commandRow("CONNECT_TINDER", NOW, "d4e25555-1111-4111-8111-111111111111")]
  });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    payload,
    NOW,
    { inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION }
  );
  assert.deepEqual(response.commands, []);
  assert.equal(fake.state.createdSweeps.length, 0);
  assert.equal(fake.state.createdSweepSteps.length, 0);
  assert.equal(fake.calls.some(call => call.sql.includes("WHERE device_id=$1 AND terminal_status IS NULL")), false);

  const alreadyReported = heartbeatPool({
    request,
    schemaEvidenceCandidateCount: 1,
    schemaEvidenceAlreadyReported: true
  });
  await assert.rejects(
    () => processHeartbeatTransaction(
      alreadyReported.pool,
      { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
      payload,
      NOW
    ),
    error => error.code === "TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ALREADY_REPORTED"
      && error.deviceBridgeHeartbeatFailureStage === "SCHEMA_EVIDENCE_AUTHORIZATION"
  );
  assert.equal(alreadyReported.state.audits, 0);

  const unprovenanced = heartbeatPool({ request });
  await assert.rejects(
    () => processHeartbeatTransaction(
      unprovenanced.pool,
      { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
      payload,
      NOW
    ),
    error => error.code === "TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_NOT_AUTHORIZED"
      && error.deviceBridgeHeartbeatFailureStage === "SCHEMA_EVIDENCE_AUTHORIZATION"
  );
  assert.equal(unprovenanced.state.audits, 0);

  const ambiguous = heartbeatPool({ request, schemaEvidenceCandidateCount: 2 });
  await assert.rejects(
    () => processHeartbeatTransaction(
      ambiguous.pool,
      { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
      payload,
      NOW
    ),
    error => error.code === "TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_NOT_AUTHORIZED"
      && error.deviceBridgeHeartbeatFailureStage === "SCHEMA_EVIDENCE_AUTHORIZATION"
  );
  assert.equal(ambiguous.state.audits, 0);

  const auditFailure = heartbeatPool({
    request,
    schemaEvidenceCandidateCount: 1,
    schemaEvidenceAuditFailure: true
  });
  await assert.rejects(
    () => processHeartbeatTransaction(
      auditFailure.pool,
      { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
      payload,
      NOW
    ),
    error => error?.deviceBridgeHeartbeatFailureStage === "SCHEMA_EVIDENCE_AUDIT"
  );
  assert.equal(auditFailure.state.audits, 0);
  assert.equal(auditFailure.state.rollbacks, 1);

  const t0Payload = heartbeatPayload({
    tinder_official_resume_handoff: handoff,
    tinder_official_resume_schema_evidence: officialResumeSchemaEvidence()
  });
  const t0Request = heartbeatRequest(t0Payload);
  const t0 = heartbeatPool({ request: t0Request, schemaEvidenceCandidateCount: 1 });
  await assert.rejects(
    () => processHeartbeatTransaction(
      t0.pool,
      { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: t0Request.hash },
      t0Payload,
      NOW
    ),
    error => error.code === "TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_NOT_AUTHORIZED"
      && error.deviceBridgeHeartbeatFailureStage === "SCHEMA_EVIDENCE_AUTHORIZATION"
  );
  assert.equal(t0.state.audits, 0);
});

test("optional V10 return lifecycle diagnostic is exact, content-free, and cannot select a return command", async () => {
  const diagnostic = { stage: "READY_FOR_HEARTBEAT", reason: "NONE" };
  const returnCommandId = "50f44444-4444-4444-8444-444444444444";
  const capabilities =
    T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_RETURN_FOREGROUND_RETURN_DEVICE_CAPABILITIES;
  const payload = heartbeatPayload({
    capabilities,
    tinder_state: "CONNECTED",
    tinder_resumed_foreground_chat_return: { ready: false },
    tinder_resumed_foreground_chat_return_diagnostic: diagnostic
  });
  const request = heartbeatRequest(payload);
  assert.deepEqual(
    parseAndValidateHeartbeat(request.req).tinder_resumed_foreground_chat_return_diagnostic,
    diagnostic
  );

  const fake = heartbeatPool({
    request,
    commands: [commandRow("RETURN_TINDER_RESUMED_FOREGROUND_CHAT_TO_INBOX", NOW, returnCommandId)]
  });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    payload,
    NOW,
    {
      inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION,
      inspectUnboundInboxConversationSweepRuntimeFoundation: async () => ({ state: "CANONICAL" }),
      inspectVerifiedChatReturnFoundation: async () => ({ state: "INVALID" }),
      inspectResumedForegroundChatReturnFoundation: async () => ({ state: "CANONICAL" })
    }
  );
  assert.deepEqual(response.commands, []);
  const audit = fake.calls.find(call => call.sql.includes("INSERT INTO device_bridge_audit_events"));
  assert.deepEqual(JSON.parse(audit.params[3]), {
    sequence: 1,
    tinder_resumed_foreground_chat_return: { ready: false },
    tinder_resumed_foreground_chat_return_diagnostic: diagnostic
  });
  const update = fake.calls.find(call => call.sql.includes("UPDATE device_bridge_devices"));
  const serialized = JSON.stringify({ response, update: update?.params });
  for (const value of ["READY_FOR_HEARTBEAT", "NONE"]) assert.equal(serialized.includes(value), false);

  for (const invalidDiagnostic of [
    null,
    {},
    { ...diagnostic, stage: "IDLE" },
    { ...diagnostic, reason: "raw exception" },
    { ...diagnostic, extra: "forbidden" },
    { ...diagnostic, text: "forbidden" }
  ]) {
    const invalid = heartbeatPayload({
      capabilities,
      tinder_state: "CONNECTED",
      tinder_resumed_foreground_chat_return_diagnostic: invalidDiagnostic
    });
    assert.throws(
      () => parseAndValidateHeartbeat(heartbeatRequest(invalid).req),
      error => error.code === "INVALID_DEVICE_STATE"
    );
  }
});

test("optional passive Inbox observation diagnostic is exact, content-free, and cannot select a command", async () => {
  const diagnostic = {
    stage: "PENDING_HEARTBEAT",
    reason: "NONE",
    settle_sample_count: 2,
    validation_count: 3
  };
  const payload = heartbeatPayload({
    capabilities: T1_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED",
    tinder_passive_inbox_observation_diagnostic: diagnostic
  });
  const request = heartbeatRequest(payload);
  assert.deepEqual(
    parseAndValidateHeartbeat(request.req).tinder_passive_inbox_observation_diagnostic,
    diagnostic
  );

  const fake = heartbeatPool({ request });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    payload,
    NOW
  );
  assert.deepEqual(response.commands, []);
  const audit = fake.calls.find(call => call.sql.includes("INSERT INTO device_bridge_audit_events"));
  assert.deepEqual(JSON.parse(audit.params[3]), {
    sequence: 1,
    tinder_passive_inbox_observation_diagnostic: diagnostic
  });
  const update = fake.calls.find(call => call.sql.includes("UPDATE device_bridge_devices"));
  const serialized = JSON.stringify({ response, update: update?.params });
  for (const forbidden of ["PENDING_HEARTBEAT", "settle_sample_count", "validation_count"]) {
    assert.equal(serialized.includes(forbidden), false);
  }

  for (const invalidDiagnostic of [
    null,
    {},
    { ...diagnostic, stage: "IDLE" },
    { ...diagnostic, reason: "SETTLE_NON_INBOX" },
    { ...diagnostic, settle_sample_count: 9 },
    { ...diagnostic, validation_count: 2.5 },
    { ...diagnostic, extra: "forbidden" },
    { ...diagnostic, text: "forbidden" }
  ]) {
    const invalid = heartbeatPayload({
      capabilities: T1_DEVICE_CAPABILITIES,
      tinder_state: "CONNECTED",
      tinder_passive_inbox_observation_diagnostic: invalidDiagnostic
    });
    assert.throws(
      () => parseAndValidateHeartbeat(heartbeatRequest(invalid).req),
      error => error.code === "INVALID_DEVICE_STATE"
    );
  }
});

test("V10 accepts the bounded Initial-Chat-shell rejection without adding authority", () => {
  const diagnostic = { stage: "BLOCKED", reason: "INITIAL_SHELL_REJECTED" };
  const payload = heartbeatPayload({
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_RETURN_FOREGROUND_RETURN_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED",
    tinder_resumed_foreground_chat_return: { ready: false },
    tinder_resumed_foreground_chat_return_diagnostic: diagnostic
  });
  assert.deepEqual(
    parseAndValidateHeartbeat(heartbeatRequest(payload).req)
      .tinder_resumed_foreground_chat_return_diagnostic,
    diagnostic
  );
});

test("optional V8 sweep heartbeat diagnostic is exact, content-free, and cannot affect command issuance", async () => {
  const diagnostic = {
    stage: "INGRESS",
    command_handoff_stage: "SERVICE_HANDOFF_QUEUED",
    reason: "UNBOUND_READER_INGRESS_FAILED",
    session_state: "READ_IN_PROGRESS",
    current_slot: 1,
    reads_accepted: 0,
    returns_accepted: 0,
    reader_result: "COMPLETE",
    ingress_phase: "READ",
    ingress_outcome: "REJECTED",
    ingress_stage: "HTTP_RESPONSE"
  };
  const payload = heartbeatPayload({ tinder_unbound_inbox_sweep: diagnostic });
  const request = heartbeatRequest(payload);
  assert.deepEqual(parseAndValidateHeartbeat(request.req).tinder_unbound_inbox_sweep, diagnostic);

  const fake = heartbeatPool({ request });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    payload,
    NOW
  );
  const audit = fake.calls.find(call => call.sql.includes("INSERT INTO device_bridge_audit_events"));
  assert.deepEqual(JSON.parse(audit.params[3]), {
    sequence: 1,
    tinder_unbound_inbox_sweep: diagnostic
  });
  assert.deepEqual(response.commands, []);
  const update = fake.calls.find(call => call.sql.includes("UPDATE device_bridge_devices"));
  assert.equal(JSON.stringify(update.params).includes("UNBOUND_READER_INGRESS_FAILED"), false);

  for (const invalidDiagnostic of [
    null,
    {},
    { ...diagnostic, extra: "forbidden" },
    { ...diagnostic, ingress_stage: "raw-stack" },
    { ...diagnostic, current_slot: 9 },
    { ...diagnostic, reads_accepted: -1 }
  ]) {
    const invalid = heartbeatPayload({ tinder_unbound_inbox_sweep: invalidDiagnostic });
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

test("a fresh reviewed Inbox observation is consumed but cannot mint V8 beside an active V9 return", async () => {
  const observationNonce = "1bfa798e-85ce-4c2e-830e-df8465c58f70";
  const capabilities = T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_RETURN_DEVICE_CAPABILITIES;
  const payload = heartbeatPayload({
    capabilities,
    tinder_state: "CONNECTED",
    tinder_inbox_navigation: {
      stage: "INBOX_READY",
      reason: "NONE",
      visible_conversation_count: 2,
      observed_event_count: 3,
      observation_kind: "FRESH_REVIEWED_INBOX_V1",
      observation_nonce: observationNonce
    }
  });
  const request = heartbeatRequest(payload, {
    requestId: "2bfa798e-85ce-4c2e-830e-df8465c58f70"
  });
  const fake = heartbeatPool({
    request,
    unboundInboxSweepFoundation: true,
    activeVerifiedChatReturnPermit: true,
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

  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "2bfa798e-85ce-4c2e-830e-df8465c58f70", contentSha256: request.hash },
    payload,
    NOW,
    {
      inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION,
      inspectVerifiedChatReturnFoundation: async () => ({ state: "CANONICAL" })
    }
  );

  assert.equal(fake.state.createdSweeps.length, 0);
  assert.equal(fake.state.createdSweepSteps.length, 0);
  assert.equal(fake.state.sweepAudits.length, 0);
  const heartbeatAudit = fake.calls.find(call => call.sql.includes("INSERT INTO device_bridge_audit_events"));
  assert.equal(JSON.parse(heartbeatAudit.params[3]).tinder_inbox_navigation.observation_nonce, observationNonce);
  assert.equal(JSON.stringify(response).includes(observationNonce), false);
});

test("a fresh reviewed Inbox observation cannot mint V8 beside a partial V9 catalog", async () => {
  const observationNonce = "3bfa798e-85ce-4c2e-830e-df8465c58f70";
  const capabilities = T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES;
  const payload = heartbeatPayload({
    capabilities,
    tinder_state: "CONNECTED",
    tinder_inbox_navigation: {
      stage: "INBOX_READY",
      reason: "NONE",
      visible_conversation_count: 2,
      observed_event_count: 3,
      observation_kind: "FRESH_REVIEWED_INBOX_V1",
      observation_nonce: observationNonce
    }
  });
  const request = heartbeatRequest(payload, {
    requestId: "4bfa798e-85ce-4c2e-830e-df8465c58f70"
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

  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "4bfa798e-85ce-4c2e-830e-df8465c58f70", contentSha256: request.hash },
    payload,
    NOW,
    {
      inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION,
      inspectVerifiedChatReturnFoundation: async () => ({ state: "INVALID" })
    }
  );

  assert.equal(fake.state.createdSweeps.length, 0);
  assert.equal(fake.state.createdSweepSteps.length, 0);
  assert.equal(fake.state.sweepAudits.length, 0);
  const heartbeatAudit = fake.calls.find(call => call.sql.includes("INSERT INTO device_bridge_audit_events"));
  assert.equal(JSON.parse(heartbeatAudit.params[3]).tinder_inbox_navigation.observation_nonce, observationNonce);
  assert.equal(JSON.stringify(response).includes(observationNonce), false);
});

test("V9 alone cannot mint a V8 child when retained V8 runtime proof is invalid", async () => {
  const observationNonce = "5bfa798e-85ce-4c2e-830e-df8465c58f70";
  const capabilities = T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES;
  const payload = heartbeatPayload({
    capabilities,
    tinder_state: "CONNECTED",
    tinder_inbox_navigation: {
      stage: "INBOX_READY",
      reason: "NONE",
      visible_conversation_count: 2,
      observed_event_count: 3,
      observation_kind: "FRESH_REVIEWED_INBOX_V1",
      observation_nonce: observationNonce
    }
  });
  const request = heartbeatRequest(payload, {
    requestId: "5bfa798e-85ce-4c2e-830e-df8465c58f70"
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

  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "5bfa798e-85ce-4c2e-830e-df8465c58f70", contentSha256: request.hash },
    payload,
    NOW,
    {
      inspectUnboundInboxConversationSweepFoundation: async () => ({ state: "INVALID" }),
      inspectUnboundInboxConversationSweepRuntimeFoundation: async () => ({ state: "INVALID" }),
      inspectVerifiedChatReturnFoundation: async () => ({ state: "CANONICAL" })
    }
  );

  assert.equal(response.commands.some(command => command.type.includes("UNBOUND_INBOX_CONVERSATION_SWEEP")), false);
  assert.equal(fake.state.createdSweeps.length, 0);
  assert.equal(fake.state.createdSweepSteps.length, 0);
});

test("jointly canonical V9 and retained V8 runtime proof can mint a V8 child", async () => {
  const observationNonce = "6bfa798e-85ce-4c2e-830e-df8465c58f70";
  const capabilities = T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES;
  const payload = heartbeatPayload({
    capabilities,
    tinder_state: "CONNECTED",
    tinder_inbox_navigation: {
      stage: "INBOX_READY",
      reason: "NONE",
      visible_conversation_count: 2,
      observed_event_count: 3,
      observation_kind: "FRESH_REVIEWED_INBOX_V1",
      observation_nonce: observationNonce
    }
  });
  const request = heartbeatRequest(payload, {
    requestId: "6bfa798e-85ce-4c2e-830e-df8465c58f70"
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

  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "6bfa798e-85ce-4c2e-830e-df8465c58f70", contentSha256: request.hash },
    payload,
    NOW,
    {
      inspectUnboundInboxConversationSweepFoundation: async () => ({ state: "INVALID" }),
      inspectUnboundInboxConversationSweepRuntimeFoundation: async () => ({ state: "CANONICAL" }),
      inspectVerifiedChatReturnFoundation: async () => ({ state: "CANONICAL" })
    }
  );

  assert.equal(response.commands.filter(command => command.type === "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT").length, 1);
  assert.equal(fake.state.createdSweeps.length, 1);
});

test("partial, unknown, or repair-required V8 schema is inert: it cannot issue or deliver a V8 child", async () => {
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
        return { state: "TRIGGER_REPAIR_REQUIRED" };
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

test("internal heartbeat failures log only a bounded transaction stage", async () => {
  const current = new Date();
  const payload = heartbeatPayload({ sent_at: current.toISOString() });
  const request = heartbeatRequest(payload, { now: current });
  const fake = heartbeatPool({ request, failUpdate: true });
  const response = responseRecorder();
  const messages = [];
  const originalError = console.error;
  console.error = value => messages.push(String(value));
  try {
    await createHeartbeatHandler(fake.pool)(request.req, response);
  } finally {
    console.error = originalError;
  }
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error.code, "INTERNAL_ERROR");
  assert.deepEqual(messages, ["Device Bridge heartbeat transaction failed at DEVICE_UPDATE: INTERNAL_UNCLASSIFIED."]);
  assert.equal(messages.join(" ").includes("simulated"), false);
  assert.match(heartbeatSource, /failureStage = "V8_EXPIRY";\s+const v8SweepRuntime/);
  assert.match(heartbeatSource, /boundedTinderUnboundInboxConversationSweepIssuePhase/);
  assert.match(heartbeatSource, /stage === "V8_START"/);
});

test("internal heartbeat database failures retain only a finite reason class", async () => {
  const current = new Date();
  const payload = heartbeatPayload({ sent_at: current.toISOString() });
  const request = heartbeatRequest(payload, { now: current });
  const fake = heartbeatPool({ request, failUpdate: true, failUpdateCode: "23505" });
  const response = responseRecorder();
  const messages = [];
  const originalError = console.error;
  console.error = value => messages.push(String(value));
  try {
    await createHeartbeatHandler(fake.pool)(request.req, response);
  } finally {
    console.error = originalError;
  }
  assert.equal(response.statusCode, 500);
  assert.equal(response.body.error.code, "INTERNAL_ERROR");
  assert.deepEqual(messages, ["Device Bridge heartbeat transaction failed at DEVICE_UPDATE: DATABASE_UNIQUE_CONFLICT."]);
  assert.equal(messages.join(" ").includes("23505"), false);
  assert.equal(messages.join(" ").includes("simulated"), false);
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

test("a live V8 parent with a lost manual gate delivers exactly one server-coordinated empty CONNECT before its child", async () => {
  const read = commandRow(
    "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT",
    new Date(NOW.valueOf() - 1_000),
    "5b444444-4444-4444-8444-444444444444"
  );
  const payload = heartbeatPayload({
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES,
    tinder_state: "DISCONNECTED"
  });
  const request = heartbeatRequest(payload, {
    requestId: "5d444444-4444-4444-8444-444444444444"
  });
  const fake = heartbeatPool({
    request,
    commands: [read, commandRow("PING", new Date(NOW.valueOf() - 900), "5e444444-4444-4444-8444-444444444444")],
    localAttestationFoundation: true,
    unboundInboxSweepFoundation: true,
    coordinatorRuntime: {
      device_id: DEVICE_ID, enrollment_state: "ACTIVE", revoked_at: null,
      last_accepted_heartbeat_at: new Date(NOW.valueOf() - 1_000),
      bridge_service_state: "RUNNING", tinder_state: "DISCONNECTED", automation_state: "STOPPED",
      capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES
    },
    activeIssuedCoordinatorSweep: {
      sweep_id: "5f444444-4444-4444-8444-444444444444",
      device_id: DEVICE_ID, sweep_state: "ACTIVE", active_command_id: read.command_id,
      sweep_issued_at: new Date(NOW.valueOf() - 1_000),
      sweep_expires_at: new Date(NOW.valueOf() + 10 * 60_000),
      child_state: "ISSUED", child_kind: "READ",
      child_expires_at: new Date(NOW.valueOf() + 3 * 60_000)
    }
  });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "5d444444-4444-4444-8444-444444444444", contentSha256: request.hash },
    payload,
    NOW,
    { inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION }
  );
  assert.deepEqual(response.commands.map(command => ({ type: command.type, payload: command.payload })), [
    { type: "CONNECT_TINDER", payload: {} }
  ]);
  assert.equal(response.commands[0].command_id, fake.state.coordinatorCommands[0].command_id);
  assert.equal(fake.state.coordinatorCommands.length, 1);
  assert.equal(fake.state.coordinatorAudits.length, 1);
  assert.equal(JSON.stringify(response).match(/sweep_id|child_kind|capture|binding|row/i), null);
  const selection = fake.calls.filter(call => String(call.sql).includes("FROM device_bridge_commands")).at(-1);
  assert.match(selection.sql, /AND command_id=\$4/);
  assert.match(selection.sql, /OR command_id=\$4/);
});

test("a prior coordinator row with a lost manual gate never reissues or delivers the active V8 child", async () => {
  const read = commandRow(
    "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT",
    new Date(NOW.valueOf() - 1_000),
    "60444444-4444-4444-8444-444444444444"
  );
  const payload = heartbeatPayload({
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES,
    tinder_state: "DISCONNECTED"
  });
  const request = heartbeatRequest(payload, {
    requestId: "61444444-4444-4444-8444-444444444444"
  });
  const fake = heartbeatPool({
    request,
    commands: [read],
    localAttestationFoundation: true,
    unboundInboxSweepFoundation: true,
    coordinatorRuntime: {
      device_id: DEVICE_ID, enrollment_state: "ACTIVE", revoked_at: null,
      last_accepted_heartbeat_at: new Date(NOW.valueOf() - 1_000),
      bridge_service_state: "RUNNING", tinder_state: "DISCONNECTED", automation_state: "STOPPED",
      capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES
    },
    activeIssuedCoordinatorSweep: {
      sweep_id: "62444444-4444-4444-8444-444444444444",
      device_id: DEVICE_ID, sweep_state: "ACTIVE", active_command_id: read.command_id,
      sweep_issued_at: new Date(NOW.valueOf() - 1_000),
      sweep_expires_at: new Date(NOW.valueOf() + 10 * 60_000),
      child_state: "ISSUED", child_kind: "READ",
      child_expires_at: new Date(NOW.valueOf() + 3 * 60_000)
    },
    coordinatorRows: [{
      command_id: "63444444-4444-4444-8444-444444444444", device_id: DEVICE_ID,
      command_type: "CONNECT_TINDER", payload: {},
      expires_at: new Date(NOW.valueOf() - 1_000), terminal_status: "EXPIRED",
      created_by: "server_tinder_unbound_inbox_sweep_gate_recovery"
    }]
  });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "61444444-4444-4444-8444-444444444444", contentSha256: request.hash },
    payload,
    NOW,
    { inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION }
  );
  assert.deepEqual(response.commands, []);
  assert.equal(fake.state.coordinatorCommands.length, 0);
  const selection = fake.calls.filter(call => String(call.sql).includes("FROM device_bridge_commands")).at(-1);
  assert.match(selection.sql, /AND command_type IN \('PING','REQUEST_STATUS','STOP_BRIDGE'\)/);
});

test("an orphaned or already-connected coordinator CONNECT cannot fall through the generic T1 selector", async () => {
  const orphan = commandRow(
    "CONNECT_TINDER",
    new Date(NOW.valueOf() - 1_000),
    "64444444-4444-4444-8444-444444444444",
    { created_by: "server_tinder_unbound_inbox_sweep_gate_recovery" }
  );
  for (const tinderState of ["DISCONNECTED", "CONNECTED"]) {
    const payload = heartbeatPayload({
      capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES,
      tinder_state: tinderState
    });
    const request = heartbeatRequest(payload, {
      requestId: tinderState === "CONNECTED"
        ? "65444444-4444-4444-8444-444444444444"
        : "66444444-4444-4444-8444-444444444444"
    });
    const fake = heartbeatPool({
      request,
      commands: [orphan],
      localAttestationFoundation: true,
      unboundInboxSweepFoundation: true,
      // The current signed heartbeat has no live parent to revalidate. The
      // stale coordinator row must therefore remain inert regardless of the
      // preceding persisted state.
      coordinatorRuntime: {
        device_id: DEVICE_ID, enrollment_state: "ACTIVE", revoked_at: null,
        last_accepted_heartbeat_at: new Date(NOW.valueOf() - 1_000),
        bridge_service_state: "RUNNING", tinder_state: tinderState, automation_state: "STOPPED",
        capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES
      },
      coordinatorDeliveryValid: false
    });
    const response = await processHeartbeatTransaction(
      fake.pool,
      {
        deviceId: DEVICE_ID,
        keyId: KEY_ID,
        requestId: request.headers["x-marcel-request-id"],
        contentSha256: request.hash
      },
      payload,
      NOW,
      { inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION }
    );
    assert.deepEqual(response.commands, []);
    const selection = fake.calls.filter(call => String(call.sql).includes("FROM device_bridge_commands")).at(-1);
    assert.match(selection.sql,
      /created_by IS DISTINCT FROM 'server_tinder_unbound_inbox_sweep_gate_recovery'/);
  }
});

test("an invalid current V8 child cannot mint a coordinator CONNECT", async () => {
  const read = commandRow(
    "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT",
    new Date(NOW.valueOf() - 1_000),
    "67444444-4444-4444-8444-444444444444"
  );
  const payload = heartbeatPayload({
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES,
    tinder_state: "DISCONNECTED"
  });
  const request = heartbeatRequest(payload, {
    requestId: "68444444-4444-4444-8444-444444444444"
  });
  const fake = heartbeatPool({
    request,
    commands: [read],
    localAttestationFoundation: true,
    unboundInboxSweepFoundation: true,
    coordinatorRuntime: {
      device_id: DEVICE_ID, enrollment_state: "ACTIVE", revoked_at: null,
      last_accepted_heartbeat_at: new Date(NOW.valueOf() - 1_000),
      bridge_service_state: "RUNNING", tinder_state: "DISCONNECTED", automation_state: "STOPPED",
      capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES
    },
    activeIssuedCoordinatorSweep: {
      sweep_id: "69444444-4444-4444-8444-444444444444",
      device_id: DEVICE_ID, sweep_state: "ACTIVE", active_command_id: read.command_id,
      sweep_issued_at: new Date(NOW.valueOf() - 1_000),
      sweep_expires_at: new Date(NOW.valueOf() + 10 * 60_000),
      child_state: "ISSUED", child_kind: "READ",
      child_expires_at: new Date(NOW.valueOf() + 3 * 60_000)
    },
    // The PostgreSQL adapter now makes this result impossible unless the
    // active child is exact-empty, nonterminal, unexpired and type-matched.
    coordinatorChildCommandValid: false
  });
  const response = await processHeartbeatTransaction(
    fake.pool,
    {
      deviceId: DEVICE_ID,
      keyId: KEY_ID,
      requestId: "68444444-4444-4444-8444-444444444444",
      contentSha256: request.hash
    },
    payload,
    NOW,
    { inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION }
  );
  assert.equal(response.commands.some(command => command.type === "CONNECT_TINDER"), false);
  assert.equal(fake.state.coordinatorCommands.length, 0);
});

test("a now-connected heartbeat delivers the live V8 child but never replays its earlier coordinator CONNECT", async () => {
  const read = commandRow(
    "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT",
    new Date(NOW.valueOf() - 1_000),
    "6a444444-4444-4444-8444-444444444444"
  );
  const priorConnect = commandRow(
    "CONNECT_TINDER",
    new Date(NOW.valueOf() - 900),
    "6b444444-4444-4444-8444-444444444444",
    { created_by: "server_tinder_unbound_inbox_sweep_gate_recovery" }
  );
  const payload = heartbeatPayload({
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES,
    tinder_state: "CONNECTED"
  });
  const request = heartbeatRequest(payload, {
    requestId: "6c444444-4444-4444-8444-444444444444"
  });
  const fake = heartbeatPool({
    request,
    commands: [priorConnect, read],
    localAttestationFoundation: true,
    unboundInboxSweepFoundation: true,
    coordinatorRuntime: {
      device_id: DEVICE_ID, enrollment_state: "ACTIVE", revoked_at: null,
      last_accepted_heartbeat_at: new Date(NOW.valueOf() - 1_000),
      bridge_service_state: "RUNNING", tinder_state: "CONNECTED", automation_state: "STOPPED",
      capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES
    },
    activeSweepChild: true,
    coordinatorDeliveryValid: false
  });
  const response = await processHeartbeatTransaction(
    fake.pool,
    {
      deviceId: DEVICE_ID,
      keyId: KEY_ID,
      requestId: "6c444444-4444-4444-8444-444444444444",
      contentSha256: request.hash
    },
    payload,
    NOW,
    { inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION }
  );
  assert.deepEqual(response.commands.map(command => command.type), [
    "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT"
  ]);
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

test("V9 remains fail-closed until the separate current-chat readiness contract is available", async () => {
  const returnCommandId = "5c444444-4444-4444-8444-444444444444";
  const capabilities = T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_RETURN_DEVICE_CAPABILITIES;
  const payload = heartbeatPayload({ capabilities, tinder_state: "CONNECTED" });
  const request = heartbeatRequest(payload);
  const staged = commandRow("RETURN_TINDER_VERIFIED_CHAT_TO_INBOX", NOW, returnCommandId);
  const fake = heartbeatPool({ request, commands: [staged] });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    payload,
    NOW,
    {
      inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION,
      inspectVerifiedChatReturnFoundation: async () => ({ state: "CANONICAL" })
    }
  );
  assert.deepEqual(response.commands, []);
  assert.equal(JSON.stringify(response).includes("binding_revision"), false);
  assert.equal(JSON.stringify(response).includes("source_capture"), false);
  assert.equal(fake.calls.some(call => String(call.sql).includes("RETURN_TINDER_VERIFIED_CHAT_TO_INBOX")), false);
});

test("V9 delivers only on an exact same-heartbeat readiness bit and audits no scope", async () => {
  const returnCommandId = "5c444444-4444-4444-8444-444444444444";
  const capabilities = T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_RETURN_DEVICE_CAPABILITIES;
  const payload = heartbeatPayload({
    capabilities,
    tinder_state: "CONNECTED",
    tinder_verified_chat_return: { ready: true }
  });
  const request = heartbeatRequest(payload);
  const staged = commandRow("RETURN_TINDER_VERIFIED_CHAT_TO_INBOX", NOW, returnCommandId);
  const fake = heartbeatPool({ request, commands: [staged] });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    payload,
    NOW,
    {
      inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION,
      inspectVerifiedChatReturnFoundation: async () => ({ state: "CANONICAL" })
    }
  );
  assert.deepEqual(response.commands, [{
    command_id: returnCommandId,
    protocol_version: 1,
    type: "RETURN_TINDER_VERIFIED_CHAT_TO_INBOX",
    issued_at: NOW.toISOString(),
    expires_at: new Date(NOW.valueOf() + 300_000).toISOString(),
    configuration_revision: 1,
    payload: {}
  }]);
  const audit = fake.calls.find(call => String(call.sql).includes("INSERT INTO device_bridge_audit_events"));
  assert.deepEqual(JSON.parse(audit.params[3]), {
    sequence: 1,
    tinder_verified_chat_return: { ready: true }
  });
  const selection = fake.calls.find(call => String(call.sql).includes("FROM device_bridge_commands")
    && String(call.sql).includes("RETURN_TINDER_VERIFIED_CHAT_TO_INBOX"));
  assert.match(String(selection?.sql), /return_permit\.permit_state='ISSUED'/);
  assert.match(String(selection?.sql), /resume_permit\.permit_state='DISPATCHED'/);
  assert.match(String(selection?.sql), /binding\.binding_revision=return_permit\.binding_revision/);
  assert.equal(JSON.stringify(response).match(/source_capture|binding_revision|resume_command|fingerprint|message/i), null);

  for (const tinder_verified_chat_return of [
    {},
    { ready: "true" },
    { ready: true, extra: false },
    null
  ]) {
    const invalid = heartbeatPayload({ capabilities, tinder_state: "CONNECTED", tinder_verified_chat_return });
    assert.throws(
      () => parseAndValidateHeartbeat(heartbeatRequest(invalid).req),
      error => error.code === "INVALID_DEVICE_STATE"
    );
  }
});

test("V10 delivers only on an exact same-heartbeat identity-free readiness bit", async () => {
  const returnCommandId = "50444444-4444-4444-8444-444444444444";
  const capabilities =
    T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_RETURN_FOREGROUND_RETURN_DEVICE_CAPABILITIES;
  const payload = heartbeatPayload({
    capabilities,
    tinder_state: "CONNECTED",
    tinder_resumed_foreground_chat_return: { ready: true }
  });
  const request = heartbeatRequest(payload);
  const staged = commandRow(
    "RETURN_TINDER_RESUMED_FOREGROUND_CHAT_TO_INBOX",
    NOW,
    returnCommandId
  );
  const fake = heartbeatPool({ request, commands: [staged] });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    payload,
    NOW,
    {
      inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION,
      inspectUnboundInboxConversationSweepRuntimeFoundation: async () => ({ state: "CANONICAL" }),
      inspectVerifiedChatReturnFoundation: async () => ({ state: "INVALID" }),
      inspectResumedForegroundChatReturnFoundation: async () => ({ state: "CANONICAL" })
    }
  );
  assert.deepEqual(response.commands, [{
    command_id: returnCommandId,
    protocol_version: 1,
    type: "RETURN_TINDER_RESUMED_FOREGROUND_CHAT_TO_INBOX",
    issued_at: NOW.toISOString(),
    expires_at: new Date(NOW.valueOf() + 300_000).toISOString(),
    configuration_revision: 1,
    payload: {}
  }]);
  const audit = fake.calls.find(call => String(call.sql).includes("INSERT INTO device_bridge_audit_events"));
  assert.deepEqual(JSON.parse(audit.params[3]), {
    sequence: 1,
    tinder_resumed_foreground_chat_return: { ready: true }
  });
  const selection = fake.calls.find(call => String(call.sql).includes("FROM device_bridge_commands")
    && String(call.sql).includes("RETURN_TINDER_RESUMED_FOREGROUND_CHAT_TO_INBOX"));
  assert.match(String(selection?.sql), /return_permit\.permit_state='ISSUED'/);
  assert.match(String(selection?.sql), /resume_permit\.permit_state='DISPATCHED'/);
  const v10Predicate = String(selection?.sql).slice(
    String(selection?.sql).indexOf("command_type <> 'RETURN_TINDER_RESUMED_FOREGROUND_CHAT_TO_INBOX'")
  );
  assert.doesNotMatch(
    v10Predicate,
    /binding_revision|source_capture|capture_fingerprint|thread_fingerprint/i
  );
  assert.equal(JSON.stringify(response).match(/source_capture|binding_revision|resume_command|fingerprint|message/i), null);

  const withheldPayload = heartbeatPayload({ capabilities, tinder_state: "CONNECTED" });
  const withheldRequest = heartbeatRequest(withheldPayload, {
    requestId: "51444444-4444-4444-8444-444444444444"
  });
  const withheld = heartbeatPool({ request: withheldRequest, commands: [staged] });
  const withheldResponse = await processHeartbeatTransaction(
    withheld.pool,
    {
      deviceId: DEVICE_ID,
      keyId: KEY_ID,
      requestId: "51444444-4444-4444-8444-444444444444",
      contentSha256: withheldRequest.hash
    },
    withheldPayload,
    NOW,
    {
      inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION,
      inspectUnboundInboxConversationSweepRuntimeFoundation: async () => ({ state: "CANONICAL" }),
      inspectVerifiedChatReturnFoundation: async () => ({ state: "INVALID" }),
      inspectResumedForegroundChatReturnFoundation: async () => ({ state: "CANONICAL" })
    }
  );
  assert.deepEqual(withheldResponse.commands, []);

  for (const tinder_resumed_foreground_chat_return of [
    {},
    { ready: "true" },
    { ready: true, extra: false },
    null
  ]) {
    const invalid = heartbeatPayload({
      capabilities,
      tinder_state: "CONNECTED",
      tinder_resumed_foreground_chat_return
    });
    assert.throws(
      () => parseAndValidateHeartbeat(heartbeatRequest(invalid).req),
      error => error.code === "INVALID_DEVICE_STATE"
    );
  }
  assert.throws(
    () => parseAndValidateHeartbeat(heartbeatRequest(heartbeatPayload({
      capabilities,
      tinder_state: "CONNECTED",
      tinder_verified_chat_return: { ready: true },
      tinder_resumed_foreground_chat_return: { ready: true }
    })).req),
    error => error.code === "INVALID_DEVICE_STATE"
  );
});

test("V9 expiry is terminalized and content-free audited before command selection", async () => {
  const capabilities = T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_RETURN_DEVICE_CAPABILITIES;
  const payload = heartbeatPayload({ capabilities, tinder_state: "CONNECTED" });
  const request = heartbeatRequest(payload);
  const fake = heartbeatPool({
    request,
    commands: [commandRow("PING", NOW, "5d444444-4444-4444-8444-444444444444")],
    expiredVerifiedChatReturnRows: [{
      command_id: "5e444444-4444-4444-8444-444444444444",
      device_id: DEVICE_ID,
      binding_id: "5f444444-4444-4444-8444-444444444444",
      binding_revision: 3
    }]
  });
  const response = await processHeartbeatTransaction(
    fake.pool,
    { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash },
    payload,
    NOW,
    {
      inspectUnboundInboxConversationSweepFoundation: CANONICAL_V8_FOUNDATION,
      inspectVerifiedChatReturnFoundation: async () => ({ state: "CANONICAL" })
    }
  );
  assert.deepEqual(response.commands, []);
  assert.equal(fake.state.verifiedChatReturnAudits.length, 1);
  assert.equal(JSON.stringify(fake.state.verifiedChatReturnAudits[0]).match(/source_capture|message|fingerprint|secret|token/i), null);
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

function statusRow(lastAccepted = null, capabilities = CAPABILITIES, tinderState = "UNKNOWN",
    inboxNavigation = null, officialResumeHandoff = null,
    resumedForegroundChatReturn = null, resumedForegroundChatReturnDiagnostic = null,
    officialResumeSchemaEvidence = null,
    lastAcceptedOfficialResumeSchemaDiagnostic = null,
    passiveInboxObservationDiagnostic = null,
    lastAcceptedPassiveInboxObservationDiagnosticAfterLatestV2Resume = null) {
  return {
    device_id: DEVICE_ID, display_name: "ZTE Blade A35e", enrollment_state: "ACTIVE",
    created_at: NOW,
    last_accepted_heartbeat_at: lastAccepted, app_version_name: "1.0", app_version_code: "1",
    bridge_service_state: "RUNNING", tinder_state: tinderState, automation_state: "STOPPED", capabilities,
    configuration_revision: 1,
    inbox_navigation: inboxNavigation,
    official_resume_handoff: officialResumeHandoff,
    tinder_official_resume_schema_evidence: officialResumeSchemaEvidence,
    last_accepted_official_resume_schema_diagnostic:
      lastAcceptedOfficialResumeSchemaDiagnostic,
    tinder_resumed_foreground_chat_return: resumedForegroundChatReturn,
    tinder_resumed_foreground_chat_return_diagnostic: resumedForegroundChatReturnDiagnostic,
    tinder_passive_inbox_observation_diagnostic: passiveInboxObservationDiagnostic,
    last_accepted_passive_inbox_observation_diagnostic_after_latest_v2_resume:
      lastAcceptedPassiveInboxObservationDiagnosticAfterLatestV2Resume
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

test("admin list and status classify a heartbeat read after their asynchronous query as online", async () => {
  let acceptedAt = null;
  const pool = {
    async query() {
      await new Promise(resolve => setTimeout(resolve, 12));
      acceptedAt = new Date();
      return { rows: [statusRow(acceptedAt, T4_RESUME_DEVICE_CAPABILITIES, "CONNECTED")] };
    }
  };
  const listRes = responseRecorder();
  await createAdminDeviceListHandler(pool)({}, listRes);
  assert.equal(listRes.body.devices[0].device_status, "ONLINE");
  assert.ok(new Date(listRes.body.server_time).valueOf() >= acceptedAt.valueOf());

  const statusRes = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, statusRes);
  assert.equal(statusRes.body.device.device_status, "ONLINE");
  assert.ok(new Date(statusRes.body.server_time).valueOf() >= acceptedAt.valueOf());
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

test("admin status projects only the exact terminal Tinder discovery V16 state", async () => {
  const diagnostic = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "TARGET_ACTION_REJECTED"
  };
  const pool = {
    async query() {
      return { rows: [statusRow(new Date(), T4_RESUME_DEVICE_CAPABILITIES,
        "CONNECTED", diagnostic)] };
    }
  };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.deepEqual(res.body.device.inbox_navigation, diagnostic);
  for (const forbidden of [
    "raw_accessibility_tree", "message_text", "visible_name", "node_id",
    "fingerprint", "exception_message"
  ]) {
    assert.equal(JSON.stringify(res.body.device).includes(forbidden), false);
  }

  for (const invalid of [
    { ...diagnostic, discovery_v16_state: "UNBOUNDED" },
    { ...diagnostic, stage: "INBOX_READY", reason: "NONE" },
    { ...diagnostic, reason: "UNKNOWN_INBOX_STRUCTURE" }
  ]) {
    const invalidPool = { async query() {
      return { rows: [statusRow(new Date(), T4_RESUME_DEVICE_CAPABILITIES,
        "CONNECTED", invalid)] };
    } };
    const invalidRes = responseRecorder();
    await createAdminDeviceStatusHandler(invalidPool)({ params: { deviceId: DEVICE_ID } }, invalidRes);
    assert.equal(invalidRes.body.device.inbox_navigation, null);
  }
});

test("admin status projects V16 selector counters only as the exact capped terminal pair", async () => {
  const diagnostic = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "LABEL_MATCH_COUNT_REJECTED",
    discovery_v16_raw_selector_match_count: 2,
    discovery_v16_qualified_selector_match_count: 1
  };
  const pool = {
    async query() {
      return { rows: [statusRow(new Date(), T4_RESUME_DEVICE_CAPABILITIES,
        "CONNECTED", diagnostic)] };
    }
  };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.deepEqual(res.body.device.inbox_navigation, diagnostic);
  for (const forbidden of [
    "raw_accessibility_tree", "message_text", "visible_name", "node_id",
    "fingerprint", "exception_message", "selector_text", "selector_id"
  ]) assert.equal(JSON.stringify(res.body.device).includes(forbidden), false);

  for (const invalid of [
    { ...diagnostic, discovery_v16_raw_selector_match_count: 3 },
    { ...diagnostic, discovery_v16_qualified_selector_match_count: -1 },
    { ...diagnostic, stage: "INBOX_READY", reason: "NONE" },
    (() => {
      const { discovery_v16_qualified_selector_match_count, ...withoutPair } = diagnostic;
      return withoutPair;
    })()
  ]) {
    const invalidPool = { async query() {
      return { rows: [statusRow(new Date(), T4_RESUME_DEVICE_CAPABILITIES,
        "CONNECTED", invalid)] };
    } };
    const invalidRes = responseRecorder();
    await createAdminDeviceStatusHandler(invalidPool)({ params: { deviceId: DEVICE_ID } }, invalidRes);
    assert.equal(invalidRes.body.device.inbox_navigation, null);
  }
});

test("admin status projects direct-static V2 only as the exact V16 terminal extension", async () => {
  const diagnostic = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "LABEL_MATCH_COUNT_REJECTED",
    discovery_v16_raw_selector_match_count: 2,
    discovery_v16_qualified_selector_match_count: 0,
    direct_static_v2_state: "DIRECT_TAB_BOUNDS_REJECTED"
  };
  const pool = { async query() {
    return { rows: [statusRow(new Date(), T4_RESUME_DEVICE_CAPABILITIES,
      "CONNECTED", diagnostic)] };
  } };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.deepEqual(res.body.device.inbox_navigation, diagnostic);
  for (const forbidden of [
    "raw_accessibility_tree", "message_text", "visible_name", "node_id",
    "fingerprint", "exception_message", "selector_text", "selector_id"
  ]) assert.equal(JSON.stringify(res.body.device).includes(forbidden), false);

  for (const invalid of [
    { ...diagnostic, direct_static_v2_state: "UNBOUNDED" },
    { ...diagnostic, reason: "UNKNOWN_INBOX_STRUCTURE" },
    (() => {
      const { discovery_v16_raw_selector_match_count,
        discovery_v16_qualified_selector_match_count, ...withoutCounters } = diagnostic;
      return withoutCounters;
    })()
  ]) {
    const invalidPool = { async query() {
      return { rows: [statusRow(new Date(), T4_RESUME_DEVICE_CAPABILITIES,
        "CONNECTED", invalid)] };
    } };
    const invalidRes = responseRecorder();
    await createAdminDeviceStatusHandler(invalidPool)({ params: { deviceId: DEVICE_ID } }, invalidRes);
    assert.equal(invalidRes.body.device.inbox_navigation, null);
  }
});

test("admin status projects V19 only behind the exact V18 cardinality rejection", async () => {
  const diagnostic = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "LABEL_MATCH_COUNT_REJECTED",
    discovery_v16_raw_selector_match_count: 0,
    discovery_v16_qualified_selector_match_count: 0,
    direct_static_v2_state: "DIRECT_CHILD_SET_REJECTED",
    discovery_v17_carrier_relation_state: "NO_EXACT_CARRIER_IN_FOUR_CHILD_WINDOW",
    discovery_v18_singleton_grandchild_relation_state:
      "SINGLETON_GRANDCHILD_CARDINALITY_REJECTED",
    discovery_v19_singleton_wrapper_shape_state: "WRAPPER_REFERENCE_UNAVAILABLE"
  };
  const pool = { async query() {
    return { rows: [statusRow(new Date(), T4_RESUME_DEVICE_CAPABILITIES,
      "CONNECTED", diagnostic)] };
  } };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.deepEqual(res.body.device.inbox_navigation, diagnostic);
  for (const forbidden of [
    "raw_accessibility_tree", "message_text", "visible_name", "node_id",
    "fingerprint", "exception_message", "selector_text", "selector_id"
  ]) assert.equal(JSON.stringify(res.body.device).includes(forbidden), false);

  for (const invalid of [
    { ...diagnostic, discovery_v19_singleton_wrapper_shape_state: "UNBOUNDED" },
    { ...diagnostic, discovery_v18_singleton_grandchild_relation_state:
      "EXACT_CARRIER_SINGLETON_GRANDCHILD" },
    { ...diagnostic, discovery_v16_raw_selector_match_count: 1 },
    { ...diagnostic, unexpected: "extra" },
    (() => {
      const { discovery_v18_singleton_grandchild_relation_state, ...withoutV18 } = diagnostic;
      return withoutV18;
    })()
  ]) {
    const invalidPool = { async query() {
      return { rows: [statusRow(new Date(), T4_RESUME_DEVICE_CAPABILITIES,
        "CONNECTED", invalid)] };
    } };
    const invalidRes = responseRecorder();
    await createAdminDeviceStatusHandler(invalidPool)(
      { params: { deviceId: DEVICE_ID } }, invalidRes);
    assert.equal(invalidRes.body.device.inbox_navigation, null);
  }
});

test("admin status projects V20 only as its independent exact base-and-counters branch", async () => {
  const diagnostic = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v20_five_structural_chat_state: "TARGET_PARENT_REJECTED",
    discovery_v20_raw_selector_match_count: 1,
    discovery_v20_qualified_selector_match_count: 0
  };
  const pool = { async query() {
    return { rows: [statusRow(new Date(), T4_RESUME_DEVICE_CAPABILITIES,
      "CONNECTED", diagnostic)] };
  } };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.deepEqual(res.body.device.inbox_navigation, diagnostic);
  for (const forbidden of [
    "raw_accessibility_tree", "message_text", "visible_name", "node_id",
    "fingerprint", "exception_message", "selector_text", "selector_id"
  ]) assert.equal(JSON.stringify(res.body.device).includes(forbidden), false);

  for (const invalid of [
    { ...diagnostic, discovery_v20_five_structural_chat_state: "UNBOUNDED" },
    { ...diagnostic, discovery_v20_five_structural_chat_state: "NOT_EVALUATED" },
    { ...diagnostic, discovery_v20_qualified_selector_match_count: 3 },
    { ...diagnostic, discovery_v20_qualified_selector_match_count: 2 },
    { ...diagnostic, discovery_v16_state: "LABEL_MATCH_COUNT_REJECTED" },
    { ...diagnostic, stage: "INBOX_READY", reason: "NONE" }
  ]) {
    const invalidPool = { async query() {
      return { rows: [statusRow(new Date(), T4_RESUME_DEVICE_CAPABILITIES,
        "CONNECTED", invalid)] };
    } };
    const invalidRes = responseRecorder();
    await createAdminDeviceStatusHandler(invalidPool)(
      { params: { deviceId: DEVICE_ID } }, invalidRes);
    assert.equal(invalidRes.body.device.inbox_navigation, null);
  }
});

test("admin status projects V20 anchor states only with zero selector counters", async () => {
  const base = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v20_raw_selector_match_count: 0,
    discovery_v20_qualified_selector_match_count: 0
  };
  for (const state of [
    "ANCHOR_TRAVERSAL_INCOMPLETE",
    "ANCHOR_PARENT_ABSENT",
    "ANCHOR_PARENT_ARITY_ABSENT",
    "ANCHOR_PARENT_PACKAGE_PATH_ABSENT",
    "ANCHOR_PARENT_VISIBILITY_ABSENT",
    "ANCHOR_PARENT_LOWER_BAND_ABSENT",
    "ANCHOR_PARENT_NONINTERACTIVE_SHAPE_ABSENT",
    "ANCHOR_ARITY_VARIANT_PARENT_REVALIDATION_REJECTED",
    "ANCHOR_ARITY_VARIANT_UNPROVEN_EXTRA_REJECTED",
    "ANCHOR_ARITY_VARIANT_STRICT_BRANCH_COUNT_REJECTED",
    "ANCHOR_ARITY_VARIANT_PRIVATE_LEAF_DUPLICATE_REJECTED",
    "ANCHOR_ARITY_VARIANT_BRANCH_SET_REJECTED",
    "ANCHOR_ARITY_VARIANT_V5_GROUP_REJECTED",
    "ANCHOR_STRICT_PROOF_ABSENT",
    "ANCHOR_STRICT_PROOF_AMBIGUOUS"
  ]) {
    const diagnostic = {
      ...base,
      discovery_v20_five_structural_chat_state: state
    };
    const validPool = { async query() {
      return { rows: [statusRow(new Date(), T4_RESUME_DEVICE_CAPABILITIES,
        "CONNECTED", diagnostic)] };
    } };
    const validRes = responseRecorder();
    await createAdminDeviceStatusHandler(validPool)(
      { params: { deviceId: DEVICE_ID } }, validRes);
    assert.deepEqual(validRes.body.device.inbox_navigation, diagnostic);

    const invalid = {
      ...diagnostic,
      discovery_v20_raw_selector_match_count: 1,
      discovery_v20_qualified_selector_match_count: 1
    };
    const invalidPool = { async query() {
      return { rows: [statusRow(new Date(), T4_RESUME_DEVICE_CAPABILITIES,
        "CONNECTED", invalid)] };
    } };
    const invalidRes = responseRecorder();
    await createAdminDeviceStatusHandler(invalidPool)(
      { params: { deviceId: DEVICE_ID } }, invalidRes);
    assert.equal(invalidRes.body.device.inbox_navigation, null);
  }
});

test("admin status projects only the newest bounded official resume handoff diagnostic", async () => {
  const diagnostic = { stage: "BLOCKED", reason: "OFFICIAL_FOREGROUND_NOT_OBSERVED" };
  let sql = "";
  const pool = {
    async query(query) {
      sql = query;
      return { rows: [statusRow(new Date(), T4_RESUME_DEVICE_CAPABILITIES,
        "CONNECTED", null, diagnostic)] };
    }
  };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.deepEqual(res.body.device.official_resume_handoff, diagnostic);
  assert.match(sql, /tinder_official_resume_handoff/);
  assert.match(sql, /HEARTBEAT_ACCEPTED/);
  assert.equal(JSON.stringify(res.body.device).includes("details"), false);
});

test("admin status keeps current resume schema evidence current-heartbeat-only", async () => {
  const handoff = { stage: "BLOCKED", reason: "UNREVIEWED_OFFICIAL_SURFACE" };
  const evidence = officialResumeSchemaEvidence();
  let sql = "";
  const pool = {
    async query(query) {
      sql = query;
      return { rows: [statusRow(new Date(), T4_RESUME_DEVICE_CAPABILITIES,
        "CONNECTED", null, handoff, null, null, evidence)] };
    }
  };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.deepEqual(res.body.device.tinder_official_resume_schema_evidence, evidence);
  assert.match(sql, /tinder_official_resume_schema_evidence/);
  assert.doesNotMatch(sql, /COALESCE\s*\(/i);
  assert.equal(res.body.device.last_accepted_official_resume_schema_diagnostic, null);
});

test("admin status projects separately labelled accepted V2 resume schema evidence without replacing live evidence", async () => {
  const handoff = { stage: "BLOCKED", reason: "UNREVIEWED_OFFICIAL_SURFACE" };
  const evidence = officialResumeSchemaEvidence();
  const retained = { handoff, schema_evidence: evidence };
  let sql = "";
  const pool = {
    async query(query) {
      sql = query;
      return { rows: [statusRow(new Date(), T4_RESUME_DEVICE_CAPABILITIES,
        "CONNECTED", null, handoff, null, null, null, retained)] };
    }
  };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.equal(res.body.device.tinder_official_resume_schema_evidence, null);
  assert.deepEqual(res.body.device.last_accepted_official_resume_schema_diagnostic, retained);
  assert.match(sql, /last_accepted_official_resume_schema_diagnostic/);
  assert.match(sql, /jsonb_build_object\(/i);
  assert.match(sql, /FROM tinder_official_app_resume_permits resume_permit/i);
  assert.match(sql, /evidence_heartbeat\.command_id=resume_permit\.command_id/i);
  assert.match(sql, /resume_permit\.permit_contract_version=2/i);
  assert.match(sql, /resume_permit\.permit_state='DISPATCHED'/i);
  assert.match(sql, /resume_permit\.dispatched_at IS NOT NULL/i);
  assert.match(sql, /evidence_heartbeat\.command_id IS NOT NULL/i);
  assert.match(sql, /evidence_heartbeat\.result_code='SUCCEEDED'/i);
  assert.match(sql, /evidence_heartbeat\.http_status=200/i);
  assert.match(sql, /evidence_heartbeat\.created_at>=resume_permit\.dispatched_at/i);
  assert.match(sql, /evidence_heartbeat\.created_at<resume_permit\.expires_at/i);
  assert.match(sql, /ORDER BY evidence_heartbeat\.created_at DESC, evidence_heartbeat\.audit_event_id DESC/i);
  assert.match(sql, /evidence_heartbeat\.details \? 'tinder_official_resume_schema_evidence'/i);
  assert.match(sql, /UNREVIEWED_OFFICIAL_SURFACE/);
  assert.doesNotMatch(sql, /COALESCE\s*\(/i);
  assert.doesNotMatch(sql, /source_capture_id|binding_id|capture_id|visible_name|message_text/i);
  const serialized = JSON.stringify(res.body.device);
  for (const forbidden of ["raw_accessibility_tree", "node_shapes", "fingerprint",
    "package_name", "view_id_token", "class_name"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("admin status suppresses malformed, offline, or orphaned live and retained resume schema evidence", async () => {
  const handoff = { stage: "BLOCKED", reason: "UNREVIEWED_OFFICIAL_SURFACE" };
  const evidence = officialResumeSchemaEvidence();
  for (const [acceptedAt, currentHandoff, candidate] of [
    [new Date(), handoff, { ...evidence, raw_accessibility_tree: "forbidden" }],
    [new Date(Date.now() - 91_000), handoff, evidence],
    [new Date(), null, evidence]
  ]) {
    const pool = {
      async query() {
        return { rows: [statusRow(acceptedAt, T4_RESUME_DEVICE_CAPABILITIES,
          "CONNECTED", null, currentHandoff, null, null, candidate)] };
      }
    };
    const res = responseRecorder();
    await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
    assert.equal(res.body.device.tinder_official_resume_schema_evidence, null);
  }

  for (const [acceptedAt, currentHandoff, retained] of [
    [new Date(), handoff, { handoff, schema_evidence: { ...evidence, raw_accessibility_tree: "forbidden" } }],
    [new Date(), handoff, { handoff: { stage: "BLOCKED", reason: "OFFICIAL_FOREGROUND_NOT_OBSERVED" }, schema_evidence: evidence }],
    [new Date(Date.now() - 91_000), handoff, { handoff, schema_evidence: evidence }],
    [new Date(), null, { handoff, schema_evidence: evidence }]
  ]) {
    const pool = {
      async query() {
        return { rows: [statusRow(acceptedAt, T4_RESUME_DEVICE_CAPABILITIES,
          "CONNECTED", null, currentHandoff, null, null, null, retained)] };
      }
    };
    const res = responseRecorder();
    await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
    assert.equal(res.body.device.last_accepted_official_resume_schema_diagnostic, null);
  }
});

test("admin status projects only the newest content-free V10 return readiness", async () => {
  const readiness = { ready: true };
  let sql = "";
  const pool = {
    async query(query) {
      sql = query;
      return { rows: [statusRow(new Date(),
        T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_RETURN_FOREGROUND_RETURN_DEVICE_CAPABILITIES,
        "CONNECTED", null, null, readiness)] };
    }
  };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.deepEqual(res.body.device.tinder_resumed_foreground_chat_return, readiness);
  assert.match(sql, /tinder_resumed_foreground_chat_return/);
  for (const forbidden of ["permit", "command", "identity", "source", "binding", "capture", "header", "text"]) {
    assert.equal(JSON.stringify(res.body.device).includes(forbidden), false);
  }
});

test("admin status suppresses malformed or offline V10 return readiness", async () => {
  for (const [acceptedAt, readiness] of [
    [new Date(), { ready: true, raw: "forbidden" }],
    [new Date(), { ready: "true" }],
    [new Date(Date.now() - 91_000), { ready: true }]
  ]) {
    const pool = {
      async query() {
        return { rows: [statusRow(acceptedAt,
          T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_RETURN_FOREGROUND_RETURN_DEVICE_CAPABILITIES,
          "CONNECTED", null, null, readiness)] };
      }
    };
    const res = responseRecorder();
    await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
    assert.equal(res.body.device.tinder_resumed_foreground_chat_return, null);
  }
});

test("admin status projects only the bounded online V10 lifecycle diagnostic", async () => {
  const diagnostic = { stage: "RETURN_ACTION_STAGED", reason: "NONE" };
  let sql = "";
  const pool = {
    async query(query) {
      sql = query;
      return { rows: [statusRow(new Date(),
        T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_RETURN_FOREGROUND_RETURN_DEVICE_CAPABILITIES,
        "CONNECTED", null, null, null, diagnostic)] };
    }
  };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.deepEqual(res.body.device.tinder_resumed_foreground_chat_return_diagnostic, diagnostic);
  assert.match(sql, /tinder_resumed_foreground_chat_return_diagnostic/);
  for (const forbidden of ["permit", "command", "identity", "source", "binding", "capture", "header", "text"]) {
    assert.equal(JSON.stringify(res.body.device).includes(forbidden), false);
  }
});

test("admin status suppresses malformed or offline V10 lifecycle diagnostic", async () => {
  const valid = { stage: "BLOCKED", reason: "RETURN_TIMEOUT" };
  for (const [acceptedAt, diagnostic] of [
    [new Date(), { ...valid, raw: "forbidden" }],
    [new Date(), { stage: "IDLE", reason: "NONE" }],
    [new Date(Date.now() - 91_000), valid]
  ]) {
    const pool = {
      async query() {
        return { rows: [statusRow(acceptedAt,
          T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_RETURN_FOREGROUND_RETURN_DEVICE_CAPABILITIES,
          "CONNECTED", null, null, null, diagnostic)] };
      }
    };
    const res = responseRecorder();
    await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
    assert.equal(res.body.device.tinder_resumed_foreground_chat_return_diagnostic, null);
  }
});

test("admin status projects only the bounded online passive Inbox observation diagnostic", async () => {
  const diagnostic = {
    stage: "BLOCKED",
    reason: "SETTLE_PARTIAL_OR_UNKNOWN",
    settle_sample_count: 2,
    validation_count: 3
  };
  let sql = "";
  const pool = {
    async query(query) {
      sql = query;
      const row = statusRow(new Date(), CAPABILITIES, "CONNECTED");
      row.tinder_passive_inbox_observation_diagnostic = diagnostic;
      return { rows: [row] };
    }
  };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.deepEqual(res.body.device.tinder_passive_inbox_observation_diagnostic, diagnostic);
  assert.match(sql, /tinder_passive_inbox_observation_diagnostic/);
  for (const forbidden of ["permit", "command", "identity", "source", "binding", "capture", "header", "text"]) {
    assert.equal(JSON.stringify(res.body.device).includes(forbidden), false);
  }
});

test("admin status suppresses malformed or offline passive Inbox observation diagnostic", async () => {
  const valid = {
    stage: "BLOCKED",
    reason: "HEARTBEAT_EXPIRED",
    settle_sample_count: 2,
    validation_count: 3
  };
  for (const [acceptedAt, diagnostic] of [
    [new Date(), { ...valid, raw: "forbidden" }],
    [new Date(), { ...valid, settle_sample_count: 9 }],
    [new Date(), { ...valid, stage: "ARMED" }],
    [new Date(Date.now() - 91_000), valid]
  ]) {
    const pool = {
      async query() {
        const row = statusRow(acceptedAt, CAPABILITIES, "CONNECTED");
        row.tinder_passive_inbox_observation_diagnostic = diagnostic;
        return { rows: [row] };
      }
    };
    const res = responseRecorder();
    await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
    assert.equal(res.body.device.tinder_passive_inbox_observation_diagnostic, null);
  }
});

test("admin status retains separately labelled bounded passive Inbox evidence after the newest V2 Resume", async () => {
  const historical = {
    stage: "BLOCKED",
    reason: "RUNTIME_GATE_LOST",
    settle_sample_count: 0,
    validation_count: 0
  };
  let sql = "";
  const pool = {
    async query(query) {
      sql = query;
      const row = statusRow(new Date(), CAPABILITIES, "CONNECTED");
      row.last_accepted_passive_inbox_observation_diagnostic_after_latest_v2_resume =
        historical;
      return { rows: [row] };
    }
  };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.equal(res.body.device.tinder_passive_inbox_observation_diagnostic, null);
  assert.deepEqual(
    res.body.device.last_accepted_passive_inbox_observation_diagnostic_after_latest_v2_resume,
    historical
  );
  assert.match(sql, /latest_v2_resume/i);
  assert.match(sql, /resume_command\.command_type='RESUME_OFFICIAL_TINDER_APP'/i);
  assert.match(sql, /resume_command\.terminal_status='SUCCEEDED'/i);
  assert.match(sql, /resume_command\.payload='\{\}'::jsonb/i);
  assert.match(sql, /evidence_heartbeat\.created_at>=latest_v2_resume\.dispatched_at/i);
  assert.match(sql, /evidence_heartbeat\.details \? 'tinder_passive_inbox_observation_diagnostic'/i);
  const historicalPassiveLateral = sql.slice(sql.indexOf(") latest_v2_resume ON true"));
  assert.doesNotMatch(historicalPassiveLateral, /expires_at/i);
  const serialized = JSON.stringify(
    res.body.device.last_accepted_passive_inbox_observation_diagnostic_after_latest_v2_resume
  );
  for (const forbidden of ["permit", "command", "identity", "source", "binding", "capture", "header", "text"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("admin status suppresses malformed or offline historical passive Inbox evidence", async () => {
  const valid = {
    stage: "BLOCKED",
    reason: "RUNTIME_GATE_LOST",
    settle_sample_count: 0,
    validation_count: 0
  };
  for (const [acceptedAt, historical] of [
    [new Date(), { ...valid, raw: "forbidden" }],
    [new Date(), { ...valid, stage: "UNKNOWN", reason: "NONE" }],
    [new Date(Date.now() - 91_000), valid]
  ]) {
    const pool = {
      async query() {
        const row = statusRow(acceptedAt, CAPABILITIES, "CONNECTED");
        row.last_accepted_passive_inbox_observation_diagnostic_after_latest_v2_resume =
          historical;
        return { rows: [row] };
      }
    };
    const res = responseRecorder();
    await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
    assert.equal(
      res.body.device.last_accepted_passive_inbox_observation_diagnostic_after_latest_v2_resume,
      null
    );
  }
});

test("admin status suppresses stale or malformed official resume handoff diagnostic", async () => {
  const diagnostic = { stage: "BLOCKED", reason: "ACK_WINDOW_EXPIRED" };
  for (const [acceptedAt, value] of [
    [new Date(Date.now() - 91_000), diagnostic],
    [new Date(), { ...diagnostic, raw_error: "forbidden" }],
    [new Date(), { stage: "IDLE", reason: "NONE" }]
  ]) {
    const pool = {
      async query() {
        return { rows: [statusRow(acceptedAt, T4_RESUME_DEVICE_CAPABILITIES,
          "CONNECTED", null, value)] };
      }
    };
    const res = responseRecorder();
    await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
    assert.equal(res.body.device.official_resume_handoff, null);
  }
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
  const officialResumePredicate = heartbeatSource.slice(
    heartbeatSource.indexOf("const officialAppResumeDeliveryPredicate"),
    heartbeatSource.indexOf("const localConversationAttestationDeliveryPredicate")
  );
  assert.match(heartbeatSource, /COALESCE\(to_jsonb\(resume_permit\)->>'permit_contract_version', '1'\) = '1'/);
  assert.match(heartbeatSource, /to_jsonb\(resume_permit\)->>'permit_contract_version' = '2'/);
  assert.match(heartbeatSource, /binding\.binding_id::text=to_jsonb\(resume_permit\)->>'binding_id'/);
  assert.match(heartbeatSource, /binding\.binding_revision::text=to_jsonb\(resume_permit\)->>'binding_revision'/);
  assert.match(heartbeatSource, /binding\.binding_state='CONFIRMED'/);
  assert.match(heartbeatSource, /binding_permit\.permit_state='CONSUMED'/);
  assert.match(heartbeatSource, /binding_permit\.consumed_capture_id=resume_permit\.source_capture_id/);
  assert.match(heartbeatSource, /source_capture\.human_review_status='CONFIRMED'/);
  assert.match(heartbeatSource, /resume_permit\.expires_at>\$2/);
  assert.doesNotMatch(officialResumePredicate, /resume_permit\.(?:binding_id|binding_revision|permit_contract_version)/);
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
