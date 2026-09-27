const TYPES = new Set(["vision", "ocr", "video", "speech", "sticker"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeMediaAnalysis(value) {
  if (!value || !UUID.test(value.assetId) || !UUID.test(value.analysisId)) throw new TypeError("analysis/asset UUID required");
  if (!TYPES.has(value.type)) throw new TypeError("analyzer type invalid");
  if (!["COMPLETE", "PARTIAL", "FAILED"].includes(value.status)) throw new TypeError("analysis status invalid");
  for (const key of ["analyzer", "model", "modelVersion"]) {
    if (typeof value[key] !== "string" || !value[key] || value[key].length > 256) throw new TypeError(`${key} required`);
  }
  const analyzedAt = new Date(value.analyzedAt);
  if (Number.isNaN(analyzedAt.getTime())) throw new TypeError("analyzedAt invalid");
  const result = {
    analysisId: value.analysisId, assetId: value.assetId, type: value.type,
    analyzer: value.analyzer, model: value.model, modelVersion: value.modelVersion,
    status: value.status, analyzedAt: analyzedAt.toISOString(),
    description: value.description ?? null, ocrText: value.ocrText ?? null,
    objects: value.objects ?? [], scenes: value.scenes ?? [], language: value.language ?? null,
    transcript: value.transcript ?? [], frameReferences: value.frameReferences ?? [],
    regionReferences: value.regionReferences ?? [], sensitivity: value.sensitivity ?? null,
    coverage: value.coverage ?? null, qualitySignals: value.qualitySignals ?? {}, error: value.error ?? null
  };
  if (result.status !== "FAILED" && !result.coverage) throw new TypeError("actual coverage required");
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json) > 256 * 1024) throw new TypeError("analysis result too large");
  return Object.freeze(JSON.parse(json));
}

// No model imports/downloads, network clients, memory writes or default analyzer.
// Caller supplies an explicitly enabled adapter in a separate worker process.
export function createMediaAnalysisHandler({ adapters = {}, loadAsset, saveAnalysis }) {
  return async function handle(job) {
    const data = job?.data;
    if (!data || !UUID.test(data.assetId) || !UUID.test(data.analysisId)
      || Object.keys(data).some(k => !["assetId", "analysisId", "analyzer"].includes(k))) {
      throw new TypeError("analysis job must contain references only");
    }
    const adapter = adapters[data.analyzer];
    if (typeof adapter?.analyze !== "function") throw new Error("ANALYZER_NOT_ENABLED");
    const asset = await loadAsset(data.assetId);
    if (!asset || asset.assetId !== data.assetId) throw new Error("ASSET_NOT_FOUND");
    const output = await adapter.analyze(asset);
    const normalized = normalizeMediaAnalysis({ ...output, assetId: data.assetId, analysisId: data.analysisId });
    await saveAnalysis(normalized);
    return normalized;
  };
}
