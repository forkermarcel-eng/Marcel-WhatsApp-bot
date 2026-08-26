import crypto from "crypto";
 
function getCookie(req, name) {
 const cookieHeader = req.headers.cookie || "";
 for (const cookie of cookieHeader.split(";").map(v => v.trim())) {
   const i = cookie.indexOf("=");
   if (i === -1) continue;
   if (cookie.slice(0, i) === name) return cookie.slice(i + 1);
 }
 return null;
}
 
function validDashboardSession(req) {
 const password = process.env.DASHBOARD_PASSWORD;
 if (!password) return false;
 const session = getCookie(req, "marcel_dashboard_session");
 if (!session) return false;
 const parts = session.split(".");
 if (parts.length !== 2) return false;
 const [token, receivedSignature] = parts;
 if (!token || !receivedSignature) return false;
 const expectedSignature = crypto.createHmac("sha256", password).update(token).digest("hex");
 const expectedBuffer = Buffer.from(expectedSignature, "utf8");
 const receivedBuffer = Buffer.from(receivedSignature, "utf8");
 if (expectedBuffer.length !== receivedBuffer.length) return false;
 return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}
 
export default async function handler(req, res) {
 if (!["GET", "POST"].includes(req.method)) {
   res.setHeader("Allow", "GET, POST");
   return res.status(405).json({ ok: false, error: "Methode nicht erlaubt." });
 }
 if (!validDashboardSession(req)) return res.status(401).json({ ok: false, error: "Nicht angemeldet." });
 
 const railwayBackendUrl = String(process.env.RAILWAY_BACKEND_URL || "").trim().replace(/\/+$/, "");
 const dashboardApiSecret = String(process.env.DASHBOARD_API_SECRET || "").trim();
 if (!railwayBackendUrl || !dashboardApiSecret) return res.status(500).json({ ok: false, error: "Dashboard-Verbindung ist nicht konfiguriert." });
 
 try {
   if (req.method === "GET") {
     const jobId = String(req.query?.jobId || "").trim();
     if (!jobId) return res.status(400).json({ ok: false, error: "jobId fehlt." });
     const railwayResponse = await fetch(`${railwayBackendUrl}/dashboard-api/import-whatsapp-status?jobId=${encodeURIComponent(jobId)}`, {
       method: "GET",
       headers: { Authorization: `Bearer ${dashboardApiSecret}`, Accept: "application/json" },
       cache: "no-store"
     });
     const rawText = await railwayResponse.text();
     let data = {};
     try { data = rawText ? JSON.parse(rawText) : {}; } catch { return res.status(502).json({ ok: false, error: "Ungültige Antwort vom Backend." }); }
     res.setHeader("Cache-Control", "no-store, max-age=0");
     return res.status(railwayResponse.status).json(data);
   }
 
   const body = req.body && typeof req.body === "object" ? req.body : {};
   const contactId = Number(body.contactId);
   const chatText = String(body.chatText || "");
   const senderMapping = body.senderMapping && typeof body.senderMapping === "object" ? {
     marcelSender: String(body.senderMapping.marcelSender || "").trim(),
     contactSender: String(body.senderMapping.contactSender || "").trim()
   } : null;
   if (!Number.isInteger(contactId) || contactId <= 0) return res.status(400).json({ ok: false, error: "Ungültige Kontakt-ID." });
   if (!chatText.trim()) return res.status(400).json({ ok: false, error: "Der WhatsApp-Export ist leer." });
   if (!senderMapping?.marcelSender || !senderMapping?.contactSender) return res.status(400).json({ ok: false, error: "Bitte Marcel und den Kontakt eindeutig zuordnen." });
   if (senderMapping.marcelSender === senderMapping.contactSender) return res.status(400).json({ ok: false, error: "Marcel und Kontakt müssen verschiedene Absender sein." });
 
   const railwayResponse = await fetch(`${railwayBackendUrl}/dashboard-api/import-whatsapp`, {
     method: "POST",
     headers: { Authorization: `Bearer ${dashboardApiSecret}`, Accept: "application/json", "Content-Type": "application/json" },
     cache: "no-store",
     body: JSON.stringify({ contactId, chatText, marcelSenderNames: Array.isArray(body.marcelSenderNames) ? body.marcelSenderNames : [], senderMapping })
   });
   const rawText = await railwayResponse.text();
   let data = {};
   try { data = rawText ? JSON.parse(rawText) : {}; } catch { return res.status(502).json({ ok: false, error: "Ungültige Antwort vom Backend." }); }
   res.setHeader("Cache-Control", "no-store, max-age=0");
   return res.status(railwayResponse.status).json(data);
 } catch (error) {
   console.error("WhatsApp-Import Verbindung zu Railway fehlgeschlagen:", error);
   return res.status(502).json({ ok: false, error: "Backend ist momentan nicht erreichbar." });
 }
}
