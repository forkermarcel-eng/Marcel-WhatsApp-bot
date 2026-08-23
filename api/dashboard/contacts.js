import crypto from "crypto";

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || "";

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


function validDashboardSession(req) {
  const password =
    process.env.DASHBOARD_PASSWORD;

  if (!password) {
    return false;
  }

  const session =
    getCookie(
      req,
      "marcel_dashboard_session"
    );

  if (!session) {
    return false;
  }

  const parts =
    session.split(".");

  if (parts.length !== 2) {
    return false;
  }

  const [token, receivedSignature] =
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
      .update(token)
      .digest("hex");

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


export default async function handler(
  req,
  res
) {

  if (req.method !== "GET") {

    return res
      .status(405)
      .json({

        ok: false,

        error:
          "Methode nicht erlaubt."

      });

  }


  if (
    !validDashboardSession(
      req
    )
  ) {

    return res
      .status(401)
      .json({

        ok: false,

        error:
          "Nicht angemeldet."

      });

  }


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

        ok: false,

        error:
          "Dashboard-Verbindung ist nicht konfiguriert."

      });

  }


  try {

    const railwayResponse =
      await fetch(
        `${railwayBackendUrl}/dashboard-api/contacts`,
        {

          method:
            "GET",

          headers: {

            Authorization:
              `Bearer ${dashboardApiSecret}`,

            Accept:
              "application/json"

          }

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
        "Railway lieferte keine gültige JSON-Antwort."
      );


      return res
        .status(502)
        .json({

          ok: false,

          error:
            "Ungültige Antwort vom Backend."

        });

    }


    if (
      !railwayResponse.ok
    ) {

      console.error(
        "Railway Dashboard API Fehler:",
        railwayResponse.status,
        data?.error
        ||
        "Unbekannter Fehler"
      );


      return res
        .status(502)
        .json({

          ok: false,

          error:
            "Backend konnte die Kontakte nicht liefern."

        });

    }


    return res
      .status(200)
      .json(
        data
      );


  } catch (error) {

    console.error(
      "Verbindung zu Railway fehlgeschlagen:",
      error
    );


    return res
      .status(502)
      .json({

        ok: false,

        error:
          "Backend ist momentan nicht erreichbar."

      });

  }

}
