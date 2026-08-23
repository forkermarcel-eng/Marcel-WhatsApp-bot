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

     Ohne ID:
     /api/dashboard/contacts

     Mit ID:
     /api/dashboard/contacts?id=91
  ================================================== */

  const contactId =
    normalizeContactId(
      req.query?.id
    );


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

      : "/dashboard-api/contacts";


  const railwayUrl =
    railwayBackendUrl
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
              `Bearer ${dashboardApiSecret}`,

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
        "Railway lieferte keine gültige JSON-Antwort.",
        {
          status:
            railwayResponse.status,

          path:
            railwayPath
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

          error:
            data?.error
            ||
            "Unbekannter Fehler"
        }
      );


      if (
        railwayResponse.status
        ===
        400
      ) {

        return res
          .status(400)
          .json({

            ok:
              false,

            error:
              data?.error
              ||
              "Ungültige Anfrage."

          });

      }


      if (
        railwayResponse.status
        ===
        404
      ) {

        return res
          .status(404)
          .json({

            ok:
              false,

            error:
              data?.error
              ||
              "Kontakt nicht gefunden."

          });

      }


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


      return res
        .status(502)
        .json({

          ok:
            false,

          error:
            contactId

              ? "Backend konnte den Kontakt nicht liefern."

              : "Backend konnte die Kontakte nicht liefern."

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
