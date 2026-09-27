import { createMediaAssetLink } from "./model.js";
import { createSharedMediaAssetService } from "./asset-service.js";
import { createImageDerivatives } from "./image-pipeline.js";
import { normalizeAttachmentContext, attachmentOwners } from "./attachment.js";
import { readMediaInput } from "./binary-input.js";

function detectedMediaType(mime, requested) {
  if (mime.startsWith("image/")) return requested === "sticker" ? "sticker" : "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || mime.includes("officedocument")) return "document";
  return "file";
}

export function createSharedAttachmentIngress({ repository, storage, maxBytes, processor = null, now = () => new Date() }) {
  if (typeof repository?.withContentTransaction !== "function") throw new TypeError("content repository required");
  return Object.freeze({
    async unavailable({ context, mediaType = "file", reason }) {
      const attachment = normalizeAttachmentContext(context);
      const owners = attachmentOwners(attachment);
      const service = createSharedMediaAssetService({ storage, now });
      const record = service.createUnavailableAsset({ sourceChannel: attachment.channel,
        sourceReference: attachment.messageReference || attachment.profileReference || attachment.matchReference,
        mediaType, unavailableReason: reason, owners });
      if (typeof repository.withUnavailableTransaction !== "function") throw new TypeError("unavailable repository required");
      // Exact source usage only. No invented content hash when bytes expired.
      const owner=owners.find(value=>value.ownerType==="message")||owners.find(value=>value.ownerType!=="contact")||owners[0];
      return repository.withUnavailableTransaction(owner,async tx=>{
        if(tx.existing)return {asset:tx.existing,context:attachment,reused:true};
        await tx.insertAssetWithLinks(record);
        return {...record,context:attachment,reused:false};
      });
    },
    async ingest({ input, context, mediaType: requestedType, crop = null, signal } = {}) {
    const attachment = normalizeAttachmentContext(context);
    const owners = attachmentOwners(attachment);
    let source = await readMediaInput(input, { maxBytes, signal });
    const mediaType = detectedMediaType(source.mimeType, requestedType);
    let rendered;
    if (["image", "sticker"].includes(mediaType)) {
      rendered = await createImageDerivatives(source.bytes, { crop });
      if (crop) source = await readMediaInput(rendered.source.bytes, { maxBytes, signal });
    } else if (crop) throw new TypeError("crop requires detected image bytes");
    const written = [];
    const trackedStorage = { ...storage, async put(key, bytes) {
      const result = await storage.put(key, bytes);
      written.push(key);
      return result;
    } };
    try {
      return await repository.withContentTransaction(source.sha256, async tx => {
        signal?.throwIfAborted();
        if (tx.existing) {
          const links = owners.map(owner => createMediaAssetLink({ ...owner, assetId: tx.existing.assetId }, { now }));
          await tx.attachLinks(links);
          return { asset: tx.existing, links, reused: true, context: attachment };
        }
        const inspected = processor && ["video", "audio"].includes(mediaType)
          ? await processor.inspectBytes(source.bytes, { signal, poster: mediaType === "video" }) : null;
        const service = createSharedMediaAssetService({ storage: trackedStorage, repository: tx,
          now, ...(rendered ? { imagePipeline: async () => rendered } : {}) });
        const values = { sourceChannel: attachment.channel,
          sourceReference: attachment.messageReference || attachment.profileReference || attachment.matchReference || attachment.conversationReference,
          bytes: source.bytes, mediaType, mimeType: source.mimeType, owners,
          durationMs: inspected?.metadata?.durationMs ?? null,
          width: inspected?.metadata?.video?.width ?? null,
          height: inspected?.metadata?.video?.height ?? null,
          poster: inspected?.poster ?? null,
          metadata: { sourceSha256: source.sha256, detectedType: source.detected,
            ...(inspected ? { probe: inspected.metadata } : {}),
            sourceProvenance: crop ? "screenshot_crop" : attachment.provenance.kind || "supplied_bytes" } };
        const result = rendered ? await service.ingestImage(values) : await service.ingestBinary(values);
        return { ...result, reused: false, context: attachment };
      });
    } catch (error) {
      if (["NOT_STARTED", "ROLLED_BACK"].includes(error.sharedMediaPersistenceOutcome)) {
        await Promise.all(written.map(key => storage.remove(key).catch(() => {})));
      }
      throw error;
    }
  } });
}
