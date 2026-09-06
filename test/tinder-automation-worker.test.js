import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  TINDER_AUTOMATION_WORKER_OUTCOME,
  createTinderAutomationWorker
} from "../services/tinder-automation-worker.js";

function activeControl() {
  return { runtimeStatus() { return { state: "RUNNING", runtimeApproved: true }; } };
}

function stoppedControl() {
  return { runtimeStatus() { return { state: "STOPPED", runtimeApproved: false }; } };
}

function claim() {
  return {
    workItem: { work_item_id: "work-7", contact_id: 7 },
    lease_token: "lease-7"
  };
}

test("a fresh or stopped T7 runtime cannot claim work", async () => {
  let claims = 0;
  const worker = createTinderAutomationWorker({
    controlService: stoppedControl(),
    workRepository: {
      async claimNextDueWorkItem() { claims += 1; return claim(); },
      async markClaimFailed() { throw new Error("must not run"); }
    },
    orchestrator: { async processClaim() { throw new Error("must not run"); } }
  });
  assert.deepEqual(await worker.runOnce(), { outcome: TINDER_AUTOMATION_WORKER_OUTCOME.STOPPED });
  assert.equal(claims, 0);
});

test("runOnce is explicit, claims at most one item, and passes it only to the orchestrator", async () => {
  const state = { claimInputs: [], processInputs: [], failures: [] };
  const worker = createTinderAutomationWorker({
    controlService: activeControl(),
    workRepository: {
      async claimNextDueWorkItem(input) { state.claimInputs.push(input); return claim(); },
      async markClaimFailed(input) { state.failures.push(input); }
    },
    orchestrator: {
      async processClaim(input) {
        state.processInputs.push(input);
        return { outcome: "DRAFT_READY_FOR_MANUAL_APPROVAL" };
      }
    },
    now: () => new Date("2026-09-06T12:00:00.000Z"),
    workerId: "worker-test"
  });
  const result = await worker.runOnce({ runtime: { tinder_state: "CONNECTED" } });
  assert.equal(result.outcome, TINDER_AUTOMATION_WORKER_OUTCOME.PROCESSED);
  assert.deepEqual(state.claimInputs, [{
    workerId: "worker-test",
    asOf: "2026-09-06T12:00:00.000Z",
    leaseExpiresAt: "2026-09-06T12:01:00.000Z"
  }]);
  assert.equal(state.processInputs.length, 1);
  assert.equal(state.processInputs[0].leaseToken, "lease-7");
  assert.equal(state.failures.length, 0);
});

test("processing failure records a bounded failure and does not retry", async () => {
  const failures = [];
  const worker = createTinderAutomationWorker({
    controlService: activeControl(),
    workRepository: {
      async claimNextDueWorkItem() { return claim(); },
      async markClaimFailed(input) { failures.push(input); }
    },
    orchestrator: { async processClaim() { throw new Error("raw error must not escape"); } }
  });
  assert.deepEqual(await worker.runOnce(), { outcome: TINDER_AUTOMATION_WORKER_OUTCOME.FAILED_CLOSED });
  assert.deepEqual(failures, [{
    workItemId: "work-7",
    leaseToken: "lease-7",
    reason: "AUTOMATION_PROCESSING_FAILED"
  }]);
});

test("worker is import-inert and contains no timer or device/send integration", () => {
  const source = readFileSync(new URL("../services/tinder-automation-worker.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /setInterval|setTimeout/);
  assert.doesNotMatch(source, /tinder-manual-send|SEND_TINDER_DRAFT|device-bridge/i);
});
