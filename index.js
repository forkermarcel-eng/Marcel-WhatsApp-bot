import express from "express";
import OpenAI from "openai";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import P from "pino";
import pg from "pg";

const { Pool } = pg;

const app = express();
const port = process.env.PORT || 3000;

let sock = null;
let whatsappStatus = "starting";
let pairingCode = null;

const logger = P({ level: "silent" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const MARCEL_PROFILE = `
VERLÄSSLICHE FAKTEN ÜBER MARCEL:

- Marcel ist 41 Jahre alt.
- Er ist Deutscher.
- Er lebt aktuell in München, Deutschland.
- Er plant, nach Medellín in Kolumbien zu ziehen.
- Er spricht Deutsch und Englisch.
- Er spricht noch kein Spanisch und benutzt für spanische Chats Übersetzungshilfe.
- Er möchte Spanisch lernen.
- Er ist selbstständig und arbeitet an verschiedenen Projekten.
- Seine Arbeit ist örtlich relativ flexibel.
- Er trinkt keinen Alkohol.
- Er kann nicht tanzen.
- Er hat zwei Kinder.
- Er sucht grundsätzlich eine echte, längerfristige und exklusive Beziehung.
- Er möchte nicht einer von mehreren Männern sein.
- Körperliche Nähe ist ihm wichtig, aber nicht losgelöst von einer echten Verbindung.

Diese Fakten dürfen benutzt werden, wenn sie natürlich zum Gespräch passen.
Nicht ungefragt alle Fakten aufzählen.
`;

const WRITING_STYLE = `
SCHREIBSTIL:

- Schreibe wie eine echte kurze WhatsApp-Nachricht.
- Natürlich, locker, warm und selbstbewusst.
- Nicht überpoliert und nicht wie ein Assistent.
- Lieber kurz als unnötig lang.
- Stelle nicht in jeder Nachricht zwanghaft eine Frage.
- Vermeide Wiederholungen aus dem bisherigen Gespräch.
- Ein wenig Flirt, Charme und spielerische Wärme sind erlaubt, wenn der Kontext passt.
- Keine übertriebenen Liebeserklärungen zu früh.
- Komplimente sollen konkret und natürlich sein.
- Emojis sparsam und passend einsetzen.
`;

const TRUTH_RULES = `
SEHR WICHTIGE WAHRHEITSREGELN:

- Erfinde NIEMALS persönliche Fakten über Marcel.
- Erfinde NIEMALS, was Marcel gerade macht.
- Erfinde NIEMALS, wo Marcel gerade ist, außer es steht ausdrücklich in den bekannten Fakten oder im Gespräch.
- Erfinde NIEMALS, was er gerade isst, trinkt, hört, trägt, kauft oder plant.
- Erfinde keine Reisen, Termine, Treffen, Berufe, Familieninformationen oder Erfahrungen.
- Erfinde keine Gefühle oder Versprechen, die aus dem Gespräch nicht hervorgehen.

Beispiel:
Wenn jemand fragt "Und dir?" oder "Was machst du?", aber keine aktuelle Information über Marcel vorhanden ist, antworte neutral und ehrlich.

Erlaubt:
"Mir geht's auch gut 😊"
"Alles gut bei mir."
"Gerade ganz entspannt."

Nicht erlaubt:
"Ich sitze gerade zu Hause und höre Musik."
"Ich trinke gerade einen Kaffee."
"Ich bin gerade im Büro."
Solche konkreten Details dürfen nur genannt werden, wenn sie tatsächlich bekannt sind.

Wenn dir für eine konkrete Antwort eine Information fehlt, formuliere elegant und allgemein, statt etwas zu erfinden.
`;

const LANGUAGE_RULES = `
SPRACHREGELN:

- Antworte normalerweise in der Sprache der letzten eingehenden Nachricht.
- Deutsch -> Deutsch.
- Englisch -> Englisch.
- Spanisch -> Spanisch.

Bei Spanisch:
- Marcel selbst spricht noch kein Spanisch.
- Die Nachricht darf trotzdem natürlich auf Spanisch formuliert werden, weil Übersetzungshilfe benutzt wird.
- Wenn das Thema Sprache oder ein persönliches Treffen aufkommt, darf niemals der falsche Eindruck entstehen, Marcel könne fließend Spanisch sprechen.
- Falls passend, kann natürlich erwähnt werden, dass er Übersetzungshilfe benutzt und Spanisch lernen möchte.
`;

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id SERIAL PRIMARY KEY,
      whatsapp_jid TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      whatsapp_jid TEXT NOT NULL,
      direction TEXT NOT NULL,
      message_text TEXT,
      whatsapp_message_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  console.log("PostgreSQL bereit.");
}

async function saveMessage(
  jid,
  direction,
  text,
  whatsappMessageId = null
) {
  await pool.query(
    `
      INSERT INTO contacts (
        whatsapp_jid,
        updated_at
      )
      VALUES ($1, NOW())
      ON CONFLICT (whatsapp_jid)
      DO UPDATE SET updated_at = NOW()
    `,
    [jid]
  );

  const result = await pool.query(
    `
      INSERT INTO messages (
        whatsapp_jid,
        direction,
        message_text,
        whatsapp_message_id
      )
      VALUES ($1, $2, $3, $4)
      RETURNING id
    `,
    [
      jid,
      direction,
      text || null,
      whatsappMessageId
    ]
  );

  return result.rows[0].id;
}

async function getConversationHistory(
  jid,
  beforeMessageId = null
) {
  let result;

  if (beforeMessageId) {
    result = await pool.query(
      `
        SELECT
          direction,
          message_text
        FROM messages
        WHERE whatsapp_jid = $1
          AND message_text IS NOT NULL
          AND id < $2
        ORDER BY id DESC
        LIMIT 20
      `,
      [jid, beforeMessageId]
    );
  } else {
    result = await pool.query(
      `
        SELECT
          direction,
          message_text
        FROM messages
        WHERE whatsapp_jid = $1
          AND message_text IS NOT NULL
        ORDER BY id DESC
        LIMIT 20
      `,
      [jid]
    );
  }

  return result.rows.reverse();
}

async function generateAIReply(
  jid,
  incomingText,
  incomingMessageDbId
) {
  const history =
    await getConversationHistory(
      jid,
      incomingMessageDbId
    );

  const conversation = history
    .map((item) => {
      const speaker =
        item.direction === "incoming"
          ? "Andere Person"
          : "Marcel";

      return `${speaker}: ${item.message_text}`;
    })
    .join("\n");

  const response =
    await openai.responses.create({
      model: "gpt-5-mini",

      instructions: `
Du schreibst private WhatsApp-Nachrichten im Namen von Marcel.

${MARCEL_PROFILE}

${WRITING_STYLE}

${TRUTH_RULES}

${LANGUAGE_RULES}

Nutze den bisherigen Gesprächsverlauf als Gedächtnis.
Widersprich früheren Aussagen nicht.
Frage nichts erneut, was bereits beantwortet wurde.
Gib ausschließlich die Nachricht aus, die Marcel senden soll.
Keine Analyse.
Keine Erklärung.
Keine Anführungszeichen um die Antwort.
`,

      input: `
BISHERIGER GESPRÄCHSVERLAUF:

${conversation || "[Noch kein früherer Verlauf gespeichert]"}

NEUE EINGEHENDE NACHRICHT:

${incomingText}

Formuliere jetzt Marcels passende WhatsApp-Antwort.
`
    });

  return response.output_text?.trim() || "";
}

app.get("/", (req, res) => {
  res.send(
    `Marcel WhatsApp Bot läuft. WhatsApp-Status: ${whatsappStatus}`
  );
});

app.get("/pairing-code", (req, res) => {
  if (pairingCode) {
    res.send(
      `Pairing Code: ${pairingCode}`
    );
  } else {
    res.send(
      "Noch kein Pairing-Code verfügbar."
    );
  }
});

app.get("/db-test", async (req, res) => {
  try {
    const result =
      await pool.query(
        "SELECT NOW() AS server_time"
      );

    res.json({
      ok: true,
      serverTime:
        result.rows[0].server_time
    });
  } catch (error) {
    console.error(
      "DB-Test fehlgeschlagen:",
      error
    );

    res.status(500).json({
      ok: false,
      error:
        "Datenbankverbindung fehlgeschlagen"
    });
  }
});

async function startWhatsApp() {
  const { state, saveCreds } =
    await useMultiFileAuthState(
      "/app/auth_info"
    );

  const { version } =
    await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger
  });

  sock.ev.on(
    "creds.update",
    saveCreds
  );

  sock.ev.on(
    "messages.upsert",
    async (event) => {
      if (event.type !== "notify") {
        return;
      }

      for (const message of event.messages) {
        if (message.key.fromMe) {
          continue;
        }

        const jid =
          message.key.remoteJid;

        if (!jid) {
          continue;
        }

        const text =
          message.message?.conversation ||
          message.message
            ?.extendedTextMessage?.text ||
          "";

        if (!text) {
          continue;
        }

        console.log(
          "NEUE WHATSAPP-NACHRICHT"
        );

        console.log(
          "Von:",
          jid
        );

        console.log(
          "Text:",
          text
        );

        try {
          const incomingMessageDbId =
            await saveMessage(
              jid,
              "incoming",
              text,
              message.key.id || null
            );

          console.log(
            "Eingehende Nachricht in PostgreSQL gespeichert."
          );

          const aiReply =
            await generateAIReply(
              jid,
              text,
              incomingMessageDbId
            );

          if (!aiReply) {
            console.log(
              "OpenAI hat keine Antwort erzeugt."
            );

            continue;
          }

          await sock.sendMessage(
            jid,
            {
              text: aiReply
            }
          );

          await saveMessage(
            jid,
            "outgoing",
            aiReply
          );

          console.log(
            "KI-ANTWORT GESENDET:",
            aiReply
          );
        } catch (error) {
          console.error(
            "Fehler bei KI-Antwort:",
            error
          );
        }
      }
    }
  );

  sock.ev.on(
    "connection.update",
    async (update) => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      if (
        connection === "open"
      ) {
        whatsappStatus =
          "connected";

        pairingCode = null;

        console.log(
          "WhatsApp verbunden."
        );
      }

      if (
        connection === "connecting"
      ) {
        whatsappStatus =
          "connecting";
      }

      if (
        qr &&
        !state.creds.registered &&
        !pairingCode
      ) {
        const phoneNumber =
          process.env
            .WHATSAPP_PHONE_NUMBER;

        if (phoneNumber) {
          try {
            pairingCode =
              await sock.requestPairingCode(
                phoneNumber.replace(
                  /\D/g,
                  ""
                )
              );

            console.log(
              "PAIRING CODE:",
              pairingCode
            );
          } catch (error) {
            console.error(
              "Pairing-Code Fehler:",
              error
            );
          }
        } else {
          console.log(
            "WHATSAPP_PHONE_NUMBER ist noch nicht in Railway gesetzt."
          );
        }
      }

      if (
        connection === "close"
      ) {
        whatsappStatus =
          "disconnected";

        const statusCode =
          lastDisconnect
            ?.error
            ?.output
            ?.statusCode;

        if (
          statusCode !==
          DisconnectReason.loggedOut
        ) {
          console.log(
            "WhatsApp getrennt – neuer Verbindungsversuch."
          );

          setTimeout(
            startWhatsApp,
            5000
          );
        } else {
          console.log(
            "WhatsApp wurde ausgeloggt."
          );
        }
      }
    }
  );
}

app.listen(
  port,
  async () => {
    console.log(
      `Server läuft auf Port ${port}`
    );

    try {
      await initDatabase();
    } catch (error) {
      console.error(
        "PostgreSQL Initialisierung fehlgeschlagen:",
        error
      );
    }

    startWhatsApp().catch(
      console.error
    );
  }
);
