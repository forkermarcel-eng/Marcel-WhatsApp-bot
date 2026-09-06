import { isUuidV4 } from "./protocol-v1.js";
import {
  createPgTinderCaptureRepository,
  createTinderCaptureStore,
  TINDER_PENDING_HUMAN_MAPPING_LIMIT
} from "../services/tinder-capture-store.js";
import {
  TinderHumanMappingError,
  createPgTinderHumanMappingRepository,
  createTinderHumanMappingService
} from "../services/tinder-human-mapping.js";
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

function normalizeCaptureRecord(row) {
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

  return Object.freeze({
    capture_id: captureId,
    device_id: deviceId,
    capture_revision: captureRevision,
    mapping_status: mappingStatus,
    human_review_status: reviewStatus,
    visible_name: visibleName,
    source_package: sourcePackage,
    captured_at: timestamp(row?.capturedAt ?? row?.captured_at),
    received_at: timestamp(row?.receivedAt ?? row?.received_at)
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

function createTinderDashboardCaptureReadHandler(pool, {
  createRepository = createPgTinderCaptureRepository,
  createStore = createTinderCaptureStore
} = {}) {
  const store = createStore(createRepository(pool));
  return async function tinderDashboardCaptureReadHandler(req, res) {
    try {
      const capture = await store.getCapture(normalizeCaptureId(req.params.captureId));
      if (!capture) {
        const error = new Error("Capture was not found.");
        error.statusCode = 404;
        error.code = "CAPTURE_NOT_FOUND";
        throw error;
      }
      return res.status(200).json({ ok: true, capture: normalizeCaptureRecord(capture) });
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

function registerTinderCaptureRoutes({
  app,
  pool,
  dashboardApiReady,
  dashboardApiAuthorized,
  requireDeviceBridgeReady
}) {
  const listPendingCaptures = createTinderDashboardPendingCaptureListHandler(pool);
  const readCapture = createTinderDashboardCaptureReadHandler(pool);
  const mapCapture = createTinderDashboardMappingHandler(pool);
  const dashboard = (handler) => async (req, res) => {
    if (!dashboardApiReady(res)) return;
    if (!dashboardApiAuthorized(req)) return res.status(401).json({ ok: false, error: "Not authorized." });
    if (!requireDeviceBridgeReady(res)) return;
    return handler(req, res);
  };

  app.get("/dashboard-api/tinder/captures/pending", dashboard(listPendingCaptures));
  app.get("/dashboard-api/tinder/captures/:captureId", dashboard(readCapture));
  app.post("/dashboard-api/tinder/captures/:captureId/mapping", dashboard(mapCapture));
}

export {
  TINDER_CAPTURE_MAPPING_BODY_FIELDS,
  assertMappingBody,
  createTinderDashboardCaptureReadHandler,
  createTinderDashboardPendingCaptureListHandler,
  createTinderDashboardMappingHandler,
  isFoundationNotReadyError,
  normalizeCaptureRecord,
  normalizePendingCaptureRecords,
  registerTinderCaptureRoutes
};
