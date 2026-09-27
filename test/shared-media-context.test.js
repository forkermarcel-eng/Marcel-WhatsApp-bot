import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createWhatsAppMediaAdapter } from "../services/whatsapp-media.js";
import { createMediaContextReader } from "../shared-media/media-context.js";
import { createMediaAnalysisHandler, normalizeMediaAnalysis } from "../shared-media/analysis.js";
import { normalizeProbe, createMediaProcessor, runMediaProcess } from "../shared-media/ffmpeg.js";
import { resolveContactAvatar } from "../shared-media/avatar.js";
import { registerMediaAnalysisConsumer, enqueueMediaAnalysis } from "../shared-media/analysis-jobs.js";
import { createSharedMediaRepository } from "../shared-media/repository.js";

test("avatar roles choose existing primary media without establishing person identity", () => {
  const make = (id, role) => ({ asset: { assetId: id, mediaType: "image", availability: "AVAILABLE" }, link: { relationshipType: role } });
  const result = resolveContactAvatar({ records: [make("tile", "match_avatar"), make("primary", "profile_primary")],
    urlForAsset: asset => `/media/${asset.assetId}` });
  assert.equal(result.assetId, "primary");
  assert.equal(resolveContactAvatar({ legacyPhoto: "javascript:bad" }).url, null);
  assert.equal(resolveContactAvatar({ legacyPhoto: "/legacy/photo" }).url, "/legacy/photo");
});

test("analysis remains disabled by default; explicitly enabled transport contains only references", async () => {
  const calls = [];
  const boss = { async createQueue(name) { calls.push(name); }, async work(name,options,handler) { calls.push({ name,options,handler }); },
    async send(...args) { calls.push(args); return "job"; } };
  await registerMediaAnalysisConsumer({ boss });
  await enqueueMediaAnalysis({ boss });
  assert.equal(calls.length, 0);
  await assert.rejects(() => registerMediaAnalysisConsumer({ boss, enabled: true }), /NOT_ENABLED/);
  assert.equal(calls.length, 0);
  const id = "11111111-1111-4111-8111-111111111111";
  await enqueueMediaAnalysis({ boss, enabled: true, assetId: id, analysisId: id, analyzer: "fixture" });
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ["analysisId","analyzer","assetId"]);
});

test("analysis persistence updates only the referenced asset, never contact or memory", async () => {
  const statements = [];
  const repository = createSharedMediaRepository({ async connect() {}, async query(sql,values) {
    statements.push({ sql,values }); return { rowCount: 1, rows: [] };
  } });
  const id = "11111111-1111-4111-8111-111111111111";
  await repository.saveAnalysis({ assetId: id, analysisId: id, type: "ocr", status: "COMPLETE",
    analyzer: "fixture", model: "fixture", modelVersion: "1", analyzedAt: "2026-01-01T00:00:00Z", coverage: { wholeImage: true }, ocrText: "fixture" });
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /^UPDATE media_assets/);
  assert.doesNotMatch(statements[0].sql, /contacts|memories|woman|facts/i);
  assert.equal(statements[0].values[0], id);
});

