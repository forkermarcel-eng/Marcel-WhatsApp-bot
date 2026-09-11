import crypto from "crypto";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAPPING_FIELDS = new Set([
  "action",
  "contact_id",
  "new_contact_name",
  "tinder_identifier",
  "confirmed"
]);
const CONVERSATION_BINDING_FIELDS = new Set([
  "action",
  "contact_id",
  "new_contact_name",
  "confirmed"
]);
const HUMAN_ARMED_BINDING_FIELDS = new Set([
  "action",
  "contact_id",
  "new_contact_name",
  "confirmed"
]);
const HUMAN_ARMED_REARM_FIELDS = new Set(["confirmed"]);
const HUMAN_ARMED_VISIBLE_CHAT_SYNC_FIELDS = new Set(["confirmed"]);
const HUMAN_ARMED_LOCAL_CONVERSATION_ATTESTATION_FIELDS = new Set(["confirmed"]);
const PUBLIC_CAPTURE_MAPPING_STATUSES = new Set(["NEEDS_HUMAN_MAPPING", "RESOLVED", "CONFLICT"]);
const PUBLIC_CAPTURE_REVIEW_STATUSES = new Set(["PENDING", "CONFIRMED", "REJECTED"]);
const PUBLIC_MAPPING_SUCCESS_STATUSES = new Set(["RESOLVED", "NEW_CONTACT_CONFIRMED"]);
const PUBLIC_MAPPING_ERROR_STATUSES = new Set(["CONFLICT", "NEEDS_HUMAN_MAPPING", "UNSAFE"]);
const PUBLIC_CONVERSATION_BINDING_STATUSES = new Set([
  "LEGACY_CAPTURE",
  "FOUNDATION_NOT_READY",
  "AWAITING_STABILITY_EVIDENCE",
  "ELIGIBLE_FOR_HUMAN_BINDING",
  "CONFIRMED",
  "CONFLICT",
  "UNSAFE"
]);
const PUBLIC_CONVERSATION_BINDING_SUCCESS_STATUSES = new Set(["CONFIRMED"]);
const PUBLIC_CONVERSATION_BINDING_ERROR_STATUSES = new Set([
  "LEGACY_CAPTURE",
  "FOUNDATION_NOT_READY",
  "AWAITING_STABILITY_EVIDENCE",
  "CONFLICT",
  "UNSAFE"
]);
const PUBLIC_HUMAN_ARMED_BINDING_SUCCESS_STATUSES = new Set(["ARMED"]);
const PUBLIC_HUMAN_ARMED_BINDING_ERROR_STATUSES = new Set([
  "UNSAFE_CAPTURE",
  "PENDING_CAPTURE_REQUIRED",
  "DEVICE_NOT_READY",
  "BINDING_NOT_READY",
  "PERMIT_NOT_AVAILABLE",
  "CONFLICT"
]);
const PUBLIC_LOCAL_CONVERSATION_ATTESTATION_DASHBOARD_STATUSES = new Set([
  "NOT_REQUESTED", "PENDING", "ATTESTED", "INVALIDATED"
]);
const PUBLIC_LOCAL_CONVERSATION_READER_STATUSES = new Set([
  "NOT_REQUESTED", "READER_QUEUED"
]);
const PENDING_CAPTURE_VIEW = "pending";
const PENDING_CAPTURE_LIMIT = 25;
const DRAFT_ELIGIBLE_CAPTURE_VIEW = "draft-eligible";
const DRAFT_ELIGIBLE_CAPTURE_LIMIT = 25;
const HUMAN_ARMED_BINDINGS_VIEW = "human-armed-bindings";
const HUMAN_ARMED_BINDING_LIMIT = 25;
const HUMAN_ARM_OPERATION = "human-arm";
const HUMAN_REARM_OPERATION = "human-rearm";
const HUMAN_ARMED_VISIBLE_CHAT_SYNC_OPERATION = "human-armed-visible-chat-sync";
const HUMAN_ARMED_LOCAL_CONVERSATION_ATTESTATION_OPERATION =
  "human-armed-local-conversation-attestation";
const DRAFT_OPERATION = "draft";
const PUBLIC_DRAFT_STATUS = "DRAFT";
const DRAFT_REVIEW_VIEW = "draft-review";
const OPEN_DRAFT_REVIEWS_VIEW = "open-draft-reviews";
const OPEN_DRAFT_REVIEW_LIMIT = 25;
// These remain on the existing captures proxy so the selected-detail reader
// does not consume another Vercel Serverless Function slot.
const CONFIRMED_CONVERSATIONS_VIEW = "confirmed-conversations";
const CONFIRMED_CONVERSATION_VIEW = "confirmed-conversation";
const VISIBLE_CHAT_SYNC_OPERATION = "visible-chat-sync";
const OFFICIAL_APP_RESUME_OPERATION = "resume-official-app";
const LATEST_CONFIRMED_CONVERSATION_LIMIT = 25;
const CONVERSATION_MESSAGE_LIMIT = 100;
const CONVERSATION_MESSAGE_TEXT_LIMIT = 4096;
const CONVERSATION_MESSAGE_DIRECTIONS = new Set(["INCOMING", "OUTGOING", "UNKNOWN"]);
const PUBLIC_VISIBLE_CHAT_SYNC_COMMAND_TYPE = "SYNC_TINDER_VISIBLE_CHAT";
const PUBLIC_VISIBLE_CHAT_SYNC_STATUSES = new Set([
  "QUEUED", "DEVICE_NOT_READY", "PERMIT_CONFLICT", "PERMIT_NOT_AVAILABLE"
]);
const PUBLIC_VISIBLE_CHAT_SYNC_REASONS = new Set([
  "DEVICE_OFFLINE",
  "DEVICE_ENROLLMENT_INACTIVE",
  "BRIDGE_NOT_RUNNING",
  "TINDER_NOT_CONNECTED",
  "AUTOMATION_NOT_STOPPED",
  "DEVICE_CAPABILITY_UNSUPPORTED",
  "HUMAN_ARMED_PERMIT_ACTIVE",
  "SYNC_PERMIT_ACTIVE",
  "OFFICIAL_APP_RESUME_PERMIT_ACTIVE",
  "PERMIT_NOT_FOUND",
  "PERMIT_ALREADY_CONSUMED",
  "PERMIT_NOT_STAGED",
  "PERMIT_EXPIRED",
  "PERMIT_ACK_NOT_STAGED",
  "PERMIT_DEVICE_MISMATCH",
  "SOURCE_CAPTURE_NOT_CONFIRMED",
  "HUMAN_ARMED_BINDING_NOT_CONFIRMED",
  "LOCAL_CONVERSATION_ATTESTATION_REQUIRED",
  "LOCAL_CONVERSATION_ATTESTATION_NOT_ATTESTED",
  "LOCAL_CONVERSATION_ATTESTATION_INVALID"
]);
const PUBLIC_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE =
  "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION";
