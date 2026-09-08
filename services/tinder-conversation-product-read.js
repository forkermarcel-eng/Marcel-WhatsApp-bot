/**
 * Read-only product projection for the Tinder conversation screen.
 *
 * The legacy capture-detail reader intentionally remains a redacted mapping
 * context.  This module is a separate, narrowly-shaped reader for a capture
 * that has already reached both durable resolution gates.  It never returns
 * device, contact, fingerprint, revision, provenance, source-class, or raw
 * JSON metadata fields.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TINDER_SOURCE_PACKAGE = "com.tinder";
const TINDER_CONVERSATION_MAPPING_STATUS = "RESOLVED";
const TINDER_CONVERSATION_REVIEW_STATUS = "CONFIRMED";
const TINDER_CONVERSATION_SAFETY_STATUS = "SAFE";
const TINDER_LATEST_CONFIRMED_CONVERSATION_LIMIT = 25;
const TINDER_CONVERSATION_MESSAGE_LIMIT = 100;
const TINDER_CONVERSATION_MESSAGE_TEXT_LIMIT = 4096;
const MESSAGE_DIRECTIONS = new Set(["INCOMING", "OUTGOING", "UNKNOWN"]);
const VISIBLE_CHAT_SYNC_MESSAGE_DIRECTIONS = new Set(["INCOMING", "OUTGOING"]);
const VISIBLE_CHAT_SYNC_LAYOUT_SCHEMA_VERSION = "tinder-zte-visible-chat-scroll-v1";

class TinderConversationProductReadError extends Error {
  constructor(message, code = "INVALID_TINDER_CONVERSATION_PRODUCT_READ") {
    super(message);
    this.name = "TinderConversationProductReadError";
    this.code = code;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sourceValue(source, camelCase, snakeCase) {
  return source?.[camelCase] ?? source?.[snakeCase];
}

function invalid(message, code) {
  throw new TinderConversationProductReadError(message, code);
}

function normalizeCaptureId(value) {
  const captureId = typeof value === "string" ? value.trim() : "";
  if (!UUID_V4.test(captureId)) {
    invalid("Invalid Tinder conversation capture id.", "INVALID_TINDER_CONVERSATION_CAPTURE_ID");
  }
  return captureId;
}

function normalizeText(value, field, maximum) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maximum) {
    invalid(`Invalid Tinder conversation ${field}.`, "INVALID_TINDER_CONVERSATION_RECORD");
  }
  return text;
}

function normalizeCapturedAt(value) {
  const timestamp = typeof value === "string" ? value.trim() : null;
  if (timestamp !== null && (!timestamp || timestamp.length > 64)) {
    invalid("Invalid Tinder conversation capture time.", "INVALID_TINDER_CONVERSATION_RECORD");
  }
  // `pg` decodes TIMESTAMPTZ into Date instances by default.  Accept that
  // trusted transport shape here, while retaining a strict bounded string
  // boundary for injected/product-facing values.
  const parsed = value instanceof Date
    ? new Date(value.valueOf())
    : new Date(timestamp || "");
  if (Number.isNaN(parsed.valueOf())) {
    invalid("Invalid Tinder conversation capture time.", "INVALID_TINDER_CONVERSATION_RECORD");
  }
  return parsed.toISOString();
}

function assertEligibleLatestConfirmedRow(row) {
  if (!plainObject(row)) {
    invalid("Invalid Tinder conversation record.", "INVALID_TINDER_CONVERSATION_RECORD");
  }

  const sourcePackage = String(sourceValue(row, "sourcePackage", "source_package") || "").trim();
  const safetyStatus = String(sourceValue(row, "captureSafetyStatus", "capture_safety_status") || "").trim().toUpperCase();
  const mappingStatus = String(sourceValue(row, "mappingStatus", "mapping_status") || "").trim().toUpperCase();
  const reviewStatus = String(sourceValue(row, "humanReviewStatus", "human_review_status") || "").trim().toUpperCase();
  if (sourcePackage !== TINDER_SOURCE_PACKAGE
      || safetyStatus !== TINDER_CONVERSATION_SAFETY_STATUS
      || mappingStatus !== TINDER_CONVERSATION_MAPPING_STATUS
      || reviewStatus !== TINDER_CONVERSATION_REVIEW_STATUS) {
    invalid("Tinder conversation record is not eligible.", "INELIGIBLE_TINDER_CONVERSATION_RECORD");
  }
}

function normalizeConversationIdentity(row) {
  assertEligibleLatestConfirmedRow(row);
  const metadata = sourceValue(row, "visibleThreadMetadata", "visible_thread_metadata");
  if (!plainObject(metadata)) {
    invalid("Invalid Tinder conversation record.", "INVALID_TINDER_CONVERSATION_RECORD");
  }

  return Object.freeze({
    capture_id: normalizeCaptureId(sourceValue(row, "captureId", "capture_id")),
    visible_name: normalizeText(
      sourceValue(metadata, "visibleName", "visible_name"),
      "visible name",
      240
    ),
    captured_at: normalizeCapturedAt(sourceValue(row, "capturedAt", "captured_at"))
  });
}

function normalizeConversationMessages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > TINDER_CONVERSATION_MESSAGE_LIMIT) {
    invalid("Invalid Tinder conversation messages.", "INVALID_TINDER_CONVERSATION_MESSAGES");
  }

  let previousOrder = 0;
  return Object.freeze(value.map((message) => {
    if (!plainObject(message)) {
      invalid("Invalid Tinder conversation message.", "INVALID_TINDER_CONVERSATION_MESSAGES");
    }
    const visibleOrder = Number(sourceValue(message, "visibleOrder", "visible_order"));
    const direction = String(message.direction || "").trim().toUpperCase();
    if (!Number.isInteger(visibleOrder) || visibleOrder <= previousOrder || !MESSAGE_DIRECTIONS.has(direction)) {
      invalid("Invalid Tinder conversation message.", "INVALID_TINDER_CONVERSATION_MESSAGES");
    }
    previousOrder = visibleOrder;
    return Object.freeze({
      direction,
      text: normalizeText(message.text, "message text", TINDER_CONVERSATION_MESSAGE_TEXT_LIMIT)
    });
  }));
}

/**
 * Product-only projection of the latest bounded V4 transcript. It remains
 * separate from the original signed-capture message list: the UI may present
 * it as the newer synchronized visible history, but must never merge the two
 * observations or expose its command/permit/technical identifiers.
 */
