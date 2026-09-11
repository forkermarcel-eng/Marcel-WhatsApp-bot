import crypto from "crypto";

const ALLOWED_COMMANDS = new Set(["PING", "REQUEST_STATUS", "CONNECT_TINDER", "DISCONNECT_TINDER"]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INBOX_NAVIGATION_STAGES = new Set([
  "IDLE", "AWAITING_INBOX", "AWAITING_OFFICIAL_RESUME_HANDOFF",
  "AWAITING_INBOX_TAB_ACTION", "INBOX_READY", "AWAITING_ROW_OPEN",
  "ROW_ACTION_ISSUED", "AWAITING_CHAT", "CHAT_VERIFIED", "BLOCKED"
]);
const INBOX_NAVIGATION_REASONS = new Set([
  "NONE", "RUNTIME_GATE", "HUMAN_CALIBRATION_ACTIVE", "OPERATION_IN_PROGRESS",
  "ACCESSIBILITY_UNAVAILABLE", "OFFICIAL_RESUME_HANDOFF_FAILED", "FOREGROUND_WAIT_TIMEOUT",
  "SENSITIVE_SCREEN", "DISCOVERY_STRUCTURE_REJECTED", "INBOX_TAB_TARGET_DRIFT",
  "INBOX_TAB_ACTION_REJECTED", "INBOX_TRANSITION_TIMEOUT", "UNKNOWN_INBOX_STRUCTURE",
  "NO_ELIGIBLE_CONVERSATION", "ROW_SELECTION_UNAVAILABLE", "SNAPSHOT_EXPIRED",
  "ROW_TARGET_DRIFT", "ROW_ACTION_REJECTED", "CHAT_VERIFICATION_TIMEOUT",
  "CHAT_STRUCTURE_REJECTED", "ACCESSIBILITY_INTERRUPTED", "ACCESSIBILITY_UNBOUND",
  "ACCESSIBILITY_DESTROYED", "BRIDGE_NOT_RUNNING", "TINDER_GATE_NOT_CONNECTED",
  "LIFECYCLE_RESET", "LOCAL_STATE_UNAVAILABLE"
]);
const INBOX_NAVIGATION_FIELDS = Object.freeze([
  "stage", "reason", "visible_conversation_count", "observed_event_count"
]);
const LEGACY_DEVICE_STATUS_FIELDS = Object.freeze([
  "device_id", "display_name", "enrollment_state", "device_status", "enrolled_at",
  "last_heartbeat_accepted_at", "app_version", "app_build", "bridge_service_state",
  "tinder_state", "automation_state", "tinder_manual_gate_capable",
  "tinder_local_conversation_attestation_post_chat_capable", "configuration_revision"
]);

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";").map(cookie => cookie.trim());
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

async function readJson(response, res) {
  const rawText = await response.text();
  try {
    return rawText ? JSON.parse(rawText) : {};
  } catch {
    res.status(502).json({ ok: false, error: "Ungültige Antwort vom Backend." });
    return null;
  }
}

