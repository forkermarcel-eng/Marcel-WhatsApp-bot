import crypto from "crypto";

function getCookie(req, name) {
 const cookieHeader = req.headers.cookie || "";
 const cookies = cookieHeader
   .split(";")
   .map((cookie) => cookie.trim());

 for (const cookie of cookies) {
   const separatorIndex = cookie.indexOf("=");

   if (separatorIndex === -1) {
     continue;
   }

   const key = cookie.slice(0, separatorIndex);
   const value = cookie.slice(separatorIndex + 1);

   if (key === name) {
     return value;
   }
 }

 return null;
}

function validDashboardSession(req) {
 const password = process.env.DASHBOARD_PASSWORD;

 if (!password) {
   return false;
 }

 const session = getCookie(
   req,
   "marcel_dashboard_session"
 );

 if (!session) {
   return false;
 }

 const parts = session.split(".");

 if (parts.length !== 2) {
   return false;
 }

 const [token, receivedSignature] = parts;

 if (!token || !receivedSignature) {
   return false;
 }

 const expectedSignature = crypto
   .createHmac("sha256", password)
   .update(token)
   .digest("hex");

 const expectedBuffer = Buffer.from(
   expectedSignature,
   "utf8"
 );
 const receivedBuffer = Buffer.from(
   receivedSignature,
   "utf8"
 );

 if (expectedBuffer.length !== receivedBuffer.length) {
   return false;
 }

 return crypto.timingSafeEqual(
   expectedBuffer,
   receivedBuffer
 );
}

function getSingleQueryValue(value) {
 if (Array.isArray(value)) {
   return String(value[0] || "").trim();
 }

 return String(value || "").trim();
}

function validMatchId(value) {
 return (
   value.length > 0 &&
   value.length <= 200 &&
   /^[A-Za-z0-9_-]+$/.test(value)
 );
}

export default async function handler(req, res) {
 if (req.method !== "GET") {
   res.setHeader("Allow", "GET");

   return res.status(405).json({
     ok: false,
     error: "Methode nicht erlaubt."
   });
 }

 if (!validDashboardSession(req)) {
   return res.status(401).json({
     ok: false,
     error: "Nicht angemeldet."
   });
 }

 const tinderRailwayBackendUrl = String(
   process.env.TINDER_RAILWAY_BACKEND_URL || ""
 )
   .trim()
   .replace(/\/+$/, "");

 const tinderApiSecret = String(
   process.env.TINDER_API_SECRET || ""
 ).trim();

 if (!tinderRailwayBackendUrl || !tinderApiSecret) {
   console.error(
     "Tinder Read-only API Konfiguration fehlt.",
     {
       hasTinderRailwayBackendUrl: Boolean(
         tinderRailwayBackendUrl
       ),
       hasTinderApiSecret: Boolean(
         tinderApiSecret
       )
     }
   );

   return res.status(500).json({
     ok: false,
     error: "Tinder-Verbindung ist nicht konfiguriert."
   });
 }

 const mode = getSingleQueryValue(
   req.query?.mode
 ).toLowerCase();
 const matchId = getSingleQueryValue(
   req.query?.id
 );

 let railwayPath = "";

 if (mode === "matches") {
   railwayPath = "/dashboard-api/read-only/matches";
 } else if (mode === "conversation") {
   if (!validMatchId(matchId)) {
     return res.status(400).json({
       ok: false,
       error: "Ungültige Tinder-Match-ID."
     });
   }

   railwayPath =
     "/dashboard-api/read-only/conversation/" +
     encodeURIComponent(matchId);
 } else {
   return res.status(400).json({
     ok: false,
     error: "Ungültiger Tinder-Lesemodus."
   });
 }

 const railwayUrl =
   tinderRailwayBackendUrl + railwayPath;

 try {
   const railwayResponse = await fetch(
     railwayUrl,
     {
       method: "GET",
       headers: {
         Authorization: `Bearer ${tinderApiSecret}`,
         Accept: "application/json"
       },
       cache: "no-store"
     }
   );

   const rawText = await railwayResponse.text();
   let data;

   try {
     data = rawText
       ? JSON.parse(rawText)
       : {};
   } catch {
     console.error(
       "Railway lieferte fuer Tinder Read-only keine gueltige JSON-Antwort.",
       {
         status: railwayResponse.status,
         path: railwayPath,
         method: "GET"
       }
     );

     return res.status(502).json({
       ok: false,
       error: "Ungueltige Antwort vom Tinder-Backend."
     });
   }

   if (!railwayResponse.ok) {
     console.error(
       "Railway Tinder Read-only API Fehler:",
       {
         status: railwayResponse.status,
         path: railwayPath,
         method: "GET",
         code: data?.code || "",
         error: data?.error || "Unbekannter Fehler"
       }
     );

     if (railwayResponse.status === 401) {
       return res.status(502).json({
         ok: false,
         error: "Tinder-Backend konnte nicht autorisiert werden."
       });
     }

     return res
       .status(
         railwayResponse.status >= 400 &&
         railwayResponse.status < 500
           ? railwayResponse.status
           : 502
       )
       .json({
         ok: false,
         readOnly: true,
         code: data?.code || "TINDER_READ_ONLY_BACKEND_ERROR",
         error:
           data?.error ||
           "Tinder-Daten konnten nicht geladen werden.",
         diagnostics: data?.diagnostics || {}
       });
   }

   res.setHeader(
     "Cache-Control",
     "no-store, max-age=0"
   );

   return res.status(200).json(data);
 } catch (error) {
   console.error(
     "Verbindung zu Railway fuer Tinder Read-only fehlgeschlagen:",
     error
   );

   return res.status(502).json({
     ok: false,
     error: "Tinder-Backend ist momentan nicht erreichbar."
   });
 }
}
