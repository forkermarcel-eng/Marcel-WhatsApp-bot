import { TinderMirrorError } from "./conversation.js";
import { tinderContactReference } from "./contact-binding.js";
import { mediaDeliveryUrl } from "../shared-media/delivery.js";
import { fileTypeFromBuffer } from "file-type";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function createTinderMediaService({ pool, media }) {
  return Object.freeze({
    async ingest({ deviceId, ownerId, ownerType, kind, ordinal = 0, sourceBytes, profileCollectionSize=null }) {
      if (!UUID.test(deviceId) || !UUID.test(ownerId) || !["conversation","match"].includes(ownerType)
        || !["profile","avatar"].includes(kind) || !Number.isInteger(ordinal) || ordinal < 0 || ordinal > 39) {
        throw new TinderMirrorError("INVALID_MEDIA_CONTEXT","Invalid Tinder media owner");
      }
      if(profileCollectionSize!==null && (kind!=="profile"||!Number.isInteger(profileCollectionSize)
        ||profileCollectionSize<1||profileCollectionSize>40||ordinal>=profileCollectionSize))throw new TinderMirrorError("INVALID_MEDIA_CONTEXT","Invalid observed collection size");
      if (!Buffer.isBuffer(sourceBytes) || sourceBytes.length < 8 || sourceBytes.length > 8 * 1024 * 1024) {
        throw new TinderMirrorError("INVALID_MEDIA_BYTES","Bounded cropped source bytes required");
      }
      const detected = await fileTypeFromBuffer(sourceBytes).catch(() => null);
      if (!["image/png", "image/jpeg", "image/webp"].includes(detected?.mime)) {
        throw new TinderMirrorError("INVALID_MEDIA_BYTES","Raster screenshot crop required");
      }
      const table = ownerType === "conversation" ? "tinder_conversations" : "tinder_matches";
      const column = ownerType === "conversation" ? "conversation_id" : "match_id";
      const found = await pool.query(`SELECT ${column} FROM ${table} WHERE ${column}=$1 AND device_id=$2`,[ownerId,deviceId]);
      if (found.rows.length !== 1) throw new TinderMirrorError("MEDIA_OWNER_NOT_FOUND","Owner not found",404);
      let contactId = null;
      {
        const binding = await pool.query(`SELECT contact_id FROM contact_identifiers WHERE identifier_type='tinder_profile'
          AND normalized_value=$1 AND human_verified=TRUE`,[tinderContactReference({ deviceId,
            ...(ownerType==="match"?{matchId:ownerId}:{conversationId:ownerId}) })]);
        if (binding.rows.length === 1) contactId = Number(binding.rows[0].contact_id);
      }
      const result = await media.ingress.ingest({ input: sourceBytes, context: {
        channel: "tinder", contactId, sourceType: kind === "profile" ? "profile" : "avatar",
        conversationReference: ownerType === "conversation" ? ownerId : null,
        matchReference: ownerType === "match" ? ownerId : null,
        profileReference: kind === "profile" ? ownerId : null,
        role: kind === "profile" ? (ordinal === 0 ? "profile_primary" : "profile_photo")
          : ownerType === "match" ? "match_avatar" : "conversation_avatar",
        ordinal, provenance: { kind: "screenshot_crop", ownerType, deviceId,
          ...(profileCollectionSize!==null?{profileCollectionSize}: {}),
          ...(kind === "avatar" ? {avatarObservedAt:new Date().toISOString()} : {}) }
      } });
      return { asset_id: result.asset.assetId, reused: result.reused };
    },
    async present(ownerType, ownerId) {
      const owner = { ownerChannel: "tinder", ownerType, ownerReference: ownerId };
      const rows = await media.repository.listAssetsForOwner(owner,{ includeContext: true });
      const available = rows.filter(row => row.asset.availability === "AVAILABLE");
      const completeSizes=available.map(row=>row.link.context?.provenance?.profileCollectionSize)
        .filter(size=>Number.isInteger(size)&&size>0&&size<=40);
      const profileCollectionComplete=completeSizes.some(size=>Array.from({length:size},(_,ordinal)=>ordinal).every(ordinal=>
        available.some(row=>row.link.ordinal===ordinal && ["profile_primary","profile_photo"].includes(row.link.relationshipType)
          && row.link.context?.provenance?.profileCollectionSize===size)));
      const avatar = available.filter(row => row.link.relationshipType === `${ownerType}_avatar`)
        .sort((a,b)=>String(b.link.context?.provenance?.avatarObservedAt || b.asset.createdAt || "")
          .localeCompare(String(a.link.context?.provenance?.avatarObservedAt || a.asset.createdAt || "")))[0]
        || available.find(row => row.link.relationshipType === "profile_primary");
      return { avatar_url: avatar ? mediaDeliveryUrl(avatar.asset.assetId,owner,"thumbnail") : null,
        avatar_source_sha256:avatar?.asset.metadata?.sourceSha256 ?? null,
        profile_collection_complete:profileCollectionComplete,
        media: available.map(row => ({ asset_id: row.asset.assetId, role: row.link.relationshipType,
          ordinal: row.link.ordinal, url: mediaDeliveryUrl(row.asset.assetId,owner,"display") })) };
    }
  });
}

export function registerTinderMediaRoutes({ app, service, authorized }) {
  app.post("/dashboard-api/tinder/:ownerType/:ownerId/media",async (req,res) => {
    if (!authorized(req)) return res.status(401).json({ ok: false });
    try {
      const encoded = req.body?.source_base64;
      if (typeof encoded !== "string" || encoded.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        throw new TinderMirrorError("INVALID_MEDIA_BYTES","Invalid encoded source");
      }
      const ownerType = { conversations: "conversation", matches: "match" }[req.params.ownerType];
      const result = await service.ingest({ deviceId: req.body.device_id, ownerType, ownerId: req.params.ownerId,
        kind: req.body.kind, ordinal: req.body.ordinal, sourceBytes: Buffer.from(encoded,"base64"),
        profileCollectionSize:req.body.profile_collection_size??null });
      return res.status(200).json({ ok: true,...result });
    } catch (error) {
      return res.status(error instanceof TinderMirrorError ? error.status : 500)
        .json({ ok: false,error: error instanceof TinderMirrorError ? error.code : "MEDIA_INGEST_FAILED" });
    }
  });
}
