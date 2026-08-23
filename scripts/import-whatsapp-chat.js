import fs from "fs";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;


/* ==================================================
   SANDRY WHATSAPP IMPORT
   - bestehender Kontakt: ID 48
   - kein neuer Kontakt wird angelegt
   - Persona-Testkontakte können nicht gewählt werden
   - wiederholbarer / duplikatsicherer Import
================================================== */

const IMPORT_FILE = new URL(
  "../imports/sandry/sandry_chat.txt",
  import.meta.url
);

const SANDRY_CONTACT_ID = 48;

const EXPECTED_SANDRY_JID =
  "profile-sandy-san-32@memory.local";

const INCOMING_SENDER = "sandry";

const OUTGOING_SENDER = "🤨";

const IMPORT_TIMEZONE_OFFSET =
  process.env.IMPORT_TIMEZONE_OFFSET || "+02:00";


/* ==================================================
   DATABASE
================================================== */

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL fehlt.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,

  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : {
        rejectUnauthorized: false
      }
});


/* ==================================================
   HELPERS
================================================== */

function cleanInvisibleCharacters(value) {
  return String(value ?? "").replace(
    /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
    ""
  );
}


function cleanText(value) {
  return cleanInvisibleCharacters(value)
    .replace(/\r/g, "")
    .trim();
}


function normalizeName(value) {
  return cleanText(value).toLowerCase();
}


function stripMediaPlaceholders(text) {
  let result = cleanText(text);

  const patterns = [
    /\bSticker weggelassen\b/gi,
    /\bBild weggelassen\b/gi,
    /\bVideo weggelassen\b/gi,
    /\bGIF weggelassen\b/gi,
    /\bAudio weggelassen\b/gi,
    /\bDokument weggelassen\b/gi,

    /\bsticker omitted\b/gi,
    /\bimage omitted\b/gi,
    /\bvideo omitted\b/gi,
    /\bgif omitted\b/gi,
    /\baudio omitted\b/gi,
    /\bdocument omitted\b/gi
  ];

  for (const pattern of patterns) {
    result = result.replace(pattern, "");
  }

  return result
    .replace(/\s+/g, " ")
    .trim();
}


function isSystemMessage(text) {
  const normalized =
    cleanText(text).toLowerCase();

  if (!normalized) {
    return true;
  }

  const systemFragments = [
    "nachrichten und anrufe sind ende-zu-ende-verschlüsselt",
    "messages and calls are end-to-end encrypted",

    "ist ein kontakt.",
    "is a contact.",

    "sicherheitsnummer wurde geändert",
    "security code changed",

    "du hast diese nachricht gelöscht",
    "you deleted this message",

    "diese nachricht wurde gelöscht",
    "this message was deleted"
  ];

  return systemFragments.some(fragment =>
    normalized.includes(fragment)
  );
}


/* ==================================================
   DATE
================================================== */

function createIsoTimestamp(datePart, timePart) {
  const pieces =
    String(datePart).split(".");

  if (pieces.length !== 3) {
    throw new Error(
      `Ungültiges WhatsApp-Datum: ${datePart}`
    );
  }

  let [day, month, year] = pieces;

  if (year.length === 2) {
    year = `20${year}`;
  }

  day = day.padStart(2, "0");
  month = month.padStart(2, "0");

  let normalizedTime =
    String(timePart);

  if (normalizedTime.split(":").length === 2) {
    normalizedTime += ":00";
  }

  return (
    `${year}-${month}-${day}` +
    `T${normalizedTime}` +
    IMPORT_TIMEZONE_OFFSET
  );
}


/* ==================================================
   WHATSAPP PARSER
================================================== */

