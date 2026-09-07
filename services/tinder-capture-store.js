import crypto from "node:crypto";
const TINDER_CAPTURE_SCHEMA_VERSION_V1 = "tinder-visible-chat-v1";
const TINDER_CAPTURE_SCHEMA_VERSION_V2 = "tinder-visible-chat-v2";
const TINDER_CAPTURE_SCHEMA_VERSION_V3 = "tinder-visible-chat-v3";
// Retained as the legacy default export for callers that explicitly create
// V1 captures. New Android clients declare V2 in their signed metadata.
const TINDER_CAPTURE_SCHEMA_VERSION = TINDER_CAPTURE_SCHEMA_VERSION_V1;
const TINDER_CAPTURE_SCHEMA_VERSIONS = new Set([
  TINDER_CAPTURE_SCHEMA_VERSION_V1,
  TINDER_CAPTURE_SCHEMA_VERSION_V2,
  TINDER_CAPTURE_SCHEMA_VERSION_V3
]);
const TINDER_SOURCE_PACKAGE = "com.tinder";
const TINDER_IDENTIFIER_TYPE = "tinder_profile";
const TINDER_THREAD_BINDING_EVIDENCE = Object.freeze({
  kind: "tinder_accessibility_header_unique_id_hmac_v1",
  role: "HEADER_TITLE",
  status: "OBSERVED_UNVERIFIED"
});
const TINDER_HUMAN_ARMED_PERMIT = Object.freeze({
  field: "humanBindingPermit",
  commandField: "command_id"
});

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
const TINDER_PENDING_HUMAN_MAPPING_LIMIT = 25;
// Dashboard discovery stays deliberately bounded. The selector only exposes
// a capture ID and its visible thread label; draft creation remains a separate
// explicit T4 action after the existing detail screen has reloaded the capture.
const TINDER_DRAFT_ELIGIBLE_CAPTURE_LIMIT = 25;

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

function exactLowercaseHash(value, field, code = "INVALID_TINDER_CAPTURE") {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new TinderCaptureValidationError(`${field} ist ungÃ¼ltig.`, code);
  }
  return value;
}

function exactKeys(value, keys) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
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
 * V2 carries at most one opaque, app-local HMAC observation. It is signed as
 * part of the capture body but never becomes a person/profile identifier,
 * mapping decision, or public dashboard field here.
 */
function normalizeThreadBindingEvidence(visibleThreadMetadata, schemaVersion) {
  const hasEvidence = Object.hasOwn(visibleThreadMetadata, "threadBindingEvidence");
  if (schemaVersion === TINDER_CAPTURE_SCHEMA_VERSION_V1) {
    if (hasEvidence) {
      throw new TinderCaptureValidationError(
        "Thread-Bindungsevidenz erfordert Capture-Schema V2.",
        "INVALID_THREAD_BINDING_EVIDENCE"
      );
    }
    return null;
  }

  if (!exactKeys(visibleThreadMetadata, [
    "visibleName", "threadFingerprint", "headerClassName", "threadBindingEvidence"
  ]) && !exactKeys(visibleThreadMetadata, [
    "visibleName", "threadFingerprint", "headerClassName"
  ])) {
    throw new TinderCaptureValidationError(
      "Capture-Schema V2 enthÃ¤lt nicht erlaubte Thread-Metadaten.",
      "INVALID_THREAD_BINDING_EVIDENCE"
    );
  }
  if (!hasEvidence) return null;

  const evidence = visibleThreadMetadata.threadBindingEvidence;
  if (!exactKeys(evidence, ["kind", "role", "status", "token"])
      || evidence.kind !== TINDER_THREAD_BINDING_EVIDENCE.kind
      || evidence.role !== TINDER_THREAD_BINDING_EVIDENCE.role
      || evidence.status !== TINDER_THREAD_BINDING_EVIDENCE.status) {
    throw new TinderCaptureValidationError(
      "Die Thread-Bindungsevidenz ist nicht freigegeben.",
      "INVALID_THREAD_BINDING_EVIDENCE"
    );
  }

  return Object.freeze({
    kind: TINDER_THREAD_BINDING_EVIDENCE.kind,
    role: TINDER_THREAD_BINDING_EVIDENCE.role,
    status: TINDER_THREAD_BINDING_EVIDENCE.status,
    token: exactLowercaseHash(
      evidence.token,
      "Thread-Bindungsevidenz",
      "INVALID_THREAD_BINDING_EVIDENCE"
    )
  });
}