const PUBLIC_LOCAL_CONVERSATION_ATTESTATION_STATUSES = new Set([
  "QUEUED", "DEVICE_NOT_READY", "PERMIT_CONFLICT", "PERMIT_NOT_AVAILABLE"
]);
const PUBLIC_LOCAL_CONVERSATION_ATTESTATION_REASONS = new Set([
  "DEVICE_OFFLINE",
  "DEVICE_ENROLLMENT_INACTIVE",
  "BRIDGE_NOT_RUNNING",
  "TINDER_NOT_CONNECTED",
  "AUTOMATION_NOT_STOPPED",
  "DEVICE_CAPABILITY_UNSUPPORTED",
  "HUMAN_ARMED_PERMIT_ACTIVE",
  "VISIBLE_CHAT_SYNC_PERMIT_ACTIVE",
  "OFFICIAL_APP_RESUME_PERMIT_ACTIVE",
  "ATTESTATION_ACTIVE",
  "LOCAL_CONVERSATION_ATTESTATION_DEVICE_BUSY",
  "BINDING_NOT_FOUND",
  "BINDING_NOT_CONFIRMED",
  "BINDING_NOT_HUMAN_VERIFIED",
  "BINDING_DEVICE_INVALID",
  "BINDING_REVISION_CHANGED",
  "PERMIT_NOT_FOUND",
  "PERMIT_NOT_STAGED",
  "PERMIT_EXPIRED",
  "PERMIT_ACK_NOT_STAGED",
  "PERMIT_DEVICE_MISMATCH",
  "PERMIT_BINDING_MISMATCH",
  "READER_QUEUE_NOT_AVAILABLE",
  "INVALIDATION_NOT_ALLOWED"
]);
const PUBLIC_OFFICIAL_APP_RESUME_COMMAND_TYPE = "RESUME_OFFICIAL_TINDER_APP";
const PUBLIC_OFFICIAL_APP_RESUME_STATUSES = new Set([
  "QUEUED", "DEVICE_NOT_READY", "PERMIT_CONFLICT", "PERMIT_NOT_AVAILABLE"
]);
const PUBLIC_OFFICIAL_APP_RESUME_REASONS = new Set([
  "DEVICE_OFFLINE",
  "DEVICE_ENROLLMENT_INACTIVE",
  "BRIDGE_NOT_RUNNING",
  "TINDER_NOT_CONNECTED",
  "AUTOMATION_NOT_STOPPED",
  "DEVICE_CAPABILITY_UNSUPPORTED",
  "HUMAN_ARMED_PERMIT_ACTIVE",
  "VISIBLE_CHAT_SYNC_PERMIT_ACTIVE",
  "RESUME_PERMIT_ACTIVE",
  "SOURCE_CAPTURE_NOT_CONFIRMED",
  "SOURCE_CAPTURE_ALREADY_USED"
]);
const PUBLIC_OFFICIAL_APP_RESUME_OBSERVATION_STATUSES = new Set([
  "NOT_REQUESTED", "PENDING", "DISPATCHED", "CANCELLED", "EXPIRED"
]);
const PUBLIC_OPEN_DRAFT_REVIEW_STATUSES = new Set(["DRAFT", "APPROVED", "STALE"]);
const DRAFT_APPROVE_OPERATION = "draft-approve";
const DRAFT_REJECT_OPERATION = "draft-reject";
const DRAFT_CANCEL_OPERATION = "draft-cancel";
const PUBLIC_DRAFT_REVIEW_STATUSES = new Set(["DRAFT", "APPROVED", "REJECTED", "STALE"]);
const PUBLIC_DRAFT_APPROVAL_STATES = new Set(["ACTIVE", "INVALIDATED", "CANCELLED"]);
const PUBLIC_DRAFT_INTENT_STATES = new Set([
  "PENDING_T5_WRITER", "DISPATCHING", "SENT", "FAILED", "STALE", "CANCELLED", "SEND_RESULT_UNKNOWN"
]);

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";").map((cookie) => cookie.trim());
  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex !== -1 && cookie.slice(0, separatorIndex) === name) {
      return cookie.slice(separatorIndex + 1);
    }
  }
  return null;
}

function validDashboardSession(req) {
  const password = process.env.DASHBOARD_PASSWORD;
  const session = getCookie(req, "marcel_dashboard_session");
  if (!password || !session) return false;
  const parts = session.split(".");
  if (parts.length !== 2) return false;
  const [token, receivedSignature] = parts;
  if (!token || !receivedSignature) return false;
  const expectedSignature = crypto.createHmac("sha256", password).update(token).digest("hex");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const receivedBuffer = Buffer.from(receivedSignature, "utf8");
  return expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function backendConfiguration(res) {
  const railwayBackendUrl = String(process.env.RAILWAY_BACKEND_URL || "").trim().replace(/\/+$/, "");
  const dashboardApiSecret = String(process.env.DASHBOARD_API_SECRET || "").trim();
  if (!railwayBackendUrl || !dashboardApiSecret) {
    res.status(500).json({ ok: false, error: "Dashboard-Verbindung ist nicht konfiguriert." });
    return null;
  }
  return { railwayBackendUrl, dashboardApiSecret };
}

function validCaptureId(value) {
  return typeof value === "string" && UUID_V4.test(value);
}

function normalizePublicTimestamp(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? undefined : timestamp.toISOString();
}

function normalizePublicCapture(value, captureId) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.capture_id !== captureId || !validCaptureId(value.capture_id) ||
      !validCaptureId(value.device_id) || !Number.isInteger(value.capture_revision) ||
      value.capture_revision < 1 || !PUBLIC_CAPTURE_MAPPING_STATUSES.has(value.mapping_status) ||
      !PUBLIC_CAPTURE_REVIEW_STATUSES.has(value.human_review_status) ||
      typeof value.visible_name !== "string" || !value.visible_name.trim() ||
      value.visible_name.trim().length > 240 || value.source_package !== "com.tinder") {
    return null;
  }
  const capturedAt = normalizePublicTimestamp(value.captured_at);
  const receivedAt = normalizePublicTimestamp(value.received_at);
  if (capturedAt === undefined || receivedAt === undefined) return null;
  const conversationBindingStatus = value.conversation_binding_status === undefined
    ? null
    : String(value.conversation_binding_status || "").trim().toUpperCase();
  if (conversationBindingStatus !== null
      && !PUBLIC_CONVERSATION_BINDING_STATUSES.has(conversationBindingStatus)) return null;

  return Object.freeze({
    capture_id: value.capture_id,
    device_id: value.device_id,
    capture_revision: value.capture_revision,
    mapping_status: value.mapping_status,
    human_review_status: value.human_review_status,
    visible_name: value.visible_name.trim(),
    source_package: value.source_package,
    captured_at: capturedAt,
    received_at: receivedAt,
    ...(conversationBindingStatus === null
      ? {}
      : { conversation_binding_status: conversationBindingStatus })
  });
}

function validPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validBoundedText(value, maximum) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum;
}

function normalizePublicDraft(value, captureId) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.capture_id !== captureId || !validCaptureId(value.capture_id) ||
      !validCaptureId(value.draft_id) || value.status !== PUBLIC_DRAFT_STATUS ||
      !validPositiveInteger(value.capture_revision) ||
      !validPositiveInteger(value.identity_revision) ||
      !validBoundedText(value.original_draft, 8000) ||
      !validBoundedText(value.model_version, 160)) {
    return null;
  }
  const createdAt = normalizePublicTimestamp(value.created_at);
  const sourceLanguage = value.source_language === null || value.source_language === undefined
    ? null
    : validBoundedText(value.source_language, 32) ? value.source_language.trim() : undefined;
  const controlDraftDe = value.control_draft_de === null || value.control_draft_de === undefined
    ? null
    : validBoundedText(value.control_draft_de, 8000) ? value.control_draft_de.trim() : undefined;
  if (createdAt === undefined || sourceLanguage === undefined || controlDraftDe === undefined) return null;
  return Object.freeze({
    draft_id: value.draft_id,
    capture_id: value.capture_id,
    capture_revision: value.capture_revision,
    identity_revision: value.identity_revision,
    status: PUBLIC_DRAFT_STATUS,
    original_draft: value.original_draft.trim(),
    control_draft_de: controlDraftDe,
    source_language: sourceLanguage,
    model_version: value.model_version.trim(),
    created_at: createdAt
  });
}

function normalizePublicDraftReview(value, captureId) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value.captureId !== captureId || !validCaptureId(value.captureId) ||
      !validCaptureId(value.draftId) || !validPositiveInteger(value.draftRevision) ||
      !validPositiveInteger(value.captureRevision) || !validPositiveInteger(value.identityRevision) ||
      !PUBLIC_DRAFT_REVIEW_STATUSES.has(value.status) ||
      !(value.approvalState === null || value.approvalState === undefined || PUBLIC_DRAFT_APPROVAL_STATES.has(value.approvalState)) ||
      !(value.intentState === null || value.intentState === undefined || PUBLIC_DRAFT_INTENT_STATES.has(value.intentState)) ||
      !validBoundedText(value.originalDraft, 8000) ||
      !validBoundedText(value.modelVersion, 160)) {
    return null;
  }
  const createdAt = normalizePublicTimestamp(value.createdAt);
  const sourceLanguage = value.sourceLanguage === null || value.sourceLanguage === undefined
    ? null
    : validBoundedText(value.sourceLanguage, 32) ? value.sourceLanguage.trim() : undefined;
  const controlDraftDe = value.controlDraftDe === null || value.controlDraftDe === undefined
    ? null
    : validBoundedText(value.controlDraftDe, 8000) ? value.controlDraftDe.trim() : undefined;
  if (createdAt === undefined || sourceLanguage === undefined || controlDraftDe === undefined) return null;
  return Object.freeze({
    draft_id: value.draftId,
    capture_id: value.captureId,
    draft_revision: value.draftRevision,
    capture_revision: value.captureRevision,
    identity_revision: value.identityRevision,
    status: value.status,
    approval_state: value.approvalState ?? null,
    intent_state: value.intentState ?? null,
    original_draft: value.originalDraft.trim(),
    control_draft_de: controlDraftDe,
    source_language: sourceLanguage,
    model_version: value.modelVersion.trim(),
    created_at: createdAt
  });
}

