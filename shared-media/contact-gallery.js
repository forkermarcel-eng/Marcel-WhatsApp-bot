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

export function sharedAssetToContactGalleryItem(asset, { publicRefForKey } = {}) {
  if (!asset || typeof asset !== "object" || !asset.assetId) {
    throw new TypeError("shared media asset is required");
  }
  const type = GALLERY_TYPE_BY_MEDIA_TYPE[asset.mediaType] || "file";
  return Object.freeze({
    // Namespace the id so a UUID shared asset can never accidentally select a
    // numeric legacy media row in the existing dashboard viewer.
    id: `shared:${asset.assetId}`,
    contactId: null,
    channel: asset.sourceChannel,
    type,
    sourceMessageRef: null,
    capturedAt: asset.createdAt,
    fileRef: asset.availability === "AVAILABLE" ? publicRef(publicRefForKey, asset.storageKey) : null,
    thumbnailRef: asset.availability === "AVAILABLE" ? publicRef(publicRefForKey, asset.thumbnailStorageKey) : null,
    metadata: Object.freeze({
      mimeType: asset.mimeType || null,
      width: asset.width ?? null,
      height: asset.height ?? null,
      durationMs: asset.durationMs ?? null,
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
export function createSharedMediaContactGalleryAdapter({ repository, publicRefForKey } = {}) {
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
      const records = await repository.listAssetsForOwner({
        ownerChannel: "contacts",
        ownerType: "contact",
        ownerReference: reference
      });
      if (!Array.isArray(records)) throw new TypeError("shared media repository returned an invalid result");
      return Object.freeze(records.map(({ asset }) => sharedAssetToContactGalleryItem(asset, { publicRefForKey })));
    }
  });
}
