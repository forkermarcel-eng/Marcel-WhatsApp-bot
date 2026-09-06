import assert from "node:assert/strict";
import test from "node:test";
import {
  TINDER_AUTOMATION_CONTACT_STATE,
  TINDER_AUTOMATION_GATE_REASON,
  TINDER_AUTOMATION_GLOBAL_STATE,
  TINDER_AUTOMATION_OPERATION_STATE,
  createTinderAutomationControlService,
  evaluateTinderAutomationGate
} from "../services/tinder-automation-control.js";

const CONTACT_ID = 7;

function safeGlobal(overrides = {}) {
  return {
    state: TINDER_AUTOMATION_GLOBAL_STATE.RUNNING,
    operation_state: TINDER_AUTOMATION_OPERATION_STATE.ACTIVE,
    explicit_approval: true,
    policy_revision: "tinder-delivery-policy-v1",
    ...overrides
  };
}

function safeContact(overrides = {}) {
  return {
    contact_id: CONTACT_ID,
    state: TINDER_AUTOMATION_CONTACT_STATE.ENABLED,
    identity_confirmed: true,
    auto_reply_enabled: true,
    human_takeover_active: false,
    handoff_active: false,
    date_lock_enabled: false,
    manual_review_required: false,
    ...overrides
  };
}

function safeRuntime(overrides = {}) {
  return {
    enrollment_state: "ACTIVE",
    bridge_service_state: "RUNNING",
    tinder_state: "CONNECTED",
    automation_state: "RUNNING",
    ...overrides
  };
}

function dueWorkItem(overrides = {}) {
  return {
    contact_id: CONTACT_ID,
    queue_status: "ELIGIBLE_FOR_NEXT_STAGE",
    conversation_state: "WAITING_FOR_US",
    ...overrides
  };
}

function repository({ global = safeGlobal(), contact = safeContact() } = {}) {
  return {
    async getGlobalControl() { return global; },
    async getContactControl(contactId) {
      assert.equal(contactId, CONTACT_ID);
      return contact;
    }
  };
}

test("T7 defaults to STOPPED and cannot resume a historical durable RUNNING state", async () => {
  const service = createTinderAutomationControlService({ repository: repository() });
  assert.deepEqual(service.runtimeStatus(), {
    state: TINDER_AUTOMATION_GLOBAL_STATE.STOPPED,
    runtimeApproved: false
  });

  const beforeExplicitApproval = await service.evaluate({
    contactId: CONTACT_ID,
    runtime: safeRuntime(),
    workItem: dueWorkItem()
  });
  assert.equal(beforeExplicitApproval.allowed, false);
  assert.equal(beforeExplicitApproval.reason, TINDER_AUTOMATION_GATE_REASON.RUNTIME_APPROVAL_REQUIRED);

  service.requestRuntimeStart({ explicitApproval: true, actor: "marcel_dashboard" });
  assert.equal((await service.evaluate({ contactId: CONTACT_ID, runtime: safeRuntime(), workItem: dueWorkItem() })).allowed, true);

  const afterRestart = createTinderAutomationControlService({ repository: repository() });
  assert.equal((await afterRestart.evaluate({ contactId: CONTACT_ID, runtime: safeRuntime(), workItem: dueWorkItem() })).reason,
    TINDER_AUTOMATION_GATE_REASON.RUNTIME_APPROVAL_REQUIRED);
});

test("T7 requires every global, contact, T6 and device gate", () => {
  const base = {
    globalControl: safeGlobal(),
    contactControl: safeContact(),
    runtime: safeRuntime(),
    workItem: dueWorkItem(),
    runtimeApproved: true
  };
  assert.equal(evaluateTinderAutomationGate(base).allowed, true);

  const cases = [
    [{ globalControl: safeGlobal({ state: "STOPPED" }) }, TINDER_AUTOMATION_GATE_REASON.GLOBAL_STOPPED],
    [{ globalControl: safeGlobal({ operation_state: "REST_PHASE" }) }, TINDER_AUTOMATION_GATE_REASON.REST_PHASE_ACTIVE],
    [{ contactControl: safeContact({ identity_confirmed: false }) }, TINDER_AUTOMATION_GATE_REASON.IDENTITY_NOT_CONFIRMED],
    [{ contactControl: safeContact({ human_takeover_active: true }) }, TINDER_AUTOMATION_GATE_REASON.HUMAN_TAKEOVER_ACTIVE],
    [{ contactControl: safeContact({ handoff_active: true }) }, TINDER_AUTOMATION_GATE_REASON.HANDOFF_ACTIVE],
    [{ contactControl: safeContact({ date_lock_enabled: true }) }, TINDER_AUTOMATION_GATE_REASON.DATE_LOCK_ACTIVE],
    [{ contactControl: safeContact({ manual_review_required: true }) }, TINDER_AUTOMATION_GATE_REASON.MANUAL_REVIEW_REQUIRED],
    [{ runtime: safeRuntime({ enrollment_state: "PENDING" }) }, TINDER_AUTOMATION_GATE_REASON.DEVICE_ENROLLMENT_INACTIVE],
    [{ runtime: safeRuntime({ bridge_service_state: "STOPPED" }) }, TINDER_AUTOMATION_GATE_REASON.BRIDGE_NOT_RUNNING],
    [{ runtime: safeRuntime({ tinder_state: "DISCONNECTED" }) }, TINDER_AUTOMATION_GATE_REASON.TINDER_NOT_CONNECTED],
    [{ runtime: safeRuntime({ automation_state: "STOPPED" }) }, TINDER_AUTOMATION_GATE_REASON.DEVICE_AUTOMATION_NOT_RUNNING],
    [{ workItem: dueWorkItem({ conversation_state: "WAITING_FOR_HER" }) }, TINDER_AUTOMATION_GATE_REASON.WAITING_FOR_HER]
  ];
  for (const [patch, reason] of cases) {
    const result = evaluateTinderAutomationGate({ ...base, ...patch });
    assert.equal(result.allowed, false, reason);
    assert.equal(result.reason, reason);
  }
});

test("runtime start itself needs an explicit named human authority and stop resets it", () => {
  const service = createTinderAutomationControlService({ repository: repository() });
  assert.throws(() => service.requestRuntimeStart({ explicitApproval: false, actor: "marcel_dashboard" }), {
    code: "EXPLICIT_RUNTIME_APPROVAL_REQUIRED"
  });
  assert.throws(() => service.requestRuntimeStart({ explicitApproval: true, actor: "" }), {
    code: "EXPLICIT_RUNTIME_APPROVAL_REQUIRED"
  });
  assert.equal(service.requestRuntimeStart({ explicitApproval: true, actor: "marcel_dashboard" }).state, "RUNNING");
  assert.equal(service.stopRuntime().state, "STOPPED");
});
