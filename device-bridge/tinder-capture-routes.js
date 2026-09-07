import { isUuidV4 } from "./protocol-v1.js";
import {
  createPgTinderCaptureRepository,
  createTinderCaptureStore,
  TINDER_DRAFT_ELIGIBLE_CAPTURE_LIMIT,
  TINDER_PENDING_HUMAN_MAPPING_LIMIT
} from "../services/tinder-capture-store.js";
import {
  TinderHumanMappingError,
  createPgTinderHumanMappingRepository,
  createTinderHumanMappingService
} from "../services/tinder-human-mapping.js";
import {
  CHANNEL_CONVERSATION_BINDING_STATUS,
  ChannelConversationBindingError,
  createChannelConversationBindingService,
  createPgChannelConversationBindingRepository
} from "../services/channel-conversation-binding.js";
import {
  HUMAN_ARMED_CONVERSATION_STATUS,
  TinderHumanArmedConversationBindingError,
  createPgTinderHumanArmedConversationBindingRepository,
  createTinderHumanArmedConversationBindingService
} from "../services/tinder-human-armed-conversation-binding.js";
import { TINDER_IDENTITY_RESOLUTION_STATUS } from "../services/tinder-identity-resolution.js";

/* ==================================================
T3 TINDER CAPTURE READ / HUMAN-MAPPING ROUTES

The signed T2 ingress remains the single device-write boundary in
`tinder-visible-chat-capture-ingress.js`. This module adds only dashboard
read and explicit human-mapping routes on top of that capture contract.
================================================== */

