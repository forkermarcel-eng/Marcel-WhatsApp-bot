import { isUuidV4 } from "./protocol-v1.js";
import {
  createPgTinderCaptureRepository,
  createTinderCaptureStore,
  TINDER_DRAFT_ELIGIBLE_CAPTURE_LIMIT,
  TINDER_PENDING_HUMAN_MAPPING_LIMIT
} from "../services/tinder-capture-store.js";
import {
  createPgTinderConversationProductReadRepository,
  createTinderConversationProductReadService,
  normalizeTinderConversationProductDetail,
  normalizeTinderConversationProductList
} from "../services/tinder-conversation-product-read.js";
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
import {
  TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
  TINDER_VISIBLE_CHAT_SYNC_REASON,
  TINDER_VISIBLE_CHAT_SYNC_STATUS,
  TinderVisibleChatSyncError,
  createPgTinderVisibleChatSyncRepository,
  createTinderVisibleChatSyncService
} from "../services/tinder-visible-chat-sync.js";
import {
  TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE,
  TINDER_OFFICIAL_APP_RESUME_REASON,
  TINDER_OFFICIAL_APP_RESUME_STATUS,
  TinderOfficialAppResumeError,
  createPgTinderOfficialAppResumeRepository,
  createTinderOfficialAppResumeService
} from "../services/tinder-official-app-resume.js";
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
const PUBLIC_VISIBLE_CHAT_SYNC_QUEUE_STATUSES = new Set([
  TINDER_VISIBLE_CHAT_SYNC_STATUS.QUEUED,
  TINDER_VISIBLE_CHAT_SYNC_STATUS.DEVICE_NOT_READY,
  TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_CONFLICT,
  TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE
]);
const PUBLIC_VISIBLE_CHAT_SYNC_REASONS = new Set(Object.values(TINDER_VISIBLE_CHAT_SYNC_REASON));
const PUBLIC_OFFICIAL_APP_RESUME_QUEUE_STATUSES = new Set([
  TINDER_OFFICIAL_APP_RESUME_STATUS.QUEUED,
  TINDER_OFFICIAL_APP_RESUME_STATUS.DEVICE_NOT_READY,
  TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_CONFLICT,
  TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_NOT_AVAILABLE
]);
const PUBLIC_OFFICIAL_APP_RESUME_REASONS = new Set(Object.values(TINDER_OFFICIAL_APP_RESUME_REASON));
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

