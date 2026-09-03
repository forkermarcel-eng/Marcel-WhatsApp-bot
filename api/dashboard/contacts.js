import crypto from "crypto";


/* ==================================================
 COOKIE
================================================== */

function getCookie(
req,
name
) {

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
    separatorIndex
    ===
    -1
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

function validDashboardSession(
req
) {

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
 NORMALIZE CONTACT ID
================================================== */

function normalizeContactId(
value
) {

if (
  Array.isArray(
    value
  )
) {

  value =
    value[0];

}


if (
  value === undefined
  ||
  value === null
  ||
  value === ""
) {

  return null;

}


const contactId =
  Number(
    value
  );

if (
  !Number.isInteger(
    contactId
  )
  ||
  contactId <= 0
) {

  return false;

}


return contactId;

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
  ![
    "GET",
    "POST",
    "PATCH",
    "DELETE"
  ].includes(
    req.method
  )
) {

  res.setHeader(
    "Allow",
    "GET, POST, PATCH, DELETE"
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
    "Dashboard API Konfiguration fehlt.",
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
   OPTIONAL CONTACT ID

   GET ohne ID:
   /api/dashboard/contacts

   GET/PATCH/DELETE mit ID:
   /api/dashboard/contacts?id=91

   POST ohne ID:
   neuen Kontakt anlegen
================================================== */

const contactId =
  normalizeContactId(
    req.query?.id
  );

const resource =
  String(req.query?.resource || "").trim().toLowerCase();

if (resource && resource !== "identities") {
  return res.status(400).json({ ok: false, error: "Ungültige Kontakt-Ressource." });
}

if (resource === "identities" && !contactId) {
  return res.status(400).json({ ok: false, error: "Für Kanalidentitäten fehlt die Kontakt-ID." });
}


if (
  contactId === false
) {

  return res
    .status(400)
    .json({

      ok:
        false,

      error:
        "Ungültige Kontakt-ID."

    });

}


if (
  req.method === "POST"
  &&
  contactId
  &&
  resource !== "identities"
) {

  return res
    .status(400)
    .json({

      ok:
        false,

      error:
        "Zum Anlegen darf keine Kontakt-ID gesetzt sein."

    });

}


if (
  [
    "PATCH",
    "DELETE"
  ].includes(
    req.method
  )
  &&
  !contactId
) {

  return res
    .status(400)
    .json({

      ok:
        false,

      error:
        req.method === "DELETE"
          ? "Zum Löschen fehlt die Kontakt-ID."
          : "Zum Bearbeiten fehlt die Kontakt-ID."

    });

}


/* ==================================================
   RAILWAY TARGET
================================================== */

const railwayPath =
  contactId

    ? (
        "/dashboard-api/contacts/"
        +
        encodeURIComponent(
          String(
            contactId
          )
        )
      )
      + (resource === "identities" ? "/identities" : "")

    : "/dashboard-api/contacts";


const railwayUrl =
  railwayBackendUrl
  +
  railwayPath;


/* ==================================================
   RAILWAY REQUEST
================================================== */

try {

  const hasBody =
    [
      "POST",
      "PATCH",
      "DELETE"
    ].includes(
      req.method
    );


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

          ...(hasBody
            ? {
                "Content-Type":
                  "application/json"
              }
            : {})

        },

        ...(hasBody
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
      "Railway lieferte keine gültige JSON-Antwort.",
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
      "Railway Dashboard API Fehler:",
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
      railwayResponse.status
      ===
      401
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
            req.method === "DELETE"

              ? "Kontakt konnte nicht gelöscht werden."

              : req.method === "PATCH"

                ? "Kontakt konnte nicht gespeichert werden."

                : req.method === "POST"

                  ? "Kontakt konnte nicht angelegt werden."

                  : contactId

                    ? "Backend konnte den Kontakt nicht liefern."

                    : "Backend konnte die Kontakte nicht liefern."
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
    .status(
      railwayResponse.status
    )
    .json(
      data
    );


} catch (
  error
) {

  console.error(
    "Verbindung zu Railway fehlgeschlagen:",
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
