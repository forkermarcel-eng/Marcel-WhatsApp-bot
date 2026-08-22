import crypto from "crypto";

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Methode nicht erlaubt."
    });
  }

  const { username, password } = req.body || {};

  const correctUsername = process.env.DASHBOARD_USERNAME;
  const correctPassword = process.env.DASHBOARD_PASSWORD;

  if (!correctUsername || !correctPassword) {
    console.error("Dashboard-Zugangsdaten fehlen in Vercel.");

    return res.status(500).json({
      ok: false,
      error: "Server-Konfiguration fehlt."
    });
  }

  if (
    username !== correctUsername ||
    password !== correctPassword
  ) {
    return res.status(401).json({
      ok: false,
      error: "Benutzername oder Passwort ist falsch."
    });
  }

  // Zufälliges Session-Token erzeugen
  const token = crypto.randomBytes(32).toString("hex");

  // Signatur mit dem Passwort erzeugen
  const signature = crypto
    .createHmac("sha256", correctPassword)
    .update(token)
    .digest("hex");

  const session = `${token}.${signature}`;

  // Login-Cookie setzen
  res.setHeader(
    "Set-Cookie",
    `marcel_dashboard_session=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`
  );

  return res.status(200).json({
    ok: true
  });
}
