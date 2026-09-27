import { randomUUID } from "node:crypto";
import { createMediaAnalysisHandler } from "./analysis.js";

export const MEDIA_ANALYSIS_JOB = "MEDIA_ANALYSIS";

// Uses the caller's existing pg-boss instance. No connection, scheduler or
// analyzer is created at module import or web startup.
export async function registerMediaAnalysisConsumer({ boss, enabled = false, adapters = {}, loadAsset, saveAnalysis }) {
  if (!enabled) return null;
  if (!Object.values(adapters).some(adapter => typeof adapter?.analyze === "function")) {
    throw new Error("ANALYZER_NOT_ENABLED");
  }
  const handle = createMediaAnalysisHandler({ adapters, loadAsset, saveAnalysis });
  await boss.createQueue(MEDIA_ANALYSIS_JOB);
  return boss.work(MEDIA_ANALYSIS_JOB, { batchSize: 1 }, async jobs => {
    for (const job of jobs) await handle(job);
  });
}

export async function enqueueMediaAnalysis({ boss, enabled = false, assetId, analyzer, analysisId = randomUUID() }) {
  if (!enabled) return null;
  if (!/^[a-f0-9-]{36}$/i.test(assetId) || !/^[a-f0-9-]{36}$/i.test(analysisId)
    || typeof analyzer !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(analyzer)) throw new TypeError("analysis references invalid");
  return boss.send(MEDIA_ANALYSIS_JOB, { assetId, analysisId, analyzer }, { singletonKey: analysisId });
}
