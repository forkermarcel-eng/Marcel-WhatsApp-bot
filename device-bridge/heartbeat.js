import {
  AUTOMATION_STATES,
  BRIDGE_SERVICE_STATES,
  DEVICE_BRIDGE_PROTOCOL,
  DeviceBridgeProtocolError,
  deviceBridgeCapabilityProfile,
  isKnownTinderStateForCapabilities,
  isTinderHumanArmedConversationBindingCapable,
  isTinderLocalConversationAttestationPostChatCapable,
  isTinderUnboundInboxConversationSweepCapable,
  isTinderVerifiedChatReturnCapable,
  isTinderResumedForegroundChatReturnCapable,
  isTinderManualGateCapable,
  isTinderManualSendCapable,
  isTinderOfficialAppResumeCapable,
  isTinderVisibleChatSyncCapable,
  isExactUtcTimestamp,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_VERSION,
  isUuidV4,
  protocolErrorBody
} from "./protocol-v1.js";
import {
  registerAuthenticatedRequestReplay,
  verifyAuthenticatedDeviceRequest
} from "./device-auth.js";
import {
  TINDER_SEND_COMMAND_TYPE
} from "../services/tinder-manual-send.js";
import { hydrateTinderManualSendCommandForHeartbeat } from "./tinder-manual-send-command-hydration.js";
import {
  inspectTinderUnboundInboxConversationSweepSchema,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE
} from "./tinder-unbound-inbox-conversation-sweep-schema.js";
import {
  inspectTinderUnboundInboxConversationSweepRuntimeSchema,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE
} from "./tinder-unbound-inbox-conversation-sweep-runtime-schema.js";
import {
  inspectTinderVerifiedChatReturnSchema,
  TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE
} from "./tinder-verified-chat-return-schema.js";
import {
  inspectTinderResumedForegroundChatReturnSchema,
  TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE
} from "./tinder-resumed-foreground-chat-return-schema.js";
import {
  boundedTinderUnboundInboxConversationSweepExpiryPhase,
  boundedTinderUnboundInboxConversationSweepIssuePhase
} from "../services/tinder-unbound-inbox-conversation-sweep.js";
import {
  boundedTinderUnboundInboxSweepDiagnostic
} from "./tinder-unbound-inbox-sweep-diagnostic-contract.js";
import {
  boundedTinderOfficialResumeHandoffDiagnostic
} from "./tinder-official-resume-handoff-diagnostic-contract.js";
import {
  boundedTinderOfficialResumeSchemaEvidence
} from "./tinder-official-resume-schema-evidence-contract.js";
import {
  boundedTinderResumedForegroundChatReturnDiagnostic
} from "./tinder-resumed-foreground-chat-return-diagnostic-contract.js";

const TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE = "RESUME_OFFICIAL_TINDER_APP";
const TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE = "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION";
const TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE = "tinder_local_conversation_attestation_permits";
const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE =
  "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT";
const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE =
  "RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT";
const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE = "tinder_unbound_inbox_conversation_sweeps";
const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE = "tinder_unbound_inbox_conversation_sweep_steps";
const TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE = "RETURN_TINDER_VERIFIED_CHAT_TO_INBOX";
const TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE = "tinder_verified_chat_return_permits";
const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE =
  "RETURN_TINDER_RESUMED_FOREGROUND_CHAT_TO_INBOX";
const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE =
  "tinder_resumed_foreground_chat_return_permits";
const TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE = "tinder_official_app_resume_permits";
const TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE = "tinder_visible_chat_sync_permits";
const TINDER_HUMAN_ARMED_CONVERSATION_REFERENCE_KIND = "tinder_human_armed_conversation_v1";
const HEARTBEAT_FAILURE_STAGE_PROPERTY = "deviceBridgeHeartbeatFailureStage";
const HEARTBEAT_FAILURE_STAGES = new Set([
  "BEGIN", "DEVICE_LOCK", "REQUEST_REPLAY", "V8_FOUNDATION", "V8_RUNTIME_FOUNDATION", "V9_FOUNDATION", "V10_FOUNDATION",
  "SCHEMA_EVIDENCE_AUTHORIZATION", "SCHEMA_EVIDENCE_AUDIT", "DEVICE_UPDATE", "HEARTBEAT_AUDIT", "V8_START", "V8_EXPIRY",
  "V9_EXPIRY", "V10_EXPIRY", "COMMAND_SELECTION", "COMMIT", "ROLLBACK"
]);

// This is deliberately a bounded, content-free diagnostic contract. It is
// optional so an older installed Android release remains protocol-compatible,
// but whenever it is present its shape must be exact before the signed
// heartbeat can be accepted.
export const TINDER_INBOX_NAVIGATION_STAGES = Object.freeze([
  "IDLE",
  "AWAITING_INBOX",
  "AWAITING_OFFICIAL_RESUME_HANDOFF",
  "AWAITING_INBOX_TAB_ACTION",
  "INBOX_READY",
  "AWAITING_ROW_OPEN",
  "ROW_ACTION_ISSUED",
  "AWAITING_CHAT",
  "CHAT_VERIFIED",
  "BLOCKED"
]);

export const TINDER_INBOX_NAVIGATION_REASONS = Object.freeze([
  "NONE",
  "RUNTIME_GATE",
  "HUMAN_CALIBRATION_ACTIVE",
  "OPERATION_IN_PROGRESS",
  "ACCESSIBILITY_UNAVAILABLE",
  "OFFICIAL_RESUME_HANDOFF_FAILED",
  "FOREGROUND_WAIT_TIMEOUT",
  "SENSITIVE_SCREEN",
  "DISCOVERY_STRUCTURE_REJECTED",
  "INBOX_TAB_TARGET_DRIFT",
  "INBOX_TAB_ACTION_REJECTED",
  "INBOX_TRANSITION_TIMEOUT",
  "UNKNOWN_INBOX_STRUCTURE",
  "NO_ELIGIBLE_CONVERSATION",
  "ROW_SELECTION_UNAVAILABLE",
  "SNAPSHOT_EXPIRED",
  "ROW_TARGET_DRIFT",
  "ROW_ACTION_REJECTED",
  "CHAT_VERIFICATION_TIMEOUT",
  "CHAT_STRUCTURE_REJECTED",
  "ACCESSIBILITY_INTERRUPTED",
  "ACCESSIBILITY_UNBOUND",
  "ACCESSIBILITY_DESTROYED",
  "BRIDGE_NOT_RUNNING",
  "TINDER_GATE_NOT_CONNECTED",
  "LIFECYCLE_RESET",
  "LOCAL_STATE_UNAVAILABLE"
]);

const TINDER_INBOX_NAVIGATION_STAGE_SET = new Set(TINDER_INBOX_NAVIGATION_STAGES);
const TINDER_INBOX_NAVIGATION_REASON_SET = new Set(TINDER_INBOX_NAVIGATION_REASONS);
const TINDER_INBOX_NAVIGATION_FIELDS = Object.freeze([
  "stage", "reason", "visible_conversation_count", "observed_event_count"
]);
const TINDER_INBOX_NAVIGATION_DISCOVERY_V16_FIELDS = Object.freeze([
  ...TINDER_INBOX_NAVIGATION_FIELDS, "discovery_v16_state"
]);
const TINDER_INBOX_NAVIGATION_FRESH_OBSERVATION_FIELDS = Object.freeze([
  ...TINDER_INBOX_NAVIGATION_FIELDS, "observation_kind", "observation_nonce"
]);
export const TINDER_INBOX_FRESH_REVIEWED_OBSERVATION_KIND = "FRESH_REVIEWED_INBOX_V1";
const TINDER_INBOX_NAVIGATION_MAX_COUNT = 8;
// This terminal-only enum deliberately contains no view data, content,
// identifiers, bounds, fingerprints, or driver detail. It exists only to
// distinguish reviewed finite V16 discovery branches after a local
// fail-closed Inbox rejection. It is never a navigation target, permit, or
// command input.
export const TINDER_DISCOVERY_V16_STATES = Object.freeze([
  "NOT_EVALUATED",
  "BASE_STRUCTURE_REJECTED",
  "LABEL_MATCH_COUNT_REJECTED",
  "TARGET_PARENT_REJECTED",
  "TARGET_ACTION_REJECTED",
  "STRICT_CHAT_LABEL_INBOX_CANDIDATE"
]);
const TINDER_DISCOVERY_V16_STATE_SET = new Set(TINDER_DISCOVERY_V16_STATES);
// This is not a permit, target, or identity assertion.  It is a transient
// same-heartbeat readiness bit from the V9-capable Android runtime after it
// has locally revalidated the retained human-attested V3 continuity proof.
// The server still revalidates every durable fact immediately before it can
// deliver a return command.
export const TINDER_VERIFIED_CHAT_RETURN_READINESS_FIELDS = Object.freeze(["ready"]);
// V10's readiness proves only that this Android runtime currently retains a
// strict, content-free official-chat grammar after its own successful Resume.
// It is purposefully separate from V9's binding-attested readiness.
export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_READINESS_FIELDS =
  Object.freeze(["ready"]);

/* ==================================================
DEVICE BRIDGE T0 — PROTOCOL V1 HEARTBEAT
================================================== */