/**
 * V3 does not contain an identity. It contains only the opaque command UUID
 * delivered after a separate human decision. This UUID is validated for the
 * in-transaction permit check and is intentionally never persisted in the
 * capture record or returned through a dashboard response.
 */
function normalizeHumanArmedBindingPermit(captureMetadata, schemaVersion) {
  const hasPermit = Object.hasOwn(captureMetadata, TINDER_HUMAN_ARMED_PERMIT.field);
  if (schemaVersion !== TINDER_CAPTURE_SCHEMA_VERSION_V3) {
    if (hasPermit) {
      throw new TinderCaptureValidationError(
        "Eine Human-Binding-Freigabe erfordert Capture-Schema V3.",
        "INVALID_HUMAN_BINDING_PERMIT"
      );
    }
    return null;
  }

  if (!exactKeys(captureMetadata, [
    "schemaVersion", "sourcePackage", "capturedAt", "visibleNodeCount",
    "captureFingerprint", TINDER_HUMAN_ARMED_PERMIT.field
  ])) {
    throw new TinderCaptureValidationError(
      "Capture-Schema V3 enthÃ¤lt nicht erlaubte Metadaten.",
      "INVALID_HUMAN_BINDING_PERMIT"
    );
  }
  const permit = captureMetadata[TINDER_HUMAN_ARMED_PERMIT.field];
  if (!exactKeys(permit, [TINDER_HUMAN_ARMED_PERMIT.commandField])) {
    throw new TinderCaptureValidationError(
      "Die Human-Binding-Freigabe ist ungÃ¼ltig.",
      "INVALID_HUMAN_BINDING_PERMIT"
    );
  }
  const commandId = normalizedUuidV4(permit[TINDER_HUMAN_ARMED_PERMIT.commandField]);
  if (!commandId) {
    throw new TinderCaptureValidationError(
      "Die Human-Binding-Freigabe ist ungÃ¼ltig.",
      "INVALID_HUMAN_BINDING_PERMIT"
    );
  }
  return commandId;
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
  if (!TINDER_CAPTURE_SCHEMA_VERSIONS.has(schemaVersion) || sourcePackage !== TINDER_SOURCE_PACKAGE) {
    throw new TinderCaptureValidationError("Das Tinder-Capture-Schema ist nicht freigegeben.", "UNSUPPORTED_TINDER_CAPTURE_SCHEMA");
  }

  const visibleNodeCount = Number(sourceValue(captureMetadata, "visibleNodeCount", "visible_node_count"));
  if (!Number.isInteger(visibleNodeCount) || visibleNodeCount < 1 || visibleNodeCount > 512) {
    throw new TinderCaptureValidationError("Die sichtbare Node-Anzahl ist ungültig.", "INVALID_TINDER_CAPTURE");
  }

  const threadBindingEvidence = normalizeThreadBindingEvidence(
    visibleThreadMetadata,
    schemaVersion
  );
  const humanBindingPermitCommandId = normalizeHumanArmedBindingPermit(
    captureMetadata,
    schemaVersion
  );

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
      ) || null,
      ...(threadBindingEvidence === null ? {} : { threadBindingEvidence })
    }),
    visibleMessages: normalizeVisibleMessages(visibleMessages),
    safetyStatus: "SAFE",
    ...(humanBindingPermitCommandId === null ? {} : { humanBindingPermitCommandId })
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