function parseWhatsAppExport(rawText) {
  const text =
    cleanInvisibleCharacters(rawText)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");

  const lines =
    text.split("\n");

  /*
    Beispiel:
    [18.08.26, 14:15:23] Sandry: Nachricht
  */

  const messagePattern =
    /^\[(\d{1,2}\.\d{1,2}\.\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:]+):\s?(.*)$/;

  const anyTimestampPattern =
    /^\[\d{1,2}\.\d{1,2}\.\d{2,4},\s*\d{1,2}:\d{2}(?::\d{2})?\]/;

  const parsed = [];

  let currentMessage = null;


  function finishCurrentMessage() {
    if (!currentMessage) {
      return;
    }

    const sender =
      normalizeName(currentMessage.sender);

    let direction = null;

    if (sender === INCOMING_SENDER) {
      direction = "incoming";
    }

    if (sender === OUTGOING_SENDER) {
      direction = "outgoing";
    }

    if (!direction) {
      console.warn(
        `⚠️ Unbekannter Absender übersprungen: ${currentMessage.sender}`
      );

      currentMessage = null;
      return;
    }

    const originalText =
      cleanText(currentMessage.text);

    if (isSystemMessage(originalText)) {
      currentMessage = null;
      return;
    }

    const messageText =
      stripMediaPlaceholders(originalText);

    /*
      Reine Bild-/Sticker-/Video-Platzhalter
      importieren wir jetzt noch nicht.
    */

    if (!messageText) {
      currentMessage = null;
      return;
    }

    const createdAt =
      createIsoTimestamp(
        currentMessage.date,
        currentMessage.time
      );

    parsed.push({
      sender: currentMessage.sender,
      direction,
      messageText,
      createdAt
    });

    currentMessage = null;
  }


  for (const rawLine of lines) {
    const line =
      cleanInvisibleCharacters(rawLine);

    const match =
      line.match(messagePattern);

    if (match) {
      finishCurrentMessage();

      currentMessage = {
        date: match[1],
        time: match[2],
        sender: cleanText(match[3]),
        text: match[4] ?? ""
      };

      continue;
    }

    /*
      Zeitstempel vorhanden, aber keine normale
      Chatnachricht -> alte Nachricht abschließen.
    */

    if (anyTimestampPattern.test(line)) {
      finishCurrentMessage();
      currentMessage = null;
      continue;
    }

    /*
      Mehrzeilige WhatsApp-Nachricht.
    */

    if (currentMessage) {
      currentMessage.text += `\n${line}`;
    }
  }

  finishCurrentMessage();

  return parsed;
}


/* ==================================================
   DATABASE SCHEMA
================================================== */