function invalidHeartbeat(message) {
  return new DeviceBridgeProtocolError(400, "INVALID_DEVICE_STATE", message);
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value, maximum) {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function nullableTimestamp(value) {
  return value === null || isExactUtcTimestamp(value);
}

function exactKeys(value, keys) {
  return object(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function tagHeartbeatFailureStage(error, stage) {
  if (!error || typeof error !== "object" || !HEARTBEAT_FAILURE_STAGES.has(stage)) return error;
  try {
    Object.defineProperty(error, HEARTBEAT_FAILURE_STAGE_PROPERTY, {
      value: stage, enumerable: false, configurable: true
    });
  } catch {
    // Preserve the original fail-closed error if a foreign error object cannot
    // carry bounded diagnostic metadata.
  }
  return error;
}

function boundedHeartbeatFailureStage(error) {
  return HEARTBEAT_FAILURE_STAGES.has(error?.[HEARTBEAT_FAILURE_STAGE_PROPERTY])
    ? error[HEARTBEAT_FAILURE_STAGE_PROPERTY]
    : "UNCLASSIFIED";
}

// Keep server-side heartbeat diagnostics useful without serializing a driver
// error, a SQLSTATE, a query, or any application data.  The labels below are
// deliberately coarse and finite: they tell an operator which recovery path
// to inspect while preserving the fail-closed public protocol response.
function boundedHeartbeatFailureReason(error) {
  let code = null;
  try {
    code = typeof error?.code === "string" ? error.code : null;
  } catch {
    return "INTERNAL_UNCLASSIFIED";
  }
  switch (code) {
    case "23505": return "DATABASE_UNIQUE_CONFLICT";
    case "23503": return "DATABASE_FOREIGN_KEY_CONFLICT";
    case "23514": return "DATABASE_CHECK_CONFLICT";
    case "P0001": return "DATABASE_GUARD_REJECTED";
    case "40001": return "DATABASE_TRANSACTION_CONFLICT";
    case "40P01": return "DATABASE_TRANSACTION_CONFLICT";
    case "55P03": return "DATABASE_LOCK_UNAVAILABLE";
    case "42P01": return "DATABASE_RELATION_MISSING";
    case "42703": return "DATABASE_COLUMN_MISSING";
    case "42601": return "DATABASE_QUERY_INVALID";
    case "42P10": return "DATABASE_CONSTRAINT_INVALID";
    case "0A000": return "DATABASE_QUERY_UNSUPPORTED";
    case "25P02": return "DATABASE_TRANSACTION_ABORTED";
    default: return /^[0-9A-Z]{5}$/.test(code || "")
      ? "DATABASE_UNCLASSIFIED"
      : "INTERNAL_UNCLASSIFIED";
  }
}

function boundedHeartbeatFailurePhase(error) {
  const stage = boundedHeartbeatFailureStage(error);
  if (stage === "V8_START") return boundedTinderUnboundInboxConversationSweepIssuePhase(error);
  return stage === "V8_EXPIRY"
    ? boundedTinderUnboundInboxConversationSweepExpiryPhase(error)
    : "UNCLASSIFIED";
}

export function isBoundedTinderInboxNavigationDiagnostic(value) {
  const discoveryV16 = exactKeys(value, TINDER_INBOX_NAVIGATION_DISCOVERY_V16_FIELDS);
  const freshObservation = exactKeys(value, TINDER_INBOX_NAVIGATION_FRESH_OBSERVATION_FIELDS);
  return (exactKeys(value, TINDER_INBOX_NAVIGATION_FIELDS) || discoveryV16 || freshObservation)
    && TINDER_INBOX_NAVIGATION_STAGE_SET.has(value.stage)
    && TINDER_INBOX_NAVIGATION_REASON_SET.has(value.reason)
    && Number.isSafeInteger(value.visible_conversation_count)
    && value.visible_conversation_count >= 0
    && value.visible_conversation_count <= TINDER_INBOX_NAVIGATION_MAX_COUNT
    && Number.isSafeInteger(value.observed_event_count)
    && value.observed_event_count >= 0
    && value.observed_event_count <= TINDER_INBOX_NAVIGATION_MAX_COUNT
    && (!freshObservation || (
      value.observation_kind === TINDER_INBOX_FRESH_REVIEWED_OBSERVATION_KIND
      && isUuidV4(value.observation_nonce)
    ))
    && (!discoveryV16 || (
      value.stage === "BLOCKED"
      && value.reason === "DISCOVERY_STRUCTURE_REJECTED"
      && TINDER_DISCOVERY_V16_STATE_SET.has(value.discovery_v16_state)
    ));
}

/**
 * V8 sweep diagnostic evidence is observational only.  Its exact grammar is
 * intentionally separate from Inbox freshness so no diagnostic field can
 * mint, consume, refresh, or replay a sweep child.
 */
export function isBoundedTinderUnboundInboxSweepDiagnostic(value) {
  return boundedTinderUnboundInboxSweepDiagnostic(value) !== null;
}

/**
 * This optional two-enum evidence is deliberately independent of Inbox
 * freshness and V8 issuance. Accepting it cannot select, mint, consume,
 * renew, replay, or otherwise affect a command or permit.
 */
export function isBoundedTinderOfficialResumeHandoffDiagnostic(value) {
  return boundedTinderOfficialResumeHandoffDiagnostic(value) !== null;
}

/**
 * Optional post-ACK schema evidence is observational only. It is distinct
 * from the exact two-enum handoff result and cannot alter a command, permit,
 * reader, capture, ingress, or readiness decision.
 */
export function isBoundedTinderOfficialResumeSchemaEvidence(value) {
  return boundedTinderOfficialResumeSchemaEvidence(value) !== null;
}

/**
 * The aggregate profile is a one-shot diagnostic companion, not a general
 * heartbeat capability.  Keeping this exact pair in one predicate lets both
 * the HTTP parser and the transaction/audit boundary reject an orphaned or
 * relabelled profile before it can become durable state.
 */
function isExactOfficialResumeSchemaEvidenceHeartbeat(heartbeat) {
  if (!heartbeat || typeof heartbeat !== "object"
      || !Object.hasOwn(heartbeat, "tinder_official_resume_schema_evidence")) {
    return false;
  }
  const handoff = Object.hasOwn(heartbeat, "tinder_official_resume_handoff")
    ? boundedTinderOfficialResumeHandoffDiagnostic(heartbeat.tinder_official_resume_handoff)
    : null;
  return handoff?.stage === "BLOCKED"
    && handoff.reason === "UNREVIEWED_OFFICIAL_SURFACE"
    && boundedTinderOfficialResumeSchemaEvidence(
      heartbeat.tinder_official_resume_schema_evidence) !== null;
}

function assertExactOfficialResumeSchemaEvidenceHeartbeat(heartbeat) {
  if (Object.hasOwn(heartbeat || {}, "tinder_official_resume_schema_evidence")
      && !isExactOfficialResumeSchemaEvidenceHeartbeat(heartbeat)) {
    throw new DeviceBridgeProtocolError(400, "INVALID_DEVICE_STATE",
      "Heartbeat official resume schema evidence is invalid");
  }
}

function officialResumeSchemaEvidenceAuditDetails(heartbeat) {
  assertExactOfficialResumeSchemaEvidenceHeartbeat(heartbeat);
  const evidence = boundedTinderOfficialResumeSchemaEvidence(
    heartbeat.tinder_official_resume_schema_evidence);
  if (evidence === null) {
    throw new DeviceBridgeProtocolError(400, "INVALID_DEVICE_STATE",
      "Heartbeat official resume schema evidence is invalid");
  }
  // This special heartbeat must never piggyback any operational status,
  // command, fresh-observation material, or unbounded sequencing value into
  // durable audit data. The audit row itself retains request/device/key/time
  // provenance without widening this diagnostic profile.
  return {
    tinder_official_resume_handoff: {
      stage: "BLOCKED",
      reason: "UNREVIEWED_OFFICIAL_SURFACE"
    },
    tinder_official_resume_schema_evidence: evidence
  };
}

function isOfficialResumeSchemaEvidenceAuthorizationError(error) {
  return error?.code === "TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_NOT_AUTHORIZED"
    || error?.code === "TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ALREADY_REPORTED";
}

/**
 * Atomically derive the one current V2 Resume command that authorizes this
 * diagnostic and append its paired audit record.  The caller already holds
 * the device row lock, while this statement binds exact-once to the derived
 * command rather than treating a device as globally consumed.  No Android
 * self-report can create provenance or widen the command surface.
 */
async function persistOfficialResumeSchemaEvidenceAudit(client, {
  auth, heartbeat, now
}) {
  const { deviceId, keyId, requestId } = auth;
  const capabilities = heartbeat.capabilities;
  if (!isTinderOfficialAppResumeCapable(capabilities)) {
    throw new DeviceBridgeProtocolError(409,
      "TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_NOT_AUTHORIZED",
      "Official resume schema evidence is not authorized");
  }
  const details = officialResumeSchemaEvidenceAuditDetails(heartbeat);
  const result = await client.query(
    `WITH current_resume_candidates AS (
       SELECT DISTINCT resume_permit.command_id
         FROM ${TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE} resume_permit
           JOIN device_bridge_commands resume_command
             ON resume_command.command_id=resume_permit.command_id
           JOIN device_bridge_command_acks resume_ack
             ON resume_ack.command_id=resume_command.command_id
            AND resume_ack.device_id=resume_command.device_id
           JOIN contact_human_armed_conversation_bindings binding
             ON binding.binding_id=resume_permit.binding_id
           JOIN tinder_visible_chat_captures source_capture
             ON source_capture.capture_id=resume_permit.source_capture_id
          WHERE resume_permit.device_id=$1
            AND resume_permit.permit_contract_version=2
            AND resume_permit.permit_state='DISPATCHED'
            AND resume_permit.dispatched_at IS NOT NULL
            AND resume_permit.dispatched_at <= $2
            AND resume_permit.expires_at>$2
            AND resume_command.device_id=resume_permit.device_id
            AND resume_command.command_type='${TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE}'
            AND resume_command.terminal_status='SUCCEEDED'
            AND resume_command.payload='{}'::jsonb
            AND resume_ack.status='SUCCEEDED'
            AND resume_ack.result='{"official_tinder_app_resume":"INTENT_DISPATCHED"}'::jsonb
            AND binding.device_id=resume_permit.device_id
            AND binding.binding_revision=resume_permit.binding_revision
            AND binding.channel='tinder'
            AND binding.reference_kind='${TINDER_HUMAN_ARMED_CONVERSATION_REFERENCE_KIND}'
            AND binding.binding_state='CONFIRMED'
            AND binding.human_verified=TRUE
            AND source_capture.device_id=binding.device_id
            AND source_capture.source_package='com.tinder'
            AND source_capture.capture_safety_status='SAFE'
            AND source_capture.mapping_status='RESOLVED'
            AND source_capture.human_review_status='CONFIRMED'
            AND source_capture.resolved_contact_id=binding.contact_id
            AND source_capture.capture_revision=(
              SELECT MAX(newer.capture_revision)
                FROM tinder_visible_chat_captures newer
               WHERE newer.device_id=source_capture.device_id
                 AND newer.runtime_thread_fingerprint=source_capture.runtime_thread_fingerprint
            )
            AND EXISTS (
              SELECT 1
                FROM contact_human_armed_conversation_binding_permits binding_permit
               WHERE binding_permit.binding_id=binding.binding_id
                 AND binding_permit.device_id=binding.device_id
                 AND binding_permit.binding_revision=binding.binding_revision
                 AND binding_permit.permit_state='CONSUMED'
                 AND binding_permit.consumed_capture_id=resume_permit.source_capture_id
            )
     ),
     candidate_summary AS (
       SELECT COUNT(*)::int AS schema_evidence_candidate_count
         FROM current_resume_candidates
     ),
     prior_evidence AS (
       SELECT EXISTS (
         SELECT 1
           FROM device_bridge_audit_events existing
           JOIN current_resume_candidates candidate
             ON candidate.command_id=existing.command_id
          WHERE existing.device_id=$1
            AND existing.event_type='HEARTBEAT_ACCEPTED'
            AND existing.details ? 'tinder_official_resume_schema_evidence'
       ) AS schema_evidence_already_reported
     ),
     paired_audit AS (
       INSERT INTO device_bridge_audit_events
         (event_type, request_id, device_id, key_id, command_id, result_code, http_status, details)
       SELECT 'HEARTBEAT_ACCEPTED',$3,$1,$4,candidate.command_id,'SUCCEEDED',200,$5::jsonb
         FROM current_resume_candidates candidate
        WHERE (SELECT schema_evidence_candidate_count FROM candidate_summary)=1
          AND NOT (SELECT schema_evidence_already_reported FROM prior_evidence)
       RETURNING audit_event_id
     )
     SELECT
       (SELECT schema_evidence_candidate_count FROM candidate_summary)
         AS schema_evidence_candidate_count,
       (SELECT schema_evidence_already_reported FROM prior_evidence)
         AS schema_evidence_already_reported,
       EXISTS (SELECT 1 FROM paired_audit) AS schema_evidence_inserted`,
    [deviceId, now, requestId, keyId, JSON.stringify(details)]
  );
  const row = result.rows[0] || {};
  if (row.schema_evidence_already_reported === true) {
    throw new DeviceBridgeProtocolError(409,
      "TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ALREADY_REPORTED",
      "Official resume schema evidence was already reported");
  }
  if (row.schema_evidence_candidate_count !== 1) {
    throw new DeviceBridgeProtocolError(409,
      "TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_NOT_AUTHORIZED",
      "Official resume schema evidence is not authorized");
  }
  if (row.schema_evidence_inserted !== true) {
    throw new DeviceBridgeProtocolError(500,
      "TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_AUDIT_FAILED",
      "Official resume schema evidence could not be accepted");
  }
}

/**
 * Optional V10 lifecycle evidence is observational only. It must never be
 * consulted by readiness, permit, expiry, or command-selection paths.
 */
export function isBoundedTinderResumedForegroundChatReturnDiagnostic(value) {
  return boundedTinderResumedForegroundChatReturnDiagnostic(value) !== null;
}

export function isExactTinderVerifiedChatReturnReadiness(value) {
  return exactKeys(value, TINDER_VERIFIED_CHAT_RETURN_READINESS_FIELDS)
    && typeof value.ready === "boolean";
}

export function isExactTinderResumedForegroundChatReturnReadiness(value) {
  return exactKeys(value, TINDER_RESUMED_FOREGROUND_CHAT_RETURN_READINESS_FIELDS)
    && typeof value.ready === "boolean";
}

function heartbeatAuditDetails(heartbeat) {
  // Defense in depth for callers that invoke the exported transaction
  // directly rather than entering through parseAndValidateHeartbeat().
  assertExactOfficialResumeSchemaEvidenceHeartbeat(heartbeat);
  const details = { sequence: heartbeat.sequence };
  if (Object.hasOwn(heartbeat, "tinder_inbox_navigation")) {
    const navigation = heartbeat.tinder_inbox_navigation;
    if (!isBoundedTinderInboxNavigationDiagnostic(navigation)) {
      throw invalidHeartbeat("Heartbeat inbox navigation diagnostic is invalid");
    }
    // Do not serialize the heartbeat object itself. This explicit allowlist
    // prevents future local diagnostics from becoming durable audit metadata.
    const boundedNavigation = {
      stage: navigation.stage,
      reason: navigation.reason,
      visible_conversation_count: navigation.visible_conversation_count,
      observed_event_count: navigation.observed_event_count
    };
    if (navigation.observation_kind === TINDER_INBOX_FRESH_REVIEWED_OBSERVATION_KIND) {
      // This is an opaque, device-generated freshness nonce. It exists only in
      // the immutable signed-heartbeat audit fact to consume a one-shot local
      // Inbox observation; it is never projected through dashboard/status APIs.
      boundedNavigation.observation_kind = TINDER_INBOX_FRESH_REVIEWED_OBSERVATION_KIND;
      boundedNavigation.observation_nonce = navigation.observation_nonce;
    }
    if (Object.hasOwn(navigation, "discovery_v16_state")) {
      // This value is admitted only by the terminal exact-pair validation
      // above. Keep the durable audit projection explicitly allowlisted so a
      // future local diagnostic cannot widen this transport surface.
      boundedNavigation.discovery_v16_state = navigation.discovery_v16_state;
    }
    details.tinder_inbox_navigation = boundedNavigation;
  }
  const sweepDiagnostic = Object.hasOwn(heartbeat, "tinder_unbound_inbox_sweep")
    ? boundedTinderUnboundInboxSweepDiagnostic(heartbeat.tinder_unbound_inbox_sweep)
    : null;
  if (sweepDiagnostic !== null) details.tinder_unbound_inbox_sweep = sweepDiagnostic;
  const officialResumeHandoff = Object.hasOwn(heartbeat, "tinder_official_resume_handoff")
    ? boundedTinderOfficialResumeHandoffDiagnostic(heartbeat.tinder_official_resume_handoff)
    : null;
  if (officialResumeHandoff !== null) {
    details.tinder_official_resume_handoff = officialResumeHandoff;
  }
  if (Object.hasOwn(heartbeat, "tinder_verified_chat_return")) {
    // Explicitly retain only the boolean current-heartbeat readiness fact.
    // No permit, command, source, binding, revision, timestamp, or Android
    // local-proof material can enter durable heartbeat audit data here.
    details.tinder_verified_chat_return = { ready: heartbeat.tinder_verified_chat_return.ready };
  }
  if (Object.hasOwn(heartbeat, "tinder_resumed_foreground_chat_return")) {
    // V10 is intentionally status-only. It records no local chat evidence,
    // identity, source, or header material in durable heartbeat audit data.
    details.tinder_resumed_foreground_chat_return = {
      ready: heartbeat.tinder_resumed_foreground_chat_return.ready
    };
  }
  const resumedForegroundReturnDiagnostic = Object.hasOwn(heartbeat,
    "tinder_resumed_foreground_chat_return_diagnostic")
    ? boundedTinderResumedForegroundChatReturnDiagnostic(
      heartbeat.tinder_resumed_foreground_chat_return_diagnostic)
    : null;
  if (resumedForegroundReturnDiagnostic !== null) {
    details.tinder_resumed_foreground_chat_return_diagnostic = resumedForegroundReturnDiagnostic;
  }
  return details;
}

function isFreshReviewedInboxObservation(heartbeat) {
  const navigation = heartbeat?.tinder_inbox_navigation;
  return isBoundedTinderInboxNavigationDiagnostic(navigation)
    && navigation.stage === "INBOX_READY"
    && navigation.reason === "NONE"
    && navigation.visible_conversation_count > 0
    && navigation.observation_kind === TINDER_INBOX_FRESH_REVIEWED_OBSERVATION_KIND
    && isUuidV4(navigation.observation_nonce);
}

/**
 * V8 is sole-issued from the same signed heartbeat transaction that captured
 * the local fresh Inbox observation. This intentionally has no public/manual
 * dashboard entrypoint and no command/status response field.
 */
async function maybeStartUnboundInboxConversationSweepFromFreshObservation(client, {
  pool, deviceId, heartbeat, now, unboundInboxConversationSweepFoundationReady,
  verifiedChatReturnPermitActive, resumedForegroundChatReturnPermitActive,
  verifiedChatReturnFoundationCanonical, resumedForegroundChatReturnFoundationCanonical
}) {
  if (!isFreshReviewedInboxObservation(heartbeat)
      || !isTinderUnboundInboxConversationSweepCapable(heartbeat.capabilities)
      // V9 is serial with V8. Its terminal state is determined under this
      // same device lock before V8 can consume a fresh Inbox observation.
      // The observation audit remains immutable, but it cannot mint an
      // undeliverable overlapping V8 child.
      || verifiedChatReturnPermitActive === true
      || resumedForegroundChatReturnPermitActive === true
      || unboundInboxConversationSweepFoundationReady !== true) {
    return;
  }
  // Dynamic import avoids a static heartbeat -> service -> heartbeat cycle;
  // it is evaluated only after this module and the signed transaction exist.
  const {
    createPgTinderUnboundInboxConversationSweepRepository,
    createTinderUnboundInboxConversationSweepService
  } = await import("../services/tinder-unbound-inbox-conversation-sweep.js");
  const service = createTinderUnboundInboxConversationSweepService(
    createPgTinderUnboundInboxConversationSweepRepository(pool),
    {
      now: () => now,
      verifiedChatReturnFoundationCanonical,
      resumedForegroundChatReturnFoundationCanonical
    }
  );
  await service.startUnboundInboxConversationSweepFromFreshInboxObservation(client, {
    deviceId,
    heartbeatSequence: heartbeat.sequence,
    inboxNavigation: heartbeat.tinder_inbox_navigation,
    observationNonce: heartbeat.tinder_inbox_navigation.observation_nonce
  });
}

// An expired V8 child is terminalized before delivery is selected.  The
// service owns the paired step/parent/audit transition; the heartbeat owns
// only the conservative response rule that prevents an older nonterminal
// command from slipping through in the same transaction.
async function expireUnboundInboxConversationSweepForHeartbeat(client, {
  pool, deviceId, now, unboundInboxConversationSweepFoundationCanonical
}) {
  if (unboundInboxConversationSweepFoundationCanonical !== true) {
    return Object.freeze({ childExpired: false, active: false });
  }
  const {
    createPgTinderUnboundInboxConversationSweepRepository,
    createTinderUnboundInboxConversationSweepService
  } = await import("../services/tinder-unbound-inbox-conversation-sweep.js");
  const service = createTinderUnboundInboxConversationSweepService(
    createPgTinderUnboundInboxConversationSweepRepository(pool),
    { now: () => now }
  );
  const result = await service.expireUnboundInboxConversationSweepForHeartbeat(client, {
    deviceId
  });
  return Object.freeze({
    childExpired: result?.childExpired === true,
    active: result?.active === true
  });
}

// V8 commands are permitted only after the exact catalog inspector accepts the
// complete direct-V6-to-V8 foundation. A pair of relations is not sufficient:
// a partial, drifted, or otherwise uninspectable foundation must not mint or
// deliver a child command. A catalog-read failure is deliberately inert rather
// than turning an ordinary heartbeat into a schema-repair path.
async function inspectUnboundInboxConversationSweepFoundationState(client, inspectFoundation) {
  try {
    const inspection = await inspectFoundation(client);
    return inspection?.state === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.CANONICAL
      ? TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.CANONICAL
      : inspection?.state === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.UPGRADE_REQUIRED
        ? TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.UPGRADE_REQUIRED
        : TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.INVALID;
  } catch {
    return TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.INVALID;
  }
}

// The V8 migration inspector deliberately remains version-exact.  Once V9
// owns the command vocabulary, a V8 child may continue only if the shared
// runtime inspector proves both the canonical V9 successor and every retained
// V6/V8 relation it still depends on. A failed catalog read remains inert.
async function inspectUnboundInboxConversationSweepRuntimeFoundationState(client, inspectFoundation, options) {
  try {
    const inspection = await inspectFoundation(client, options);
    return inspection?.state === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.CANONICAL
      ? TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.CANONICAL
      : TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.INVALID;
  } catch {
    return TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.INVALID;
  }
}

// V9 intentionally makes V8's exact vocabulary inspector report a later
// state as non-canonical.  Keep that historical inspector exact; this small
// successor classifier establishes whether the additive V9 catalog has taken
// over the V8 runtime relations without weakening either contract.
async function inspectVerifiedChatReturnFoundationState(client, inspectFoundation) {
  try {
    const inspection = await inspectFoundation(client);
    return inspection?.state === TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.CANONICAL
      ? TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.CANONICAL
      : inspection?.state === TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.UPGRADE_REQUIRED
        ? TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.UPGRADE_REQUIRED
        : TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.INVALID;
  } catch {
    return TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.INVALID;
  }
}

async function inspectResumedForegroundChatReturnFoundationState(client, inspectFoundation) {
  try {
    const inspection = await inspectFoundation(client);
    return inspection?.state === TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.CANONICAL
      ? TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.CANONICAL
      : inspection?.state === TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.UPGRADE_REQUIRED
        ? TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.UPGRADE_REQUIRED
        : TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.INVALID;
  } catch {
    return TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.INVALID;
  }
}

// An expired V9 child must become durably terminal before command selection,
// just as an expired V8 child does.  The V9 repository records an immutable,
// content-free RETURN_EXPIRED audit fact in the same locked transaction.  A
// command is deliberately withheld for this heartbeat when such a transition
// occurred, so a stale command cannot be interleaved with a fresh authority.
async function expireVerifiedChatReturnPermitForHeartbeat(client, {
  pool, deviceId, now, verifiedChatReturnFoundationCanonical
}) {
  if (verifiedChatReturnFoundationCanonical !== true) {
    return Object.freeze({ permitExpired: false, active: false });
  }
  const {
    createPgTinderVerifiedChatReturnRepository
  } = await import("../services/tinder-verified-chat-return.js");
  const repository = createPgTinderVerifiedChatReturnRepository(pool);
  const expiredCount = await repository.expireVerifiedChatReturnPermits(client, {
    deviceId,
    expiredAt: now.toISOString()
  });
  const active = await repository.findActiveVerifiedChatReturnPermitForDevice(client, {
    deviceId,
    now: now.toISOString()
  });
  return Object.freeze({
    permitExpired: Number.isSafeInteger(expiredCount) && expiredCount > 0,
    active: active === true
  });
}

// V10 is separately serial with both V8 and V9. Expire it before selection
// so an old foreground-return permission can never coexist with a new sweep
// command in the same signed heartbeat.
async function expireResumedForegroundChatReturnPermitForHeartbeat(client, {
  pool, deviceId, now, resumedForegroundChatReturnFoundationCanonical
}) {
  if (resumedForegroundChatReturnFoundationCanonical !== true) {
    return Object.freeze({ permitExpired: false, active: false });
  }
  const {
    createPgTinderResumedForegroundChatReturnRepository
  } = await import("../services/tinder-resumed-foreground-chat-return.js");
  const repository = createPgTinderResumedForegroundChatReturnRepository(pool);
  const expiredCount = await repository.expireResumedForegroundChatReturnPermits(client, {
    deviceId,
    expiredAt: now.toISOString()
  });
  const active = await repository.findActiveResumedForegroundChatReturnPermitForDevice(client, {
    deviceId,
    now: now.toISOString()
  });
  return Object.freeze({
    permitExpired: Number.isSafeInteger(expiredCount) && expiredCount > 0,
    active: active === true
  });
}

export function parseAndValidateHeartbeat(req) {
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw new DeviceBridgeProtocolError(400, "INVALID_JSON", "Heartbeat body is not valid JSON");
  }
  if (!object(body)) throw invalidHeartbeat("Heartbeat body must be an object");
  if (body.protocol_version !== 1) throw new DeviceBridgeProtocolError(400, "PROTOCOL_VERSION_MISMATCH", "Heartbeat protocol version is invalid");
  if (!Number.isSafeInteger(body.sequence) || body.sequence < 1) throw invalidHeartbeat("Heartbeat sequence is invalid");
  if (body.sent_at !== req.get("x-marcel-timestamp") || !isExactUtcTimestamp(body.sent_at)) throw invalidHeartbeat("Heartbeat sent_at is invalid");
  if (!object(body.app) || !nonEmptyString(body.app.version_name, 64) || !Number.isSafeInteger(body.app.version_code) || body.app.version_code < 0) throw invalidHeartbeat("Heartbeat app metadata is invalid");
  if (!object(body.device) || !isUuidV4(body.device.installation_id) || !nonEmptyString(body.device.manufacturer, 64) || !nonEmptyString(body.device.model, 128) || !Number.isInteger(body.device.android_api) || body.device.android_api < 24 || !Array.isArray(body.device.abis) || body.device.abis.length < 1 || body.device.abis.length > 8 || body.device.abis.some(abi => !nonEmptyString(abi, 64))) throw invalidHeartbeat("Heartbeat device metadata is invalid");
  if (!object(body.bridge) || !BRIDGE_SERVICE_STATES.includes(body.bridge.service_state) || !nullableTimestamp(body.bridge.started_at) || !nullableTimestamp(body.bridge.last_successful_heartbeat_at)) throw invalidHeartbeat("Heartbeat bridge metadata is invalid");
  if (!deviceBridgeCapabilityProfile(body.capabilities)) throw invalidHeartbeat("Heartbeat capabilities are invalid");
  if (!isKnownTinderStateForCapabilities(body.tinder_state, body.capabilities)) throw invalidHeartbeat("Heartbeat tinder_state is invalid for this capability profile");
  if (!AUTOMATION_STATES.includes(body.automation_state)) throw invalidHeartbeat("T1 automation_state must be STOPPED");
  if (Object.hasOwn(body, "tinder_inbox_navigation") && !isBoundedTinderInboxNavigationDiagnostic(body.tinder_inbox_navigation)) {
    throw invalidHeartbeat("Heartbeat inbox navigation diagnostic is invalid");
  }
  if (Object.hasOwn(body, "tinder_unbound_inbox_sweep")
      && !isBoundedTinderUnboundInboxSweepDiagnostic(body.tinder_unbound_inbox_sweep)) {
    throw invalidHeartbeat("Heartbeat unbound Inbox sweep diagnostic is invalid");
  }
  if (Object.hasOwn(body, "tinder_official_resume_handoff")
      && !isBoundedTinderOfficialResumeHandoffDiagnostic(
        body.tinder_official_resume_handoff)) {
    throw invalidHeartbeat("Heartbeat official resume handoff diagnostic is invalid");
  }
  if (Object.hasOwn(body, "tinder_official_resume_schema_evidence")
      && !isBoundedTinderOfficialResumeSchemaEvidence(
        body.tinder_official_resume_schema_evidence)) {
    throw invalidHeartbeat("Heartbeat official resume schema evidence is invalid");
  }
  // The new aggregate profile is not general Evidence-V2 transport. It may exist
  // only alongside the exact terminal post-ACK handoff fact that explains why
  // this separate, observational report was produced.
  if (Object.hasOwn(body, "tinder_official_resume_schema_evidence")
      && (!Object.hasOwn(body, "tinder_official_resume_handoff")
        || body.tinder_official_resume_handoff?.stage !== "BLOCKED"
        || body.tinder_official_resume_handoff?.reason
          !== "UNREVIEWED_OFFICIAL_SURFACE")) {
    throw invalidHeartbeat("Heartbeat official resume schema evidence lacks its terminal handoff fact");
  }
  if (Object.hasOwn(body, "tinder_verified_chat_return")
      && !isExactTinderVerifiedChatReturnReadiness(body.tinder_verified_chat_return)) {
    throw invalidHeartbeat("Heartbeat verified chat return readiness is invalid");
  }
  if (Object.hasOwn(body, "tinder_resumed_foreground_chat_return")
      && !isExactTinderResumedForegroundChatReturnReadiness(
        body.tinder_resumed_foreground_chat_return)) {
    throw invalidHeartbeat("Heartbeat resumed foreground chat return readiness is invalid");
  }
  if (Object.hasOwn(body, "tinder_resumed_foreground_chat_return_diagnostic")
      && !isBoundedTinderResumedForegroundChatReturnDiagnostic(
        body.tinder_resumed_foreground_chat_return_diagnostic)) {
    throw invalidHeartbeat("Heartbeat resumed foreground chat return diagnostic is invalid");
  }
  if (body.tinder_verified_chat_return?.ready === true
      && body.tinder_resumed_foreground_chat_return?.ready === true) {
    throw invalidHeartbeat("Heartbeat cannot assert both verified and resumed foreground chat return readiness");
  }
  return body;
}

export function deriveDeviceStatus(lastAcceptedHeartbeatAt, now = new Date()) {
  if (!lastAcceptedHeartbeatAt) return "OFFLINE";
  const age = now.valueOf() - new Date(lastAcceptedHeartbeatAt).valueOf();
  return age >= 0 && age <= DEVICE_BRIDGE_PROTOCOL.offlineAfterSeconds * 1000 ? "ONLINE" : "OFFLINE";
}

function commandEnvelope(row, payload = row.payload) {
  return {
    command_id: row.command_id,
    protocol_version: row.protocol_version,
    type: row.command_type,
    issued_at: new Date(row.issued_at).toISOString(),
    expires_at: new Date(row.expires_at).toISOString(),
    configuration_revision: row.configuration_revision,
    payload
  };
}

async function selectDeliverableCommands(client, deviceId, capabilities, now, {
  unboundInboxConversationSweepFoundationReady = false,
  verifiedChatReturnFoundationReady = false,
  // V9 has a separate V3-current-chat readiness contract.  Foundation
  // canonicality alone is intentionally insufficient: until the exact
  // cross-side readiness proof is supplied, a queued return remains inert.
  verifiedChatReturnDeliveryReady = false,
  verifiedChatReturnActive = false,
  resumedForegroundChatReturnFoundationReady = false,
  resumedForegroundChatReturnDeliveryReady = false,
  resumedForegroundChatReturnActive = false,
  suppressDynamicTinderCommands = false
} = {}) {
  const t1Capable = isTinderManualGateCapable(capabilities);
  const humanArmedBindingCapable = isTinderHumanArmedConversationBindingCapable(capabilities);
  const t5Capable = isTinderManualSendCapable(capabilities);
  const visibleChatSyncCapable = isTinderVisibleChatSyncCapable(capabilities);
  const officialAppResumeCapable = isTinderOfficialAppResumeCapable(capabilities);
  const advertisedPostChatLocalConversationAttestationCapability =
    isTinderLocalConversationAttestationPostChatCapable(capabilities);
  const advertisedUnboundInboxConversationSweepCapability =
    isTinderUnboundInboxConversationSweepCapable(capabilities);
  const advertisedVerifiedChatReturnCapability =
    isTinderVerifiedChatReturnCapable(capabilities);
  const advertisedResumedForegroundChatReturnCapability =
    isTinderResumedForegroundChatReturnCapable(capabilities);
  // A newer device can heartbeat during a rolling backend deployment. Do not
  // turn a schema-absent V6 foundation into a heartbeat 42P01: omit only the
  // new local-proof commands until the migration has made their table real.
  // Existing T4-resume/read-only commands retain their normal profile path.
  let postChatLocalConversationAttestationCapable = false;
  if (advertisedPostChatLocalConversationAttestationCapability) {
    const foundation = await client.query(
      "SELECT to_regclass('tinder_local_conversation_attestation_permits') AS relation_name"
    );
    postChatLocalConversationAttestationCapable = Boolean(foundation.rows[0]?.relation_name);
  }
  const unboundInboxConversationSweepCapable = advertisedUnboundInboxConversationSweepCapability
    && unboundInboxConversationSweepFoundationReady === true;
  const verifiedChatReturnCapable = advertisedVerifiedChatReturnCapability
    && verifiedChatReturnFoundationReady === true;
  const verifiedChatReturnDeliverable = verifiedChatReturnCapable
    && verifiedChatReturnDeliveryReady === true;
  const resumedForegroundChatReturnCapable =
    advertisedResumedForegroundChatReturnCapability
    && resumedForegroundChatReturnFoundationReady === true;
  const resumedForegroundChatReturnDeliverable =
    resumedForegroundChatReturnCapable
    && resumedForegroundChatReturnDeliveryReady === true;
  // A device that advertises V8 while its catalog is partial or unknown may
  // have a previously active V8 child we cannot inspect safely.  Do not fall
  // back to delivery of a pre-V8 dynamic Tinder command in that ambiguous
  // state. Administrative/status commands remain available.
  const commandTypes = suppressDynamicTinderCommands
    ? "'PING','REQUEST_STATUS','STOP_BRIDGE'"
    : resumedForegroundChatReturnDeliverable
    ? "'PING','REQUEST_STATUS','STOP_BRIDGE','CONNECT_TINDER','DISCONNECT_TINDER','ARM_TINDER_CONVERSATION_BINDING','SYNC_TINDER_VISIBLE_CHAT','RESUME_OFFICIAL_TINDER_APP','STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION','READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT','RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT','RETURN_TINDER_VERIFIED_CHAT_TO_INBOX','RETURN_TINDER_RESUMED_FOREGROUND_CHAT_TO_INBOX'"
    : verifiedChatReturnDeliverable
    ? "'PING','REQUEST_STATUS','STOP_BRIDGE','CONNECT_TINDER','DISCONNECT_TINDER','ARM_TINDER_CONVERSATION_BINDING','SYNC_TINDER_VISIBLE_CHAT','RESUME_OFFICIAL_TINDER_APP','STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION','READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT','RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT','RETURN_TINDER_VERIFIED_CHAT_TO_INBOX'"
    : unboundInboxConversationSweepCapable
    ? "'PING','REQUEST_STATUS','STOP_BRIDGE','CONNECT_TINDER','DISCONNECT_TINDER','ARM_TINDER_CONVERSATION_BINDING','SYNC_TINDER_VISIBLE_CHAT','RESUME_OFFICIAL_TINDER_APP','STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION','READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT','RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT'"
    : postChatLocalConversationAttestationCapable
    ? "'PING','REQUEST_STATUS','STOP_BRIDGE','CONNECT_TINDER','DISCONNECT_TINDER','ARM_TINDER_CONVERSATION_BINDING','SYNC_TINDER_VISIBLE_CHAT','RESUME_OFFICIAL_TINDER_APP','STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION'"
    : officialAppResumeCapable
    ? "'PING','REQUEST_STATUS','STOP_BRIDGE','CONNECT_TINDER','DISCONNECT_TINDER','ARM_TINDER_CONVERSATION_BINDING','SYNC_TINDER_VISIBLE_CHAT','RESUME_OFFICIAL_TINDER_APP'"
    : visibleChatSyncCapable
    ? "'PING','REQUEST_STATUS','STOP_BRIDGE','CONNECT_TINDER','DISCONNECT_TINDER','ARM_TINDER_CONVERSATION_BINDING','SYNC_TINDER_VISIBLE_CHAT'"
    : t5Capable
    ? "'PING','REQUEST_STATUS','STOP_BRIDGE','CONNECT_TINDER','DISCONNECT_TINDER','ARM_TINDER_CONVERSATION_BINDING','SEND_TINDER_DRAFT'"
    : humanArmedBindingCapable
    ? "'PING','REQUEST_STATUS','STOP_BRIDGE','CONNECT_TINDER','DISCONNECT_TINDER','ARM_TINDER_CONVERSATION_BINDING'"
    : t1Capable
    ? "'PING','REQUEST_STATUS','STOP_BRIDGE','CONNECT_TINDER','DISCONNECT_TINDER'"
    : "'PING','REQUEST_STATUS','STOP_BRIDGE'";
  const payloadPredicate = (resumedForegroundChatReturnDeliverable || verifiedChatReturnDeliverable)
    ? `
         OR (command_type IN ('CONNECT_TINDER','DISCONNECT_TINDER','ARM_TINDER_CONVERSATION_BINDING','RESUME_OFFICIAL_TINDER_APP','${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE}','${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE}','${TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE}','${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE}') AND payload='{}'::jsonb)
         OR (
           command_type='SYNC_TINDER_VISIBLE_CHAT'
           AND jsonb_typeof(payload)='object'
           AND payload ? 'local_conversation_attestation'
           AND payload ? 'binding_revision'
           AND (payload - 'local_conversation_attestation' - 'binding_revision')='{}'::jsonb
           AND payload->>'local_conversation_attestation' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           AND payload->>'binding_revision' ~ '^[1-9][0-9]*$'
         )
         OR (
           command_type='${TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE}'
           AND jsonb_typeof(payload)='object'
           AND payload ? 'binding_revision'
           AND payload ? 'attestation_contract_version'
           AND (payload - 'binding_revision' - 'attestation_contract_version')='{}'::jsonb
           AND payload->>'binding_revision' ~ '^[1-9][0-9]*$'
           AND payload->>'attestation_contract_version'='${TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_VERSION}'
         )`
    : unboundInboxConversationSweepCapable
    ? `
         OR (command_type IN ('CONNECT_TINDER','DISCONNECT_TINDER','ARM_TINDER_CONVERSATION_BINDING','RESUME_OFFICIAL_TINDER_APP','${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE}','${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE}') AND payload='{}'::jsonb)
         OR (
           command_type='SYNC_TINDER_VISIBLE_CHAT'
           AND jsonb_typeof(payload)='object'
           AND payload ? 'local_conversation_attestation'
           AND payload ? 'binding_revision'
           AND (payload - 'local_conversation_attestation' - 'binding_revision')='{}'::jsonb
           AND payload->>'local_conversation_attestation' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           AND payload->>'binding_revision' ~ '^[1-9][0-9]*$'
         )
         OR (
           command_type='${TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE}'
           AND jsonb_typeof(payload)='object'
           AND payload ? 'binding_revision'
           AND payload ? 'attestation_contract_version'
           AND (payload - 'binding_revision' - 'attestation_contract_version')='{}'::jsonb
           AND payload->>'binding_revision' ~ '^[1-9][0-9]*$'
           AND payload->>'attestation_contract_version'='${TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_VERSION}'
         )`
    : postChatLocalConversationAttestationCapable
    ? `
         OR (command_type IN ('CONNECT_TINDER','DISCONNECT_TINDER','ARM_TINDER_CONVERSATION_BINDING','RESUME_OFFICIAL_TINDER_APP') AND payload='{}'::jsonb)
         OR (
           command_type='SYNC_TINDER_VISIBLE_CHAT'
           AND jsonb_typeof(payload)='object'
           AND payload ? 'local_conversation_attestation'
           AND payload ? 'binding_revision'
           AND (payload - 'local_conversation_attestation' - 'binding_revision')='{}'::jsonb
           AND payload->>'local_conversation_attestation' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           AND payload->>'binding_revision' ~ '^[1-9][0-9]*$'
         )
         OR (
           command_type='${TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE}'
           AND jsonb_typeof(payload)='object'
           AND payload ? 'binding_revision'
           AND payload ? 'attestation_contract_version'
           AND (payload - 'binding_revision' - 'attestation_contract_version')='{}'::jsonb
           AND payload->>'binding_revision' ~ '^[1-9][0-9]*$'
           AND payload->>'attestation_contract_version'='${TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_VERSION}'
         )`
    : officialAppResumeCapable
    ? `
         OR (command_type IN ('CONNECT_TINDER','DISCONNECT_TINDER','ARM_TINDER_CONVERSATION_BINDING','SYNC_TINDER_VISIBLE_CHAT','RESUME_OFFICIAL_TINDER_APP') AND payload='{}'::jsonb)`
    : visibleChatSyncCapable
    ? `
         OR (command_type IN ('CONNECT_TINDER','DISCONNECT_TINDER','ARM_TINDER_CONVERSATION_BINDING','SYNC_TINDER_VISIBLE_CHAT') AND payload='{}'::jsonb)`
    : t5Capable
    ? `
         OR (command_type IN ('CONNECT_TINDER','DISCONNECT_TINDER','ARM_TINDER_CONVERSATION_BINDING') AND payload='{}'::jsonb)
         OR command_type='SEND_TINDER_DRAFT'`
    : humanArmedBindingCapable
    ? `
         OR (command_type IN ('CONNECT_TINDER','DISCONNECT_TINDER','ARM_TINDER_CONVERSATION_BINDING') AND payload='{}'::jsonb)`
    : t1Capable
    ? `
         OR (command_type IN ('CONNECT_TINDER','DISCONNECT_TINDER') AND payload='{}'::jsonb)`
    : "";
  const officialAppResumeDeliveryPredicate = officialAppResumeCapable
    ? `
       AND (
         command_type <> '${TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE}'
         OR EXISTS (
           SELECT 1
             FROM tinder_official_app_resume_permits resume_permit
            WHERE resume_permit.command_id=device_bridge_commands.command_id
              AND resume_permit.device_id=device_bridge_commands.device_id
              AND resume_permit.permit_state='ISSUED'
              AND resume_permit.expires_at>$2
              -- V1 rows have no V2 snapshot keys and retain their historic
              -- delivery semantics. The JSON row projection makes this safe before the
              -- V2 columns exist, while V2 fails closed on any mismatch.
              AND (
                COALESCE(to_jsonb(resume_permit)->>'permit_contract_version', '1') = '1'
                OR (
                  to_jsonb(resume_permit)->>'permit_contract_version' = '2'
                  AND EXISTS (
                    SELECT 1
                      FROM contact_human_armed_conversation_bindings binding
                      JOIN contact_human_armed_conversation_binding_permits binding_permit
                        ON binding_permit.binding_id=binding.binding_id
                      JOIN tinder_visible_chat_captures source_capture
                        ON source_capture.capture_id=binding_permit.consumed_capture_id
                     WHERE binding.binding_id::text=to_jsonb(resume_permit)->>'binding_id'
                       AND binding.binding_revision::text=to_jsonb(resume_permit)->>'binding_revision'
                       AND binding.device_id=resume_permit.device_id
                       AND binding.channel='tinder'
                       AND binding.reference_kind='${TINDER_HUMAN_ARMED_CONVERSATION_REFERENCE_KIND}'
                       AND binding.binding_state='CONFIRMED'
                       AND binding.human_verified=TRUE
                       AND binding_permit.device_id=binding.device_id
                       AND binding_permit.binding_revision=binding.binding_revision
                       AND binding_permit.permit_state='CONSUMED'
                       AND binding_permit.consumed_capture_id=resume_permit.source_capture_id
                       AND source_capture.device_id=binding.device_id
                       AND source_capture.source_package='com.tinder'
                       AND source_capture.capture_safety_status='SAFE'
                       AND source_capture.mapping_status='RESOLVED'
                       AND source_capture.human_review_status='CONFIRMED'
                       AND source_capture.resolved_contact_id=binding.contact_id
                       AND source_capture.capture_revision = (
                         SELECT MAX(newer.capture_revision)
                           FROM tinder_visible_chat_captures newer
                          WHERE newer.device_id=source_capture.device_id
                            AND newer.runtime_thread_fingerprint=source_capture.runtime_thread_fingerprint
                       )
                  )
                )
              )
         )
       )`
    : "";
  const localConversationAttestationDeliveryPredicate = postChatLocalConversationAttestationCapable
    ? `
        AND (
          command_type <> '${TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE}'
          OR EXISTS (
            SELECT 1
              FROM ${TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE} attestation_permit
              JOIN contact_human_armed_conversation_bindings binding
                ON binding.binding_id=attestation_permit.binding_id
             WHERE attestation_permit.command_id=device_bridge_commands.command_id
               AND attestation_permit.device_id=device_bridge_commands.device_id
               AND attestation_permit.permit_contract_version=1
               AND attestation_permit.permit_state='ISSUED'
               AND attestation_permit.expires_at>$2
               AND binding.device_id=attestation_permit.device_id
               AND binding.binding_revision=attestation_permit.binding_revision
               AND binding.channel='tinder'
               AND binding.reference_kind='${TINDER_HUMAN_ARMED_CONVERSATION_REFERENCE_KIND}'
               AND binding.binding_state='CONFIRMED'
               AND binding.human_verified=TRUE
               AND device_bridge_commands.payload=jsonb_build_object(
                 'binding_revision', attestation_permit.binding_revision::text,
                 'attestation_contract_version', '${TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_VERSION}'
               )
          )
        )
        AND (
          command_type <> 'SYNC_TINDER_VISIBLE_CHAT'
          OR EXISTS (
            SELECT 1
              FROM ${TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE} sync_permit
              JOIN ${TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE} attestation_permit
                ON attestation_permit.command_id=sync_permit.attestation_command_id
              -- The FK proves only that a command-shaped row exists.  The
              -- delivery gate must also prove it is the dedicated bootstrap
              -- command before Android observes a reader command.
              JOIN device_bridge_commands attestation_command
                ON attestation_command.command_id=attestation_permit.command_id
              JOIN contact_human_armed_conversation_bindings binding
                ON binding.binding_id=sync_permit.binding_id
              JOIN contact_human_armed_conversation_binding_permits binding_permit
                ON binding_permit.binding_id=binding.binding_id
              JOIN tinder_visible_chat_captures source_capture
                ON source_capture.capture_id=binding_permit.consumed_capture_id
             WHERE sync_permit.command_id=device_bridge_commands.command_id
               AND sync_permit.device_id=device_bridge_commands.device_id
               AND sync_permit.permit_contract_version=2
               AND sync_permit.permit_state='ISSUED'
               AND sync_permit.expires_at>$2
               AND attestation_permit.device_id=sync_permit.device_id
               AND attestation_permit.binding_id=sync_permit.binding_id
               AND attestation_permit.binding_revision=sync_permit.binding_revision
               AND attestation_permit.permit_contract_version=1
               AND attestation_permit.permit_state='ATTESTED'
               AND attestation_permit.expires_at>$2
               AND attestation_command.command_type='${TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE}'
               AND attestation_command.payload=jsonb_build_object(
                 'binding_revision', attestation_permit.binding_revision::text,
                 'attestation_contract_version', '${TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_VERSION}'
               )
               AND binding.device_id=sync_permit.device_id
               AND binding.binding_revision=sync_permit.binding_revision
               AND binding.channel='tinder'
               AND binding.reference_kind='${TINDER_HUMAN_ARMED_CONVERSATION_REFERENCE_KIND}'
               AND binding.binding_state='CONFIRMED'
               AND binding.human_verified=TRUE
               AND binding_permit.device_id=binding.device_id
               AND binding_permit.binding_revision=binding.binding_revision
               AND binding_permit.permit_state='CONSUMED'
               AND binding_permit.consumed_capture_id=sync_permit.source_capture_id
               AND source_capture.device_id=binding.device_id
               AND source_capture.source_package='com.tinder'
               AND source_capture.capture_safety_status='SAFE'
               AND source_capture.mapping_status='RESOLVED'
               AND source_capture.human_review_status='CONFIRMED'
               AND source_capture.resolved_contact_id=binding.contact_id
               AND source_capture.capture_revision = (
                 SELECT MAX(newer.capture_revision)
                   FROM tinder_visible_chat_captures newer
                  WHERE newer.device_id=source_capture.device_id
                    AND newer.runtime_thread_fingerprint=source_capture.runtime_thread_fingerprint
               )
               AND device_bridge_commands.payload=jsonb_build_object(
                 'local_conversation_attestation', sync_permit.attestation_command_id::text,
                 'binding_revision', sync_permit.binding_revision::text
               )
          )
        )`
    : "";
  const unboundInboxConversationSweepDeliveryPredicate = unboundInboxConversationSweepCapable
    ? `
        AND (
          command_type NOT IN ('${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE}','${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE}')
          OR EXISTS (
            SELECT 1
              FROM ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE} step
              JOIN ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE} sweep
                ON sweep.sweep_id=step.sweep_id
             WHERE step.command_id=device_bridge_commands.command_id
               AND step.device_id=device_bridge_commands.device_id
               AND step.child_state='ISSUED'
               AND step.expires_at>$2
               AND sweep.device_id=step.device_id
               AND sweep.sweep_state='ACTIVE'
               AND sweep.active_command_id=step.command_id
               AND sweep.expires_at>$2
               AND (
                 (step.child_kind='READ' AND device_bridge_commands.command_type='${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE}')
                 OR (step.child_kind='RETURN_ONLY' AND device_bridge_commands.command_type='${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE}')
               )
               AND device_bridge_commands.payload='{}'::jsonb
          )
        )`
    : "";
  // A V8 parent has exactly one active child. If a stale pre-V8 command is
  // still nonterminal in the command table, never batch it beside that child:
  // only the exact current V8 READ/RETURN command may reach Android. This is
  // a delivery backstop; reciprocal issuer checks prevent new overlaps.
  const unboundInboxConversationSweepExclusiveDeliveryPredicate = unboundInboxConversationSweepCapable
    ? `
        AND (
          NOT EXISTS (
            SELECT 1
              FROM ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE} active_sweep
              JOIN ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE} active_step
                ON active_step.sweep_id=active_sweep.sweep_id
               AND active_step.device_id=active_sweep.device_id
             WHERE active_sweep.device_id=$1
               AND active_sweep.sweep_state='ACTIVE'
               AND active_sweep.expires_at>$2
               AND active_sweep.active_command_id=active_step.command_id
               AND active_step.child_state IN ('ISSUED','STAGED','RETURN_STAGED')
               AND active_step.expires_at>$2
          )
          OR command_type IN ('${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE}','${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE}')
        )`
    : "";
  // V10 is an identity-free post-Resume return. Its single current-heartbeat
  // readiness bit permits delivery only after Android has separately proved
  // the foreground structure; every durable Resume/permit fact is still
  // revalidated under this same device lock.
  const resumedForegroundChatReturnDeliveryPredicate = resumedForegroundChatReturnDeliverable
    ? `
        AND (
          command_type <> '${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE}'
          OR EXISTS (
            SELECT 1
              FROM ${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE} return_permit
              JOIN tinder_official_app_resume_permits resume_permit
                ON resume_permit.command_id=return_permit.resume_command_id
              JOIN device_bridge_commands resume_command
                ON resume_command.command_id=resume_permit.command_id
             WHERE return_permit.command_id=device_bridge_commands.command_id
               AND return_permit.device_id=device_bridge_commands.device_id
               AND return_permit.permit_contract_version=1
               AND return_permit.permit_state='ISSUED'
               AND return_permit.expires_at>$2
               AND device_bridge_commands.payload='{}'::jsonb
               AND resume_permit.device_id=return_permit.device_id
               AND resume_permit.permit_contract_version=2
               AND resume_permit.permit_state='DISPATCHED'
               AND resume_permit.expires_at>$2
               AND resume_command.device_id=resume_permit.device_id
               AND resume_command.command_type='${TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE}'
               AND resume_command.terminal_status='SUCCEEDED'
               AND resume_command.payload='{}'::jsonb
          )
        )`
    : "";
  const resumedForegroundChatReturnExclusiveDeliveryPredicate =
    resumedForegroundChatReturnActive
      ? ` AND command_type='${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE}'`
      : "";

  // V9 is a distinct post-Resume navigation authority.  The command body is
  // permanently `{}`; all target scope remains in the locked permit and is
  // revalidated immediately before Android can observe the command.
  const verifiedChatReturnDeliveryPredicate = verifiedChatReturnDeliverable
    ? `
        AND (
          command_type <> '${TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE}'
          OR EXISTS (
            SELECT 1
              FROM ${TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE} return_permit
              JOIN tinder_official_app_resume_permits resume_permit
                ON resume_permit.command_id=return_permit.resume_command_id
              JOIN device_bridge_commands resume_command
                ON resume_command.command_id=resume_permit.command_id
              JOIN contact_human_armed_conversation_bindings binding
                ON binding.binding_id=return_permit.binding_id
              JOIN contact_human_armed_conversation_binding_permits binding_permit
                ON binding_permit.binding_id=binding.binding_id
              JOIN tinder_visible_chat_captures source_capture
                ON source_capture.capture_id=return_permit.source_capture_id
             WHERE return_permit.command_id=device_bridge_commands.command_id
               AND return_permit.device_id=device_bridge_commands.device_id
               AND return_permit.permit_contract_version=1
               AND return_permit.permit_state='ISSUED'
               AND return_permit.expires_at>$2
               AND device_bridge_commands.payload='{}'::jsonb
               AND resume_permit.device_id=return_permit.device_id
               AND resume_permit.source_capture_id=return_permit.source_capture_id
               AND resume_permit.binding_id=return_permit.binding_id
               AND resume_permit.binding_revision=return_permit.binding_revision
               AND resume_permit.permit_contract_version=2
               AND resume_permit.permit_state='DISPATCHED'
               AND resume_permit.expires_at>$2
               AND resume_command.device_id=resume_permit.device_id
               AND resume_command.command_type='${TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE}'
               AND resume_command.terminal_status='SUCCEEDED'
               AND resume_command.payload='{}'::jsonb
               AND binding.device_id=return_permit.device_id
               AND binding.binding_revision=return_permit.binding_revision
               AND binding.channel='tinder'
               AND binding.reference_kind='${TINDER_HUMAN_ARMED_CONVERSATION_REFERENCE_KIND}'
               AND binding.binding_state='CONFIRMED'
               AND binding.human_verified=TRUE
               AND binding_permit.device_id=binding.device_id
               AND binding_permit.binding_revision=binding.binding_revision
               AND binding_permit.permit_state='CONSUMED'
               AND binding_permit.consumed_capture_id=return_permit.source_capture_id
               AND source_capture.device_id=binding.device_id
               AND source_capture.source_package='com.tinder'
               AND source_capture.capture_safety_status='SAFE'
               AND source_capture.mapping_status='RESOLVED'
               AND source_capture.human_review_status='CONFIRMED'
               AND source_capture.resolved_contact_id=binding.contact_id
               AND source_capture.capture_revision=(
                 SELECT MAX(newer.capture_revision)
                   FROM tinder_visible_chat_captures newer
                  WHERE newer.device_id=source_capture.device_id
                    AND newer.runtime_thread_fingerprint=source_capture.runtime_thread_fingerprint
               )
          )
        )`
    : "";
  // While V9 is live (including after its command was STAGED), no unrelated
  // dynamic Tinder command may be batched beside it.  Its own command is the
  // sole exception; terminal commands disappear via the base query.
  const verifiedChatReturnExclusiveDeliveryPredicate = verifiedChatReturnActive
    ? ` AND command_type='${TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE}'`
    : "";
  const result = await client.query(
    `SELECT command_id, protocol_version, command_type, issued_at, expires_at,
            configuration_revision, payload
     FROM device_bridge_commands
     WHERE device_id=$1 AND terminal_status IS NULL AND expires_at>$2
       AND command_type IN (${commandTypes})
       AND (
         (command_type IN ('PING','REQUEST_STATUS') AND payload='{}'::jsonb)
         OR (command_type='STOP_BRIDGE' AND payload='{"reason":"ADMIN_REQUEST"}'::jsonb)
         ${payloadPredicate}
        )
        ${officialAppResumeDeliveryPredicate}
        ${localConversationAttestationDeliveryPredicate}
        ${unboundInboxConversationSweepDeliveryPredicate}
        ${unboundInboxConversationSweepExclusiveDeliveryPredicate}
        ${resumedForegroundChatReturnDeliveryPredicate}
        ${resumedForegroundChatReturnExclusiveDeliveryPredicate}
        ${verifiedChatReturnDeliveryPredicate}
        ${verifiedChatReturnExclusiveDeliveryPredicate}
     ORDER BY issued_at ASC, command_id ASC
     LIMIT $3`,
    [deviceId, now, DEVICE_BRIDGE_PROTOCOL.commandBatchLimit]
  );
  const commands = [];
  for (const row of result.rows) {
    if (row.command_type !== TINDER_SEND_COMMAND_TYPE) {
      commands.push(commandEnvelope(row));
      continue;
    }
    if (!t5Capable || row.protocol_version !== DEVICE_BRIDGE_PROTOCOL.version) continue;

    // The durable T5 payload is intentionally descriptor-only.  The exact
    // text-bearing envelope exists only in this authenticated heartbeat
    // transaction after the source rows were locked and revalidated.  Drift
    // is a silent fail-closed omission: no command, audit, status, or retry
    // write is created by this delivery decision.
    const payload = await hydrateTinderManualSendCommandForHeartbeat(client, {
      commandId: row.command_id,
      deviceId,
      now
    });
    if (payload) commands.push(commandEnvelope(row, payload));
  }
  return commands;
}

function heartbeatResponse(serverTime, acceptedAt, commands) {
  return {
    ok: true,
    protocol_version: 1,
    server_time: serverTime.toISOString(),
    accepted_at: acceptedAt.toISOString(),
    configuration: {
      heartbeat_interval_seconds: 30,
      offline_after_seconds: 90,
      signature_window_seconds: 300,
      configuration_revision: 1
    },
    device_directive: "CONTINUE",
    commands
  };
}

export async function processHeartbeatTransaction(pool, auth, heartbeat, now = new Date(), {
  inspectUnboundInboxConversationSweepFoundation = inspectTinderUnboundInboxConversationSweepSchema,
  inspectUnboundInboxConversationSweepRuntimeFoundation = inspectTinderUnboundInboxConversationSweepRuntimeSchema,
  inspectVerifiedChatReturnFoundation = inspectTinderVerifiedChatReturnSchema,
  inspectResumedForegroundChatReturnFoundation =
    inspectTinderResumedForegroundChatReturnSchema
} = {}) {
  if (typeof inspectUnboundInboxConversationSweepFoundation !== "function") {
    throw new TypeError("inspectUnboundInboxConversationSweepFoundation must be a function");
  }
  if (typeof inspectUnboundInboxConversationSweepRuntimeFoundation !== "function") {
    throw new TypeError("inspectUnboundInboxConversationSweepRuntimeFoundation must be a function");
  }
  if (typeof inspectVerifiedChatReturnFoundation !== "function") {
    throw new TypeError("inspectVerifiedChatReturnFoundation must be a function");
  }
  if (typeof inspectResumedForegroundChatReturnFoundation !== "function") {
    throw new TypeError("inspectResumedForegroundChatReturnFoundation must be a function");
  }
  // The HTTP route parses first, but this exported transaction is also used
  // by trusted internal callers and tests.  Do not let such a caller persist
  // a profile without its exact terminal companion fact.
  assertExactOfficialResumeSchemaEvidenceHeartbeat(heartbeat);
  const hasOfficialResumeSchemaEvidence = Object.hasOwn(heartbeat || {},
    "tinder_official_resume_schema_evidence");
  const client = await pool.connect();
  let failureStage = "BEGIN";
  try {
    await client.query("BEGIN");
    failureStage = "DEVICE_LOCK";
    const locked = await client.query(
      `SELECT d.device_id, d.installation_id, d.enrollment_state, d.revoked_at,
              d.last_heartbeat_sequence, d.last_heartbeat_body_sha256, d.last_accepted_heartbeat_at,
              k.key_id, k.revoked_at AS key_revoked_at
       FROM device_bridge_devices d
       JOIN device_bridge_keys k ON k.device_id=d.device_id AND k.key_id=$2
       WHERE d.device_id=$1 FOR UPDATE OF d, k`,
      [auth.deviceId, auth.keyId]
    );
    const device = locked.rows[0];
    if (!device || device.enrollment_state === "REVOKED" || device.revoked_at) {
      throw new DeviceBridgeProtocolError(403, "DEVICE_REVOKED", "Device heartbeat is not authorized");
    }
    if (device.enrollment_state !== "ACTIVE") throw new DeviceBridgeProtocolError(410, "RE_ENROLL_REQUIRED", "Device must enroll again");
    if (device.key_revoked_at) throw new DeviceBridgeProtocolError(403, "KEY_REVOKED", "Device heartbeat is not authorized");
    if (device.installation_id !== heartbeat.device.installation_id) {
      throw new DeviceBridgeProtocolError(409, "DEVICE_ID_MISMATCH", "Installation identifier does not match device");
    }
    failureStage = "REQUEST_REPLAY";
    await registerAuthenticatedRequestReplay(client, auth, now);

    const previousSequence = device.last_heartbeat_sequence === null ? null : Number(device.last_heartbeat_sequence);
    const idempotent = previousSequence !== null && heartbeat.sequence === previousSequence && device.last_heartbeat_body_sha256 === auth.contentSha256;
    if (previousSequence !== null && (heartbeat.sequence < previousSequence || (heartbeat.sequence === previousSequence && !idempotent))) {
      throw new DeviceBridgeProtocolError(409, "HEARTBEAT_SEQUENCE_CONFLICT", "Heartbeat sequence conflicts with the last accepted heartbeat");
    }

    if (hasOfficialResumeSchemaEvidence) {
      // The profile is the one expressly authorized diagnostic heartbeat. It
      // has no action authority: do not inspect/mint/expire a child, select
      // any command, or even deliver administrative commands in this branch.
      // The locked device row serializes the exact command-paired audit gate.
      if (!idempotent) {
        failureStage = "SCHEMA_EVIDENCE_AUTHORIZATION";
        if (!isTinderOfficialAppResumeCapable(heartbeat.capabilities)) {
          throw new DeviceBridgeProtocolError(409,
            "TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_NOT_AUTHORIZED",
            "Official resume schema evidence is not authorized");
        }
      }
      let acceptedAt = now;
      if (!idempotent) {
        failureStage = "DEVICE_UPDATE";
        await client.query(
          `UPDATE device_bridge_devices SET
            app_version_name=$2, app_version_code=$3, manufacturer=$4, model=$5,
            android_api=$6, abis=$7::jsonb, capabilities=$8::jsonb,
            bridge_service_state=$9, tinder_state=$10, automation_state='STOPPED',
            last_heartbeat_sequence=$11, last_heartbeat_body_sha256=$12,
            last_accepted_heartbeat_at=$13, updated_at=$13
           WHERE device_id=$1`,
          [auth.deviceId, heartbeat.app.version_name, heartbeat.app.version_code,
            heartbeat.device.manufacturer, heartbeat.device.model, heartbeat.device.android_api,
            JSON.stringify(heartbeat.device.abis), JSON.stringify(heartbeat.capabilities),
            heartbeat.bridge.service_state, heartbeat.tinder_state, heartbeat.sequence,
            auth.contentSha256, now]
        );
        failureStage = "SCHEMA_EVIDENCE_AUTHORIZATION";
        try {
          await persistOfficialResumeSchemaEvidenceAudit(client, { auth, heartbeat, now });
        } catch (error) {
          failureStage = isOfficialResumeSchemaEvidenceAuthorizationError(error)
            ? "SCHEMA_EVIDENCE_AUTHORIZATION"
            : "SCHEMA_EVIDENCE_AUDIT";
          throw error;
        }
      } else {
        acceptedAt = new Date(device.last_accepted_heartbeat_at);
      }
      failureStage = "COMMIT";
      await client.query("COMMIT");
      return heartbeatResponse(now, acceptedAt, []);
    }

    failureStage = "V8_FOUNDATION";
    const unboundInboxConversationSweepFoundationState =
      await inspectUnboundInboxConversationSweepFoundationState(
        client,
        inspectUnboundInboxConversationSweepFoundation
      );
    failureStage = "V9_FOUNDATION";
    const verifiedChatReturnFoundationState =
      await inspectVerifiedChatReturnFoundationState(client, inspectVerifiedChatReturnFoundation);
    failureStage = "V10_FOUNDATION";
    const resumedForegroundChatReturnFoundationState =
      await inspectResumedForegroundChatReturnFoundationState(
        client,
        inspectResumedForegroundChatReturnFoundation
      );
    // Reuse the exact catalog conclusions already read for this signed
    // heartbeat. Only the V9-successor case needs retained V6/V8 catalog
    // proofs; a direct V8 foundation is already a complete proof.
    let unboundInboxConversationSweepRuntimeFoundationState =
      TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.INVALID;
    if (unboundInboxConversationSweepFoundationState
        === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.CANONICAL) {
      unboundInboxConversationSweepRuntimeFoundationState =
        TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.CANONICAL;
    } else if (verifiedChatReturnFoundationState
          === TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.CANONICAL
        || resumedForegroundChatReturnFoundationState
          === TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.CANONICAL) {
      failureStage = "V8_RUNTIME_FOUNDATION";
      unboundInboxConversationSweepRuntimeFoundationState =
        await inspectUnboundInboxConversationSweepRuntimeFoundationState(
          client,
          inspectUnboundInboxConversationSweepRuntimeFoundation,
          {
            // The shared runtime inspector will only inspect retained V6/V8
            // catalog facts after these exact already-read predecessor and
            // successor results agree with their exact compatibility branch.
            inspectV8Schema: async () => ({ state: unboundInboxConversationSweepFoundationState }),
            inspectV9Schema: async () => ({ state: verifiedChatReturnFoundationState }),
            inspectV10Schema: async () => ({
              state: resumedForegroundChatReturnFoundationState
            })
          }
        );
    }
    // V8's own exact inspector deliberately becomes INVALID after the V9
    // command-constraint successor.  V9 alone is not enough: the shared
    // runtime inspector independently proves retained V6/V8 relations before
    // a V8 child may be minted, expired, delivered, acknowledged, or ingested.
    const verifiedChatReturnFoundationCanonical =
      verifiedChatReturnFoundationState === TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.CANONICAL;
    const resumedForegroundChatReturnFoundationCanonical =
      resumedForegroundChatReturnFoundationState
      === TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.CANONICAL;
    // `UPGRADE_REQUIRED` is the one known pre-V9 catalog: the exact V8
    // inspector is still authoritative there. Any other V9 result means a
    // partially present or drifted successor and must not mint a new V8
    // authority merely because the retained V8 relations happen to inspect.
    const verifiedChatReturnFoundationAllowsV8Runtime =
      verifiedChatReturnFoundationCanonical
      || resumedForegroundChatReturnFoundationCanonical
      || verifiedChatReturnFoundationState
        === TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.UPGRADE_REQUIRED;
    const unboundInboxConversationSweepFoundationCanonical =
      unboundInboxConversationSweepRuntimeFoundationState
      === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.CANONICAL;
    const unboundInboxConversationSweepFoundationReady =
      unboundInboxConversationSweepFoundationCanonical
      && verifiedChatReturnFoundationAllowsV8Runtime
      && isTinderUnboundInboxConversationSweepCapable(heartbeat.capabilities);
    const verifiedChatReturnFoundationReady = verifiedChatReturnFoundationCanonical
      && isTinderVerifiedChatReturnCapable(heartbeat.capabilities);
    const resumedForegroundChatReturnFoundationReady =
      resumedForegroundChatReturnFoundationCanonical
      && isTinderResumedForegroundChatReturnCapable(heartbeat.capabilities);
    // Readiness is deliberately transient and tied to this signed heartbeat.
    // A prior `ready:true` audit cannot authorize a later delivery. The
    // Android runtime may assert it only after local V3 continuity proof;
    // selection still revalidates all durable server facts under this lock.
    const verifiedChatReturnDeliveryReady = verifiedChatReturnFoundationReady
      && heartbeat.tinder_verified_chat_return?.ready === true;
    const resumedForegroundChatReturnDeliveryReady =
      resumedForegroundChatReturnFoundationReady
      && heartbeat.tinder_resumed_foreground_chat_return?.ready === true;
    let acceptedAt = now;
    if (!idempotent) {
      failureStage = "DEVICE_UPDATE";
      await client.query(
        `UPDATE device_bridge_devices SET
          app_version_name=$2, app_version_code=$3, manufacturer=$4, model=$5,
          android_api=$6, abis=$7::jsonb, capabilities=$8::jsonb,
          bridge_service_state=$9, tinder_state=$10, automation_state='STOPPED',
          last_heartbeat_sequence=$11, last_heartbeat_body_sha256=$12,
          last_accepted_heartbeat_at=$13, updated_at=$13
         WHERE device_id=$1`,
        [auth.deviceId, heartbeat.app.version_name, heartbeat.app.version_code,
          heartbeat.device.manufacturer, heartbeat.device.model, heartbeat.device.android_api,
          JSON.stringify(heartbeat.device.abis), JSON.stringify(heartbeat.capabilities),
          heartbeat.bridge.service_state, heartbeat.tinder_state, heartbeat.sequence,
          auth.contentSha256, now]
      );
      failureStage = "HEARTBEAT_AUDIT";
      await client.query(
        `INSERT INTO device_bridge_audit_events
         (event_type, request_id, device_id, key_id, result_code, http_status, details)
         VALUES ('HEARTBEAT_ACCEPTED',$1,$2,$3,'SUCCEEDED',200,$4::jsonb)`,
        [auth.requestId, auth.deviceId, auth.keyId, JSON.stringify(heartbeatAuditDetails(heartbeat))]
      );
    } else {
      acceptedAt = new Date(device.last_accepted_heartbeat_at);
    }
    failureStage = "V8_EXPIRY";
    const v8SweepRuntime = await expireUnboundInboxConversationSweepForHeartbeat(client, {
      pool,
      deviceId: auth.deviceId,
      now,
      unboundInboxConversationSweepFoundationCanonical
    });
    failureStage = "V9_EXPIRY";
    const v9ReturnRuntime = await expireVerifiedChatReturnPermitForHeartbeat(client, {
      pool,
      deviceId: auth.deviceId,
      now,
      verifiedChatReturnFoundationCanonical
    });
    failureStage = "V10_EXPIRY";
    const v10ReturnRuntime = await expireResumedForegroundChatReturnPermitForHeartbeat(client, {
      pool,
      deviceId: auth.deviceId,
      now,
      resumedForegroundChatReturnFoundationCanonical
    });
    if (!idempotent) {
      // The audit fact was intentionally written before the expiration and
      // serial gate. A valid fresh observation nonce is therefore consumed
      // even when a current V9 authority blocks V8. A later V8 must originate
      // from a new independently reviewed local Inbox observation.
      failureStage = "V8_START";
      await maybeStartUnboundInboxConversationSweepFromFreshObservation(client, {
        pool, deviceId: auth.deviceId, heartbeat, now,
        unboundInboxConversationSweepFoundationReady,
        verifiedChatReturnPermitActive: v9ReturnRuntime.active,
        resumedForegroundChatReturnPermitActive: v10ReturnRuntime.active,
        verifiedChatReturnFoundationCanonical,
        resumedForegroundChatReturnFoundationCanonical
      });
    }
    let commands = [];
    if (!v8SweepRuntime.childExpired && !v9ReturnRuntime.permitExpired
        && !v10ReturnRuntime.permitExpired) {
      // Delivery must not continue with an older nonterminal command in the
      // same heartbeat that made the V8 child terminal. A subsequent signed
      // heartbeat obtains a freshly locked command view.
      failureStage = "COMMAND_SELECTION";
      commands = await selectDeliverableCommands(client, auth.deviceId, heartbeat.capabilities, now, {
        unboundInboxConversationSweepFoundationReady,
        verifiedChatReturnFoundationReady,
        verifiedChatReturnDeliveryReady,
        verifiedChatReturnActive: v9ReturnRuntime.active,
        resumedForegroundChatReturnFoundationReady,
        resumedForegroundChatReturnDeliveryReady,
        resumedForegroundChatReturnActive: v10ReturnRuntime.active,
        suppressDynamicTinderCommands:
          // An INVALID result can mean a previously canonical V8 catalog
          // drifted after an active parent/child was issued. The current
          // transaction cannot safely inspect that parent, so never fall back
          // to unrelated dynamic Tinder delivery merely because this
          // heartbeat also advertises an older capability profile. An absent
          // V8 catalog is the distinct UPGRADE_REQUIRED state and preserves
          // legacy delivery until this new foundation has ever been applied.
          (unboundInboxConversationSweepFoundationState
            === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.INVALID
            && !verifiedChatReturnFoundationCanonical
            && !resumedForegroundChatReturnFoundationCanonical)
          // A canonical V9/V10 successor is not by itself proof that every V8
          // relation survived. Suppress dynamic Tinder delivery rather than
          // issue a V8 child that the ACK/ingress boundary must reject.
          || ((verifiedChatReturnFoundationCanonical
              || resumedForegroundChatReturnFoundationCanonical)
            && unboundInboxConversationSweepRuntimeFoundationState
              !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.CANONICAL)
          || verifiedChatReturnFoundationState
            === TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.INVALID
            && !resumedForegroundChatReturnFoundationCanonical
          // A partially present V10 catalog is not a harmless optional
          // feature flag. Hold all dynamic Tinder delivery inert rather than
          // falling back to V9 beside an uninspectable successor relation.
          || resumedForegroundChatReturnFoundationState
            === TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.INVALID
          // A current legacy capability cannot receive a V8 child. If one is
          // nevertheless active from an earlier V8 heartbeat, suppress all
          // dynamic Tinder delivery until it reaches its immutable terminal
          // state; never let capability downgrade bypass serial execution.
          || (!isTinderUnboundInboxConversationSweepCapable(heartbeat.capabilities)
            && v8SweepRuntime.active)
      });
    }
    failureStage = "COMMIT";
    await client.query("COMMIT");
    return heartbeatResponse(now, acceptedAt, commands);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw tagHeartbeatFailureStage(rollbackError, "ROLLBACK");
    }
    throw tagHeartbeatFailureStage(error, failureStage);
  } finally {
    client.release();
  }
}

export function createHeartbeatHandler(pool) {
  return async function heartbeatHandler(req, res) {
    try {
      const auth = await verifyAuthenticatedDeviceRequest({ req, pool, urlDeviceId: req.params.deviceId });
      const heartbeat = parseAndValidateHeartbeat(req);
      const response = await processHeartbeatTransaction(pool, auth, heartbeat);
      return res.status(200).json(response);
    } catch (error) {
      const status = error instanceof DeviceBridgeProtocolError ? error.status : 500;
      if (!(error instanceof DeviceBridgeProtocolError)) {
        const stage = boundedHeartbeatFailureStage(error);
        const phase = boundedHeartbeatFailurePhase(error);
        const location = phase === "UNCLASSIFIED" ? stage : `${stage}/${phase}`;
        console.error(
          `Device Bridge heartbeat transaction failed at ${location}: ${boundedHeartbeatFailureReason(error)}.`
        );
      }
      return res.status(status).json(protocolErrorBody(error, req.get("x-marcel-request-id")));
    }
  };
}
