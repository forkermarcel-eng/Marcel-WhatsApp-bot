import {
  TINDER_PASSIVE_INBOX_OBSERVATION_DIAGNOSTIC_REASONS
} from "./tinder-passive-inbox-observation-diagnostic-contract.js";

/**
 * Exact, content-free grammar for the companion passive Inbox lifecycle
 * observation. It is status-only: it cannot carry or grant a row, target,
 * command, permit, identity, message, timestamp, exception, or reader
 * authority.
 */
export const TINDER_PASSIVE_INBOX_OBSERVATION_LIFECYCLE_STAGES = Object.freeze([
  "ARMED", "SETTLE_ENTERED", "TERMINAL"
]);

export const TINDER_PASSIVE_INBOX_OBSERVATION_LIFECYCLE_LAST_CALLBACKS = Object.freeze([
  "NOT_OBSERVED", "ON_CREATE", "ON_SERVICE_CONNECTED", "ON_UNBIND", "ON_REBIND",
  "ON_DESTROY"
]);

export const TINDER_PASSIVE_INBOX_OBSERVATION_LIFECYCLE_WIRINGS = Object.freeze([
  "NOT_STARTED", "INITIALIZING", "READY", "FAILED", "CLEARED"
]);

export const TINDER_PASSIVE_INBOX_OBSERVATION_LIFECYCLE_ACTIVE_EDGES = Object.freeze([
  "ACTIVE", "INACTIVE"
]);

const CALLBACK_MASK_PARTS = Object.freeze([
  "CREATE", "CONNECTED", "UNBIND", "REBIND", "DESTROYED"
]);

// The Android runtime constructs this in the same fixed order. Enumerating
// every canonical subset rejects reordered, repeated, or arbitrary strings.
export const TINDER_PASSIVE_INBOX_OBSERVATION_LIFECYCLE_CALLBACKS_SEEN = Object.freeze(
  Array.from({ length: 1 << CALLBACK_MASK_PARTS.length }, (_, mask) => {
    const values = CALLBACK_MASK_PARTS.filter((_, index) => (mask & (1 << index)) !== 0);
    return values.length === 0 ? "NONE" : values.join("|");
  })
);

const FIELDS = Object.freeze([
  "stage", "reason", "settle_sample_count", "validation_count", "last_callback",
  "callbacks_seen", "wiring", "active_edge"
]);
const MAXIMUM_COUNTER = 8;
const stages = new Set(TINDER_PASSIVE_INBOX_OBSERVATION_LIFECYCLE_STAGES);
const reasons = new Set(TINDER_PASSIVE_INBOX_OBSERVATION_DIAGNOSTIC_REASONS);
const lastCallbacks = new Set(TINDER_PASSIVE_INBOX_OBSERVATION_LIFECYCLE_LAST_CALLBACKS);
const callbacksSeen = new Set(TINDER_PASSIVE_INBOX_OBSERVATION_LIFECYCLE_CALLBACKS_SEEN);
const wirings = new Set(TINDER_PASSIVE_INBOX_OBSERVATION_LIFECYCLE_WIRINGS);
const activeEdges = new Set(TINDER_PASSIVE_INBOX_OBSERVATION_LIFECYCLE_ACTIVE_EDGES);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...FIELDS].sort().join("|");
}

/** Projects only the exact finite companion lifecycle into a fresh frozen value. */
export function boundedTinderPassiveInboxObservationLifecycle(value) {
  if (!exactKeys(value) || !stages.has(value.stage) || !reasons.has(value.reason)
      || !Number.isSafeInteger(value.settle_sample_count)
      || value.settle_sample_count < 0 || value.settle_sample_count > MAXIMUM_COUNTER
      || !Number.isSafeInteger(value.validation_count)
      || value.validation_count < 0 || value.validation_count > MAXIMUM_COUNTER
      || !lastCallbacks.has(value.last_callback)
      || !callbacksSeen.has(value.callbacks_seen)
      || !wirings.has(value.wiring)
      || !activeEdges.has(value.active_edge)
      || (value.stage === "TERMINAL" && value.reason === "NONE")
      || (value.stage !== "TERMINAL" && value.reason !== "NONE")) {
    return null;
  }
  return Object.freeze({
    stage: value.stage,
    reason: value.reason,
    settle_sample_count: value.settle_sample_count,
    validation_count: value.validation_count,
    last_callback: value.last_callback,
    callbacks_seen: value.callbacks_seen,
    wiring: value.wiring,
    active_edge: value.active_edge
  });
}