for (const type of ["image", "video", "sticker", "audio", "document"]) {
  test(`WhatsApp ${type} uses injected Baileys stream and shared context without a live socket`, async () => {
    const bytes = Readable.from([Buffer.from("fixture")]);
    let delivered;
    const adapter = createWhatsAppMediaAdapter({ ingress: { async ingest(input) { delivered = input; return input; } },
      loadBaileys: async () => ({ extractMessageContent: m => m,
        async downloadMediaMessage(message, mode) { assert.equal(mode,"stream"); return bytes; } }) });
    await adapter.ingestMessage({ key: { id: "m1", fromMe: false }, messageTimestamp: 1,
      message: { [`${type}Message`]: { caption: "fixture", fileName: "fixture.bin" } } },
    { contactId: 7, conversationReference: "c1" });
    assert.equal(delivered.input,bytes);
    assert.equal(delivered.mediaType,type);
    assert.equal(delivered.context.contactId,7);
    assert.equal(delivered.context.direction,"inbound");
    assert.equal(delivered.context.messageReference,"m1");
    assert.equal(delivered.context.timestamp,"1970-01-01T00:00:01.000Z");
  });
}
test("expired WA media is unavailable, not invented; transient failures remain failures", async () => {
  let unavailable = 0;
  const adapter = createWhatsAppMediaAdapter({ ingress: { async unavailable(v) { unavailable++; return v; } },
    loadBaileys: async () => ({ extractMessageContent: m => m,
      async downloadMediaMessage() { throw Object.assign(new Error("expired"),{ status: 410 }); } }) });
  const result = await adapter.ingestMessage({ key: { id: "m" }, message: { imageMessage: {} } }, { contactId: 7, conversationReference: "c" });
  assert.equal(unavailable,1);
  assert.equal(result.reason,"SOURCE_MEDIA_UNAVAILABLE");
});
test("context preserves Text A / Image B / Text C and separates profile media", async () => {
  const asset = { assetId: "asset-1", mediaType: "image", mimeType: "image/png", availability: "AVAILABLE", metadata: {} };
  const common = { contactId: 7, channel: "whatsapp", conversationReference: "c1" };
  const reader = createMediaContextReader({ listAttachments: async () => [
    { asset, context: { ...common, sourceType: "attachment", messageReference: "b", direction: "inbound" } },
    { asset, context: { ...common, sourceType: "profile" } },
    { asset: { ...asset, assetId: "foreign" }, context: { ...common, contactId: 8, sourceType: "attachment", messageReference: "b" } }
  ] });
  const result = await reader.read({ ...common, messages: [
    { messageReference: "a", text: "A" }, { messageReference: "b", text: "" }, { messageReference: "c", text: "C" }
  ] });
  assert.deepEqual(result.messages.map(m => m.attachments.length),[0,1,0]);
  assert.equal(result.messages[1].attachments[0].assetId,result.profileMedia[0].assetId);
  assert.equal(result.profileMedia.length,1);
});
test("analysis stays disabled with no model registry, rejects binary job payloads", async () => {
  const handler = createMediaAnalysisHandler({ loadAsset() { assert.fail("must not load"); }, saveAnalysis() { assert.fail("must not save"); } });
  const data = { assetId: "11111111-1111-4111-8111-111111111111", analysisId: "22222222-2222-4222-8222-222222222222", analyzer: "vision" };
  await assert.rejects(handler({ data }), /NOT_ENABLED/);
  await assert.rejects(handler({ data: { ...data, bytes: "secret" } }), /references only/);
  const output = normalizeMediaAnalysis({ ...data, type: "vision", analyzer: "fixture", model: "fixture", modelVersion: "1",
    status: "COMPLETE", analyzedAt: "2026-09-27", coverage: { frames: [0] }, confidence: 1 });
  assert.equal("confidence" in output,false);
  assert.equal("memory" in output,false);
});
test("ffprobe normalizes video/audio and invokes argv without a shell command string", async () => {
  const probe = { format: { duration: "2.5" }, streams: [
    { codec_type: "video", width: 640, height: 480, codec_name: "h264", avg_frame_rate: "30/1", side_data_list: [{ rotation: 90 }] },
    { codec_type: "audio", codec_name: "aac", channels: 2, sample_rate: "48000" }
  ] };
  assert.equal(normalizeProbe(probe).durationMs,2500);
  let invoked;
  const processor = createMediaProcessor({ run: async (bin,args) => { invoked = { bin,args }; return JSON.stringify(probe); } });
  const result = await processor.probe(process.execPath);
  assert.equal(result.video.rotation,90);
  assert.equal(result.audio.sampleRate,48000);
  assert.equal(invoked.bin,"ffprobe");
  assert.equal(invoked.args.at(-1),process.execPath);
});
test("process adapter handles exit, timeout and bounded output without FFmpeg installation", async () => {
  assert.equal(await runMediaProcess(process.execPath,["-e","process.stdout.write('ok')"]),"ok");
  await assert.rejects(runMediaProcess(process.execPath,["-e","process.exit(3)"]),/EXIT_3/);
  await assert.rejects(runMediaProcess(process.execPath,["-e","setInterval(()=>{},1000)"],{ timeoutMs: 100 }),/TIMEOUT/);
  await assert.rejects(runMediaProcess(process.execPath,["-e","process.stdout.write('too much')"],{ maxOutputBytes: 2 }),/OUTPUT_LIMIT/);
});
