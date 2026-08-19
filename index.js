import express from "express";
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

async function saveIncomingMessage(message, text) {
  const jid = message.key.remoteJid;
  if (!jid) return;

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
      "incoming",
      text || null,
      message.key.id || null
    ]
  );

  console.log("Nachricht in PostgreSQL gespeichert.");
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

      console.log("NEUE WHATSAPP-NACHRICHT");
      console.log("Von:", jid);
      console.log(
        "Text:",
        text || "[keine reine Textnachricht]"
      );

      try {
        await saveIncomingMessage(message, text);
      } catch (error) {
        console.error(
          "Fehler beim Speichern der Nachricht:",
          error
        );
      }

      if (text) {
        try {
          await sock.sendMessage(jid, {
            text:
              "Test erfolgreich ✅ Der Marcel WhatsApp Bot kann automatisch antworten."
          });

          console.log("TESTANTWORT GESENDET");
        } catch (error) {
          console.error(
            "Fehler beim Senden:",
            error
          );
        }
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
