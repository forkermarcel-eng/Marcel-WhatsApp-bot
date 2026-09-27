/*
 * Read-side adapter only. Existing services/contact-media.js remains the
 * WhatsApp legacy reader; callers can merge these records after the additive
 * shared-media migration is deliberately applied.
 */

const GALLERY_TYPE_BY_MEDIA_TYPE = Object.freeze({
  image: "photo",
  video: "video",
  sticker: "sticker",
  audio: "file",
  document: "document",
  file: "file"
});

function asDateValue(value) {
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function publicRef(resolver, key) {
  if (!key || typeof resolver !== "function") return null;
  const value = resolver(key);
  return typeof value === "string" && /^(?:https:\/\/|\/)/i.test(value) ? value : null;
}

export function sharedAssetToContactGalleryItem(asset, { publicRefForKey, publicRefForAsset, contactId = null, context = {} } = {}) {
  if (!asset || typeof asset !== "object" || !asset.assetId) {
    throw new TypeError("shared media asset is required");
  }
  const type = GALLERY_TYPE_BY_MEDIA_TYPE[asset.mediaType] || "file";
  return Object.freeze({
    // Namespace the id so a UUID shared asset can never accidentally select a
    // numeric legacy media row in the existing dashboard viewer.
    id: `shared:${asset.assetId}`,
    contactId,
    channel: context.channel || asset.sourceChannel,
    type,
    sourceMessageRef: context.messageReference || null,
    capturedAt: context.timestamp || asset.createdAt,
    originalRef: asset.availability === "AVAILABLE" && publicRefForAsset ? publicRefForAsset(asset,"original") : null,
    fileRef: asset.availability === "AVAILABLE"
      ? (publicRefForAsset ? publicRefForAsset(asset, "display")
        : publicRef(publicRefForKey, asset.metadata?.derivatives?.display?.storageKey || asset.storageKey))
      : null,
    thumbnailRef: asset.availability === "AVAILABLE"
      ? (publicRefForAsset && asset.thumbnailStorageKey ? publicRefForAsset(asset, "thumbnail") : publicRef(publicRefForKey, asset.thumbnailStorageKey)) : null,
    metadata: Object.freeze({
      mimeType: asset.mimeType || null,
      width: asset.width ?? null,
      height: asset.height ?? null,
      durationMs: asset.durationMs ?? null,
      caption: context.caption || null,
      filename: context.filename || null,
      direction: context.direction || null,
      sourceType: context.sourceType || null,
      assetId: asset.assetId,
      sourceProvenance:asset.metadata?.sourceProvenance||null,
      pages:asset.metadata?.pages??null,
      legacyMediaId:context.provenance?.legacyMediaId??null,
      availability: asset.availability,
      unavailableReason: asset.unavailableReason || null
    })
  });
}

export function mergeContactGalleryItems(legacyItems = [], sharedAssets = [], options = {}) {
  if (!Array.isArray(legacyItems) || !Array.isArray(sharedAssets)) {
    throw new TypeError("gallery collections must be arrays");
  }
  return Object.freeze([
    ...legacyItems,
    ...sharedAssets.map((asset) => sharedAssetToContactGalleryItem(asset, options))
  ].sort((left, right) => asDateValue(right.capturedAt) - asDateValue(left.capturedAt)
    || String(right.id).localeCompare(String(left.id))));
}

/**
 * Optional Contacts Gallery read adapter. It intentionally does not replace
 * the legacy WhatsApp reader or register a route; a future operator can use
 * it only after the additive shared-media schema exists.
 */
export function createSharedMediaContactGalleryAdapter({ repository, publicRefForKey, publicRefForAsset } = {}) {
  if (!repository || typeof repository.listAssetsForOwner !== "function") {
    throw new TypeError("shared media repository.listAssetsForOwner is required");
  }
  if (publicRefForKey !== undefined && typeof publicRefForKey !== "function") {
    throw new TypeError("publicRefForKey must be a function when supplied");
  }
  return Object.freeze({
    async listSharedItemsForContact(contactId) {
      const reference = String(contactId ?? "").trim();
      if (!reference) throw new TypeError("contactId is required");
      const owner = {
        ownerChannel: "contacts",
        ownerType: "contact",
        ownerReference: reference
      };
      const records = publicRefForAsset && repository.listContactAssetUsages
        ? await repository.listContactAssetUsages(Number(reference))
        : await repository.listAssetsForOwner(owner, { includeContext: Boolean(publicRefForAsset) });
      if (!Array.isArray(records)) throw new TypeError("shared media repository returned an invalid result");
      const items = records.map(({ asset, link }) => sharedAssetToContactGalleryItem(asset, {
        publicRefForKey, contactId: Number(reference), context: link?.context,
        publicRefForAsset: publicRefForAsset ? (value, variant) => publicRefForAsset(value, variant, owner) : undefined
      }));
      const unique = new Map();
      for (const item of items) {
        const previous = unique.get(item.id);
        unique.set(item.id, { ...(previous || item),
          channels: [...new Set([...(previous?.channels || []),item.channel])] });
      }
      return Object.freeze([...unique.values()]);
    }
  });
}