function normalizePublicOpenDraftReview(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !validCaptureId(value.captureId) || !validBoundedText(value.visibleName, 240) ||
      !PUBLIC_OPEN_DRAFT_REVIEW_STATUSES.has(value.status)) {
    return null;
  }
  return Object.freeze({
    capture_id: value.captureId,
    visible_name: value.visibleName.trim(),
    status: value.status
  });
}

function normalizePublicOpenDraftReviews(value) {
  if (!Array.isArray(value) || value.length > OPEN_DRAFT_REVIEW_LIMIT) return null;
  const reviews = value.map(normalizePublicOpenDraftReview);
  return reviews.some((review) => review === null) ? null : Object.freeze(reviews);
}

function normalizePublicMappingResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !PUBLIC_MAPPING_SUCCESS_STATUSES.has(value.status) ||
      !validPositiveInteger(value.contactId) || typeof value.idempotent !== "boolean") {
    return null;
  }
  return Object.freeze({
    status: value.status,
    contactId: value.contactId,
    idempotent: value.idempotent
  });
}

function normalizePublicMappingErrorResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !PUBLIC_MAPPING_ERROR_STATUSES.has(value.status)) {
    return null;
  }
  const result = { status: value.status };
  if (value.status === "CONFLICT" &&
      typeof value.conflictCode === "string" && /^[A-Z0-9_]{1,120}$/.test(value.conflictCode)) {
    result.conflictCode = value.conflictCode;
  }
  if (validPositiveInteger(value.preservedContactId)) {
    result.preservedContactId = value.preservedContactId;
  }
  return Object.freeze(result);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function captureRequestFromQuery(req) {
  const query = req.query || {};
  if (exactKeys(query, ["captureId", "view"]) && validCaptureId(query.captureId)
      && query.view === CONFIRMED_CONVERSATION_VIEW) {
    return Object.freeze({ type: "confirmed_conversation", captureId: query.captureId });
  }
  if (exactKeys(query, ["view"]) && query.view === CONFIRMED_CONVERSATIONS_VIEW) {
    return Object.freeze({ type: "confirmed_conversations" });
  }
  if (exactKeys(query, ["captureId", "view"]) && validCaptureId(query.captureId)
      && query.view === DRAFT_REVIEW_VIEW) {
    return Object.freeze({ type: "draft_review", captureId: query.captureId });
  }
  if (exactKeys(query, ["view"]) && query.view === OPEN_DRAFT_REVIEWS_VIEW) {
    return Object.freeze({ type: "open_draft_reviews" });
  }
  if (exactKeys(query, ["view"]) && query.view === DRAFT_ELIGIBLE_CAPTURE_VIEW) {
    return Object.freeze({ type: "draft_eligible" });
  }
  if (exactKeys(query, ["captureId", "operation"]) && validCaptureId(query.captureId)
      && query.operation === DRAFT_OPERATION) {
    return Object.freeze({ type: "draft", captureId: query.captureId });
  }
  if (exactKeys(query, ["captureId", "operation"]) && validCaptureId(query.captureId)
      && query.operation === DRAFT_APPROVE_OPERATION) {
    return Object.freeze({ type: "draft_approve", captureId: query.captureId });
  }
  if (exactKeys(query, ["captureId", "operation"]) && validCaptureId(query.captureId)
      && query.operation === DRAFT_REJECT_OPERATION) {
    return Object.freeze({ type: "draft_reject", captureId: query.captureId });
  }
  if (exactKeys(query, ["captureId", "operation"]) && validCaptureId(query.captureId)
      && query.operation === DRAFT_CANCEL_OPERATION) {
    return Object.freeze({ type: "draft_cancel", captureId: query.captureId });
  }
  if (exactKeys(query, ["captureId", "operation"]) && validCaptureId(query.captureId)
      && query.operation === VISIBLE_CHAT_SYNC_OPERATION) {
    return Object.freeze({ type: "visible_chat_sync", captureId: query.captureId });
  }
  if (exactKeys(query, ["captureId", "operation"]) && validCaptureId(query.captureId)
      && query.operation === OFFICIAL_APP_RESUME_OPERATION) {
    return Object.freeze({ type: "official_app_resume", captureId: query.captureId });
  }
  if (exactKeys(query, ["captureId", "operation"]) && validCaptureId(query.captureId)
      && query.operation === HUMAN_ARM_OPERATION) {
    return Object.freeze({ type: "human_arm", captureId: query.captureId });
  }
  if (exactKeys(query, ["bindingId", "operation"]) && validCaptureId(query.bindingId)
      && query.operation === HUMAN_REARM_OPERATION) {
    return Object.freeze({ type: "human_rearm", bindingId: query.bindingId });
  }
  if (exactKeys(query, ["bindingId", "operation"]) && validCaptureId(query.bindingId)
      && query.operation === HUMAN_ARMED_VISIBLE_CHAT_SYNC_OPERATION) {
    return Object.freeze({ type: "human_armed_visible_chat_sync", bindingId: query.bindingId });
  }
  if (exactKeys(query, ["bindingId", "operation"]) && validCaptureId(query.bindingId)
      && query.operation === HUMAN_ARMED_LOCAL_CONVERSATION_ATTESTATION_OPERATION) {
    return Object.freeze({ type: "human_armed_local_conversation_attestation", bindingId: query.bindingId });
  }
  if (exactKeys(query, ["captureId"]) && validCaptureId(query.captureId)) {
    return Object.freeze({ type: "capture", captureId: query.captureId });
  }
  if (exactKeys(query, ["view"]) && query.view === PENDING_CAPTURE_VIEW) {
    return Object.freeze({ type: "pending" });
  }
  if (exactKeys(query, ["view"]) && query.view === HUMAN_ARMED_BINDINGS_VIEW) {
    return Object.freeze({ type: "human_armed_bindings" });
  }
  return null;
}

function validMappingBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((field) => !MAPPING_FIELDS.has(field))) {
    return false;
  }
  const action = String(body.action || "").trim().toUpperCase();
  if (body.confirmed !== true) return false;
  if (action === "MAP_EXISTING") {
    return exactKeys(body, ["action", "contact_id", "tinder_identifier", "confirmed"]);
  }
  if (action === "CREATE_NEW") {
    return exactKeys(body, ["action", "new_contact_name", "tinder_identifier", "confirmed"]);
  }
  return false;
}

function validConversationBindingBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((field) => !CONVERSATION_BINDING_FIELDS.has(field))) {
    return false;
  }
  const action = String(body.action || "").trim().toUpperCase();
  if (body.confirmed !== true) return false;
  if (action === "BIND_EXISTING") {
    return exactKeys(body, ["action", "contact_id", "confirmed"]);
  }
  if (action === "BIND_CREATE") {
    return exactKeys(body, ["action", "new_contact_name", "confirmed"]);
  }
  return false;
}

function validHumanArmedBindingBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((field) => !HUMAN_ARMED_BINDING_FIELDS.has(field)) ||
      body.confirmed !== true) {
    return false;
  }
  const action = String(body.action || "").trim().toUpperCase();
  if (action === "BIND_EXISTING") {
    return exactKeys(body, ["action", "contact_id", "confirmed"])
      && validPositiveInteger(body.contact_id);
  }
  if (action === "BIND_CREATE") {
    const name = typeof body.new_contact_name === "string"
      ? body.new_contact_name.trim().replace(/\s+/g, " ")
      : "";
    return exactKeys(body, ["action", "new_contact_name", "confirmed"])
      && name.length >= 1 && name.length <= 160;
  }
  return false;
}

function validHumanArmedRearmBody(body) {
  return exactKeys(body, HUMAN_ARMED_REARM_FIELDS) && body.confirmed === true;
}

function validHumanArmedVisibleChatSyncBody(body) {
  return exactKeys(body, HUMAN_ARMED_VISIBLE_CHAT_SYNC_FIELDS) && body.confirmed === true;
}

function validHumanArmedLocalConversationAttestationBody(body) {
  return exactKeys(body, HUMAN_ARMED_LOCAL_CONVERSATION_ATTESTATION_FIELDS) && body.confirmed === true;
}

function validEmptyDraftBody(body) {
  return body === undefined || body === null || exactKeys(body, []);
}

// The browser never chooses a device, contact, thread, source capture, or
// permit. This operation has no browser-owned input beyond the selected
// opaque capture handle in the query string.
function validEmptyVisibleChatSyncBody(body) {
  return body === undefined || body === null || exactKeys(body, []);
}

