// Presentation selection only. Neither hashes nor image similarity establish a person.
const PRIORITY = ["profile_primary", "profile_photo", "conversation_avatar", "match_avatar"];
export function resolveContactAvatar({ records = [], legacyPhoto = null, urlForAsset }) {
  const candidates = records.filter(({ asset, link }) => asset?.availability === "AVAILABLE"
    && asset.mediaType === "image" && PRIORITY.includes(link?.relationshipType));
  candidates.sort((a,b) => PRIORITY.indexOf(a.link.relationshipType) - PRIORITY.indexOf(b.link.relationshipType)
    || (b.asset.width || 0) * (b.asset.height || 0) - (a.asset.width || 0) * (a.asset.height || 0)
    || a.asset.assetId.localeCompare(b.asset.assetId));
  for (const { asset } of candidates) {
    const url = urlForAsset?.(asset, "thumbnail");
    if (typeof url === "string" && /^(\/[^/]|https:\/\/)/i.test(url)) return { assetId: asset.assetId, url };
  }
  return { assetId: null, url: typeof legacyPhoto === "string" && /^(\/[^/]|https:\/\/)/i.test(legacyPhoto) ? legacyPhoto : null };
}
