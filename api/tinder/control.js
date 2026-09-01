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

function getAction(req) {
 const value =
   req.body && typeof req.body === "object"
     ? req.body.action
     : "";

 return String(value || "")
   .trim()
   .toLowerCase();
}

function actionToRailwayPath(action) {
 switch (action) {
   case "connect":
     return "/dashboard-api/control/connect";
   case "disconnect":
     return "/dashboard-api/control/disconnect";
   case "automation-start":
     return "/dashboard-api/control/automation/start";
   case "automation-stop":
     return "/dashboard-api/control/automation/stop";
   default:
     return "";
 }
}

export default async function handler(req, res) {
 if (req.method !== "POST") {
   res.setHeader("Allow", "POST");

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
     "Tinder Control API Konfiguration fehlt.",
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

 const action = getAction(req);
 const railwayPath = actionToRailwayPath(action);

 if (!railwayPath) {
   return res.status(400).json({
     ok: false,
     error: "Ungültige Tinder-Steuerungsaktion."
   });
 }

 const railwayUrl =
   tinderRailwayBackendUrl + railwayPath;

 try {
   const railwayResponse = await fetch(
     railwayUrl,
     {
       method: "POST",
       headers: {
         Authorization: `Bearer ${tinderApiSecret}`,
         Accept: "application/json",
         "Content-Type": "application/json"
       },
       body: JSON.stringify({}),
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
       "Railway lieferte für Tinder Control keine gültige JSON-Antwort.",
       {
         status: railwayResponse.status,
         path: railwayPath,
         action
       }
     );

     return res.status(502).json({
       ok: false,
       error: "Ungültige Antwort vom Tinder-Backend."
     });
   }

   if (!railwayResponse.ok) {
     console.error(
       "Railway Tinder Control API Fehler:",
       {
         status: railwayResponse.status,
         path: railwayPath,
         action,
         error:
           data?.error ||
           "Unbekannter Fehler"
       }
     );

     if (railwayResponse.status === 401) {
       return res.status(502).json({
         ok: false,
         error:
           "Tinder-Backend konnte nicht autorisiert werden."
       });
     }

     const passthroughStatus = [
       400,
       404,
       409,
       423
     ].includes(railwayResponse.status)
       ? railwayResponse.status
       : 502;

     return res
       .status(passthroughStatus)
       .json({
         ...data,
         ok: false,
         error:
           data?.error ||
           "Tinder-Steuerung konnte nicht ausgeführt werden."
       });
   }

   res.setHeader(
     "Cache-Control",
     "no-store, max-age=0"
   );

   return res
     .status(railwayResponse.status)
     .json(data);
 } catch (error) {
   console.error(
     "Verbindung zu Railway für Tinder Control fehlgeschlagen:",
     error
   );

   return res.status(502).json({
     ok: false,
     error: "Tinder-Backend ist momentan nicht erreichbar."
   });
 }
}
