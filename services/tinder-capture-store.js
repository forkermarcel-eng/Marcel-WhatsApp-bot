import crypto from "node:crypto";

const TINDER_CAPTURE_SCHEMA_VERSION = "tinder-visible-chat-v1";
const TINDER_SOURCE_PACKAGE = "com.tinder";

const TINDER_CAPTURE_MAPPING_STATUS = Object.freeze({
  NEEDS_HUMAN_MAPPING: "NEEDS_HUMAN_MAPPING",
  RESOLVED: "RESOLVED",
  CONFLICT: "CONFLICT"
});

const TINDER_CAPTURE_REVIEW_STATUS = Object.freeze({
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  REJECTED: "REJECTED"
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MESSAGE_DIRECTIONS = new Set(["INCOMING", "OUTGOING", "UNKNOWN"]);

class TinderCaptureValidationError extends Error {
  constructor(message, code = "INVALID_TINDER_CAPTURE") {
    super(message);
    this.name = "TinderCaptureValidationError";
    this.code = code;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sourceValue(source, camelCase, snakeCase) {
  return source?.[camelCase] ?? source?.[snakeCase];
}

function stringWithin(value, field, { minimum = 0, maximum = 512 } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < minimum || text.length > maximum) {
    throw new TinderCaptureValidationError(`${field} ist ungültig.`, "INVALID_TINDER_CAPTURE");
  }
  return text;
}

function exactTimestamp(value, field) {
  const text = stringWithin(value, field, { minimum: 20, maximum: 64 });
  const date = new Date(text);
  if (Number.isNaN(date.valueOf())) {
    throw new TinderCaptureValidationError(`${field} ist ungültig.`, "INVALID_TINDER_CAPTURE");
  }
  return date.toISOString();
}

function hash(value, field) {
  const text = stringWithin(value, field, { minimum: 64, maximum: 64 }).toLowerCase();
  if (!SHA256_HEX.test(text)) {
    throw new TinderCaptureValidationError(`${field} ist ungültig.`, "INVALID_TINDER_CAPTURE");
  }
  return text;
}

function captureSafetyStatus(capture) {
  return String(
    sourceValue(capture, "safetyStatus", "safety_status")
      ?? sourceValue(capture, "captureSafetyStatus", "capture_safety_status")
      ?? ""
  ).trim().toUpperCase();
}

function rejectIdentityInjection(capture) {
  for (const field of [
    "contactId",
    "contact_id",
    "resolvedContactId",
    "resolved_contact_id",
    "whatsappJid",
    "whatsapp_jid",
    "phoneNumber",
    "phone_number"
  ]) {
    if (Object.hasOwn(capture, field)) {
      throw new TinderCaptureValidationError(
        "Ein Capture darf keine Kontakt- oder WhatsApp-Identität enthalten.",
        "CAPTURE_IDENTITY_INJECTION"
      );
    }
  }
}

function normalizeVisibleMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 100) {
    throw new TinderCaptureValidationError("Die sichtbaren Nachrichten sind ungültig.", "INVALID_TINDER_CAPTURE");
  }

  let previousOrder = 0;
  return Object.freeze(messages.map((message) => {
    if (!plainObject(message)) {
      throw new TinderCaptureValidationError("Eine sichtbare Nachricht ist ungültig.", "INVALID_TINDER_CAPTURE");
    }
    const visibleOrder = Number(sourceValue(message, "visibleOrder", "visible_order"));
    if (!Number.isInteger(visibleOrder) || visibleOrder <= previousOrder) {
      throw new TinderCaptureValidationError("Die Nachrichtenreihenfolge ist ungültig.", "INVALID_TINDER_CAPTURE");
    }
    previousOrder = visibleOrder;

    const direction = String(message.direction || "").trim().toUpperCase();
    if (!MESSAGE_DIRECTIONS.has(direction)) {
      throw new TinderCaptureValidationError("Die Nachrichtenrichtung ist ungültig.", "INVALID_TINDER_CAPTURE");
    }

    return Object.freeze({
      visibleOrder,
      text: stringWithin(message.text, "Nachricht", { minimum: 1, maximum: 4096 }),
      direction,
      sourceClassName: stringWithin(
        sourceValue(message, "sourceClassName", "source_class_name") || "",
        "Nachrichtenklasse",
        { minimum: 0, maximum: 256 }
      ) || null
    });
  }));
}

/**
 * Validates the trusted T2 wire shape before it can be persisted.  It accepts
 * no contact identifier and does not infer one from display data.
 */
function validateSafeVisibleChatCapture(capture) {
  if (!plainObject(capture)) {
    throw new TinderCaptureValidationError("Das Tinder-Capture ist ungültig.", "INVALID_TINDER_CAPTURE");
  }
  rejectIdentityInjection(capture);
  if (captureSafetyStatus(capture) !== "SAFE") {
    throw new TinderCaptureValidationError("Nur sichere Tinder-Captures dürfen gespeichert werden.", "UNSAFE_TINDER_CAPTURE");
  }

  const captureMetadata = sourceValue(capture, "captureMetadata", "capture_metadata");
  const visibleThreadMetadata = sourceValue(capture, "visibleThreadMetadata", "visible_thread_metadata");
  const visibleMessages = sourceValue(capture, "visibleMessages", "visible_messages");
  if (!plainObject(captureMetadata) || !plainObject(visibleThreadMetadata)) {
    throw new TinderCaptureValidationError("Die Tinder-Capture-Metadaten sind ungültig.", "INVALID_TINDER_CAPTURE");
  }

  const schemaVersion = stringWithin(
    sourceValue(captureMetadata, "schemaVersion", "schema_version"),
    "Capture-Schema",
    { minimum: 1, maximum: 80 }
  );
  const sourcePackage = stringWithin(
    sourceValue(captureMetadata, "sourcePackage", "source_package"),
    "Quellpaket",
    { minimum: 1, maximum: 160 }
  );
  if (schemaVersion !== TINDER_CAPTURE_SCHEMA_VERSION || sourcePackage !== TINDER_SOURCE_PACKAGE) {
    throw new TinderCaptureValidationError("Das Tinder-Capture-Schema ist nicht freigegeben.", "UNSUPPORTED_TINDER_CAPTURE_SCHEMA");
  }

  const visibleNodeCount = Number(sourceValue(captureMetadata, "visibleNodeCount", "visible_node_count"));
  if (!Number.isInteger(visibleNodeCount) || visibleNodeCount < 1 || visibleNodeCount > 512) {
    throw new TinderCaptureValidationError("Die sichtbare Node-Anzahl ist ungültig.", "INVALID_TINDER_CAPTURE");
  }

  return Object.freeze({
    schemaVersion,
    sourcePackage,
    capturedAt: exactTimestamp(sourceValue(captureMetadata, "capturedAt", "captured_at"), "Capture-Zeit"),
    visibleNodeCount,
    captureFingerprint: hash(
      sourceValue(captureMetadata, "captureFingerprint", "capture_fingerprint"),
      "Capture-Fingerprint"
    ),
    visibleThreadMetadata: Object.freeze({
      visibleName: stringWithin(
        sourceValue(visibleThreadMetadata, "visibleName", "visible_name"),
        "Sichtbarer Thread-Name",
        { minimum: 1, maximum: 240 }
      ),
      threadFingerprint: hash(
        sourceValue(visibleThreadMetadata, "threadFingerprint", "thread_fingerprint"),
        "Thread-Fingerprint"
      ),
      headerClassName: stringWithin(
        sourceValue(visibleThreadMetadata, "headerClassName", "header_class_name") || "",
        "Headerklasse",
        { minimum: 0, maximum: 256 }
      ) || null
    }),
    visibleMessages: normalizeVisibleMessages(visibleMessages),
    safetyStatus: "SAFE"
  });
}

function normalizeDeviceId(deviceId) {
  const value = String(deviceId || "").trim();
  if (!UUID_V4.test(value)) {
    throw new TinderCaptureValidationError("Die Device-ID ist ungültig.", "INVALID_DEVICE_ID");
  }
  return value;
}

function normalizeProvenance(provenance) {
  const source = String(provenance?.source || "android_visible_chat").trim();
  if (source !== "android_visible_chat") {
    throw new TinderCaptureValidationError("Die Capture-Herkunft ist ungültig.", "INVALID_CAPTURE_PROVENANCE");
  }

  const protocolVersion = provenance?.protocolVersion ?? provenance?.protocol_version ?? null;
  if (protocolVersion !== null && (!Number.isInteger(Number(protocolVersion)) || Number(protocolVersion) < 1)) {
    throw new TinderCaptureValidationError("Die Protocol-Version ist ungültig.", "INVALID_CAPTURE_PROVENANCE");
  }

  return Object.freeze({
    source,
    ...(protocolVersion === null ? {} : { protocolVersion: Number(protocolVersion) })
  });
}

function normalizeCaptureId(captureId) {
  const value = String(captureId || "").trim();
  if (!UUID_V4.test(value)) {
    throw new TinderCaptureValidationError("Die Capture-ID ist ungültig.", "INVALID_CAPTURE_ID");
  }
  return value;
}

function createTinderCaptureStore(repository, {
  createCaptureId = () => crypto.randomUUID(),
  now = () => new Date()
} = {}) {
  for (const method of ["withTransaction", "nextCaptureRevision", "insertCapture", "findCaptureById"]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }

  async function storeSafeCapture({ deviceId, capture, provenance } = {}) {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const normalizedCapture = validateSafeVisibleChatCapture(capture);
    const normalizedProvenance = normalizeProvenance(provenance);
    const captureId = normalizeCaptureId(createCaptureId());
    const receivedAt = exactTimestamp(now()?.toISOString?.() || now(), "Empfangszeit");

    return repository.withTransaction(async (transaction) => {
      const captureRevision = Number(await repository.nextCaptureRevision(transaction, {
        deviceId: normalizedDeviceId,
        runtimeThreadFingerprint: normalizedCapture.visibleThreadMetadata.threadFingerprint
      }));
      if (!Number.isInteger(captureRevision) || captureRevision < 1) {
        throw new TinderCaptureValidationError("Die Capture-Revision ist ungültig.", "INVALID_CAPTURE_REVISION");
      }

      const record = Object.freeze({
        captureId,
        deviceId: normalizedDeviceId,
        schemaVersion: normalizedCapture.schemaVersion,
        sourcePackage: normalizedCapture.sourcePackage,
        captureSafetyStatus: normalizedCapture.safetyStatus,
        runtimeThreadFingerprint: normalizedCapture.visibleThreadMetadata.threadFingerprint,
        captureFingerprint: normalizedCapture.captureFingerprint,
        captureRevision,
        visibleThreadMetadata: normalizedCapture.visibleThreadMetadata,
        visibleMessages: normalizedCapture.visibleMessages,
        mappingStatus: TINDER_CAPTURE_MAPPING_STATUS.NEEDS_HUMAN_MAPPING,
        humanReviewStatus: TINDER_CAPTURE_REVIEW_STATUS.PENDING,
        resolvedContactId: null,
        provenance: normalizedProvenance,
        capturedAt: normalizedCapture.capturedAt,
        receivedAt
      });

      const persisted = await repository.insertCapture(transaction, record);
      return persisted || record;
    });
  }

  async function getCapture(captureId) {
    return repository.findCaptureById(normalizeCaptureId(captureId));
  }

  return Object.freeze({ getCapture, storeSafeCapture });
}

/**
 * PostgreSQL adapter.  It is intentionally only an adapter: no caller wires
 * it into runtime initialization, and the matching migration remains manual.
 */
function createPgTinderCaptureRepository(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("pool.connect and pool.query must be functions");
  }

  return Object.freeze({
    async withTransaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async nextCaptureRevision(client, { deviceId, runtimeThreadFingerprint }) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`tinder-capture:${deviceId}:${runtimeThreadFingerprint}`]
      );
      const result = await client.query(
        `SELECT COALESCE(MAX(capture_revision), 0) + 1 AS next_revision
         FROM tinder_visible_chat_captures
         WHERE device_id = $1
           AND runtime_thread_fingerprint = $2`,
        [deviceId, runtimeThreadFingerprint]
      );
      return Number(result.rows[0]?.next_revision);
    },

    async insertCapture(client, record) {
      const result = await client.query(
        `INSERT INTO tinder_visible_chat_captures (
           capture_id, device_id, capture_schema_version, source_platform,
           source_package, capture_safety_status, runtime_thread_fingerprint,
           capture_fingerprint, capture_revision, visible_thread_metadata,
           visible_messages, mapping_status, human_review_status,
           resolved_contact_id, provenance, captured_at, received_at
         ) VALUES (
           $1,$2,$3,'tinder',$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,
           $11,$12,$13,$14::jsonb,$15,$16
         ) RETURNING *`,
        [
          record.captureId,
          record.deviceId,
          record.schemaVersion,
          record.sourcePackage,
          record.captureSafetyStatus,
          record.runtimeThreadFingerprint,
          record.captureFingerprint,
          record.captureRevision,
          JSON.stringify(record.visibleThreadMetadata),
          JSON.stringify(record.visibleMessages),
          record.mappingStatus,
          record.humanReviewStatus,
          record.resolvedContactId,
          JSON.stringify(record.provenance),
          record.capturedAt,
          record.receivedAt
        ]
      );
      return result.rows[0] || null;
    },

    async findCaptureById(captureId) {
      const result = await pool.query(
        `SELECT *
         FROM tinder_visible_chat_captures
         WHERE capture_id = $1`,
        [captureId]
      );
      return result.rows[0] || null;
    }
  });
}

export {
  TINDER_CAPTURE_MAPPING_STATUS,
  TINDER_CAPTURE_REVIEW_STATUS,
  TINDER_CAPTURE_SCHEMA_VERSION,
  TINDER_SOURCE_PACKAGE,
  TinderCaptureValidationError,
  captureSafetyStatus,
  createPgTinderCaptureRepository,
  createTinderCaptureStore,
  validateSafeVisibleChatCapture
};