// Kept separate by name even though both bounded operations accept the same
// exact empty object. This prevents future resume changes from accidentally
// inheriting a browser-owned sync field.
function validEmptyOfficialAppResumeBody(body) {
  return body === undefined || body === null || exactKeys(body, []);
}

function normalizePublicDraftActionResult(value, action) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.state !== "string" || typeof value.idempotent !== "boolean") {
    return null;
  }
  const state = value.state.trim().toUpperCase();
  const allowedStates = action === "APPROVE"
    ? new Set(["ACTIVE"])
    : action === "REJECT"
      ? new Set(["REJECTED"])
      : new Set(["CANCELLED", "SEND_RESULT_UNKNOWN"]);
  return allowedStates.has(state)
    ? Object.freeze({ state, idempotent: value.idempotent })
    : null;
}

function normalizePublicConversationBindingResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !PUBLIC_CONVERSATION_BINDING_SUCCESS_STATUSES.has(value.status) ||
      !validPositiveInteger(value.contactId) || typeof value.idempotent !== "boolean") {
    return null;
  }
  return Object.freeze({
    status: value.status,
    contactId: value.contactId,
    idempotent: value.idempotent
  });
}

function normalizePublicConversationBindingErrorResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !PUBLIC_CONVERSATION_BINDING_ERROR_STATUSES.has(value.status)) {
    return null;
  }
  return Object.freeze({ status: value.status });
}

function normalizePublicHumanArmedBindingResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !PUBLIC_HUMAN_ARMED_BINDING_SUCCESS_STATUSES.has(value.status)) {
    return null;
  }
  // Never forward binding/contact/permit/command/reference identifiers.
  return Object.freeze({ status: value.status });
}

function normalizePublicHumanArmedBindingErrorResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !PUBLIC_HUMAN_ARMED_BINDING_ERROR_STATUSES.has(value.status)) {
    return null;
  }
  return Object.freeze({ status: value.status });
}

function normalizePublicHumanArmedBindings(value) {
  if (!Array.isArray(value) || value.length > HUMAN_ARMED_BINDING_LIMIT) return null;
  const bindings = value.map((binding) => {
    if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
        !exactKeys(binding, [
          "binding_id", "contact_name", "local_conversation_attestation_status", "reader_status"
        ]) || !validCaptureId(binding.binding_id) || typeof binding.contact_name !== "string") {
      return null;
    }
    const contactName = binding.contact_name.trim().replace(/\s+/g, " ");
    const localConversationAttestationStatus = String(
      binding.local_conversation_attestation_status || ""
    ).trim().toUpperCase();
    const readerStatus = String(binding.reader_status || "").trim().toUpperCase();
    if (!contactName || contactName.length > 160
        || !PUBLIC_LOCAL_CONVERSATION_ATTESTATION_DASHBOARD_STATUSES.has(localConversationAttestationStatus)
        || !PUBLIC_LOCAL_CONVERSATION_READER_STATUSES.has(readerStatus)) return null;
    // binding_id is an opaque JavaScript-only handle for the separate rearm
    // operation. It is intentionally not rendered or put in a URL.
    return Object.freeze({
      binding_id: binding.binding_id,
      contact_name: contactName,
      local_conversation_attestation_status: localConversationAttestationStatus,
      reader_status: readerStatus
    });
  });
  return bindings.some((binding) => !binding) ? null : Object.freeze(bindings);
}

function backendHeaders(configuration, withBody = false) {
  return {
    Authorization: `Bearer ${configuration.dashboardApiSecret}`,
    Accept: "application/json",
    ...(withBody ? { "Content-Type": "application/json" } : {})
  };
}

async function readJson(response, res) {
  const rawText = await response.text();
  try {
    return rawText ? JSON.parse(rawText) : {};
  } catch {
    res.status(502).json({ ok: false, error: "Ungültige Antwort vom Backend." });
    return null;
  }
}

function safeBackendError(data, fallback) {
  const result = normalizePublicMappingErrorResult(data?.result);
  return {
    ok: false,
    ...(data?.conflict === true && result ? { conflict: true } : {}),
    ...(result ? { result } : {}),
    error: fallback
  };
}

function normalizeConfirmedConversationTimestamp(value) {
  const timestamp = normalizePublicTimestamp(value);
  return timestamp || null;
}

/**
 * List results deliberately contain no message content. This is the first
 * guard against turning a bounded selected-detail reader into a bulk reader.
 */
function normalizePublicConfirmedConversationListItem(value) {
  if (!exactKeys(value, ["capture_id", "visible_name", "captured_at"])
      || !validCaptureId(value.capture_id) || !validBoundedText(value.visible_name, 240)) {
    return null;
  }
  const capturedAt = normalizeConfirmedConversationTimestamp(value.captured_at);
  if (!capturedAt) return null;
  return Object.freeze({
    capture_id: value.capture_id,
    visible_name: value.visible_name.trim(),
    captured_at: capturedAt
  });
}

function normalizePublicConfirmedConversationList(value) {
  if (!Array.isArray(value) || value.length > LATEST_CONFIRMED_CONVERSATION_LIMIT) return null;
  const conversations = value.map(normalizePublicConfirmedConversationListItem);
  return conversations.some((conversation) => conversation === null)
    ? null
    : Object.freeze(conversations);
}

function normalizePublicConfirmedConversationMessage(value) {
  if (!exactKeys(value, ["direction", "text"])
      || !validBoundedText(value.text, CONVERSATION_MESSAGE_TEXT_LIMIT)) {
    return null;
  }
  const direction = String(value.direction || "").trim().toUpperCase();
  if (!CONVERSATION_MESSAGE_DIRECTIONS.has(direction)) return null;
  return Object.freeze({ direction, text: value.text.trim() });
}

function normalizePublicVisibleChatSyncMessage(value) {
  const message = normalizePublicConfirmedConversationMessage(value);
  return message && message.direction !== "UNKNOWN" ? message : null;
}

function normalizePublicVisibleChatSyncTranscript(value) {
  if (!exactKeys(value, [
    "received_at", "layout_schema_version", "segment_count", "overlap_count", "messages"
  ]) || value.layout_schema_version !== "tinder-zte-visible-chat-scroll-v1"
      || !Number.isSafeInteger(value.segment_count) || value.segment_count < 1 || value.segment_count > 8
      || !Number.isSafeInteger(value.overlap_count) || value.overlap_count < 0 || value.overlap_count > 100
      || !Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > CONVERSATION_MESSAGE_LIMIT) {
    return null;
  }
  const receivedAt = normalizeConfirmedConversationTimestamp(value.received_at);
  const messages = value.messages.map(normalizePublicVisibleChatSyncMessage);
  if (!receivedAt || messages.some((message) => message === null)) return null;
  return Object.freeze({
    received_at: receivedAt,
    layout_schema_version: "tinder-zte-visible-chat-scroll-v1",
    segment_count: value.segment_count,
    overlap_count: value.overlap_count,
    messages: Object.freeze(messages)
  });
}

function normalizePublicOfficialAppResumeObservation(value) {
  if (!exactKeys(value, ["status"])
      || !PUBLIC_OFFICIAL_APP_RESUME_OBSERVATION_STATUSES.has(value.status)) {
    return null;
  }
  return Object.freeze({ status: value.status });
}

/**
 * Every backend property is allowlisted. In particular, an accidental
 * capture/device/contact/fingerprint/provenance field cannot cross the
 * Vercel boundary even if a backend response changes later.
 */
function normalizePublicConfirmedConversation(value, captureId) {
  const hasVisibleChatSync = Object.prototype.hasOwnProperty.call(value || {}, "visible_chat_sync");
  const hasOfficialAppResume = Object.prototype.hasOwnProperty.call(value || {}, "official_app_resume");
  const expectedFields = [
    "capture_id", "visible_name", "captured_at", "messages",
    ...(hasVisibleChatSync ? ["visible_chat_sync"] : []),
    ...(hasOfficialAppResume ? ["official_app_resume"] : [])
  ];
  if (!exactKeys(value, expectedFields)
      || value.capture_id !== captureId || !validCaptureId(value.capture_id)
      || !validBoundedText(value.visible_name, 240)
      || !Array.isArray(value.messages) || value.messages.length === 0
      || value.messages.length > CONVERSATION_MESSAGE_LIMIT) {
    return null;
  }
  const capturedAt = normalizeConfirmedConversationTimestamp(value.captured_at);
  const messages = value.messages.map(normalizePublicConfirmedConversationMessage);
  const visibleChatSync = hasVisibleChatSync
    ? normalizePublicVisibleChatSyncTranscript(value.visible_chat_sync)
    : null;
  const officialAppResume = hasOfficialAppResume
    ? normalizePublicOfficialAppResumeObservation(value.official_app_resume)
    : null;
  if (!capturedAt || messages.some((message) => message === null)
      || (hasVisibleChatSync && visibleChatSync === null)
      || (hasOfficialAppResume && officialAppResume === null)) return null;
  return Object.freeze({
    capture_id: value.capture_id,
    visible_name: value.visible_name.trim(),
    captured_at: capturedAt,
    messages: Object.freeze(messages),
    ...(hasVisibleChatSync ? { visible_chat_sync: visibleChatSync } : {}),
    ...(hasOfficialAppResume ? { official_app_resume: officialAppResume } : {})
  });
}

function normalizePublicVisibleChatSyncResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.command_type !== PUBLIC_VISIBLE_CHAT_SYNC_COMMAND_TYPE
      || !PUBLIC_VISIBLE_CHAT_SYNC_STATUSES.has(value.status)) {
    return null;
  }
  const status = value.status;
  const hasReason = Object.prototype.hasOwnProperty.call(value, "reason_code");
  if (status === "QUEUED") {
    return exactKeys(value, ["command_type", "status"])
      ? Object.freeze({ command_type: PUBLIC_VISIBLE_CHAT_SYNC_COMMAND_TYPE, status })
      : null;
  }
  if (!hasReason || !exactKeys(value, ["command_type", "status", "reason_code"])
      || !PUBLIC_VISIBLE_CHAT_SYNC_REASONS.has(value.reason_code)) {
    return null;
  }
  return Object.freeze({
    command_type: PUBLIC_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
    status,
    reason_code: value.reason_code
  });
}

// This public result deliberately contains only a command type, terminal
// queue state, and bounded reason.  In particular it must not turn the
// opaque device command handle or binding facts into dashboard data.
function normalizePublicLocalConversationAttestationResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.command_type !== PUBLIC_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE
      || !PUBLIC_LOCAL_CONVERSATION_ATTESTATION_STATUSES.has(value.status)) {
    return null;
  }
  const status = value.status;
  const hasReason = Object.prototype.hasOwnProperty.call(value, "reason_code");
  if (status === "QUEUED") {
    return exactKeys(value, ["command_type", "status"])
      ? Object.freeze({ command_type: PUBLIC_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE, status })
      : null;
  }
  if (!hasReason || !exactKeys(value, ["command_type", "status", "reason_code"])
      || !PUBLIC_LOCAL_CONVERSATION_ATTESTATION_REASONS.has(value.reason_code)) {
    return null;
  }
  return Object.freeze({
    command_type: PUBLIC_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE,
    status,
    reason_code: value.reason_code
  });
}

function normalizePublicOfficialAppResumeResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.command_type !== PUBLIC_OFFICIAL_APP_RESUME_COMMAND_TYPE
      || !PUBLIC_OFFICIAL_APP_RESUME_STATUSES.has(value.status)) {
    return null;
  }
  const status = value.status;
  const hasReason = Object.prototype.hasOwnProperty.call(value, "reason_code");
  if (status === "QUEUED") {
    return exactKeys(value, ["command_type", "status"])
      ? Object.freeze({ command_type: PUBLIC_OFFICIAL_APP_RESUME_COMMAND_TYPE, status })
      : null;
  }
  if (!hasReason || !exactKeys(value, ["command_type", "status", "reason_code"])
      || !PUBLIC_OFFICIAL_APP_RESUME_REASONS.has(value.reason_code)) {
    return null;
  }
  return Object.freeze({
    command_type: PUBLIC_OFFICIAL_APP_RESUME_COMMAND_TYPE,
    status,
    reason_code: value.reason_code
  });
}

function confirmedConversationBackendError(res, response, { detail = false } = {}) {
  if (response.status === 401) {
    return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
  }
  const allowed = detail ? [400, 404, 409, 503] : [400, 409, 503];
  const status = allowed.includes(response.status) ? response.status : 502;
  return res.status(status).json({
    ok: false,
    error: detail ? "Tinder-Conversation konnte nicht geladen werden." : "Tinder-Conversations konnten nicht geladen werden."
  });
}

