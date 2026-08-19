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

async function saveMessage(jid, direction, text, whatsappMessageId = null) {
  await pool.query(
    `
      INSERT INTO contacts (whatsapp_jid, updated_at)
      VALUES ($1, NOW())
      ON CONFLICT (whatsapp_jid)
      DO UPDATE SET updated_at = NOW()
    `,
    [jid]
  );

  await pool.query(
    `
      INSERT INTO messages (
        whatsapp_jid,
        direction,
        message_text,
        whatsapp_message_id
      )
      VALUES ($1, $2, $3, $4)
    `,
    [
      jid,
      direction,
      text || null,
      whatsappMessageId
    ]
  );
}

async function getConversationHistory(jid) {
  const result = await pool.query(
    `
      SELECT direction, message_text
      FROM messages
      WHERE whatsapp_jid = $1
      AND message_text IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 20
    `,
    [jid]
  );

  return result.rows.reverse();
}

async function generateAIReply(jid, incomingText) {
  const history = await getConversationHistory(jid);

  const conversation = history
    .map((item) => {
      const speaker =
        item.direction === "incoming"
          ? "Andere Person"
          : "Marcel";

      return `${speaker}: ${item.message_text}`;
    })
    .join("\n");

  const response = await openai.responses.create({
    model: "gpt-5-mini",
    instructions: `
Du schreibst WhatsApp-Antworten im Namen von Marcel.

Wichtige Regeln:
- Antworte natürlich, kurz und menschlich.
- Keine langen Erklärungen.
- Keine Erwähnung, dass du eine KI oder ein Bot bist.
- Antworte grundsätzlich in der Sprache der letzten eingehenden Nachricht.
- Wenn die Nachricht Spanisch ist, antworte auf Spanisch.
- Wenn die Nachricht Deutsch ist, antworte auf Deutsch.
- Wenn die Nachricht Englisch ist, antworte auf Englisch.
- Erfinde keine persönlichen Fakten über Marcel.
- Nutze den bisherigen Gesprächsverlauf, um Wiederholungen zu vermeiden.
- Die Antwort soll wie eine normale WhatsApp-Nachricht wirken.
`,
    input: `
Bisheriger Gesprächsverlauf:
${conversation}

Neue Nachricht:
${incomingText}

Schreibe jetzt nur die passende WhatsApp-Antwort.
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
    res.send(`Pairing Code: ${pairingCode}`);
  } else {
    res.send("Noch kein Pairing-Code verfügbar.");
  }
});

app.get("/db-test", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT NOW() AS server_time"
    );

    res.json({
      ok: true,
      serverTime: result.rows[0].server_time
    });
  } catch (error) {
    console.error("DB-Test fehlgeschlagen:", error);

    res.status(500).json({
      ok: false,
      error: "Datenbankverbindung fehlgeschlagen"
    });
  }
});

async function startWhatsApp() {
  const { state, saveCreds } =
    await useMultiFileAuthState("/app/auth_info");

  const { version } =
    await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (event) => {
    if (event.type !== "notify") return;

    for (const message of event.messages) {
      if (message.key.fromMe) continue;

      const jid = message.key.remoteJid;
      if (!jid) continue;

      const text =
        message.message?.conversation ||
        message.message?.extendedTextMessage?.text ||
        "";

      if (!text) continue;

      console.log("NEUE WHATSAPP-NACHRICHT");
      console.log("Von:", jid);
      console.log("Text:", text);

      try {
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
          await generateAIReply(jid, text);

        if (!aiReply) {
          console.log(
            "OpenAI hat keine Antwort erzeugt."
          );
          continue;
        }

        await sock.sendMessage(jid, {
          text: aiReply
        });

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
  });

  sock.ev.on(
    "connection.update",
    async (update) => {
      const {
        connection,
        lastDisconnect,
        qr
      } = update;

      if (connection === "open") {
        whatsappStatus = "connected";
        pairingCode = null;

        console.log("WhatsApp verbunden.");
      }

      if (connection === "connecting") {
        whatsappStatus = "connecting";
      }

      if (
        qr &&
        !state.creds.registered &&
        !pairingCode
      ) {
        const phoneNumber =
          process.env.WHATSAPP_PHONE_NUMBER;

        if (phoneNumber) {
          try {
            pairingCode =
              await sock.requestPairingCode(
                phoneNumber.replace(/\D/g, "")
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

      if (connection === "close") {
        whatsappStatus = "disconnected";

        const statusCode =
          lastDisconnect?.error?.output
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

app.listen(port, async () => {
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

  startWhatsApp().catch(console.error);
});
