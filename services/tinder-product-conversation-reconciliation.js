import {
  TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE,
  TINDER_PRODUCT_CONVERSATION_HISTORY_STATE,
  TINDER_PRODUCT_CONVERSATION_IDENTITY_STATE,
  TINDER_PRODUCT_CONVERSATION_LINK_METHOD,
  TINDER_PRODUCT_CONVERSATION_MINIMUM_ORDERED_OVERLAP,
  mergeOrderedTinderMessageHistory,
  normalizeTinderProductConversationMessages,
  orderedDirectionalOverlap
} from "./tinder-product-conversation-store.js";

/* ==================================================
HISTORICAL TINDER PRODUCT-CONVERSATION RECONCILIATION

This is deliberately a pure, local planning helper.  It never opens a
database connection, changes a capture, creates a Conversation, or invokes a
migration.  A separately authorized application step must re-read and
revalidate the immutable evidence before it can apply one of these plans.

`runtimeThreadFingerprint` is only a device-scoped candidate bucket.  It is
never an identity key: captures join a plan only after a unique, ordered,
directional overlap.  Visible names, profile data, timestamps, and arbitrary
message snippets are not correlation inputs.  Timestamps below serve only to
make an already supplied evidence sequence deterministic.
================================================== */

export const TINDER_PRODUCT_CONVERSATION_RECONCILIATION_MAX_CAPTURES = 1000;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export class TinderProductConversationReconciliationError extends Error {
  constructor(message, code = "INVALID_TINDER_PRODUCT_CONVERSATION_RECONCILIATION") {
    super(message);
    this.code = code;
  }
}

function invalid(message, code) {
  throw new TinderProductConversationReconciliationError(message, code);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sourceValue(source, camelCase, snakeCase) {
  return source?.[camelCase] ?? source?.[snakeCase];
}

function uuid(value, field) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UUID_V4.test(normalized)) invalid(`Invalid reconciliation ${field}.`, "INVALID_TINDER_PRODUCT_CONVERSATION_RECONCILIATION_RECORD");
  return normalized;
}

function hash(value, field) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA256_HEX.test(normalized)) invalid(`Invalid reconciliation ${field}.`, "INVALID_TINDER_PRODUCT_CONVERSATION_RECONCILIATION_RECORD");
  return normalized;
}

function timestamp(value, field) {
  const parsed = value instanceof Date ? new Date(value.valueOf()) : new Date(String(value || ""));
  if (Number.isNaN(parsed.valueOf())) invalid(`Invalid reconciliation ${field}.`, "INVALID_TINDER_PRODUCT_CONVERSATION_RECONCILIATION_RECORD");
  return parsed.toISOString();
}

function linkedFlag(value) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    invalid("Invalid reconciliation already-linked flag.", "INVALID_TINDER_PRODUCT_CONVERSATION_RECONCILIATION_RECORD");
  }
  return value;
}

function normalizeCapture(value) {
  if (!plainObject(value)) invalid("Invalid reconciliation capture.", "INVALID_TINDER_PRODUCT_CONVERSATION_RECONCILIATION_RECORD");
  const metadata = sourceValue(value, "visibleThreadMetadata", "visible_thread_metadata");
  const fingerprint = sourceValue(value, "runtimeThreadFingerprint", "runtime_thread_fingerprint")
    ?? sourceValue(metadata, "threadFingerprint", "thread_fingerprint");
  const capturedAt = timestamp(sourceValue(value, "capturedAt", "captured_at"), "capture time");
  const receivedAt = timestamp(sourceValue(value, "receivedAt", "received_at"), "receipt time");
  return Object.freeze({
    captureId: uuid(sourceValue(value, "captureId", "capture_id"), "capture id"),
    deviceId: uuid(sourceValue(value, "deviceId", "device_id"), "device id"),
    runtimeThreadFingerprint: hash(fingerprint, "thread correlation hint"),
    visibleMessages: normalizeTinderProductConversationMessages(sourceValue(value, "visibleMessages", "visible_messages")),
    capturedAt,
    receivedAt,
    alreadyLinked: linkedFlag(sourceValue(value, "alreadyLinked", "already_linked"))
  });
}

function evidenceOrder(left, right) {
  const capturedAt = Date.parse(left.capturedAt) - Date.parse(right.capturedAt);
  if (capturedAt !== 0) return capturedAt;
  const receivedAt = Date.parse(left.receivedAt) - Date.parse(right.receivedAt);
  if (receivedAt !== 0) return receivedAt;
  return left.captureId.localeCompare(right.captureId);
}

function bucketKey(capture) {
  return `${capture.deviceId}\u0000${capture.runtimeThreadFingerprint}`;
}

function planLink(capture, linkMethod) {
  return Object.freeze({ captureId: capture.captureId, linkMethod });
}

function createPlan(capture, correlationState) {
  return {
    deviceId: capture.deviceId,
    runtimeThreadFingerprintHint: capture.runtimeThreadFingerprint,
    correlationState,
    identityBindingState: TINDER_PRODUCT_CONVERSATION_IDENTITY_STATE.UNASSIGNED,
    historyState: TINDER_PRODUCT_CONVERSATION_HISTORY_STATE.PARTIAL,
    messages: capture.visibleMessages,
    captureLinks: [planLink(capture, TINDER_PRODUCT_CONVERSATION_LINK_METHOD.INITIAL)]
  };
}

function matchPlan(plan, capture, minimumOrderedOverlap) {
  const overlap = orderedDirectionalOverlap(plan.messages, capture.visibleMessages);
  return overlap.count >= minimumOrderedOverlap
    ? Object.freeze({ plan, overlap })
    : null;
}