const TINDER_CAPTURE_FOUNDATION_ERROR_CODES = new Set(["42P01", "42703", "23502"]);
const TINDER_CAPTURE_MAPPING_BODY_FIELDS = new Set([
  "action",
  "contact_id",
  "new_contact_name",
  "tinder_identifier",
  "confirmed"
]);
const TINDER_CAPTURE_CONVERSATION_BINDING_BODY_FIELDS = new Set([
  "action",
  "contact_id",
  "new_contact_name",
  "confirmed"
]);
const TINDER_HUMAN_ARMED_BINDING_BODY_FIELDS = new Set([
  "action",
  "contact_id",
  "new_contact_name",
  "confirmed"
]);
const TINDER_HUMAN_ARMED_REARM_BODY_FIELDS = new Set(["confirmed"]);
const TINDER_HUMAN_ARMED_BINDING_LIST_LIMIT = 25;
const PUBLIC_CONVERSATION_BINDING_STATUSES = new Set(Object.values(CHANNEL_CONVERSATION_BINDING_STATUS));
const PUBLIC_HUMAN_ARMED_BINDING_ERROR_STATUSES = new Set([
  HUMAN_ARMED_CONVERSATION_STATUS.UNSAFE_CAPTURE,
  HUMAN_ARMED_CONVERSATION_STATUS.PENDING_CAPTURE_REQUIRED,
  HUMAN_ARMED_CONVERSATION_STATUS.DEVICE_NOT_READY,
  HUMAN_ARMED_CONVERSATION_STATUS.BINDING_NOT_READY,
  HUMAN_ARMED_CONVERSATION_STATUS.PERMIT_NOT_AVAILABLE,
  HUMAN_ARMED_CONVERSATION_STATUS.CONFLICT
]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function foundationNotReadyError() {
  return {
    statusCode: 503,
    code: "TINDER_IDENTITY_FOUNDATION_NOT_READY",
    message: "Tinder identity foundation is not ready"
  };
}

function humanArmedBindingFoundationNotReadyError() {
  return {
    statusCode: 503,
    code: "TINDER_HUMAN_ARMED_BINDING_FOUNDATION_NOT_READY",
    message: "Tinder human-armed conversation binding foundation is not ready"
  };
}

function isFoundationNotReadyError(error) {
  return TINDER_CAPTURE_FOUNDATION_ERROR_CODES.has(error?.code);
}

function safeMessage(error, fallback) {
  return typeof error?.message === "string" && error.message.trim()
    ? error.message
    : fallback;
}

function normalizeCaptureId(value) {
  const captureId = String(value || "").trim();
  if (!isUuidV4(captureId)) {
    const error = new Error("Ungültige Capture-ID.");
    error.statusCode = 400;
    error.code = "INVALID_CAPTURE_ID";
    throw error;
  }
  return captureId;
}

function normalizeBindingId(value) {
  const bindingId = String(value || "").trim();
  if (!isUuidV4(bindingId)) {
    const error = new Error("Invalid human-armed binding id.");
    error.statusCode = 400;
    error.code = "INVALID_HUMAN_ARMED_BINDING_ID";
    throw error;
  }
  return bindingId;
}

function normalizeCaptureRecord(row, { conversationBindingStatus = null } = {}) {
  const captureId = String(row?.captureId ?? row?.capture_id ?? "").trim();
  const deviceId = String(row?.deviceId ?? row?.device_id ?? "").trim();
  const captureRevision = Number(row?.captureRevision ?? row?.capture_revision);
  const mappingStatus = String(row?.mappingStatus ?? row?.mapping_status ?? "").trim().toUpperCase();
  const reviewStatus = String(row?.humanReviewStatus ?? row?.human_review_status ?? "").trim().toUpperCase();
  const safetyStatus = String(row?.captureSafetyStatus ?? row?.capture_safety_status ?? "SAFE").trim().toUpperCase();
  const sourcePackage = String(row?.sourcePackage ?? row?.source_package ?? "com.tinder").trim();
  const metadata = row?.visibleThreadMetadata ?? row?.visible_thread_metadata ?? {};

  if (!isUuidV4(captureId) || !isUuidV4(deviceId)
      || !Number.isInteger(captureRevision) || captureRevision < 1
      || !["NEEDS_HUMAN_MAPPING", "RESOLVED", "CONFLICT"].includes(mappingStatus)
      || !["PENDING", "CONFIRMED", "REJECTED"].includes(reviewStatus)
      || safetyStatus !== "SAFE" || sourcePackage !== "com.tinder" || !plainObject(metadata)) {
    const error = new Error("Invalid capture record.");
    error.statusCode = 500;
    error.code = "INVALID_TINDER_CAPTURE_RECORD";
    throw error;
  }

  const visibleName = String(metadata.visibleName ?? metadata.visible_name ?? "").trim();
  if (!visibleName || visibleName.length > 240) {
    const error = new Error("Invalid capture record.");
    error.statusCode = 500;
    error.code = "INVALID_TINDER_CAPTURE_RECORD";
    throw error;
  }

  const timestamp = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  };

  const normalizedConversationBindingStatus = conversationBindingStatus === null
    ? null
    : String(conversationBindingStatus || "").trim().toUpperCase();
  if (normalizedConversationBindingStatus !== null
      && !PUBLIC_CONVERSATION_BINDING_STATUSES.has(normalizedConversationBindingStatus)) {
    const error = new Error("Invalid conversation binding status.");
    error.statusCode = 500;
    error.code = "INVALID_CONVERSATION_BINDING_STATUS";
    throw error;
  }

  return Object.freeze({
    capture_id: captureId,
    device_id: deviceId,
    capture_revision: captureRevision,
    mapping_status: mappingStatus,
    human_review_status: reviewStatus,
    visible_name: visibleName,
    source_package: sourcePackage,
    captured_at: timestamp(row?.capturedAt ?? row?.captured_at),
    received_at: timestamp(row?.receivedAt ?? row?.received_at),
    ...(normalizedConversationBindingStatus === null
      ? {}
      : { conversation_binding_status: normalizedConversationBindingStatus })
  });
}

function normalizePendingCaptureRecords(rows) {
  if (!Array.isArray(rows) || rows.length > TINDER_PENDING_HUMAN_MAPPING_LIMIT) {
    const error = new Error("Invalid pending capture records.");
    error.statusCode = 500;
    error.code = "INVALID_PENDING_TINDER_CAPTURES";
    throw error;
  }
  return Object.freeze(rows.map((row) => {
    const capture = normalizeCaptureRecord(row);
    if (
      capture.mapping_status !== "NEEDS_HUMAN_MAPPING"
      || capture.human_review_status !== "PENDING"
    ) {
      const error = new Error("Invalid pending capture record.");
      error.statusCode = 500;
      error.code = "INVALID_PENDING_TINDER_CAPTURES";
      throw error;
    }
    return capture;
  }));
}

