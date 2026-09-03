import crypto from "crypto";

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";
  for (const cookie of cookieHeader.split(";").map(value => value.trim())) {
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
  return expectedBuffer.length === receivedBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export function createBrainWriteProxy({ methods, buildPath }) {
  return async function handler(req, res) {
    if (!methods.includes(req.method)) {
      res.setHeader("Allow", methods.join(", "));
      return res.status(405).json({ ok: false, error: "Methode nicht erlaubt." });
    }
    if (!validDashboardSession(req)) {
      return res.status(401).json({ ok: false, error: "Nicht angemeldet." });
    }
    const railwayBackendUrl = String(process.env.RAILWAY_BACKEND_URL || "").trim().replace(/\/+$/, "");
    const dashboardApiSecret = String(process.env.DASHBOARD_API_SECRET || "").trim();
    if (!railwayBackendUrl || !dashboardApiSecret) {
      return res.status(500).json({ ok: false, error: "Dashboard-Verbindung ist nicht konfiguriert." });
    }
    let railwayPath;
    try {
      railwayPath = buildPath(req);
    } catch (error) {
      return res.status(Number(error?.statusCode) || 400).json({
        ok: false,
        error: error?.message || "Ungültige Anfrage."
      });
    }
    try {
      const railwayResponse = await fetch(railwayBackendUrl + railwayPath, {
        method: req.method,
        headers: {
          Authorization: `Bearer ${dashboardApiSecret}`,
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(req.body && typeof req.body === "object" ? req.body : {}),
        cache: "no-store"
      });
      const rawText = await railwayResponse.text();
      let data;
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        return res.status(502).json({ ok: false, error: "Ungültige Antwort vom Backend." });
      }
      const status = [200, 201, 400, 404, 409].includes(railwayResponse.status)
        ? railwayResponse.status
        : railwayResponse.status === 401 ? 502 : 502;
      res.setHeader("Cache-Control", "no-store, max-age=0");
      return res.status(status).json(
        railwayResponse.ok
          ? data
          : { ...data, ok: false, error: data?.error || "Brain konnte nicht aktualisiert werden." }
      );
    } catch (error) {
      console.error("Marcel Brain Write Proxy nicht erreichbar.");
      return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
    }
  };
}