function immutablePlan(plan, ordinal) {
  // The plan exposes only the references and states necessary for a later,
  // separately authorized application.  It deliberately does not serialize
  // message text, profile data, names, or timestamps.
  return Object.freeze({
    planOrdinal: ordinal,
    deviceId: plan.deviceId,
    runtimeThreadFingerprintHint: plan.runtimeThreadFingerprintHint,
    correlationState: plan.correlationState,
    identityBindingState: plan.identityBindingState,
    historyState: TINDER_PRODUCT_CONVERSATION_HISTORY_STATE.PARTIAL,
    captureLinks: Object.freeze(plan.captureLinks.slice()),
    requiresCurrentEvidenceRevalidation: true,
    automaticMergeAllowed: plan.correlationState !== TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.AMBIGUOUS
  });
}

function boundedSummary({ inputCaptureCount, skippedAlreadyLinkedCaptureCount, eligibleCaptureCount, plans }) {
  const summary = {
    inputCaptureCount,
    skippedAlreadyLinkedCaptureCount,
    eligibleCaptureCount,
    plannedCaptureCount: plans.reduce((count, plan) => count + plan.captureLinks.length, 0),
    planGroupCount: plans.length,
    provisionalPlanGroupCount: 0,
    correlatedPlanGroupCount: 0,
    ambiguousPlanGroupCount: 0,
    overlapLinkedCaptureCount: 0
  };
  for (const plan of plans) {
    if (plan.correlationState === TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.PROVISIONAL) summary.provisionalPlanGroupCount += 1;
    if (plan.correlationState === TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.CORRELATED) summary.correlatedPlanGroupCount += 1;
    if (plan.correlationState === TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.AMBIGUOUS) summary.ambiguousPlanGroupCount += 1;
    summary.overlapLinkedCaptureCount += plan.captureLinks.filter(link => link.linkMethod === TINDER_PRODUCT_CONVERSATION_LINK_METHOD.ORDERED_MESSAGE_OVERLAP).length;
  }
  return Object.freeze(summary);
}

/**
 * Produces a non-mutating, bounded reconciliation plan for unlinked immutable
 * captures.  Already-linked captures are explicitly skipped: this helper never
 * replays or changes historical capture/conversation links.
 */
export function analyzeTinderProductConversationReconciliation(input, {
  minimumOrderedOverlap = TINDER_PRODUCT_CONVERSATION_MINIMUM_ORDERED_OVERLAP
} = {}) {
  if (!plainObject(input) || !Array.isArray(input.captures)) {
    invalid("Reconciliation input must contain captures.", "INVALID_TINDER_PRODUCT_CONVERSATION_RECONCILIATION_INPUT");
  }
  if (input.captures.length > TINDER_PRODUCT_CONVERSATION_RECONCILIATION_MAX_CAPTURES) {
    invalid("Reconciliation capture input exceeds the bounded maximum.", "TINDER_PRODUCT_CONVERSATION_RECONCILIATION_INPUT_TOO_LARGE");
  }
  if (!Number.isInteger(minimumOrderedOverlap) || minimumOrderedOverlap < 2 || minimumOrderedOverlap > 100) {
    invalid("Reconciliation overlap must require at least two ordered messages.", "INVALID_TINDER_PRODUCT_CONVERSATION_RECONCILIATION_OVERLAP");
  }

  const captures = input.captures.map(normalizeCapture);
  const seenCaptureIds = new Set();
  for (const capture of captures) {
    if (seenCaptureIds.has(capture.captureId)) {
      invalid("Reconciliation input contains the same capture more than once.", "DUPLICATE_TINDER_PRODUCT_CONVERSATION_RECONCILIATION_CAPTURE");
    }
    seenCaptureIds.add(capture.captureId);
  }

  const skippedAlreadyLinked = captures.filter(capture => capture.alreadyLinked);
  const eligible = captures.filter(capture => !capture.alreadyLinked).sort(evidenceOrder);
  const plansByBucket = new Map();
  const plans = [];

  for (const capture of eligible) {
    const key = bucketKey(capture);
    const candidates = plansByBucket.get(key) || [];
    const matches = candidates
      .map(plan => matchPlan(plan, capture, minimumOrderedOverlap))
      .filter(Boolean);

    if (matches.length === 1) {
      const { plan } = matches[0];
      const merged = mergeOrderedTinderMessageHistory(plan.messages, capture.visibleMessages);
      // `matchPlan` has already required a valid edge-aware overlap.  Keep the
      // second check defensive so this pure planner cannot later weaken the
      // durable product store's correlation contract.
      if (!merged.merged) {
        invalid("Reconciliation overlap cannot be merged safely.", "TINDER_PRODUCT_CONVERSATION_RECONCILIATION_CORRELATION_INVALID");
      }
      plan.messages = merged.messages;
      plan.captureLinks.push(planLink(capture, TINDER_PRODUCT_CONVERSATION_LINK_METHOD.ORDERED_MESSAGE_OVERLAP));
      if (plan.correlationState !== TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.AMBIGUOUS) {
        plan.correlationState = TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.CORRELATED;
      }
      continue;
    }

    const plan = createPlan(capture, matches.length > 1
      ? TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.AMBIGUOUS
      : TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.PROVISIONAL);
    candidates.push(plan);
    plansByBucket.set(key, candidates);
    plans.push(plan);
  }

  const immutablePlans = Object.freeze(plans.map((plan, index) => immutablePlan(plan, index + 1)));
  return Object.freeze({
    summary: boundedSummary({
      inputCaptureCount: captures.length,
      skippedAlreadyLinkedCaptureCount: skippedAlreadyLinked.length,
      eligibleCaptureCount: eligible.length,
      plans: immutablePlans
    }),
    plans: immutablePlans
  });
}
