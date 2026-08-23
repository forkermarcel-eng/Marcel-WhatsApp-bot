import fs from "fs";
import crypto from "crypto";
import pg from "pg";

const {
  Pool
} = pg;


/* ==================================================
   CONFIG
================================================== */

const IMPORT_FILE =
  new URL(
    "../imports/sandry/sandry_chat.txt",
    import.meta.url
  );


const CONTACT_NAMES = [
  "sandry",
  "sandy",
  "san"
];


const CONTACT_IDENTITY_KEYS = [
  "sandy_san_32",
  "sandry"
];


const INCOMING_NAMES = [
  "sandry"
];


const OUTGOING_NAMES = [
  "🤨"
];


/*
  Der WhatsApp-Export wurde im August in Deutschland
  erstellt. Deutschland = CEST = UTC+02:00.

  Falls wir später andere Exporte importieren, können
  wir diesen Wert bei Bedarf als Environment Variable
  überschreiben.
*/

const IMPORT_TIMEZONE_OFFSET =
  process.env.IMPORT_TIMEZONE_OFFSET
  ||
  "+02:00";


/* ==================================================
   DATABASE
================================================== */

if (
  !process.env.DATABASE_URL
) {

  console.error(
    "❌ DATABASE_URL fehlt."
  );

  process.exit(
    1
  );

}


const pool =
  new Pool({
    connectionString:
      process.env.DATABASE_URL,

    ssl:
      process.env.DATABASE_URL.includes(
        "localhost"
      )
        ? false
        : {
            rejectUnauthorized:
              false
          }
  });


/* ==================================================
   TEXT HELPERS
================================================== */

function cleanInvisibleCharacters(
  value
) {

  return String(
    value ?? ""
  )
    .replace(
      /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
      ""
    );

}


function cleanText(
  value
) {

  return cleanInvisibleCharacters(
    value
  )
    .replace(
      /\r/g,
      ""
    )
    .trim();

}


function normalizeName(
  value
) {

  return cleanText(
    value
  )
    .toLowerCase();

}


/* ==================================================
   MEDIA PLACEHOLDERS

   Medien werden beim ersten Import NICHT als
   Nachrichten gespeichert.

   Wenn Text + "Bild weggelassen" in derselben
   Nachricht stehen, bleibt nur der echte Text übrig.

   Dadurch können wir später denselben Chat mit Medien
   erneut importieren, ohne den Text doppelt anzulegen.
================================================== */

function stripMediaPlaceholders(
  text
) {

  let result =
    cleanText(
      text
    );


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
    /\bGIF omitted\b/gi,
    /\baudio omitted\b/gi,
    /\bdocument omitted\b/gi

  ];


  for (
    const pattern
    of patterns
  ) {

    result =
      result.replace(
        pattern,
        ""
      );

  }


  return result
    .replace(
      /\s+/g,
      " "
    )
    .trim();

}


/* ==================================================
   SYSTEM MESSAGE FILTER
================================================== */

