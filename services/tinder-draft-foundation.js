import crypto from "node:crypto";
import { isTinderManualGateCapable } from "../device-bridge/protocol-v1.js";

/* ==================================================
T4 TINDER DRAFT FOUNDATION

This module deliberately contains only an offline-safe draft boundary.  It
does not register a route, call a device, or expose a send operation.  The
caller supplies the existing shared-reply-core helpers explicitly so T4 never
grows a second persona, memory system, or reply engine.
================================================== */

const TINDER_DRAFT_CHANNEL = "tinder";

const TINDER_DRAFT_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  STALE: "STALE"
});

const TINDER_DRAFT_STALE_REASON = Object.freeze({
  NEWER_CAPTURE_REVISION: "NEWER_CAPTURE_REVISION",
  THREAD_CHANGED: "THREAD_CHANGED",
  IDENTITY_MAPPING_CHANGED: "IDENTITY_MAPPING_CHANGED",
  HUMAN_TAKEOVER: "HUMAN_TAKEOVER",
  HANDOFF: "HANDOFF",
  GATE_CLOSED: "GATE_CLOSED"
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const VISIBLE_DIRECTIONS = new Set(["INCOMING", "OUTGOING", "UNKNOWN"]);

class TinderDraftEligibilityError extends Error {
  constructor(message, code = "TINDER_DRAFT_INELIGIBLE", statusCode = 409) {
    super(message);
    this.name = "TinderDraftEligibilityError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function sourceValue(source, camelCase, snakeCase) {
  return source?.[camelCase] ?? source?.[snakeCase];
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedState(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizedCapabilities(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizedUuid(value, field, { statusCode = 400 } = {}) {
  const identifier = String(value || "").trim();
  if (!UUID_V4.test(identifier)) {
    throw new TinderDraftEligibilityError(`${field} ist ungültig.`, `INVALID_${field.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, statusCode);
  }
  return identifier;
}

function normalizedFingerprint(value, field = "Thread-Fingerprint") {
  const fingerprint = String(value || "").trim().toLowerCase();
  if (!SHA256_HEX.test(fingerprint)) {
    throw new TinderDraftEligibilityError(`${field} ist ungültig.`, "INVALID_THREAD_FINGERPRINT", 400);
  }
  return fingerprint;
}

function normalizedActor(value) {
  const actor = String(value || "system").trim();
  if (!actor || actor.length > 80) {
    throw new TinderDraftEligibilityError("Der Draft-Akteur ist ungültig.", "INVALID_DRAFT_ACTOR", 400);
  }
  return actor;
}

function normalizedNow(now) {
  const value = now?.();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new TypeError("now must return a valid Date");
  }
  return date.toISOString();
}

function normalizedLanguage(value) {
  if (value === null || value === undefined || value === "") return null;
  const language = String(value).trim().toLowerCase();
  if (!language || language.length > 32) return null;
  return language;
}

function isGermanLanguage(value) {
  const language = normalizedLanguage(value);
  return language === "de" || language === "deutsch" || language === "german" || language?.startsWith("de-");
}

function normalizedDraftText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 8000) {
    throw new TinderDraftEligibilityError("Der Shared Reply Core hat keinen gültigen Draft geliefert.", "EMPTY_SHARED_REPLY", 502);
  }
  return text;
}

function normalizeVisibleMessages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new TinderDraftEligibilityError("Das sichtbare Tinder-Capture enthält keine gültigen Nachrichten.", "INVALID_VISIBLE_CAPTURE", 409);
  }

  let previousOrder = 0;
  return Object.freeze(value.map((item) => {
    if (!plainObject(item)) {
      throw new TinderDraftEligibilityError("Das sichtbare Tinder-Capture ist ungültig.", "INVALID_VISIBLE_CAPTURE", 409);
    }
    const visibleOrder = positiveInteger(sourceValue(item, "visibleOrder", "visible_order"));
    const text = typeof item.text === "string" ? item.text.trim() : "";
    const direction = normalizedState(item.direction);
    if (visibleOrder === null || visibleOrder <= previousOrder || !text || text.length > 4096 || !VISIBLE_DIRECTIONS.has(direction)) {
      throw new TinderDraftEligibilityError("Das sichtbare Tinder-Capture ist ungültig.", "INVALID_VISIBLE_CAPTURE", 409);
    }
    previousOrder = visibleOrder;
    return Object.freeze({ visibleOrder, direction, text });
  }));
}

function normalizeCaptureRecord(row) {
  if (!plainObject(row)) {
    throw new TinderDraftEligibilityError("Das Tinder-Capture wurde nicht gefunden.", "CAPTURE_NOT_FOUND", 404);
  }

  const captureId = normalizedUuid(sourceValue(row, "captureId", "capture_id"), "Capture-ID", { statusCode: 409 });
  const contactId = positiveInteger(sourceValue(row, "resolvedContactId", "resolved_contact_id"));
  const captureRevision = positiveInteger(sourceValue(row, "captureRevision", "capture_revision"));
  const latestCaptureRevision = positiveInteger(sourceValue(row, "latestCaptureRevision", "latest_capture_revision"));
  const identityRevision = positiveInteger(sourceValue(row, "identityRevision", "identity_revision"));

  if (captureRevision === null || latestCaptureRevision === null || identityRevision === null) {
    throw new TinderDraftEligibilityError("Der serverseitige Capture-Status ist unvollständig.", "INVALID_CAPTURE_STATE", 409);
  }

  const normalized = Object.freeze({
    captureId,
    deviceId: normalizedUuid(sourceValue(row, "deviceId", "device_id"), "Device-ID", { statusCode: 409 }),
    captureSafetyStatus: normalizedState(sourceValue(row, "captureSafetyStatus", "capture_safety_status")),
    mappingStatus: normalizedState(sourceValue(row, "mappingStatus", "mapping_status")),
    humanReviewStatus: normalizedState(sourceValue(row, "humanReviewStatus", "human_review_status")),
    contactId,
    runtimeThreadFingerprint: normalizedFingerprint(sourceValue(row, "runtimeThreadFingerprint", "runtime_thread_fingerprint")),
    captureRevision,
    latestCaptureRevision,
    identityRevision,
    visibleMessages: normalizeVisibleMessages(sourceValue(row, "visibleMessages", "visible_messages")),
    enrollmentState: normalizedState(sourceValue(row, "deviceEnrollmentState", "device_enrollment_state")),
    bridgeState: normalizedState(sourceValue(row, "bridgeServiceState", "bridge_service_state")),
    tinderState: normalizedState(sourceValue(row, "tinderState", "tinder_state")),
    automationState: normalizedState(sourceValue(row, "automationState", "automation_state")),
    manualGateCapable: isTinderManualGateCapable(
      normalizedCapabilities(sourceValue(row, "deviceCapabilities", "device_capabilities") ?? row.capabilities)
    ),
    humanTakeoverActive: sourceValue(row, "humanTakeoverActive", "human_takeover_active"),
    handoffActive: sourceValue(row, "handoffActive", "handoff_active")
  });

  return normalized;
}

function assertDraftEligible(capture) {
  if (capture.captureSafetyStatus !== "SAFE") {
    throw new TinderDraftEligibilityError("Nur SAFE-Captures dürfen einen Draft erzeugen.", "CAPTURE_NOT_SAFE");
  }
  if (capture.mappingStatus !== "RESOLVED" || capture.humanReviewStatus !== "CONFIRMED" || capture.contactId === null) {
    throw new TinderDraftEligibilityError("Das Capture braucht eine bestätigte zentrale Kontaktzuordnung.", "IDENTITY_NOT_RESOLVED");
  }
  if (capture.captureRevision !== capture.latestCaptureRevision) {
    throw new TinderDraftEligibilityError("Das Capture ist nicht die aktuelle Revision.", "CAPTURE_REVISION_STALE");
  }
  if (capture.enrollmentState !== "ACTIVE") {
    throw new TinderDraftEligibilityError("Das Device-Enrollment ist nicht aktiv.", "DEVICE_ENROLLMENT_INACTIVE");
  }
  if (!capture.manualGateCapable) {
    throw new TinderDraftEligibilityError("Das Device unterstützt das Tinder Manual Gate nicht.", "DEVICE_CAPABILITY_UNSUPPORTED");
  }
  if (capture.bridgeState !== "RUNNING") {
    throw new TinderDraftEligibilityError("Die Bridge läuft nicht.", "BRIDGE_NOT_RUNNING");
  }
  if (capture.tinderState !== "CONNECTED") {
    throw new TinderDraftEligibilityError("Das lokale Tinder-Gate ist nicht verbunden.", "TINDER_GATE_NOT_CONNECTED");
  }
  if (capture.automationState !== "STOPPED") {
    throw new TinderDraftEligibilityError("Die Automation muss gestoppt bleiben.", "AUTOMATION_NOT_STOPPED");
  }
  if (capture.humanTakeoverActive !== false) {
    throw new TinderDraftEligibilityError("Ein menschlicher Takeover ist aktiv oder nicht verifizierbar.", "HUMAN_TAKEOVER_ACTIVE");
  }
  if (capture.handoffActive !== false) {
    throw new TinderDraftEligibilityError("Ein Handoff ist aktiv oder nicht verifizierbar.", "HANDOFF_ACTIVE");
  }
}

function terminalIncomingMessage(capture) {
  const terminal = capture.visibleMessages[capture.visibleMessages.length - 1];
  if (terminal?.direction !== "INCOMING") {
    throw new TinderDraftEligibilityError(
      "Die letzte sichtbare Tinder-Nachricht muss eingehend sein.",
      "TERMINAL_MESSAGE_NOT_INCOMING"
    );
  }
  return terminal;
}

function visibleTinderConversation(capture) {
  return capture.visibleMessages
    .map((message) => `${message.direction}: ${message.text}`)
    .join("\n");
}

function contactIdFromRow(row) {
  return positiveInteger(sourceValue(row, "id", "id") ?? sourceValue(row, "contactId", "contact_id"));
}

/* Only fields that the channel-neutral shared core actually needs travel from
the central contact into this adapter. */
function safeContactForTinderCore(row, expectedContactId) {
  if (!plainObject(row) || contactIdFromRow(row) !== expectedContactId) {
    throw new TinderDraftEligibilityError("Der zentrale Kontakt wurde nicht gefunden.", "CONTACT_NOT_FOUND", 404);
  }

  const result = { id: expectedContactId };
  const allowedFields = [
    ["memoryIdentityKey", "memory_identity_key"],
    ["canonicalName", "canonical_name"],
    ["displayName", "display_name"],
    ["country", "country"],
    ["city", "city"],
    ["primaryLanguage", "primary_language"],
    ["sourcePlatform", "source_platform"],
    ["currentPlatform", "current_platform"],
    ["platformStatus", "platform_status"],
    ["relationshipStage", "relationship_stage"],
    ["birthDay", "birth_day"],
    ["birthMonth", "birth_month"],
    ["birthYear", "birth_year"],
    ["birthYearInferred", "birth_year_inferred"]
  ];
  for (const [camelCase, snakeCase] of allowedFields) {
    const value = sourceValue(row, camelCase, snakeCase);
    if (value !== undefined) result[snakeCase] = value;
  }
  return Object.freeze(result);
}

function assertSameCaptureSnapshot(before, after) {
  const changed = before.captureId !== after.captureId ||
    before.contactId !== after.contactId ||
    before.runtimeThreadFingerprint !== after.runtimeThreadFingerprint ||
    before.captureRevision !== after.captureRevision ||
    before.identityRevision !== after.identityRevision;
  if (changed) {
    throw new TinderDraftEligibilityError("Das Capture hat sich während der Draft-Erzeugung geändert.", "CAPTURE_CHANGED_DURING_DRAFT");
  }
}

function normalizeDraftRow(row, fallback) {
  const source = plainObject(row) ? row : fallback;
  const draftId = normalizedUuid(sourceValue(source, "draftId", "draft_id"), "Draft-ID", { statusCode: 500 });
  const contactId = positiveInteger(sourceValue(source, "contactId", "contact_id"));
  const captureId = normalizedUuid(sourceValue(source, "captureId", "capture_id"), "Capture-ID", { statusCode: 500 });
  const captureRevision = positiveInteger(sourceValue(source, "captureRevision", "capture_revision"));
  const identityRevision = positiveInteger(sourceValue(source, "identityRevision", "identity_revision"));
  const status = normalizedState(source.status);
  const originalDraft = sourceValue(source, "originalDraft", "original_draft");
  const controlDraftDe = sourceValue(source, "controlDraftDe", "control_draft_de");
  const sourceLanguage = normalizedLanguage(sourceValue(source, "sourceLanguage", "source_language"));
  const modelVersion = String(sourceValue(source, "modelVersion", "model_version") || "").trim();
  const createdAt = String(sourceValue(source, "createdAt", "created_at") || "").trim();

  if (contactId === null || captureRevision === null || identityRevision === null ||
      status !== TINDER_DRAFT_STATUS.DRAFT || !modelVersion || modelVersion.length > 160 ||
      !createdAt || Number.isNaN(new Date(createdAt).valueOf())) {
    throw new TinderDraftEligibilityError("Der gespeicherte Tinder-Draft ist ungültig.", "INVALID_DRAFT_RECORD", 500);
  }

  const normalizedOriginalDraft = normalizedDraftText(originalDraft);
  const normalizedControlDraft = controlDraftDe === null || controlDraftDe === undefined
    ? null
    : normalizedDraftText(controlDraftDe);
  if (normalizedControlDraft !== null && (!isGermanLanguage(sourceLanguage) || normalizedControlDraft !== normalizedOriginalDraft)) {
    throw new TinderDraftEligibilityError("Der deutsche Kontroll-Draft ist ungültig.", "INVALID_DRAFT_RECORD", 500);
  }

  return Object.freeze({
    draftId,
    channel: TINDER_DRAFT_CHANNEL,
    status: TINDER_DRAFT_STATUS.DRAFT,
    contactId,
    captureId,
    runtimeThreadFingerprint: normalizedFingerprint(sourceValue(source, "runtimeThreadFingerprint", "runtime_thread_fingerprint")),
    captureRevision,
    identityRevision,
    originalDraft: normalizedOriginalDraft,
    controlDraftDe: normalizedControlDraft,
    sourceLanguage,
    modelVersion,
    createdAt: new Date(createdAt).toISOString()
  });
}

function requireRepository(repository) {
  for (const method of [
    "getCapture",
    "findCurrentDraft",
    "withTransaction",
    "getCaptureForUpdate",
    "findCurrentDraftForUpdate",
    "insertDraft",
    "markDraftsStale"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
}

function requireAdapters(adapters) {
  for (const method of [
    "getContactById",
    "getContactMemoryProfile",
    "getRelevantMemoryItems",
    "getRelevantMemoryEvents",
    "getMarcelMemory",
    "getMarcelLiveState",
    "buildMemoryContext",
    "resolveReplyLanguage",
    "generateSharedReply"
  ]) {
    if (typeof adapters?.[method] !== "function") {
      throw new TypeError(`${method} must be a function`);
    }
  }
}

function normalizeStaleRequest(input = {}) {
  const reason = normalizedState(input.reason);
  if (!Object.hasOwn(TINDER_DRAFT_STALE_REASON, reason)) {
    throw new TinderDraftEligibilityError("Der Draft-Stale-Grund ist ungültig.", "INVALID_DRAFT_STALE_REASON", 400);
  }

  const request = {
    reason,
    actor: normalizedActor(input.actor),
    captureId: input.captureId === undefined ? null : normalizedUuid(input.captureId, "Capture-ID"),
    contactId: input.contactId === undefined ? null : positiveInteger(input.contactId),
    runtimeThreadFingerprint: input.runtimeThreadFingerprint === undefined
      ? null
      : normalizedFingerprint(input.runtimeThreadFingerprint),
    deviceId: input.deviceId === undefined ? null : normalizedUuid(input.deviceId, "Device-ID"),
    newerCaptureRevision: input.newerCaptureRevision === undefined
      ? null
      : positiveInteger(input.newerCaptureRevision)
  };

  if (input.contactId !== undefined && request.contactId === null) {
    throw new TinderDraftEligibilityError("Die Kontakt-ID ist ungültig.", "INVALID_CONTACT_ID", 400);
  }
  if (input.newerCaptureRevision !== undefined && request.newerCaptureRevision === null) {
    throw new TinderDraftEligibilityError("Die Capture-Revision ist ungültig.", "INVALID_CAPTURE_REVISION", 400);
  }

  if (reason === TINDER_DRAFT_STALE_REASON.NEWER_CAPTURE_REVISION) {
    if (!request.runtimeThreadFingerprint || request.newerCaptureRevision === null) {
      throw new TinderDraftEligibilityError("Eine neue Capture-Revision braucht Thread-Fingerprint und Revision.", "STALE_TARGET_REQUIRED", 400);
    }
  } else if (reason === TINDER_DRAFT_STALE_REASON.THREAD_CHANGED) {
    if (request.contactId === null || !request.runtimeThreadFingerprint) {
      throw new TinderDraftEligibilityError("Ein Thread-Wechsel braucht Kontakt-ID und aktuellen Thread-Fingerprint.", "STALE_TARGET_REQUIRED", 400);
    }
  } else if (reason === TINDER_DRAFT_STALE_REASON.IDENTITY_MAPPING_CHANGED) {
    if (!request.captureId) {
      throw new TinderDraftEligibilityError("Eine Identitätsänderung braucht eine Capture-ID.", "STALE_TARGET_REQUIRED", 400);
    }
  } else if (!request.captureId && request.contactId === null && !request.runtimeThreadFingerprint && !request.deviceId) {
    throw new TinderDraftEligibilityError("Der Draft-Stale-Vorgang braucht ein enges Ziel.", "STALE_TARGET_REQUIRED", 400);
  }

  return Object.freeze(request);
}

function staleCountFromResult(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  const count = Number(value?.staleCount ?? value?.stale_count ?? value?.count ?? 0);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

/**
 * The only T4 draft factory.  The request surface accepts a capture id only;
 * it never receives a contact, message, gate, or identity state from a client.
 */
function createTinderDraftFoundationService({
  repository,
  getContactById,
  getContactMemoryProfile,
  getRelevantMemoryItems,
  getRelevantMemoryEvents,
  getMarcelMemory,
  getMarcelLiveState,
  buildMemoryContext,
  resolveReplyLanguage,
  generateSharedReply,
  now = () => new Date(),
  createDraftId = () => crypto.randomUUID(),
  modelVersion = "shared-reply-core-v1"
} = {}) {
  requireRepository(repository);
  const adapters = {
    getContactById,
    getContactMemoryProfile,
    getRelevantMemoryItems,
    getRelevantMemoryEvents,
    getMarcelMemory,
    getMarcelLiveState,
    buildMemoryContext,
    resolveReplyLanguage,
    generateSharedReply
  };
  requireAdapters(adapters);

  const normalizedModelVersion = String(modelVersion || "").trim();
  if (!normalizedModelVersion || normalizedModelVersion.length > 160) {
    throw new TypeError("modelVersion must be a non-empty string up to 160 characters");
  }

  async function loadEligibleDraftInput(captureId) {
    const rawCapture = await repository.getCapture(captureId);
    const capture = normalizeCaptureRecord(rawCapture);
    assertDraftEligible(capture);
    const rawContact = await adapters.getContactById(capture.contactId);
    const contact = safeContactForTinderCore(rawContact, capture.contactId);
    return Object.freeze({ capture, contact });
  }

  async function createDraft({ captureId } = {}) {
    const normalizedCaptureId = normalizedUuid(captureId, "Capture-ID");
    const initial = await loadEligibleDraftInput(normalizedCaptureId);
    const existingInitial = await repository.findCurrentDraft(
      normalizedCaptureId,
      initial.capture.captureRevision,
      initial.capture.identityRevision
    );
    if (existingInitial) {
      return normalizeDraftRow(existingInitial);
    }
    const incoming = terminalIncomingMessage(initial.capture);

    const [profile, memoryItems, memoryEvents, marcelMemory, liveState] = await Promise.all([
      adapters.getContactMemoryProfile(initial.contact.id),
      adapters.getRelevantMemoryItems(initial.contact.id),
      adapters.getRelevantMemoryEvents(initial.contact.id),
      adapters.getMarcelMemory(),
      adapters.getMarcelLiveState()
    ]);
    const memoryContext = await adapters.buildMemoryContext({
      contact: initial.contact,
      profile: profile || null,
      memoryItems: Array.isArray(memoryItems) ? memoryItems : [],
      memoryEvents: Array.isArray(memoryEvents) ? memoryEvents : [],
      marcelMemory: Array.isArray(marcelMemory) ? marcelMemory : [],
      liveState: plainObject(liveState) ? liveState : {}
    });
    const sourceLanguage = normalizedLanguage(
      await adapters.resolveReplyLanguage(initial.contact, null, incoming.text)
    );

    // This is deliberately the sole shared-core invocation and happens only
    // after all server-owned eligibility gates above have passed.
    const originalDraft = normalizedDraftText(await adapters.generateSharedReply({
      incomingText: incoming.text,
      conversation: visibleTinderConversation(initial.capture),
      memoryContext: typeof memoryContext === "string" ? memoryContext : String(memoryContext || ""),
      resolvedLanguage: sourceLanguage,
      channelLabel: "Tinder"
    }));
    const draftId = normalizedUuid(createDraftId(), "Draft-ID", { statusCode: 500 });
    const createdAt = normalizedNow(now);

    return repository.withTransaction(async (transaction) => {
      const currentCapture = normalizeCaptureRecord(
        await repository.getCaptureForUpdate(transaction, normalizedCaptureId)
      );
      assertDraftEligible(currentCapture);
      terminalIncomingMessage(currentCapture);
      assertSameCaptureSnapshot(initial.capture, currentCapture);
      safeContactForTinderCore(
        await adapters.getContactById(currentCapture.contactId),
        currentCapture.contactId
      );

      const existingLocked = await repository.findCurrentDraftForUpdate(
        transaction,
        currentCapture.captureId,
        currentCapture.captureRevision,
        currentCapture.identityRevision
      );
      if (existingLocked) {
        return normalizeDraftRow(existingLocked);
      }

      await repository.markDraftsStale(transaction, {
        reason: TINDER_DRAFT_STALE_REASON.NEWER_CAPTURE_REVISION,
        actor: "system",
        contactId: currentCapture.contactId,
        runtimeThreadFingerprint: currentCapture.runtimeThreadFingerprint,
        newerCaptureRevision: currentCapture.captureRevision,
        captureId: null,
        deviceId: null
      });

      const record = Object.freeze({
        draftId,
        channel: TINDER_DRAFT_CHANNEL,
        status: TINDER_DRAFT_STATUS.DRAFT,
        contactId: currentCapture.contactId,
        captureId: currentCapture.captureId,
        runtimeThreadFingerprint: currentCapture.runtimeThreadFingerprint,
        captureRevision: currentCapture.captureRevision,
        identityRevision: currentCapture.identityRevision,
        originalDraft,
        controlDraftDe: isGermanLanguage(sourceLanguage) ? originalDraft : null,
        sourceLanguage,
        modelVersion: normalizedModelVersion,
        createdAt
      });
      const stored = await repository.insertDraft(transaction, record);
      return normalizeDraftRow(stored, record);
    });
  }

  async function markDraftsStale(input = {}) {
    const request = normalizeStaleRequest(input);
    return repository.withTransaction(async (transaction) => {
      const staleCount = staleCountFromResult(await repository.markDraftsStale(transaction, request));
      return Object.freeze({
        reason: request.reason,
        staleCount
      });
    });
  }

  return Object.freeze({ createDraft, markDraftsStale });
}

function createPgTinderDraftRepository(pool) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new TypeError("pool.query and pool.connect must be functions");
  }

  const selectCapture = `
    SELECT
      c.capture_id,
      c.device_id,
      c.capture_safety_status,
      c.mapping_status,
      c.human_review_status,
      c.resolved_contact_id,
      c.runtime_thread_fingerprint,
      c.capture_revision,
      c.identity_revision,
      c.visible_messages,
      c.human_takeover_active,
      c.handoff_active,
      d.enrollment_state AS device_enrollment_state,
      d.bridge_service_state,
      d.tinder_state,
      d.automation_state,
      d.capabilities AS device_capabilities,
      (
        SELECT MAX(newer.capture_revision)
        FROM tinder_visible_chat_captures newer
        WHERE newer.device_id = c.device_id
          AND newer.runtime_thread_fingerprint = c.runtime_thread_fingerprint
      ) AS latest_capture_revision
    FROM tinder_visible_chat_captures c
    JOIN device_bridge_devices d
      ON d.device_id = c.device_id
    WHERE c.capture_id = $1`;

  const selectCurrentDraft = `
    SELECT
      draft_id,
      contact_id,
      capture_id,
      capture_revision,
      identity_revision,
      status,
      original_draft,
      control_draft_de,
      source_language,
      model_version,
      created_at
    FROM tinder_reply_drafts
    WHERE capture_id = $1
      AND capture_revision = $2
      AND identity_revision = $3
      AND status = 'DRAFT'
    ORDER BY created_at DESC, draft_id DESC
    LIMIT 1`;

  function singleRow(result) {
    return result.rows[0] || null;
  }

  return Object.freeze({
    async getCapture(captureId) {
      return singleRow(await pool.query(selectCapture, [captureId]));
    },

    async findCurrentDraft(captureId, captureRevision, identityRevision) {
      return singleRow(await pool.query(
        selectCurrentDraft,
        [captureId, captureRevision, identityRevision]
      ));
    },

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

    async getCaptureForUpdate(client, captureId) {
      const result = await client.query(`${selectCapture}\nFOR UPDATE OF c, d`, [captureId]);
      return singleRow(result);
    },

    async findCurrentDraftForUpdate(client, captureId, captureRevision, identityRevision) {
      return singleRow(await client.query(
        `${selectCurrentDraft}\nFOR UPDATE`,
        [captureId, captureRevision, identityRevision]
      ));
    },

    async insertDraft(client, record) {
      const result = await client.query(
        `INSERT INTO tinder_reply_drafts (
           draft_id, channel, status, contact_id, capture_id,
           runtime_thread_fingerprint, capture_revision, identity_revision,
           original_draft, control_draft_de, source_language,
           model_version, created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13
         ) RETURNING *`,
        [
          record.draftId,
          TINDER_DRAFT_CHANNEL,
          TINDER_DRAFT_STATUS.DRAFT,
          record.contactId,
          record.captureId,
          record.runtimeThreadFingerprint,
          record.captureRevision,
          record.identityRevision,
          record.originalDraft,
          record.controlDraftDe,
          record.sourceLanguage,
          record.modelVersion,
          record.createdAt
        ]
      );
      const stored = singleRow(result);
      if (!stored) return null;
      await client.query(
        `INSERT INTO tinder_reply_draft_audit (
           draft_id, capture_id, action, actor, source,
           previous_status, new_status, reason, details
         ) VALUES ($1,$2,'DRAFT_CREATED','system','tinder_draft_foundation',NULL,'DRAFT',NULL,$3::jsonb)`,
        [
          record.draftId,
          record.captureId,
          JSON.stringify({
            captureRevision: record.captureRevision,
            identityRevision: record.identityRevision,
            modelVersion: record.modelVersion
          })
        ]
      );
      return stored;
    },

    async markDraftsStale(client, request) {
      const result = await client.query(
        `WITH stale AS (
           UPDATE tinder_reply_drafts draft
              SET status = 'STALE',
                  stale_reason = $7,
                  updated_at = NOW()
             FROM tinder_visible_chat_captures capture
            WHERE draft.capture_id = capture.capture_id
              AND draft.status = 'DRAFT'
              AND ($1::uuid IS NULL OR draft.capture_id = $1)
              AND ($2::integer IS NULL OR draft.contact_id = $2)
              AND ($3::char(64) IS NULL OR draft.runtime_thread_fingerprint = $3)
              AND ($4::integer IS NULL OR draft.capture_revision < $4)
              AND ($5::uuid IS NULL OR capture.device_id = $5)
              AND ($6::char(64) IS NULL OR draft.runtime_thread_fingerprint <> $6::char(64))
           RETURNING draft.draft_id, draft.capture_id
         ), audit AS (
           INSERT INTO tinder_reply_draft_audit (
             draft_id, capture_id, action, actor, source,
             previous_status, new_status, reason, details
           )
           SELECT stale.draft_id, stale.capture_id, 'DRAFT_STALE', $8,
                  'tinder_draft_foundation', 'DRAFT', 'STALE', $7, $9::jsonb
             FROM stale
         )
         SELECT COUNT(*)::integer AS stale_count FROM stale`,
        [
          request.captureId,
          request.contactId,
          request.reason === TINDER_DRAFT_STALE_REASON.THREAD_CHANGED ? null : request.runtimeThreadFingerprint,
          request.newerCaptureRevision,
          request.deviceId,
          request.reason === TINDER_DRAFT_STALE_REASON.THREAD_CHANGED
            ? request.runtimeThreadFingerprint
            : null,
          request.reason,
          request.actor,
          JSON.stringify({
            ...(request.runtimeThreadFingerprint ? { runtimeThreadFingerprint: request.runtimeThreadFingerprint } : {}),
            ...(request.newerCaptureRevision !== null ? { newerCaptureRevision: request.newerCaptureRevision } : {})
          })
        ]
      );
      return Number(singleRow(result)?.stale_count || 0);
    }
  });
}

export {
  TINDER_DRAFT_CHANNEL,
  TINDER_DRAFT_STALE_REASON,
  TINDER_DRAFT_STATUS,
  TinderDraftEligibilityError,
  createPgTinderDraftRepository,
  createTinderDraftFoundationService,
  isGermanLanguage,
  normalizeStaleRequest
};
