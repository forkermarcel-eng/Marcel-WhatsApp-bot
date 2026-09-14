/**
 * Exact, content-free grammar for the Android official-resume acknowledgement
 * to Inbox handoff observation.
 *
 * This is observational only. It cannot contain or grant a command, permit,
 * capture, identity, binding, revision, target, timestamp, UI tree, text,
 * exception, payload, URL, or network result.
 */

export const TINDER_OFFICIAL_RESUME_HANDOFF_STAGES = Object.freeze([
  "ARMED",
  "ACK_ACCEPTED",
  "CURRENT_ROOT_SAMPLED",
  "CANDIDATE_ACCEPTED",
  "INBOX_PREPARATION_REQUESTED",
  "BLOCKED"
]);

export const TINDER_OFFICIAL_RESUME_HANDOFF_REASONS = Object.freeze([
  "NONE",
  "ACK_WINDOW_EXPIRED",
  "ACK_ENVELOPE_UNAVAILABLE",
  "OFFICIAL_FOREGROUND_NOT_OBSERVED",
  "CANDIDATE_POLICY_REJECTED",
  "CURRENT_ROOT_SCHEDULE_FAILED",
  "INBOX_PREPARATION_REJECTED",
  "LIFECYCLE_RESET"
]);

const FIELDS = Object.freeze(["stage", "reason"]);
const stageSet = new Set(TINDER_OFFICIAL_RESUME_HANDOFF_STAGES);
const reasonSet = new Set(TINDER_OFFICIAL_RESUME_HANDOFF_REASONS);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...FIELDS].sort().join("|");
}

/**
 * Projects only exact supported vocabulary into a fresh frozen object. Never
 * return the source object, so future Android fields cannot cross a durable
 * audit or public status boundary accidentally.
 */
export function boundedTinderOfficialResumeHandoffDiagnostic(value) {
  if (!exactKeys(value)
      || !stageSet.has(value.stage)
      || !reasonSet.has(value.reason)) {
    return null;
  }
  return Object.freeze({ stage: value.stage, reason: value.reason });
}
