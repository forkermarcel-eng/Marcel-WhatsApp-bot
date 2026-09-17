import crypto from "crypto";
import {
  boundedTinderOfficialResumeHandoffDiagnostic
} from "../../device-bridge/tinder-official-resume-handoff-diagnostic-contract.js";
import {
  boundedTinderOfficialResumeSchemaEvidence
} from "../../device-bridge/tinder-official-resume-schema-evidence-contract.js";
import {
  boundedTinderResumedForegroundChatReturnDiagnostic
} from "../../device-bridge/tinder-resumed-foreground-chat-return-diagnostic-contract.js";
import {
  boundedTinderPassiveInboxObservationDiagnostic
} from "../../device-bridge/tinder-passive-inbox-observation-diagnostic-contract.js";
import {
  boundedTinderPassiveInboxObservationLifecycle
} from "../../device-bridge/tinder-passive-inbox-observation-lifecycle-contract.js";
import {
  boundedTinderUnboundInboxSweepStartDisposition
} from "../../device-bridge/tinder-unbound-inbox-sweep-start-disposition-contract.js";

const ALLOWED_COMMANDS = new Set(["PING", "REQUEST_STATUS", "CONNECT_TINDER", "DISCONNECT_TINDER"]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INBOX_NAVIGATION_STAGES = new Set([
  "IDLE", "AWAITING_INBOX", "AWAITING_OFFICIAL_RESUME_HANDOFF",
  "AWAITING_INBOX_TAB_ACTION", "INBOX_READY", "AWAITING_ROW_OPEN",
  "ROW_ACTION_ISSUED", "AWAITING_CHAT", "CHAT_VERIFIED", "BLOCKED"
]);
const INBOX_NAVIGATION_REASONS = new Set([
  "NONE", "RUNTIME_GATE", "HUMAN_CALIBRATION_ACTIVE", "OPERATION_IN_PROGRESS",
  "ACCESSIBILITY_UNAVAILABLE", "OFFICIAL_RESUME_HANDOFF_FAILED", "FOREGROUND_WAIT_TIMEOUT",
  "SENSITIVE_SCREEN", "DISCOVERY_STRUCTURE_REJECTED", "INBOX_TAB_TARGET_DRIFT",
  "INBOX_TAB_ACTION_REJECTED", "INBOX_TRANSITION_TIMEOUT", "UNKNOWN_INBOX_STRUCTURE",
  "NO_ELIGIBLE_CONVERSATION", "ROW_SELECTION_UNAVAILABLE", "SNAPSHOT_EXPIRED",
  "ROW_TARGET_DRIFT", "ROW_ACTION_REJECTED", "CHAT_VERIFICATION_TIMEOUT",
  "CHAT_STRUCTURE_REJECTED", "ACCESSIBILITY_INTERRUPTED", "ACCESSIBILITY_UNBOUND",
  "ACCESSIBILITY_DESTROYED", "BRIDGE_NOT_RUNNING", "TINDER_GATE_NOT_CONNECTED",
  "LIFECYCLE_RESET", "LOCAL_STATE_UNAVAILABLE"
]);
const INBOX_NAVIGATION_FIELDS = Object.freeze([
  "stage", "reason", "visible_conversation_count", "observed_event_count"
]);
const INBOX_NAVIGATION_DISCOVERY_V16_FIELDS = Object.freeze([
  ...INBOX_NAVIGATION_FIELDS, "discovery_v16_state"
]);
const INBOX_NAVIGATION_DISCOVERY_V16_SELECTOR_COUNT_FIELDS = Object.freeze([
  ...INBOX_NAVIGATION_DISCOVERY_V16_FIELDS,
  "discovery_v16_raw_selector_match_count",
  "discovery_v16_qualified_selector_match_count"
]);
const INBOX_NAVIGATION_DISCOVERY_V16_DIRECT_STATIC_V2_FIELDS = Object.freeze([
  ...INBOX_NAVIGATION_DISCOVERY_V16_SELECTOR_COUNT_FIELDS,
  "direct_static_v2_state"
]);
const INBOX_NAVIGATION_DISCOVERY_V17_FIELDS = Object.freeze([
  ...INBOX_NAVIGATION_DISCOVERY_V16_DIRECT_STATIC_V2_FIELDS,
  "discovery_v17_carrier_relation_state"
]);
const INBOX_NAVIGATION_DISCOVERY_V18_FIELDS = Object.freeze([
  ...INBOX_NAVIGATION_DISCOVERY_V17_FIELDS,
  "discovery_v18_singleton_grandchild_relation_state"
]);
const INBOX_NAVIGATION_DISCOVERY_V19_FIELDS = Object.freeze([
  ...INBOX_NAVIGATION_DISCOVERY_V18_FIELDS,
  "discovery_v19_singleton_wrapper_shape_state"
]);
// V20 is a stand-alone terminal grammar: the bounded Inbox base, one finite
// V20 state, and two capped counters. It cannot be mixed with V16–V19.
const INBOX_NAVIGATION_DISCOVERY_V20_FIELDS = Object.freeze([
  ...INBOX_NAVIGATION_FIELDS,
  "discovery_v20_five_structural_chat_state",
  "discovery_v20_raw_selector_match_count",
  "discovery_v20_qualified_selector_match_count"
]);
const DISCOVERY_V16_SELECTOR_MATCH_COUNT_MAX = 2;
const DISCOVERY_V16_STATES = new Set([
  "NOT_EVALUATED",
  "BASE_STRUCTURE_REJECTED",
  "LABEL_MATCH_COUNT_REJECTED",
  "TARGET_PARENT_REJECTED",
  "TARGET_ACTION_REJECTED",
  "STRICT_CHAT_LABEL_INBOX_CANDIDATE"
]);
const DIRECT_STATIC_V2_STATES = new Set([
  "NOT_EVALUATED",
  "DIRECT_ID_INCOMPLETE_OR_AMBIGUOUS",
  "DIRECT_PARENTS_NOT_COMMON",
  "DIRECT_PARENT_SHAPE_REJECTED",
  "DIRECT_CHILD_SET_REJECTED",
  "DIRECT_TAB_SHAPE_REJECTED",
  "DIRECT_TAB_SELECTION_ACTION_REJECTED",
  "DIRECT_TAB_BOUNDS_REJECTED",
  "STRICT_V2_CANDIDATE"
]);
const DISCOVERY_V17_CARRIER_RELATION_STATES = new Set([
  "EXACT_CARRIER_FOUR_DIRECT_CHILDREN",
  "AMBIGUOUS_EXACT_CARRIER_FOUR_DIRECT_CHILDREN",
  "DIRECT_CHILD_CARDINALITY_OVER_FOUR",
  "NO_EXACT_CARRIER_IN_FOUR_CHILD_WINDOW"
]);
const DISCOVERY_V18_SINGLETON_GRANDCHILD_RELATION_STATES = new Set([
  "SINGLETON_GRANDCHILD_CARDINALITY_REJECTED",
  "EXACT_CARRIER_SINGLETON_GRANDCHILD",
  "AMBIGUOUS_EXACT_CARRIER_SINGLETON_GRANDCHILD",
  "NO_EXACT_CARRIER_SINGLETON_GRANDCHILD"
]);
const DISCOVERY_V19_SINGLETON_WRAPPER_SHAPE_STATES = new Set([
  "LEAF_SHAPE_NOT_REPRODUCED",
  "WRAPPER_REFERENCE_UNAVAILABLE",
  "WRAPPER_EMPTY",
  "WRAPPER_BRANCHING",
  "WRAPPER_SHAPE_MIXED_REJECTED",
  "V18_CARDINALITY_NOT_REPRODUCED"
]);
const DISCOVERY_V20_FIVE_STRUCTURAL_CHAT_STATES = new Set([
  "BASE_STRUCTURE_REJECTED",
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
  "ANCHOR_STRICT_PROOF_AMBIGUOUS",
  "LABEL_MATCH_COUNT_REJECTED",
  "TARGET_PARENT_REJECTED",
  "TARGET_ACTION_REJECTED",
  "STRICT_FIVE_STRUCTURAL_CHAT_LABEL_INBOX_CANDIDATE"
]);
const DISCOVERY_V20_ANCHOR_ZERO_COUNT_STATE_SET = new Set([
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
]);
const LEGACY_DEVICE_STATUS_FIELDS = Object.freeze([
  "device_id", "display_name", "enrollment_state", "device_status", "enrolled_at",
  "last_heartbeat_accepted_at", "app_version", "app_build", "bridge_service_state",
  "tinder_state", "automation_state", "tinder_manual_gate_capable",
  "tinder_local_conversation_attestation_post_chat_capable", "configuration_revision",
  "official_resume_handoff", "tinder_official_resume_schema_evidence",
  "last_accepted_official_resume_schema_diagnostic",
  "tinder_resumed_foreground_chat_return",
  "tinder_resumed_foreground_chat_return_diagnostic",
  "tinder_passive_inbox_observation_diagnostic",
  "tinder_passive_inbox_observation_lifecycle",
  "last_accepted_passive_inbox_observation_diagnostic_after_latest_v2_resume",
  "last_accepted_unbound_inbox_sweep_start_disposition_after_latest_v2_resume"
]);

function v20CountsMatchState(state, rawCount, qualifiedCount) {
  if (qualifiedCount > rawCount) return false;
  if (DISCOVERY_V20_ANCHOR_ZERO_COUNT_STATE_SET.has(state)) {
    return rawCount === 0 && qualifiedCount === 0;
  }
  if (state === "LABEL_MATCH_COUNT_REJECTED") return rawCount !== 1;
  if (state === "TARGET_PARENT_REJECTED") return rawCount === 1 && qualifiedCount === 0;
  if (state === "TARGET_ACTION_REJECTED"
      || state === "STRICT_FIVE_STRUCTURAL_CHAT_LABEL_INBOX_CANDIDATE") {
    return rawCount === 1 && qualifiedCount === 1;
  }
  return state === "BASE_STRUCTURE_REJECTED";
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";").map(cookie => cookie.trim());
  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex !== -1 && cookie.slice(0, separatorIndex) === name) {
      return cookie.slice(separatorIndex + 1);
    }
  }
  return null;
}