function normalizedStatus(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function normalizedUuidV4(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return UUID_V4.test(normalized) ? normalized : null;
}

function normalizedHash(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SHA256_HEX.test(normalized) ? normalized : null;
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * A reuse candidate is accepted only when the repository proves every
 * server-owned condition again.  This deliberately accepts neither a display
 * name nor any client-supplied identity value as evidence.
 */
function normalizeReusableConfirmedMapping(row, { deviceId, runtimeThreadFingerprint }) {
  if (!plainObject(row)) return null;

  const candidateDeviceId = normalizedUuidV4(sourceValue(row, "deviceId", "device_id"));
  const candidateThreadFingerprint = normalizedHash(
    sourceValue(row, "runtimeThreadFingerprint", "runtime_thread_fingerprint")
  );
  const resolvedContactId = positiveInteger(sourceValue(row, "resolvedContactId", "resolved_contact_id"));
  const identifierContactId = positiveInteger(sourceValue(row, "contactId", "contact_id"));
  const identifierType = sourceValue(row, "identifierType", "identifier_type");
  const humanVerified = sourceValue(row, "humanVerified", "human_verified");

  if (
    candidateDeviceId !== deviceId
    || candidateThreadFingerprint !== runtimeThreadFingerprint
    || normalizedStatus(sourceValue(row, "captureSafetyStatus", "capture_safety_status")) !== "SAFE"
    || normalizedStatus(sourceValue(row, "mappingStatus", "mapping_status")) !== TINDER_CAPTURE_MAPPING_STATUS.RESOLVED
    || normalizedStatus(sourceValue(row, "humanReviewStatus", "human_review_status")) !== TINDER_CAPTURE_REVIEW_STATUS.CONFIRMED
    || resolvedContactId === null
    || identifierContactId !== resolvedContactId
    || identifierType !== TINDER_IDENTIFIER_TYPE
    || humanVerified !== true
  ) {
    return null;
  }

  return Object.freeze({ resolvedContactId });
}

/**
 * A conversation binding is a later, separate human authority. It is scoped
 * to the authenticated device and opaque V2 reference only; it deliberately
 * ignores visible name, message text and runtime/capture fingerprints so a
 * completed binding can survive a process restart.
 */
function normalizeReusableConfirmedConversationBinding(row, {
  deviceId,
  threadBindingEvidence
}) {
  if (!threadBindingEvidence || !plainObject(row)) return null;
  const candidateDeviceId = normalizedUuidV4(sourceValue(row, "deviceId", "device_id"));
  const referenceKind = sourceValue(row, "referenceKind", "reference_kind");
  const referenceHash = normalizedHash(sourceValue(row, "referenceHash", "reference_hash"));
  const resolvedContactId = positiveInteger(sourceValue(row, "contactId", "contact_id"));
  if (
    candidateDeviceId !== deviceId
    || sourceValue(row, "channel") !== "tinder"
    || referenceKind !== threadBindingEvidence.kind
    || referenceHash !== threadBindingEvidence.token
    || normalizedStatus(sourceValue(row, "bindingState", "binding_state")) !== "CONFIRMED"
    || sourceValue(row, "humanVerified", "human_verified") !== true
    || resolvedContactId === null
  ) {
    return null;
  }
  return Object.freeze({ resolvedContactId });
}

function requireHumanBindingPermitGateway(gateway) {
  if (!gateway
      || typeof gateway.authorizeIncomingCapturePermit !== "function"
      || typeof gateway.consumeAuthorizedIncomingPermit !== "function") {
    throw new TinderCaptureValidationError(
      "Die Human-Binding-Freigabe ist nicht verfÃ¼gbar.",
      "HUMAN_BINDING_PERMIT_NOT_AVAILABLE"
    );
  }
  return gateway;
}

function authorizedHumanBindingContact(result) {
  const contactId = positiveInteger(result?.authorization?.contactId);
  if (result?.status !== "AUTHORIZED" || contactId === null) {
    throw new TinderCaptureValidationError(
      "Die Human-Binding-Freigabe ist nicht verfÃ¼gbar.",
      "HUMAN_BINDING_PERMIT_NOT_AVAILABLE"
    );
  }
  return Object.freeze({ authorization: result.authorization, contactId });
}

function consumedHumanBindingContact(result, expectedContactId) {
  if (result?.status !== "CONSUMED"
      || positiveInteger(result?.contactId) !== expectedContactId) {
    throw new TinderCaptureValidationError(
      "Die Human-Binding-Freigabe konnte nicht verbraucht werden.",
      "HUMAN_BINDING_PERMIT_NOT_AVAILABLE"
    );
  }
}

function createTinderCaptureStore(repository, {
  createCaptureId = () => crypto.randomUUID(),
  now = () => new Date(),
  humanBindingPermitGateway = null
} = {}) {
  for (const method of [
    "withTransaction",
    "nextCaptureRevision",
    "insertCapture",
    "findCaptureByFingerprint",
    "findReusableConfirmedMapping",
    "findCaptureById",
    "findPendingHumanMappingCaptures"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
  const findReusableConfirmedConversationBinding =
    typeof repository.findReusableConfirmedConversationBinding === "function"
      ? repository.findReusableConfirmedConversationBinding.bind(repository)
      : async () => null;

  async function storeSafeCapture({ deviceId, capture, provenance } = {}) {
    const normalizedDeviceId = normalizeDeviceId(deviceId);
    const normalizedCapture = validateSafeVisibleChatCapture(capture);
    const normalizedProvenance = normalizeProvenance(provenance);
    const captureId = normalizeCaptureId(createCaptureId());
    const receivedAt = exactTimestamp(now()?.toISOString?.() || now(), "Empfangszeit");

    return repository.withTransaction(async (transaction) => {
      // `nextCaptureRevision` takes the PostgreSQL transaction advisory lock
      // for this exact device/thread before it reads any row. The fingerprint
      // lookup deliberately happens after that lock: two identical captures
      // cannot both observe an absent fingerprint and race into a unique
      // constraint failure. A duplicate performs no insert.
      const captureRevision = Number(await repository.nextCaptureRevision(transaction, {
        deviceId: normalizedDeviceId,
        runtimeThreadFingerprint: normalizedCapture.visibleThreadMetadata.threadFingerprint
      }));
      if (!Number.isInteger(captureRevision) || captureRevision < 1) {
        throw new TinderCaptureValidationError("Die Capture-Revision ist ungültig.", "INVALID_CAPTURE_REVISION");
      }

      let humanBindingAuthorization = null;
      if (normalizedCapture.schemaVersion === TINDER_CAPTURE_SCHEMA_VERSION_V3) {
        const gateway = requireHumanBindingPermitGateway(humanBindingPermitGateway);
        humanBindingAuthorization = authorizedHumanBindingContact(
          await gateway.authorizeIncomingCapturePermit(transaction, {
            commandId: normalizedCapture.humanBindingPermitCommandId,
            deviceId: normalizedDeviceId,
            captureId
          })
        );
      }

      const existing = await repository.findCaptureByFingerprint(transaction, {
        deviceId: normalizedDeviceId,
        runtimeThreadFingerprint: normalizedCapture.visibleThreadMetadata.threadFingerprint,
        captureFingerprint: normalizedCapture.captureFingerprint
      });
      if (existing) {
        // A human-armed V3 permit authorizes exactly one fresh observation.
        // Returning a prior V1/V2 row here would silently skip both its
        // explicit permit verification and one-use consumption.  Abort the
        // whole transaction instead, leaving the verified permit unconsumed.
        if (humanBindingAuthorization) {
          throw new TinderCaptureValidationError(
            "Die Human-Binding-Capture ist nicht neu.",
            "HUMAN_BINDING_CAPTURE_NOT_FRESH"
          );
        }
        return existing;
      }

      // V1/V2 may reuse only separately verified source evidence. V3 is the
      // distinct human-armed path: it never falls back to a fingerprint,
      // display name, legacy profile mapping or a prior permit.
      const reusableConversationBinding = humanBindingAuthorization
        ? null
        : normalizeReusableConfirmedConversationBinding(
          await findReusableConfirmedConversationBinding(transaction, {
            deviceId: normalizedDeviceId,
            threadBindingEvidence: normalizedCapture.visibleThreadMetadata.threadBindingEvidence ?? null
          }),
          {
            deviceId: normalizedDeviceId,
            threadBindingEvidence: normalizedCapture.visibleThreadMetadata.threadBindingEvidence ?? null
          }
        );
      const reusableMapping = humanBindingAuthorization
        ? null
        : normalizeReusableConfirmedMapping(
          await repository.findReusableConfirmedMapping(transaction, {
            deviceId: normalizedDeviceId,
            runtimeThreadFingerprint: normalizedCapture.visibleThreadMetadata.threadFingerprint
          }),
          {
            deviceId: normalizedDeviceId,
            runtimeThreadFingerprint: normalizedCapture.visibleThreadMetadata.threadFingerprint
          }
        );

      // A legacy profile mapping and a newer opaque conversation binding must
      // agree. A disagreement is surfaced as a pending conflict, never an
      // automatic overwrite or preference for a visible UI value.
      const reusableContactId = humanBindingAuthorization?.contactId
        ?? reusableConversationBinding?.resolvedContactId
        ?? reusableMapping?.resolvedContactId
        ?? null;
      const reusableConflict = reusableConversationBinding && reusableMapping
        && reusableConversationBinding.resolvedContactId !== reusableMapping.resolvedContactId;

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
        mappingStatus: reusableConflict
          ? TINDER_CAPTURE_MAPPING_STATUS.CONFLICT
          : reusableContactId
            ? TINDER_CAPTURE_MAPPING_STATUS.RESOLVED
            : TINDER_CAPTURE_MAPPING_STATUS.NEEDS_HUMAN_MAPPING,
        humanReviewStatus: reusableConflict
          ? TINDER_CAPTURE_REVIEW_STATUS.PENDING
          : reusableContactId
            ? TINDER_CAPTURE_REVIEW_STATUS.CONFIRMED
            : TINDER_CAPTURE_REVIEW_STATUS.PENDING,
        resolvedContactId: reusableConflict ? null : reusableContactId,
        provenance: normalizedProvenance,
        capturedAt: normalizedCapture.capturedAt,
        receivedAt
      });

      const persisted = await repository.insertCapture(transaction, record);
      if (humanBindingAuthorization) {
        const gateway = requireHumanBindingPermitGateway(humanBindingPermitGateway);
        const consumed = await gateway.consumeAuthorizedIncomingPermit(transaction, {
          authorization: humanBindingAuthorization.authorization,
          captureId
        });
        consumedHumanBindingContact(consumed, humanBindingAuthorization.contactId);
      }
      return persisted || record;
    });
  }

  async function getCapture(captureId) {
    return repository.findCaptureById(normalizeCaptureId(captureId));
  }

  async function listPendingHumanMappingCaptures() {
    const captures = await repository.findPendingHumanMappingCaptures();
    if (!Array.isArray(captures) || captures.length > TINDER_PENDING_HUMAN_MAPPING_LIMIT) {
      throw new TinderCaptureValidationError(
        "Die ausstehenden Tinder-Captures sind ungültig.",
        "INVALID_PENDING_TINDER_CAPTURES"
      );
    }
    return Object.freeze([...captures]);
  }

  return Object.freeze({ getCapture, listPendingHumanMappingCaptures, storeSafeCapture });
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

    async findCaptureByFingerprint(client, { deviceId, runtimeThreadFingerprint, captureFingerprint }) {
      const result = await client.query(
        `SELECT *
         FROM tinder_visible_chat_captures
         WHERE device_id = $1
           AND runtime_thread_fingerprint = $2
           AND capture_fingerprint = $3`,
        [deviceId, runtimeThreadFingerprint, captureFingerprint]
      );
      return result.rows[0] || null;
    },

    async findReusableConfirmedMapping(client, { deviceId, runtimeThreadFingerprint }) {
      // T2's deliberately minimal foundation does not require the T3 contact
      // identifier relation. Check the optional T3 prerequisites without a
      // static reference first; absent or partial T3 must keep ingress alive
      // and simply yield no reusable mapping.
      const readiness = await client.query(
        `SELECT
           to_regclass('public.tinder_identity_mapping_audit') IS NOT NULL AS t3_audit_present,
           to_regclass('public.contact_identifiers') IS NOT NULL AS contact_identifiers_present,
           COUNT(*) FILTER (
             WHERE column_name IN ('id', 'contact_id', 'identifier_type', 'human_verified')
           ) = 4 AS required_identifier_columns_present
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'contact_identifiers'`
      );
      const prerequisite = readiness.rows[0];
      if (
        prerequisite?.t3_audit_present !== true
        || prerequisite?.contact_identifiers_present !== true
        || prerequisite?.required_identifier_columns_present !== true
      ) {
        return null;
      }

      const result = await client.query(
        `SELECT c.device_id,
                c.runtime_thread_fingerprint,
                c.capture_safety_status,
                c.mapping_status,
                c.human_review_status,
                c.resolved_contact_id,
                i.contact_id,
                i.identifier_type,
                i.human_verified
           FROM tinder_visible_chat_captures c
           JOIN contact_identifiers i
             ON i.contact_id = c.resolved_contact_id
          WHERE to_regclass('public.tinder_identity_mapping_audit') IS NOT NULL
            AND c.device_id = $1
            AND c.runtime_thread_fingerprint = $2
            AND c.capture_safety_status = 'SAFE'
            AND c.mapping_status = 'RESOLVED'
            AND c.human_review_status = 'CONFIRMED'
            AND c.resolved_contact_id IS NOT NULL
            AND i.identifier_type = $3
            AND i.human_verified = TRUE
          ORDER BY c.received_at DESC, c.capture_id DESC, i.id ASC
          LIMIT 1`,
        [deviceId, runtimeThreadFingerprint, TINDER_IDENTIFIER_TYPE]
      );
      return result.rows[0] || null;
    },

    async findReusableConfirmedConversationBinding(client, {
      deviceId,
      threadBindingEvidence
    }) {
      if (!threadBindingEvidence) return null;
      // T2 remains deployable before the later additive binding foundation.
      // Do not reference an absent relation until its exact table exists.
      const readiness = await client.query(
        `SELECT to_regclass('public.contact_conversation_bindings') IS NOT NULL AS binding_present`
      );
      if (readiness.rows[0]?.binding_present !== true) return null;
      try {
        const result = await client.query(
          `SELECT channel, reference_kind, reference_hash, device_id,
                  contact_id, binding_state, human_verified
             FROM contact_conversation_bindings
            WHERE channel = 'tinder'
              AND reference_kind = $1
              AND reference_hash = $2
              AND device_id = $3
              AND binding_state = 'CONFIRMED'
              AND human_verified = TRUE
            ORDER BY binding_id ASC
            LIMIT 1`,
          [threadBindingEvidence.kind, threadBindingEvidence.token, deviceId]
        );
        return result.rows[0] || null;
      } catch (error) {
        // A partial/unavailable future foundation must keep the signed T2
        // ingress fail-safe and pending; no contact is ever inferred here.
        if (error?.code === "42P01" || error?.code === "42703") return null;
        throw error;
      }
    },

    async findCaptureById(captureId) {
      const result = await pool.query(
        `SELECT *
         FROM tinder_visible_chat_captures
         WHERE capture_id = $1`,
        [captureId]
      );
      return result.rows[0] || null;
    },

    async findPendingHumanMappingCaptures() {
      const result = await pool.query(
        `SELECT capture_id,
                device_id,
                capture_revision,
                mapping_status,
                human_review_status,
                visible_thread_metadata,
                source_package,
                captured_at,
                received_at
         FROM tinder_visible_chat_captures
         WHERE capture_safety_status = 'SAFE'
           AND mapping_status = 'NEEDS_HUMAN_MAPPING'
           AND human_review_status = 'PENDING'
           AND resolved_contact_id IS NULL
         ORDER BY received_at DESC, capture_id DESC
         LIMIT $1`,
        [TINDER_PENDING_HUMAN_MAPPING_LIMIT]
      );
      return result.rows;
    },

    /**
     * Bounded discovery projection for the first explicit T4 draft. This is
     * intentionally not a draft creator and does not return capture content,
     * fingerprints, device data, contacts, or provenance. A correlated latest
     * revision check prevents an older observation of the same runtime thread
     * from re-entering the selector after newer capture data exists.
     */
    async findDraftEligibleCaptures() {
      const result = await pool.query(
        `SELECT c.capture_id,
                c.source_package,
                c.capture_safety_status,
                c.mapping_status,
                c.human_review_status,
                COALESCE(
                  c.visible_thread_metadata ->> 'visibleName',
                  c.visible_thread_metadata ->> 'visible_name'
                ) AS visible_name
           FROM tinder_visible_chat_captures c
          WHERE c.capture_safety_status = 'SAFE'
            AND c.source_package = 'com.tinder'
            AND c.mapping_status = 'RESOLVED'
            AND c.human_review_status = 'CONFIRMED'
            AND c.resolved_contact_id IS NOT NULL
            AND c.capture_revision = (
              SELECT MAX(newer.capture_revision)
                FROM tinder_visible_chat_captures newer
               WHERE newer.device_id = c.device_id
                 AND newer.runtime_thread_fingerprint = c.runtime_thread_fingerprint
            )
            AND NOT EXISTS (
              SELECT 1
                FROM tinder_reply_drafts draft
               WHERE draft.capture_id = c.capture_id
            )
          ORDER BY c.received_at DESC, c.capture_id DESC
          LIMIT $1`,
        [TINDER_DRAFT_ELIGIBLE_CAPTURE_LIMIT]
      );
      return result.rows;
    }
  });
}

export {
  TINDER_CAPTURE_SCHEMA_VERSION_V1,
  TINDER_CAPTURE_SCHEMA_VERSION_V2,
  TINDER_CAPTURE_SCHEMA_VERSION_V3,
  TINDER_THREAD_BINDING_EVIDENCE,
  TINDER_HUMAN_ARMED_PERMIT,
  TINDER_CAPTURE_MAPPING_STATUS,
  TINDER_CAPTURE_REVIEW_STATUS,
  TINDER_DRAFT_ELIGIBLE_CAPTURE_LIMIT,
  TINDER_PENDING_HUMAN_MAPPING_LIMIT,
  TINDER_CAPTURE_SCHEMA_VERSION,
  TINDER_SOURCE_PACKAGE,
  TinderCaptureValidationError,
  captureSafetyStatus,
  createPgTinderCaptureRepository,
  createTinderCaptureStore,
  normalizeHumanArmedBindingPermit,
  normalizeThreadBindingEvidence,
  validateSafeVisibleChatCapture
};
