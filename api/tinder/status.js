import crypto from "crypto";
 
 
/* ==================================================
  COOKIE
================================================== */
 
function getCookie(req, name) {
 const cookieHeader =
   req.headers.cookie
   ||
   "";
 
 const cookies =
   cookieHeader
     .split(";")
     .map(
       cookie =>
         cookie.trim()
     );
 
 for (
   const cookie
   of cookies
 ) {
   const separatorIndex =
     cookie.indexOf("=");
 
   if (
     separatorIndex === -1
   ) {
     continue;
   }
 
   const key =
     cookie.slice(
       0,
       separatorIndex
     );
 
   const value =
     cookie.slice(
       separatorIndex + 1
     );
 
   if (
     key === name
   ) {
     return value;
   }
 }
 
 return null;
}
 
 
/* ==================================================
  DASHBOARD SESSION
================================================== */
 
function validDashboardSession(req) {
 const password =
   process.env
     .DASHBOARD_PASSWORD;
 
 if (
   !password
 ) {
   return false;
 }
 
 const session =
   getCookie(
     req,
     "marcel_dashboard_session"
   );
 
 if (
   !session
 ) {
   return false;
 }
 
 const parts =
   session.split(".");
 
 if (
   parts.length !== 2
 ) {
   return false;
 }
 
 const [
   token,
   receivedSignature
 ] =
   parts;
 
 if (
   !token
   ||
   !receivedSignature
 ) {
   return false;
 }
 
 const expectedSignature =
   crypto
     .createHmac(
       "sha256",
       password
     )
     .update(
       token
     )
     .digest(
       "hex"
     );
 
 const expectedBuffer =
   Buffer.from(
     expectedSignature,
     "utf8"
   );
 
 const receivedBuffer =
   Buffer.from(
     receivedSignature,
     "utf8"
   );
 
 if (
   expectedBuffer.length
   !==
   receivedBuffer.length
 ) {
   return false;
 }
 
 return crypto.timingSafeEqual(
   expectedBuffer,
   receivedBuffer
 );
}
 
 
/* ==================================================
  HANDLER
================================================== */
 
export default async function handler(
 req,
 res
) {
 
 /* ==================================================
    METHOD
 ================================================== */
 
 if (
   req.method !== "GET"
 ) {
   res.setHeader(
     "Allow",
     "GET"
   );
 
   return res
     .status(405)
     .json({
       ok:
         false,
 
       error:
         "Methode nicht erlaubt."
     });
 }
 
 
 /* ==================================================
    LOGIN SESSION
 ================================================== */
 
 if (
   !validDashboardSession(
     req
   )
 ) {
   return res
     .status(401)
     .json({
       ok:
         false,
 
       error:
         "Nicht angemeldet."
     });
 }
 
 
 /* ==================================================
    ENVIRONMENT
 ================================================== */
 
 const tinderRailwayBackendUrl =
   String(
     process.env
       .TINDER_RAILWAY_BACKEND_URL
     ||
     ""
   )
     .trim()
     .replace(
       /\/+$/,
       ""
     );
 
 const tinderApiSecret =
   String(
     process.env
       .TINDER_API_SECRET
     ||
     ""
   )
     .trim();
 
 if (
   !tinderRailwayBackendUrl
   ||
   !tinderApiSecret
 ) {
   console.error(
     "Tinder Status API Konfiguration fehlt.",
     {
       hasTinderRailwayBackendUrl:
         Boolean(
           tinderRailwayBackendUrl
         ),
 
       hasTinderApiSecret:
         Boolean(
           tinderApiSecret
         )
     }
   );
 
   return res
     .status(500)
     .json({
       ok:
         false,
 
       error:
         "Tinder-Verbindung ist nicht konfiguriert."
     });
 }
 
 
 /* ==================================================
    RAILWAY TARGET
 ================================================== */
 
 const railwayPath =
   "/dashboard-api/status";
 
 const railwayUrl =
   tinderRailwayBackendUrl
   +
   railwayPath;
 
 
 /* ==================================================
    RAILWAY REQUEST
 ================================================== */
 
 try {
   const railwayResponse =
     await fetch(
       railwayUrl,
       {
         method:
           "GET",
 
         headers: {
           Authorization:
             `Bearer ${tinderApiSecret}`,
 
           Accept:
             "application/json"
         },
 
         cache:
           "no-store"
       }
     );
 
   const rawText =
     await railwayResponse.text();
 
   let data;
 
   try {
     data =
       rawText
 
         ? JSON.parse(
             rawText
           )
 
         : {};
   } catch {
     console.error(
       "Railway lieferte fuer Tinder Status keine gueltige JSON-Antwort.",
       {
         status:
           railwayResponse.status,
 
         path:
           railwayPath,
 
         method:
           "GET"
       }
     );
 
     return res
       .status(502)
       .json({
         ok:
           false,
 
         error:
           "Ungueltige Antwort vom Tinder-Backend."
       });
   }
 
 
   /* ==================================================
      RAILWAY ERRORS
   ================================================== */
 
   if (
     !railwayResponse.ok
   ) {
     console.error(
       "Railway Tinder Status API Fehler:",
       {
         status:
           railwayResponse.status,
 
         path:
           railwayPath,
 
         method:
           "GET",
 
         error:
           data?.error
           ||
           "Unbekannter Fehler"
       }
     );
 
     if (
       railwayResponse.status === 401
     ) {
       return res
         .status(502)
         .json({
           ok:
             false,
 
           error:
             "Tinder-Backend konnte nicht autorisiert werden."
         });
     }
 
     return res
       .status(502)
       .json({
         ok:
           false,
 
         error:
           data?.error
           ||
           "Tinder-Status konnte nicht geladen werden."
       });
   }
 
 
   /* ==================================================
      RESPONSE HEADERS
   ================================================== */
 
   res.setHeader(
     "Cache-Control",
     "no-store, max-age=0"
   );
 
 
   /* ==================================================
      SUCCESS
   ================================================== */
 
   return res
     .status(200)
     .json(
       data
     );
 
 } catch (
   error
 ) {
   console.error(
     "Verbindung zu Railway fuer Tinder Status fehlgeschlagen:",
     error
   );
 
   return res
     .status(502)
     .json({
       ok:
         false,
 
       error:
         "Tinder-Backend ist momentan nicht erreichbar."
     });
 }
}
