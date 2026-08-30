export const config = {
 matcher: [
   "/Hub/:path*",
   "/Dashboard/:path*",
   "/Tinder/:path*",
   "/Brain/:path*"
 ]
};

function getCookie(request, name) {
 const cookieHeader = request.headers.get("cookie") || "";

 const cookies = cookieHeader
   .split(";")
   .map(cookie => cookie.trim());

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

function hexToBytes(hex) {
 if (!hex || hex.length % 2 !== 0) {
   return null;
 }

 const bytes = new Uint8Array(hex.length / 2);

 for (let i = 0; i < hex.length; i += 2) {
   const byte = Number.parseInt(hex.slice(i, i + 2), 16);

   if (Number.isNaN(byte)) {
     return null;
   }

   bytes[i / 2] = byte;
 }

 return bytes;
}

function constantTimeEqual(a, b) {
 if (!a || !b || a.length !== b.length) {
   return false;
 }

 let difference = 0;

 for (let i = 0; i < a.length; i++) {
   difference |= a[i] ^ b[i];
 }

 return difference === 0;
}

async function createSignature(token, secret) {
 const encoder = new TextEncoder();

 const key = await crypto.subtle.importKey(
   "raw",
   encoder.encode(secret),
   {
     name: "HMAC",
     hash: "SHA-256"
   },
   false,
   ["sign"]
 );

 const signature = await crypto.subtle.sign(
   "HMAC",
   key,
   encoder.encode(token)
 );

 return new Uint8Array(signature);
}

export default async function middleware(request) {
 const password = process.env.DASHBOARD_PASSWORD;

 if (!password) {
   return new Response(
     "Dashboard-Schutz ist nicht konfiguriert.",
     {
       status: 500
     }
   );
 }

 const session = getCookie(
   request,
   "marcel_dashboard_session"
 );

 if (!session) {
   return Response.redirect(
     new URL("/login.html", request.url),
     307
   );
 }

 const parts = session.split(".");

 if (parts.length !== 2) {
   return Response.redirect(
     new URL("/login.html", request.url),
     307
   );
 }

 const [token, signatureHex] = parts;

 if (!token || !signatureHex) {
   return Response.redirect(
     new URL("/login.html", request.url),
     307
   );
 }

 try {
   const expectedSignature = await createSignature(
     token,
     password
   );

   const receivedSignature = hexToBytes(
     signatureHex
   );

   if (
     !receivedSignature ||
     !constantTimeEqual(
       expectedSignature,
       receivedSignature
     )
   ) {
     return Response.redirect(
       new URL("/login.html", request.url),
       307
     );
   }

   return fetch(request);

 } catch (error) {
   console.error(
     "Dashboard-Session konnte nicht geprüft werden:",
     error
   );

   return Response.redirect(
     new URL("/login.html", request.url),
     307
   );
 }
}