/**
 * The initial T4 selector remains deliberately less revealing than a capture
 * detail: it provides only an opaque capture handle and the visible label.
 * Eligibility itself is selected by the repository and is rechecked by the
 * existing explicit draft-creation route after a human opens the detail.
 */
function normalizeDraftEligibleCaptureRecords(rows) {
  if (!Array.isArray(rows) || rows.length > TINDER_DRAFT_ELIGIBLE_CAPTURE_LIMIT) {
    const error = new Error("Invalid draft-eligible capture records.");
    error.statusCode = 500;
    error.code = "INVALID_DRAFT_ELIGIBLE_TINDER_CAPTURES";
    throw error;
  }
  return Object.freeze(rows.map((row) => {
    const captureId = String(row?.captureId ?? row?.capture_id ?? "").trim();
    const visibleName = String(row?.visibleName ?? row?.visible_name ?? "").trim();
    const safetyStatus = String(row?.captureSafetyStatus ?? row?.capture_safety_status ?? "").trim().toUpperCase();
    const mappingStatus = String(row?.mappingStatus ?? row?.mapping_status ?? "").trim().toUpperCase();
    const reviewStatus = String(row?.humanReviewStatus ?? row?.human_review_status ?? "").trim().toUpperCase();
    const sourcePackage = String(row?.sourcePackage ?? row?.source_package ?? "").trim();
    if (!isUuidV4(captureId) || !visibleName || visibleName.length > 240
        || safetyStatus !== "SAFE" || sourcePackage !== "com.tinder"
        || mappingStatus !== "RESOLVED" || reviewStatus !== "CONFIRMED") {
      const error = new Error("Invalid draft-eligible capture record.");
      error.statusCode = 500;
      error.code = "INVALID_DRAFT_ELIGIBLE_TINDER_CAPTURES";
      throw error;
    }
    return Object.freeze({ capture_id: captureId, visible_name: visibleName });
  }));
}

function assertMappingBody(body) {
  if (!plainObject(body) || Object.keys(body).some((key) => !TINDER_CAPTURE_MAPPING_BODY_FIELDS.has(key))) {
    const error = new Error("Ungültige Mapping-Anfrage.");
    error.statusCode = 400;
    error.code = "INVALID_TINDER_MAPPING_REQUEST";
    throw error;
  }

  const action = String(body.action || "").trim().toUpperCase();
  if (!["MAP_EXISTING", "CREATE_NEW"].includes(action) || body.confirmed !== true) {
    const error = new Error("Menschliche Bestätigung ist erforderlich.");
    error.statusCode = 400;
    error.code = "HUMAN_CONFIRMATION_REQUIRED";
    throw error;
  }

  const required = action === "MAP_EXISTING"
    ? ["action", "contact_id", "tinder_identifier", "confirmed"]
    : ["action", "new_contact_name", "tinder_identifier", "confirmed"];
  if (!exactKeys(body, required)) {
    const error = new Error("Mapping-Anfrage enthält nicht erlaubte Felder.");
    error.statusCode = 400;
    error.code = "INVALID_TINDER_MAPPING_REQUEST";
    throw error;
  }

  return Object.freeze({
    action,
    ...(action === "MAP_EXISTING" ? { contactId: body.contact_id } : { newContactName: body.new_contact_name }),
    tinderIdentifier: body.tinder_identifier,
    confirmed: true
  });
}

/**
 * A durable conversation binding deliberately has no client-provided token,
 * profile identifier, display-name or fingerprint field. The service loads
 * its candidate solely from the stored signed capture by URL capture ID.
 */
