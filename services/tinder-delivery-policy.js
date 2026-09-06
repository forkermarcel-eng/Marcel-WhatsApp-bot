/* ==================================================
T7 DELIVERY POLICY FOUNDATION

There is intentionally no timing curve, delivery client, or automatic approval
in this module. It accepts only a trusted server-side policy provider and can
at most authorize creation of a draft that remains pending a human approval.
================================================== */

const TINDER_DELIVERY_POLICY_DECISION = Object.freeze({
  BLOCKED: "BLOCKED",
  DRAFT_ONLY: "DRAFT_ONLY"
});

const TINDER_DELIVERY_POLICY_REASON = Object.freeze({
  POLICY_UNAVAILABLE: "POLICY_UNAVAILABLE",
  POLICY_INVALID: "POLICY_INVALID",
  AUTOMATIC_APPROVAL_UNSUPPORTED: "AUTOMATIC_APPROVAL_UNSUPPORTED",
  AUTOMATIC_SEND_UNSUPPORTED: "AUTOMATIC_SEND_UNSUPPORTED",
  DRAFT_NOT_ALLOWED: "DRAFT_NOT_ALLOWED"
});

class TinderDeliveryPolicyError extends Error {
  constructor(message, code = "TINDER_DELIVERY_POLICY_ERROR", statusCode = 409) {
    super(message);
    this.name = "TinderDeliveryPolicyError";
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

function blocked(reason) {
  return Object.freeze({
    decision: TINDER_DELIVERY_POLICY_DECISION.BLOCKED,
    reason,
    policyRevision: null,
    requiresManualApproval: true,
    permitsSend: false
  });
}

function validatePolicy(policy) {
  if (!plainObject(policy)) return null;
  const revision = nonEmptyText(policy.revision);
  if (!revision) return null;
  if (policy.allowDraft !== true) return Object.freeze({ invalidReason: TINDER_DELIVERY_POLICY_REASON.DRAFT_NOT_ALLOWED });
  if (policy.requireManualApproval !== true) {
    return Object.freeze({ invalidReason: TINDER_DELIVERY_POLICY_REASON.AUTOMATIC_APPROVAL_UNSUPPORTED });
  }
  if (policy.allowAutomatedSend !== false) {
    return Object.freeze({ invalidReason: TINDER_DELIVERY_POLICY_REASON.AUTOMATIC_SEND_UNSUPPORTED });
  }
  return Object.freeze({ revision });
}

/*
 * This is a server-only adapter boundary. The input intentionally carries no
 * draft text or client-controlled policy values, so it cannot become a second
 * send path or a transport for message content.
 */
function createTinderDeliveryPolicy({ getPolicy } = {}) {
  if (getPolicy !== undefined && typeof getPolicy !== "function") {
    throw new TypeError("getPolicy must be a function when provided");
  }

  async function evaluate({ contactId, workItemId } = {}) {
    if (positiveInteger(contactId) === null || !nonEmptyText(workItemId, 80)) {
      throw new TinderDeliveryPolicyError("T7 policy request is invalid.", "INVALID_POLICY_CONTEXT", 400);
    }
    if (typeof getPolicy !== "function") return blocked(TINDER_DELIVERY_POLICY_REASON.POLICY_UNAVAILABLE);

    const result = validatePolicy(await getPolicy(Object.freeze({
      channel: "tinder",
      contactId: Number(contactId),
      workItemId: String(workItemId)
    })));
    if (!result) return blocked(TINDER_DELIVERY_POLICY_REASON.POLICY_INVALID);
    if (result.invalidReason) return blocked(result.invalidReason);
    return Object.freeze({
      decision: TINDER_DELIVERY_POLICY_DECISION.DRAFT_ONLY,
      reason: null,
      policyRevision: result.revision,
      requiresManualApproval: true,
      permitsSend: false
    });
  }

  return Object.freeze({ evaluate });
}

export {
  TINDER_DELIVERY_POLICY_DECISION,
  TINDER_DELIVERY_POLICY_REASON,
  TinderDeliveryPolicyError,
  createTinderDeliveryPolicy
};
