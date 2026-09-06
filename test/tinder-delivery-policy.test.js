import assert from "node:assert/strict";
import test from "node:test";
import {
  TINDER_DELIVERY_POLICY_DECISION,
  TINDER_DELIVERY_POLICY_REASON,
  createTinderDeliveryPolicy
} from "../services/tinder-delivery-policy.js";

const CONTEXT = { contactId: 7, workItemId: "work-item-7" };

test("missing T7 delivery policy fails closed", async () => {
  const policy = createTinderDeliveryPolicy();
  const result = await policy.evaluate(CONTEXT);
  assert.equal(result.decision, TINDER_DELIVERY_POLICY_DECISION.BLOCKED);
  assert.equal(result.reason, TINDER_DELIVERY_POLICY_REASON.POLICY_UNAVAILABLE);
  assert.equal(result.permitsSend, false);
  assert.equal(result.requiresManualApproval, true);
});

test("trusted policy can only allow a draft that still requires manual approval", async () => {
  let received;
  const policy = createTinderDeliveryPolicy({
    async getPolicy(context) {
      received = context;
      return {
        revision: "delivery-policy-v1",
        allowDraft: true,
        requireManualApproval: true,
        allowAutomatedSend: false
      };
    }
  });
  const result = await policy.evaluate(CONTEXT);
  assert.deepEqual(received, { channel: "tinder", contactId: 7, workItemId: "work-item-7" });
  assert.equal(result.decision, TINDER_DELIVERY_POLICY_DECISION.DRAFT_ONLY);
  assert.equal(result.policyRevision, "delivery-policy-v1");
  assert.equal(result.requiresManualApproval, true);
  assert.equal(result.permitsSend, false);
});

test("automatic approval or automatic send is rejected rather than normalized", async () => {
  const automaticApproval = createTinderDeliveryPolicy({
    async getPolicy() {
      return { revision: "v1", allowDraft: true, requireManualApproval: false, allowAutomatedSend: false };
    }
  });
  assert.equal((await automaticApproval.evaluate(CONTEXT)).reason,
    TINDER_DELIVERY_POLICY_REASON.AUTOMATIC_APPROVAL_UNSUPPORTED);

  const automaticSend = createTinderDeliveryPolicy({
    async getPolicy() {
      return { revision: "v1", allowDraft: true, requireManualApproval: true, allowAutomatedSend: true };
    }
  });
  assert.equal((await automaticSend.evaluate(CONTEXT)).reason,
    TINDER_DELIVERY_POLICY_REASON.AUTOMATIC_SEND_UNSUPPORTED);
});
