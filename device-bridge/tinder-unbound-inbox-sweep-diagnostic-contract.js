/**
 * Strict, content-free V8 sweep diagnostic grammar shared by the signed
 * heartbeat boundary and the dashboard-only status projection.
 *
 * The contract intentionally has no identifiers, names, content, payloads,
 * URLs, exception text, backend code, or HTTP status.  It is observational
 * only: accepting it can never issue, renew, consume, or replay a command.
 */

export const TINDER_UNBOUND_INBOX_SWEEP_DIAGNOSTIC_STAGES = Object.freeze([
  "IDLE",
  "POST_ACK_HANDOFF",
  "ROW_NAVIGATION",
  "CHAT_VERIFICATION",
  "READER",
  "INGRESS",
  "RETURN"
]);

export const TINDER_UNBOUND_INBOX_SWEEP_DIAGNOSTIC_REASONS = Object.freeze([
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
  "HUMAN_ROW_SELECTION_REJECTED",
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
  "LOCAL_STATE_UNAVAILABLE",
  "UNBOUND_READ_COMMAND_EXPIRED",
  "UNBOUND_READER_TIMEOUT",
  "CHAT_TRANSITION_DIVERGED",
  "UNBOUND_READER_REJECTED",
  "UNBOUND_READER_INGRESS_FAILED",
  "ROW_ACTION_EVENT_UNOBSERVED"
]);

export const TINDER_UNBOUND_INBOX_SWEEP_DIAGNOSTIC_SESSION_STATES = Object.freeze([
  "IDLE",
  "READY_FOR_READ_CHILD",
  "READ_CHILD_STAGED",
  "READ_IN_PROGRESS",
  "AWAITING_RETURN_CHILD",
  "RETURN_CHILD_STAGED",
  "RETURN_IN_PROGRESS",
  "COMPLETED",
  "BLOCKED"
]);

export const TINDER_UNBOUND_INBOX_SWEEP_DIAGNOSTIC_READER_RESULTS = Object.freeze([
  "NOT_REACHED",
  "STAGED",
  "READY_TO_SCROLL",
  "WAITING_FOR_VIEWPORT",
  "COMPLETE",
  "BLOCKED_COMPETING_CAPTURE_PENDING",
  "BLOCKED_COMMAND_EXPIRED",
  "BLOCKED_CHILD_PHASE",
  "BLOCKED_RUNTIME_GATE",
  "BLOCKED_TECHNICAL_CHAT",
  "BLOCKED_VIEWPORT",
  "BLOCKED_CONTINUITY",
  "BLOCKED_THREAD_SWITCH",
  "BLOCKED_SCROLL_TARGET",
  "BLOCKED_SCROLL_ACTION",
  "BLOCKED_ASSEMBLY",
  "BLOCKED_TIMEOUT",
  "BLOCKED_SEGMENT_LIMIT",
  "BLOCKED_INVALID_STATE"
]);

export const TINDER_UNBOUND_INBOX_SWEEP_DIAGNOSTIC_INGRESS_PHASES = Object.freeze([
  "NONE", "READ", "RETURN"
]);

export const TINDER_UNBOUND_INBOX_SWEEP_DIAGNOSTIC_INGRESS_OUTCOMES = Object.freeze([
  "NOT_REACHED", "ACCEPTED", "NOT_ATTEMPTED", "REJECTED", "RESULT_UNCONFIRMED"
]);

export const TINDER_UNBOUND_INBOX_SWEEP_DIAGNOSTIC_INGRESS_STAGES = Object.freeze([
  "NONE",
  "LOCAL_GATE",
  "SERIALIZATION",
  "BODY_HASH",
  "REQUEST_BUILD",
  "SIGNATURE",
  "URL_BUILD",
  "TRANSPORT_CONNECT",
  "TLS",
  "HTTP_RESPONSE",
  "RESPONSE_PARSE",
  "UNEXPECTED"
]);

const FIELDS = Object.freeze([
  "stage",
  "reason",
  "session_state",
  "current_slot",
  "reads_accepted",
  "returns_accepted",
  "reader_result",
  "ingress_phase",
  "ingress_outcome",
  "ingress_stage"
]);
const MAXIMUM_COUNTER = 8;
const stageSet = new Set(TINDER_UNBOUND_INBOX_SWEEP_DIAGNOSTIC_STAGES);
const reasonSet = new Set(TINDER_UNBOUND_INBOX_SWEEP_DIAGNOSTIC_REASONS);
const sessionStateSet = new Set(TINDER_UNBOUND_INBOX_SWEEP_DIAGNOSTIC_SESSION_STATES);
const readerResultSet = new Set(TINDER_UNBOUND_INBOX_SWEEP_DIAGNOSTIC_READER_RESULTS);
const ingressPhaseSet = new Set(TINDER_UNBOUND_INBOX_SWEEP_DIAGNOSTIC_INGRESS_PHASES);
const ingressOutcomeSet = new Set(TINDER_UNBOUND_INBOX_SWEEP_DIAGNOSTIC_INGRESS_OUTCOMES);
const ingressStageSet = new Set(TINDER_UNBOUND_INBOX_SWEEP_DIAGNOSTIC_INGRESS_STAGES);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value) {
  return object(value)
    && Object.keys(value).sort().join("|") === [...FIELDS].sort().join("|");
}

function boundedCounter(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAXIMUM_COUNTER;
}

/**
 * Returns a newly projected, frozen exact diagnostic or null.  Do not return
 * the original value: callers must never accidentally carry future fields
 * from a device heartbeat or database JSON document across a public boundary.
 */
export function boundedTinderUnboundInboxSweepDiagnostic(value) {
  if (!exactKeys(value)
      || !stageSet.has(value.stage)
      || !reasonSet.has(value.reason)
      || !sessionStateSet.has(value.session_state)
      || !boundedCounter(value.current_slot)
      || !boundedCounter(value.reads_accepted)
      || !boundedCounter(value.returns_accepted)
      || !readerResultSet.has(value.reader_result)
      || !ingressPhaseSet.has(value.ingress_phase)
      || !ingressOutcomeSet.has(value.ingress_outcome)
      || !ingressStageSet.has(value.ingress_stage)) {
    return null;
  }
  return Object.freeze({
    stage: value.stage,
    reason: value.reason,
    session_state: value.session_state,
    current_slot: value.current_slot,
    reads_accepted: value.reads_accepted,
    returns_accepted: value.returns_accepted,
    reader_result: value.reader_result,
    ingress_phase: value.ingress_phase,
    ingress_outcome: value.ingress_outcome,
    ingress_stage: value.ingress_stage
  });
}