async function getTableColumns(tableName) {
  const result =
    await pool.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
      `,
      [tableName]
    );

  return new Set(
    result.rows.map(
      row => row.column_name
    )
  );
}


/* ==================================================
   LOAD EXACT SANDRY CONTACT
================================================== */

async function getSandryContact() {
  const result =
    await pool.query(
      `
        SELECT *
        FROM contacts
        WHERE id = $1
        LIMIT 1
      `,
      [SANDRY_CONTACT_ID]
    );

  if (result.rows.length === 0) {
    throw new Error(
      `Kontakt ID ${SANDRY_CONTACT_ID} existiert nicht. Import abgebrochen.`
    );
  }

  const contact =
    result.rows[0];

  const actualJid =
    String(
      contact.whatsapp_jid || ""
    ).trim();


  /*
    Entscheidende Sicherheitsprüfung:
    ID UND JID müssen zusammenpassen.
  */

  if (
    actualJid !== EXPECTED_SANDRY_JID
  ) {
    console.error(
      "❌ Sicherheitsprüfung fehlgeschlagen."
    );

    console.error({
      expectedId:
        SANDRY_CONTACT_ID,

      actualId:
        contact.id,

      expectedJid:
        EXPECTED_SANDRY_JID,

      actualJid
    });

    throw new Error(
      "Kontakt ID 48 besitzt nicht die erwartete Sandry-JID. Import wurde NICHT ausgeführt."
    );
  }


  if (
    actualJid.toLowerCase().includes(
      "@persona.test"
    )
  ) {
    throw new Error(
      "Sicherheitsstopp: Persona-Testkontakt erkannt."
    );
  }


  console.log(
    "🔒 Kontakt-ID und JID erfolgreich geprüft."
  );

  console.log(
    `🎯 Sandry-Kontakt: ID ${contact.id}`
  );

  console.log(
    `🎯 JID: ${actualJid}`
  );

  return contact;
}


/* ==================================================
   NORMALIZE CONTACT NAME
================================================== */

async function normalizeSandryContact(
  client,
  contact,
  contactColumns
) {
  const updates = [];
  const values = [];


  function addUpdate(
    column,
    value
  ) {
    if (!contactColumns.has(column)) {
      return;
    }

    values.push(value);

    updates.push(
      `${column} = $${values.length}`
    );
  }


  /*
    Wir korrigieren nur sichtbare Namensfelder.

    whatsapp_jid bleibt unverändert.
    Memory-Zuordnung bleibt unverändert.
  */

  addUpdate(
    "name",
    "Sandry"
  );

  addUpdate(
    "display_name",
    "Sandry"
  );

  addUpdate(
    "whatsapp_display_name",
    "Sandry"
  );


  if (
    contactColumns.has("updated_at")
  ) {
    updates.push(
      "updated_at = NOW()"
    );
  }


  if (updates.length === 0) {
    return;
  }


  values.push(contact.id);


  await client.query(
    `
      UPDATE contacts
      SET
        ${updates.join(",\n        ")}
      WHERE id = $${values.length}
    `,
    values
  );
}


/* ==================================================
   STABLE IMPORT IDS

   Der occurrence-Wert sorgt dafür, dass sogar zwei
   identische Nachrichten in derselben Sekunde
   auseinandergehalten werden können.

   Beim erneuten Import entsteht wieder dieselbe ID,
   solange der WhatsApp-Verlauf gleich ist.
================================================== */

function createImportMessageId({
  contactId,
  direction,
  createdAt,
  messageText,
  occurrence
}) {
  const canonical =
    [
      "whatsapp-export",
      "sandry",
      "v2",
      String(contactId),
      direction,
      createdAt,
      messageText,
      String(occurrence)
    ].join("\n");

  const hash =
    crypto
      .createHash("sha256")
      .update(canonical, "utf8")
      .digest("hex");

  return (
    "wa-import-sandry-v2-" +
    hash
  );
}


/* ==================================================
   ADD STABLE OCCURRENCE NUMBERS
================================================== */

function prepareMessagesForImport(messages) {
  const occurrences =
    new Map();

  return messages.map(message => {
    const baseKey =
      [
        message.direction,
        message.createdAt,
        message.messageText
      ].join("\n");

    const nextOccurrence =
      (occurrences.get(baseKey) || 0) + 1;

    occurrences.set(
      baseKey,
      nextOccurrence
    );

    return {
      ...message,
      occurrence: nextOccurrence
    };
  });
}


/* ==================================================
   IMPORT
================================================== */

async function runImport() {
  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    " SANDRY WHATSAPP IMPORT V2"
  );
  console.log(
    "=========================================="
  );
  console.log("");


  /* ==================================================
     FILE
  ================================================== */

  if (!fs.existsSync(IMPORT_FILE)) {
    throw new Error(
      "imports/sandry/sandry_chat.txt wurde nicht gefunden."
    );
  }

  console.log(
    "📄 WhatsApp-Datei gefunden."
  );


  const rawText =
    fs.readFileSync(
      IMPORT_FILE,
      "utf8"
    );


  const parsedMessages =
    prepareMessagesForImport(
      parseWhatsAppExport(rawText)
    );


  if (parsedMessages.length === 0) {
    throw new Error(
      "Keine importierbaren Textnachrichten erkannt."
    );
  }


  const incomingCount =
    parsedMessages.filter(
      message =>
        message.direction === "incoming"
    ).length;


  const outgoingCount =
    parsedMessages.filter(
      message =>
        message.direction === "outgoing"
    ).length;


  console.log(
    `💬 Importierbare Textnachrichten: ${parsedMessages.length}`
  );

  console.log(
    `   Sandry → Marcel: ${incomingCount}`
  );

  console.log(
    `   Marcel → Sandry: ${outgoingCount}`
  );

  console.log("");


  /* ==================================================
     CONTACT
  ================================================== */

  const contact =
    await getSandryContact();


  const contactColumns =
    await getTableColumns(
      "contacts"
    );


  const messageColumns =
    await getTableColumns(
      "messages"
    );


  const requiredMessageColumns = [
    "whatsapp_jid",
    "direction",
    "message_text",
    "whatsapp_message_id",
    "created_at"
  ];


  for (
    const column
    of requiredMessageColumns
  ) {
    if (!messageColumns.has(column)) {
      throw new Error(
        `messages.${column} fehlt. Import abgebrochen.`
      );
    }
  }


  /* ==================================================
     TRANSACTION
  ================================================== */

  const client =
    await pool.connect();


  let inserted = 0;
  let duplicates = 0;


  try {
    await client.query("BEGIN");


    /*
      Erst innerhalb der Transaktion wird der sichtbare
      Name von Sandy auf Sandry korrigiert.
    */

    await normalizeSandryContact(
      client,
      contact,
      contactColumns
    );


    console.log(
      "✅ Anzeigename auf Sandry vereinheitlicht."
    );

    console.log("");


    /* ==================================================
       MESSAGES
    ================================================== */

    for (
      let index = 0;
      index < parsedMessages.length;
      index++
    ) {
      const message =
        parsedMessages[index];


      const importMessageId =
        createImportMessageId({
          contactId:
            contact.id,

          direction:
            message.direction,

          createdAt:
            message.createdAt,

          messageText:
            message.messageText,

          occurrence:
            message.occurrence
        });


      /*
        Duplikatschutz:
        Derselbe WhatsApp-Export erzeugt dieselbe
        whatsapp_message_id.

        Deshalb kann der gesamte Verlauf später erneut
        importiert werden.
      */

      const existing =
        await client.query(
          `
            SELECT id
            FROM messages
            WHERE whatsapp_message_id = $1
            LIMIT 1
          `,
          [importMessageId]
        );


      if (existing.rows.length > 0) {
        duplicates++;
        continue;
      }


      const insertColumns = [
        "whatsapp_jid",
        "direction",
        "message_text",
        "whatsapp_message_id",
        "created_at"
      ];


      const insertValues = [
        contact.whatsapp_jid,
        message.direction,
        message.messageText,
        importMessageId,
        message.createdAt
      ];


      const placeholders = [
        "$1",
        "$2",
        "$3",
        "$4",
        "$5::timestamptz"
      ];


      /*
        Optionale bestehende DB-Spalten.
      */

      if (
        messageColumns.has(
          "is_edited"
        )
      ) {
        insertColumns.push(
          "is_edited"
        );

        insertValues.push(false);

        placeholders.push(
          `$${insertValues.length}`
        );
      }


      if (
        messageColumns.has(
          "processing_status"
        )
      ) {
        insertColumns.push(
          "processing_status"
        );

        insertValues.push(
          "imported"
        );

        placeholders.push(
          `$${insertValues.length}`
        );
      }


      await client.query(
        `
          INSERT INTO messages (
            ${insertColumns.join(",\n            ")}
          )
          VALUES (
            ${placeholders.join(",\n            ")}
          )
        `,
        insertValues
      );


      inserted++;


      if (
        inserted > 0
        &&
        inserted % 100 === 0
      ) {
        console.log(
          `   ${inserted} Nachrichten importiert …`
        );
      }
    }


    /* ==================================================
       CONTACT TIMESTAMPS
    ================================================== */

    const firstMessage =
      parsedMessages[0];


    const lastMessage =
      parsedMessages[
        parsedMessages.length - 1
      ];


    const contactUpdates = [];
    const updateValues = [];


    if (
      contactColumns.has(
        "first_contact_at"
      )
    ) {
      updateValues.push(
        firstMessage.createdAt
      );

      contactUpdates.push(
        `first_contact_at = LEAST(
          COALESCE(
            first_contact_at,
            $${updateValues.length}::timestamptz
          ),
          $${updateValues.length}::timestamptz
        )`
      );
    }


    if (
      contactColumns.has(
        "last_message_at"
      )
    ) {
      updateValues.push(
        lastMessage.createdAt
      );

      contactUpdates.push(
        `last_message_at = GREATEST(
          COALESCE(
            last_message_at,
            $${updateValues.length}::timestamptz
          ),
          $${updateValues.length}::timestamptz
        )`
      );
    }


    if (
      contactColumns.has(
        "updated_at"
      )
    ) {
      contactUpdates.push(
        "updated_at = NOW()"
      );
    }


    if (contactUpdates.length > 0) {
      updateValues.push(
        contact.id
      );

      await client.query(
        `
          UPDATE contacts
          SET
            ${contactUpdates.join(",\n            ")}
          WHERE id = $${updateValues.length}
        `,
        updateValues
      );
    }


    /* ==================================================
       FINAL SAFETY CHECK
    ================================================== */

    const importedCountResult =
      await client.query(
        `
          SELECT COUNT(*)::integer AS count
          FROM messages
          WHERE whatsapp_jid = $1
            AND whatsapp_message_id
                LIKE 'wa-import-sandry-v2-%'
        `,
        [contact.whatsapp_jid]
      );


    const storedImportCount =
      Number(
        importedCountResult.rows[0]?.count || 0
      );


    console.log("");
    console.log(
      `🔎 Sandry-Importnachrichten jetzt in DB: ${storedImportCount}`
    );


    await client.query("COMMIT");


  } catch (error) {
    await client.query("ROLLBACK");

    console.error("");
    console.error(
      "↩️ Transaktion wurde vollständig zurückgerollt."
    );

    throw error;

  } finally {
    client.release();
  }


  /* ==================================================
     SUCCESS
  ================================================== */

  console.log("");
  console.log(
    "=========================================="
  );
  console.log(
    " IMPORT ABGESCHLOSSEN"
  );
  console.log(
    "=========================================="
  );

  console.log(
    `✅ Neu importiert: ${inserted}`
  );

  console.log(
    `↩️ Bereits vorhanden: ${duplicates}`
  );

  console.log(
    `💬 Gesamt erkannt: ${parsedMessages.length}`
  );

  console.log(
    `👤 Kontakt-ID: ${contact.id}`
  );

  console.log(
    "👤 Kontakt: Sandry"
  );

  console.log(
    `🔗 JID: ${contact.whatsapp_jid}`
  );

  console.log("");
  console.log(
    "✅ Kein neuer Kontakt wurde angelegt."
  );

  console.log(
    "✅ Persona-Testkontakte wurden nicht verwendet."
  );

  console.log(
    "✅ Der gleiche Export kann später erneut importiert werden."
  );

  console.log("");
}


/* ==================================================
   START
================================================== */

try {
  await runImport();

  await pool.end();

  process.exit(0);

} catch (error) {
  console.error("");
  console.error(
    "=========================================="
  );
  console.error(
    " IMPORT ABGEBROCHEN"
  );
  console.error(
    "=========================================="
  );

  console.error(
    error?.stack ||
    error?.message ||
    error
  );

  try {
    await pool.end();
  } catch {
    // nichts
  }

  process.exit(1);
}
