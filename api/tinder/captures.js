import crypto from "crypto";

// Tombstone for the former Tinder data endpoint. It remains only to fail
// closed for stale dashboard clients and never contacts the backend.
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

export default async function handler(req, res) {
  if (!validDashboardSession(req)) {
    return res.status(401).json({ ok: false, error: "Nicht angemeldet." });
  }
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(410).json({
    ok: false,
    error: "Der frühere Tinder-Daten-Endpunkt ist nicht aktiv."
  });
}
