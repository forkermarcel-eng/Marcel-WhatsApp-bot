import { isUuidV4 } from "./protocol-v1.js";

/* ==================================================
T4 TINDER DRAFT FOUNDATION -- DASHBOARD ROUTE

This route deliberately accepts no mutable draft context from the browser.
The capture id is the sole client-provided value; the draft service loads and
rechecks capture, identity, device-gate and takeover state server-side.

The T3 and T4 migrations remain explicit, standalone preparations.  A
missing table/column is therefore a controlled fail-closed 503, rather than a
best-effort draft or an implicit runtime migration.
================================================== */

const TINDER_DRAFT_FOUNDATION_ERROR_CODES = new Set([
  "42P01", // undefined_table
  "42703", // undefined_column
  "23502"  // schema present but required foundation data unavailable
]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCaptureId(value) {
  const captureId = String(value || "").trim();
  if (!isUuidV4(captureId)) {
    const error = new Error("Die Capture-ID ist ungültig.");
    error.code = "INVALID_CAPTURE_ID";
    error.statusCode = 400;
    throw error;
  }
  return captureId;
}

/**
 * No contact, visible-message, gate, mapping or instruction input may be
 * client controlled.  Express may leave req.body undefined for an empty POST;
 * an explicit empty JSON object is also harmless and permitted.
 */
function assertEmptyDraftRequestBody(body) {
  if (body === undefined || body === null) return;
  if (!plainObject(body) || Object.keys(body).length !== 0) {
    const error = new Error("Die Draft-Anfrage darf keine Client-Daten enthalten.");
    error.code = "INVALID_TINDER_DRAFT_REQUEST";
    error.statusCode = 400;
    throw error;
  }
}

function isFoundationNotReadyError(error) {
  return TINDER_DRAFT_FOUNDATION_ERROR_CODES.has(error?.code);
}

function foundationNotReadyResponse(res) {
  return res.status(503).json({
    ok: false,
    code: "TINDER_DRAFT_FOUNDATION_NOT_READY",
    error: "Tinder Draft Foundation ist noch nicht migriert."
  });
}

function publicErrorMessage(error, status) {
  if (status >= 500) return "Tinder-Draft konnte nicht erstellt werden.";
  const message = String(error?.publicMessage || error?.message || "").trim();
  return message || "Tinder-Draft kann im aktuellen Zustand nicht erstellt werden.";
}

function safeStatusCode(error) {
  const status = Number(error?.statusCode);
  return [400, 404, 409, 422].includes(status) ? status : 500;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function requiredText(value, field, maximum = 4096) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maximum) {
    const error = new Error(`Tinder-Draft-Antwort enthält ein ungültiges Feld: ${field}.`);
    error.code = "INVALID_TINDER_DRAFT_RESULT";
    throw error;
  }
  return text;
}

/**
 * The route deliberately does not return capture messages, device gates or
 * the runtime fingerprint.  Draft creation itself is server-authoritative;
 * this presentation is only the bounded result needed by a future dashboard
 * review UI.
 */
function presentDraft(draft, expectedCaptureId) {
  if (!plainObject(draft)) {
    const error = new Error("Tinder-Draft-Antwort ist ungültig.");
    error.code = "INVALID_TINDER_DRAFT_RESULT";
    throw error;
  }

  const draftId = requiredText(draft.draftId ?? draft.draft_id, "draftId", 64);
  const captureId = requiredText(draft.captureId ?? draft.capture_id, "captureId", 64);
  const contactId = positiveInteger(draft.contactId ?? draft.contact_id);
  const captureRevision = positiveInteger(draft.captureRevision ?? draft.capture_revision);
  const identityRevision = positiveInteger(draft.identityRevision ?? draft.identity_revision);
  const createdAt = requiredText(draft.createdAt ?? draft.created_at, "createdAt", 64);
  const originalDraft = requiredText(draft.originalDraft ?? draft.original_draft, "originalDraft", 8000);
  const modelVersion = requiredText(draft.modelVersion ?? draft.model_version, "modelVersion", 160);
  const sourceLanguageValue = draft.sourceLanguage ?? draft.source_language;
  const sourceLanguage = sourceLanguageValue === null || sourceLanguageValue === undefined
    ? null
    : requiredText(sourceLanguageValue, "sourceLanguage", 32);
  const controlDraftValue = draft.controlDraftDe ?? draft.control_draft_de;
  const controlDraftDe = controlDraftValue === null || controlDraftValue === undefined
    ? null
    : requiredText(controlDraftValue, "controlDraftDe", 8000);

  if (!isUuidV4(draftId) || !isUuidV4(captureId) || captureId !== expectedCaptureId ||
      !contactId || !captureRevision || !identityRevision || draft.status !== "DRAFT" ||
      Number.isNaN(new Date(createdAt).valueOf())) {
    const error = new Error("Tinder-Draft-Antwort ist ungültig.");
    error.code = "INVALID_TINDER_DRAFT_RESULT";
    throw error;
  }

  return Object.freeze({
    draft_id: draftId,
    status: "DRAFT",
    contact_id: contactId,
    capture_id: captureId,
    capture_revision: captureRevision,
    identity_revision: identityRevision,
    original_draft: originalDraft,
    control_draft_de: controlDraftDe,
    source_language: sourceLanguage,
    model_version: modelVersion,
    created_at: new Date(createdAt).toISOString()
  });
}

function createTinderDashboardDraftHandler(draftService) {
  if (!draftService || typeof draftService.createDraft !== "function") {
    throw new TypeError("draftService.createDraft must be a function");
  }

  return async function tinderDashboardDraftHandler(req, res) {
    try {
      assertEmptyDraftRequestBody(req.body);
      const captureId = normalizeCaptureId(req.params?.captureId);
      // Intentionally the only client-derived service argument.
      const draft = await draftService.createDraft({ captureId });
      return res.status(201).json({ ok: true, draft: presentDraft(draft, captureId) });
    } catch (error) {
      if (isFoundationNotReadyError(error)) {
        return foundationNotReadyResponse(res);
      }
      const status = safeStatusCode(error);
      if (status === 500) {
        console.error("Tinder dashboard draft creation failed.");
      }
      return res.status(status).json({
        ok: false,
        code: error?.code || "TINDER_DRAFT_CREATE_FAILED",
        error: publicErrorMessage(error, status)
      });
    }
  };
}

function registerTinderDraftRoutes({
  app,
  dashboardApiReady,
  dashboardApiAuthorized,
  requireDeviceBridgeReady,
  draftService
} = {}) {
  if (!app || typeof app.post !== "function") {
    throw new TypeError("app.post must be a function");
  }
  if (typeof dashboardApiReady !== "function" ||
      typeof dashboardApiAuthorized !== "function" ||
      typeof requireDeviceBridgeReady !== "function") {
    throw new TypeError("dashboard and device bridge guards must be functions");
  }

  const createDraft = createTinderDashboardDraftHandler(draftService);
  const dashboard = (handler) => async (req, res) => {
    if (!dashboardApiReady(res)) return;
    if (!dashboardApiAuthorized(req)) {
      return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
    }
    if (!requireDeviceBridgeReady(res)) return;
    return handler(req, res);
  };

  app.post("/dashboard-api/tinder/captures/:captureId/drafts", dashboard(createDraft));
}

export {
  TINDER_DRAFT_FOUNDATION_ERROR_CODES,
  assertEmptyDraftRequestBody,
  createTinderDashboardDraftHandler,
  isFoundationNotReadyError,
  normalizeCaptureId,
  presentDraft,
  registerTinderDraftRoutes
};
