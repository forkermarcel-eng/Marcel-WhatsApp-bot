function normalizePublicMediaRef(value) {
  const ref = String(value || "").trim();
  return /^(?:https:\/\/|\/)/i.test(ref) ? ref : null;
}

function normalizeContactMediaItem(item) {
  const rawType = String(item.media_type || "file").toLowerCase();
  const type = /sticker/.test(rawType)
    ? "sticker"
    : /video/.test(rawType)
      ? "video"
      : /image|photo/.test(rawType)
        ? "photo"
        : /document|pdf|doc/.test(rawType)
          ? "document"
          : "file";

  return {
    id: item.id,
    contactId: item.contact_id,
    channel: "whatsapp",
    type,
    sourceMessageRef: item.message_id || item.whatsapp_message_id || null,
    capturedAt: item.received_at || item.created_at,
    fileRef: normalizePublicMediaRef(item.storage_path),
    thumbnailRef: normalizePublicMediaRef(item.thumbnail_path),
    fingerprint: null,
    metadata: {
      mimeType: item.mime_type || null,
      caption: item.caption || null,
      analysis: item.ai_description || null,
      tags: Array.isArray(item.ai_tags) ? item.ai_tags : [],
      safety: item.sensitivity || "normal",
      memoryCandidate: Number(item.memory_relevance || 0) > 1,
      reviewStatus: "not_reviewed",
      stickerCatalog: type === "sticker" ? {
        favorite: null,
        neverAutoUse: null,
        flirtOnly: null,
        allowedContactIds: [],
        semanticCategory: null,
        usageCount: null
      } : null,
      relatedMemoryItemIds: item.related_memory_item_ids || [],
      relatedEventIds: item.related_event_ids || []
    }
  };
}

function createContactMediaService(pool) {
  async function listContactMedia(contactId) {
    const result = await pool.query(
      `SELECT id, contact_id, message_id, whatsapp_message_id,
              media_type, mime_type, storage_path, thumbnail_path,
              caption, ai_description, ai_tags, sensitivity,
              memory_relevance, related_memory_item_ids,
              related_event_ids, received_at, created_at
       FROM media
       WHERE contact_id = $1
       ORDER BY COALESCE(received_at, created_at) DESC, id DESC
       LIMIT 250`,
      [contactId]
    );

    return result.rows.map(normalizeContactMediaItem);
  }

  return Object.freeze({ listContactMedia });
}

export {
  createContactMediaService,
  normalizeContactMediaItem,
  normalizePublicMediaRef
};