function validDashboardSession(req) {
  const password = process.env.DASHBOARD_PASSWORD;
  const session = getCookie(req, "marcel_dashboard_session");
  if (!password || !session) return false;
  const parts = session.split(".");
  if (parts.length !== 2) return false;
  const [token, receivedSignature] = parts;
  if (!token || !receivedSignature) return false;
  const expectedSignature = crypto.createHmac("sha256", password).update(token).digest("hex");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const receivedBuffer = Buffer.from(receivedSignature, "utf8");
  return expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function backendConfiguration(res) {
  const railwayBackendUrl = String(process.env.RAILWAY_BACKEND_URL || "").trim().replace(/\/+$/, "");
  const dashboardApiSecret = String(process.env.DASHBOARD_API_SECRET || "").trim();
  if (!railwayBackendUrl || !dashboardApiSecret) {
    res.status(500).json({ ok: false, error: "Dashboard-Verbindung ist nicht konfiguriert." });
    return null;
  }
  return { railwayBackendUrl, dashboardApiSecret };
}

async function readJson(response, res) {
  const rawText = await response.text();
  try {
    return rawText ? JSON.parse(rawText) : {};
  } catch {
    res.status(502).json({ ok: false, error: "Ungültige Antwort vom Backend." });
    return null;
  }
}

function backendHeaders(configuration, withBody = false) {
  return {
    Authorization: `Bearer ${configuration.dashboardApiSecret}`,
    Accept: "application/json",
    ...(withBody ? { "Content-Type": "application/json" } : {})
  };
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function normalizePublicInboxNavigation(value) {
  if (value === null) return null;
  const discoveryV16 = exactKeys(value, INBOX_NAVIGATION_DISCOVERY_V16_FIELDS);
  const discoveryV16SelectorCounts = exactKeys(
    value, INBOX_NAVIGATION_DISCOVERY_V16_SELECTOR_COUNT_FIELDS);
  const discoveryV16DirectStaticV2 = exactKeys(
    value, INBOX_NAVIGATION_DISCOVERY_V16_DIRECT_STATIC_V2_FIELDS);
  const discoveryV17 = exactKeys(value, INBOX_NAVIGATION_DISCOVERY_V17_FIELDS);
  const discoveryV18 = exactKeys(value, INBOX_NAVIGATION_DISCOVERY_V18_FIELDS);
  const discoveryV19 = exactKeys(value, INBOX_NAVIGATION_DISCOVERY_V19_FIELDS);
  const discoveryV20 = exactKeys(value, INBOX_NAVIGATION_DISCOVERY_V20_FIELDS);
  const hasDiscoveryV16SelectorCounts = discoveryV16SelectorCounts
    || discoveryV16DirectStaticV2 || discoveryV17 || discoveryV18 || discoveryV19;
  const hasDiscoveryV16DirectStaticV2 = discoveryV16DirectStaticV2 || discoveryV17
    || discoveryV18 || discoveryV19;
  const hasDiscoveryV17 = discoveryV17 || discoveryV18 || discoveryV19;
  const hasDiscoveryV18 = discoveryV18 || discoveryV19;
  if (!(exactKeys(value, INBOX_NAVIGATION_FIELDS)
      || discoveryV16 || discoveryV16SelectorCounts || discoveryV16DirectStaticV2
      || discoveryV17 || discoveryV18 || discoveryV19 || discoveryV20)
      || !INBOX_NAVIGATION_STAGES.has(value.stage)
      || !INBOX_NAVIGATION_REASONS.has(value.reason)
      || !Number.isSafeInteger(value.visible_conversation_count)
      || value.visible_conversation_count < 0 || value.visible_conversation_count > 8
      || !Number.isSafeInteger(value.observed_event_count)
      || value.observed_event_count < 0 || value.observed_event_count > 8
      || ((discoveryV16 || discoveryV16SelectorCounts || hasDiscoveryV16DirectStaticV2) && (
        value.stage !== "BLOCKED"
        || value.reason !== "DISCOVERY_STRUCTURE_REJECTED"
        || !DISCOVERY_V16_STATES.has(value.discovery_v16_state)
      ))
      || (hasDiscoveryV16SelectorCounts && (
        !Number.isSafeInteger(value.discovery_v16_raw_selector_match_count)
        || value.discovery_v16_raw_selector_match_count < 0
        || value.discovery_v16_raw_selector_match_count > DISCOVERY_V16_SELECTOR_MATCH_COUNT_MAX
        || !Number.isSafeInteger(value.discovery_v16_qualified_selector_match_count)
        || value.discovery_v16_qualified_selector_match_count < 0
        || value.discovery_v16_qualified_selector_match_count > DISCOVERY_V16_SELECTOR_MATCH_COUNT_MAX
      ))
      || (hasDiscoveryV16DirectStaticV2
        && !DIRECT_STATIC_V2_STATES.has(value.direct_static_v2_state))
      || (discoveryV17 && (
        value.discovery_v16_state !== "LABEL_MATCH_COUNT_REJECTED"
        || value.discovery_v16_raw_selector_match_count !== 0
        || value.discovery_v16_qualified_selector_match_count !== 0
        || !DISCOVERY_V17_CARRIER_RELATION_STATES.has(
          value.discovery_v17_carrier_relation_state)
      ))
      || (discoveryV18 && (
        value.discovery_v16_state !== "LABEL_MATCH_COUNT_REJECTED"
        || value.discovery_v16_raw_selector_match_count !== 0
        || value.discovery_v16_qualified_selector_match_count !== 0
        || value.discovery_v17_carrier_relation_state
          !== "NO_EXACT_CARRIER_IN_FOUR_CHILD_WINDOW"
        || !DISCOVERY_V18_SINGLETON_GRANDCHILD_RELATION_STATES.has(
          value.discovery_v18_singleton_grandchild_relation_state)
      ))
      || (discoveryV19 && (
        value.discovery_v16_state !== "LABEL_MATCH_COUNT_REJECTED"
        || value.discovery_v16_raw_selector_match_count !== 0
        || value.discovery_v16_qualified_selector_match_count !== 0
        || value.discovery_v17_carrier_relation_state
          !== "NO_EXACT_CARRIER_IN_FOUR_CHILD_WINDOW"
        || value.discovery_v18_singleton_grandchild_relation_state
          !== "SINGLETON_GRANDCHILD_CARDINALITY_REJECTED"
        || !DISCOVERY_V19_SINGLETON_WRAPPER_SHAPE_STATES.has(
          value.discovery_v19_singleton_wrapper_shape_state)
      ))
      || (discoveryV20 && (
        value.stage !== "BLOCKED"
        || value.reason !== "DISCOVERY_STRUCTURE_REJECTED"
        || !DISCOVERY_V20_FIVE_STRUCTURAL_CHAT_STATES.has(
          value.discovery_v20_five_structural_chat_state)
        || !Number.isSafeInteger(value.discovery_v20_raw_selector_match_count)
        || value.discovery_v20_raw_selector_match_count < 0
        || value.discovery_v20_raw_selector_match_count > DISCOVERY_V16_SELECTOR_MATCH_COUNT_MAX
        || !Number.isSafeInteger(value.discovery_v20_qualified_selector_match_count)
        || value.discovery_v20_qualified_selector_match_count < 0
        || value.discovery_v20_qualified_selector_match_count > DISCOVERY_V16_SELECTOR_MATCH_COUNT_MAX
        || !v20CountsMatchState(value.discovery_v20_five_structural_chat_state,
          value.discovery_v20_raw_selector_match_count,
          value.discovery_v20_qualified_selector_match_count)
      ))) {
    return null;
  }
  return Object.freeze({
    stage: value.stage,
    reason: value.reason,
    visible_conversation_count: value.visible_conversation_count,
    observed_event_count: value.observed_event_count,
    ...((discoveryV16 || discoveryV16SelectorCounts || hasDiscoveryV16DirectStaticV2)
      ? { discovery_v16_state: value.discovery_v16_state } : {}),
    ...(hasDiscoveryV16SelectorCounts ? {
      discovery_v16_raw_selector_match_count: value.discovery_v16_raw_selector_match_count,
      discovery_v16_qualified_selector_match_count: value.discovery_v16_qualified_selector_match_count
    } : {}),
    ...(hasDiscoveryV16DirectStaticV2
      ? { direct_static_v2_state: value.direct_static_v2_state } : {}),
    ...(hasDiscoveryV17
      ? { discovery_v17_carrier_relation_state: value.discovery_v17_carrier_relation_state } : {}),
    ...(hasDiscoveryV18 ? {
      discovery_v18_singleton_grandchild_relation_state:
        value.discovery_v18_singleton_grandchild_relation_state
    } : {}),
    ...(discoveryV19 ? {
      discovery_v19_singleton_wrapper_shape_state:
        value.discovery_v19_singleton_wrapper_shape_state
    } : {}),
    ...(discoveryV20 ? {
      discovery_v20_five_structural_chat_state:
        value.discovery_v20_five_structural_chat_state,
      discovery_v20_raw_selector_match_count:
        value.discovery_v20_raw_selector_match_count,
      discovery_v20_qualified_selector_match_count:
        value.discovery_v20_qualified_selector_match_count
    } : {})
  });
}

function normalizePublicOfficialResumeHandoff(value) {
  return boundedTinderOfficialResumeHandoffDiagnostic(value);
}

function normalizePublicOfficialResumeSchemaEvidence(value) {
  return boundedTinderOfficialResumeSchemaEvidence(value);
}

function normalizePublicLastAcceptedOfficialResumeSchemaDiagnostic(value) {
  if (value === null || !exactKeys(value, ["handoff", "schema_evidence"])) return null;
  const handoff = normalizePublicOfficialResumeHandoff(value.handoff);
  const schemaEvidence = normalizePublicOfficialResumeSchemaEvidence(value.schema_evidence);
  if (handoff?.stage !== "BLOCKED"
      || handoff.reason !== "UNREVIEWED_OFFICIAL_SURFACE"
      || schemaEvidence === null) {
    return null;
  }
  return Object.freeze({ handoff, schema_evidence: schemaEvidence });
}

function normalizePublicResumedForegroundChatReturnReadiness(value) {
  if (value === null || !exactKeys(value, ["ready"]) || typeof value.ready !== "boolean") {
    return null;
  }
  return Object.freeze({ ready: value.ready });
}

function normalizePublicResumedForegroundChatReturnDiagnostic(value) {
  return boundedTinderResumedForegroundChatReturnDiagnostic(value);
}

function normalizePublicPassiveInboxObservationDiagnostic(value) {
  return boundedTinderPassiveInboxObservationDiagnostic(value);
}

function normalizePublicPassiveInboxObservationLifecycle(value) {
  return boundedTinderPassiveInboxObservationLifecycle(value);
}

/**
 * Preserve the pre-existing device-status fields without changing their
 * validation semantics, while explicitly allowlisting the new optional
 * heartbeat diagnostic. This prevents raw audit JSON from crossing the
 * Vercel boundary without turning unrelated legacy status variation into an
 * outage.
 */
function sanitizePublicDeviceStatus(value) {
  if (!plainObject(value)) return null;
  const hasInboxNavigation = Object.hasOwn(value, "inbox_navigation");
  // The server only projects a heartbeat observation while the device is
  // ONLINE. Keep that freshness boundary at the public proxy too, so an
  // unexpected/stale upstream payload cannot make an offline observation
  // visible in the dashboard.
  const inboxNavigation = String(value.device_status || "").toUpperCase() === "ONLINE" && hasInboxNavigation
    ? normalizePublicInboxNavigation(value.inbox_navigation)
    : null;
  const hasOfficialResumeHandoff = Object.hasOwn(value, "official_resume_handoff");
  const officialResumeHandoff = String(value.device_status || "").toUpperCase() === "ONLINE"
    && hasOfficialResumeHandoff
    ? normalizePublicOfficialResumeHandoff(value.official_resume_handoff)
    : null;
  const hasOfficialResumeSchemaEvidence = Object.hasOwn(
    value, "tinder_official_resume_schema_evidence"
  );
  const officialResumeSchemaEvidence = String(value.device_status || "").toUpperCase()
      === "ONLINE" && officialResumeHandoff?.stage === "BLOCKED"
      && officialResumeHandoff?.reason === "UNREVIEWED_OFFICIAL_SURFACE"
      && hasOfficialResumeSchemaEvidence
    ? normalizePublicOfficialResumeSchemaEvidence(
      value.tinder_official_resume_schema_evidence)
    : null;
  const hasLastAcceptedOfficialResumeSchemaDiagnostic = Object.hasOwn(
    value, "last_accepted_official_resume_schema_diagnostic"
  );
  const lastAcceptedOfficialResumeSchemaDiagnostic =
    String(value.device_status || "").toUpperCase() === "ONLINE"
      && officialResumeHandoff?.stage === "BLOCKED"
      && officialResumeHandoff?.reason === "UNREVIEWED_OFFICIAL_SURFACE"
      && hasLastAcceptedOfficialResumeSchemaDiagnostic
    ? normalizePublicLastAcceptedOfficialResumeSchemaDiagnostic(
      value.last_accepted_official_resume_schema_diagnostic)
    : null;
  const hasResumedForegroundChatReturn = Object.hasOwn(
    value, "tinder_resumed_foreground_chat_return"
  );
  const resumedForegroundChatReturn = String(value.device_status || "").toUpperCase() === "ONLINE"
    && hasResumedForegroundChatReturn
    ? normalizePublicResumedForegroundChatReturnReadiness(
      value.tinder_resumed_foreground_chat_return
    )
    : null;
  const hasResumedForegroundChatReturnDiagnostic = Object.hasOwn(
    value, "tinder_resumed_foreground_chat_return_diagnostic"
  );
  const resumedForegroundChatReturnDiagnostic =
    String(value.device_status || "").toUpperCase() === "ONLINE"
      && hasResumedForegroundChatReturnDiagnostic
      ? normalizePublicResumedForegroundChatReturnDiagnostic(
        value.tinder_resumed_foreground_chat_return_diagnostic
      )
      : null;
  const hasPassiveInboxObservationDiagnostic = Object.hasOwn(
    value, "tinder_passive_inbox_observation_diagnostic"
  );
  const passiveInboxObservationDiagnostic =
    String(value.device_status || "").toUpperCase() === "ONLINE"
      && hasPassiveInboxObservationDiagnostic
      ? normalizePublicPassiveInboxObservationDiagnostic(
        value.tinder_passive_inbox_observation_diagnostic
      )
      : null;
  const hasPassiveInboxObservationLifecycle = Object.hasOwn(
    value, "tinder_passive_inbox_observation_lifecycle"
  );
  // The lifecycle companion is intentionally current-heartbeat-only. It is
  // an exact bounded diagnostic, never a historical permit/audit authority.
  const passiveInboxObservationLifecycle =
    String(value.device_status || "").toUpperCase() === "ONLINE"
      && hasPassiveInboxObservationLifecycle
      ? normalizePublicPassiveInboxObservationLifecycle(
        value.tinder_passive_inbox_observation_lifecycle
      )
      : null;
  // This separately labelled temporal record is historical accepted evidence,
  // not a current diagnostic or an authority for any command or permit.
  const hasLastAcceptedPassiveInboxObservationDiagnosticAfterLatestV2Resume =
    Object.hasOwn(value,
      "last_accepted_passive_inbox_observation_diagnostic_after_latest_v2_resume");
  const lastAcceptedPassiveInboxObservationDiagnosticAfterLatestV2Resume =
    String(value.device_status || "").toUpperCase() === "ONLINE"
      && hasLastAcceptedPassiveInboxObservationDiagnosticAfterLatestV2Resume
      ? normalizePublicPassiveInboxObservationDiagnostic(
        value.last_accepted_passive_inbox_observation_diagnostic_after_latest_v2_resume
      )
      : null;
  const hasLastAcceptedUnboundInboxSweepStartDispositionAfterLatestV2Resume =
    Object.hasOwn(value,
      "last_accepted_unbound_inbox_sweep_start_disposition_after_latest_v2_resume");
  const lastAcceptedUnboundInboxSweepStartDispositionAfterLatestV2Resume =
    String(value.device_status || "").toUpperCase() === "ONLINE"
      && hasLastAcceptedUnboundInboxSweepStartDispositionAfterLatestV2Resume
      ? boundedTinderUnboundInboxSweepStartDisposition(
        value.last_accepted_unbound_inbox_sweep_start_disposition_after_latest_v2_resume
      )
      : null;
  return Object.freeze({
    ...Object.fromEntries(LEGACY_DEVICE_STATUS_FIELDS.map(field => [field, value[field]])),
    // This is a bounded derived compatibility bit, not the raw capability
    // array. Missing/legacy upstream values are conservatively false.
    tinder_local_conversation_attestation_post_chat_capable:
      value.tinder_local_conversation_attestation_post_chat_capable === true,
    inbox_navigation: inboxNavigation,
    official_resume_handoff: officialResumeHandoff,
    tinder_official_resume_schema_evidence: officialResumeSchemaEvidence,
    last_accepted_official_resume_schema_diagnostic:
      lastAcceptedOfficialResumeSchemaDiagnostic,
    tinder_resumed_foreground_chat_return: resumedForegroundChatReturn,
    tinder_resumed_foreground_chat_return_diagnostic: resumedForegroundChatReturnDiagnostic,
    tinder_passive_inbox_observation_diagnostic: passiveInboxObservationDiagnostic,
    tinder_passive_inbox_observation_lifecycle: passiveInboxObservationLifecycle,
    last_accepted_passive_inbox_observation_diagnostic_after_latest_v2_resume:
      lastAcceptedPassiveInboxObservationDiagnosticAfterLatestV2Resume,
    last_accepted_unbound_inbox_sweep_start_disposition_after_latest_v2_resume:
      lastAcceptedUnboundInboxSweepStartDispositionAfterLatestV2Resume
  });
}

async function listDevices(res, configuration) {
  try {
    const railwayResponse = await fetch(
      configuration.railwayBackendUrl + "/dashboard-api/device-bridge/devices",
      { method: "GET", headers: backendHeaders(configuration), cache: "no-store" }
    );
    const data = await readJson(railwayResponse, res);
    if (!data) return;
    if (!railwayResponse.ok) {
      if (railwayResponse.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      return res.status(502).json({
        ok: false,
        error: data?.error?.message || data?.error || "Gerätestatus konnte nicht geladen werden."
      });
    }
    if (!Array.isArray(data?.devices)) {
      return res.status(502).json({ ok: false, error: "Ungültige Geräteantwort vom Backend." });
    }
    const devices = data.devices.map(sanitizePublicDeviceStatus);
    if (devices.some(device => device === null)) {
      return res.status(502).json({ ok: false, error: "Ung\u00fcltige Ger\u00e4teantwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, server_time: data.server_time, devices });
  } catch {
    console.error("Verbindung zum Device-Bridge-Status fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

async function createCommand(req, res, configuration) {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 2 || typeof body.device_id !== "string" ||
      typeof body.type !== "string") {
    return res.status(400).json({ ok: false, error: "Ungültige Command-Anfrage." });
  }
  if (!UUID_V4.test(body.device_id)) {
    return res.status(400).json({ ok: false, error: "Ungültige Device-ID." });
  }
  if (!ALLOWED_COMMANDS.has(body.type)) {
    return res.status(400).json({ ok: false, error: "Command ist nicht erlaubt." });
  }
  const railwayPath = `/dashboard-api/device-bridge/devices/${body.device_id}/commands`;
  try {
    const railwayResponse = await fetch(configuration.railwayBackendUrl + railwayPath, {
      method: "POST",
      headers: backendHeaders(configuration, true),
      body: JSON.stringify({ type: body.type }),
      cache: "no-store"
    });
    const data = await readJson(railwayResponse, res);
    if (!data) return;
    if (!railwayResponse.ok) {
      if (railwayResponse.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      const status = [400, 403, 404, 409, 429].includes(railwayResponse.status)
        ? railwayResponse.status : 502;
      return res.status(status).json({
        ok: false,
        error: data?.error?.message || "Command konnte nicht erstellt werden.",
        code: data?.error?.code || ""
      });
    }
    const command = data?.command;
    if (!command || !UUID_V4.test(command.command_id) || command.type !== body.type) {
      return res.status(502).json({ ok: false, error: "Ungültige Command-Antwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(201).json({
      ok: true,
      command: {
        command_id: command.command_id,
        type: command.type,
        issued_at: command.issued_at,
        expires_at: command.expires_at,
        configuration_revision: command.configuration_revision
      }
    });
  } catch {
    console.error("Verbindung zur Device-Bridge-Command-Erstellung fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

async function readCommandStatus(req, res, configuration) {
  const deviceId = typeof req.query?.deviceId === "string" ? req.query.deviceId : "";
  const commandId = typeof req.query?.commandId === "string" ? req.query.commandId : "";
  if (!UUID_V4.test(deviceId)) {
    return res.status(400).json({ ok: false, error: "Ungültige Device-ID." });
  }
  if (!UUID_V4.test(commandId)) {
    return res.status(400).json({ ok: false, error: "Ungültige Command-ID." });
  }
  const railwayPath = `/dashboard-api/device-bridge/devices/${deviceId}/commands/${commandId}`;
  try {
    const railwayResponse = await fetch(configuration.railwayBackendUrl + railwayPath, {
      method: "GET",
      headers: backendHeaders(configuration),
      cache: "no-store"
    });
    const data = await readJson(railwayResponse, res);
    if (!data) return;
    if (!railwayResponse.ok) {
      if (railwayResponse.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      const status = [400, 404].includes(railwayResponse.status) ? railwayResponse.status : 502;
      return res.status(status).json({
        ok: false,
        error: data?.error?.message || "Command-Status konnte nicht geladen werden.",
        code: data?.error?.code || ""
      });
    }
    if (!data?.command || data.command.command_id !== commandId || data.command.device_id !== deviceId) {
      return res.status(502).json({ ok: false, error: "Ungültige Command-Status-Antwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, server_time: data.server_time, command: data.command });
  } catch {
    console.error("Verbindung zum Device-Bridge-Command-Status fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

export default async function handler(req, res) {
  if (!new Set(["GET", "POST"]).has(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Methode nicht erlaubt." });
  }
  if (!validDashboardSession(req)) {
    return res.status(401).json({ ok: false, error: "Nicht angemeldet." });
  }
  const configuration = backendConfiguration(res);
  if (!configuration) return;
  if (req.method === "POST") return createCommand(req, res, configuration);
  const hasCommandQuery = req.query?.deviceId !== undefined || req.query?.commandId !== undefined;
  return hasCommandQuery
    ? readCommandStatus(req, res, configuration)
    : listDevices(res, configuration);
}

export { ALLOWED_COMMANDS };
