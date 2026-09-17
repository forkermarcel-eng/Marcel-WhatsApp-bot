/**
 * Strict, content-free result grammar for the one server-side attempt to
 * start a V8 Inbox sweep from an already accepted fresh Inbox observation.
 *
 * This is diagnostic only. It carries neither an observation nonce nor any
 * command, permit, sweep, device, identity, content, timestamp, or error
 * material. Accepting or displaying it cannot grant, renew, consume, or
 * replay authority.
 */

export const TINDER_UNBOUND_INBOX_SWEEP_START_DISPOSITION_STATUSES = Object.freeze([
  "QUEUED",
  "INERT",
  "DEVICE_NOT_READY",
  "SWEEP_NOT_AVAILABLE",
  "PERMIT_CONFLICT",
  "BLOCKED_CAPABILITY",
  "BLOCKED_V9_ACTIVE",
  "BLOCKED_V10_ACTIVE",
  "BLOCKED_FOUNDATION"
]);

const STATUS_SET = new Set(TINDER_UNBOUND_INBOX_SWEEP_START_DISPOSITION_STATUSES);
const NO_REASON_STATUSES = new Set([
  "QUEUED",
  "INERT",
  "BLOCKED_CAPABILITY",
  "BLOCKED_V9_ACTIVE",
  "BLOCKED_V10_ACTIVE",
  "BLOCKED_FOUNDATION"
]);
const DEVICE_NOT_READY_REASONS = new Set([
  "DEVICE_OFFLINE",
  "DEVICE_ENROLLMENT_INACTIVE",
  "BRIDGE_NOT_RUNNING",
  "TINDER_NOT_CONNECTED",
  "AUTOMATION_NOT_STOPPED",
  "DEVICE_CAPABILITY_UNSUPPORTED"
]);
const SWEEP_NOT_AVAILABLE_REASONS = new Set(["INBOX_NOT_READY"]);
const PERMIT_CONFLICT_REASONS = new Set([
  "HUMAN_ARMED_PERMIT_ACTIVE",
  "VISIBLE_CHAT_SYNC_PERMIT_ACTIVE",
  "RESUME_PERMIT_ACTIVE",
  "ATTESTATION_ACTIVE",
  "VERIFIED_CHAT_RETURN_PERMIT_ACTIVE",
  "RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_ACTIVE",
  "SWEEP_ACTIVE"
]);

function exactKeys(value, keys) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

/**
 * Re-project an exact fixed disposition or return null.  Do not return the
 * original input: callers must not accidentally widen the diagnostic through
 * a future audit/document field.
 */
export function boundedTinderUnboundInboxSweepStartDisposition(value) {
  const status = value?.status;
  if (!STATUS_SET.has(status)) return null;
  if (NO_REASON_STATUSES.has(status)) {
    return exactKeys(value, ["status"])
      ? Object.freeze({ status })
      : null;
  }
  if (!exactKeys(value, ["status", "reason_code"])) return null;
  const reasonCode = value.reason_code;
  const allowedReasons = status === "DEVICE_NOT_READY"
    ? DEVICE_NOT_READY_REASONS
    : status === "SWEEP_NOT_AVAILABLE"
      ? SWEEP_NOT_AVAILABLE_REASONS
      : status === "PERMIT_CONFLICT"
        ? PERMIT_CONFLICT_REASONS
        : null;
  if (!allowedReasons?.has(reasonCode)) return null;
  return Object.freeze({ status, reason_code: reasonCode });
}
