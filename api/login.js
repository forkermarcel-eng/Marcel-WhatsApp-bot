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
    console.error("Dashboard-Zugangsdaten fehlen in Vercel.", {
      hasUsername: Boolean(correctUsername),
      hasPassword: Boolean(correctPassword)
    });

    return res.status(500).json({
      ok: false,
      error: "Server-Konfiguration fehlt."
    });
  }

  const usernameMatches = username === correctUsername;
  const passwordMatches = password === correctPassword;

  console.log("Dashboard Login Test:", {
    usernameMatches,
    passwordMatches,
    receivedUsernameLength: String(username || "").length,
    storedUsernameLength: String(correctUsername || "").length,
    receivedPasswordLength: String(password || "").length,
    storedPasswordLength: String(correctPassword || "").length
  });

  if (!usernameMatches || !passwordMatches) {
    return res.status(401).json({
      ok: false,
      error: "Benutzername oder Passwort ist falsch."
    });
  }

  const token = crypto.randomBytes(32).toString("hex");

  const signature = crypto
    .createHmac("sha256", correctPassword)
    .update(token)
    .digest("hex");

  const session = `${token}.${signature}`;

  res.setHeader(
    "Set-Cookie",
    `marcel_dashboard_session=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`
  );

  return res.status(200).json({
    ok: true
  });
}
