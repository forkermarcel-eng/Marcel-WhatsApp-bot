import crypto from "crypto";

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || "").split(";").map((value) => value.trim());
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator > 0 && cookie.slice(0, separator) === name) return cookie.slice(separator + 1);
  }
  return null;
}

function hasDashboardSession(req) {
  const password = process.env.DASHBOARD_PASSWORD;
  const session = cookieValue(req, "marcel_dashboard_session");
  if (!password || !session) return false;
  const [token, signature, ...rest] = session.split(".");
  if (!token || !signature || rest.length !== 0) return false;
  const expected = crypto.createHmac("sha256", password).update(token).digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(signature, "utf8");
  return expectedBuffer.length === receivedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

function validUuid(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/*
 * Read-only dashboard proxy.  Appium never sends observations through this
 * browser endpoint; the thin host adapter uses the existing backend bearer
 * transport directly.
 */
export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Methode nicht erlaubt." });
  }
  if (!hasDashboardSession(req)) {
    return res.status(401).json({ ok: false, error: "Nicht angemeldet." });
  }
  const backendUrl = String(process.env.RAILWAY_BACKEND_URL || "").trim().replace(/\/+$/, "");
  const bearer = String(process.env.DASHBOARD_API_SECRET || "").trim();
  if (!backendUrl || !bearer) {
    return res.status(500).json({ ok: false, error: "Dashboard-Verbindung ist nicht konfiguriert." });
  }

  const id = req.query?.id;
  if (id !== undefined && !validUuid(id)) {
    return res.status(400).json({ ok: false, error: "Ungültige Conversation-ID." });
  }
  const path = id
    ? `/dashboard-api/tinder/conversations/${encodeURIComponent(id)}`
    : "/dashboard-api/tinder/conversations";
  try {
    const response = await fetch(`${backendUrl}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
      cache: "no-store"
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      const status = response.status === 404 ? 404 : response.status === 400 ? 400 : 502;
      return res.status(status).json({ ok: false, error: data?.error || "Backend konnte Tinder-Daten nicht liefern." });
    }
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(200).json(data);
  } catch {
    return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
  }
}