function assertConversationBindingBody(body) {
  if (!plainObject(body) || Object.keys(body).some((key) =>
    !TINDER_CAPTURE_CONVERSATION_BINDING_BODY_FIELDS.has(key))) {
    const error = new Error("Ungültige Conversation-Binding-Anfrage.");
    error.statusCode = 400;
    error.code = "INVALID_CONVERSATION_BINDING_REQUEST";
    throw error;
  }
  const action = String(body.action || "").trim().toUpperCase();
  if (!['BIND_EXISTING', 'BIND_CREATE'].includes(action) || body.confirmed !== true) {
    const error = new Error("Menschliche Bestätigung ist erforderlich.");
    error.statusCode = 400;
    error.code = "HUMAN_CONFIRMATION_REQUIRED";
    throw error;
  }
  const required = action === "BIND_EXISTING"
    ? ["action", "contact_id", "confirmed"]
    : ["action", "new_contact_name", "confirmed"];
  if (!exactKeys(body, required)) {
    const error = new Error("Conversation-Binding-Anfrage enthält nicht erlaubte Felder.");
    error.statusCode = 400;
    error.code = "INVALID_CONVERSATION_BINDING_REQUEST";
    throw error;
  }
  return Object.freeze({
    action,
    ...(action === "BIND_EXISTING" ? { contactId: body.contact_id } : { newContactName: body.new_contact_name }),
    confirmed: true
  });
}

/**
 * The human-armed fallback never accepts a platform identifier, visible name,
 * fingerprint, device ID, or caller-supplied binding reference. The service
 * loads the selected SAFE capture by URL capture ID itself.
 */
function assertHumanArmedBindingBody(body) {
  if (!plainObject(body) || Object.keys(body).some((key) =>
    !TINDER_HUMAN_ARMED_BINDING_BODY_FIELDS.has(key))) {
    const error = new Error("Invalid human-armed binding request.");
    error.statusCode = 400;
    error.code = "INVALID_HUMAN_ARMED_BINDING_REQUEST";
    throw error;
  }
  const action = String(body.action || "").trim().toUpperCase();
  if (!["BIND_EXISTING", "BIND_CREATE"].includes(action) || body.confirmed !== true) {
    const error = new Error("Human confirmation is required.");
    error.statusCode = 400;
    error.code = "HUMAN_CONFIRMATION_REQUIRED";
    throw error;
  }
  const required = action === "BIND_EXISTING"
    ? ["action", "contact_id", "confirmed"]
    : ["action", "new_contact_name", "confirmed"];
  if (!exactKeys(body, required)) {
    const error = new Error("Human-armed binding request has forbidden fields.");
    error.statusCode = 400;
    error.code = "INVALID_HUMAN_ARMED_BINDING_REQUEST";
    throw error;
  }
  if (action === "BIND_EXISTING") {
    const contactId = Number(body.contact_id);
    if (!Number.isSafeInteger(contactId) || contactId <= 0) {
      const error = new Error("Selected contact is invalid.");
      error.statusCode = 400;
      error.code = "INVALID_CONTACT_ID";
      throw error;
    }
    return Object.freeze({ action, contactId, confirmed: true });
  }
  const newContactName = String(body.new_contact_name || "").trim().replace(/\s+/g, " ");
  if (!newContactName || newContactName.length > 160) {
    const error = new Error("New contact name is invalid.");
    error.statusCode = 400;
    error.code = "INVALID_NEW_CONTACT_NAME";
    throw error;
  }
  return Object.freeze({ action, newContactName, confirmed: true });
}

function assertHumanArmedRearmBody(body) {
  if (!exactKeys(body, TINDER_HUMAN_ARMED_REARM_BODY_FIELDS) || body.confirmed !== true) {
    const error = new Error("Human confirmation is required.");
    error.statusCode = 400;
    error.code = "HUMAN_CONFIRMATION_REQUIRED";
    throw error;
  }
  return Object.freeze({ confirmed: true });
}

function normalizeHumanArmedBindingRecords(rows) {
  if (!Array.isArray(rows) || rows.length > TINDER_HUMAN_ARMED_BINDING_LIST_LIMIT) {
    const error = new Error("Invalid human-armed binding records.");
    error.statusCode = 500;
    error.code = "INVALID_HUMAN_ARMED_BINDING_LIST";
    throw error;
  }
  return Object.freeze(rows.map((row) => {
    const bindingId = normalizeBindingId(row?.bindingId ?? row?.binding_id);
    const contactName = String(row?.contactName ?? row?.contact_name ?? "").trim();
    const bindingState = String(row?.bindingState ?? row?.binding_state ?? row?.state ?? "").trim().toUpperCase();
    if (!contactName || contactName.length > 160 || bindingState !== "CONFIRMED") {
      const error = new Error("Invalid human-armed binding record.");
      error.statusCode = 500;
      error.code = "INVALID_HUMAN_ARMED_BINDING_LIST";
      throw error;
    }
    // binding_id is an opaque in-memory browser handle for the explicit
    // rearm POST only. It is never rendered, copied, or placed in a URL.
    return Object.freeze({ binding_id: bindingId, contact_name: contactName });
  }));
}

