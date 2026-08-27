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
   &&
   req.method !== "POST"
 ) {
 
   res.setHeader(
     "Allow",
     "GET, POST"
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
 
 const railwayBackendUrl =
   String(
     process.env
       .RAILWAY_BACKEND_URL
     ||
     ""
   )
     .trim()
     .replace(
       /\/+$/,
       ""
     );
 
 const dashboardApiSecret =
   String(
     process.env
       .DASHBOARD_API_SECRET
     ||
     ""
   )
     .trim();
 
 if (
   !railwayBackendUrl
   ||
   !dashboardApiSecret
 ) {
 
   console.error(
     "Marcel Brain API Konfiguration fehlt.",
     {
 
       hasRailwayBackendUrl:
         Boolean(
           railwayBackendUrl
         ),
 
       hasDashboardApiSecret:
         Boolean(
           dashboardApiSecret
         )
 
     }
   );
 
   return res
     .status(500)
     .json({
 
       ok:
         false,
 
       error:
         "Dashboard-Verbindung ist nicht konfiguriert."
 
     });
 
 }
 
 
 /* ==================================================
    RAILWAY TARGET
 ================================================== */
 
 const railwayPath =
   "/dashboard-api/marcel-brain";
 
 const railwayUrl =
   railwayBackendUrl
   +
   railwayPath;
 
 
 /* ==================================================
    RAILWAY REQUEST
 ================================================== */
 
 try {
 
   const isPost =
     req.method === "POST";
 
   const railwayResponse =
     await fetch(
       railwayUrl,
       {
 
         method:
           req.method,
 
         headers: {
 
           Authorization:
             `Bearer ${dashboardApiSecret}`,
 
           Accept:
             "application/json",
 
           ...(isPost
             ? {
                 "Content-Type":
                   "application/json"
               }
             : {})
 
         },
 
         ...(isPost
           ? {
               body:
                 JSON.stringify(
                   req.body
                   &&
                   typeof req.body === "object"
 
                     ? req.body
 
                     : {}
                 )
             }
           : {}),
 
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
       "Railway lieferte für Marcel Brain keine gültige JSON-Antwort.",
       {
 
         status:
           railwayResponse.status,
 
         path:
           railwayPath,
 
         method:
           req.method
 
       }
     );
 
     return res
       .status(502)
       .json({
 
         ok:
           false,
 
         error:
           "Ungültige Antwort vom Backend."
 
       });
 
   }
 
 
   /* ==================================================
      RAILWAY ERRORS
   ================================================== */
 
   if (
     !railwayResponse.ok
   ) {
 
     console.error(
       "Railway Marcel Brain API Fehler:",
       {
 
         status:
           railwayResponse.status,
 
         path:
           railwayPath,
 
         method:
           req.method,
 
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
             "Dashboard-Backend konnte nicht autorisiert werden."
 
         });
 
     }
 
     const passthroughStatus =
       [
         400,
         404,
         409
       ].includes(
         railwayResponse.status
       )
 
         ? railwayResponse.status
 
         : 502;
 
     return res
       .status(
         passthroughStatus
       )
       .json({
 
         ok:
           false,
 
         error:
           data?.error
           ||
           (
             req.method === "POST"
 
               ? "Marcel Brain konnte nicht aktualisiert werden."
 
               : "Marcel Brain konnte nicht geladen werden."
           )
 
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
     "Verbindung zu Railway für Marcel Brain fehlgeschlagen:",
     error
   );
 
   return res
     .status(502)
     .json({
 
       ok:
         false,
 
       error:
         "Backend ist momentan nicht erreichbar."
 
     });
 
 }
 
}
