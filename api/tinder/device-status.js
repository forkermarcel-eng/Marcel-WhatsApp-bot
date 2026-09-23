import crypto from "crypto";

// This endpoint is intentionally limited to generic enrolled-device status.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATUS_TOKEN = /^[A-Z0-9_]{1,48}$/;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getCookie(req, name) {
  const cookies = String(req.headers?.cookie || "").split(";").map((cookie) => cookie.trim());
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
  const [token, receivedSignature, ...rest] = session.split(".");
  if (!token || !receivedSignature || rest.length !== 0) return false;
  const expectedSignature = crypto.createHmac("sha256", password).update(token).digest("hex");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const receivedBuffer = Buffer.from(receivedSignature, "utf8");
  return expectedBuffer.length === receivedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function backendConfiguration(res) {
  const railwayBackendUrl = String(process.env.RAILWAY_BACKEND_URL || "").trim().replace(/\/+$/, "");
  const dashboardApiSecret = String(process.env.DASHBOARD_API_SECRET || "").trim();
  if (!railwayBackendUrl || !dashboardApiSecret) {
    res.status(500).json({ ok: false, error: "Dashboard-Verbindung ist nicht konfiguriert." });
    return null;
  }
  return Object.freeze({ railwayBackendUrl, dashboardApiSecret });
}

function normalizeTimestamp(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? null : timestamp.toISOString();
}

function normalizeStatusToken(value) {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  return STATUS_TOKEN.test(normalized) ? normalized : "UNKNOWN";
}

function normalizeBoundedText(value, maximum) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : null;
}

function sanitizePublicDeviceStatus(value) {
  if (!plainObject(value)
      || typeof value.device_id !== "string" || !UUID_V4.test(value.device_id)
      || !normalizeBoundedText(value.display_name, 160)) {
    return null;
  }
  const enrolledAt = normalizeTimestamp(value.enrolled_at);
  if (!enrolledAt) return null;
  const appVersion = typeof value.app_version === "string" || typeof value.app_version === "number"
    ? normalizeBoundedText(String(value.app_version), 80)
    : null;
  const appBuild = Number.isSafeInteger(value.app_build) && value.app_build >= 0
    ? value.app_build
    : null;
  const configurationRevision = Number.isSafeInteger(value.configuration_revision)
    && value.configuration_revision >= 0 && value.configuration_revision <= 1_000_000
    ? value.configuration_revision
    : null;
  return Object.freeze({
    device_id: value.device_id,
    display_name: value.display_name.trim(),
    enrollment_state: normalizeStatusToken(value.enrollment_state),
    device_status: normalizeStatusToken(value.device_status),
    enrolled_at: enrolledAt,
    last_heartbeat_accepted_at: normalizeTimestamp(value.last_heartbeat_accepted_at),
    app_version: appVersion,
    app_build: appBuild,
    bridge_service_state: normalizeStatusToken(value.bridge_service_state),
    configuration_revision: configurationRevision
  });
}

function backendHeaders(configuration) {
  return {
    Authorization: `Bearer ${configuration.dashboardApiSecret}`,
    Accept: "application/json"
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

async function listDevices(res, configuration) {
  try {
    const response = await fetch(
      `${configuration.railwayBackendUrl}/dashboard-api/device-bridge/devices`,
      { method: "GET", headers: backendHeaders(configuration), cache: "no-store" }
    );
    const data = await readJson(response, res);
    if (!data) return;
    if (!response.ok) {
      if (response.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      return res.status(502).json({ ok: false, error: "Gerätestatus konnte nicht geladen werden." });
    }
    if (data?.ok !== true || !Array.isArray(data.devices)) {
      return res.status(502).json({ ok: false, error: "Ungültige Geräteantwort vom Backend." });
    }
    const devices = data.devices.map(sanitizePublicDeviceStatus);
    if (devices.some((device) => device === null)) {
      return res.status(502).json({ ok: false, error: "Ungültige Geräteantwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, devices });
  } catch {
    console.error("Verbindung zum Device-Bridge-Status fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Methode nicht erlaubt." });
  }
  if (!validDashboardSession(req)) {
    return res.status(401).json({ ok: false, error: "Nicht angemeldet." });
  }
  if (!plainObject(req.query) || Object.keys(req.query).length !== 0) {
    return res.status(410).json({
      ok: false,
      error: "Dieser frühere Tinder-Endpunkt ist nicht mehr aktiv."
    });
  }
  const configuration = backendConfiguration(res);
  if (!configuration) return;
  return listDevices(res, configuration);
}

export { sanitizePublicDeviceStatus };