function conversationProductReadNotReadyError() {
  return {
    statusCode: 503,
    code: "TINDER_CONVERSATION_PRODUCT_READ_NOT_READY",
    message: "Tinder conversation reader is not ready"
  };
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

/**
 * V4 has no dashboard-provided operation input. The URL capture context is
 * looked up server-side; an empty body prevents device, contact, thread, or
 * fingerprint injection from becoming a second targeting surface.
 */
function assertEmptyVisibleChatSyncBody(body) {
  if (body === undefined || body === null || exactKeys(body, [])) return;
  const error = new Error("Visible-chat sync request has unsupported fields.");
  error.statusCode = 400;
  error.code = "INVALID_TINDER_VISIBLE_CHAT_SYNC_REQUEST";
  throw error;
}

/**
 * The standard-launcher action has no browser-controlled target, package,
 * component, URI, device, command, expiry, thread, or identity input. The
 * selected capture context is the only server-side correlation handle.
 */
function assertEmptyOfficialAppResumeBody(body) {
  if (exactKeys(body, [])) return;
  const error = new Error("Official Tinder app resume request has unsupported fields.");
  error.statusCode = 400;
  error.code = "INVALID_TINDER_OFFICIAL_APP_RESUME_REQUEST";
  throw error;
}

function boundedVisibleChatSyncQueueResult(result) {
  const status = String(result?.status || "").trim().toUpperCase();
  const reasonCode = result?.reasonCode === undefined
    ? null
    : String(result.reasonCode || "").trim().toUpperCase();
  if (!PUBLIC_VISIBLE_CHAT_SYNC_QUEUE_STATUSES.has(status)
      || (reasonCode !== null && !PUBLIC_VISIBLE_CHAT_SYNC_REASONS.has(reasonCode))
      || (status === TINDER_VISIBLE_CHAT_SYNC_STATUS.QUEUED && reasonCode !== null)
      || (status !== TINDER_VISIBLE_CHAT_SYNC_STATUS.QUEUED && reasonCode === null)) {
    const error = new Error("Invalid visible-chat sync result.");
    error.statusCode = 500;
    error.code = "INVALID_TINDER_VISIBLE_CHAT_SYNC_RESULT";
    throw error;
  }
  return Object.freeze({
    command_type: TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
    status,
    ...(reasonCode === null ? {} : { reason_code: reasonCode })
  });
}

function boundedOfficialAppResumeQueueResult(result) {
  const status = String(result?.status || "").trim().toUpperCase();
  const reasonCode = result?.reasonCode === undefined
    ? null
    : String(result.reasonCode || "").trim().toUpperCase();
  if (!PUBLIC_OFFICIAL_APP_RESUME_QUEUE_STATUSES.has(status)
      || (reasonCode !== null && !PUBLIC_OFFICIAL_APP_RESUME_REASONS.has(reasonCode))
      || (status === TINDER_OFFICIAL_APP_RESUME_STATUS.QUEUED && reasonCode !== null)
      || (status !== TINDER_OFFICIAL_APP_RESUME_STATUS.QUEUED && reasonCode === null)) {
    const error = new Error("Invalid official Tinder app resume result.");
    error.statusCode = 500;
    error.code = "INVALID_TINDER_OFFICIAL_APP_RESUME_RESULT";
    throw error;
  }
  return Object.freeze({
    command_type: TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE,
    status,
    ...(reasonCode === null ? {} : { reason_code: reasonCode })
  });
}

/**
 * A dashboard user may only request the bounded V4 sync for the capture they
 * already selected in the existing capture context. The server alone derives
 * the device target, and the sync service re-locks/rechecks the confirmed
 * source capture before it writes the empty command and opaque permit.
 */
function createTinderDashboardVisibleChatSyncQueueHandler(pool, {
  createCaptureRepository = createPgTinderCaptureRepository,
  createCaptureStore = createTinderCaptureStore,
  createSyncRepository = createPgTinderVisibleChatSyncRepository,
  createSyncService = createTinderVisibleChatSyncService
} = {}) {
  const captureStore = createCaptureStore(createCaptureRepository(pool));
  const syncService = createSyncService(createSyncRepository(pool));
  return async function tinderDashboardVisibleChatSyncQueueHandler(req, res) {
    try {
      assertEmptyVisibleChatSyncBody(req.body);
      const captureId = normalizeCaptureId(req.params.captureId);
      const sourceCapture = await captureStore.getCapture(captureId);
      if (!sourceCapture) {
        const error = new Error("Capture was not found.");
        error.statusCode = 404;
        error.code = "CAPTURE_NOT_FOUND";
        throw error;
      }
      const capture = normalizeCaptureRecord(sourceCapture);
      // Keep the UI route fail-closed before creating a command. The sync
      // service repeats this condition in its locked transaction, including
      // the resolved-contact requirement that never reaches the dashboard.
      if (capture.mapping_status !== "RESOLVED" || capture.human_review_status !== "CONFIRMED") {
        return res.status(409).json({
          ok: false,
          conflict: true,
          sync: {
            command_type: TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
            status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
            reason_code: TINDER_VISIBLE_CHAT_SYNC_REASON.SOURCE_CAPTURE_NOT_CONFIRMED
          }
        });
      }
      const sync = boundedVisibleChatSyncQueueResult(await syncService.queueVisibleChatSync({
        deviceId: capture.device_id,
        sourceCaptureId: capture.capture_id
      }));
      if (sync.status !== TINDER_VISIBLE_CHAT_SYNC_STATUS.QUEUED) {
        return res.status(409).json({ ok: false, conflict: true, sync });
      }
      // The command UUID remains private to the signed Device-Bridge channel.
      // `command_type` + status is the bounded dashboard correlation only.
      return res.status(202).json({ ok: true, sync });
    } catch (error) {
      if (isFoundationNotReadyError(error)) {
        return res.status(503).json({
          ok: false,
          code: "TINDER_VISIBLE_CHAT_SYNC_FOUNDATION_NOT_READY",
          error: "Tinder visible-chat sync foundation is not ready."
        });
      }
      const status = Number(error?.statusCode)
        || (error instanceof TinderVisibleChatSyncError ? error.statusCode : 500);
      if (status === 500) console.error("Tinder visible-chat sync queue failed.");
      // Intentionally do not reflect messages from capture, database, or
      // command layers: every error response remains bounded and contentless.
      return res.status(status).json({
        ok: false,
        code: status === 400 && error?.code === "INVALID_CAPTURE_ID"
          ? "INVALID_CAPTURE_ID"
          : status === 400 && error?.code === "INVALID_TINDER_VISIBLE_CHAT_SYNC_REQUEST"
            ? "INVALID_TINDER_VISIBLE_CHAT_SYNC_REQUEST"
            : status === 404 && error?.code === "CAPTURE_NOT_FOUND"
              ? "CAPTURE_NOT_FOUND"
              : "TINDER_VISIBLE_CHAT_SYNC_QUEUE_FAILED",
        error: "Tinder visible-chat sync could not be queued."
      });
    }
  };
}

/**
 * This is the only dashboard path which may queue a one-shot standard Tinder
 * launcher command. It is intentionally not a general Android-launch or
 * Tinder-navigation route: source capture and device are derived server-side,
 * while Android receives exactly an empty payload.
 */
function createTinderDashboardOfficialAppResumeQueueHandler(pool, {
  createCaptureRepository = createPgTinderCaptureRepository,
  createCaptureStore = createTinderCaptureStore,
  createResumeRepository = createPgTinderOfficialAppResumeRepository,
  createResumeService = createTinderOfficialAppResumeService
} = {}) {
  const captureStore = createCaptureStore(createCaptureRepository(pool));
  const resumeService = createResumeService(createResumeRepository(pool));
  return async function tinderDashboardOfficialAppResumeQueueHandler(req, res) {
    try {
      assertEmptyOfficialAppResumeBody(req.body);
      const captureId = normalizeCaptureId(req.params.captureId);
      const sourceCapture = await captureStore.getCapture(captureId);
      if (!sourceCapture) {
        const error = new Error("Capture was not found.");
        error.statusCode = 404;
        error.code = "CAPTURE_NOT_FOUND";
        throw error;
      }
      const capture = normalizeCaptureRecord(sourceCapture);
      if (capture.mapping_status !== "RESOLVED" || capture.human_review_status !== "CONFIRMED") {
        return res.status(409).json({
          ok: false,
          conflict: true,
          resume: {
            command_type: TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE,
            status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_NOT_AVAILABLE,
            reason_code: TINDER_OFFICIAL_APP_RESUME_REASON.SOURCE_CAPTURE_NOT_CONFIRMED
          }
        });
      }
      const resume = boundedOfficialAppResumeQueueResult(await resumeService.queueOfficialAppResume({
        deviceId: capture.device_id,
        sourceCaptureId: capture.capture_id
      }));
      if (resume.status !== TINDER_OFFICIAL_APP_RESUME_STATUS.QUEUED) {
        return res.status(409).json({ ok: false, conflict: true, resume });
      }
      // The device-bridge command identifier never becomes a dashboard/API
      // input or output. The signed command path alone receives it.
      return res.status(202).json({ ok: true, resume });
    } catch (error) {
      if (isFoundationNotReadyError(error)) {
        return res.status(503).json({
          ok: false,
          code: "TINDER_OFFICIAL_APP_RESUME_FOUNDATION_NOT_READY",
          error: "Official Tinder app resume foundation is not ready."
        });
      }
      const status = Number(error?.statusCode)
        || (error instanceof TinderOfficialAppResumeError ? error.statusCode : 500);
      if (status === 500) console.error("Official Tinder app resume queue failed.");
      return res.status(status).json({
        ok: false,
        code: status === 400 && error?.code === "INVALID_CAPTURE_ID"
          ? "INVALID_CAPTURE_ID"
          : status === 400 && error?.code === "INVALID_TINDER_OFFICIAL_APP_RESUME_REQUEST"
            ? "INVALID_TINDER_OFFICIAL_APP_RESUME_REQUEST"
            : status === 404 && error?.code === "CAPTURE_NOT_FOUND"
              ? "CAPTURE_NOT_FOUND"
              : "TINDER_OFFICIAL_APP_RESUME_QUEUE_FAILED",
        error: "Official Tinder app resume could not be queued."
      });
    }
  };
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

/**
 * This product reader is deliberately separate from the legacy capture detail
 * route above.  The latter remains a redacted mapping context; this one is the
 * only dashboard read surface allowed to project confirmed conversation text.
 */
function createTinderDashboardLatestConfirmedConversationListHandler(pool, {
  createRepository = createPgTinderConversationProductReadRepository,
  createService = createTinderConversationProductReadService
} = {}) {
  const conversationReader = createService(createRepository(pool));
  return async function tinderDashboardLatestConfirmedConversationListHandler(_req, res) {
    try {
      const conversations = normalizeTinderConversationProductList(
        await conversationReader.listLatestConfirmedConversations()
      );
      return res.status(200).json({ ok: true, conversations });
    } catch (error) {
      if (isFoundationNotReadyError(error)) {
        const notReady = conversationProductReadNotReadyError();
        return res.status(notReady.statusCode).json({ ok: false, code: notReady.code, error: notReady.message });
      }
      const status = Number(error?.statusCode) || 500;
      if (status === 500) console.error("Tinder dashboard latest conversation list failed.");
      return res.status(status).json({
        ok: false,
        code: error?.code || "TINDER_CONVERSATION_LIST_FAILED",
        error: status === 500
          ? "Tinder conversations could not be loaded."
          : safeMessage(error, "Tinder conversations could not be loaded.")
      });
    }
  };
}

function createTinderDashboardLatestConfirmedConversationReadHandler(pool, {
  createRepository = createPgTinderConversationProductReadRepository,
  createService = createTinderConversationProductReadService
} = {}) {
  const conversationReader = createService(createRepository(pool));
  return async function tinderDashboardLatestConfirmedConversationReadHandler(req, res) {
    try {
      const conversation = await conversationReader.getLatestConfirmedConversation(
        normalizeCaptureId(req.params.captureId)
      );
      if (!conversation) {
        const error = new Error("Tinder conversation was not found.");
        error.statusCode = 404;
        error.code = "TINDER_CONVERSATION_NOT_FOUND";
        throw error;
      }
      return res.status(200).json({ ok: true, conversation: normalizeTinderConversationProductDetail(conversation) });
    } catch (error) {
      if (isFoundationNotReadyError(error)) {
        const notReady = conversationProductReadNotReadyError();
        return res.status(notReady.statusCode).json({ ok: false, code: notReady.code, error: notReady.message });
      }
      const status = Number(error?.statusCode) || 500;
      if (status === 500) console.error("Tinder dashboard latest conversation read failed.");
      return res.status(status).json({
        ok: false,
        code: error?.code || "TINDER_CONVERSATION_READ_FAILED",
        error: status === 500
          ? "Tinder conversation could not be loaded."
          : safeMessage(error, "Tinder conversation could not be loaded.")
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
  const listLatestConfirmedConversations = createTinderDashboardLatestConfirmedConversationListHandler(pool);
  const readLatestConfirmedConversation = createTinderDashboardLatestConfirmedConversationReadHandler(pool);
  const readCapture = createTinderDashboardCaptureReadHandler(pool);
  const mapCapture = createTinderDashboardMappingHandler(pool);
  const bindCaptureConversation = createTinderDashboardConversationBindingHandler(pool);
  const armCaptureConversation = createTinderDashboardHumanArmedBindingHandler(pool);
  const rearmCaptureConversation = createTinderDashboardHumanArmedRearmHandler(pool);
  const listHumanArmedBindings = createTinderDashboardHumanArmedBindingListHandler(pool);
  const queueVisibleChatSync = createTinderDashboardVisibleChatSyncQueueHandler(pool);
  const queueOfficialAppResume = createTinderDashboardOfficialAppResumeQueueHandler(pool);
  const dashboard = (handler) => async (req, res) => {
    if (!dashboardApiReady(res)) return;
    if (!dashboardApiAuthorized(req)) return res.status(401).json({ ok: false, error: "Not authorized." });
    if (!requireDeviceBridgeReady(res)) return;
    return handler(req, res);
  };

  app.get("/dashboard-api/tinder/captures/pending", dashboard(listPendingCaptures));
  app.get("/dashboard-api/tinder/captures/draft-eligible", dashboard(listDraftEligibleCaptures));
  app.get("/dashboard-api/tinder/conversations/latest-confirmed", dashboard(listLatestConfirmedConversations));
  app.get("/dashboard-api/tinder/conversations/:captureId", dashboard(readLatestConfirmedConversation));
  app.get("/dashboard-api/tinder/human-armed-conversation-bindings", dashboard(listHumanArmedBindings));
  app.get("/dashboard-api/tinder/captures/:captureId", dashboard(readCapture));
  app.post("/dashboard-api/tinder/captures/:captureId/mapping", dashboard(mapCapture));
  app.post("/dashboard-api/tinder/captures/:captureId/conversation-binding", dashboard(bindCaptureConversation));
  app.post("/dashboard-api/tinder/captures/:captureId/human-armed-binding", dashboard(armCaptureConversation));
  app.post("/dashboard-api/tinder/captures/:captureId/visible-chat-sync", dashboard(queueVisibleChatSync));
  app.post("/dashboard-api/tinder/captures/:captureId/resume-official-app", dashboard(queueOfficialAppResume));
  app.post("/dashboard-api/tinder/human-armed-conversation-bindings/:bindingId/rearm", dashboard(rearmCaptureConversation));
}

export {
  TINDER_CAPTURE_MAPPING_BODY_FIELDS,
  TINDER_CAPTURE_CONVERSATION_BINDING_BODY_FIELDS,
  TINDER_HUMAN_ARMED_BINDING_BODY_FIELDS,
  TINDER_HUMAN_ARMED_REARM_BODY_FIELDS,
  TINDER_HUMAN_ARMED_BINDING_LIST_LIMIT,
  assertConversationBindingBody,
  assertEmptyVisibleChatSyncBody,
  assertHumanArmedBindingBody,
  assertHumanArmedRearmBody,
  assertMappingBody,
  createTinderDashboardCaptureReadHandler,
  createTinderDashboardDraftEligibleCaptureListHandler,
  createTinderDashboardLatestConfirmedConversationListHandler,
  createTinderDashboardLatestConfirmedConversationReadHandler,
  createTinderDashboardPendingCaptureListHandler,
  createTinderDashboardMappingHandler,
  createTinderDashboardConversationBindingHandler,
  createTinderDashboardVisibleChatSyncQueueHandler,
  createTinderDashboardOfficialAppResumeQueueHandler,
  createTinderDashboardHumanArmedBindingHandler,
  createTinderDashboardHumanArmedRearmHandler,
  createTinderDashboardHumanArmedBindingListHandler,
  isFoundationNotReadyError,
  normalizeBindingId,
  boundedVisibleChatSyncQueueResult,
  normalizeCaptureRecord,
  assertEmptyOfficialAppResumeBody,
  boundedOfficialAppResumeQueueResult,
  normalizeDraftEligibleCaptureRecords,
  normalizeHumanArmedBindingRecords,
  normalizePendingCaptureRecords,
  registerTinderCaptureRoutes
};
