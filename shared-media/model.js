import { randomUUID } from "node:crypto";

/*
 * Shared media is deliberately channel-neutral.  It records stored product
 * media and its ordinary owners; it is not an identity, fingerprint, queue,
 * or capture subsystem.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const TOKEN_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export const MEDIA_TYPES = Object.freeze([
  "image",
  "video",
  "sticker",
  "audio",
  "document",
  "file"
]);

export const MEDIA_AVAILABILITY = Object.freeze([
  "AVAILABLE",
  "UNAVAILABLE"
]);

// These are conveniences, not a closed enum. Future channel owners remain
// valid without another media table or a schema change.
export const MEDIA_OWNER_TYPES = Object.freeze({
  TINDER_PROFILE: "tinder_profile",
  WHATSAPP_MESSAGE: "whatsapp_message",
  CONTACT: "contact",
  CONVERSATION: "conversation"
});

export const MEDIA_RELATION_TYPES = Object.freeze({
  PROFILE_MEDIA: "profile_media",
  ATTACHMENT: "attachment",
  GALLERY: "gallery"
});

function requiredText(value, field, maximum = 2048) {
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new TypeError(`${field} is invalid`);
  return normalized;
}

function nullableText(value, field, maximum = 2048) {
  if (value === null || value === undefined || value === "") return null;
  return requiredText(value, field, maximum);
}

function token(value, field) {
  const normalized = requiredText(value, field, 64).toLowerCase();
  if (!TOKEN_PATTERN.test(normalized)) throw new TypeError(`${field} is invalid`);
  return normalized;
}

function mediaStorageKey(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const normalized = requiredText(value, field, 512);
  if (!KEY_PATTERN.test(normalized)
    || normalized.startsWith("/")
    || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized;
}

function nullableNonNegativeInteger(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return number;
}

function nullablePositiveInteger(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${field} must be a positive integer`);
  return number;
}

function jsonObject(value, field) {
  if (value === null || value === undefined) return Object.freeze({});
  if (Array.isArray(value) || typeof value !== "object") throw new TypeError(`${field} must be an object`);
  try {
    JSON.stringify(value);
  } catch {
    throw new TypeError(`${field} must be JSON serializable`);
  }
  return Object.freeze({ ...value });
}

function timestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a valid timestamp`);
  return date.toISOString();
}

function uuid(value, field) {
  const normalized = requiredText(value, field, 36).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new TypeError(`${field} must be a UUID`);
  return normalized;
}

export function normalizeMediaAsset(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("media asset must be an object");
  }
  const availability = requiredText(value.availability ?? "AVAILABLE", "asset.availability", 16).toUpperCase();
  if (!MEDIA_AVAILABILITY.includes(availability)) throw new TypeError("asset.availability is invalid");

  const storageKey = mediaStorageKey(value.storageKey, "asset.storageKey");
  const thumbnailStorageKey = mediaStorageKey(value.thumbnailStorageKey, "asset.thumbnailStorageKey");
  const unavailableReason = nullableText(value.unavailableReason, "asset.unavailableReason", 160);
  if (availability === "AVAILABLE" && !storageKey) {
    throw new TypeError("available asset.storageKey is required");
  }
  if (availability === "UNAVAILABLE" && (storageKey || thumbnailStorageKey || !unavailableReason)) {
    throw new TypeError("unavailable assets must not have storage and require a reason");
  }

  const mediaType = token(value.mediaType, "asset.mediaType");
  if (!MEDIA_TYPES.includes(mediaType)) throw new TypeError("asset.mediaType is invalid");
  const mimeType = nullableText(value.mimeType, "asset.mimeType", 255)?.toLowerCase() || null;
  if (mimeType && !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimeType)) throw new TypeError("asset.mimeType is invalid");

  return Object.freeze({
    assetId: uuid(value.assetId, "asset.assetId"),
    sourceChannel: token(value.sourceChannel, "asset.sourceChannel"),
    sourceReference: nullableText(value.sourceReference, "asset.sourceReference", 2048),
    mediaType,
    mimeType,
    storageKey,
    thumbnailStorageKey,
    byteSize: nullableNonNegativeInteger(value.byteSize, "asset.byteSize"),
    width: nullablePositiveInteger(value.width, "asset.width"),
    height: nullablePositiveInteger(value.height, "asset.height"),
    durationMs: nullableNonNegativeInteger(value.durationMs, "asset.durationMs"),
    availability,
    unavailableReason,
    metadata: jsonObject(value.metadata, "asset.metadata"),
    createdAt: timestamp(value.createdAt, "asset.createdAt")
  });
}

export function createMediaAsset(value, { idFactory = randomUUID, now = () => new Date() } = {}) {
  if (typeof idFactory !== "function" || typeof now !== "function") {
    throw new TypeError("idFactory and now must be functions");
  }
  return normalizeMediaAsset({
    ...value,
    assetId: value?.assetId ?? idFactory(),
    createdAt: value?.createdAt ?? now()
  });
}

export function normalizeMediaAssetLink(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("media asset link must be an object");
  }
  const ordinal = nullableNonNegativeInteger(value.ordinal, "link.ordinal");
  return Object.freeze({
    linkId: uuid(value.linkId, "link.linkId"),
    assetId: uuid(value.assetId, "link.assetId"),
    ownerChannel: token(value.ownerChannel, "link.ownerChannel"),
    ownerType: token(value.ownerType, "link.ownerType"),
    ownerReference: requiredText(value.ownerReference, "link.ownerReference", 2048),
    relationshipType: token(value.relationshipType ?? "attachment", "link.relationshipType"),
    ordinal,
    createdAt: timestamp(value.createdAt, "link.createdAt")
  });
}

export function createMediaAssetLink(value, { idFactory = randomUUID, now = () => new Date() } = {}) {
  if (typeof idFactory !== "function" || typeof now !== "function") {
    throw new TypeError("idFactory and now must be functions");
  }
  return normalizeMediaAssetLink({
    ...value,
    linkId: value?.linkId ?? idFactory(),
    createdAt: value?.createdAt ?? now()
  });
}

export function mediaStorageKeyForAsset(assetId, name) {
  const validAssetId = uuid(assetId, "assetId");
  const validName = requiredText(name, "name", 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(validName)) throw new TypeError("name is invalid");
  return `media-assets/${validAssetId}/${validName}`;
}