function normalizeVisibleChatSyncMessages(value) {
  const messages = normalizeConversationMessages(value);
  if (messages.some((message) => !VISIBLE_CHAT_SYNC_MESSAGE_DIRECTIONS.has(message.direction))) {
    invalid("Invalid synchronized Tinder conversation messages.", "INVALID_TINDER_VISIBLE_CHAT_SYNC_PRODUCT_PROJECTION");
  }
  return messages;
}

function normalizeVisibleChatSync(value) {
  if (!exactKeys(value, [
    "received_at", "layout_schema_version", "segment_count", "overlap_count", "messages"
  ])) {
    invalid("Invalid synchronized Tinder conversation projection.", "INVALID_TINDER_VISIBLE_CHAT_SYNC_PRODUCT_PROJECTION");
  }
  const layoutSchemaVersion = typeof value.layout_schema_version === "string"
    ? value.layout_schema_version.trim() : "";
  const segmentCount = Number(value.segment_count);
  const overlapCount = Number(value.overlap_count);
  if (layoutSchemaVersion !== VISIBLE_CHAT_SYNC_LAYOUT_SCHEMA_VERSION
      || !Number.isInteger(segmentCount) || segmentCount < 1 || segmentCount > 8
      || !Number.isInteger(overlapCount) || overlapCount < 0 || overlapCount > 100) {
    invalid("Invalid synchronized Tinder conversation projection.", "INVALID_TINDER_VISIBLE_CHAT_SYNC_PRODUCT_PROJECTION");
  }
  return Object.freeze({
    received_at: normalizeCapturedAt(value.received_at),
    layout_schema_version: layoutSchemaVersion,
    segment_count: segmentCount,
    overlap_count: overlapCount,
    messages: normalizeVisibleChatSyncMessages(value.messages)
  });
}

/**
 * The database row has a deliberately different, server-internal field name
 * (`visible_messages`).  Convert it through an exact allowlist before the
 * public product normalizer sees it, so a selected detail cannot accidentally
 * inherit sync/device/command metadata from the persistence relation.
 */
function normalizeLatestConfirmedVisibleChatSync(row) {
  if (!exactKeys(row, [
    "received_at", "layout_schema_version", "segment_count", "overlap_count", "visible_messages"
  ])) {
    invalid("Invalid synchronized Tinder conversation record.", "INVALID_TINDER_VISIBLE_CHAT_SYNC_PRODUCT_PROJECTION");
  }
  return normalizeVisibleChatSync({
    received_at: row.received_at,
    layout_schema_version: row.layout_schema_version,
    segment_count: row.segment_count,
    overlap_count: row.overlap_count,
    messages: row.visible_messages
  });
}

