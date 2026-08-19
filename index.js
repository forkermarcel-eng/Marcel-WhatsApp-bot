import express from "express";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import P from "pino";

const app = express();
const port = process.env.PORT || 3000;

let sock = null;
let whatsappStatus = "starting";
let pairingCode = null;

const logger = P({ level: "silent" });

app.get("/", (req, res) => {
  res.send(`Marcel WhatsApp Bot läuft. WhatsApp-Status: ${whatsappStatus}`);
});

app.get("/pairing-code", (req, res) => {
  if (pairingCode) {
    res.send(`Pairing Code: ${pairingCode}`);
  } else {
    res.send("Noch kein Pairing-Code verfügbar.");
  }
});

async function startWhatsApp() {
  const { state, saveCreds } =
    await useMultiFileAuthState("/app/auth_info");

  const { version } = await fetchLatestBaileysVersion();

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
      console.log("Text:", text || "[keine reine Textnachricht]");

      if (text) {
        try {
          await sock.sendMessage(jid, {
            text: "Test erfolgreich ✅ Der Marcel WhatsApp Bot kann automatisch antworten."
          });

          console.log("TESTANTWORT GESENDET");
        } catch (error) {
          console.error("Fehler beim Senden:", error);
        }
      }
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === "open") {
      whatsappStatus = "connected";
      pairingCode = null;
      console.log("WhatsApp verbunden.");
    }

    if (connection === "connecting") {
      whatsappStatus = "connecting";
    }

    if (qr && !state.creds.registered && !pairingCode) {
      const phoneNumber = process.env.WHATSAPP_PHONE_NUMBER;

      if (phoneNumber) {
        try {
          pairingCode = await sock.requestPairingCode(
            phoneNumber.replace(/\D/g, "")
          );

          console.log("PAIRING CODE:", pairingCode);
        } catch (error) {
          console.error("Pairing-Code Fehler:", error);
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
        lastDisconnect?.error?.output?.statusCode;

      if (statusCode !== DisconnectReason.loggedOut) {
        console.log("WhatsApp getrennt – neuer Verbindungsversuch.");
        setTimeout(startWhatsApp, 5000);
      } else {
        console.log("WhatsApp wurde ausgeloggt.");
      }
    }
  });
}

app.listen(port, () => {
  console.log(`Server läuft auf Port ${port}`);
  startWhatsApp().catch(console.error);
});
