import {
  TINDER_DISCOVERY_QUEUE,
  normalizeTinderDiscoveryJob
} from "./pg-boss-discovery.js";

export const TINDER_DISCOVERY_WORKER_OPTIONS = Object.freeze({
  batchSize: 1,
  localConcurrency: 1,
  // Polling works through the existing Railway SSH tunnel and deliberately
  // needs neither a public TCP proxy nor LISTEN/NOTIFY.
  pollingIntervalSeconds: 2
});

function assertWorkerOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("workerOptions must be an object");
  }
  if (value.batchSize !== 1 || value.localConcurrency !== 1
    || !Number.isFinite(value.pollingIntervalSeconds)
    || value.pollingIntervalSeconds < 0.5 || value.pollingIntervalSeconds > 60) {
    throw new TypeError("Tinder discovery worker options must remain bounded and serial");
  }
}

/*
 * A Windows-only consumer. It receives no Tinder data from Railway: job.data
 * contains only the already enrolled device UUID. The supplied dispatcher is
 * the existing local Appium/UiAutomator2 composition, not a new controller.
 */
export async function startTinderDiscoveryWorker({
  boss,
  dispatcher,
  workerOptions = TINDER_DISCOVERY_WORKER_OPTIONS
} = {}) {
  if (!boss || typeof boss.work !== "function" || typeof boss.offWork !== "function") {
    throw new TypeError("A started pg-boss instance with work() and offWork() is required");
  }
  if (!dispatcher || typeof dispatcher.signal !== "function") {
    throw new TypeError("An existing local Tinder dispatcher with signal() is required");
  }
  assertWorkerOptions(workerOptions);
  const options = Object.freeze({ ...workerOptions });
  const workId = await boss.work(TINDER_DISCOVERY_QUEUE, options, async (jobs) => {
    if (!Array.isArray(jobs) || jobs.length !== 1) {
      throw new Error("Tinder discovery worker requires exactly one serial job");
    }
    const job = jobs[0];
    const payload = normalizeTinderDiscoveryJob(job?.data);
    // Awaiting the existing dispatcher lets pg-boss settle the transport job
    // only once that bounded local attempt has ended. No retry is configured.
    await dispatcher.signal(payload);
  });

  return Object.freeze({
    work_id: workId,
    async stop() {
      await boss.offWork(TINDER_DISCOVERY_QUEUE, { id: workId, wait: true });
    }
  });
}