function exactKeys(value, keys) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

/**
 * A second, public-boundary validator.  The service itself produces this
 * shape, but the route uses it again so an injected/replaced reader cannot
 * accidentally serialize extra capture columns.
 */
function normalizeTinderConversationProductListItem(value) {
  if (!exactKeys(value, ["capture_id", "visible_name", "captured_at"])) {
    invalid("Invalid Tinder conversation list projection.", "INVALID_TINDER_CONVERSATION_PRODUCT_PROJECTION");
  }
  return Object.freeze({
    capture_id: normalizeCaptureId(value.capture_id),
    visible_name: normalizeText(value.visible_name, "visible name", 240),
    captured_at: normalizeCapturedAt(value.captured_at)
  });
}

function normalizeTinderConversationProductList(value) {
  if (!Array.isArray(value) || value.length > TINDER_LATEST_CONFIRMED_CONVERSATION_LIMIT) {
    invalid("Invalid Tinder conversation list projection.", "INVALID_TINDER_CONVERSATION_PRODUCT_PROJECTION");
  }
  return Object.freeze(value.map(normalizeTinderConversationProductListItem));
}

function normalizeTinderConversationProductMessage(value) {
  if (!exactKeys(value, ["direction", "text"])) {
    invalid("Invalid Tinder conversation message projection.", "INVALID_TINDER_CONVERSATION_PRODUCT_PROJECTION");
  }
  const direction = String(value.direction || "").trim().toUpperCase();
  if (!MESSAGE_DIRECTIONS.has(direction)) {
    invalid("Invalid Tinder conversation message projection.", "INVALID_TINDER_CONVERSATION_PRODUCT_PROJECTION");
  }
  return Object.freeze({
    direction,
    text: normalizeText(value.text, "message text", TINDER_CONVERSATION_MESSAGE_TEXT_LIMIT)
  });
}

function normalizeTinderConversationProductDetail(value) {
  const baseKeys = ["capture_id", "visible_name", "captured_at", "messages"];
  const hasVisibleChatSync = Object.prototype.hasOwnProperty.call(value || {}, "visible_chat_sync");
  if (!exactKeys(value, hasVisibleChatSync ? [...baseKeys, "visible_chat_sync"] : baseKeys)
      || !Array.isArray(value.messages) || value.messages.length === 0
      || value.messages.length > TINDER_CONVERSATION_MESSAGE_LIMIT) {
    invalid("Invalid Tinder conversation detail projection.", "INVALID_TINDER_CONVERSATION_PRODUCT_PROJECTION");
  }
  return Object.freeze({
    ...normalizeTinderConversationProductListItem({
      capture_id: value.capture_id,
      visible_name: value.visible_name,
      captured_at: value.captured_at
    }),
    messages: Object.freeze(value.messages.map(normalizeTinderConversationProductMessage)),
    ...(hasVisibleChatSync
      ? { visible_chat_sync: normalizeVisibleChatSync(value.visible_chat_sync) }
      : {})
  });
}

function normalizeLatestConfirmedConversationListItem(row) {
  return normalizeConversationIdentity(row);
}

function normalizeLatestConfirmedConversationDetail(row, visibleChatSync = null) {
  const identity = normalizeConversationIdentity(row);
  return Object.freeze({
    ...identity,
    messages: normalizeConversationMessages(sourceValue(row, "visibleMessages", "visible_messages")),
    ...(visibleChatSync === null ? {} : { visible_chat_sync: normalizeLatestConfirmedVisibleChatSync(visibleChatSync) })
  });
}

