import { isUuidV4 } from "./protocol-v1.js";

/* ==================================================
T5 HUMAN-APPROVED TINDER SEND -- DASHBOARD ROUTES

The browser may express one explicit human action only.  It can never supply
text, hashes, contact/device/thread identifiers, timing, payloads, or a
generic Device Bridge command.  All binding truth is loaded and locked by the
server-side T5 service.

These are dashboard review/reservation routes only.  They do not register a
device route and cannot send or access Tinder.
================================================== */

const TINDER_SEND_FOUNDATION_ERROR_CODES = new Set([
  "42P01", // undefined_table
  "42703", // undefined_column
  "23502"  // foundation row unavailable
]);
const TINDER_OPEN_DRAFT_REVIEW_LIMIT = 25;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeDraftId(value) {
  const draftId = String(value || "").trim();
  if (!isUuidV4(draftId)) {
    const error = new Error("Die Draft-ID ist ungültig.");
    error.code = "INVALID_DRAFT_ID";
    error.statusCode = 400;
    throw error;
  }
  return draftId;
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

function assertExactAction(body, action) {
  if (!plainObject(body) || Object.keys(body).length !== 1 || body.action !== action) {
    const error = new Error("Die T5-Aktion darf keine Client-Daten enthalten.");
    error.code = "INVALID_TINDER_SEND_REQUEST";
    error.statusCode = 400;
    throw error;
  }
}

function safeStatusCode(error) {
  const status = Number(error?.statusCode);
  return [400, 404, 409, 422].includes(status) ? status : 500;
}

function isFoundationNotReadyError(error) {
  return TINDER_SEND_FOUNDATION_ERROR_CODES.has(error?.code);
}

function foundationNotReadyResponse(res) {
  return res.status(503).json({
    ok: false,
    code: "TINDER_SEND_FOUNDATION_NOT_READY",
    error: "Tinder Send Foundation ist noch nicht migriert."
  });
}

function publicErrorMessage(error, status) {
  if (status >= 500) return "Tinder-Freigabe konnte nicht verarbeitet werden.";
  const message = String(error?.publicMessage || error?.message || "").trim();
  return message || "Tinder-Freigabe kann im aktuellen Zustand nicht verarbeitet werden.";
}

function boundedResult(value) {
  if (!plainObject(value)) {
    const error = new Error("Die Tinder-Send-Antwort ist ungültig.");
    error.code = "INVALID_TINDER_SEND_RESULT";
    throw error;
  }
  const result = {};
  for (const key of [
    "approvalId", "intentId", "commandId", "draftId", "draftRevision",
    "state", "approvedAt", "receivedAt", "completedAt", "resultCode", "idempotent"
  ]) {
    if (Object.hasOwn(value, key)) result[key] = value[key];
  }
  if (!result.draftId || !isUuidV4(result.draftId) ||
      !Number.isSafeInteger(result.draftRevision) || result.draftRevision < 1 ||
      typeof result.state !== "string" || !result.state) {
    const error = new Error("Die Tinder-Send-Antwort ist ungültig.");
    error.code = "INVALID_TINDER_SEND_RESULT";
    throw error;
  }
  if (result.approvalId !== undefined && !isUuidV4(result.approvalId)) throw new Error("Ungültige Freigabe-Antwort.");
  if (result.intentId !== undefined && !isUuidV4(result.intentId)) throw new Error("Ungültige Intent-Antwort.");
  if (result.commandId !== undefined && !isUuidV4(result.commandId)) throw new Error("Ungültige Command-Antwort.");
  if (result.idempotent !== undefined && typeof result.idempotent !== "boolean") throw new Error("Ungültige Intent-Antwort.");
  return Object.freeze(result);
}

function boundedDraftReview(value, expectedCaptureId) {
  if (!plainObject(value)) {
    const error = new Error("Die Tinder-Draft-Prüfung ist ungültig.");
    error.code = "INVALID_TINDER_DRAFT_REVIEW";
    throw error;
  }
  const draftId = normalizeDraftId(value.draftId ?? value.draft_id);
  const captureId = normalizeCaptureId(value.captureId ?? value.capture_id);
  const draftRevision = Number(value.draftRevision ?? value.draft_revision);
  const captureRevision = Number(value.captureRevision ?? value.capture_revision);
  const identityRevision = Number(value.identityRevision ?? value.identity_revision);
  const status = String(value.status || "").trim().toUpperCase();
  const approvalStateValue = value.approvalState ?? value.approval_state;
  const approvalState = approvalStateValue === null || approvalStateValue === undefined
    ? null : String(approvalStateValue).trim().toUpperCase();
  const intentStateValue = value.intentState ?? value.intent_state;
  const intentState = intentStateValue === null || intentStateValue === undefined
    ? null : String(intentStateValue).trim().toUpperCase();
  const originalDraft = typeof (value.originalDraft ?? value.original_draft) === "string"
    ? (value.originalDraft ?? value.original_draft).trim() : "";
  const controlDraftValue = value.controlDraftDe ?? value.control_draft_de;
  const controlDraftDe = controlDraftValue === null || controlDraftValue === undefined
    ? null : typeof controlDraftValue === "string" ? controlDraftValue.trim() : "";
  const sourceLanguageValue = value.sourceLanguage ?? value.source_language;
  const sourceLanguage = sourceLanguageValue === null || sourceLanguageValue === undefined
    ? null : String(sourceLanguageValue).trim();
  const modelVersion = String(value.modelVersion ?? value.model_version ?? "").trim();
  const createdAt = String(value.createdAt ?? value.created_at ?? "").trim();
  const allowedDraftStates = new Set(["DRAFT", "APPROVED", "REJECTED", "STALE"]);
  const allowedApprovalStates = new Set(["ACTIVE", "INVALIDATED", "CANCELLED"]);
  const allowedIntentStates = new Set([
    "PENDING_T5_WRITER", "DISPATCHING", "SENT", "FAILED", "STALE", "CANCELLED", "SEND_RESULT_UNKNOWN"
  ]);
  if (captureId !== expectedCaptureId || !Number.isSafeInteger(draftRevision) || draftRevision < 1 ||
      !Number.isSafeInteger(captureRevision) || captureRevision < 1 ||
      !Number.isSafeInteger(identityRevision) || identityRevision < 1 ||
      !allowedDraftStates.has(status) ||
      (approvalState !== null && !allowedApprovalStates.has(approvalState)) ||
      (intentState !== null && !allowedIntentStates.has(intentState)) ||
      !originalDraft || originalDraft.length > 8000 ||
      (controlDraftDe !== null && (!controlDraftDe || controlDraftDe.length > 8000)) ||
      (sourceLanguage !== null && !/^[A-Za-z-]{2,32}$/.test(sourceLanguage)) ||
      !modelVersion || modelVersion.length > 160 || Number.isNaN(new Date(createdAt).valueOf())) {
    const error = new Error("Die Tinder-Draft-Prüfung ist ungültig.");
    error.code = "INVALID_TINDER_DRAFT_REVIEW";
    throw error;
  }
  return Object.freeze({
    draftId,
    captureId,
    draftRevision,
    captureRevision,
    identityRevision,
    status,
    approvalState,
    intentState,
    originalDraft,
    controlDraftDe,
    sourceLanguage,
    modelVersion,
    createdAt: new Date(createdAt).toISOString()
  });
}

/*
 * This is a selector for the existing T4/T5 review screen, not a second
 * review representation. The capture UUID is only an opaque browser handle
 * for the already protected capture-detail reader.
 */
function boundedOpenDraftReviews(value) {
  if (!Array.isArray(value) || value.length > TINDER_OPEN_DRAFT_REVIEW_LIMIT) {
    const error = new Error("Die offenen Tinder-Draft-Prüfungen sind ungültig.");
    error.code = "INVALID_OPEN_DRAFT_REVIEWS";
    throw error;
  }
  return Object.freeze(value.map((entry) => {
    if (!plainObject(entry)) {
      const error = new Error("Die offene Tinder-Draft-Prüfung ist ungültig.");
      error.code = "INVALID_OPEN_DRAFT_REVIEW";
      throw error;
    }
    const captureId = normalizeCaptureId(entry.captureId ?? entry.capture_id);
    const visibleName = String(entry.visibleName ?? entry.visible_name ?? "").trim();
    const status = String(entry.status ?? entry.draftStatus ?? entry.draft_status ?? "").trim().toUpperCase();
    if (!visibleName || visibleName.length > 240 || !["DRAFT", "APPROVED", "STALE"].includes(status)) {
      const error = new Error("Die offene Tinder-Draft-Prüfung ist ungültig.");
      error.code = "INVALID_OPEN_DRAFT_REVIEW";
      throw error;
    }
    return Object.freeze({ captureId, visibleName, status });
  }));
}

function createTinderDashboardDraftReviewHandler(service) {
  if (!service || typeof service.getDraftReviewForCapture !== "function") {
    throw new TypeError("service.getDraftReviewForCapture must be a function");
  }
  return async function tinderDashboardDraftReviewHandler(req, res) {
    try {
      const captureId = normalizeCaptureId(req.params?.captureId);
      const review = boundedDraftReview(
        await service.getDraftReviewForCapture({ captureId }),
        captureId
      );
      return res.status(200).json({ ok: true, review });
    } catch (error) {
      if (isFoundationNotReadyError(error)) return foundationNotReadyResponse(res);
      const status = safeStatusCode(error);
      if (status === 500) console.error("Tinder dashboard draft review failed.");
      return res.status(status).json({ ok: false, code: error?.code || "TINDER_DRAFT_REVIEW_FAILED", error: publicErrorMessage(error, status) });
    }
  };
}

function createTinderDashboardOpenDraftReviewsHandler(service) {
  if (!service || typeof service.listOpenDraftReviews !== "function") {
    throw new TypeError("service.listOpenDraftReviews must be a function");
  }
  return async function tinderDashboardOpenDraftReviewsHandler(_req, res) {
    try {
      const reviews = boundedOpenDraftReviews(await service.listOpenDraftReviews());
      return res.status(200).json({ ok: true, reviews });
    } catch (error) {
      if (isFoundationNotReadyError(error)) return foundationNotReadyResponse(res);
      const status = safeStatusCode(error);
      if (status === 500) console.error("Tinder dashboard open draft reviews failed.");
      return res.status(status).json({ ok: false, code: error?.code || "TINDER_OPEN_DRAFT_REVIEWS_FAILED", error: publicErrorMessage(error, status) });
    }
  };
}

function createTinderDashboardApproveHandler(service) {
  if (!service || typeof service.approveDraft !== "function") throw new TypeError("service.approveDraft must be a function");
  return async function tinderDashboardApproveHandler(req, res) {
    try {
      assertExactAction(req.body, "APPROVE");
      const result = boundedResult(await service.approveDraft({
        draftId: normalizeDraftId(req.params?.draftId),
        actor: "marcel_dashboard"
      }));
      return res.status(result.idempotent ? 200 : 201).json({ ok: true, approval: result });
    } catch (error) {
      if (isFoundationNotReadyError(error)) return foundationNotReadyResponse(res);
      const status = safeStatusCode(error);
      if (status === 500) console.error("Tinder dashboard approval failed.");
      return res.status(status).json({ ok: false, code: error?.code || "TINDER_APPROVAL_FAILED", error: publicErrorMessage(error, status) });
    }
  };
}

function createTinderDashboardDispatchHandler(service) {
  if (!service || typeof service.reserveApprovedSend !== "function") throw new TypeError("service.reserveApprovedSend must be a function");
  return async function tinderDashboardDispatchHandler(req, res) {
    try {
      assertExactAction(req.body, "DISPATCH");
      const result = boundedResult(await service.reserveApprovedSend({
        draftId: normalizeDraftId(req.params?.draftId),
        actor: "marcel_dashboard"
      }));
      // The server creates a sealed, device-scoped signed command together
      // with the reservation.  The present Android contract still terminates
      // it fail-closed as TINDER_WRITER_NOT_IMPLEMENTED; this route never
      // writes Tinder or exposes a generic device-command surface.
      return res.status(result.idempotent ? 200 : 202).json({ ok: true, intent: result });
    } catch (error) {
      if (isFoundationNotReadyError(error)) return foundationNotReadyResponse(res);
      const status = safeStatusCode(error);
      if (status === 500) console.error("Tinder dashboard send reservation failed.");
      return res.status(status).json({ ok: false, code: error?.code || "TINDER_SEND_RESERVATION_FAILED", error: publicErrorMessage(error, status) });
    }
  };
}

function createTinderDashboardRejectHandler(service) {
  if (!service || typeof service.rejectDraft !== "function") throw new TypeError("service.rejectDraft must be a function");
  return async function tinderDashboardRejectHandler(req, res) {
    try {
      assertExactAction(req.body, "REJECT");
      const result = boundedResult(await service.rejectDraft({
        draftId: normalizeDraftId(req.params?.draftId),
        actor: "marcel_dashboard"
      }));
      return res.status(200).json({ ok: true, draft: result });
    } catch (error) {
      if (isFoundationNotReadyError(error)) return foundationNotReadyResponse(res);
      const status = safeStatusCode(error);
      if (status === 500) console.error("Tinder dashboard draft rejection failed.");
      return res.status(status).json({ ok: false, code: error?.code || "TINDER_DRAFT_REJECT_FAILED", error: publicErrorMessage(error, status) });
    }
  };
}

function createTinderDashboardCancelHandler(service) {
  if (!service || typeof service.cancelApprovedSend !== "function") throw new TypeError("service.cancelApprovedSend must be a function");
  return async function tinderDashboardCancelHandler(req, res) {
    try {
      assertExactAction(req.body, "CANCEL");
      const result = boundedResult(await service.cancelApprovedSend({
        draftId: normalizeDraftId(req.params?.draftId),
        actor: "marcel_dashboard"
      }));
      return res.status(200).json({ ok: true, result });
    } catch (error) {
      if (isFoundationNotReadyError(error)) return foundationNotReadyResponse(res);
      const status = safeStatusCode(error);
      if (status === 500) console.error("Tinder dashboard approval cancellation failed.");
      return res.status(status).json({ ok: false, code: error?.code || "TINDER_SEND_CANCEL_FAILED", error: publicErrorMessage(error, status) });
    }
  };
}

function registerTinderManualSendRoutes({
  app,
  dashboardApiReady,
  dashboardApiAuthorized,
  requireDeviceBridgeReady,
  service
} = {}) {
  if (!app || typeof app.get !== "function" || typeof app.post !== "function") {
    throw new TypeError("app.get and app.post must be functions");
  }
  if (typeof dashboardApiReady !== "function" || typeof dashboardApiAuthorized !== "function" ||
      typeof requireDeviceBridgeReady !== "function") {
    throw new TypeError("dashboard and device bridge guards must be functions");
  }
  const dashboard = (handler) => async (req, res) => {
    if (!dashboardApiReady(res)) return;
    if (!dashboardApiAuthorized(req)) return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
    if (!requireDeviceBridgeReady(res)) return;
    return handler(req, res);
  };
  app.get("/dashboard-api/tinder/drafts/open-reviews", dashboard(createTinderDashboardOpenDraftReviewsHandler(service)));
  app.get("/dashboard-api/tinder/captures/:captureId/draft-review", dashboard(createTinderDashboardDraftReviewHandler(service)));
  app.post("/dashboard-api/tinder/drafts/:draftId/approval", dashboard(createTinderDashboardApproveHandler(service)));
  app.post("/dashboard-api/tinder/drafts/:draftId/dispatch", dashboard(createTinderDashboardDispatchHandler(service)));
  app.post("/dashboard-api/tinder/drafts/:draftId/reject", dashboard(createTinderDashboardRejectHandler(service)));
  app.post("/dashboard-api/tinder/drafts/:draftId/cancel", dashboard(createTinderDashboardCancelHandler(service)));
}

export {
  TINDER_SEND_FOUNDATION_ERROR_CODES,
  assertExactAction,
  boundedDraftReview,
  boundedOpenDraftReviews,
  boundedResult,
  createTinderDashboardApproveHandler,
  createTinderDashboardCancelHandler,
  createTinderDashboardDraftReviewHandler,
  createTinderDashboardOpenDraftReviewsHandler,
  createTinderDashboardDispatchHandler,
  createTinderDashboardRejectHandler,
  normalizeCaptureId,
  normalizeDraftId,
  registerTinderManualSendRoutes
};
