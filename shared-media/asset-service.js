import { randomUUID } from "node:crypto";
import {
  createMediaAsset,
  createMediaAssetLink,
  mediaStorageKeyForAsset
} from "./model.js";
import { createImageDerivatives } from "./image-pipeline.js";
import { assertMediaStorage } from "./storage.js";

function owners(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("at least one media owner is required");
  }
  return value;
}

function binaryBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new TypeError("media bytes must be a Buffer or Uint8Array");
}

/**
 * Produces insert-ready asset/link records while persisting only raster bytes
 * through the supplied storage adapter. Database persistence is deliberately
 * separate, so this has no startup or production migration side effect.
 */
export function createSharedMediaAssetService({
  storage,
  idFactory = randomUUID,
  now = () => new Date(),
  imagePipeline = createImageDerivatives
} = {}) {
  assertMediaStorage(storage);
  if (typeof idFactory !== "function" || typeof now !== "function" || typeof imagePipeline !== "function") {
    throw new TypeError("idFactory, now, and imagePipeline must be functions");
  }

  async function ingestImage({
    sourceChannel,
    sourceReference = null,
    bytes,
    crop = null,
    mediaType = "image",
    owners: ownerValues,
    metadata = {},
    createdAt = now(),
    imageOptions = {}
  } = {}) {
    if (!["image", "sticker"].includes(mediaType)) {
      throw new TypeError("ingestImage supports image and sticker media types");
    }
    const assetId = idFactory();
    const originalKey = mediaStorageKeyForAsset(assetId, "image.webp");
    const thumbnailKey = mediaStorageKeyForAsset(assetId, "thumbnail.webp");
    const rendered = await imagePipeline(bytes, { ...imageOptions, crop });
    const asset = createMediaAsset({
      assetId,
      sourceChannel,
      sourceReference,
      mediaType,
      mimeType: rendered.image.mimeType,
      storageKey: originalKey,
      thumbnailStorageKey: thumbnailKey,
      byteSize: rendered.image.bytes.byteLength,
      width: rendered.image.width,
      height: rendered.image.height,
      metadata,
      createdAt
    }, { idFactory, now });
    const links = owners(ownerValues).map((owner) => createMediaAssetLink({
      ...owner,
      assetId,
      createdAt,
      ownerChannel: owner.ownerChannel ?? sourceChannel
    }, { idFactory, now }));

    await storage.put(originalKey, rendered.image.bytes);
    await storage.put(thumbnailKey, rendered.thumbnail.bytes);
    return Object.freeze({ asset, links, image: Object.freeze({
      width: rendered.image.width,
      height: rendered.image.height,
      mimeType: rendered.image.mimeType,
      thumbnailWidth: rendered.thumbnail.width,
      thumbnailHeight: rendered.thumbnail.height
    }) });
  }

  async function ingestBinary({
    sourceChannel,
    sourceReference = null,
    mediaType,
    mimeType = null,
    bytes,
    owners: ownerValues,
    metadata = {},
    width = null,
    height = null,
    durationMs = null,
    createdAt = now()
  } = {}) {
    if (["image", "sticker"].includes(mediaType)) {
      throw new TypeError("image and sticker media must use ingestImage for Sharp derivatives");
    }
    const content = binaryBytes(bytes);
    const assetId = idFactory();
    const storageKey = mediaStorageKeyForAsset(assetId, "source.bin");
    const asset = createMediaAsset({
      assetId,
      sourceChannel,
      sourceReference,
      mediaType,
      mimeType,
      storageKey,
      byteSize: content.byteLength,
      width,
      height,
      durationMs,
      metadata,
      createdAt
    }, { idFactory, now });
    const links = owners(ownerValues).map((owner) => createMediaAssetLink({
      ...owner,
      assetId,
      createdAt,
      ownerChannel: owner.ownerChannel ?? sourceChannel
    }, { idFactory, now }));
    await storage.put(storageKey, content);
    return Object.freeze({ asset, links });
  }

  function createUnavailableAsset({
    sourceChannel,
    sourceReference = null,
    mediaType = "image",
    unavailableReason,
    owners: ownerValues,
    metadata = {},
    createdAt = now()
  } = {}) {
    const assetId = idFactory();
    const asset = createMediaAsset({
      assetId,
      sourceChannel,
      sourceReference,
      mediaType,
      availability: "UNAVAILABLE",
      unavailableReason,
      metadata,
      createdAt
    }, { idFactory, now });
    const links = owners(ownerValues).map((owner) => createMediaAssetLink({
      ...owner,
      assetId,
      createdAt,
      ownerChannel: owner.ownerChannel ?? sourceChannel
    }, { idFactory, now }));
    return Object.freeze({ asset, links });
  }

  return Object.freeze({ ingestImage, ingestBinary, createUnavailableAsset });
}
