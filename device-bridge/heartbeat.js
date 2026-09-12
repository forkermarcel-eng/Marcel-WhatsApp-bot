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

const TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE = "RESUME_OFFICIAL_TINDER_APP";
const TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE = "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION";
const TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE = "tinder_local_conversation_attestation_permits";
const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE =
  "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT";
const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE =
  "RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT";
const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE = "tinder_unbound_inbox_conversation_sweeps";
const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE = "tinder_unbound_inbox_conversation_sweep_steps";
const TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE = "tinder_visible_chat_sync_permits";
const TINDER_HUMAN_ARMED_CONVERSATION_REFERENCE_KIND = "tinder_human_armed_conversation_v1";

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
const TINDER_INBOX_NAVIGATION_FRESH_OBSERVATION_FIELDS = Object.freeze([
  ...TINDER_INBOX_NAVIGATION_FIELDS, "observation_kind", "observation_nonce"
]);
export const TINDER_INBOX_FRESH_REVIEWED_OBSERVATION_KIND = "FRESH_REVIEWED_INBOX_V1";
const TINDER_INBOX_NAVIGATION_MAX_COUNT = 8;

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

export function isBoundedTinderInboxNavigationDiagnostic(value) {
  const freshObservation = exactKeys(value, TINDER_INBOX_NAVIGATION_FRESH_OBSERVATION_FIELDS);
  return (exactKeys(value, TINDER_INBOX_NAVIGATION_FIELDS) || freshObservation)
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
    ));
}

function heartbeatAuditDetails(heartbeat) {
  const details = { sequence: heartbeat.sequence };
  if (!Object.hasOwn(heartbeat, "tinder_inbox_navigation")) return details;
  const navigation = heartbeat.tinder_inbox_navigation;
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
  return {
    ...details,
    tinder_inbox_navigation: boundedNavigation
  };
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
  pool, deviceId, heartbeat, now, unboundInboxConversationSweepFoundationReady
}) {
  if (!isFreshReviewedInboxObservation(heartbeat)
      || !isTinderUnboundInboxConversationSweepCapable(heartbeat.capabilities)
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
    { now: () => now }
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
  // A device that advertises V8 while its catalog is partial or unknown may
  // have a previously active V8 child we cannot inspect safely.  Do not fall
  // back to delivery of a pre-V8 dynamic Tinder command in that ambiguous
  // state. Administrative/status commands remain available.
  const commandTypes = suppressDynamicTinderCommands
    ? "'PING','REQUEST_STATUS','STOP_BRIDGE'"
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
  const payloadPredicate = unboundInboxConversationSweepCapable
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
  inspectUnboundInboxConversationSweepFoundation = inspectTinderUnboundInboxConversationSweepSchema
} = {}) {
  if (typeof inspectUnboundInboxConversationSweepFoundation !== "function") {
    throw new TypeError("inspectUnboundInboxConversationSweepFoundation must be a function");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
    await registerAuthenticatedRequestReplay(client, auth, now);

    const previousSequence = device.last_heartbeat_sequence === null ? null : Number(device.last_heartbeat_sequence);
    const idempotent = previousSequence !== null && heartbeat.sequence === previousSequence && device.last_heartbeat_body_sha256 === auth.contentSha256;
    if (previousSequence !== null && (heartbeat.sequence < previousSequence || (heartbeat.sequence === previousSequence && !idempotent))) {
      throw new DeviceBridgeProtocolError(409, "HEARTBEAT_SEQUENCE_CONFLICT", "Heartbeat sequence conflicts with the last accepted heartbeat");
    }

    const unboundInboxConversationSweepFoundationState =
      await inspectUnboundInboxConversationSweepFoundationState(
        client,
        inspectUnboundInboxConversationSweepFoundation
      );
    const unboundInboxConversationSweepFoundationCanonical =
      unboundInboxConversationSweepFoundationState
      === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.CANONICAL;
    const unboundInboxConversationSweepFoundationReady =
      unboundInboxConversationSweepFoundationCanonical
      && isTinderUnboundInboxConversationSweepCapable(heartbeat.capabilities);
    let acceptedAt = now;
    if (!idempotent) {
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
      await client.query(
        `INSERT INTO device_bridge_audit_events
         (event_type, request_id, device_id, key_id, result_code, http_status, details)
         VALUES ('HEARTBEAT_ACCEPTED',$1,$2,$3,'SUCCEEDED',200,$4::jsonb)`,
        [auth.requestId, auth.deviceId, auth.keyId, JSON.stringify(heartbeatAuditDetails(heartbeat))]
      );
      // The audit fact is intentionally written before any V8 gate/conflict
      // decision. Therefore a valid fresh observation nonce is consumed even
      // when this particular heartbeat cannot issue a sweep child.
      await maybeStartUnboundInboxConversationSweepFromFreshObservation(client, {
        pool, deviceId: auth.deviceId, heartbeat, now,
        unboundInboxConversationSweepFoundationReady
      });
    } else {
      acceptedAt = new Date(device.last_accepted_heartbeat_at);
    }
    const v8SweepRuntime = await expireUnboundInboxConversationSweepForHeartbeat(client, {
      pool,
      deviceId: auth.deviceId,
      now,
      unboundInboxConversationSweepFoundationCanonical
    });
    const commands = v8SweepRuntime.childExpired
      // Delivery must not continue with an older nonterminal command in the
      // same heartbeat that made the V8 child terminal.  A subsequent signed
      // heartbeat obtains a freshly locked command view.
      ? []
      : await selectDeliverableCommands(client, auth.deviceId, heartbeat.capabilities, now, {
        unboundInboxConversationSweepFoundationReady,
        suppressDynamicTinderCommands:
          // An INVALID result can mean a previously canonical V8 catalog
          // drifted after an active parent/child was issued. The current
          // transaction cannot safely inspect that parent, so never fall back
          // to unrelated dynamic Tinder delivery merely because this
          // heartbeat also advertises an older capability profile. An absent
          // V8 catalog is the distinct UPGRADE_REQUIRED state and preserves
          // legacy delivery until this new foundation has ever been applied.
          unboundInboxConversationSweepFoundationState
            === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.INVALID
          // A current legacy capability cannot receive a V8 child. If one is
          // nevertheless active from an earlier V8 heartbeat, suppress all
          // dynamic Tinder delivery until it reaches its immutable terminal
          // state; never let capability downgrade bypass serial execution.
          || (!isTinderUnboundInboxConversationSweepCapable(heartbeat.capabilities)
            && v8SweepRuntime.active)
      });
    await client.query("COMMIT");
    return heartbeatResponse(now, acceptedAt, commands);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
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
      if (!(error instanceof DeviceBridgeProtocolError)) console.error("Device Bridge heartbeat transaction failed.");
      return res.status(status).json(protocolErrorBody(error, req.get("x-marcel-request-id")));
    }
  };
}
