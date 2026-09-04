import crypto from "crypto";

const ALLOWED_COMMANDS = new Set(["PING", "REQUEST_STATUS", "CONNECT_TINDER", "DISCONNECT_TINDER"]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json({ ok: true, server_time: data.server_time, devices: data.devices });
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
