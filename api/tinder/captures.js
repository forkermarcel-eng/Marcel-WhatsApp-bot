import crypto from "crypto";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAPPING_FIELDS = new Set([
  "action",
  "contact_id",
  "new_contact_name",
  "tinder_identifier",
  "confirmed"
]);
const PUBLIC_CAPTURE_MAPPING_STATUSES = new Set(["NEEDS_HUMAN_MAPPING", "RESOLVED", "CONFLICT"]);
const PUBLIC_CAPTURE_REVIEW_STATUSES = new Set(["PENDING", "CONFIRMED", "REJECTED"]);
const PUBLIC_MAPPING_SUCCESS_STATUSES = new Set(["RESOLVED", "NEW_CONTACT_CONFIRMED"]);
const PUBLIC_MAPPING_ERROR_STATUSES = new Set(["CONFLICT", "NEEDS_HUMAN_MAPPING", "UNSAFE"]);

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

  return Object.freeze({
    capture_id: value.capture_id,
    device_id: value.device_id,
    capture_revision: value.capture_revision,
    mapping_status: value.mapping_status,
    human_review_status: value.human_review_status,
    visible_name: value.visible_name.trim(),
    source_package: value.source_package,
    captured_at: capturedAt,
    received_at: receivedAt
  });
}

function validPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
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

function captureIdFromQuery(req) {
  const query = req.query || {};
  if (!exactKeys(query, ["captureId"]) || !validCaptureId(query.captureId)) return null;
  return query.captureId;
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

export default async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Methode nicht erlaubt." });
  }
  if (!validDashboardSession(req)) {
    return res.status(401).json({ ok: false, error: "Nicht angemeldet." });
  }

  const captureId = captureIdFromQuery(req);
  if (!captureId) {
    return res.status(400).json({ ok: false, error: "Ungültige Capture-ID." });
  }
  if (req.method === "POST" && !validMappingBody(req.body)) {
    return res.status(400).json({ ok: false, error: "Ungültige Mapping-Anfrage." });
  }

  const configuration = backendConfiguration(res);
  if (!configuration) return;
  return req.method === "GET"
    ? forwardCaptureRead(res, configuration, captureId)
    : forwardHumanMapping(req, res, configuration, captureId);
}

export {
  MAPPING_FIELDS,
  normalizePublicCapture,
  normalizePublicMappingErrorResult,
  normalizePublicMappingResult,
  validCaptureId,
  validMappingBody
};