function boundedHumanArmedBindingResult(result) {
  const status = String(result?.status || "").trim().toUpperCase();
  if (status === HUMAN_ARMED_CONVERSATION_STATUS.ARMED
      || PUBLIC_HUMAN_ARMED_BINDING_ERROR_STATUSES.has(status)) {
    return Object.freeze({ status });
  }
  const error = new Error("Invalid human-armed binding result.");
  error.statusCode = 500;
  error.code = "INVALID_HUMAN_ARMED_BINDING_RESULT";
  throw error;
}

function createTinderDashboardCaptureReadHandler(pool, {
  createRepository = createPgTinderCaptureRepository,
  createStore = createTinderCaptureStore,
  createBindingRepository = createPgChannelConversationBindingRepository,
  createBindingService = createChannelConversationBindingService
} = {}) {
  const store = createStore(createRepository(pool));
  // Tests and an older pre-foundation deployment may deliberately provide no
  // usable binding repository. Capture read stays redacted and operational;
  // only the new binding status is then absent rather than guessed.
  let bindingService = null;
  try {
    bindingService = createBindingService(createBindingRepository(pool));
  } catch {
    bindingService = null;
  }
  return async function tinderDashboardCaptureReadHandler(req, res) {
    try {
      const capture = await store.getCapture(normalizeCaptureId(req.params.captureId));
      if (!capture) {
        const error = new Error("Capture was not found.");
        error.statusCode = 404;
        error.code = "CAPTURE_NOT_FOUND";
        throw error;
      }
      const readiness = bindingService
        ? await bindingService.getReadiness(String(capture.captureId ?? capture.capture_id))
        : null;
      return res.status(200).json({
        ok: true,
        capture: normalizeCaptureRecord(capture, {
          conversationBindingStatus: readiness?.status ?? null
        })
      });
    } catch (error) {
      if (isFoundationNotReadyError(error)) {
        const notReady = foundationNotReadyError();
        return res.status(notReady.statusCode).json({ ok: false, code: notReady.code, error: notReady.message });
      }
      const status = Number(error?.statusCode) || 500;
      if (status === 500) console.error("Tinder dashboard capture read failed.");
      return res.status(status).json({
        ok: false,
        code: error?.code || "TINDER_CAPTURE_READ_FAILED",
        error: status === 500 ? "Tinder capture could not be loaded." : safeMessage(error, "Tinder capture could not be loaded.")
      });
    }
  };
}

function createTinderDashboardPendingCaptureListHandler(pool, {
  createRepository = createPgTinderCaptureRepository,
  createStore = createTinderCaptureStore
} = {}) {
  const store = createStore(createRepository(pool));
  return async function tinderDashboardPendingCaptureListHandler(_req, res) {
    try {
      const captures = normalizePendingCaptureRecords(
        await store.listPendingHumanMappingCaptures()
      );
      return res.status(200).json({ ok: true, captures });
    } catch (error) {
      if (isFoundationNotReadyError(error)) {
        const notReady = foundationNotReadyError();
        return res.status(notReady.statusCode).json({ ok: false, code: notReady.code, error: notReady.message });
      }
      const status = Number(error?.statusCode) || 500;
      if (status === 500) console.error("Tinder dashboard pending capture list failed.");
      return res.status(status).json({
        ok: false,
        code: error?.code || "TINDER_PENDING_CAPTURE_LIST_FAILED",
        error: status === 500 ? "Tinder captures could not be loaded." : safeMessage(error, "Tinder captures could not be loaded.")
      });
    }
  };
}

