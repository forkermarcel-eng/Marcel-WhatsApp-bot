import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzeTinderProductConversationReconciliation,
  TINDER_PRODUCT_CONVERSATION_RECONCILIATION_MAX_CAPTURES
} from "../services/tinder-product-conversation-reconciliation.js";

const DEVICE_A = "e880455d-325c-4f35-9914-823dcb0e0d18";
const DEVICE_B = "066af011-d1fb-4694-af6f-ae22f3b1be32";
const THREAD_A = "a".repeat(64);
const THREAD_B = "b".repeat(64);

function id(index) {
  return `a565e8a7-ef60-42d0-b19d-${String(index).padStart(12, "0")}`;
}

function messages(...items) {
  return items.map(([direction, text], index) => ({
    visibleOrder: index + 1,
    direction,
    text
  }));
}

function capture(index, sequence, {
  deviceId = DEVICE_A,
  threadHint = THREAD_A,
  alreadyLinked = false,
  capturedAt = `2026-09-22T10:${String(index).padStart(2, "0")}:00.000Z`,
  displayName = "ignored visible label"
} = {}) {
  return {
    captureId: id(index),
    deviceId,
    runtimeThreadFingerprint: threadHint,
    visibleMessages: messages(...sequence),
    capturedAt,
    receivedAt: capturedAt,
    alreadyLinked,
    displayName
  };
}

function captureIds(plan) {
  return plan.captureLinks.map(link => link.captureId);
}

test("plans a unique directional two-message overlap and skips already-linked evidence", () => {
  const result = analyzeTinderProductConversationReconciliation({
    captures: [
      capture(1, [["INCOMING", "already"], ["OUTGOING", "linked"]], { alreadyLinked: true }),
      capture(2, [["INCOMING", "one"], ["OUTGOING", "two"], ["INCOMING", "three"]]),
      capture(3, [["OUTGOING", "two"], ["INCOMING", "three"], ["OUTGOING", "four"]])
    ]
  });

  assert.deepEqual(result.summary, {
    inputCaptureCount: 3,
    skippedAlreadyLinkedCaptureCount: 1,
    eligibleCaptureCount: 2,
    plannedCaptureCount: 2,
    planGroupCount: 1,
    provisionalPlanGroupCount: 0,
    correlatedPlanGroupCount: 1,
    ambiguousPlanGroupCount: 0,
    overlapLinkedCaptureCount: 1
  });
  assert.equal(result.plans.length, 1);
  assert.deepEqual(captureIds(result.plans[0]), [id(2), id(3)]);
  assert.deepEqual(result.plans[0].captureLinks.map(link => link.linkMethod), ["INITIAL", "ORDERED_MESSAGE_OVERLAP"]);
  assert.equal(result.plans[0].identityBindingState, "UNASSIGNED");
  assert.equal(result.plans[0].historyState, "PARTIAL");
  assert.equal(result.plans[0].correlationState, "CORRELATED");
});

test("does not treat a fingerprint, visible name, timestamp, or unordered text as identity", () => {
  const result = analyzeTinderProductConversationReconciliation({
    captures: [
      capture(4, [["INCOMING", "same"], ["OUTGOING", "sequence"]], { displayName: "first label" }),
      capture(5, [["OUTGOING", "same"], ["INCOMING", "sequence"]], { displayName: "first label" }),
      capture(6, [["INCOMING", "same"], ["OUTGOING", "sequence"]], { deviceId: DEVICE_B, displayName: "first label" }),
      capture(7, [["INCOMING", "same"], ["OUTGOING", "sequence"]], { threadHint: THREAD_B, displayName: "first label" })
    ]
  });

  assert.equal(result.summary.planGroupCount, 4);
  assert.equal(result.summary.provisionalPlanGroupCount, 4);
  assert.equal(result.summary.overlapLinkedCaptureCount, 0);
  assert.ok(result.plans.every(plan => plan.correlationState === "PROVISIONAL"));
});

test("creates a separate ambiguous plan instead of merging where two candidates overlap", () => {
  const result = analyzeTinderProductConversationReconciliation({
    captures: [
      capture(8, [["INCOMING", "alpha"], ["OUTGOING", "one"], ["INCOMING", "two"]]),
      capture(9, [["INCOMING", "beta"], ["OUTGOING", "one"], ["INCOMING", "two"]]),
      capture(10, [["OUTGOING", "one"], ["INCOMING", "two"], ["OUTGOING", "three"]])
    ]
  });

  // The first two observations share only a suffix, so neither joins the
  // other at an edge. Capture 10 can join either one with the same two-message
  // overlap and must therefore remain a separate ambiguous plan.
  assert.equal(result.summary.planGroupCount, 3);
  assert.equal(result.summary.ambiguousPlanGroupCount, 1);
  const ambiguous = result.plans.find(plan => plan.correlationState === "AMBIGUOUS");
  assert.deepEqual(captureIds(ambiguous), [id(10)]);
  assert.equal(ambiguous.automaticMergeAllowed, false);
});

test("plan output contains only references and bounded state, never visible message content", () => {
  const result = analyzeTinderProductConversationReconciliation({
    captures: [capture(13, [["INCOMING", "sensitive visible text"], ["OUTGOING", "private answer"]])]
  });

  const serializedPlans = JSON.stringify(result.plans);
  assert.doesNotMatch(serializedPlans, /sensitive visible text|private answer|ignored visible label/);
  assert.equal(result.plans[0].historyState, "PARTIAL");
  assert.equal(result.plans[0].requiresCurrentEvidenceRevalidation, true);
});

test("rejects oversized and duplicate evidence input before producing a plan", () => {
  const first = capture(14, [["INCOMING", "one"], ["OUTGOING", "two"]]);
  assert.throws(
    () => analyzeTinderProductConversationReconciliation({ captures: [first, first] }),
    error => error?.code === "DUPLICATE_TINDER_PRODUCT_CONVERSATION_RECONCILIATION_CAPTURE"
  );

  assert.throws(
    () => analyzeTinderProductConversationReconciliation({ captures: Array.from({ length: TINDER_PRODUCT_CONVERSATION_RECONCILIATION_MAX_CAPTURES + 1 }, () => first) }),
    error => error?.code === "TINDER_PRODUCT_CONVERSATION_RECONCILIATION_INPUT_TOO_LARGE"
  );
});
