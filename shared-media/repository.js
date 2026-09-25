import {
  normalizeMediaAsset,
  normalizeMediaAssetLink
} from "./model.js";

const PLACEHOLDER_UUID = "11111111-1111-4111-8111-111111111111";

function requirePool(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("database pool.connect and pool.query are required");
  }
  return pool;
}

function assetFromRow(row) {
  return normalizeMediaAsset({
    assetId: row.asset_id,
    sourceChannel: row.source_channel,
    sourceReference: row.source_reference,
    mediaType: row.media_type,
    mimeType: row.mime_type,
    storageKey: row.storage_key,
    thumbnailStorageKey: row.thumbnail_storage_key,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    availability: row.availability,
    unavailableReason: row.unavailable_reason,
    metadata: row.metadata,
    createdAt: row.created_at
  });
}

function linkFromRow(row) {
  return normalizeMediaAssetLink({
    linkId: row.link_id,
    assetId: row.asset_id,
    ownerChannel: row.owner_channel,
    ownerType: row.owner_type,
    ownerReference: row.owner_reference,
    relationshipType: row.relationship_type,
    ordinal: row.ordinal,
    createdAt: row.link_created_at
  });
}

function normalizedOwner(value) {
  return normalizeMediaAssetLink({
    linkId: PLACEHOLDER_UUID,
    assetId: PLACEHOLDER_UUID,
    ownerChannel: value?.ownerChannel,
    ownerType: value?.ownerType,
    ownerReference: value?.ownerReference,
    relationshipType: "attachment",
    createdAt: new Date(0)
  });
}

/**
 * Opt-in SQL adapter for the additive media_assets/media_asset_links tables.
 * Normal application startup does not construct this adapter, so a database
 * without the operator-applied migration keeps the legacy WhatsApp path.
 */
export function createSharedMediaRepository(pool) {
  requirePool(pool);

  async function insertAssetWithLinks({ asset, links } = {}) {
    const normalizedAsset = normalizeMediaAsset(asset);
    if (!Array.isArray(links) || links.length === 0) throw new TypeError("asset links are required");
    const normalizedLinks = links.map(normalizeMediaAssetLink);
    if (normalizedLinks.some((link) => link.assetId !== normalizedAsset.assetId)) {
      throw new TypeError("every link must belong to the supplied asset");
    }

    let client;
    let committed = false;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO media_assets
          (asset_id, source_channel, source_reference, media_type, mime_type,
           storage_key, thumbnail_storage_key, byte_size, width, height,
           duration_ms, availability, unavailable_reason, metadata, created_at)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)`,
        [
          normalizedAsset.assetId,
          normalizedAsset.sourceChannel,
          normalizedAsset.sourceReference,
          normalizedAsset.mediaType,
          normalizedAsset.mimeType,
          normalizedAsset.storageKey,
          normalizedAsset.thumbnailStorageKey,
          normalizedAsset.byteSize,
          normalizedAsset.width,
          normalizedAsset.height,
          normalizedAsset.durationMs,
          normalizedAsset.availability,
          normalizedAsset.unavailableReason,
          JSON.stringify(normalizedAsset.metadata),
          normalizedAsset.createdAt
        ]
      );
      for (const link of normalizedLinks) {
        await client.query(
          `INSERT INTO media_asset_links
            (link_id, asset_id, owner_channel, owner_type, owner_reference,
             relationship_type, ordinal, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            link.linkId,
            link.assetId,
            link.ownerChannel,
            link.ownerType,
            link.ownerReference,
            link.relationshipType,
            link.ordinal,
            link.createdAt
          ]
        );
      }
      await client.query("COMMIT");
      committed = true;
      return Object.freeze({ asset: normalizedAsset, links: Object.freeze(normalizedLinks) });
    } catch (error) {
      if (client && !committed) await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client?.release();
    }
  }

  async function listAssetsForOwner(owner) {
    const normalized = normalizedOwner(owner);
    const result = await pool.query(
      `SELECT a.asset_id, a.source_channel, a.source_reference, a.media_type,
              a.mime_type, a.storage_key, a.thumbnail_storage_key, a.byte_size,
              a.width, a.height, a.duration_ms, a.availability,
              a.unavailable_reason, a.metadata, a.created_at,
              l.link_id, l.owner_channel, l.owner_type, l.owner_reference,
              l.relationship_type, l.ordinal, l.created_at AS link_created_at
       FROM media_asset_links l
       JOIN media_assets a ON a.asset_id = l.asset_id
       WHERE l.owner_channel = $1
         AND l.owner_type = $2
         AND l.owner_reference = $3
       ORDER BY a.created_at DESC, l.ordinal ASC NULLS LAST, l.link_id DESC`,
      [normalized.ownerChannel, normalized.ownerType, normalized.ownerReference]
    );
    return Object.freeze(result.rows.map((row) => Object.freeze({
      asset: assetFromRow(row),
      link: linkFromRow(row)
    })));
  }

  return Object.freeze({ insertAssetWithLinks, listAssetsForOwner });
}
