/**
 * Exact, content-free grammar for the architecture-cut passive Tinder read
 * channel's current diagnostic.  It carries progress only; it is never a
 * command, permit, identity, capture, reader input, or ingress authority.
 */

export const TINDER_PASSIVE_READ_CHANNEL_DIAGNOSTIC_STATES = Object.freeze([
  "IDLE",
  "AWAITING_FOREGROUND",
  "AWAITING_INBOX",
  "AWAITING_ROW_OPEN",
  "AWAITING_ROW_ACTION_CONFIRMATION",
  "AWAITING_CONVERSATION_VERIFICATION",
  "READING",
  "AWAITING_TRANSCRIPT_SUBMISSION",
  "AWAITING_HEADER_BACK",
  "AWAITING_NEXT_INBOX",
  "COMPLETE",
  "BLOCKED"
]);

export const TINDER_PASSIVE_READ_CHANNEL_DIAGNOSTIC_REASONS = Object.freeze([
  "NONE",
  "NO_ELIGIBLE_CONVERSATIONS",
  "MAXIMUM_CONVERSATIONS_REACHED",
  "CHANNEL_TIMEOUT",
  "STAGE_TIMEOUT",
  "TIME_UNAVAILABLE",
  "FOREGROUND_UNSAFE",
  "AUTH_OR_REVIEW_DETECTED",
  "INBOX_UNVERIFIED",
  "INBOX_SNAPSHOT_STALE",
  "ROW_NOT_ELIGIBLE",
  "ROW_ACTION_REJECTED",
  "ROW_ACTION_UNVERIFIED",
  "CONVERSATION_TRANSITION_DIVERGED",
  "CONVERSATION_UNVERIFIED",
  "READ_STOPPED",
  "SUBMISSION_REJECTED",
  "SUBMISSION_OUTCOME_UNKNOWN",
  "HEADER_BACK_UNVERIFIED",
  "HEADER_BACK_ACTION_REJECTED",
  "INBOX_RETURN_DIVERGED",
  "VISIBLE_INBOX_EXHAUSTED",
  "INVALID_TRANSITION"
]);

export const TINDER_PASSIVE_READ_CHANNEL_READER_STATES = Object.freeze([
  "NOT_REACHED", "IDLE", "READY_TO_SCROLL", "WAITING_FOR_VIEWPORT", "COMPLETE", "BLOCKED"
]);

export const TINDER_PASSIVE_READ_CHANNEL_READER_RESULTS = Object.freeze([
  "NOT_REACHED", "READY_TO_SCROLL", "WAITING_FOR_VIEWPORT", "COMPLETE",
  "BLOCKED_RUNTIME_GATE", "BLOCKED_VIEWPORT", "BLOCKED_SCREEN_CHANGED",
  "BLOCKED_SCROLL_TARGET", "BLOCKED_SCROLL_ACTION", "BLOCKED_ASSEMBLY",
  "BLOCKED_TIMEOUT", "BLOCKED_SEGMENT_LIMIT", "BLOCKED_INVALID_STATE"
]);

export const TINDER_PASSIVE_READ_CHANNEL_ASSEMBLY_RESULTS = Object.freeze([
  "NOT_REACHED", "ACCEPTED", "BLOCKED_INVALID_CAPTURE", "BLOCKED_LAYOUT_CHANGED",
  "BLOCKED_NO_PROGRESS", "BLOCKED_NO_OVERLAP", "BLOCKED_AMBIGUOUS_OVERLAP",
  "BLOCKED_MESSAGE_LIMIT"
]);

const FIELDS = Object.freeze([
  "direct_read_state", "direct_read_reason", "processed_conversation_count", "visible_conversation_count",
  "reader_state", "reader_result", "segment_count", "message_count", "overlap_count",
  "assembly_result"
]);
const MAXIMUM_PROCESSED_CONVERSATIONS = 24;
const MAXIMUM_VISIBLE_CONVERSATIONS = 64;
const MAXIMUM_SEGMENTS = 8;
const MAXIMUM_MESSAGES = 100;
const states = new Set(TINDER_PASSIVE_READ_CHANNEL_DIAGNOSTIC_STATES);
const reasons = new Set(TINDER_PASSIVE_READ_CHANNEL_DIAGNOSTIC_REASONS);
const readerStates = new Set(TINDER_PASSIVE_READ_CHANNEL_READER_STATES);
const readerResults = new Set(TINDER_PASSIVE_READ_CHANNEL_READER_RESULTS);
const assemblyResults = new Set(TINDER_PASSIVE_READ_CHANNEL_ASSEMBLY_RESULTS);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...FIELDS].sort().join("|");
}

function bounded(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

/**
 * Creates a fresh allowlisted projection.  In particular, a database JSON
 * value can never carry a future local field through this diagnostic surface.
 */
export function boundedTinderPassiveReadChannelDiagnostic(value) {
  const terminal = value?.direct_read_state === "COMPLETE"
    || value?.direct_read_state === "BLOCKED";
  if (!exactKeys(value)
      || !terminal
      || !states.has(value.direct_read_state)
      || !reasons.has(value.direct_read_reason)
      || value.direct_read_reason === "NONE"
      || !bounded(value.processed_conversation_count, MAXIMUM_PROCESSED_CONVERSATIONS)
      || !bounded(value.visible_conversation_count, MAXIMUM_VISIBLE_CONVERSATIONS)
      || !readerStates.has(value.reader_state)
      || !readerResults.has(value.reader_result)
      || !bounded(value.segment_count, MAXIMUM_SEGMENTS)
      || !bounded(value.message_count, MAXIMUM_MESSAGES)
      || !bounded(value.overlap_count, MAXIMUM_MESSAGES)
      || !assemblyResults.has(value.assembly_result)) {
    return null;
  }
  return Object.freeze({
    direct_read_state: value.direct_read_state,
    direct_read_reason: value.direct_read_reason,
    processed_conversation_count: value.processed_conversation_count,
    visible_conversation_count: value.visible_conversation_count,
    reader_state: value.reader_state,
    reader_result: value.reader_result,
    segment_count: value.segment_count,
    message_count: value.message_count,
    overlap_count: value.overlap_count,
    assembly_result: value.assembly_result
  });
}
