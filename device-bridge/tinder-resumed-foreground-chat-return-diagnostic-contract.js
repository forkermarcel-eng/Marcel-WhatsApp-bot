/**
 * Exact, content-free grammar for V10 foreground-chat return lifecycle evidence.
 *
 * This optional observation cannot contain or grant a command, permit, capture,
 * identity, binding, revision, target, timestamp, UI tree, text, exception,
 * payload, URL, or network result. It is never used for command delivery.
 */

export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_DIAGNOSTIC_STAGES = Object.freeze([
  "CANDIDATE_ARMED",
  "RESUME_ACK_ACCEPTED",
  "CHAT_REPROVED",
  "READY_FOR_HEARTBEAT",
  "RETURN_ACTION_STAGED",
  "AWAITING_EXPECTED_CLICK",
  "AWAITING_FRESH_INBOX",
  "RETURNED",
  "BLOCKED"
]);

export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_DIAGNOSTIC_REASONS = Object.freeze([
  "NONE",
  "PRECONDITION_REJECTED",
  "ACK_MISMATCH_OR_EXPIRED",
  "STRICT_REPROOF_REJECTED",
  "CONTINUITY_MISMATCH",
  "EVENT_DRIFT",
  "READINESS_EXPIRED",
  "LIFECYCLE_RESET",
  "PERMIT_OR_STAGE_INVALID",
  "FOREGROUND_PROOF_INVALID",
  "HEADER_ACTION_REJECTED",
  "HEADER_CLICK_UNOBSERVED",
  "FRESH_INBOX_REJECTED",
  "RECEIPT_REJECTED",
  "RETURN_TIMEOUT"
]);

const FIELDS = Object.freeze(["stage", "reason"]);
const stages = new Set(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_DIAGNOSTIC_STAGES);
const reasons = new Set(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_DIAGNOSTIC_REASONS);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...FIELDS].sort().join("|");
}

/** Projects only exact supported vocabulary into a fresh frozen object. */
export function boundedTinderResumedForegroundChatReturnDiagnostic(value) {
  if (!exactKeys(value) || !stages.has(value.stage) || !reasons.has(value.reason)) {
    return null;
  }
  return Object.freeze({ stage: value.stage, reason: value.reason });
}
