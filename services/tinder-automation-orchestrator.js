/* ==================================================
T7 TINDER AUTOMATION ORCHESTRATOR FOUNDATION

This is deliberately not registered with application startup. A claimed T6
work item can only become a T4 draft after every T7 gate and a trusted
server-side DRAFT_ONLY policy pass. It never creates an approval, sealed send
intent, device command, or delivery request.
================================================== */

import { TINDER_DELIVERY_POLICY_DECISION } from "./tinder-delivery-policy.js";

const TINDER_AUTOMATION_WORK_OUTCOME = Object.freeze({
  BLOCKED: "BLOCKED",
  DRAFT_READY_FOR_MANUAL_APPROVAL: "DRAFT_READY_FOR_MANUAL_APPROVAL"
});

const TINDER_AUTOMATION_WORK_BLOCK_REASON = Object.freeze({
  DELIVERY_POLICY_BLOCKED: "DELIVERY_POLICY_BLOCKED",
  DELIVERY_POLICY_UNSAFE: "DELIVERY_POLICY_UNSAFE",
  DRAFT_CREATION_FAILED: "DRAFT_CREATION_FAILED"
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class TinderAutomationOrchestratorError extends Error {
  constructor(message, code = "TINDER_AUTOMATION_ORCHESTRATOR_ERROR", statusCode = 409) {
    super(message);
    this.name = "TinderAutomationOrchestratorError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function nonEmptyText(value, maximum = 160) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maximum ? text : null;
}

function sourceValue(source, camelCase, snakeCase) {
  return source?.[camelCase] ?? source?.[snakeCase];
}

function normalizeWorkItem(value) {
  if (!plainObject(value)) {
    throw new TinderAutomationOrchestratorError("T7 work-item claim is invalid.", "INVALID_WORK_ITEM", 500);
  }
  const workItemId = nonEmptyText(sourceValue(value, "workItemId", "work_item_id"), 80);
  const contactId = positiveInteger(sourceValue(value, "contactId", "contact_id"));
  const captureId = String(sourceValue(value, "captureId", "capture_id") || "").trim();
  const queueStatus = String(sourceValue(value, "queueStatus", "queue_status") || "").trim().toUpperCase();
  if (!workItemId || contactId === null || !UUID_V4.test(captureId) || queueStatus !== "ELIGIBLE_FOR_NEXT_STAGE") {
    throw new TinderAutomationOrchestratorError("T7 work-item claim is invalid.", "INVALID_WORK_ITEM", 500);
  }
  return Object.freeze({
    workItemId,
    contactId,
    captureId,
    queueStatus,
    conversationState: String(sourceValue(value, "conversationState", "conversation_state") || "").trim().toUpperCase()
  });
}

function requireDependencies({ workRepository, controlService, deliveryPolicy, draftService }) {
  for (const [owner, methods] of [
    [workRepository, ["recordBlocked", "recordDraftReady"]],
    [controlService, ["evaluate"]],
    [deliveryPolicy, ["evaluate"]],
    [draftService, ["createDraft"]]
  ]) {
    for (const method of methods) {
      if (typeof owner?.[method] !== "function") throw new TypeError(`${method} must be a function`);
    }
  }
}

function normalizedDraftId(value) {
  const draftId = String(value?.draftId ?? value?.draft_id ?? "").trim();
  if (!UUID_V4.test(draftId)) {
    throw new TinderAutomationOrchestratorError("T4 draft result cannot be safely bound.", "INVALID_DRAFT_RESULT", 500);
  }
  return draftId;
}

function blockedResult(workItem, reason) {
  return Object.freeze({
    outcome: TINDER_AUTOMATION_WORK_OUTCOME.BLOCKED,
    workItemId: workItem.workItemId,
    contactId: workItem.contactId,
    reason
  });
}

function safeBlockReason(value) {
  return nonEmptyText(value, 120) || TINDER_AUTOMATION_WORK_BLOCK_REASON.DELIVERY_POLICY_BLOCKED;
}

function createTinderAutomationOrchestrator({
  workRepository,
  controlService,
  deliveryPolicy,
  draftService
} = {}) {
  requireDependencies({ workRepository, controlService, deliveryPolicy, draftService });

  async function recordBlocked(workItem, leaseToken, reason) {
    await workRepository.recordBlocked(Object.freeze({
      workItemId: workItem.workItemId,
      leaseToken,
      reason: safeBlockReason(reason)
    }));
    return blockedResult(workItem, safeBlockReason(reason));
  }

  async function processClaim({ workItem, leaseToken, runtime } = {}) {
    const normalizedWorkItem = normalizeWorkItem(workItem);
    const normalizedLeaseToken = nonEmptyText(leaseToken, 160);
    if (!normalizedLeaseToken) {
      throw new TinderAutomationOrchestratorError("T7 claim has no valid lease token.", "INVALID_LEASE_TOKEN", 500);
    }

    const control = await controlService.evaluate({
      contactId: normalizedWorkItem.contactId,
      runtime,
      workItem: normalizedWorkItem
    });
    if (!plainObject(control) || control.allowed !== true) {
      return recordBlocked(normalizedWorkItem, normalizedLeaseToken, control?.reason || "AUTOMATION_CONTROL_UNAVAILABLE");
    }

    const policy = await deliveryPolicy.evaluate({
      contactId: normalizedWorkItem.contactId,
      workItemId: normalizedWorkItem.workItemId
    });
    if (!plainObject(policy) || policy.decision !== TINDER_DELIVERY_POLICY_DECISION.DRAFT_ONLY) {
      return recordBlocked(normalizedWorkItem, normalizedLeaseToken, policy?.reason || TINDER_AUTOMATION_WORK_BLOCK_REASON.DELIVERY_POLICY_BLOCKED);
    }
    if (policy.requiresManualApproval !== true || policy.permitsSend !== false || !nonEmptyText(policy.policyRevision, 160)) {
      return recordBlocked(normalizedWorkItem, normalizedLeaseToken, TINDER_AUTOMATION_WORK_BLOCK_REASON.DELIVERY_POLICY_UNSAFE);
    }

    let draftId;
    try {
      draftId = normalizedDraftId(await draftService.createDraft(Object.freeze({ captureId: normalizedWorkItem.captureId })));
    } catch (_error) {
      return recordBlocked(normalizedWorkItem, normalizedLeaseToken, TINDER_AUTOMATION_WORK_BLOCK_REASON.DRAFT_CREATION_FAILED);
    }

    await workRepository.recordDraftReady(Object.freeze({
      workItemId: normalizedWorkItem.workItemId,
      leaseToken: normalizedLeaseToken,
      draftId,
      policyRevision: policy.policyRevision,
      requiresManualApproval: true
    }));
    return Object.freeze({
      outcome: TINDER_AUTOMATION_WORK_OUTCOME.DRAFT_READY_FOR_MANUAL_APPROVAL,
      workItemId: normalizedWorkItem.workItemId,
      contactId: normalizedWorkItem.contactId,
      draftId,
      requiresManualApproval: true
    });
  }

  return Object.freeze({ processClaim });
}

export {
  TINDER_AUTOMATION_WORK_BLOCK_REASON,
  TINDER_AUTOMATION_WORK_OUTCOME,
  TinderAutomationOrchestratorError,
  createTinderAutomationOrchestrator
};