function createTinderDashboardDraftEligibleCaptureListHandler(pool, {
  createRepository = createPgTinderCaptureRepository
} = {}) {
  const repository = createRepository(pool);
  return async function tinderDashboardDraftEligibleCaptureListHandler(_req, res) {
    try {
      if (typeof repository.findDraftEligibleCaptures !== "function") {
        const error = new Error("Draft-eligible capture reader is unavailable.");
        error.statusCode = 503;
        error.code = "TINDER_DRAFT_FOUNDATION_NOT_READY";
        throw error;
      }
      const captures = normalizeDraftEligibleCaptureRecords(
        await repository.findDraftEligibleCaptures()
      );
      return res.status(200).json({ ok: true, captures });
    } catch (error) {
      if (isFoundationNotReadyError(error)) {
        const notReady = foundationNotReadyError();
        return res.status(notReady.statusCode).json({ ok: false, code: notReady.code, error: notReady.message });
      }
      const status = Number(error?.statusCode) || 500;
      if (status === 500) console.error("Tinder dashboard draft-eligible capture list failed.");
      return res.status(status).json({
        ok: false,
        code: error?.code || "TINDER_DRAFT_ELIGIBLE_CAPTURE_LIST_FAILED",
        error: status === 500
          ? "Tinder captures ready for a draft could not be loaded."
          : safeMessage(error, "Tinder captures ready for a draft could not be loaded.")
      });
    }
  };
}

function createTinderDashboardMappingHandler(pool, {
  createRepository = createPgTinderHumanMappingRepository,
  createService = createTinderHumanMappingService
} = {}) {
  const mappingService = createService(createRepository(pool));
  return async function tinderDashboardMappingHandler(req, res) {
    try {
      const input = assertMappingBody(req.body);
      const result = await mappingService.confirmMapping({
        captureId: normalizeCaptureId(req.params.captureId),
        ...input,
        actor: "marcel_dashboard"
      });
      if ([
        TINDER_IDENTITY_RESOLUTION_STATUS.CONFLICT,
        TINDER_IDENTITY_RESOLUTION_STATUS.NEEDS_HUMAN_MAPPING,
        TINDER_IDENTITY_RESOLUTION_STATUS.UNSAFE
      ].includes(result.status)) {
        return res.status(409).json({ ok: false, conflict: true, result });
      }
      return res.status(200).json({ ok: true, result });
    } catch (error) {
      if (isFoundationNotReadyError(error)) {
        const notReady = foundationNotReadyError();
        return res.status(notReady.statusCode).json({ ok: false, code: notReady.code, error: notReady.message });
      }
      const status = Number(error?.statusCode) || (error instanceof TinderHumanMappingError ? error.statusCode : 500);
      if (status === 500) console.error("Tinder human mapping failed.");
      return res.status(status).json({
        ok: false,
        code: error?.code || "TINDER_MAPPING_FAILED",
        error: status === 500 ? "Tinder mapping could not be saved." : safeMessage(error, "Tinder mapping could not be saved.")
      });
    }
  };
}

function createTinderDashboardConversationBindingHandler(pool, {
  createRepository = createPgChannelConversationBindingRepository,
  createService = createChannelConversationBindingService
} = {}) {
  const bindingService = createService(createRepository(pool));
  return async function tinderDashboardConversationBindingHandler(req, res) {
    try {
      const input = assertConversationBindingBody(req.body);
      const result = await bindingService.confirmBinding({
        captureId: normalizeCaptureId(req.params.captureId),
        ...input,
        actor: "marcel_dashboard"
      });
      if (result.status !== CHANNEL_CONVERSATION_BINDING_STATUS.CONFIRMED) {
        return res.status(409).json({ ok: false, conflict: true, result: { status: result.status } });
      }
      return res.status(200).json({
        ok: true,
        result: {
          status: result.status,
          contactId: result.contactId,
          idempotent: result.idempotent
        }
      });
    } catch (error) {
      if (isFoundationNotReadyError(error)) {
        const notReady = foundationNotReadyError();
        return res.status(notReady.statusCode).json({ ok: false, code: notReady.code, error: notReady.message });
      }
      const status = Number(error?.statusCode) || (error instanceof ChannelConversationBindingError ? error.statusCode : 500);
      if (status === 500) console.error("Tinder conversation binding failed.");
      return res.status(status).json({
        ok: false,
        code: error?.code || "TINDER_CONVERSATION_BINDING_FAILED",
        error: status === 500
          ? "Tinder conversation binding could not be saved."
          : safeMessage(error, "Tinder conversation binding could not be saved.")
      });
    }
  };
}

