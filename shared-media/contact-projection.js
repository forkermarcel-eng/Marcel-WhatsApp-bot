import { resolveContactAvatar } from "./avatar.js";
import { mediaDeliveryUrl } from "./delivery.js";

export function createContactMediaProjection({ repository, pool }) {
  return async function project(contactId, legacyPhoto = null) {
    if (!Number.isSafeInteger(contactId) || contactId < 1) throw new TypeError("contactId required");
    const owner = { ownerChannel: "contacts", ownerType: "contact", ownerReference: String(contactId) };
    const records = await repository.listAssetsForOwner(owner,{ includeContext: true });
    const profiles = await pool.query(`SELECT c.conversation_id,c.device_id,c.profile FROM contact_identifiers i
      JOIN tinder_conversations c ON i.normalized_value='mirror:' || c.device_id::text || ':' || c.conversation_id::text
      WHERE i.contact_id=$1 AND i.identifier_type='tinder_profile' AND i.human_verified=TRUE
      UNION ALL
      SELECT NULL::uuid AS conversation_id,m.device_id,to_jsonb(m)->'profile' AS profile FROM contact_identifiers i
      JOIN tinder_matches m ON i.normalized_value='mirror-match:' || m.device_id::text || ':' || m.match_id::text
      WHERE i.contact_id=$1 AND i.identifier_type='tinder_profile' AND i.human_verified=TRUE
        AND m.conversation_id IS NULL AND to_jsonb(m)->'profile' IS NOT NULL AND to_jsonb(m)->'profile'<>'null'::jsonb
      ORDER BY conversation_id NULLS LAST`,[contactId]);
    const avatar = resolveContactAvatar({ records,legacyPhoto,
      urlForAsset: (asset,variant) => mediaDeliveryUrl(asset.assetId,owner,variant) });
    return { avatar, profilePhotoUrl: avatar.url,
      tinderProfiles: profiles.rows.map(row => ({ conversationId: row.conversation_id, profile: row.profile })) };
  };
}
