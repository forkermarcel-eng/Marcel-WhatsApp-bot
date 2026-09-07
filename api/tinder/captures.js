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
const PENDING_CAPTURE_VIEW = "pending";
const PENDING_CAPTURE_LIMIT = 25;
const DRAFT_ELIGIBLE_CAPTURE_VIEW = "draft-eligible";
const DRAFT_ELIGIBLE_CAPTURE_LIMIT = 25;
const HUMAN_ARMED_BINDINGS_VIEW = "human-armed-bindings";
const HUMAN_ARMED_BINDING_LIMIT = 25;
const HUMAN_ARM_OPERATION = "human-arm";
const HUMAN_REARM_OPERATION = "human-rearm";
const DRAFT_OPERATION = "draft";
const PUBLIC_DRAFT_STATUS = "DRAFT";
const DRAFT_REVIEW_VIEW = "draft-review";
const OPEN_DRAFT_REVIEWS_VIEW = "open-draft-reviews";
const OPEN_DRAFT_REVIEW_LIMIT = 25;
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
      && query.operation === HUMAN_ARM_OPERATION) {
    return Object.freeze({ type: "human_arm", captureId: query.captureId });
  }
  if (exactKeys(query, ["bindingId", "operation"]) && validCaptureId(query.bindingId)
      && query.operation === HUMAN_REARM_OPERATION) {
    return Object.freeze({ type: "human_rearm", bindingId: query.bindingId });
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

function validEmptyDraftBody(body) {
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
        !validCaptureId(binding.binding_id) || typeof binding.contact_name !== "string") {
      return null;
    }
    const contactName = binding.contact_name.trim().replace(/\s+/g, " ");
    if (!contactName || contactName.length > 160) return null;
    // binding_id is an opaque JavaScript-only handle for the separate rearm
    // operation. It is intentionally not rendered or put in a URL.
    return Object.freeze({ binding_id: binding.binding_id, contact_name: contactName });
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
    "capture", "human_arm", "human_rearm", "draft", "draft_approve", "draft_reject", "draft_cancel"
  ].includes(captureRequest.type))) {
    return res.status(400).json({ ok: false, error: "Ungültige Capture-ID." });
  }
  const requestKind = req.method !== "POST" ? null
    : captureRequest.type === "human_arm" && validHumanArmedBindingBody(req.body)
      ? "human_arm"
    : captureRequest.type === "human_rearm" && validHumanArmedRearmBody(req.body)
      ? "human_rearm"
      : captureRequest.type === "draft" && validEmptyDraftBody(req.body)
        ? "draft"
      : captureRequest.type === "draft_approve" && validEmptyDraftBody(req.body)
        ? "draft_approve"
      : captureRequest.type === "draft_reject" && validEmptyDraftBody(req.body)
        ? "draft_reject"
      : captureRequest.type === "draft_cancel" && validEmptyDraftBody(req.body)
        ? "draft_cancel"
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
  return requestKind === "conversation_binding"
    ? forwardConversationBinding(req, res, configuration, captureRequest.captureId)
    : forwardHumanMapping(req, res, configuration, captureRequest.captureId);
}

export {
  CONVERSATION_BINDING_FIELDS,
  HUMAN_ARMED_BINDING_FIELDS,
  HUMAN_ARMED_BINDINGS_VIEW,
  HUMAN_ARMED_REARM_FIELDS,
  HUMAN_ARM_OPERATION,
  HUMAN_REARM_OPERATION,
  DRAFT_OPERATION,
  DRAFT_ELIGIBLE_CAPTURE_LIMIT,
  DRAFT_ELIGIBLE_CAPTURE_VIEW,
  DRAFT_REVIEW_VIEW,
  OPEN_DRAFT_REVIEWS_VIEW,
  OPEN_DRAFT_REVIEW_LIMIT,
  DRAFT_APPROVE_OPERATION,
  DRAFT_REJECT_OPERATION,
  DRAFT_CANCEL_OPERATION,
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
  validCaptureId,
  validConversationBindingBody,
  validHumanArmedBindingBody,
  validHumanArmedRearmBody,
  validEmptyDraftBody,
  validMappingBody
};
