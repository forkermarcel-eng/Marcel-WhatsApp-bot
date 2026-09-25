import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import test from "node:test";
import { createSharedMediaAssetService } from "../shared-media/asset-service.js";
import { createImageDerivatives } from "../shared-media/image-pipeline.js";
import { createLocalFilesystemMediaStorage } from "../shared-media/storage.js";

const assetId = "11111111-1111-4111-8111-111111111111";
const linkId = "22222222-2222-4222-8222-222222222222";
const createdAt = "2026-09-25T00:00:00.000Z";

async function splitColourPng() {
  return sharp({
    create: { width: 100, height: 60, channels: 3, background: { r: 240, g: 20, b: 20 } }
  })
    .composite([{
      input: await sharp({
        create: { width: 50, height: 60, channels: 3, background: { r: 20, g: 30, b: 230 } }
      }).png().toBuffer(),
      left: 50,
      top: 0
    }])
    .png()
    .toBuffer();
}

test("Sharp crops a verified image region, bounds it, and emits a WebP thumbnail", async () => {
  const source = await splitColourPng();
  const result = await createImageDerivatives(source, {
    crop: { left: 50, top: 0, width: 50, height: 60 },
    maxWidth: 30,
    maxHeight: 30,
    thumbnailWidth: 20,
    thumbnailHeight: 20,
    quality: 90,
    thumbnailQuality: 85
  });
  assert.deepEqual(result.crop, { left: 50, top: 0, width: 50, height: 60 });
  assert.deepEqual({ width: result.image.width, height: result.image.height }, { width: 25, height: 30 });
  assert.deepEqual({ width: result.thumbnail.width, height: result.thumbnail.height }, { width: 17, height: 20 });
  assert.equal(result.image.mimeType, "image/webp");
  const pixel = await sharp(result.image.bytes).raw().toBuffer();
  assert.ok(pixel[2] > pixel[0] * 3, "cropped image retains the blue right-hand region");
  await assert.rejects(
    createImageDerivatives(source, { crop: { left: 99, top: 0, width: 2, height: 2 } }),
    /outside the source image/
  );
});

test("image ingestion writes separate resized image and thumbnail under an asset key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "marcel-shared-media-images-"));
  try {
    const storage = createLocalFilesystemMediaStorage({ rootDirectory: root });
    const ids = [assetId, linkId];
    const service = createSharedMediaAssetService({
      storage,
      idFactory: () => ids.shift(),
      now: () => new Date(createdAt)
    });
    const result = await service.ingestImage({
      sourceChannel: "tinder",
      sourceReference: "profile:opaque",
      bytes: await splitColourPng(),
      crop: { left: 50, top: 0, width: 50, height: 60 },
      owners: [{
        ownerType: "tinder_profile",
        ownerReference: "profile:opaque",
        relationshipType: "profile_media",
        ordinal: 0
      }],
      imageOptions: { maxWidth: 30, maxHeight: 30, thumbnailWidth: 20, thumbnailHeight: 20 }
    });
    assert.equal(result.asset.storageKey, `media-assets/${assetId}/image.webp`);
    assert.equal(result.asset.thumbnailStorageKey, `media-assets/${assetId}/thumbnail.webp`);
    assert.equal(await storage.exists(result.asset.storageKey), true);
    assert.equal(await storage.exists(result.asset.thumbnailStorageKey), true);
    const fullMeta = await sharp(await storage.read(result.asset.storageKey)).metadata();
    const thumbMeta = await sharp(await storage.read(result.asset.thumbnailStorageKey)).metadata();
    assert.deepEqual({ width: fullMeta.width, height: fullMeta.height, format: fullMeta.format }, {
      width: 25,
      height: 30,
      format: "webp"
    });
    assert.deepEqual({ width: thumbMeta.width, height: thumbMeta.height, format: thumbMeta.format }, {
      width: 17,
      height: 20,
      format: "webp"
    });
    assert.equal(result.links[0].ownerType, "tinder_profile");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
