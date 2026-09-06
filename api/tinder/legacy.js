import crypto from "crypto";

const LEGACY_WORKER_DISABLED = Object.freeze({
  ok: false,
  code: "LEGACY_TINDER_WEBWORKER_DISABLED",
  error: "Der Legacy-Tinder-Webworker ist deaktiviert."
});

const LEGACY_ROUTES = Object.freeze({
  control: "POST",
  read: "GET",
  status: "GET"
});

function dashboardSessionIsValid(req) {
  const password = String(process.env.DASHBOARD_PASSWORD || "");
  const session = String(req.headers?.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("marcel_dashboard_session="))
    ?.slice("marcel_dashboard_session=".length);
  if (!password || !session) return false;
  const [token, signature, ...extra] = session.split(".");
  if (!token || !signature || extra.length) return false;
  const expected = crypto.createHmac("sha256", password).update(token).digest("hex");
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(signature, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/*
 * The historical Playwright worker stays quarantined. Vercel rewrites the
 * three former public compatibility URLs to this one bounded function.
 */
export default async function handler(req, res) {
  const legacyRoute = typeof req.query?.legacyRoute === "string" ? req.query.legacyRoute : "";
  const requiredMethod = LEGACY_ROUTES[legacyRoute];
  if (!requiredMethod) {
    return res.status(404).json({ ok: false, error: "Nicht gefunden." });
  }
  if (req.method !== requiredMethod) {
    res.setHeader("Allow", requiredMethod);
    return res.status(405).json({ ok: false, error: "Methode nicht erlaubt." });
  }
  if (!dashboardSessionIsValid(req)) {
    return res.status(401).json({ ok: false, error: "Nicht angemeldet." });
  }
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(410).json(LEGACY_WORKER_DISABLED);
}

export { LEGACY_ROUTES, LEGACY_WORKER_DISABLED };