function createTinderConversationProductReadService(repository) {
  for (const method of [
    "findLatestConfirmedConversations",
    "findLatestConfirmedConversationByCaptureId"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }

  async function listLatestConfirmedConversations() {
    const rows = await repository.findLatestConfirmedConversations();
    if (!Array.isArray(rows) || rows.length > TINDER_LATEST_CONFIRMED_CONVERSATION_LIMIT) {
      invalid("Invalid latest Tinder conversation list.", "INVALID_TINDER_CONVERSATION_LIST");
    }
    return Object.freeze(rows.map(normalizeLatestConfirmedConversationListItem));
  }

  async function getLatestConfirmedConversation(captureId) {
    const normalizedCaptureId = normalizeCaptureId(captureId);
    const row = await repository.findLatestConfirmedConversationByCaptureId(normalizedCaptureId);
    if (row === null || row === undefined) return null;
    const visibleChatSync = typeof repository.findLatestConfirmedVisibleChatSyncByCaptureId === "function"
      ? await repository.findLatestConfirmedVisibleChatSyncByCaptureId(normalizedCaptureId)
      : null;
    return normalizeLatestConfirmedConversationDetail(row, visibleChatSync ?? null);
  }

  return Object.freeze({
    getLatestConfirmedConversation,
    listLatestConfirmedConversations
  });
}

/**
 * The relation is the existing signed-capture store.  These are strictly
 * read-only projections, not a schema or write path.  The correlated latest
 * revision condition deliberately suppresses an old confirmed observation
 * once a newer observation of the same device/thread exists.
 */
function createPgTinderConversationProductReadRepository(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("pool.query must be a function");
  }

  const eligibleWhere = `
    c.capture_safety_status = 'SAFE'
    AND c.source_package = 'com.tinder'
    AND c.mapping_status = 'RESOLVED'
    AND c.human_review_status = 'CONFIRMED'
    AND c.resolved_contact_id IS NOT NULL
    AND c.capture_revision = (
      SELECT MAX(newer.capture_revision)
        FROM tinder_visible_chat_captures newer
       WHERE newer.device_id = c.device_id
         AND newer.runtime_thread_fingerprint = c.runtime_thread_fingerprint
    )`;

  return Object.freeze({
    async findLatestConfirmedConversations() {
      const result = await pool.query(
        `SELECT c.capture_id,
                c.capture_safety_status,
                c.mapping_status,
                c.human_review_status,
                c.source_package,
                c.visible_thread_metadata,
                c.captured_at
           FROM tinder_visible_chat_captures c
          WHERE ${eligibleWhere}
          ORDER BY c.captured_at DESC, c.capture_id DESC
          LIMIT $1`,
        [TINDER_LATEST_CONFIRMED_CONVERSATION_LIMIT]
      );
      return result.rows;
    },

    async findLatestConfirmedConversationByCaptureId(captureId) {
      const result = await pool.query(
        `SELECT c.capture_id,
                c.capture_safety_status,
                c.mapping_status,
                c.human_review_status,
                c.source_package,
                c.visible_thread_metadata,
                c.visible_messages,
                c.captured_at
           FROM tinder_visible_chat_captures c
          WHERE c.capture_id = $1
            AND ${eligibleWhere}
          LIMIT 1`,
        [captureId]
      );
      return result.rows[0] || null;
    },

    /**
     * The V4 relation is intentionally optional until its explicit migration
     * runs. A missing relation leaves existing confirmed conversations fully
     * readable rather than turning a no-DDL code release into a reader outage.
     * Any other database failure remains visible to the protected route.
     */
    async findLatestConfirmedVisibleChatSyncByCaptureId(captureId) {
      try {
        const result = await pool.query(
          `SELECT s.received_at,
                  s.layout_schema_version,
                  s.segment_count,
                  s.overlap_count,
                  s.visible_messages
             FROM tinder_visible_chat_sync_transcripts s
             JOIN tinder_visible_chat_captures c
               ON c.capture_id=s.source_capture_id
            WHERE s.source_capture_id=$1
              AND ${eligibleWhere}
            ORDER BY s.received_at DESC, s.sync_id DESC
            LIMIT 1`,
          [captureId]
        );
        return result.rows[0] || null;
      } catch (error) {
        if (error?.code === "42P01") return null;
        throw error;
      }
    }
  });
}

export {
  TINDER_CONVERSATION_MESSAGE_LIMIT,
  TINDER_CONVERSATION_MESSAGE_TEXT_LIMIT,
  TINDER_LATEST_CONFIRMED_CONVERSATION_LIMIT,
  TinderConversationProductReadError,
  createPgTinderConversationProductReadRepository,
  createTinderConversationProductReadService,
  normalizeLatestConfirmedConversationDetail,
  normalizeLatestConfirmedConversationListItem,
  normalizeLatestConfirmedVisibleChatSync,
  normalizeConversationMessages,
  normalizeVisibleChatSync,
  normalizeVisibleChatSyncMessages,
  normalizeTinderConversationProductDetail,
  normalizeTinderConversationProductList,
  normalizeTinderConversationProductListItem,
  normalizeTinderConversationProductMessage
};
