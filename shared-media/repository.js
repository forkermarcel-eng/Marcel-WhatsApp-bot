import {
  normalizeMediaAsset,
  normalizeMediaAssetLink
} from "./model.js";
import { normalizeMediaAnalysis } from "./analysis.js";

const PLACEHOLDER_UUID = "11111111-1111-4111-8111-111111111111";

/*
 * The storage adapter may safely compensate only a database failure whose
 * outcome this repository itself can prove.  In particular, a connection
 * failure while COMMIT is in flight is not evidence that the transaction
 * rolled back: deleting its object could break a record that committed just
 * before the connection was lost.  This is intentionally a small local
 * outcome marker, not a retry queue or a new persistence protocol.
 */
function markPersistenceOutcome(error, outcome) {
  try {
    Object.defineProperty(error, "sharedMediaPersistenceOutcome", {
      value: outcome,
      configurable: true
    });
  } catch {
    // Preserve the original repository failure even if an unusual Error-like
    // object cannot carry the optional local marker.
  }
  return error;
}

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
    context: row.context,
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

  async function insertAssetWithLinks({ asset, links } = {}, transactionClient = null) {
    const normalizedAsset = normalizeMediaAsset(asset);
    if (!Array.isArray(links) || links.length === 0) throw new TypeError("asset links are required");
    const normalizedLinks = links.map(normalizeMediaAssetLink);
    if (normalizedLinks.some((link) => link.assetId !== normalizedAsset.assetId)) {
      throw new TypeError("every link must belong to the supplied asset");
    }

    let client;
    let committed = false;
    let commitAttempted = false;
    try {
      client = transactionClient || await pool.connect();
      if (!transactionClient) await client.query("BEGIN");
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
      await insertLinks(client, normalizedLinks, Boolean(transactionClient)
        || normalizedLinks.some(link => Object.keys(link.context).length > 0));
      commitAttempted = true;
      if (!transactionClient) await client.query("COMMIT");
      committed = true;
      return Object.freeze({ asset: normalizedAsset, links: Object.freeze(normalizedLinks) });
    } catch (error) {
      if (transactionClient) throw error;
      if (committed) throw error;
      if (!client) throw markPersistenceOutcome(error, "NOT_STARTED");
      // An exception while COMMIT is being attempted is deliberately
      // unresolved.  Do not report it as rollback-safe merely because a
      // follow-up rollback request happens to be accepted or ignored.
      if (commitAttempted) throw markPersistenceOutcome(error, "UNRESOLVED");
      try {
        await client.query("ROLLBACK");
        throw markPersistenceOutcome(error, "ROLLED_BACK");
      } catch (rollbackError) {
        if (rollbackError === error) throw rollbackError;
        throw markPersistenceOutcome(error, "UNRESOLVED");
      }
    } finally {
      if (!transactionClient) client?.release();
    }
  }

  async function insertLinks(client, links, withContext = false) {
    for (const link of links) {
      await client.query(
        `INSERT INTO media_asset_links
          (link_id, asset_id, owner_channel, owner_type, owner_reference,
           relationship_type, ordinal, created_at${withContext ? ", context" : ""})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8${withContext ? ",$9::jsonb" : ""})
         ${withContext ? `ON CONFLICT (asset_id, owner_channel, owner_type, owner_reference, relationship_type, (COALESCE(ordinal, -1)))
           DO UPDATE SET context=jsonb_set(media_asset_links.context,'{provenance}',EXCLUDED.context->'provenance')
           WHERE (EXCLUDED.context->'provenance'->'profileCollectionSize' IS NOT NULL
             OR EXCLUDED.context->'provenance'->'avatarObservedAt' IS NOT NULL)
             AND EXCLUDED.context->'provenance' IS DISTINCT FROM media_asset_links.context->'provenance'` : ""}`,
        [link.linkId, link.assetId, link.ownerChannel, link.ownerType,
          link.ownerReference, link.relationshipType, link.ordinal, link.createdAt,
          ...(withContext ? [JSON.stringify(link.context)] : [])]
      );
    }
  }

  // Enabled only by the universal ingress after its explicit migration.
  // The DB lock covers lookup, file publication, asset insert and owner links.
  // A unique hash index additionally rejects writers bypassing this method.
  async function withContentTransaction(digest, work) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError("invalid SHA-256");
    return withMediaTransaction(`media:${digest}`,
      "SELECT * FROM media_assets WHERE metadata->>'sourceSha256' = $1", [digest], work);
  }

  async function withUnavailableTransaction(owner, work) {
    const normalized = normalizedOwner(owner);
    const values=[normalized.ownerChannel,normalized.ownerType,normalized.ownerReference,
      owner.relationshipType,owner.ordinal??null,JSON.stringify(owner.context||{})];
    return withMediaTransaction(`unavailable:${JSON.stringify(values)}`,
      `SELECT a.* FROM media_assets a JOIN media_asset_links l ON l.asset_id=a.asset_id
       WHERE a.availability='UNAVAILABLE' AND l.owner_channel=$1 AND l.owner_type=$2
         AND l.owner_reference=$3 AND l.relationship_type=$4 AND l.ordinal IS NOT DISTINCT FROM $5::int
         AND l.context=$6::jsonb ORDER BY a.created_at LIMIT 1`,values,work);
  }

  async function withMediaTransaction(lockKey, lookup, values, work) {
    const client = await pool.connect();
    let commitAttempted = false;
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
      const found = await client.query(lookup, values);
      const result = await work({
        existing: found.rows[0] ? assetFromRow(found.rows[0]) : null,
        insertAssetWithLinks: record => insertAssetWithLinks(record, client),
        attachLinks: links => insertLinks(client, links.map(normalizeMediaAssetLink), true)
      });
      commitAttempted = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (commitAttempted) { discard = true; throw markPersistenceOutcome(error, "UNRESOLVED"); }
      try { await client.query("ROLLBACK"); }
      catch { discard = true; throw markPersistenceOutcome(error, "UNRESOLVED"); }
      throw markPersistenceOutcome(error, "ROLLED_BACK");
    } finally { client.release(discard); }
  }

  async function listAssetsForOwner(owner, { includeContext = false } = {}) {
    const normalized = normalizedOwner(owner);
    const result = await pool.query(
      `SELECT a.asset_id, a.source_channel, a.source_reference, a.media_type,
              a.mime_type, a.storage_key, a.thumbnail_storage_key, a.byte_size,
              a.width, a.height, a.duration_ms, a.availability,
              a.unavailable_reason, a.metadata, a.created_at,
              l.link_id, l.owner_channel, l.owner_type, l.owner_reference,
              l.relationship_type, l.ordinal, l.created_at AS link_created_at
              ${includeContext ? ", l.context" : ""}
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

  async function assetForOwner(assetId, owner) {
    const normalized = normalizedOwner(owner);
    const result = await pool.query(`SELECT a.* FROM media_assets a
      WHERE a.asset_id=$1 AND EXISTS (SELECT 1 FROM media_asset_links l
        WHERE l.asset_id=a.asset_id AND l.owner_channel=$2 AND l.owner_type=$3 AND l.owner_reference=$4)`,
    [assetId, normalized.ownerChannel, normalized.ownerType, normalized.ownerReference]);
    return result.rows[0] ? assetFromRow(result.rows[0]) : null;
  }

  async function listContactAssetUsages(contactId) {
    if (!Number.isSafeInteger(contactId) || contactId < 1) throw new TypeError("contactId required");
    const result = await pool.query(`SELECT DISTINCT a.*, l.context
      FROM media_assets a JOIN media_asset_links l ON l.asset_id=a.asset_id
      WHERE (l.context->>'contactId'=$1::text OR
        (l.owner_channel='contacts' AND l.owner_type='contact' AND l.owner_reference=$1::text))
        AND EXISTS (SELECT 1 FROM media_asset_links c WHERE c.asset_id=a.asset_id
          AND c.owner_channel='contacts' AND c.owner_type='contact' AND c.owner_reference=$1::text)
      ORDER BY a.created_at DESC, a.asset_id LIMIT 1001`, [String(contactId)]);
    if (result.rows.length > 1000) throw new Error("CONTACT_MEDIA_WINDOW_TOO_LARGE");
    return result.rows.map(row => ({ asset:assetFromRow(row),link:{context:row.context} }));
  }

  async function saveAnalysis(value) {
    const analysis = normalizeMediaAnalysis(value);
    const result = await pool.query(`UPDATE media_assets SET metadata = jsonb_set(metadata,
      '{analyses}', COALESCE(metadata->'analyses','{}'::jsonb) || jsonb_build_object($2::text,$3::jsonb))
      WHERE asset_id=$1 RETURNING asset_id`, [analysis.assetId, analysis.analysisId, JSON.stringify(analysis)]);
    if (result.rowCount !== 1) throw new Error("ASSET_NOT_FOUND");
    return analysis;
  }

  // Called inside the existing confirmed person-binding transaction. Reuse
  // assets already scoped to that exact mirror conversation; never match names.
  async function attachConversationContact(client, { contactId, conversationId, matchId }) {
    const reference=matchId ?? conversationId;
    const contextKey=matchId?"matchReference":"conversationReference";
    const ownerType=matchId?"match":"conversation";
    if (!Number.isSafeInteger(contactId) || contactId < 1 || typeof reference !== "string" || (matchId&&conversationId)) {
      throw new TypeError("confirmed contact and conversation required");
    }
    const conflict=await client.query(`SELECT link_id FROM media_asset_links
      WHERE owner_channel='tinder' AND context->>'${contextKey}'=$1
        AND context->>'contactId' IS NOT NULL AND context->>'contactId'<>$2::text
      LIMIT 1 FOR UPDATE`,[reference,String(contactId)]);
    if(conflict.rows.length)throw new Error("MEDIA_CONTACT_BINDING_CONFLICT");
    await client.query(`UPDATE media_asset_links SET context=jsonb_set(context,'{contactId}',to_jsonb($1::int))
      WHERE owner_channel='tinder' AND context->>'${contextKey}'=$2
        AND (context->>'contactId' IS NULL OR context->>'contactId'=$1::text)`, [contactId,reference]);
    await client.query(`INSERT INTO media_asset_links
      (link_id,asset_id,owner_channel,owner_type,owner_reference,relationship_type,ordinal,context)
      SELECT gen_random_uuid(),asset_id,'contacts','contact',$1::text,relationship_type,ordinal,context
      FROM media_asset_links
      WHERE owner_channel='tinder' AND owner_type='${ownerType}' AND owner_reference=$2
        AND context->>'contactId'=$1::text
      ON CONFLICT DO NOTHING`, [contactId,reference]);
  }

  async function transferMatchMedia(client,{matchId,conversationId,contactId=null}) {
    if(typeof matchId!=="string"||typeof conversationId!=="string")throw new TypeError("verified match and conversation required");
    if(contactId!==null)await attachConversationContact(client,{matchId,contactId});
    await client.query(`INSERT INTO media_asset_links
      (link_id,asset_id,owner_channel,owner_type,owner_reference,relationship_type,ordinal,context)
      SELECT gen_random_uuid(),asset_id,'tinder',target.kind,
        $2,CASE WHEN relationship_type='match_avatar' THEN 'conversation_avatar' ELSE relationship_type END,
        ordinal,jsonb_set(context,'{conversationReference}',to_jsonb($2::text))
      FROM media_asset_links CROSS JOIN (VALUES ('conversation'),('profile')) AS target(kind)
      WHERE owner_channel='tinder' AND owner_type='match' AND owner_reference=$1
        AND (target.kind='conversation' OR context->>'sourceType'='profile')
      ON CONFLICT DO NOTHING`,[matchId,conversationId]);
    if(contactId!==null)await attachConversationContact(client,{conversationId,contactId});
  }

  async function listAttachments({ contactId, channel, conversationReference, profileReference=null, messageReferences, profileLimit }) {
    if (!Number.isSafeInteger(contactId) || contactId < 1 || !Array.isArray(messageReferences)
      || messageReferences.length > 200 || !Number.isInteger(profileLimit) || profileLimit < 0 || profileLimit > 20) {
      throw new TypeError("bounded contact context required");
    }
    // Owner links establish access; source SDK objects are never returned.
    const result = await pool.query(`SELECT a.*, l.context FROM media_asset_links l
      JOIN media_assets a ON a.asset_id=l.asset_id
      WHERE l.owner_channel=$2 AND ((l.context->>'conversationReference'=$3 AND $3::text IS NOT NULL)
          OR (l.context->>'profileReference'=$5 AND l.context->>'sourceType'='profile' AND $5::text IS NOT NULL))
        AND l.context->>'contactId'=$1::text
        AND ((l.owner_type='message' AND l.owner_reference=ANY($4::text[]))
          OR (l.owner_type='profile' AND l.context->>'sourceType'='profile'))
        AND EXISTS (SELECT 1 FROM media_asset_links c WHERE c.asset_id=a.asset_id
          AND c.owner_channel='contacts' AND c.owner_type='contact' AND c.owner_reference=$1::text)
      ORDER BY l.ordinal ASC NULLS LAST, l.created_at, l.link_id
      LIMIT 1001`, [String(contactId), channel, conversationReference, messageReferences, profileReference]);
    if (result.rows.length > 1000) throw new Error("MEDIA_CONTEXT_WINDOW_TOO_LARGE");
    return result.rows.map(row => ({ asset: assetFromRow(row), context: row.context }));
  }

  return Object.freeze({ insertAssetWithLinks, listAssetsForOwner, withContentTransaction, withUnavailableTransaction, assetForOwner,
    saveAnalysis, listAttachments, attachConversationContact, listContactAssetUsages, transferMatchMedia });
}
