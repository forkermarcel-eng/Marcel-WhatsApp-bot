/**
 * Exact, content-free grammar for passive V8 Inbox-observation lifecycle evidence.
 *
 * This observation cannot contain or grant a nonce, snapshot, row, target, command, permit,
 * identity, message, timestamp, exception, secret, or reader authority.
 */

export const TINDER_PASSIVE_INBOX_OBSERVATION_DIAGNOSTIC_STAGES = Object.freeze([
  "ARMED", "PENDING_HEARTBEAT", "DELIVERED", "BLOCKED"
]);

export const TINDER_PASSIVE_INBOX_OBSERVATION_DIAGNOSTIC_REASONS = Object.freeze([
  "NONE",
  "REQUEST_GATE_REJECTED",
  "SCHEDULE_FAILED",
  "LIFECYCLE_RESET",
  "RUNTIME_GATE_LOST",
  "SETTLE_FOREIGN_OR_EMPTY",
  "SETTLE_NON_INBOX",
  "SETTLE_SENSITIVE",
  "SETTLE_PARTIAL_OR_UNKNOWN",
  "LOCAL_CONTEXT_REJECTED",
  "RUNTIME_WITNESS_REJECTED",
  "LEASE_REJECTED",
  "VALIDATION_BUDGET",
  "VALIDATION_DRIFT",
  "HEARTBEAT_EXPIRED",
  "HEARTBEAT_EXPIRED_PRE_PAYLOAD",
  "HEARTBEAT_EXPIRED_PAYLOAD_BUILT",
  "HEARTBEAT_EXPIRED_TRANSPORT_ATTEMPTED",
  "HEARTBEAT_GATE_LOST",
  "HEARTBEAT_GATE_ENROLLMENT_INACTIVE",
  "HEARTBEAT_GATE_LIFECYCLE_NOT_RUNNING",
  "HEARTBEAT_GATE_MANUAL_DISCONNECTED",
  "HEARTBEAT_GATE_HUMAN_BINDING_BUSY",
  "HEARTBEAT_GATE_LOCAL_ATTESTATION_BUSY",
  "HEARTBEAT_GATE_VISIBLE_CHAT_SYNC_BUSY",
  "HEARTBEAT_GATE_UNBOUND_SWEEP_BUSY",
  "HEARTBEAT_GATE_LOCAL_ATTESTATION_RETURN_BUSY",
  "HEARTBEAT_GATE_RESUMED_FOREGROUND_RETURN_BUSY",
  "HEARTBEAT_GATE_OFFICIAL_RESUME_WINDOW_BUSY",
  "HEARTBEAT_LEASE_LOST"
]);

const FIELDS = Object.freeze(["stage", "reason", "settle_sample_count", "validation_count"]);
const MAXIMUM_COUNTER = 8;
const stages = new Set(TINDER_PASSIVE_INBOX_OBSERVATION_DIAGNOSTIC_STAGES);
const reasons = new Set(TINDER_PASSIVE_INBOX_OBSERVATION_DIAGNOSTIC_REASONS);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...FIELDS].sort().join("|");
}

/** Projects only exact finite observational facts into a fresh frozen object. */
export function boundedTinderPassiveInboxObservationDiagnostic(value) {
  if (!exactKeys(value) || !stages.has(value.stage) || !reasons.has(value.reason)
      || !Number.isSafeInteger(value.settle_sample_count)
      || value.settle_sample_count < 0 || value.settle_sample_count > MAXIMUM_COUNTER
      || !Number.isSafeInteger(value.validation_count)
      || value.validation_count < 0 || value.validation_count > MAXIMUM_COUNTER
      || (value.stage === "BLOCKED" && value.reason === "NONE")
      || (value.stage !== "BLOCKED" && value.reason !== "NONE")) {
    return null;
  }
  return Object.freeze({
    stage: value.stage,
    reason: value.reason,
    settle_sample_count: value.settle_sample_count,
    validation_count: value.validation_count
  });
}