function createTinderDashboardHumanArmedBindingHandler(pool, {
  createRepository = createPgTinderHumanArmedConversationBindingRepository,
  createService = createTinderHumanArmedConversationBindingService
} = {}) {
  const bindingService = createService(createRepository(pool));
  return async function tinderDashboardHumanArmedBindingHandler(req, res) {
    try {
      const input = assertHumanArmedBindingBody(req.body);
      const result = await bindingService.armInitialCapture({
        captureId: normalizeCaptureId(req.params.captureId),
        ...input,
        actor: "marcel_dashboard"
      });
      const bounded = boundedHumanArmedBindingResult(result);
      if (bounded.status !== HUMAN_ARMED_CONVERSATION_STATUS.ARMED) {
        return res.status(409).json({ ok: false, conflict: true, result: bounded });
      }
      // Deliberately do not disclose a contact, binding, permit, command or
      // reference identifier. The device receives the one-shot permit only
      // through the protected signed command channel.
      return res.status(200).json({ ok: true, result: bounded });
    } catch (error) {
      if (isFoundationNotReadyError(error)) {
        const notReady = humanArmedBindingFoundationNotReadyError();
        return res.status(notReady.statusCode).json({ ok: false, code: notReady.code, error: notReady.message });
      }
      const status = Number(error?.statusCode)
        || (error instanceof TinderHumanArmedConversationBindingError ? error.statusCode : 500);
      if (status === 500) console.error("Tinder human-armed conversation binding failed.");
      return res.status(status).json({
        ok: false,
        code: error?.code || "TINDER_HUMAN_ARMED_BINDING_FAILED",
        error: status === 500
          ? "Tinder human-armed conversation binding could not be saved."
          : safeMessage(error, "Tinder human-armed conversation binding could not be saved.")
      });
    }
  };
}

function createTinderDashboardHumanArmedRearmHandler(pool, {
  createRepository = createPgTinderHumanArmedConversationBindingRepository,
  createService = createTinderHumanArmedConversationBindingService
} = {}) {
  const bindingService = createService(createRepository(pool));
  return async function tinderDashboardHumanArmedRearmHandler(req, res) {
    try {
      const input = assertHumanArmedRearmBody(req.body);
      const result = await bindingService.rearmExistingBinding({
        bindingId: normalizeBindingId(req.params.bindingId),
        ...input,
        actor: "marcel_dashboard"
      });
      const bounded = boundedHumanArmedBindingResult(result);
      if (bounded.status !== HUMAN_ARMED_CONVERSATION_STATUS.ARMED) {
        return res.status(409).json({ ok: false, conflict: true, result: bounded });
      }
      return res.status(200).json({ ok: true, result: bounded });
    } catch (error) {
      if (isFoundationNotReadyError(error)) {
        const notReady = humanArmedBindingFoundationNotReadyError();
        return res.status(notReady.statusCode).json({ ok: false, code: notReady.code, error: notReady.message });
      }
      const status = Number(error?.statusCode)
        || (error instanceof TinderHumanArmedConversationBindingError ? error.statusCode : 500);
      if (status === 500) console.error("Tinder human-armed conversation rearm failed.");
      return res.status(status).json({
        ok: false,
        code: error?.code || "TINDER_HUMAN_ARMED_REARM_FAILED",
        error: status === 500
          ? "Tinder human-armed conversation could not be rearmed."
          : safeMessage(error, "Tinder human-armed conversation could not be rearmed.")
      });
    }
  };
}

