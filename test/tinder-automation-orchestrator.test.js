import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  TINDER_AUTOMATION_WORK_BLOCK_REASON,
  TINDER_AUTOMATION_WORK_OUTCOME,
  createTinderAutomationOrchestrator
} from "../services/tinder-automation-orchestrator.js";
import { TINDER_DELIVERY_POLICY_DECISION } from "../services/tinder-delivery-policy.js";

const CAPTURE_ID = "6c7308cf-5d40-423d-913b-c4424f7e4ee0";
const DRAFT_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";

function claim(overrides = {}) {
  return {
    workItem: {
      work_item_id: "work-7",
      contact_id: 7,
      capture_id: CAPTURE_ID,
      queue_status: "ELIGIBLE_FOR_NEXT_STAGE",
      conversation_state: "WAITING_FOR_US",
      ...overrides
    },
    leaseToken: "lease-7",
    runtime: { enrollment_state: "ACTIVE" }
  };
}

function fixture({ control = { allowed: true }, policy, draftResult = { draft_id: DRAFT_ID }, draftError } = {}) {
  const state = { blocked: [], draftReady: [], draftCalls: 0 };
  const workRepository = {
    async recordBlocked(value) { state.blocked.push(value); },
    async recordDraftReady(value) { state.draftReady.push(value); }
  };
  const controlService = { async evaluate() { return control; } };
  const deliveryPolicy = {
    async evaluate() {
      return policy || {
        decision: TINDER_DELIVERY_POLICY_DECISION.DRAFT_ONLY,
        policyRevision: "delivery-policy-v1",
        requiresManualApproval: true,
        permitsSend: false
      };
    }
  };
  const draftService = {
    async createDraft(value) {
      state.draftCalls += 1;
      state.draftInput = value;
      if (draftError) throw draftError;
      return draftResult;
    }
  };
  return {
    state,
    service: createTinderAutomationOrchestrator({ workRepository, controlService, deliveryPolicy, draftService })
  };
}

test("blocked T7 gate records bounded reason and never invokes T4", async () => {
  const { state, service } = fixture({ control: { allowed: false, reason: "HUMAN_TAKEOVER_ACTIVE" } });
  const result = await service.processClaim(claim());
  assert.equal(result.outcome, TINDER_AUTOMATION_WORK_OUTCOME.BLOCKED);
  assert.equal(result.reason, "HUMAN_TAKEOVER_ACTIVE");
  assert.equal(state.draftCalls, 0);
  assert.deepEqual(state.blocked, [{ workItemId: "work-7", leaseToken: "lease-7", reason: "HUMAN_TAKEOVER_ACTIVE" }]);
  assert.equal(state.draftReady.length, 0);
});

test("approved DRAFT_ONLY policy may create a T4 draft but cannot create an approval or send", async () => {
  const { state, service } = fixture();
  const result = await service.processClaim(claim());
  assert.deepEqual(result, {
    outcome: TINDER_AUTOMATION_WORK_OUTCOME.DRAFT_READY_FOR_MANUAL_APPROVAL,
    workItemId: "work-7",
    contactId: 7,
    draftId: DRAFT_ID,
    requiresManualApproval: true
  });
  assert.deepEqual(state.draftInput, { captureId: CAPTURE_ID });
  assert.deepEqual(state.draftReady, [{
    workItemId: "work-7",
    leaseToken: "lease-7",
    draftId: DRAFT_ID,
    policyRevision: "delivery-policy-v1",
    requiresManualApproval: true
  }]);
  assert.equal(state.blocked.length, 0);
});

test("unsafe policy and draft failures remain fail-closed", async () => {
  const unsafe = fixture({
    policy: {
      decision: TINDER_DELIVERY_POLICY_DECISION.DRAFT_ONLY,
      policyRevision: "delivery-policy-v1",
      requiresManualApproval: false,
      permitsSend: true
    }
  });
  const unsafeResult = await unsafe.service.processClaim(claim());
  assert.equal(unsafeResult.reason, TINDER_AUTOMATION_WORK_BLOCK_REASON.DELIVERY_POLICY_UNSAFE);
  assert.equal(unsafe.state.draftCalls, 0);

  const failedDraft = fixture({ draftError: new Error("untrusted details") });
  const failedResult = await failedDraft.service.processClaim(claim());
  assert.equal(failedResult.reason, TINDER_AUTOMATION_WORK_BLOCK_REASON.DRAFT_CREATION_FAILED);
  assert.equal(failedDraft.state.draftCalls, 1);
  assert.equal(failedDraft.state.draftReady.length, 0);
});

test("orchestrator source has no T5 send dependency or delivery invocation", () => {
  const source = readFileSync(new URL("../services/tinder-automation-orchestrator.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /tinder-manual-send/i);
  assert.doesNotMatch(source, /SEND_TINDER_DRAFT/);
  assert.doesNotMatch(source, /createApproval|dispatchIntent|dispatchSend/);
});