function backendHeaders(configuration, withBody = false) {
  return {
    Authorization: `Bearer ${configuration.dashboardApiSecret}`,
    Accept: "application/json",
    ...(withBody ? { "Content-Type": "application/json" } : {})
  };
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function normalizePublicInboxNavigation(value) {
  if (value === null) return null;
  if (!exactKeys(value, INBOX_NAVIGATION_FIELDS)
      || !INBOX_NAVIGATION_STAGES.has(value.stage)
      || !INBOX_NAVIGATION_REASONS.has(value.reason)
      || !Number.isSafeInteger(value.visible_conversation_count)
      || value.visible_conversation_count < 0 || value.visible_conversation_count > 8
      || !Number.isSafeInteger(value.observed_event_count)
      || value.observed_event_count < 0 || value.observed_event_count > 8) {
    return null;
  }
  return Object.freeze({
    stage: value.stage,
    reason: value.reason,
    visible_conversation_count: value.visible_conversation_count,
    observed_event_count: value.observed_event_count
  });
}

/**
 * Preserve the pre-existing device-status fields without changing their
 * validation semantics, while explicitly allowlisting the new optional
 * heartbeat diagnostic. This prevents raw audit JSON from crossing the
 * Vercel boundary without turning unrelated legacy status variation into an
 * outage.
 */
function sanitizePublicDeviceStatus(value) {
  if (!plainObject(value)) return null;
  const hasInboxNavigation = Object.hasOwn(value, "inbox_navigation");
  // The server only projects a heartbeat observation while the device is
  // ONLINE. Keep that freshness boundary at the public proxy too, so an
  // unexpected/stale upstream payload cannot make an offline observation
  // visible in the dashboard.
  const inboxNavigation = String(value.device_status || "").toUpperCase() === "ONLINE" && hasInboxNavigation
    ? normalizePublicInboxNavigation(value.inbox_navigation)
    : null;
  return Object.freeze({
    ...Object.fromEntries(LEGACY_DEVICE_STATUS_FIELDS.map(field => [field, value[field]])),
    // This is a bounded derived compatibility bit, not the raw capability
    // array. Missing/legacy upstream values are conservatively false.
    tinder_local_conversation_attestation_post_chat_capable:
      value.tinder_local_conversation_attestation_post_chat_capable === true,
    inbox_navigation: inboxNavigation
  });
}

async function listDevices(res, configuration) {
  try {
    const railwayResponse = await fetch(
      configuration.railwayBackendUrl + "/dashboard-api/device-bridge/devices",
      { method: "GET", headers: backendHeaders(configuration), cache: "no-store" }
    );
    const data = await readJson(railwayResponse, res);
    if (!data) return;
    if (!railwayResponse.ok) {
      if (railwayResponse.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      return res.status(502).json({
        ok: false,
        error: data?.error?.message || data?.error || "Gerätestatus konnte nicht geladen werden."
      });
    }
    if (!Array.isArray(data?.devices)) {
      return res.status(502).json({ ok: false, error: "Ungültige Geräteantwort vom Backend." });
    }
    const devices = data.devices.map(sanitizePublicDeviceStatus);
    if (devices.some(device => device === null)) {
      return res.status(502).json({ ok: false, error: "Ung\u00fcltige Ger\u00e4teantwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, server_time: data.server_time, devices });
  } catch {
    console.error("Verbindung zum Device-Bridge-Status fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

async function createCommand(req, res, configuration) {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 2 || typeof body.device_id !== "string" ||
      typeof body.type !== "string") {
    return res.status(400).json({ ok: false, error: "Ungültige Command-Anfrage." });
  }
  if (!UUID_V4.test(body.device_id)) {
    return res.status(400).json({ ok: false, error: "Ungültige Device-ID." });
  }
  if (!ALLOWED_COMMANDS.has(body.type)) {
    return res.status(400).json({ ok: false, error: "Command ist nicht erlaubt." });
  }
  const railwayPath = `/dashboard-api/device-bridge/devices/${body.device_id}/commands`;
  try {
    const railwayResponse = await fetch(configuration.railwayBackendUrl + railwayPath, {
      method: "POST",
      headers: backendHeaders(configuration, true),
      body: JSON.stringify({ type: body.type }),
      cache: "no-store"
    });
    const data = await readJson(railwayResponse, res);
    if (!data) return;
    if (!railwayResponse.ok) {
      if (railwayResponse.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      const status = [400, 403, 404, 409, 429].includes(railwayResponse.status)
        ? railwayResponse.status : 502;
      return res.status(status).json({
        ok: false,
        error: data?.error?.message || "Command konnte nicht erstellt werden.",
        code: data?.error?.code || ""
      });
    }
    const command = data?.command;
    if (!command || !UUID_V4.test(command.command_id) || command.type !== body.type) {
      return res.status(502).json({ ok: false, error: "Ungültige Command-Antwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(201).json({
      ok: true,
      command: {
        command_id: command.command_id,
        type: command.type,
        issued_at: command.issued_at,
        expires_at: command.expires_at,
        configuration_revision: command.configuration_revision
      }
    });
  } catch {
    console.error("Verbindung zur Device-Bridge-Command-Erstellung fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

async function readCommandStatus(req, res, configuration) {
  const deviceId = typeof req.query?.deviceId === "string" ? req.query.deviceId : "";
  const commandId = typeof req.query?.commandId === "string" ? req.query.commandId : "";
  if (!UUID_V4.test(deviceId)) {
    return res.status(400).json({ ok: false, error: "Ungültige Device-ID." });
  }
  if (!UUID_V4.test(commandId)) {
    return res.status(400).json({ ok: false, error: "Ungültige Command-ID." });
  }
  const railwayPath = `/dashboard-api/device-bridge/devices/${deviceId}/commands/${commandId}`;
  try {
    const railwayResponse = await fetch(configuration.railwayBackendUrl + railwayPath, {
      method: "GET",
      headers: backendHeaders(configuration),
      cache: "no-store"
    });
    const data = await readJson(railwayResponse, res);
    if (!data) return;
    if (!railwayResponse.ok) {
      if (railwayResponse.status === 401) {
        return res.status(502).json({ ok: false, error: "Dashboard-Backend konnte nicht autorisiert werden." });
      }
      const status = [400, 404].includes(railwayResponse.status) ? railwayResponse.status : 502;
      return res.status(status).json({
        ok: false,
        error: data?.error?.message || "Command-Status konnte nicht geladen werden.",
        code: data?.error?.code || ""
      });
    }
    if (!data?.command || data.command.command_id !== commandId || data.command.device_id !== deviceId) {
      return res.status(502).json({ ok: false, error: "Ungültige Command-Status-Antwort vom Backend." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, server_time: data.server_time, command: data.command });
  } catch {
    console.error("Verbindung zum Device-Bridge-Command-Status fehlgeschlagen.");
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}

export default async function handler(req, res) {
  if (!new Set(["GET", "POST"]).has(req.method)) {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ ok: false, error: "Methode nicht erlaubt." });
  }
  if (!validDashboardSession(req)) {
    return res.status(401).json({ ok: false, error: "Nicht angemeldet." });
  }
  const configuration = backendConfiguration(res);
  if (!configuration) return;
  if (req.method === "POST") return createCommand(req, res, configuration);
  const hasCommandQuery = req.query?.deviceId !== undefined || req.query?.commandId !== undefined;
  return hasCommandQuery
    ? readCommandStatus(req, res, configuration)
    : listDevices(res, configuration);
}

export { ALLOWED_COMMANDS };