function createTinderDashboardHumanArmedBindingListHandler(pool, {
  createRepository = createPgTinderHumanArmedConversationBindingRepository,
  createService = createTinderHumanArmedConversationBindingService
} = {}) {
  const bindingService = createService(createRepository(pool));
  return async function tinderDashboardHumanArmedBindingListHandler(_req, res) {
    try {
      const bindings = normalizeHumanArmedBindingRecords(
        await bindingService.listHumanArmedBindingsForDashboard()
      );
      return res.status(200).json({ ok: true, bindings });
    } catch (error) {
      if (isFoundationNotReadyError(error)) {
        const notReady = humanArmedBindingFoundationNotReadyError();
        return res.status(notReady.statusCode).json({ ok: false, code: notReady.code, error: notReady.message });
      }
      const status = Number(error?.statusCode) || 500;
      if (status === 500) console.error("Tinder human-armed binding list failed.");
      return res.status(status).json({
        ok: false,
        code: error?.code || "TINDER_HUMAN_ARMED_BINDING_LIST_FAILED",
        error: status === 500
          ? "Tinder human-armed conversations could not be loaded."
          : safeMessage(error, "Tinder human-armed conversations could not be loaded.")
      });
    }
  };
}

function registerTinderCaptureRoutes({
  app,
  pool,
  dashboardApiReady,
  dashboardApiAuthorized,
  requireDeviceBridgeReady
}) {
  const listPendingCaptures = createTinderDashboardPendingCaptureListHandler(pool);
  const listDraftEligibleCaptures = createTinderDashboardDraftEligibleCaptureListHandler(pool);
  const readCapture = createTinderDashboardCaptureReadHandler(pool);
  const mapCapture = createTinderDashboardMappingHandler(pool);
  const bindCaptureConversation = createTinderDashboardConversationBindingHandler(pool);
  const armCaptureConversation = createTinderDashboardHumanArmedBindingHandler(pool);
  const rearmCaptureConversation = createTinderDashboardHumanArmedRearmHandler(pool);
  const listHumanArmedBindings = createTinderDashboardHumanArmedBindingListHandler(pool);
  const dashboard = (handler) => async (req, res) => {
    if (!dashboardApiReady(res)) return;
    if (!dashboardApiAuthorized(req)) return res.status(401).json({ ok: false, error: "Not authorized." });
    if (!requireDeviceBridgeReady(res)) return;
    return handler(req, res);
  };

  app.get("/dashboard-api/tinder/captures/pending", dashboard(listPendingCaptures));
  app.get("/dashboard-api/tinder/captures/draft-eligible", dashboard(listDraftEligibleCaptures));
  app.get("/dashboard-api/tinder/human-armed-conversation-bindings", dashboard(listHumanArmedBindings));
  app.get("/dashboard-api/tinder/captures/:captureId", dashboard(readCapture));
  app.post("/dashboard-api/tinder/captures/:captureId/mapping", dashboard(mapCapture));
  app.post("/dashboard-api/tinder/captures/:captureId/conversation-binding", dashboard(bindCaptureConversation));
  app.post("/dashboard-api/tinder/captures/:captureId/human-armed-binding", dashboard(armCaptureConversation));
  app.post("/dashboard-api/tinder/human-armed-conversation-bindings/:bindingId/rearm", dashboard(rearmCaptureConversation));
}

export {
  TINDER_CAPTURE_MAPPING_BODY_FIELDS,
  TINDER_CAPTURE_CONVERSATION_BINDING_BODY_FIELDS,
  TINDER_HUMAN_ARMED_BINDING_BODY_FIELDS,
  TINDER_HUMAN_ARMED_REARM_BODY_FIELDS,
  TINDER_HUMAN_ARMED_BINDING_LIST_LIMIT,
  assertConversationBindingBody,
  assertHumanArmedBindingBody,
  assertHumanArmedRearmBody,
  assertMappingBody,
  createTinderDashboardCaptureReadHandler,
  createTinderDashboardDraftEligibleCaptureListHandler,
  createTinderDashboardPendingCaptureListHandler,
  createTinderDashboardMappingHandler,
  createTinderDashboardConversationBindingHandler,
  createTinderDashboardHumanArmedBindingHandler,
  createTinderDashboardHumanArmedRearmHandler,
  createTinderDashboardHumanArmedBindingListHandler,
  isFoundationNotReadyError,
  normalizeBindingId,
  normalizeCaptureRecord,
  normalizeDraftEligibleCaptureRecords,
  normalizeHumanArmedBindingRecords,
  normalizePendingCaptureRecords,
  registerTinderCaptureRoutes
};
