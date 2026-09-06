/* ==================================================
T7 TINDER AUTOMATION CONTROL FOUNDATION

This module is deliberately server-side and inert. It has no route, timer,
worker registration, device command, draft, or delivery dependency. A fresh
process always starts with its runtime authorization closed, even when future
durable control storage contains a historical RUNNING value.
================================================== */

const TINDER_AUTOMATION_GLOBAL_STATE = Object.freeze({
  STOPPED: "STOPPED",
  RUNNING: "RUNNING",
  PAUSED: "PAUSED",
  BLOCKED: "BLOCKED"
});

const TINDER_AUTOMATION_CONTACT_STATE = Object.freeze({
  DISABLED: "DISABLED",
  ENABLED: "ENABLED",
  PAUSED: "PAUSED",
  BLOCKED: "BLOCKED"
});

const TINDER_AUTOMATION_OPERATION_STATE = Object.freeze({
  ACTIVE: "ACTIVE",
  REST_PHASE: "REST_PHASE"
});

const TINDER_AUTOMATION_GATE_REASON = Object.freeze({
  RUNTIME_APPROVAL_REQUIRED: "RUNTIME_APPROVAL_REQUIRED",
  GLOBAL_STOPPED: "GLOBAL_STOPPED",
  GLOBAL_PAUSED: "GLOBAL_PAUSED",
  GLOBAL_BLOCKED: "GLOBAL_BLOCKED",
  GLOBAL_CONTROL_INVALID: "GLOBAL_CONTROL_INVALID",
  GLOBAL_POLICY_UNVERIFIABLE: "GLOBAL_POLICY_UNVERIFIABLE",
  CONTACT_CONTROL_MISSING: "CONTACT_CONTROL_MISSING",
  CONTACT_DISABLED: "CONTACT_DISABLED",
  CONTACT_PAUSED: "CONTACT_PAUSED",
  CONTACT_BLOCKED: "CONTACT_BLOCKED",
  CONTACT_CONTROL_INVALID: "CONTACT_CONTROL_INVALID",
  IDENTITY_NOT_CONFIRMED: "IDENTITY_NOT_CONFIRMED",
  AUTO_REPLY_DISABLED: "AUTO_REPLY_DISABLED",
  HUMAN_TAKEOVER_ACTIVE: "HUMAN_TAKEOVER_ACTIVE",
  HANDOFF_ACTIVE: "HANDOFF_ACTIVE",
  DATE_LOCK_ACTIVE: "DATE_LOCK_ACTIVE",
  MANUAL_REVIEW_REQUIRED: "MANUAL_REVIEW_REQUIRED",
  DEVICE_ENROLLMENT_INACTIVE: "DEVICE_ENROLLMENT_INACTIVE",
  BRIDGE_NOT_RUNNING: "BRIDGE_NOT_RUNNING",
  TINDER_NOT_CONNECTED: "TINDER_NOT_CONNECTED",
  DEVICE_AUTOMATION_NOT_RUNNING: "DEVICE_AUTOMATION_NOT_RUNNING",
  REST_PHASE_ACTIVE: "REST_PHASE_ACTIVE",
  WAITING_FOR_HER: "WAITING_FOR_HER",
  WORK_ITEM_INVALID: "WORK_ITEM_INVALID"
});

