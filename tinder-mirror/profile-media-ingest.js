import {
  MEDIA_OWNER_TYPES,
  MEDIA_RELATION_TYPES
} from "../shared-media/model.js";

function requiredProfileReference(value) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("profileReference is required");
  return value.trim();
}

function positionValue(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("position must be a non-negative integer");
  return value;
}

function profileOwner(profileReference, position) {
  return {
    ownerType: MEDIA_OWNER_TYPES.TINDER_PROFILE,
    ownerReference: profileReference,
    relationshipType: MEDIA_RELATION_TYPES.PROFILE_MEDIA,
    ordinal: position
  };
}

/*
 * This intentionally has no device-control client, Android transport, and no
 * screenshot command. A permitted caller passes image bytes that it already
 * obtained from either an element screenshot or a freshly verified screen
 * region. The adapter turns those bytes into ordinary shared media records.
 */
export function createTinderProfileMediaIngestor({ assetService } = {}) {
  if (!assetService || typeof assetService.ingestImage !== "function"
    || typeof assetService.createUnavailableAsset !== "function") {
    throw new TypeError("shared media assetService is required");
  }

  async function ingestElementScreenshot({
    profileReference,
    imageBytes,
    position = null,
    metadata = {},
    createdAt,
    imageOptions
  } = {}) {
    const profile = requiredProfileReference(profileReference);
    return assetService.ingestImage({
      sourceChannel: "tinder",
      sourceReference: profile,
      bytes: imageBytes,
      crop: null,
      owners: [profileOwner(profile, positionValue(position))],
      metadata: { ...metadata, ingestMode: "element_screenshot" },
      createdAt,
      imageOptions
    });
  }

  async function ingestVerifiedScreenRegion({
    profileReference,
    screenBytes,
    verifiedMediaBounds,
    observationReference,
    position = null,
    metadata = {},
    createdAt,
    imageOptions
  } = {}) {
    const profile = requiredProfileReference(profileReference);
    if (typeof observationReference !== "string" || !observationReference.trim()) {
      throw new TypeError("observationReference is required for a screen-region ingest");
    }
    if (!verifiedMediaBounds || typeof verifiedMediaBounds !== "object") {
      throw new TypeError("verifiedMediaBounds is required for a screen-region ingest");
    }
    return assetService.ingestImage({
      sourceChannel: "tinder",
      sourceReference: profile,
      bytes: screenBytes,
      crop: verifiedMediaBounds,
      owners: [profileOwner(profile, positionValue(position))],
      metadata: {
        ...metadata,
        ingestMode: "verified_screen_region"
      },
      createdAt,
      imageOptions
    });
  }

  function recordUnavailable({
    profileReference,
    reason,
    position = null,
    metadata = {},
    createdAt
  } = {}) {
    const profile = requiredProfileReference(profileReference);
    return assetService.createUnavailableAsset({
      sourceChannel: "tinder",
      sourceReference: profile,
      mediaType: "image",
      unavailableReason: reason,
      owners: [profileOwner(profile, positionValue(position))],
      metadata,
      createdAt
    });
  }

  return Object.freeze({
    ingestElementScreenshot,
    ingestVerifiedScreenRegion,
    recordUnavailable
  });
}
