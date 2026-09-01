import crypto from "crypto";

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || "")
    .split(";")
    .map((cookie) => cookie.trim());

  for (const cookie of cookies) {
    const separatorIndex = cookie.indexOf("=");
    if (separatorIndex === -1) continue;
    if (cookie.slice(0, separatorIndex) === name) {
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

  const expectedSignature = crypto
    .createHmac("sha256", password)
    .update(token)
    .digest("hex");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const receivedBuffer = Buffer.from(receivedSignature, "utf8");

  return expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Methode nicht erlaubt." });
  }

  if (!validDashboardSession(req)) {
    return res.status(401).json({ ok: false, error: "Nicht angemeldet." });
  }

  const railwayBackendUrl = String(process.env.RAILWAY_BACKEND_URL || "")
    .trim()
    .replace(/\/+$/, "");
  const dashboardApiSecret = String(process.env.DASHBOARD_API_SECRET || "").trim();

  if (!railwayBackendUrl || !dashboardApiSecret) {
    return res.status(500).json({
      ok: false,
      error: "Dashboard-Verbindung ist nicht konfiguriert."
    });
  }

  const railwayPath = "/dashboard-api/device-bridge/enrollment-codes";

  try {
    const railwayResponse = await fetch(railwayBackendUrl + railwayPath, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dashboardApiSecret}`,
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ display_name: "ZTE Android Device Bridge" }),
      cache: "no-store"
    });

    const rawText = await railwayResponse.text();
    let data;
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      return res.status(502).json({ ok: false, error: "Ungültige Antwort vom Backend." });
    }

    if (!railwayResponse.ok) {
      if (railwayResponse.status === 401) {
        return res.status(502).json({
          ok: false,
          error: "Dashboard-Backend konnte nicht autorisiert werden."
        });
      }

      const status = [400, 409, 429].includes(railwayResponse.status)
        ? railwayResponse.status
        : 502;
      return res.status(status).json({
        ok: false,
        error: data?.error || "Enrollment-Code konnte nicht erstellt werden."
      });
    }

    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.status(201).json({
      ok: true,
      enrollment_code: data.enrollment_code,
      expires_at: data.expires_at
    });
  } catch (error) {
    console.error("Verbindung zum Device-Bridge-Enrollment fehlgeschlagen.");
    return res.status(502).json({
      ok: false,
      error: "Backend ist momentan nicht erreichbar."
    });
  }
}
