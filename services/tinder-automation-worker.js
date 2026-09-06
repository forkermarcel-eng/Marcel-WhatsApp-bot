/* ==================================================
T7 EXPLICIT WORKER FOUNDATION

There is no import-time work, no interval, no timer and no startup hook. A
future protected scheduler may call runOnce explicitly; an unapproved runtime
cannot even claim a work item. This worker has no device-command or send
dependency.
================================================== */

import { TINDER_AUTOMATION_GLOBAL_STATE } from "./tinder-automation-control.js";

const TINDER_AUTOMATION_WORKER_OUTCOME = Object.freeze({
  STOPPED: "STOPPED",
  IDLE: "IDLE",
  BUSY: "BUSY",
  PROCESSED: "PROCESSED",
  FAILED_CLOSED: "FAILED_CLOSED"
});

const DEFAULT_LEASE_MS = 60 * 1000;

function nonEmptyText(value, maximum = 160) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= maximum ? text : null;
}

function safeDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError("now must return a valid Date");
  return date;
}

function requireDependencies({ workRepository, controlService, orchestrator }) {
  for (const [owner, methods] of [
    [workRepository, ["claimNextDueWorkItem", "markClaimFailed"]],
    [controlService, ["runtimeStatus"]],
    [orchestrator, ["processClaim"]]
  ]) {
    for (const method of methods) {
      if (typeof owner?.[method] !== "function") throw new TypeError(`${method} must be a function`);
    }
  }
}

function normalizeClaim(value) {
  if (!value) return null;
  const leaseToken = nonEmptyText(value.leaseToken ?? value.lease_token, 160);
  if (!leaseToken || !value.workItem) throw new TypeError("claimNextDueWorkItem returned an invalid claim");
  return Object.freeze({ workItem: value.workItem, leaseToken });
}

function createTinderAutomationWorker({
  workRepository,
  controlService,
  orchestrator,
  now = () => new Date(),
  workerId = "tinder-automation-worker-v1",
  leaseMs = DEFAULT_LEASE_MS
} = {}) {
  requireDependencies({ workRepository, controlService, orchestrator });
  const normalizedWorkerId = nonEmptyText(workerId, 120);
  if (!normalizedWorkerId) throw new TypeError("workerId must be a non-empty string");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60 * 1000) {
    throw new TypeError("leaseMs must be between 1000 and 600000");
  }

  let runInFlight = false;

  async function runOnce({ runtime } = {}) {
    if (runInFlight) return Object.freeze({ outcome: TINDER_AUTOMATION_WORKER_OUTCOME.BUSY });
    const status = controlService.runtimeStatus();
    if (status?.state !== TINDER_AUTOMATION_GLOBAL_STATE.RUNNING || status?.runtimeApproved !== true) {
      return Object.freeze({ outcome: TINDER_AUTOMATION_WORKER_OUTCOME.STOPPED });
    }

    runInFlight = true;
    try {
      const startedAt = safeDate(now());
      const claim = normalizeClaim(await workRepository.claimNextDueWorkItem(Object.freeze({
        workerId: normalizedWorkerId,
        asOf: startedAt.toISOString(),
        leaseExpiresAt: new Date(startedAt.valueOf() + leaseMs).toISOString()
      })));
      if (!claim) return Object.freeze({ outcome: TINDER_AUTOMATION_WORKER_OUTCOME.IDLE });

      try {
        const result = await orchestrator.processClaim(Object.freeze({
          workItem: claim.workItem,
          leaseToken: claim.leaseToken,
          runtime
        }));
        return Object.freeze({
          outcome: TINDER_AUTOMATION_WORKER_OUTCOME.PROCESSED,
          result
        });
      } catch (_error) {
        await workRepository.markClaimFailed(Object.freeze({
          workItemId: claim.workItem.workItemId ?? claim.workItem.work_item_id,
          leaseToken: claim.leaseToken,
          reason: "AUTOMATION_PROCESSING_FAILED"
        }));
        return Object.freeze({ outcome: TINDER_AUTOMATION_WORKER_OUTCOME.FAILED_CLOSED });
      }
    } finally {
      runInFlight = false;
    }
  }

  return Object.freeze({ runOnce });
}

export {
  DEFAULT_LEASE_MS,
  TINDER_AUTOMATION_WORKER_OUTCOME,
  createTinderAutomationWorker
};