async function forwardConfirmedConversationList(res, configuration) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/conversations/latest-confirmed`,
      { method: "GET", headers: backendHeaders(configuration), cache: "no-store" }
    );
    const data = await readJson(response, res);
    if (!data) return;
    if (!response.ok) return confirmedConversationBackendError(res, response);
    if (data?.ok !== true) {
      return res.status(502).json({ ok: false, error: "UngÃ¼ltige Conversation-Antwort vom Backend." });
    }
    const conversations = normalizePublicConfirmedConversationList(data?.conversations);
    if (!conversations) {
      return res.status(502).json({ ok: false, error: "UngÃ¼ltige Conversation-Antwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, conversations });
  } catch {
    console.error("Verbindung zum Tinder-Conversation-Backend fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

async function forwardConfirmedConversationDetail(res, configuration, captureId) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/conversations/${encodeURIComponent(captureId)}`,
      { method: "GET", headers: backendHeaders(configuration), cache: "no-store" }
    );
    const data = await readJson(response, res);
    if (!data) return;
    if (!response.ok) return confirmedConversationBackendError(res, response, { detail: true });
    if (data?.ok !== true) {
      return res.status(502).json({ ok: false, error: "UngÃ¼ltige Conversation-Antwort vom Backend." });
    }
    const conversation = normalizePublicConfirmedConversation(data?.conversation, captureId);
    if (!conversation) {
      return res.status(502).json({ ok: false, error: "UngÃ¼ltige Conversation-Antwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, conversation });
  } catch {
    console.error("Verbindung zum Tinder-Conversation-Backend fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

async function forwardVisibleChatSync(res, configuration, captureId) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/captures/${encodeURIComponent(captureId)}/visible-chat-sync`,
      {
        method: "POST",
        headers: backendHeaders(configuration, true),
        // Do not forward a browser body. The backend derives every target and
        // accepts only this exact empty object for the selected capture.
        body: JSON.stringify({}),
        cache: "no-store"
      }
    );
    const data = await readJson(response, res);
    if (!data) return;
    const sync = normalizePublicVisibleChatSyncResult(data?.sync);
    if (response.ok) {
      if (data?.ok !== true || !sync || sync.status !== "QUEUED") {
        return res.status(502).json({ ok: false, error: "Ungültige sichtbare Chat-Synchronisierung vom Backend." });
      }
      res.setHeader("Cache-Control", "no-store, max-age=0");
      return res.status(202).json({ ok: true, sync });
    }

    if (response.status === 401) {
      return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
    }
    if (response.status === 409 && data?.ok === false && sync && sync.status !== "QUEUED") {
      return res.status(409).json({ ok: false, conflict: true, sync, error: "Sichtbare Chat-Synchronisierung ist derzeit nicht verfügbar." });
    }
    const status = [400, 404, 503].includes(response.status) ? response.status : 502;
    return res.status(status).json({ ok: false, error: "Sichtbare Chat-Synchronisierung konnte nicht vorbereitet werden." });
  } catch {
    console.error("Verbindung zur sichtbaren Tinder-Chat-Synchronisierung fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

async function forwardOfficialAppResume(res, configuration, captureId) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/captures/${encodeURIComponent(captureId)}/resume-official-app`,
      {
        method: "POST",
        headers: backendHeaders(configuration, true),
        // Browser input never chooses a package, component, URI, device,
        // command ID, expiry, thread, identity, or payload. The backend uses
        // only the selected capture context and accepts this exact object.
        body: JSON.stringify({}),
        cache: "no-store"
      }
    );
    const data = await readJson(response, res);
    if (!data) return;
    const resume = normalizePublicOfficialAppResumeResult(data?.resume);
    if (response.ok) {
      if (data?.ok !== true || !resume || resume.status !== "QUEUED") {
        return res.status(502).json({ ok: false, error: "UngÃ¼ltige offizielle Tinder-App-Antwort vom Backend." });
      }
      res.setHeader("Cache-Control", "no-store, max-age=0");
      return res.status(202).json({ ok: true, resume });
    }
    if (response.status === 401) {
      return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
    }
    if (response.status === 409 && data?.ok === false && resume && resume.status !== "QUEUED") {
      return res.status(409).json({ ok: false, conflict: true, resume, error: "Offizielle Tinder-App kann derzeit nicht einmalig geöffnet werden." });
    }
    const status = [400, 404, 503].includes(response.status) ? response.status : 502;
    return res.status(status).json({ ok: false, error: "Offizielle Tinder-App konnte nicht vorbereitet werden." });
  } catch {
    console.error("Verbindung zum offiziellen Tinder-App-Resume fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

async function forwardCaptureRead(res, configuration, captureId) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/captures/${encodeURIComponent(captureId)}`,
      { method: "GET", headers: backendHeaders(configuration), cache: "no-store" }
    );
    const data = await readJson(response, res);
    if (!data) return;
    if (!response.ok) {
      if (response.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      const status = [400, 404, 409, 503].includes(response.status) ? response.status : 502;
      return res.status(status).json(safeBackendError(data, "Tinder-Capture konnte nicht geladen werden."));
    }
    const capture = normalizePublicCapture(data?.capture, captureId);
    if (!capture) {
      return res.status(502).json({ ok: false, error: "Ungültige Capture-Antwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, capture });
  } catch {
    console.error("Verbindung zum Tinder-Capture-Backend fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

function normalizePublicPendingCaptures(value) {
  if (!Array.isArray(value) || value.length > PENDING_CAPTURE_LIMIT) return null;
  const captures = value.map((capture) => normalizePublicCapture(capture, capture?.capture_id));
  if (captures.some((capture) => !capture
      || capture.mapping_status !== "NEEDS_HUMAN_MAPPING"
      || capture.human_review_status !== "PENDING")) {
    return null;
  }
  return Object.freeze(captures);
}

function normalizePublicDraftEligibleCapture(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !validCaptureId(value.capture_id) || !validBoundedText(value.visible_name, 240)) {
    return null;
  }
  return Object.freeze({
    capture_id: value.capture_id,
    visible_name: value.visible_name.trim()
  });
}

function normalizePublicDraftEligibleCaptures(value) {
  if (!Array.isArray(value) || value.length > DRAFT_ELIGIBLE_CAPTURE_LIMIT) return null;
  const captures = value.map(normalizePublicDraftEligibleCapture);
  return captures.some((capture) => capture === null) ? null : Object.freeze(captures);
}

async function forwardPendingCaptureRead(res, configuration) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/captures/pending`,
      { method: "GET", headers: backendHeaders(configuration), cache: "no-store" }
    );
    const data = await readJson(response, res);
    if (!data) return;
    if (!response.ok) {
      if (response.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      const status = [400, 409, 503].includes(response.status) ? response.status : 502;
      return res.status(status).json(safeBackendError(data, "Ausstehende Tinder-Captures konnten nicht geladen werden."));
    }
    const captures = normalizePublicPendingCaptures(data?.captures);
    if (!captures) {
      return res.status(502).json({ ok: false, error: "Ungültige Capture-Antwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, captures });
  } catch {
    console.error("Verbindung zum Tinder-Capture-Backend fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

async function forwardDraftEligibleCaptureRead(res, configuration) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/captures/draft-eligible`,
      { method: "GET", headers: backendHeaders(configuration), cache: "no-store" }
    );
    const data = await readJson(response, res);
    if (!data) return;
    if (!response.ok) {
      if (response.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      const status = [400, 409, 503].includes(response.status) ? response.status : 502;
      return res.status(status).json(safeBackendError(data, "Bereite Tinder-Captures konnten nicht geladen werden."));
    }
    const captures = normalizePublicDraftEligibleCaptures(data?.captures);
    if (!captures) {
      return res.status(502).json({ ok: false, error: "UngÃ¼ltige bereite Tinder-Captures vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, captures });
  } catch {
    console.error("Verbindung zu bereiten Tinder-Captures fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

async function forwardHumanMapping(req, res, configuration, captureId) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/captures/${encodeURIComponent(captureId)}/mapping`,
      {
        method: "POST",
        headers: backendHeaders(configuration, true),
        body: JSON.stringify(req.body),
        cache: "no-store"
      }
    );
    const data = await readJson(response, res);
    if (!data) return;
    if (!response.ok) {
      if (response.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      const status = [400, 404, 409, 503].includes(response.status) ? response.status : 502;
      return res.status(status).json(safeBackendError(data, "Tinder-Zuordnung konnte nicht gespeichert werden."));
    }
    const result = normalizePublicMappingResult(data?.result);
    if (!result) {
      return res.status(502).json({ ok: false, error: "Ungültige Mapping-Antwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, result });
  } catch {
    console.error("Verbindung zum Tinder-Mapping-Backend fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

function safeConversationBindingBackendError(data, fallback) {
  const result = normalizePublicConversationBindingErrorResult(data?.result);
  return {
    ok: false,
    ...(data?.conflict === true && result ? { conflict: true } : {}),
    ...(result ? { result } : {}),
    error: fallback
  };
}

function safeHumanArmedBindingBackendError(data, fallback) {
  const result = normalizePublicHumanArmedBindingErrorResult(data?.result);
  return {
    ok: false,
    ...(data?.conflict === true && result ? { conflict: true } : {}),
    ...(result ? { result } : {}),
    error: fallback
  };
}

function safeDraftBackendError(data, fallback) {
  if (data?.code === "TINDER_DRAFT_FOUNDATION_NOT_READY") {
    return {
      ok: false,
      code: "TINDER_DRAFT_FOUNDATION_NOT_READY",
      error: "Tinder-Draft Foundation ist noch nicht bereit."
    };
  }
  return { ok: false, error: fallback };
}

async function forwardConversationBinding(req, res, configuration, captureId) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/captures/${encodeURIComponent(captureId)}/conversation-binding`,
      {
        method: "POST",
        headers: backendHeaders(configuration, true),
        body: JSON.stringify(req.body),
        cache: "no-store"
      }
    );
    const data = await readJson(response, res);
    if (!data) return;
    if (!response.ok) {
      if (response.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      const status = [400, 404, 409, 503].includes(response.status) ? response.status : 502;
      return res.status(status).json(safeConversationBindingBackendError(data, "Conversation-Binding konnte nicht gespeichert werden."));
    }
    const result = normalizePublicConversationBindingResult(data?.result);
    if (!result) {
      return res.status(502).json({ ok: false, error: "Ungültige Binding-Antwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, result });
  } catch {
    console.error("Verbindung zum Tinder-Conversation-Binding-Backend fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

async function forwardHumanArmedBinding(req, res, configuration, captureId) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/captures/${encodeURIComponent(captureId)}/human-armed-binding`,
      {
        method: "POST",
        headers: backendHeaders(configuration, true),
        body: JSON.stringify(req.body),
        cache: "no-store"
      }
    );
    const data = await readJson(response, res);
    if (!data) return;
    if (!response.ok) {
      if (response.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      const status = [400, 404, 409, 503].includes(response.status) ? response.status : 502;
      return res.status(status).json(
        safeHumanArmedBindingBackendError(data, "Human-bestätigte Conversation-Bindung konnte nicht vorbereitet werden.")
      );
    }
    const result = normalizePublicHumanArmedBindingResult(data?.result);
    if (!result) {
      return res.status(502).json({ ok: false, error: "Ungültige Human-Binding-Antwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, result });
  } catch {
    console.error("Verbindung zum Tinder-Human-Binding-Backend fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

async function forwardHumanArmedRearm(req, res, configuration, bindingId) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/human-armed-conversation-bindings/${encodeURIComponent(bindingId)}/rearm`,
      {
        method: "POST",
        headers: backendHeaders(configuration, true),
        body: JSON.stringify(req.body),
        cache: "no-store"
      }
    );
    const data = await readJson(response, res);
    if (!data) return;
    if (!response.ok) {
      if (response.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      const status = [400, 404, 409, 503].includes(response.status) ? response.status : 502;
      return res.status(status).json(
        safeHumanArmedBindingBackendError(data, "Human-bestätigte Conversation konnte nicht erneut freigegeben werden.")
      );
    }
    const result = normalizePublicHumanArmedBindingResult(data?.result);
    if (!result) {
      return res.status(502).json({ ok: false, error: "Ungültige Human-Rearm-Antwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, result });
  } catch {
    console.error("Verbindung zum Tinder-Human-Rearm-Backend fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

/**
 * The browser submits only the existing opaque human-binding handle and an
 * explicit confirmation. The Railway service derives all capture/device
 * facts from the locked binding; no Tinder UI identity crosses this proxy.
 */
async function forwardHumanArmedVisibleChatSync(req, res, configuration, bindingId) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/human-armed-conversation-bindings/${encodeURIComponent(bindingId)}/visible-chat-sync`,
      {
        method: "POST",
        headers: backendHeaders(configuration, true),
        // The request was already parsed as exactly `{ confirmed: true }`.
        // Keep the proxy boundary fixed as well, so a future caller-side
        // change cannot expand the browser-controlled wire contract.
        body: JSON.stringify({ confirmed: true }),
        cache: "no-store"
      }
    );
    const data = await readJson(response, res);
    if (!data) return;
    const sync = normalizePublicVisibleChatSyncResult(data?.sync);
    if (response.ok) {
      if (data?.ok !== true || !sync || sync.status !== "QUEUED") {
        return res.status(502).json({ ok: false, error: "Ung\u00fcltige human-best\u00e4tigte Chat-Synchronisierung vom Backend." });
      }
      res.setHeader("Cache-Control", "no-store, max-age=0");
      return res.status(202).json({ ok: true, sync });
    }
    if (response.status === 401) {
      return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
    }
    if (response.status === 409 && data?.ok === false && sync && sync.status !== "QUEUED") {
      return res.status(409).json({ ok: false, conflict: true, sync, error: "Human-best\u00e4tigte aktuelle Chat-Synchronisierung ist derzeit nicht verf\u00fcgbar." });
    }
    const status = [400, 404, 503].includes(response.status) ? response.status : 502;
    return res.status(status).json({ ok: false, error: "Human-best\u00e4tigte aktuelle Chat-Synchronisierung konnte nicht vorbereitet werden." });
  } catch {
    console.error("Verbindung zur human-best\u00e4tigten Tinder-Chat-Synchronisierung fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

/**
 * The browser can request only the human-confirmed bootstrap.  It cannot
 * select a Tinder row, capture, device, or technical attestation handle;
 * those facts remain inside the authenticated Railway/device contract.
 */
async function forwardHumanArmedLocalConversationAttestation(req, res, configuration, bindingId) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/human-armed-conversation-bindings/${encodeURIComponent(bindingId)}/local-conversation-attestation`,
      {
        method: "POST",
        headers: backendHeaders(configuration, true),
        body: JSON.stringify({ confirmed: true }),
        cache: "no-store"
      }
    );
    const data = await readJson(response, res);
    if (!data) return;
    const attestation = normalizePublicLocalConversationAttestationResult(data?.attestation);
    if (response.ok) {
      if (data?.ok !== true || !attestation || attestation.status !== "QUEUED") {
        return res.status(502).json({ ok: false, error: "Ung\u00fcltige lokale Conversation-Best\u00e4tigung vom Backend." });
      }
      res.setHeader("Cache-Control", "no-store, max-age=0");
      return res.status(202).json({ ok: true, attestation });
    }
    if (response.status === 401) {
      return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
    }
    if (response.status === 409 && data?.ok === false && attestation && attestation.status !== "QUEUED") {
      return res.status(409).json({
        ok: false,
        conflict: true,
        attestation,
        error: "Lokale Conversation-Best\u00e4tigung ist derzeit nicht verf\u00fcgbar."
      });
    }
    const status = [400, 404, 503].includes(response.status) ? response.status : 502;
    return res.status(status).json({ ok: false, error: "Lokale Conversation-Best\u00e4tigung konnte nicht vorbereitet werden." });
  } catch {
    console.error("Verbindung zur lokalen Tinder-Conversation-Best\u00e4tigung fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Dashboard-Backend ist momentan nicht erreichbar." });
  }
}

async function forwardDraftCreation(res, configuration, captureId) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/captures/${encodeURIComponent(captureId)}/drafts`,
      {
        method: "POST",
        headers: backendHeaders(configuration, true),
        // The backend accepts an empty object only; no browser-owned context
        // crosses this proxy boundary.
        body: JSON.stringify({}),
        cache: "no-store"
      }
    );
    const data = await readJson(response, res);
    if (!data) return;
    if (!response.ok) {
      if (response.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      const status = [400, 404, 409, 422, 503].includes(response.status) ? response.status : 502;
      return res.status(status).json(safeDraftBackendError(data, "Tinder-Draft konnte nicht erstellt werden."));
    }
    const draft = normalizePublicDraft(data?.draft, captureId);
    if (!draft) {
      return res.status(502).json({ ok: false, error: "Ung\u00fcltige Tinder-Draft-Antwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(201).json({ ok: true, draft });
  } catch {
    console.error("Verbindung zum Tinder-Draft-Backend fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

function safeDraftReviewBackendError(data, fallback) {
  if (data?.code === "TINDER_SEND_FOUNDATION_NOT_READY") {
    return {
      ok: false,
      code: "TINDER_SEND_FOUNDATION_NOT_READY",
      error: "Tinder Send Foundation ist noch nicht bereit."
    };
  }
  return { ok: false, error: fallback };
}

async function loadDraftReview(res, configuration, captureId) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/captures/${encodeURIComponent(captureId)}/draft-review`,
      { method: "GET", headers: backendHeaders(configuration), cache: "no-store" }
    );
    const data = await readJson(response, res);
    if (!data) return null;
    if (!response.ok) {
      if (response.status === 401) {
        res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
        return null;
      }
      const status = [400, 404, 409, 422, 503].includes(response.status) ? response.status : 502;
      res.status(status).json(safeDraftReviewBackendError(data, "Tinder-Draft kann derzeit nicht geprüft werden."));
      return null;
    }
    const review = normalizePublicDraftReview(data?.review, captureId);
    if (!review) {
      res.status(502).json({ ok: false, error: "Ungültige Tinder-Draft-Prüfung vom Backend." });
      return null;
    }
    return review;
  } catch {
    console.error("Verbindung zur Tinder-Draft-Prüfung fehlgeschlagen.");
    res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
    return null;
  }
}

async function forwardDraftReview(res, configuration, captureId) {
  const review = await loadDraftReview(res, configuration, captureId);
  if (!review) return;
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(200).json({ ok: true, review });
}

async function forwardOpenDraftReviewRead(res, configuration) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/drafts/open-reviews`,
      { method: "GET", headers: backendHeaders(configuration), cache: "no-store" }
    );
    const data = await readJson(response, res);
    if (!data) return;
    if (!response.ok) {
      if (response.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      const status = [400, 409, 503].includes(response.status) ? response.status : 502;
      return res.status(status).json(safeDraftReviewBackendError(data, "Offene Tinder-Draft-Prüfungen konnten nicht geladen werden."));
    }
    const reviews = normalizePublicOpenDraftReviews(data?.reviews);
    if (!reviews) {
      return res.status(502).json({ ok: false, error: "Ungültige offene Tinder-Draft-Prüfungen vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, reviews });
  } catch {
    console.error("Verbindung zu offenen Tinder-Draft-Prüfungen fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

async function forwardDraftReviewAction(res, configuration, captureId, action) {
  const review = await loadDraftReview(res, configuration, captureId);
  if (!review) return;
  const endpoint = action === "APPROVE"
    ? "approval"
    : action === "REJECT"
      ? "reject"
      : "cancel";
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/drafts/${encodeURIComponent(review.draft_id)}/${endpoint}`,
      {
        method: "POST",
        headers: backendHeaders(configuration, true),
        // The browser can express only the fixed action.  The backend reloads
        // and locks every binding field from the verified draft snapshot.
        body: JSON.stringify({ action }),
        cache: "no-store"
      }
    );
    const data = await readJson(response, res);
    if (!data) return;
    if (!response.ok) {
      if (response.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      const status = [400, 404, 409, 422, 503].includes(response.status) ? response.status : 502;
      return res.status(status).json(safeDraftReviewBackendError(data, "Tinder-Draft-Entscheidung konnte nicht gespeichert werden."));
    }
    const source = action === "APPROVE" ? data?.approval : action === "REJECT" ? data?.draft : data?.result;
    const result = normalizePublicDraftActionResult(source, action);
    if (!result) {
      return res.status(502).json({ ok: false, error: "Ungültige Tinder-Draft-Entscheidung vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, result });
  } catch {
    console.error("Verbindung zur Tinder-Draft-Entscheidung fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

async function forwardHumanArmedBindingList(res, configuration) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/tinder/human-armed-conversation-bindings`,
      { method: "GET", headers: backendHeaders(configuration), cache: "no-store" }
    );
    const data = await readJson(response, res);
    if (!data) return;
    if (!response.ok) {
      if (response.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      const status = [400, 409, 503].includes(response.status) ? response.status : 502;
      return res.status(status).json({ ok: false, error: "Menschlich gebundene Tinder-Conversations konnten nicht geladen werden." });
    }
    const bindings = normalizePublicHumanArmedBindings(data?.bindings);
    if (!bindings) {
      return res.status(502).json({ ok: false, error: "Ungültige Binding-Antwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, bindings });
  } catch {
    console.error("Verbindung zum Tinder-Human-Binding-Backend fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Methode nicht erlaubt." });
  }
  if (!validDashboardSession(req)) {
    return res.status(401).json({ ok: false, error: "Nicht angemeldet." });
  }

  const captureRequest = captureRequestFromQuery(req);
  if (!captureRequest || (req.method === "POST" && ![
    "capture", "human_arm", "human_rearm", "human_armed_visible_chat_sync",
    "human_armed_local_conversation_attestation", "draft", "draft_approve",
    "draft_reject", "draft_cancel", "visible_chat_sync", "official_app_resume"
  ].includes(captureRequest.type))) {
    return res.status(400).json({ ok: false, error: "Ungültige Capture-ID." });
  }
  const requestKind = req.method !== "POST" ? null
    : captureRequest.type === "human_arm" && validHumanArmedBindingBody(req.body)
      ? "human_arm"
    : captureRequest.type === "human_rearm" && validHumanArmedRearmBody(req.body)
      ? "human_rearm"
      : captureRequest.type === "human_armed_visible_chat_sync" && validHumanArmedVisibleChatSyncBody(req.body)
        ? "human_armed_visible_chat_sync"
      : captureRequest.type === "human_armed_local_conversation_attestation"
          && validHumanArmedLocalConversationAttestationBody(req.body)
        ? "human_armed_local_conversation_attestation"
      : captureRequest.type === "draft" && validEmptyDraftBody(req.body)
        ? "draft"
      : captureRequest.type === "draft_approve" && validEmptyDraftBody(req.body)
        ? "draft_approve"
      : captureRequest.type === "draft_reject" && validEmptyDraftBody(req.body)
        ? "draft_reject"
      : captureRequest.type === "draft_cancel" && validEmptyDraftBody(req.body)
        ? "draft_cancel"
      : captureRequest.type === "visible_chat_sync" && validEmptyVisibleChatSyncBody(req.body)
        ? "visible_chat_sync"
      : captureRequest.type === "official_app_resume" && validEmptyOfficialAppResumeBody(req.body)
        ? "official_app_resume"
      : captureRequest.type === "capture" && validMappingBody(req.body)
          ? "profile_mapping"
          : captureRequest.type === "capture" && validConversationBindingBody(req.body)
            ? "conversation_binding"
            : null;
  if (req.method === "POST" && !requestKind) {
    return res.status(400).json({ ok: false, error: "Ungültige Mapping-Anfrage." });
  }

  const configuration = backendConfiguration(res);
  if (!configuration) return;
  if (req.method === "GET" && captureRequest.type === "confirmed_conversations") {
    return forwardConfirmedConversationList(res, configuration);
  }
  if (req.method === "GET" && captureRequest.type === "confirmed_conversation") {
    return forwardConfirmedConversationDetail(res, configuration, captureRequest.captureId);
  }
  if (req.method === "GET" && captureRequest.type === "pending") {
    return forwardPendingCaptureRead(res, configuration);
  }
  if (req.method === "GET" && captureRequest.type === "draft_eligible") {
    return forwardDraftEligibleCaptureRead(res, configuration);
  }
  if (req.method === "GET" && captureRequest.type === "human_armed_bindings") {
    return forwardHumanArmedBindingList(res, configuration);
  }
  if (req.method === "GET" && captureRequest.type === "open_draft_reviews") {
    return forwardOpenDraftReviewRead(res, configuration);
  }
  if (req.method === "GET" && captureRequest.type === "draft_review") {
    return forwardDraftReview(res, configuration, captureRequest.captureId);
  }
  if (req.method === "GET") {
    return forwardCaptureRead(res, configuration, captureRequest.captureId);
  }
  if (requestKind === "human_arm") {
    return forwardHumanArmedBinding(req, res, configuration, captureRequest.captureId);
  }
  if (requestKind === "human_rearm") {
    return forwardHumanArmedRearm(req, res, configuration, captureRequest.bindingId);
  }
  if (requestKind === "human_armed_visible_chat_sync") {
    return forwardHumanArmedVisibleChatSync(req, res, configuration, captureRequest.bindingId);
  }
  if (requestKind === "human_armed_local_conversation_attestation") {
    return forwardHumanArmedLocalConversationAttestation(req, res, configuration, captureRequest.bindingId);
  }
  if (requestKind === "draft") {
    return forwardDraftCreation(res, configuration, captureRequest.captureId);
  }
  if (requestKind === "draft_approve") {
    return forwardDraftReviewAction(res, configuration, captureRequest.captureId, "APPROVE");
  }
  if (requestKind === "draft_reject") {
    return forwardDraftReviewAction(res, configuration, captureRequest.captureId, "REJECT");
  }
  if (requestKind === "draft_cancel") {
    return forwardDraftReviewAction(res, configuration, captureRequest.captureId, "CANCEL");
  }
  if (requestKind === "visible_chat_sync") {
    return forwardVisibleChatSync(res, configuration, captureRequest.captureId);
  }
  if (requestKind === "official_app_resume") {
    return forwardOfficialAppResume(res, configuration, captureRequest.captureId);
  }
  return requestKind === "conversation_binding"
    ? forwardConversationBinding(req, res, configuration, captureRequest.captureId)
    : forwardHumanMapping(req, res, configuration, captureRequest.captureId);
}

export {
  CONVERSATION_BINDING_FIELDS,
  HUMAN_ARMED_BINDING_FIELDS,
  HUMAN_ARMED_BINDINGS_VIEW,
  HUMAN_ARMED_REARM_FIELDS,
  HUMAN_ARMED_LOCAL_CONVERSATION_ATTESTATION_FIELDS,
  HUMAN_ARM_OPERATION,
  HUMAN_REARM_OPERATION,
  HUMAN_ARMED_LOCAL_CONVERSATION_ATTESTATION_OPERATION,
  DRAFT_OPERATION,
  DRAFT_ELIGIBLE_CAPTURE_LIMIT,
  DRAFT_ELIGIBLE_CAPTURE_VIEW,
  DRAFT_REVIEW_VIEW,
  OPEN_DRAFT_REVIEWS_VIEW,
  OPEN_DRAFT_REVIEW_LIMIT,
  DRAFT_APPROVE_OPERATION,
  DRAFT_REJECT_OPERATION,
  DRAFT_CANCEL_OPERATION,
  CONFIRMED_CONVERSATION_VIEW,
  CONFIRMED_CONVERSATIONS_VIEW,
  VISIBLE_CHAT_SYNC_OPERATION,
  OFFICIAL_APP_RESUME_OPERATION,
  CONVERSATION_MESSAGE_LIMIT,
  CONVERSATION_MESSAGE_TEXT_LIMIT,
  LATEST_CONFIRMED_CONVERSATION_LIMIT,
  MAPPING_FIELDS,
  PENDING_CAPTURE_LIMIT,
  PENDING_CAPTURE_VIEW,
  captureRequestFromQuery,
  normalizePublicCapture,
  normalizePublicDraftEligibleCapture,
  normalizePublicDraftEligibleCaptures,
  normalizePublicPendingCaptures,
  normalizePublicMappingErrorResult,
  normalizePublicConversationBindingErrorResult,
  normalizePublicConversationBindingResult,
  normalizePublicHumanArmedBindingErrorResult,
  normalizePublicHumanArmedBindingResult,
  normalizePublicHumanArmedBindings,
  normalizePublicDraft,
  normalizePublicDraftReview,
  normalizePublicOpenDraftReview,
  normalizePublicOpenDraftReviews,
  normalizePublicDraftActionResult,
  normalizePublicMappingResult,
  normalizePublicConfirmedConversation,
  normalizePublicConfirmedConversationList,
  normalizePublicConfirmedConversationListItem,
  normalizePublicConfirmedConversationMessage,
  normalizePublicVisibleChatSyncMessage,
  normalizePublicVisibleChatSyncTranscript,
  normalizePublicOfficialAppResumeObservation,
  normalizePublicVisibleChatSyncResult,
  normalizePublicLocalConversationAttestationResult,
  normalizePublicOfficialAppResumeResult,
  validEmptyOfficialAppResumeBody,
  validCaptureId,
  validConversationBindingBody,
  validHumanArmedBindingBody,
  validHumanArmedRearmBody,
  validHumanArmedVisibleChatSyncBody,
  validHumanArmedLocalConversationAttestationBody,
  validEmptyDraftBody,
  validEmptyVisibleChatSyncBody,
  validMappingBody
};