function isSystemMessage(
  text
) {

  const normalized =
    cleanText(
      text
    )
      .toLowerCase();


  if (
    !normalized
  ) {

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


  return systemFragments.some(
    fragment =>
      normalized.includes(
        fragment
      )
  );

}


/* ==================================================
   DATE
================================================== */

function createIsoTimestamp(
  datePart,
  timePart
) {

  const datePieces =
    String(
      datePart
    )
      .split(
        "."
      );


  if (
    datePieces.length !== 3
  ) {

    throw new Error(
      `Ungültiges Datum: ${datePart}`
    );

  }


  let [
    day,
    month,
    year
  ] =
    datePieces;


  if (
    year.length === 2
  ) {

    year =
      `20${year}`;

  }


  day =
    day.padStart(
      2,
      "0"
    );


  month =
    month.padStart(
      2,
      "0"
    );


  let normalizedTime =
    String(
      timePart
    );


  if (
    normalizedTime
      .split(":")
      .length === 2
  ) {

    normalizedTime +=
      ":00";

  }


  return (
    `${year}-${month}-${day}`
    +
    `T${normalizedTime}`
    +
    IMPORT_TIMEZONE_OFFSET
  );

}


/* ==================================================
   WHATSAPP EXPORT PARSER
================================================== */

function parseWhatsAppExport(
  rawText
) {

  const text =
    cleanInvisibleCharacters(
      rawText
    )
      .replace(
        /\r\n/g,
        "\n"
      )
      .replace(
        /\r/g,
        "\n"
      );


  const lines =
    text.split(
      "\n"
    );


  /*
    Beispiel:

    [18.08.26, 14:15:23] Sandry: Nachricht
  */

  const messagePattern =
    /^\[(\d{1,2}\.\d{1,2}\.\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:]+):\s?(.*)$/;


  /*
    Erkennt auch WhatsApp-Systemzeilen mit Zeitstempel,
    die keinen normalen Absender enthalten.
  */

  const anyTimestampPattern =
    /^\[\d{1,2}\.\d{1,2}\.\d{2,4},\s*\d{1,2}:\d{2}(?::\d{2})?\]/;


  const parsed =
    [];


  let currentMessage =
    null;


  function finishCurrentMessage() {

    if (
      !currentMessage
    ) {

      return;

    }


    const sender =
      normalizeName(
        currentMessage.sender
      );


    let direction =
      null;


    if (
      INCOMING_NAMES.includes(
        sender
      )
    ) {

      direction =
        "incoming";

    }


    if (
      OUTGOING_NAMES.includes(
        sender
      )
    ) {

      direction =
        "outgoing";

    }


    /*
      Unbekannter Absender:
      nicht raten, sondern Nachricht überspringen.
    */

    if (
      !direction
    ) {

      console.warn(
        `⚠️ Unbekannter Absender übersprungen: ${currentMessage.sender}`
      );


      currentMessage =
        null;


      return;

    }


    const originalText =
      cleanText(
        currentMessage.text
      );


    if (
      isSystemMessage(
        originalText
      )
    ) {

      currentMessage =
        null;


      return;

    }


    const messageText =
      stripMediaPlaceholders(
        originalText
      );


    /*
      Reine Sticker-/Bild-/Video-Platzhalter werden
      zunächst nicht als Textnachricht gespeichert.
    */

    if (
      !messageText
    ) {

      currentMessage =
        null;


      return;

    }


    const createdAt =
      createIsoTimestamp(
        currentMessage.date,
        currentMessage.time
      );


    parsed.push({

      sender:
        currentMessage.sender,

      direction,

      messageText,

      originalText,

      createdAt

    });


    currentMessage =
      null;

  }


  for (
    const rawLine
    of lines
  ) {

    const line =
      cleanInvisibleCharacters(
        rawLine
      );


    const match =
      line.match(
        messagePattern
      );


    if (
      match
    ) {

      finishCurrentMessage();


      currentMessage = {

        date:
          match[1],

        time:
          match[2],

        sender:
          cleanText(
            match[3]
          ),

        text:
          match[4] ?? ""

      };


      continue;

    }


    /*
      Eine neue WhatsApp-Zeile mit Zeitstempel,
      aber ohne erkennbaren normalen Absender:
      vorherige Nachricht abschließen und Systemzeile
      ignorieren.
    */

    if (
      anyTimestampPattern.test(
        line
      )
    ) {

      finishCurrentMessage();


      currentMessage =
        null;


      continue;

    }


    /*
      Mehrzeilige WhatsApp-Nachricht:
      Folgezeilen werden an die vorherige Nachricht
      angehängt.
    */

    if (
      currentMessage
    ) {

      currentMessage.text +=
        `\n${line}`;

    }

  }


  finishCurrentMessage();


  return parsed;

}


/* ==================================================
   DATABASE SCHEMA HELPERS
================================================== */

async function getTableColumns(
  tableName
) {

  const result =
    await pool.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = $1
      `,
      [
        tableName
      ]
    );


  return new Set(
    result.rows.map(
      row =>
        row.column_name
    )
  );

}


/* ==================================================
   FIND EXISTING SANDRY CONTACT

   WICHTIG:
   Es wird absichtlich KEIN neuer Kontakt angelegt.

   Wir wollen das bestehende Sandy/San-Memory mit
   Sandry verbinden.

   Wenn kein eindeutiger Kontakt gefunden wird,
   bricht der Import ab.
================================================== */

async function findSandryContact() {

  const contactColumns =
    await getTableColumns(
      "contacts"
    );


  const searchableColumns =
    [

      "identity_key",
      "name",
      "display_name",
      "whatsapp_display_name",
      "nickname"

    ]
      .filter(
        column =>
          contactColumns.has(
            column
          )
      );


  if (
    searchableColumns.length === 0
  ) {

    throw new Error(
      "In contacts wurden keine verwendbaren Namensfelder gefunden."
    );

  }


  const conditions =
    [];


  const values =
    [];


  function addValue(
    value
  ) {

    values.push(
      value
    );


    return `$${values.length}`;

  }


  for (
    const column
    of searchableColumns
  ) {

    if (
      column === "identity_key"
    ) {

      for (
        const identityKey
        of CONTACT_IDENTITY_KEYS
      ) {

        const placeholder =
          addValue(
            identityKey.toLowerCase()
          );


        conditions.push(
          `LOWER(COALESCE(${column}::text, '')) = ${placeholder}`
        );

      }

    }


    for (
      const name
      of CONTACT_NAMES
    ) {

      const placeholder =
        addValue(
          name.toLowerCase()
        );


      conditions.push(
        `LOWER(COALESCE(${column}::text, '')) = ${placeholder}`
      );

    }

  }


  const result =
    await pool.query(
      `
        SELECT *
        FROM contacts
        WHERE
          ${conditions.join(
            "\nOR "
          )}
        ORDER BY id ASC
      `,
      values
    );


  if (
    result.rows.length === 0
  ) {

    throw new Error(
      [
        "Kein bestehender Sandry/Sandy/San-Kontakt gefunden.",
        "Der Import wurde sicherheitshalber NICHT ausgeführt.",
        "Es wurde KEIN neuer Kontakt erzeugt."
      ].join(
        " "
      )
    );

  }


  /*
    Falls verschiedene Suchbegriffe denselben Kontakt
    mehrfach treffen, PostgreSQL liefert ihn trotzdem
    nur einmal.

    Mehr als eine Zeile bedeutet daher tatsächlich,
    dass mehrere Kontakte passen.
  */

  if (
    result.rows.length > 1
  ) {

    console.error(
      "❌ Mehrere mögliche Sandry-Kontakte gefunden:"
    );


    for (
      const row
      of result.rows
    ) {

      console.error({

        id:
          row.id,

        name:
          row.name,

        display_name:
          row.display_name,

        whatsapp_display_name:
          row.whatsapp_display_name,

        nickname:
          row.nickname,

        identity_key:
          row.identity_key,

        whatsapp_jid:
          row.whatsapp_jid

      });

    }


    throw new Error(
      "Mehrere passende Kontakte gefunden. Import abgebrochen, damit keine Identitäten vermischt werden."
    );

  }


  return {
    contact:
      result.rows[0],

    columns:
      contactColumns
  };

}


/* ==================================================
   NORMALIZE SANDRY NAME
================================================== */

async function normalizeSandryContactName(
  contact,
  contactColumns
) {

  const updates =
    [];


  const values =
    [];


  function addUpdate(
    column,
    value
  ) {

    if (
      !contactColumns.has(
        column
      )
    ) {

      return;

    }


    values.push(
      value
    );


    updates.push(
      `${column} = $${values.length}`
    );

  }


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


  /*
    Identity-Key bleibt unverändert.
    Dadurch geht das bisherige Memory nicht verloren.
  */


  if (
    updates.length === 0
  ) {

    return;

  }


  values.push(
    contact.id
  );


  await pool.query(
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
   IMPORT MESSAGE ID

   Diese ID ist deterministisch.

   Derselbe Export erzeugt bei erneutem Import
   für dieselbe Nachricht exakt dieselbe ID.
================================================== */

function createImportMessageId({
  contactId,
  direction,
  createdAt,
  messageText
}) {

  const canonical =
    [
      "sandry",
      String(
        contactId
      ),
      direction,
      createdAt,
      messageText
    ].join(
      "\n"
    );


  const hash =
    crypto
      .createHash(
        "sha256"
      )
      .update(
        canonical,
        "utf8"
      )
      .digest(
        "hex"
      );


  return (
    "wa-import-sandry-v1-"
    +
    hash
  );

}


/* ==================================================
   CHECK EXISTING MESSAGE

   Zwei Schutzschichten:

   1. gleiche deterministische Import-ID
   2. gleicher JID + Richtung + Zeitpunkt + Text

   Dadurch kann derselbe vollständige Export später
   wiederholt importiert werden.
================================================== */

async function messageAlreadyExists({
  jid,
  direction,
  createdAt,
  messageText,
  importMessageId
}) {

  const result =
    await pool.query(
      `
        SELECT id
        FROM messages
        WHERE
          whatsapp_jid = $1
          AND
          (
            whatsapp_message_id = $2

            OR

            (
              direction = $3
              AND created_at = $4::timestamptz
              AND message_text = $5
            )
          )
        LIMIT 1
      `,
      [
        jid,
        importMessageId,
        direction,
        createdAt,
        messageText
      ]
    );


  return (
    result.rows.length > 0
  );

}


/* ==================================================
   INSERT MESSAGE
================================================== */

async function insertMessage({
  jid,
  direction,
  createdAt,
  messageText,
  importMessageId
}) {

  await pool.query(
    `
      INSERT INTO messages (
        whatsapp_jid,
        direction,
        message_text,
        whatsapp_message_id,
        created_at,
        is_edited,
        processing_status
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::timestamptz,
        FALSE,
        'imported'
      )
    `,
    [
      jid,
      direction,
      messageText,
      importMessageId,
      createdAt
    ]
  );

}


/* ==================================================
   UPDATE CONTACT TIMESTAMPS
================================================== */

async function updateContactAfterImport(
  contact,
  contactColumns,
  messages
) {

  if (
    messages.length === 0
  ) {

    return;

  }


  const firstMessage =
    messages[0];


  const lastMessage =
    messages[
      messages.length - 1
    ];


  const updates =
    [];


  const values =
    [];


  function addUpdate(
    column,
    sqlValue,
    value
  ) {

    if (
      !contactColumns.has(
        column
      )
    ) {

      return;

    }


    values.push(
      value
    );


    updates.push(
      `${column} = ${sqlValue(
        values.length
      )}`
    );

  }


  addUpdate(
    "first_contact_at",
    number =>
      `COALESCE(first_contact_at, $${number}::timestamptz)`,
    firstMessage.createdAt
  );


  addUpdate(
    "last_message_at",
    number =>
      `$${number}::timestamptz`,
    lastMessage.createdAt
  );


  if (
    contactColumns.has(
      "updated_at"
    )
  ) {

    updates.push(
      "updated_at = NOW()"
    );

  }


  if (
    updates.length === 0
  ) {

    return;

  }


  values.push(
    contact.id
  );


  await pool.query(
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
   IMPORT
================================================== */

async function runImport() {

  console.log(
    ""
  );


  console.log(
    "=========================================="
  );


  console.log(
    " Sandry WhatsApp Import"
  );


  console.log(
    "=========================================="
  );


  console.log(
    ""
  );


  if (
    !fs.existsSync(
      IMPORT_FILE
    )
  ) {

    throw new Error(
      "Importdatei imports/sandry/sandry_chat.txt wurde nicht gefunden."
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
    parseWhatsAppExport(
      rawText
    );


  console.log(
    `💬 ${parsedMessages.length} importierbare Textnachrichten erkannt.`
  );


  const incomingCount =
    parsedMessages.filter(
      message =>
        message.direction
        ===
        "incoming"
    ).length;


  const outgoingCount =
    parsedMessages.filter(
      message =>
        message.direction
        ===
        "outgoing"
    ).length;


  console.log(
    `   Sandry → Marcel: ${incomingCount}`
  );


  console.log(
    `   Marcel → Sandry: ${outgoingCount}`
  );


  console.log(
    ""
  );


  const {
    contact,
    columns:
      contactColumns
  } =
    await findSandryContact();


  console.log(
    "✅ Bestehender Kontakt gefunden:"
  );


  console.log({
    id:
      contact.id,

    name:
      contact.name,

    displayName:
      contact.display_name,

    whatsappDisplayName:
      contact.whatsapp_display_name,

    identityKey:
      contact.identity_key,

    jid:
      contact.whatsapp_jid
  });


  if (
    !contact.whatsapp_jid
  ) {

    throw new Error(
      "Der gefundene Kontakt besitzt keinen whatsapp_jid. Import abgebrochen."
    );

  }


  await normalizeSandryContactName(
    contact,
    contactColumns
  );


  console.log(
    "✅ Kontaktname auf Sandry vereinheitlicht."
  );


  console.log(
    ""
  );


  let inserted =
    0;


  let duplicates =
    0;


  let failed =
    0;


  const client =
    await pool.connect();


  try {

    await client.query(
      "BEGIN"
    );


    /*
      Innerhalb der Transaktion verwenden wir denselben
      Client für Prüfung und Insert.
    */

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
            message.messageText

        });


      const existing =
        await client.query(
          `
            SELECT id
            FROM messages
            WHERE
              whatsapp_jid = $1
              AND
              (
                whatsapp_message_id = $2

                OR

                (
                  direction = $3
                  AND created_at = $4::timestamptz
                  AND message_text = $5
                )
              )
            LIMIT 1
          `,
          [
            contact.whatsapp_jid,
            importMessageId,
            message.direction,
            message.createdAt,
            message.messageText
          ]
        );


      if (
        existing.rows.length > 0
      ) {

        duplicates++;


        continue;

      }


      try {

        await client.query(
          `
            INSERT INTO messages (
              whatsapp_jid,
              direction,
              message_text,
              whatsapp_message_id,
              created_at,
              is_edited,
              processing_status
            )
            VALUES (
              $1,
              $2,
              $3,
              $4,
              $5::timestamptz,
              FALSE,
              'imported'
            )
          `,
          [
            contact.whatsapp_jid,
            message.direction,
            message.messageText,
            importMessageId,
            message.createdAt
          ]
        );


        inserted++;


      } catch (
        error
      ) {

        failed++;


        console.error(
          `❌ Nachricht ${index + 1} konnte nicht importiert werden:`,
          error.message
        );


        throw error;

      }

    }


    if (
      parsedMessages.length > 0
    ) {

      const firstMessage =
        parsedMessages[0];


      const lastMessage =
        parsedMessages[
          parsedMessages.length - 1
        ];


      const contactUpdates =
        [];


      const updateValues =
        [];


      if (
        contactColumns.has(
          "first_contact_at"
        )
      ) {

        updateValues.push(
          firstMessage.createdAt
        );


        contactUpdates.push(
          `first_contact_at = COALESCE(first_contact_at, $${updateValues.length}::timestamptz)`
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
          `last_message_at = $${updateValues.length}::timestamptz`
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


      if (
        contactUpdates.length > 0
      ) {

        updateValues.push(
          contact.id
        );


        await client.query(
          `
            UPDATE contacts
            SET
              ${contactUpdates.join(",\n              ")}
            WHERE id = $${updateValues.length}
          `,
          updateValues
        );

      }

    }


    await client.query(
      "COMMIT"
    );


  } catch (
    error
  ) {

    await client.query(
      "ROLLBACK"
    );


    throw error;


  } finally {

    client.release();

  }


  console.log(
    ""
  );


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
    `❌ Fehler: ${failed}`
  );


  console.log(
    `💬 Gesamt erkannt: ${parsedMessages.length}`
  );


  console.log(
    ""
  );


  console.log(
    "Der Import kann später erneut ausgeführt werden."
  );


  console.log(
    "Bereits vorhandene Nachrichten werden übersprungen."
  );


  console.log(
    ""
  );

}


/* ==================================================
   START
================================================== */

try {

  await runImport();


  await pool.end();


  process.exit(
    0
  );


} catch (
  error
) {

  console.error(
    ""
  );


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
    error
  );


  try {

    await pool.end();

  } catch {
    // nichts
  }


  process.exit(
    1
  );

}