class TinderAutomationControlError extends Error {
  constructor(message, code = "TINDER_AUTOMATION_CONTROL_ERROR", statusCode = 409) {
    super(message);
    this.name = "TinderAutomationControlError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedState(value) {
  return String(value ?? "").trim().toUpperCase();
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

function gate(allowed, reason = null, details = {}) {
  return Object.freeze({
    allowed: allowed === true,
    reason: allowed === true ? null : reason,
    ...details
  });
}

function defaultGlobalControl() {
  return Object.freeze({
    state: TINDER_AUTOMATION_GLOBAL_STATE.STOPPED,
    operationState: TINDER_AUTOMATION_OPERATION_STATE.ACTIVE,
    explicitApproval: false,
    policyRevision: null
  });
}

function normalizeGlobalControl(value) {
  if (!plainObject(value)) return defaultGlobalControl();
  const state = normalizedState(sourceValue(value, "state", "state"));
  const operationState = normalizedState(sourceValue(value, "operationState", "operation_state"));
  return Object.freeze({
    state: Object.values(TINDER_AUTOMATION_GLOBAL_STATE).includes(state) ? state : null,
    operationState: Object.values(TINDER_AUTOMATION_OPERATION_STATE).includes(operationState)
      ? operationState
      : null,
    explicitApproval: sourceValue(value, "explicitApproval", "explicit_approval") === true,
    policyRevision: nonEmptyText(sourceValue(value, "policyRevision", "policy_revision"))
  });
}

function normalizeContactControl(value, expectedContactId) {
  if (!plainObject(value)) return null;
  const contactId = positiveInteger(sourceValue(value, "contactId", "contact_id"));
  if (contactId === null || contactId !== expectedContactId) return null;
  const state = normalizedState(sourceValue(value, "state", "state"));
  return Object.freeze({
    contactId,
    state: Object.values(TINDER_AUTOMATION_CONTACT_STATE).includes(state) ? state : null,
    identityConfirmed: sourceValue(value, "identityConfirmed", "identity_confirmed"),
    autoReplyEnabled: sourceValue(value, "autoReplyEnabled", "auto_reply_enabled"),
    humanTakeoverActive: sourceValue(value, "humanTakeoverActive", "human_takeover_active"),
    handoffActive: sourceValue(value, "handoffActive", "handoff_active"),
    dateLockEnabled: sourceValue(value, "dateLockEnabled", "date_lock_enabled"),
    manualReviewRequired: sourceValue(value, "manualReviewRequired", "manual_review_required")
  });
}

function normalizeRuntime(value) {
  if (!plainObject(value)) return null;
  return Object.freeze({
    enrollmentState: normalizedState(sourceValue(value, "enrollmentState", "enrollment_state")),
    bridgeServiceState: normalizedState(sourceValue(value, "bridgeServiceState", "bridge_service_state")),
    tinderState: normalizedState(sourceValue(value, "tinderState", "tinder_state")),
    automationState: normalizedState(sourceValue(value, "automationState", "automation_state"))
  });
}

function normalizeWorkItem(value, expectedContactId) {
  if (!plainObject(value)) return null;
  const contactId = positiveInteger(sourceValue(value, "contactId", "contact_id"));
  if (contactId === null || contactId !== expectedContactId) return null;
  return Object.freeze({
    contactId,
    conversationState: normalizedState(sourceValue(value, "conversationState", "conversation_state")),
    queueStatus: normalizedState(sourceValue(value, "queueStatus", "queue_status"))
  });
}

function evaluateTinderAutomationGate({
  globalControl,
  contactControl,
  runtime,
  workItem,
  runtimeApproved = false
} = {}) {
  const contactId = positiveInteger(sourceValue(workItem, "contactId", "contact_id") ?? sourceValue(contactControl, "contactId", "contact_id"));
  if (contactId === null) return gate(false, TINDER_AUTOMATION_GATE_REASON.WORK_ITEM_INVALID);
  if (runtimeApproved !== true) return gate(false, TINDER_AUTOMATION_GATE_REASON.RUNTIME_APPROVAL_REQUIRED);

  const global = normalizeGlobalControl(globalControl);
  if (!global.state || !global.operationState) return gate(false, TINDER_AUTOMATION_GATE_REASON.GLOBAL_CONTROL_INVALID);
  if (global.state === TINDER_AUTOMATION_GLOBAL_STATE.STOPPED) return gate(false, TINDER_AUTOMATION_GATE_REASON.GLOBAL_STOPPED);
  if (global.state === TINDER_AUTOMATION_GLOBAL_STATE.PAUSED) return gate(false, TINDER_AUTOMATION_GATE_REASON.GLOBAL_PAUSED);
  if (global.state === TINDER_AUTOMATION_GLOBAL_STATE.BLOCKED) return gate(false, TINDER_AUTOMATION_GATE_REASON.GLOBAL_BLOCKED);
  if (global.state !== TINDER_AUTOMATION_GLOBAL_STATE.RUNNING || !global.explicitApproval || !global.policyRevision) {
    return gate(false, TINDER_AUTOMATION_GATE_REASON.GLOBAL_POLICY_UNVERIFIABLE);
  }
  if (global.operationState === TINDER_AUTOMATION_OPERATION_STATE.REST_PHASE) {
    return gate(false, TINDER_AUTOMATION_GATE_REASON.REST_PHASE_ACTIVE);
  }

  const contact = normalizeContactControl(contactControl, contactId);
  if (!contact) return gate(false, TINDER_AUTOMATION_GATE_REASON.CONTACT_CONTROL_MISSING);
  if (!contact.state) return gate(false, TINDER_AUTOMATION_GATE_REASON.CONTACT_CONTROL_INVALID);
  if (contact.state === TINDER_AUTOMATION_CONTACT_STATE.DISABLED) return gate(false, TINDER_AUTOMATION_GATE_REASON.CONTACT_DISABLED);
  if (contact.state === TINDER_AUTOMATION_CONTACT_STATE.PAUSED) return gate(false, TINDER_AUTOMATION_GATE_REASON.CONTACT_PAUSED);
  if (contact.state === TINDER_AUTOMATION_CONTACT_STATE.BLOCKED) return gate(false, TINDER_AUTOMATION_GATE_REASON.CONTACT_BLOCKED);
  if (contact.state !== TINDER_AUTOMATION_CONTACT_STATE.ENABLED) return gate(false, TINDER_AUTOMATION_GATE_REASON.CONTACT_CONTROL_INVALID);
  if (contact.identityConfirmed !== true) return gate(false, TINDER_AUTOMATION_GATE_REASON.IDENTITY_NOT_CONFIRMED);
  if (contact.autoReplyEnabled !== true) return gate(false, TINDER_AUTOMATION_GATE_REASON.AUTO_REPLY_DISABLED);
  if (contact.humanTakeoverActive !== false) return gate(false, TINDER_AUTOMATION_GATE_REASON.HUMAN_TAKEOVER_ACTIVE);
  if (contact.handoffActive !== false) return gate(false, TINDER_AUTOMATION_GATE_REASON.HANDOFF_ACTIVE);
  if (contact.dateLockEnabled !== false) return gate(false, TINDER_AUTOMATION_GATE_REASON.DATE_LOCK_ACTIVE);
  if (contact.manualReviewRequired !== false) return gate(false, TINDER_AUTOMATION_GATE_REASON.MANUAL_REVIEW_REQUIRED);

  const normalizedWorkItem = normalizeWorkItem(workItem, contactId);
  if (!normalizedWorkItem || normalizedWorkItem.queueStatus !== "ELIGIBLE_FOR_NEXT_STAGE") {
    return gate(false, TINDER_AUTOMATION_GATE_REASON.WORK_ITEM_INVALID);
  }
  if (normalizedWorkItem.conversationState === "WAITING_FOR_HER") {
    return gate(false, TINDER_AUTOMATION_GATE_REASON.WAITING_FOR_HER);
  }

  const device = normalizeRuntime(runtime);
  if (!device || device.enrollmentState !== "ACTIVE") return gate(false, TINDER_AUTOMATION_GATE_REASON.DEVICE_ENROLLMENT_INACTIVE);
  if (device.bridgeServiceState !== "RUNNING") return gate(false, TINDER_AUTOMATION_GATE_REASON.BRIDGE_NOT_RUNNING);
  if (device.tinderState !== "CONNECTED") return gate(false, TINDER_AUTOMATION_GATE_REASON.TINDER_NOT_CONNECTED);
  if (device.automationState !== "RUNNING") return gate(false, TINDER_AUTOMATION_GATE_REASON.DEVICE_AUTOMATION_NOT_RUNNING);

  return gate(true, null, { policyRevision: global.policyRevision });
}

function requireRepository(repository) {
  for (const method of ["getGlobalControl", "getContactControl"]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
}

/*
 * The process-local authorization is intentionally never persisted. Future
 * protected control routes may call requestRuntimeStart after a human action;
 * loading this module or restarting Node can never restore it.
 */
function createTinderAutomationControlService({ repository } = {}) {
  requireRepository(repository);
  let runtimeApproved = false;

  function runtimeStatus() {
    return Object.freeze({
      state: runtimeApproved ? TINDER_AUTOMATION_GLOBAL_STATE.RUNNING : TINDER_AUTOMATION_GLOBAL_STATE.STOPPED,
      runtimeApproved
    });
  }

  function requestRuntimeStart({ explicitApproval, actor } = {}) {
    if (explicitApproval !== true || !nonEmptyText(actor, 120)) {
      throw new TinderAutomationControlError("T7 runtime requires explicit approval.", "EXPLICIT_RUNTIME_APPROVAL_REQUIRED", 403);
    }
    runtimeApproved = true;
    return runtimeStatus();
  }

  function stopRuntime() {
    runtimeApproved = false;
    return runtimeStatus();
  }

  async function evaluate({ contactId, runtime, workItem } = {}) {
    const normalizedContactId = positiveInteger(contactId);
    if (normalizedContactId === null) return gate(false, TINDER_AUTOMATION_GATE_REASON.WORK_ITEM_INVALID);
    const globalControl = await repository.getGlobalControl();
    const contactControl = await repository.getContactControl(normalizedContactId);
    return evaluateTinderAutomationGate({
      globalControl,
      contactControl,
      runtime,
      workItem,
      runtimeApproved
    });
  }

  return Object.freeze({
    evaluate,
    requestRuntimeStart,
    runtimeStatus,
    stopRuntime
  });
}

export {
  TINDER_AUTOMATION_CONTACT_STATE,
  TINDER_AUTOMATION_GATE_REASON,
  TINDER_AUTOMATION_GLOBAL_STATE,
  TINDER_AUTOMATION_OPERATION_STATE,
  TinderAutomationControlError,
  createTinderAutomationControlService,
  evaluateTinderAutomationGate
};
