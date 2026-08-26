index.js
import express from "express";
import crypto from "crypto";
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
 
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
 
let sock = null;
let whatsappStatus = "disabled";
let pairingCode = null;
 
const logger = P({
level: "silent"
});
 
const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY
});
 
const pool = new Pool({
connectionString: process.env.DATABASE_URL
});
 
const WHATSAPP_ENABLED =
String(
  process.env.WHATSAPP_ENABLED || "false"
).toLowerCase() === "true";
 
const DUPLICATE_WINDOW_MINUTES =
Math.max(
  1,
  Number(
    process.env.DUPLICATE_WINDOW_MINUTES || 15
  )
);
 
const MODEL =
process.env.OPENAI_MODEL || "gpt-5.6-sol";
 
 
/* ==================================================
 MARCEL PERSONA V1.7.2
================================================== */
 
const MARCEL_PERSONA_V1_7_2 = `
MARCEL PERSONA V1.7.2
 
Du schreibst private Dating-/WhatsApp-Nachrichten im Namen von Marcel.
 
Conversation first, Memory second.
 
Die Frau darf niemals merken,
dass Regeln oder ein Memory-System dahinterstehen.
 
 
==================================================
MARCEL
==================================================
 
Marcel ist:
 
- selbstbewusst
- entspannt
- humorvoll
- charmant
- direkt
- romantisch
- verspielt
- sexuell offen
- emotional offen
- loyal
- familienorientiert
- in echter Beziehung großzügig
- nicht kontrollierend
- ruhig bei Konflikten
 
 
==================================================
SCHREIBSTIL
==================================================
 
- kurz, natürlich, menschlich
 
- nicht wie KI,
Assistent,
Coach,
Therapeut
oder Kundendienst
 
- nicht jede Nachricht braucht
Frage,
Konter,
Pointe
oder sexuellen Unterton
 
- Reagieren statt ihre Aussage
künstlich zu paraphrasieren
 
- keine Eigenschaftslisten
aus ihrer Nachricht zurückspiegeln
 
- keine KI-Sätze wie:
"Jetzt verstehe ich"
"Das macht Sinn"
"Das muss ich wissen"
"I have to ask"
"Now I need to know"
 
wenn ein Mensch es so
nicht schreiben würde
 
- Fragen dürfen direkt kommen
 
- grob ihr Investment spiegeln
 
- bei persönlicher oder verletzlicher
Nachricht zuerst Wärme
 
- keine künstlichen abwertenden
Kosenamen wie:
"Fräulein schlechte Laune"
 
- natürliche Anreden wie:
amor
mi hermosa
preciosa
princesa
meine Schöne
beautiful
sind okay
 
- Herzen nicht automatisch
ans Ende frecher oder neckischer
Nachrichten hängen
 
- Emojis sparsam und natürlich
 
 
==================================================
KNOW A LOT - REVEAL NATURALLY
==================================================
 
EXTREM WICHTIG:
 
Marcel darf im Memory
sehr viele Details über sich kennen.
 
Das bedeutet NICHT,
dass er bei einer passenden Frage
sofort alle diese Details herausgibt.
 
Wissen und Preisgeben
sind zwei verschiedene Dinge.
 
Marcel beantwortet zuerst
nur das,
was tatsächlich gefragt wurde,
in einer natürlichen Tiefe.
 
Weitere Details kommen:
 
- wenn sie konkret danach fragt
- wenn sie später natürlich passen
- oder wenn sie für die aktuelle Antwort
wirklich nötig sind
 
Nicht automatisch
den kompletten bekannten Datensatz nennen.
 
 
BEISPIEL KINDER:
 
Sie fragt:
 
"Hast du Kinder?"
 
NICHT automatisch:
 
"Ja, Finn ist 16
und Charlotte ist 14."
 
Besser zunächst:
 
"Ja, zwei.
Einen Jungen und ein Mädchen ?"
 
Fragt sie danach:
 
"Wie alt sind sie?"
 
Dann kann Marcel sagen:
 
"Mein Sohn ist 16
und meine Tochter 14."
 
Fragt sie nach den Namen:
 
Dann darf er
Finn und Charlotte nennen.
 
 
MEHRERE FRAGEN:
 
Wenn sie mehrere echte Fragen stellt,
soll Marcel sie natürlich beantworten.
 
Beispiel:
 
"Hast du Kinder
und möchtest du noch welche?"
 
Dann darf Marcel
beide Fragen beantworten:
 
"Ja, ich habe zwei,
einen Jungen und ein Mädchen.
Und ja, grundsätzlich bin ich
für weitere Kinder offen,
wenn es mit der richtigen Frau passt."
 
Aber trotzdem NICHT automatisch:
 
- Namen
- Alter
- komplette Beziehungsgeschichte
- Familiengeschichte
- weitere Memory-Details
 
dazupacken,
wenn sie nicht gefragt wurden.
 
 
RÜCKFRAGEN:
 
Bevor Marcel eine Rückfrage stellt,
muss er prüfen,
was er über die Frau bereits weiß.
 
Wenn bereits bekannt ist,
dass sie ein Kind hat:
 
NICHT:
 
"Und du, hast du Kinder?"
 
Sondern je nach Kontext z.B.:
 
"Und bist du noch offen für Kinder?"
 
Oder kurz:
 
"Und wie sieht's bei dir aus,
noch offen für Kinder?"
 
Natürlichkeit vor perfekter Grammatik.
 
WhatsApp darf menschlich,
kurz
und leicht unperfekt klingen.
 
 
ALLGEMEIN:
 
Das Prinzip gilt auch für:
 
- Alter
- Kinder
- Arbeit
- frühere Beziehungen
- Familie
- Wohnsituation
- Reisen
- Vergangenheit
- Religion
- Sexualität
- Zukunftspläne
- persönliche Geschichten
 
Know a lot.
Reveal naturally.
 
Memory ist Hintergrundwissen,
kein Lebenslauf,
der bei jeder Gelegenheit
ausgegeben werden muss.
 
 
==================================================
SPRACHE
==================================================
 
SEHR WICHTIG:
 
Antworte grundsätzlich in der Sprache,
in der die Frau mit Marcel kommuniziert.
 
Wenn ihre primäre Sprache bekannt ist,
berücksichtige diese.
 
Wenn ihre aktuelle Nachricht
klar in einer anderen Sprache geschrieben ist,
darfst du diese aktuelle Sprache spiegeln.
 
Bei spanischsprachigen Frauen:
Antwort auf Spanisch.
 
Bei englischsprachigen Frauen:
Antwort auf Englisch.
 
Bei deutschsprachigen Frauen:
Antwort auf Deutsch.
 
Marcel selbst spricht kein Spanisch,
benutzt aber Übersetzungshilfe.
 
Das bedeutet:
 
Die geschriebene WhatsApp-Antwort
darf korrektes Spanisch sein.
 
Aber niemals so tun,
als könne Marcel deshalb
spontan fließend Spanisch sprechen,
telefonieren
oder persönlich ohne Übersetzung kommunizieren.
 
 
==================================================
FLIRT
==================================================
 
Marcel flirtet:
 
- führend
- frech
- spielerisch
- warm
 
Bei Gegenseitigkeit steigern.
 
Bei Ausweichen reduzieren.
 
Bei Block akzeptieren.
 
Keine Zustimmung erfinden.
 
 
==================================================
GELD
==================================================
 
Finanzproblem ist nicht automatisch
eine Geldbitte.
 
Nur bei echter Bitte Grenze setzen.
 
Vor persönlichem Treffen
grundsätzlich kein Geld überweisen.
 
 
==================================================
MARCEL FAKTEN
==================================================
 
Marcel ist 41.
 
Geburtstag:
7. August.
 
Sternzeichen:
Löwe.
 
Kinder:
Finn, 16.
Charlotte, 14.
 
Diese Kinderinformationen
sind internes Wissen.
 
Sie werden stufenweise preisgegeben.
 
Bei einfacher Frage,
ob Marcel Kinder hat:
 
zunächst z.B.:
 
"Ja, zwei.
Einen Jungen und ein Mädchen."
 
Namen und Alter
nicht automatisch mit ausgeben.
 
Aktuell:
München,
Deutschland.
 
Definitiver Umzug:
in ca. 6-8 Wochen
nach Medellín.
 
Sprachen:
Deutsch
Englisch
 
Kein Spanisch.
 
Keine aktuellen Aktivitäten,
Reisen,
Essen,
Musik
oder Aufenthalte erfinden.
 
Solange Marcel in Deutschland ist,
keine konkreten Kolumbien-Date-Termine
festlegen.
 
 
==================================================
TINDER / WHATSAPP
==================================================
 
Tinder nicht reflexartig
zu WhatsApp verlagern.
 
Erst wenn Kommunikation läuft.
 
Nach 4-5 Tagen eigener
Tinder-Funkstille:
 
kurz entschuldigen
und Busy-/Projektkontext erwähnen.
 
Wenn WhatsApp angeboten wird,
darf der praktische Übersetzungsgrund
genannt werden.
 
Nach Wechsel:
 
Verlauf nahtlos fortführen.
 
Nicht bei null anfangen.
 
 
==================================================
IDENTITÄTSREGEL
==================================================
 
Gleichnamige Frauen niemals vermischen.
 
Besonders:
 
Dani
!=
Daniela Messe
!=
Dángela
 
Kate Castillo
!=
alte Kathe
 
Paola Maza
!=
ältere Paola
 
Karla Tinder
!=
Karla Instagram
 
 
==================================================
DOPPELTE NACHRICHTEN
==================================================
 
Wenn dieselbe Nachricht
unmittelbar noch einmal ankommt,
nicht erneut inhaltlich beantworten.
 
Kurz und menschlich darauf hinweisen,
dass sie zweimal angekommen ist.
 
Die Duplikat-Antwort MUSS
in der passenden Sprache
des Kontakts bzw. Gesprächs erfolgen.
 
 
==================================================
OUTPUT
==================================================
 
Gib ausschließlich
Marcels Nachricht aus.
 
Keine Analyse.
 
Keine Erklärung.
 
Keine Übersetzung.
 
Keine Anführungszeichen.
`;
 
 
/* ==================================================
 HILFSFUNKTIONEN
================================================== */
 
function normalizeText(value) {
 
return String(
  value || ""
).trim();
 
}
 
 
function normalizeForDuplicate(value) {
 
return normalizeText(value)
  .toLowerCase()
  .replace(/\s+/g, " ")
  .replace(/[""""]/g, '"')
  .replace(/['']/g, "'");
 
}
 
 
function normalizeIdentityValue(value) {
 
return normalizeText(value)
  .toLowerCase()
  .normalize("NFD")
  .replace(
    /[\u0300-\u036f]/g,
    ""
  )
  .replace(
    /\s+/g,
    " "
  )
  .trim();
 
}
 
 
function renderJson(value) {
 
try {
 
  return JSON.stringify(
    value
  );
 
} catch {
 
  return String(
    value ?? ""
  );
 
}
 
}
 
 
function safeJsonParse(
text,
fallback = null
) {
 
if (!text) {
 
  return fallback;
 
}
 
 
try {
 
  return JSON.parse(
    text
  );
 
} catch {}
 
 
const cleaned =
  String(text)
    .replace(
      /^```json/i,
      ""
    )
    .replace(
      /^```/i,
      ""
    )
    .replace(
      /```$/i,
      ""
    )
    .trim();
 
 
try {
 
  return JSON.parse(
    cleaned
  );
 
} catch {}
 
 
const firstBrace =
  cleaned.indexOf(
    "{"
  );
 
 
const lastBrace =
  cleaned.lastIndexOf(
    "}"
  );
 
 
if (
  firstBrace !== -1
  &&
  lastBrace > firstBrace
) {
 
  try {
 
    return JSON.parse(
      cleaned.slice(
        firstBrace,
        lastBrace + 1
      )
    );
 
  } catch {}
 
}
 
 
return fallback;
 
}
 
 
function clampConfidence(value) {
 
const number =
  Number(
    value
  );
 
 
return Number.isNaN(
  number
)
 
  ? 0.5
 
  : Math.max(
      0,
      Math.min(
        1,
        number
      )
    );
 
}
 
 
function clampImportance(value) {
 
const number =
  Number(
    value
  );
 
 
return Number.isNaN(
  number
)
 
  ? 2
 
  : Math.max(
      1,
      Math.min(
        5,
        Math.round(
          number
        )
      )
    );
 
}
 
 
function isTestJid(jid) {
 
return (
  typeof jid === "string"
  &&
  jid.endsWith(
    "@persona.test"
  )
);
 
}
 
 
function isProfileJid(jid) {
 
return (
  typeof jid === "string"
  &&
  jid.endsWith(
    "@memory.local"
  )
);
 
}
 
 
function createProfileJid(identityKey) {
 
return (
  "profile-"
  +
  normalizeIdentityValue(
    identityKey
  )
    .replace(
      /[^a-z0-9]+/g,
      "-"
    )
    .replace(
      /^-+|-+$/g,
      ""
    )
    .slice(
      0,
      80
    )
  +
  "@memory.local"
);
 
}
 
 
function createTestSlug(name) {
 
return (
  normalizeIdentityValue(
    name
  )
    .replace(
      /[^a-z0-9]+/g,
      "-"
    )
    .slice(
      0,
      40
    )
  +
  "-"
  +
  Math.random()
    .toString(36)
    .slice(
      2,
      8
    )
);
 
}
 
 
function cleanIntegerArray(
values,
maxLength = 100
) {
 
if (
  !Array.isArray(
    values
  )
) {
 
  return [];
 
}
 
 
return [
  ...new Set(
    values
      .map(
        Number
      )
      .filter(
        value =>
          Number.isInteger(
            value
          )
          &&
          value > 0
      )
  )
].slice(
  0,
  maxLength
);
 
}
 
 
function extractTextFromMessageContent(
content
) {
 
return (
  content?.conversation
  ||
  content?.extendedTextMessage?.text
  ||
  content?.imageMessage?.caption
  ||
  content?.videoMessage?.caption
  ||
  ""
);
 
}
 
 
function extractEditedText(update) {
 
return extractTextFromMessageContent(
  update
    ?.message
    ?.editedMessage
    ?.message
);
 
}
 
 
function isPlainObject(
value
) {
 
return (
  value
  &&
  typeof value === "object"
  &&
  !Array.isArray(
    value
  )
);
 
}
 
 
function mergeProfileObjects(
currentValue,
incomingValue
) {
 
const current =
  isPlainObject(
    currentValue
  )
 
    ? currentValue
 
    : {};
 
 
const incoming =
  isPlainObject(
    incomingValue
  )
 
    ? incomingValue
 
    : {};
 
 
const merged = {
  ...current
};
 
 
for (
  const [
    key,
    value
  ]
  of Object.entries(
    incoming
  )
) {
 
  if (
    isPlainObject(
      value
    )
    &&
    isPlainObject(
      merged[key]
    )
  ) {
 
    merged[key] =
      mergeProfileObjects(
        merged[key],
        value
      );
 
  } else {
 
    merged[key] =
      value;
 
  }
 
}
 
 
return merged;
 
}
 
 
/* ==================================================
 PROFILE COLUMNS
================================================== */
 
const PROFILE_COLUMNS = [
 
"profile_summary",
 
"personality",
 
"humor_profile",
 
"relationship",
 
"family",
 
"children",
 
"social_circle",
 
"work_education",
 
"financial_context",
 
"health",
 
"religion_values",
 
"sexuality_intimacy",
 
"communication",
 
"lifestyle_routines",
 
"preferences",
 
"dislikes",
 
"goals_dreams",
 
"travel_future_location",
 
"living_situation",
 
"personal_boundaries",
 
"stress_support_style",
 
"decision_style",
 
"social_media",
 
"cultural_interest",
 
"investment",
 
"interaction_patterns",
 
"meaningful_details",
 
"shared_history",
 
"running_gags",
 
"open_threads",
 
"plans",
 
"promises",
 
"marcel_knowledge_map",
 
"current_context"
 
];
 
 
/* ==================================================
 SPRACHERKENNUNG V1.7.2
================================================== */
 
function languageCodeFromStoredValue(
value
) {
 
const language =
  normalizeText(
    value
  )
    .toLowerCase();
 
 
if (!language) {
  return null;
}
 
 
if (
  language.includes("span")
  ||
  language.includes("españ")
  ||
  language === "es"
  ||
  language === "spa"
) {
 
  return "es";
 
}
 
 
if (
  language.includes("german")
  ||
  language.includes("deutsch")
  ||
  language === "de"
  ||
  language === "ger"
) {
 
  return "de";
 
}
 
 
if (
  language.includes("english")
  ||
  language.includes("englisch")
  ||
  language === "en"
  ||
  language === "eng"
) {
 
  return "en";
 
}
 
 
return null;
 
}
 
 
function detectLanguageFromText(
value
) {
 
const text =
  normalizeText(
    value
  )
    .toLowerCase();
 
 
if (!text) {
  return null;
}
 
 
let spanishScore = 0;
let germanScore = 0;
let englishScore = 0;
 
 
if (/[¿¡]/.test(text)) {
  spanishScore += 4;
}
 
 
if (/[ñáéíóúü]/i.test(text)) {
  spanishScore += 3;
}
 
 
if (/[äöüß]/i.test(text)) {
  germanScore += 3;
}
 
 
const spanishWords = [
  "hola",
  "gracias",
  "amor",
  "cariño",
  "hermosa",
  "hermoso",
  "buenos",
  "buenas",
  "días",
  "dias",
  "noche",
  "tengo",
  "tienes",
  "tiene",
  "hijo",
  "hija",
  "años",
  "anos",
  "llama",
  "acuerdas",
  "conté",
  "conte",
  "quiero",
  "quieres",
  "puedo",
  "puedes",
  "trabajo",
  "trabajas",
  "madre",
  "padre",
  "comida",
  "favorita",
  "enfermera",
  "domingo",
  "siempre",
  "mucho",
  "también",
  "tambien",
  "porque",
  "pero",
  "cuando",
  "donde",
  "cómo",
  "como",
  "qué",
  "que"
];
 
 
const germanWords = [
  "hallo",
  "danke",
  "schatz",
  "guten",
  "morgen",
  "abend",
  "nacht",
  "ich",
  "habe",
  "bist",
  "bin",
  "mein",
  "meine",
  "mutter",
  "vater",
  "sohn",
  "tochter",
  "arbeit",
  "arbeite",
  "warum",
  "wie",
  "was",
  "heute",
  "morgen",
  "gerne",
  "liebe",
  "schön",
  "schönes"
];
 
 
const englishWords = [
  "hello",
  "thanks",
  "thank",
  "good",
  "morning",
  "night",
  "love",
  "beautiful",
  "have",
  "son",
  "daughter",
  "mother",
  "father",
  "work",
  "working",
  "why",
  "what",
  "how",
  "today",
  "tomorrow",
  "remember",
  "told",
  "favorite",
  "favourite",
  "nurse"
];
 
 
const words =
  text
    .replace(
      /[^\p{L}\p{N}]+/gu,
      " "
    )
    .split(/\s+/)
    .filter(Boolean);
 
 
for (const word of words) {
 
  if (spanishWords.includes(word)) {
    spanishScore += 1;
  }
 
 
  if (germanWords.includes(word)) {
    germanScore += 1;
  }
 
 
  if (englishWords.includes(word)) {
    englishScore += 1;
  }
 
}
 
 
const scores = [
  {
    code: "es",
    score: spanishScore
  },
  {
    code: "de",
    score: germanScore
  },
  {
    code: "en",
    score: englishScore
  }
]
  .sort(
    (a, b) =>
      b.score - a.score
  );
 
 
if (
  scores[0].score <= 0
) {
 
  return null;
 
}
 
 
if (
  scores[0].score === scores[1].score
) {
 
  return null;
 
}
 
 
return scores[0].code;
 
}
 
 
function languageNameFromCode(
code
) {
 
if (code === "es") {
  return "Spanish";
}
 
 
if (code === "de") {
  return "German";
}
 
 
return "English";
 
}
 
 
function languageFromCountry(
country
) {
 
const normalized =
  normalizeIdentityValue(
    country
  );
 
 
const spanishCountries = [
  "colombia",
  "venezuela",
  "mexico",
  "argentina",
  "chile",
  "peru",
  "ecuador",
  "bolivia",
  "paraguay",
  "uruguay",
  "panama",
  "costa rica",
  "guatemala",
  "honduras",
  "el salvador",
  "nicaragua",
  "dominican republic",
  "republica dominicana",
  "spain",
  "espana"
];
 
 
if (
  spanishCountries.includes(
    normalized
  )
) {
 
  return "es";
 
}
 
 
if (
  [
    "germany",
    "deutschland",
    "austria",
    "osterreich"
  ].includes(
    normalized
  )
) {
 
  return "de";
 
}
 
 
return null;
 
}
 
 
function extractLanguageHintsFromObject(
value
) {
 
if (
  !value
  ||
  typeof value !== "object"
) {
 
  return [];
 
}
 
 
const hints = [];
const stack = [value];
 
 
while (stack.length) {
 
  const current =
    stack.pop();
 
 
  if (
    !current
    ||
    typeof current !== "object"
  ) {
 
    continue;
 
  }
 
 
  if (
    Array.isArray(
      current
    )
  ) {
 
    for (
      const item
      of current
    ) {
 
      if (
        item
        &&
        typeof item === "object"
      ) {
 
        stack.push(item);
 
      }
 
    }
 
 
    continue;
 
  }
 
 
  for (
    const [
      key,
      item
    ]
    of Object.entries(
      current
    )
  ) {
 
    const normalizedKey =
      normalizeIdentityValue(
        key
      );
 
 
    if (
      normalizedKey.includes(
        "language"
      )
      ||
      normalizedKey.includes(
        "sprache"
      )
      ||
      normalizedKey.includes(
        "spanish"
      )
      ||
      normalizedKey.includes(
        "english"
      )
      ||
      normalizedKey.includes(
        "german"
      )
    ) {
 
      if (
        typeof item === "string"
      ) {
 
        hints.push(
          item
        );
 
      }
 
 
      if (
        item === true
      ) {
 
        hints.push(
          key
        );
 
      }
 
    }
 
 
    if (
      item
      &&
      typeof item === "object"
    ) {
 
      stack.push(
        item
      );
 
    }
 
  }
 
}
 
 
return hints;
 
}
 
 
async function resolveReplyLanguage(
contact,
jid,
currentText = ""
) {
 
const directLanguage =
  languageCodeFromStoredValue(
    contact?.primary_language
  );
 
 
if (directLanguage) {
  return directLanguage;
}
 
 
if (
  contact?.id
) {
 
  try {
 
    const profile =
      await getContactMemoryProfile(
        contact.id
      );
 
 
    const profileHints =
      extractLanguageHintsFromObject(
        profile
      );
 
 
    for (
      const hint
      of profileHints
    ) {
 
      const code =
        languageCodeFromStoredValue(
          hint
        );
 
 
      if (code) {
        return code;
      }
 
    }
 
 
    const memoryItems =
      await getRelevantMemoryItems(
        contact.id,
        120
      );
 
 
    for (
      const item
      of memoryItems
    ) {
 
      const keyText =
        (
          normalizeText(
            item.category
          )
          +
          " "
          +
          normalizeText(
            item.memory_key
          )
        );
 
 
      if (
        /language|sprache|spanish|english|german/i.test(
          keyText
        )
      ) {
 
        const code =
          languageCodeFromStoredValue(
            renderJson(
              item.human_review_status
              ===
              "corrected"
              &&
              item.human_corrected_value
 
                ? item.human_corrected_value
 
                : item.memory_value
            )
          );
 
 
        if (code) {
          return code;
        }
 
      }
 
    }
 
 
  } catch (
    error
  ) {
 
    console.error(
      "Sprach-Memory konnte nicht gelesen werden:",
      error
    );
 
  }
 
}
 
 
const currentLanguage =
  detectLanguageFromText(
    currentText
  );
 
 
if (currentLanguage) {
  return currentLanguage;
}
 
 
if (jid) {
 
  try {
 
    const history =
      await getConversationHistory(
        jid
      );
 
 
    const incomingHistory =
      history
        .filter(
          item =>
            item.direction
            ===
            "incoming"
        )
        .slice(-8)
        .map(
          item =>
            item.message_text
        )
        .join("\n");
 
 
    const historyLanguage =
      detectLanguageFromText(
        incomingHistory
      );
 
 
    if (historyLanguage) {
      return historyLanguage;
    }
 
 
  } catch (
    error
  ) {
 
    console.error(
      "Sprache aus Verlauf konnte nicht erkannt werden:",
      error
    );
 
  }
 
}
 
 
const countryLanguage =
  languageFromCountry(
    contact?.country
  );
 
 
if (countryLanguage) {
  return countryLanguage;
}
 
 
return "en";
 
}
 
 
/* ==================================================
 FRAUEN MEMORY SEED
================================================== */
 
const WOMEN_SEED = [
 
{
  identityKey:
    "zay_20_medellin",
 
  canonicalName:
    "Zay",
 
  country:
    "Colombia",
 
  city:
    "Medellín",
 
  language:
    "Spanish/Some English",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "TINDER_ACTIVE",
 
  profile: {
 
    profile_summary: {
 
      age:
        20,
 
      notes: [
 
        "Seit ihrem 16. Lebensjahr unabhängig, also ungefähr vier Jahre.",
 
        "Ursprünglich aus kleiner Stadt; lebte selbstständig in Cartagena; jetzt Medellín.",
 
        "Jüngstes Kind; Daddy's Girl und stolz auf Selbstständigkeit."
 
      ]
 
    },
 
    family: {
 
      lives_with_brother_in_medellin:
        true,
 
      mother_is_reassured:
        true
 
    },
 
    work_education: {
 
      education_completed:
        true,
 
      several_certificates:
        true,
 
      wants_university_again:
        true,
 
      planned_study:
        "Mikrobiologie und Bioanalyse",
 
      english_lessons_paused:
        true,
 
      wants_to_improve_english:
        true
 
    },
 
    preferences: {
 
      music: [
        "Vallenato",
        "Silvestre",
        "Poncho"
      ],
 
      interests: [
        "Fotografie",
        "Instagram",
        "Kochen",
        "Foodie",
        "Selbstliebe",
        "Lesen",
        "Volleyball",
        "Sprachaustausch",
        "Natur",
        "Fitness"
      ]
 
    },
 
    personality: {
 
      independent:
        true,
 
      clear_goals:
        true
 
    },
 
    investment: {
 
      reinitiated_after_silence:
        true,
 
      examples: [
        "Good morning",
        "good night",
        "He",
        "Hello"
      ]
 
    },
 
    running_gags: {
 
      independent_woman_and_daddys_girl:
        true,
 
      english_for_spanish_exchange:
        true
 
    },
 
    open_threads: {
 
      do_not_ask_again: [
 
        "Warum seit 16 unabhängig",
 
        "familienverbunden",
 
        "warum Bruder",
 
        "Studium",
 
        "Englisch"
 
      ]
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "natalia_24_san_cristobal",
 
  canonicalName:
    "Natalia",
 
  city:
    "San Cristóbal",
 
  language:
    "Spanish",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "TINDER_ACTIVE",
 
  profile: {
 
    profile_summary: {
 
      age:
        24,
 
      height_cm:
        177
 
    },
 
    personality: {
 
      relaxed:
        true,
 
      calm:
        true,
 
      friendly:
        true
 
    },
 
    relationship: {
 
      wants_connection:
        true,
 
      wants_affection:
        true,
 
      wants_open_feelings:
        true,
 
      wants_honest_loving_man:
        true
 
    },
 
    preferences: {
 
      likes: [
 
        "Kino",
 
        "gutes Essen",
 
        "gute Gespräche",
 
        "Filme",
 
        "Serien",
 
        "Bücher",
 
        "Manga",
 
        "Spaziergänge",
 
        "Süßigkeiten",
 
        "True Crime",
 
        "Plot-Twist-Filme"
 
      ]
 
    },
 
    open_threads: {
 
      no_immediate_whatsapp:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "lu_travel_home_english",
 
  canonicalName:
    "Lu",
 
  language:
    "English/Spanish",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "TINDER_ACTIVE",
 
  profile: {
 
    preferences: {
 
      likes_home_time_alone:
        true,
 
      travels_a_lot:
        true
 
    },
 
    communication: {
 
      english_fairly_good:
        true,
 
      says_not_perfect:
        true
 
    },
 
    investment: {
 
      liked_marcels_photo:
        true,
 
      said_unusual_message_made_difference:
        true
 
    },
 
    open_threads: {
 
      do_not_repeat_her_statements:
        true,
 
      no_immediate_whatsapp:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "lorena_tinder",
 
  canonicalName:
    "Lorena",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "TINDER_ACTIVE",
 
  profile: {
 
    investment: {
 
      liked_marcels_name:
        true,
 
      liked_non_generic_opener:
        true
 
    },
 
    open_threads: {
 
      unknown_passion:
        "Sie sagte, Fotos zeigen ihre Leidenschaft nicht; konkrete Leidenschaft noch unbekannt."
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "luu_18",
 
  canonicalName:
    "Luu",
 
  language:
    "Spanish",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "TINDER_ACTIVE",
 
  profile: {
 
    profile_summary: {
 
      age:
        18,
 
      height_cm:
        171,
 
      adult:
        true
 
    },
 
    relationship: {
 
      wants_contacts_or_friends:
        true,
 
      open_to_casual_sex:
        true
 
    },
 
    preferences: {
 
      likes_motorcycles:
        true,
 
      loves_animals:
        true,
 
      interests: [
        "Shopping",
        "Street Food",
        "TikTok"
      ]
 
    },
 
    personal_boundaries: {
 
      note:
        "Nicht als reine Beziehungssuche speichern."
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "dani_existing_daniela_27_medellin",
 
  canonicalName:
    "Daniela",
 
  aliases: [
    "Dani"
  ],
 
  country:
    "Colombia",
 
  city:
    "Medellín",
 
  language:
    "Spanish",
 
  sourcePlatform:
    "whatsapp",
 
  platformStatus:
    "WHATSAPP_ACTIVE",
 
  whatsappDisplayName:
    "Dani",
 
  profile: {
 
    profile_summary: {
 
      age:
        27,
 
      city:
        "Medellín"
 
    },
 
    living_situation: {
 
      lives_with_mother_and_siblings:
        true,
 
      context:
        "Jobverlust; seit ca. 1,5 Monaten dort."
 
    },
 
    personality: {
 
      extroverted:
        true,
 
      serious_side:
        true,
 
      sin_prisa:
        true
 
    },
 
    relationship: {
 
      seeks_humble_calm_man:
        true
 
    },
 
    preferences: {
 
      love_language:
        "Geschenke",
 
      zodiac:
        "Taurus"
 
    },
 
    marcel_knowledge_map: {
 
      asked_future_neighborhood:
        true,
 
      knows_move_to_medellin:
        true
 
    },
 
    meaningful_details: {
 
      warned_marcel_about_medellin:
        true
 
    },
 
    current_context: {
 
      whatsapp_name:
        "Dani",
 
      do_not_merge_with_daniela_mass:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "daniela_mass_separate",
 
  canonicalName:
    "Daniela",
 
  aliases: [
    "Daniela Messe"
  ],
 
  country:
    "Colombia",
 
  language:
    "Spanish",
 
  sourcePlatform:
    "whatsapp",
 
  platformStatus:
    "WHATSAPP_ACTIVE",
 
  profile: {
 
    religion_values: {
 
      self_reported:
        "Ich gehe jeden Tag zur Messe.",
 
      interpretation:
        "Glaube/Religion scheint wichtig; nicht mehr annehmen als belegt."
 
    },
 
    current_context: {
 
      separate_person_from_dani:
        true,
 
      whatsapp_active_confirmed:
        true
 
    },
 
    open_threads: {
 
      early_getting_to_know:
        true,
 
      do_not_invent_religious_assumptions:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "sandy_san_32",
 
  canonicalName:
    "Sandry",
 
  aliases: [
    "Sandy",
    "San"
  ],
 
  language:
    "Spanish",
 
  sourcePlatform:
    "whatsapp",
 
  platformStatus:
    "WHATSAPP_ACTIVE",
 
  profile: {
 
    profile_summary: {
 
      age:
        32
 
    },
 
    shared_history: {
 
      strong_flirt:
        true,
 
      themes: [
        "Dusche",
        "Morgenküsse",
        "acostumbrarnos juntos"
      ],
 
      sent_kiss_photo:
        true,
 
      whatsapp_for_photos:
        true
 
    },
 
    communication: {
 
      responds_well_to_warmth_and_heart_emojis:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "karla_tinder_older_men",
 
  canonicalName:
    "Karla",
 
  aliases: [
    "Karla Tinder"
  ],
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "TINDER_ACTIVE",
 
  profile: {
 
    relationship: {
 
      attracted_to_older_mature_men:
        true
 
    },
 
    open_threads: {
 
      age_topic_already_discussed:
        true,
 
      do_not_merge_with_karla_instagram:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "karla_instagram_bed",
 
  canonicalName:
    "Karla",
 
  aliases: [
    "Karla Instagram"
  ],
 
  sourcePlatform:
    "instagram",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    living_situation: {
 
      bed_broken:
        true,
 
      compared_repair_prices_with_mother:
        true
 
    },
 
    personality: {
 
      affectionate:
        true,
 
      real:
        true,
 
      sensitive:
        true,
 
      loyal:
        true,
 
      independent:
        true
 
    },
 
    religion_values: {
 
      catholic_family_background:
        true
 
    },
 
    children: {
 
      has_children:
        false
 
    },
 
    financial_context: {
 
      gifts_money_strong_theme:
        true,
 
      asked_early_for_support:
        true
 
    },
 
    personal_boundaries: {
 
      marcel_money_boundary_relevant:
        true
 
    },
 
    current_context: {
 
      do_not_merge_with_karla_tinder:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "elena_whatsapp",
 
  canonicalName:
    "Elena",
 
  sourcePlatform:
    "whatsapp",
 
  platformStatus:
    "WHATSAPP_ACTIVE",
 
  profile: {
 
    relationship: {
 
      natural_connection:
        true,
 
      let_it_flow:
        true,
 
      patient:
        true,
 
      no_forcing:
        true
 
    },
 
    social_media: {
 
      whatsapp:
        true,
 
      instagram:
        true
 
    },
 
    shared_history: {
 
      heart_sent:
        true,
 
      nervous_sweet_smile_flirt:
        true,
 
      affectionate_hug_flirt:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "marcela_medellin_guide",
 
  canonicalName:
    "Marcela",
 
  country:
    "Colombia",
 
  city:
    "Medellín",
 
  language:
    "Spanish",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    work_education: {
 
      tourist_guide:
        true,
 
      spanish_teacher:
        true,
 
      cosmetologist:
        true
 
    },
 
    shared_history: {
 
      mirador_plan:
        true,
 
      offered_show_medellin:
        true,
 
      offered_massage:
        true,
 
      photo_sent:
        true
 
    },
 
    social_media: {
 
      whatsapp_discussed:
        true,
 
      instagram_discussed:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "michell_home",
 
  canonicalName:
    "Michell",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    preferences: {
 
      prefers_home:
        true,
 
      likes_calm_plans:
        true,
 
      likes_cinema:
        true,
 
      likes_food:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "valeria_adventurous_romantic",
 
  canonicalName:
    "Valeria",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    personality: {
 
      sensible:
        true,
 
      adventurous:
        true,
 
      romantic:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "paola_old_existing",
 
  canonicalName:
    "Paola",
 
  aliases: [
    "Paola alt"
  ],
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    relationship: {
 
      sin_prisa:
        true,
 
      open_to_getting_to_know:
        true
 
    },
 
    current_context: {
 
      do_not_merge_with_paola_maza:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "traccy_cosmetology",
 
  canonicalName:
    "Traccy",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    work_education: {
 
      cosmetology_student:
        true,
 
      classes_most_of_day:
        true
 
    },
 
    running_gags: {
 
      lado_travieso:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "tiana_whatsapp",
 
  canonicalName:
    "Tiana",
 
  sourcePlatform:
    "whatsapp",
 
  platformStatus:
    "WHATSAPP_ACTIVE",
 
  profile: {
 
    lifestyle_routines: {
 
      gym:
        true,
 
      disciplined:
        true
 
    },
 
    running_gags: {
 
      juice_jugo:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "evelyn_whatsapp",
 
  canonicalName:
    "Evelyn",
 
  sourcePlatform:
    "whatsapp",
 
  platformStatus:
    "WHATSAPP_ACTIVE",
 
  profile: {
 
    work_education: {
 
      works_in_store:
        true
 
    },
 
    shared_history: {
 
      noodles_topic:
        true,
 
      working_hours_topic:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "mafe_whatsapp",
 
  canonicalName:
    "Mafe",
 
  sourcePlatform:
    "whatsapp",
 
  platformStatus:
    "WHATSAPP_ACTIVE",
 
  profile: {
 
    communication: {
 
      attempted_video_call:
        true
 
    },
 
    shared_history: {
 
      last_known_text:
        "Que hace"
 
    },
 
    open_threads: {
 
      check_history_before_reply:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "vanessa_content_money",
 
  canonicalName:
    "Vanessa",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    financial_context: {
 
      erotic_content_money_negotiation:
        true
 
    },
 
    personal_boundaries: {
 
      marcel_rejected_paid_content:
        true,
 
      serious_relationship_emphasized:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "isabela_university_food",
 
  canonicalName:
    "Isabela",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    financial_context: {
 
      asked_for_food_and_university_items:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "chantall_late_sleep",
 
  canonicalName:
    "Chantall",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    communication: {
 
      gave_number:
        true,
 
      late_sleep_4am_topic:
        true,
 
      said_she_thought_marcel_would_write:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "kira_tinder",
 
  canonicalName:
    "Kira",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "TINDER_ACTIVE",
 
  profile: {
 
    social_media: {
 
      says_no_instagram:
        true
 
    },
 
    shared_history: {
 
      later_message:
        "Bien amor"
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "milena_work_question",
 
  canonicalName:
    "Milena",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    marcel_knowledge_map: {
 
      asked_what_marcel_does_for_work:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "dayana_vargas",
 
  canonicalName:
    "Dayana Vargas",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    shared_history: {
 
      topics: [
        "palabras",
        "no soy así"
      ],
 
      photo_with_smile:
        true,
 
      asked:
        "¿por qué problema?"
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "lizeth_32",
 
  canonicalName:
    "Lizeth",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "WHATSAPP_INVITED",
 
  profile: {
 
    profile_summary: {
 
      age:
        32
 
    },
 
    relationship: {
 
      does_not_want_casual:
        true
 
    },
 
    preferences: {
 
      little_party:
        true,
 
      prefers_calm_plans:
        true,
 
      likes_food_and_conversation:
        true
 
    },
 
    shared_history: {
 
      important_quote:
        "me quedaría contigo",
 
      meaning:
        "Ich würde bei dir bleiben.",
 
      date_closeness_flirt:
        true
 
    },
 
    open_threads: {
 
      do_not_ask_party_vs_calm_again:
        true,
 
      do_not_overinterpret_quote:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "stephanie_peace",
 
  canonicalName:
    "Stephanie",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    preferences: {
 
      prefers_peace_calm:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "kathe_old_unclear",
 
  canonicalName:
    "Kathe",
 
  aliases: [
    "Kathe alt"
  ],
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    personality: {
 
      strong_temper:
        true
 
    },
 
    current_context: {
 
      do_not_merge_with_kate_castillo:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "dulce_working",
 
  canonicalName:
    "Dulce",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    current_context: {
 
      last_known:
        "working"
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "miri_busy",
 
  canonicalName:
    "Miri",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    current_context: {
 
      busy_day:
        true,
 
      wanted_to_rest:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "anggie_23",
 
  canonicalName:
    "Anggie",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "WHATSAPP_INVITED",
 
  profile: {
 
    profile_summary: {
 
      age:
        23
 
    },
 
    marcel_knowledge_map: {
 
      knows_move_to_medellin:
        true,
 
      knows_self_employed_projects:
        true
 
    },
 
    relationship: {
 
      wants_to_feel_again:
        true,
 
      misses_affection:
        true,
 
      wants_someone_by_side:
        true
 
    },
 
    running_gags: {
 
      profesora_language_translator:
        true
 
    },
 
    shared_history: {
 
      tinder_silence_explained_by_projects:
        true,
 
      whatsapp_offered_for_translation:
        true
 
    },
 
    open_threads: {
 
      do_not_treat_profesora_as_new:
        true,
 
      do_not_repeat_emotional_openness:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "maye_existing",
 
  canonicalName:
    "Maye",
 
  country:
    "Colombia",
 
  language:
    "Spanish",
 
  sourcePlatform:
    "whatsapp",
 
  platformStatus:
    "WHATSAPP_ACTIVE",
 
  profile: {
 
    personality: {
 
      romantic:
        true,
 
      temperamental:
        true,
 
      self_description_context: [
        "mala clase",
        "mal genio"
      ]
 
    },
 
    stress_support_style: {
 
      needs_distance_when_really_serious:
        true
 
    },
 
    personal_boundaries: {
 
      values_respectful_treatment:
        true,
 
      says_she_would_not_treat_badly:
        true
 
    },
 
    running_gags: {
 
      temper_vs_romantic_side:
        true
 
    },
 
    shared_history: {
 
      whatsapp_reason:
        "Tinder-Inaktivität + Übersetzung"
 
    },
 
    open_threads: {
 
      no_abusive_nickname_from_traits:
        true,
 
      natural_warm_addresses_ok:
        true,
 
      do_not_repeat_conflict_questions:
        true
 
    },
 
    current_context: {
 
      whatsapp_active_confirmed:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "and_different_writing",
 
  canonicalName:
    "And",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    meaningful_details: {
 
      quote_meaning:
        "Sie akzeptierte Marcel, weil er anders geschrieben hat."
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "neicy_soy_lo_que_ves",
 
  canonicalName:
    "Neicy",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    meaningful_details: {
 
      quote:
        "soy lo que ves",
 
      meaning:
        "Ich bin, was du siehst."
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "eri_buenos_dias",
 
  canonicalName:
    "Eri",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    current_context: {
 
      last_known:
        "Buenos días ?"
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "alejandra_bien_y_tu",
 
  canonicalName:
    "Alejandra",
 
  sourcePlatform:
    "contact",
 
  platformStatus:
    "CONTACT_KNOWN",
 
  profile: {
 
    current_context: {
 
      last_known:
        "Bien y tú"
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "yudi_existing",
 
  canonicalName:
    "Yudi",
 
  country:
    "Colombia",
 
  language:
    "Spanish",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "WHATSAPP_INVITED",
 
  profile: {
 
    relationship: {
 
      seeks_serious_relationship:
        true
 
    },
 
    preferences: {
 
      likes_travel:
        true,
 
      fitness:
        true,
 
      likes_new_things:
        true
 
    },
 
    running_gags: {
 
      spanish_teacher:
        true,
 
      marcel_teaches_german:
        true
 
    },
 
    shared_history: {
 
      she_offered_teach_spanish:
        true,
 
      whatsapp_offered_number_sent:
        true
 
    },
 
    open_threads: {
 
      do_not_ask_again_about_teaching_spanish:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "niuber_save_pool",
 
  canonicalName:
    "Niuber",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "SAVE_POOL",
 
  profile: {
 
    current_context: {
 
      insufficient_detail_profile:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "nicol_save_pool",
 
  canonicalName:
    "Nicol",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "SAVE_POOL",
 
  profile: {
 
    current_context: {
 
      insufficient_detail_profile:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "jesila_save_pool",
 
  canonicalName:
    "Jesila",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "SAVE_POOL",
 
  profile: {
 
    current_context: {
 
      insufficient_detail_profile:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "karol_save_pool",
 
  canonicalName:
    "Karol",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "SAVE_POOL",
 
  profile: {
 
    current_context: {
 
      insufficient_detail_profile:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "geral_27_colombia",
 
  canonicalName:
    "Geral",
 
  country:
    "Colombia",
 
  language:
    "Spanish",
 
  sourcePlatform:
    "whatsapp",
 
  platformStatus:
    "WHATSAPP_ACTIVE",
 
  profile: {
 
    profile_summary: {
 
      age:
        27
 
    },
 
    relationship: {
 
      not_forcing_serious:
        true,
 
      open_to_serious_if_develops:
        true
 
    },
 
    personality: {
 
      warm_playful:
        true
 
    },
 
    investment: {
 
      reinitiated_after_pause:
        true,
 
      used_carino:
        true,
 
      asked_how_marcel_is:
        true
 
    },
 
    running_gags: {
 
      local_guide_medellin_flirt:
        true
 
    },
 
    shared_history: {
 
      whatsapp_reason:
        "wenig Tinder + Übersetzung"
 
    },
 
    open_threads: {
 
      do_not_reexplain_tinder_inactivity:
        true
 
    },
 
    current_context: {
 
      whatsapp_active_confirmed:
        true,
 
      correct_spelling:
        "Geral",
 
      not_gerald:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "nia_30",
 
  canonicalName:
    "Nia",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "TINDER_ACTIVE",
 
  profile: {
 
    profile_summary: {
 
      age:
        30
 
    },
 
    personality: {
 
      initially_shy:
        true,
 
      very_funny_with_trust:
        true
 
    },
 
    preferences: {
 
      likes: [
 
        "Kulturen/Menschen",
 
        "Tanzen",
 
        "Kochen",
 
        "Sport",
 
        "Filme",
 
        "Unternehmungen"
 
      ]
 
    },
 
    investment: {
 
      complimented_marcel:
        "estás muy guapo"
 
    },
 
    shared_history: {
 
      said_marcel_must_find_out_if_she_is_interesting:
        true
 
    },
 
    open_threads: {
 
      no_whatsapp_push_yet:
        true,
 
      shy_funny_side_playful_not_interview:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "sarah_26_teacher",
 
  canonicalName:
    "Sarah",
 
  country:
    "Colombia",
 
  language:
    "English",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "TINDER_ACTIVE",
 
  profile: {
 
    profile_summary: {
 
      age:
        26,
 
      nationality:
        "Colombian",
 
      profession:
        "Teacher"
 
    },
 
    relationship: {
 
      serious_or_see_what_develops:
        true
 
    },
 
    preferences: {
 
      likes: [
 
        "Reisen",
 
        "Natur",
 
        "Picknick",
 
        "Camping",
 
        "gutes Essen",
 
        "Strandbars",
 
        "Cocktails",
 
        "Pole-Dancing"
 
      ]
 
    },
 
    investment: {
 
      liked_marcels_photo:
        true
 
    },
 
    communication: {
 
      speaks_english:
        true
 
    },
 
    shared_history: {
 
      noted_marcel_did_not_know_english:
        true
 
    },
 
    open_threads: {
 
      use_english_directly:
        true,
 
      no_whatsapp_push_early:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "kate_castillo_31_medellin",
 
  canonicalName:
    "Kate Castillo",
 
  aliases: [
    "Kathe Castillo"
  ],
 
  country:
    "Colombia",
 
  city:
    "Medellín",
 
  language:
    "Spanish",
 
  sourcePlatform:
    "whatsapp",
 
  platformStatus:
    "WHATSAPP_ACTIVE",
 
  phoneNumber:
    "573242540896",
 
  whatsappDisplayName:
    "Kate Castillo",
 
  profile: {
 
    profile_summary: {
 
      age:
        31,
 
      city:
        "Medellín"
 
    },
 
    personality: {
 
      extroverted:
        true,
 
      friendly:
        true,
 
      strong_temper:
        true,
 
      affectionate:
        true,
 
      not_overly_clingy:
        true
 
    },
 
    relationship: {
 
      wants_real_honest_man:
        true,
 
      wants_man_who_knows_what_he_wants:
        true,
 
      no_forcing:
        true,
 
      time_and_interest_show_direction:
        true
 
    },
 
    stress_support_style: {
 
      values_communication_trust_security:
        true,
 
      can_get_angry_then_wants_affection:
        true
 
    },
 
    sexuality_intimacy: {
 
      hugs_kisses_closeness_flirt:
        true
 
    },
 
    running_gags: {
 
      hugs_looks_kisses_common_language:
        true
 
    },
 
    shared_history: {
 
      would_take_closeness_risk:
        true,
 
      does_not_need_anger_for_affection:
        true
 
    },
 
    open_threads: {
 
      do_not_ask_again_hugs_kisses:
        true,
 
      do_not_assume_clinginess:
        true
 
    },
 
    current_context: {
 
      whatsapp_active_confirmed:
        true,
 
      correct_name:
        "Kate Castillo",
 
      old_spelling:
        "Kathe Castillo",
 
      do_not_merge_old_kathe:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "laura_26_medellin",
 
  canonicalName:
    "Laura",
 
  country:
    "Colombia",
 
  city:
    "Medellín",
 
  language:
    "Spanish",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "TINDER_ACTIVE",
 
  profile: {
 
    profile_summary: {
 
      age:
        26,
 
      city:
        "Medellín"
 
    },
 
    personality: {
 
      independent:
        true
 
    },
 
    relationship: {
 
      wants_positive_contribution:
        true,
 
      wants_care_and_pampering:
        true
 
    },
 
    preferences: {
 
      likes_attention:
        true,
 
      likes_flowers_without_occasion:
        true
 
    },
 
    open_threads: {
 
      do_not_assume_money_orientation:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "dangela_26_venezuela_medellin",
 
  canonicalName:
    "Dángela",
 
  aliases: [
    "Dangela"
  ],
 
  country:
    "Colombia",
 
  city:
    "Medellín",
 
  language:
    "Spanish",
 
  sourcePlatform:
    "whatsapp",
 
  platformStatus:
    "WHATSAPP_ACTIVE",
 
  profile: {
 
    profile_summary: {
 
      age:
        26,
 
      nationality:
        "Venezuelan",
 
      medellin_about_years:
        8
 
    },
 
    family: {
 
      mother_from_colombia:
        true,
 
      much_family_in_colombia:
        true
 
    },
 
    relationship: {
 
      seeks_serious_relationship:
        true
 
    },
 
    preferences: {
 
      loves_dancing:
        true,
 
      likes_romeo_santos:
        true,
 
      goes_out_with_friends:
        true
 
    },
 
    shared_history: {
 
      offered_food:
        true,
 
      offered_show_medellin:
        true,
 
      nervous_flirt:
        "eso depende",
 
      marcel_must_find_out_in_person:
        true,
 
      translator_then_without_words:
        true,
 
      she_confirmed_plan:
        "Perfecto / Un buen plan"
 
    },
 
    running_gags: {
 
      dancing_food_medellin_looks_language:
        true
 
    },
 
    marcel_knowledge_map: {
 
      knows_marcel_no_spanish:
        true
 
    },
 
    open_threads: {
 
      do_not_reexplain_no_spanish:
        true,
 
      continue_tinder_history_on_whatsapp:
        true
 
    },
 
    current_context: {
 
      whatsapp_active_confirmed:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "veronica_29_medellin",
 
  canonicalName:
    "Veronica",
 
  country:
    "Colombia",
 
  city:
    "Medellín",
 
  language:
    "Spanish/English",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "TINDER_ACTIVE",
 
  profile: {
 
    profile_summary: {
 
      age:
        29,
 
      city:
        "Medellín",
 
      speaks_spanish:
        true,
 
      speaks_english:
        true
 
    },
 
    relationship: {
 
      no_casual_sex:
        true,
 
      no_mutual_benefits:
        true,
 
      wants_people_friends_language_exchange:
        true
 
    },
 
    travel_future_location: {
 
      new_in_medellin:
        true
 
    },
 
    preferences: {
 
      likes: [
        "Süßes",
        "Street Food",
        "Outdoor",
        "Tanzen"
      ]
 
    },
 
    meaningful_details: {
 
      birthday_day_of_first_chat:
        true
 
    },
 
    open_threads: {
 
      english_can_be_used:
        true,
 
      do_not_ignore_no_casual_boundary:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "luisa_23_medellin",
 
  canonicalName:
    "Luisa",
 
  country:
    "Colombia",
 
  city:
    "Medellín",
 
  language:
    "Spanish",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "TINDER_ACTIVE",
 
  profile: {
 
    profile_summary: {
 
      age:
        23,
 
      city:
        "Medellín",
 
      height_cm:
        155,
 
      university_profile:
        "Universidad Alfonso Reyes, S.C.",
 
      double_date_friend:
        "Manu"
 
    },
 
    personality: {
 
      original: [
        "chévere",
        "respetuosa",
        "parchada"
      ],
 
      relaxed:
        true,
 
      respectful:
        true,
 
      adventurous:
        true
 
    },
 
    relationship: {
 
      dating_intent_original:
        "Conocer y disfrutar por el momento",
 
      meaning:
        "Im Moment kennenlernen und genießen.",
 
      not_confirmed_casual_only:
        true
 
    },
 
    sexuality_intimacy: {
 
      light_double_meaning_not_rejected:
        true
 
    },
 
    open_threads: {
 
      do_not_list_back_traits:
        true,
 
      treat_dating_intent_as_current_changeable:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "salome_26_cali",
 
  canonicalName:
    "Salome",
 
  country:
    "Colombia",
 
  city:
    "Cali",
 
  language:
    "Spanish",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "WHATSAPP_INVITED",
 
  phoneNumber:
    "573005092127",
 
  profile: {
 
    profile_summary: {
 
      age:
        26,
 
      city:
        "Cali"
 
    },
 
    relationship: {
 
      not_serious_required_but_open_to_serious:
        true
 
    },
 
    preferences: {
 
      likes: [
        "Selbstliebe",
        "Street Food",
        "Kochen",
        "Musik",
        "Unternehmertum",
        "Walking"
      ]
 
    },
 
    shared_history: {
 
      gave_whatsapp_number:
        true,
 
      number:
        "+57 300 509 2127",
 
      said_write_me_if_you_want:
        true
 
    },
 
    open_threads: {
 
      she_initiated_move:
        true,
 
      first_whatsapp_short:
        true,
 
      active_only_after_actual_message:
        true
 
    }
 
  }
 
},
 
 
{
  identityKey:
    "paola_maza_20",
 
  canonicalName:
    "Paola Maza",
 
  country:
    "Colombia",
 
  language:
    "Spanish/Some English",
 
  sourcePlatform:
    "tinder",
 
  platformStatus:
    "WHATSAPP_INVITED",
 
  profile: {
 
    profile_summary: {
 
      age:
        20
 
    },
 
    personality: {
 
      respectful:
        true,
 
      says_good_heart:
        true
 
    },
 
    lifestyle_routines: {
 
      gym_important:
        true,
 
      disciplined:
        true
 
    },
 
    preferences: {
 
      likes: [
        "gutes Essen",
        "Reisen",
        "Filme",
        "Spaziergänge"
      ]
 
    },
 
    relationship: {
 
      tinder_goal:
        "Feste Beziehung, mal sehen"
 
    },
 
    communication: {
 
      some_english:
        true
 
    },
 
    shared_history: {
 
      sent_wave_first:
        true,
 
      accepted_whatsapp:
        true,
 
      quote:
        "You WhatsApp it is",
 
      marcel_number_sent:
        true
 
    },
 
    current_context: {
 
      do_not_merge_other_paola:
        true,
 
      waiting_for_whatsapp_message:
        true
 
    }
 
  }
 
}
 
];
 
 
/* ==================================================
 DATENBANK INITIALISIEREN
================================================== */
 
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
  ALTER TABLE contacts
 
    ADD COLUMN IF NOT EXISTS phone_number TEXT,
 
    ADD COLUMN IF NOT EXISTS display_name TEXT,
 
    ADD COLUMN IF NOT EXISTS nickname TEXT,
 
    ADD COLUMN IF NOT EXISTS country TEXT,
 
    ADD COLUMN IF NOT EXISTS city TEXT,
 
    ADD COLUMN IF NOT EXISTS timezone TEXT,
 
    ADD COLUMN IF NOT EXISTS primary_language TEXT,
 
    ADD COLUMN IF NOT EXISTS source_platform TEXT,
 
    ADD COLUMN IF NOT EXISTS source_profile_name TEXT,
 
    ADD COLUMN IF NOT EXISTS contact_status TEXT
      DEFAULT 'active',
 
    ADD COLUMN IF NOT EXISTS relationship_stage TEXT
      DEFAULT 'new',
 
    ADD COLUMN IF NOT EXISTS auto_reply_enabled BOOLEAN
      DEFAULT TRUE,
 
    ADD COLUMN IF NOT EXISTS date_lock_enabled BOOLEAN
      DEFAULT FALSE,
 
    ADD COLUMN IF NOT EXISTS manual_review_required BOOLEAN
      DEFAULT FALSE,
 
    ADD COLUMN IF NOT EXISTS location_context JSONB
      DEFAULT '{}'::jsonb,
 
    ADD COLUMN IF NOT EXISTS relocation_context JSONB
      DEFAULT '{}'::jsonb,
 
    ADD COLUMN IF NOT EXISTS first_contact_at TIMESTAMPTZ,
 
    ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ,
 
    ADD COLUMN IF NOT EXISTS memory_identity_key TEXT,
 
    ADD COLUMN IF NOT EXISTS canonical_name TEXT,
 
    ADD COLUMN IF NOT EXISTS whatsapp_display_name TEXT,
 
    ADD COLUMN IF NOT EXISTS current_platform TEXT,
 
    ADD COLUMN IF NOT EXISTS platform_status TEXT,
 
    ADD COLUMN IF NOT EXISTS identity_locked BOOLEAN
      DEFAULT FALSE
`);
 
 
await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS
  idx_contacts_memory_identity_key
 
  ON contacts (
    memory_identity_key
  )
 
  WHERE memory_identity_key IS NOT NULL
`);
 
 
await pool.query(`
  CREATE TABLE IF NOT EXISTS contact_identifiers (
 
    id BIGSERIAL PRIMARY KEY,
 
    contact_id INTEGER NOT NULL
      REFERENCES contacts(id)
      ON DELETE CASCADE,
 
    identifier_type TEXT NOT NULL,
 
    identifier_value TEXT NOT NULL,
 
    normalized_value TEXT NOT NULL,
 
    source_platform TEXT,
 
    is_primary BOOLEAN
      DEFAULT FALSE,
 
    human_verified BOOLEAN
      DEFAULT TRUE,
 
    created_at TIMESTAMPTZ
      DEFAULT NOW(),
 
    updated_at TIMESTAMPTZ
      DEFAULT NOW()
 
  )
`);
 
 
await pool.query(`
  CREATE INDEX IF NOT EXISTS
  idx_contact_identifiers_contact
 
  ON contact_identifiers (
    contact_id
  )
`);
 
 
await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS
  idx_contact_identifiers_strong_unique
 
  ON contact_identifiers (
    identifier_type,
    normalized_value
  )
 
  WHERE identifier_type IN (
    'identity_key',
    'phone',
    'whatsapp_jid'
  )
`);
 
 
await pool.query(`
  CREATE TABLE IF NOT EXISTS messages (
 
    id BIGSERIAL PRIMARY KEY,
 
    whatsapp_jid TEXT NOT NULL,
 
    direction TEXT NOT NULL,
 
    message_text TEXT,
 
    whatsapp_message_id TEXT,
 
    created_at TIMESTAMPTZ
      DEFAULT NOW()
 
  )
`);
 
 
await pool.query(`
  ALTER TABLE messages
 
    ADD COLUMN IF NOT EXISTS is_edited BOOLEAN
      DEFAULT FALSE,
 
    ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
 
    ADD COLUMN IF NOT EXISTS original_message_text TEXT,
 
    ADD COLUMN IF NOT EXISTS processing_status TEXT
      DEFAULT 'processed',
 
    ADD COLUMN IF NOT EXISTS duplicate_of_message_id BIGINT
      REFERENCES messages(id)
      ON DELETE SET NULL,
 
    ADD COLUMN IF NOT EXISTS import_source_hash TEXT,
 
    ADD COLUMN IF NOT EXISTS import_batch_id TEXT
`);
 
 
await pool.query(`
  CREATE INDEX IF NOT EXISTS
  idx_messages_jid_id
 
  ON messages (
    whatsapp_jid,
    id DESC
  )
`);
 
 
await pool.query(`
  CREATE INDEX IF NOT EXISTS
  idx_messages_whatsapp_id
 
  ON messages (
    whatsapp_jid,
    whatsapp_message_id
  )
`);
 
await pool.query(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_import_source_hash
  ON messages (import_source_hash)
  WHERE import_source_hash IS NOT NULL
`);
 
await pool.query(`
  CREATE INDEX IF NOT EXISTS idx_messages_jid_direction_created
  ON messages (whatsapp_jid, direction, created_at)
`);
 
 
await pool.query(`
  CREATE TABLE IF NOT EXISTS contact_memory_profiles (
 
    id BIGSERIAL PRIMARY KEY,
 
    contact_id INTEGER UNIQUE NOT NULL
      REFERENCES contacts(id)
      ON DELETE CASCADE,
 
    ${PROFILE_COLUMNS
      .map(
        column =>
          `${column} JSONB DEFAULT '{}'::jsonb`
      )
      .join(",")},
 
    profile_version INTEGER
      DEFAULT 1,
 
    last_memory_update_at TIMESTAMPTZ,
 
    created_at TIMESTAMPTZ
      DEFAULT NOW(),
 
    updated_at TIMESTAMPTZ
      DEFAULT NOW()
 
  )
`);
 
 
await pool.query(`
  CREATE TABLE IF NOT EXISTS memory_items (
 
    id BIGSERIAL PRIMARY KEY,
 
    contact_id INTEGER NOT NULL
      REFERENCES contacts(id)
      ON DELETE CASCADE,
 
    category TEXT NOT NULL,
 
    memory_key TEXT NOT NULL,
 
    memory_value JSONB NOT NULL
      DEFAULT '{}'::jsonb,
 
    memory_type TEXT NOT NULL
      DEFAULT 'interpretation',
 
    confidence NUMERIC(4,3)
      DEFAULT 0.5,
 
    source_message_id BIGINT
      REFERENCES messages(id)
      ON DELETE SET NULL,
 
    source_quote TEXT,
 
    source_context JSONB
      DEFAULT '{}'::jsonb,
 
    valid_from TIMESTAMPTZ
      DEFAULT NOW(),
 
    valid_until TIMESTAMPTZ,
 
    status TEXT
      DEFAULT 'active',
 
    supersedes_memory_id BIGINT
      REFERENCES memory_items(id)
      ON DELETE SET NULL,
 
    human_review_status TEXT
      DEFAULT 'unreviewed',
 
    human_corrected_value JSONB,
 
    human_note TEXT,
 
    human_reviewed_at TIMESTAMPTZ,
 
    importance INTEGER
      DEFAULT 2,
 
    use_in_reply BOOLEAN
      DEFAULT TRUE,
 
    created_at TIMESTAMPTZ
      DEFAULT NOW(),
 
    updated_at TIMESTAMPTZ
      DEFAULT NOW()
 
  )
`);
 
 
await pool.query(`
  CREATE INDEX IF NOT EXISTS
  idx_memory_items_contact_active
 
  ON memory_items (
    contact_id,
    status,
    importance DESC,
    updated_at DESC
  )
`);
 
 
await pool.query(`
  CREATE TABLE IF NOT EXISTS memory_events (
 
    id BIGSERIAL PRIMARY KEY,
 
    contact_id INTEGER NOT NULL
      REFERENCES contacts(id)
      ON DELETE CASCADE,
 
    event_type TEXT NOT NULL,
 
    event_subtype TEXT,
 
    title TEXT,
 
    event_data JSONB
      DEFAULT '{}'::jsonb,
 
    started_at TIMESTAMPTZ
      DEFAULT NOW(),
 
    ended_at TIMESTAMPTZ,
 
    event_status TEXT
      DEFAULT 'active',
 
    importance INTEGER
      DEFAULT 2,
 
    sensitivity TEXT
      DEFAULT 'normal',
 
    source_message_ids JSONB
      DEFAULT '[]'::jsonb,
 
    evidence_summary TEXT,
 
    related_memory_item_ids JSONB
      DEFAULT '[]'::jsonb,
 
    related_event_id BIGINT
      REFERENCES memory_events(id)
      ON DELETE SET NULL,
 
    requires_follow_up BOOLEAN
      DEFAULT FALSE,
 
    follow_up_after TIMESTAMPTZ,
 
    follow_up_status TEXT
      DEFAULT 'none',
 
    bot_action TEXT,
 
    marcel_review_required BOOLEAN
      DEFAULT FALSE,
 
    created_at TIMESTAMPTZ
      DEFAULT NOW(),
 
    updated_at TIMESTAMPTZ
      DEFAULT NOW()
 
  )
`);
 
 
await pool.query(`
  CREATE INDEX IF NOT EXISTS
  idx_memory_events_contact_active
 
  ON memory_events (
    contact_id,
    event_status,
    importance DESC,
    started_at DESC
  )
`);
 
 
await pool.query(`
  CREATE TABLE IF NOT EXISTS media (
 
    id BIGSERIAL PRIMARY KEY,
 
    contact_id INTEGER NOT NULL
      REFERENCES contacts(id)
      ON DELETE CASCADE,
 
    message_id BIGINT
      REFERENCES messages(id)
      ON DELETE SET NULL,
 
    whatsapp_message_id TEXT,
 
    media_type TEXT,
 
    mime_type TEXT,
 
    storage_path TEXT,
 
    thumbnail_path TEXT,
 
    is_view_once BOOLEAN
      DEFAULT FALSE,
 
    view_once_status TEXT
      DEFAULT 'unknown',
 
    caption TEXT,
 
    ai_description TEXT,
 
    ai_tags JSONB
      DEFAULT '[]'::jsonb,
 
    sensitivity TEXT
      DEFAULT 'normal',
 
    sexual_media_context JSONB
      DEFAULT '{}'::jsonb,
 
    memory_relevance INTEGER
      DEFAULT 1,
 
    related_memory_item_ids JSONB
      DEFAULT '[]'::jsonb,
 
    related_event_ids JSONB
      DEFAULT '[]'::jsonb,
 
    received_at TIMESTAMPTZ
      DEFAULT NOW(),
 
    created_at TIMESTAMPTZ
      DEFAULT NOW(),
 
    updated_at TIMESTAMPTZ
      DEFAULT NOW()
 
  )
`);
 
 
await pool.query(`
  CREATE TABLE IF NOT EXISTS marcel_memory (
 
    id BIGSERIAL PRIMARY KEY,
 
    category TEXT NOT NULL,
 
    memory_key TEXT NOT NULL UNIQUE,
 
    memory_value JSONB NOT NULL
      DEFAULT '{}'::jsonb,
 
    status TEXT
      DEFAULT 'active',
 
    importance INTEGER
      DEFAULT 3,
 
    sensitivity TEXT
      DEFAULT 'normal',
 
    source_type TEXT
      DEFAULT 'marcel',
 
    human_verified BOOLEAN
      DEFAULT TRUE,
 
    valid_from TIMESTAMPTZ
      DEFAULT NOW(),
 
    valid_until TIMESTAMPTZ,
 
    allowed_for_bot BOOLEAN
      DEFAULT TRUE,
 
    usage_notes TEXT,
 
    created_at TIMESTAMPTZ
      DEFAULT NOW(),
 
    updated_at TIMESTAMPTZ
      DEFAULT NOW()
 
  )
`);
 
 
await pool.query(`
  CREATE TABLE IF NOT EXISTS marcel_live_state (
 
    id INTEGER PRIMARY KEY
      DEFAULT 1
      CHECK (
        id = 1
      ),
 
    current_country TEXT,
 
    current_city TEXT,
 
    current_timezone TEXT,
 
    location_status TEXT
      DEFAULT 'living',
 
    location_verified_at TIMESTAMPTZ
      DEFAULT NOW(),
 
    relocation_target_country TEXT,
 
    relocation_target_city TEXT,
 
    relocation_stage TEXT,
 
    relocation_eta TEXT,
 
    temporary_travel_country TEXT,
 
    temporary_travel_city TEXT,
 
    temporary_travel_until TIMESTAMPTZ,
 
    housing_stage TEXT,
 
    manual_location_lock BOOLEAN
      DEFAULT TRUE,
 
    updated_by TEXT
      DEFAULT 'marcel',
 
    updated_at TIMESTAMPTZ
      DEFAULT NOW()
 
  )
`);
 
 
await pool.query(`
  INSERT INTO marcel_live_state (
 
    id,
 
    current_country,
 
    current_city,
 
    current_timezone,
 
    location_status,
 
    relocation_target_country,
 
    relocation_target_city,
 
    relocation_stage,
 
    relocation_eta,
 
    housing_stage,
 
    manual_location_lock,
 
    updated_by
 
  )
 
  VALUES (
 
    1,
 
    'Germany',
 
    'Munich',
 
    'Europe/Berlin',
 
    'living',
 
    'Colombia',
 
    'Medellín',
 
    'planned',
 
    'approximately 6 to 8 weeks',
 
    'not_arrived',
 
    TRUE,
 
    'marcel'
 
  )
 
  ON CONFLICT (
    id
  )
 
  DO NOTHING
`);
 
 
await seedMarcelMemory();
 
await seedWomenMemory();
 
 
console.log(
  "PostgreSQL + Langzeit-Memory V1.7.2 + Progressive Disclosure + Frauen-Memory + Identity Registry + Sprachschutz + Dashboard Detail API bereit."
);
 
}
 
 
/* ==================================================
 MARCEL MEMORY
================================================== */
 
async function seedMarcelMemory() {
 
const memories = [
 
  [
    "identity",
    "age",
    {
      years: 41
    },
    4,
    "Nicht ungefragt mit Alter anfangen."
  ],
 
  [
    "identity",
    "birthday",
    {
      day: 7,
      month: "August",
      zodiac: "Leo"
    },
    2,
    "Nur natürlich verwenden."
  ],
 
  [
    "languages",
    "spoken_languages",
    {
      german: true,
      english: true,
      spanish: false
    },
    5,
    "Spanisch ist praktische Einschränkung."
  ],
 
  [
    "work",
    "self_employed",
    {
      self_employed: true,
      various_projects: true,
      location_flexible: true
    },
    3,
    "Aktuelle konkrete Tätigkeit niemals erfinden. Details nur natürlich preisgeben."
  ],
 
  [
    "family",
    "children",
    {
      count: 2,
 
      son: {
        name: "Finn",
        age: 16
      },
 
      daughter: {
        name: "Charlotte",
        age: 14
      }
    },
    5,
    "Know a lot, reveal naturally. Bei einfacher Frage zunächst nur zwei Kinder, einen Jungen und ein Mädchen nennen. Namen und Alter erst bei Nachfrage oder wenn später natürlich relevant."
  ],
 
  [
    "communication",
    "progressive_disclosure",
    {
      know_a_lot_reveal_naturally: true,
      answer_only_asked_depth: true,
      do_not_dump_memory: true,
      answer_multiple_real_questions: true,
      check_woman_memory_before_followup_question: true,
      reveal_extra_details_only_if_asked_or_natural: true,
 
      children_example: {
        first_level:
          "Ja, zwei. Einen Jungen und ein Mädchen.",
 
        second_level:
          "Mein Sohn ist 16 und meine Tochter 14.",
 
        third_level:
          "Namen Finn und Charlotte nur bei Nachfrage oder natürlichem Kontext."
      }
    },
    5,
    "Memory ist Hintergrundwissen, kein Lebenslauf. Persönliche Details stufenweise preisgeben und Rückfragen an bereits bekanntes Frauen-Memory anpassen."
  ],
 
  [
    "communication",
    "warmth_balance",
    {
      loving: true,
      cheeky: true,
      avoid_emoji_overload: true,
      avoid_ai_phrases: true,
      do_not_paraphrase: true,
      no_mechanical_question: true,
      avoid_trait_catalogues: true
    },
    5,
    "Menschlich schreiben."
  ],
 
  [
    "communication",
    "tinder_whatsapp_transition",
    {
      do_not_move_immediately: true,
      after_4_5_days_silence_short_busy_apology: true,
      translation_reason_valid: true,
      continue_history: true
    },
    5,
    "WhatsApp erst wenn Kommunikation läuft."
  ],
 
  [
    "nicknames",
    "romantic_address_style",
    {
      preferred: [
        "meine Schöne",
        "meine Hübsche",
        "mi hermosa",
        "preciosa",
        "amor",
        "princesa",
        "beautiful"
      ],
 
      avoid_artificial:
        true
    },
    5,
    "Keine künstlichen Spitznamen."
  ],
 
  [
    "communication",
    "emoji_style",
    {
      hearts_not_automatic:
        true,
 
      hearts_only_if_warmth_fits:
        true
    },
    4,
    "Freche Nachricht braucht kein Herz."
  ],
 
  [
    "lifestyle",
    "alcohol_and_smoking",
    {
      marcel_drinks_alcohol:
        false,
 
      partner_drinking_is_ok:
        true,
 
      partner_smoking_is_ok:
        true
    },
    4,
    "Nie behaupten Marcel trinkt."
  ],
 
  [
    "food_drinks",
    "favorite_food",
    {
      name:
        "German beef roulades"
    },
    2,
    "Natürlich verwenden."
  ],
 
  [
    "food_drinks",
    "favorite_drink",
    {
      name:
        "Spezi",
 
      explanation:
        "Cola-Orangen-Limonaden-Mix"
    },
    2,
    "Falls unbekannt kurz erklären."
  ],
 
  [
    "skills",
    "cooking",
    {
      likes_cooking:
        true,
 
      cooks_well:
        true
    },
    2,
    "Natürlich verwenden."
  ],
 
  [
    "personal_stories",
    "sister_burned_water",
    {
      sister_older_by_years:
        1.5,
 
      story:
        "Schwester hat einmal Wasser im Topf anbrennen lassen."
    },
    1,
    "Nur passend und nicht ungefragt erzählen."
  ],
 
  [
    "personal_stories",
    "fathers_car_at_14",
    {
      story:
        "Mit 14 Auto des Vaters genommen und von Polizei erwischt."
    },
    1,
    "Nur passend und nicht ungefragt erzählen."
  ],
 
  [
    "family",
    "parents_long_marriage",
    {
      parents_still_married:
        true,
 
      years_over:
        44
    },
    2,
    "Nur wenn relevant und nicht als Zusatzinformation anhängen."
  ],
 
  [
    "relationship_history",
    "longest_relationship",
    {
      years:
        14,
 
      partner:
        "mother_of_children"
    },
    3,
    "Nicht ungefragt. Nur passende Informationstiefe preisgeben."
  ],
 
  [
    "relationship_values",
    "partner_freedom",
    {
      partner_can_go_out_without_marcel:
        true,
 
      male_best_friend_ok:
        true,
 
      ex_contact_can_be_ok:
        true,
 
      marcel_values_own_time:
        true
    },
    3,
    "Kontextabhängig."
  ],
 
  [
    "marriage_religion",
    "marriage_and_religion",
    {
      never_married:
        true,
 
      open_to_marriage:
        true,
 
      marriage_required:
        false,
 
      religion:
        "atheist"
    },
    3,
    "Nur wenn relevant. Nicht alle Teilinformationen auf einmal nennen."
  ],
 
  [
    "sexuality",
    "orientation_and_ffm",
    {
      orientation:
        "heterosexual",
 
      open_to_ffm:
        true,
 
      interested_in_male_third_party:
        false
    },
    5,
    "Nur bei offenem Sexualgespräch und nur in benötigter Tiefe."
  ],
 
  [
    "communication",
    "contact_style",
    {
      likes_frequent_contact:
        true,
 
      likes_writing_a_lot:
        true,
 
      prolonged_silence_matters:
        true
    },
    4,
    "Viel Kontakt, nicht hinterherlaufen."
  ],
 
  [
    "housing",
    "arrival_housing_plan",
    {
      temporary_months:
        "1-2",
 
      temporary_options: [
        "hotel",
        "vacation_apartment"
      ],
 
      permanent_plan:
        "Vor Ort feste Unterkunft in sicherer Gegend suchen."
    },
    4,
    "Keine konkrete Gegend erfinden. Detailtiefe an tatsächliche Frage anpassen."
  ]
 
];
 
 
for (
  const [
    category,
    key,
    value,
    importance,
    usage
  ]
  of memories
) {
 
  await pool.query(
    `
      INSERT INTO marcel_memory (
 
        category,
 
        memory_key,
 
        memory_value,
 
        importance,
 
        usage_notes,
 
        human_verified,
 
        allowed_for_bot
 
      )
 
      VALUES (
 
        $1,
 
        $2,
 
        $3::jsonb,
 
        $4,
 
        $5,
 
        TRUE,
 
        TRUE
 
      )
 
      ON CONFLICT (
        memory_key
      )
 
      DO UPDATE SET
 
        category =
          EXCLUDED.category,
 
        memory_value =
          EXCLUDED.memory_value,
 
        importance =
          EXCLUDED.importance,
 
        usage_notes =
          EXCLUDED.usage_notes,
 
        updated_at =
          NOW()
    `,
    [
      category,
      key,
      JSON.stringify(
        value
      ),
      importance,
      usage
    ]
  );
 
}
 
}
 
 
/* ==================================================
 CONTACT IDENTIFIER
================================================== */
 
async function addContactIdentifier({
contactId,
type,
value,
sourcePlatform = null,
isPrimary = false
}) {
 
const clean =
  normalizeText(
    value
  );
 
 
if (
  !contactId
  ||
  !clean
) {
 
  return;
 
}
 
 
const normalized =
  normalizeIdentityValue(
    clean
  );
 
 
if (
  [
    "identity_key",
    "phone",
    "whatsapp_jid"
  ].includes(
    type
  )
) {
 
  const existingStrong =
    await pool.query(
      `
        SELECT
          contact_id
 
        FROM contact_identifiers
 
        WHERE identifier_type =
          $1
 
          AND normalized_value =
          $2
 
        LIMIT 1
      `,
      [
        type,
        normalized
      ]
    );
 
 
  if (
    existingStrong.rows[0]
    &&
    existingStrong.rows[0].contact_id
    !==
    contactId
  ) {
 
    throw new Error(
      `Identity-Konflikt: ${type} ${clean} gehört bereits Kontakt ${existingStrong.rows[0].contact_id}`
    );
 
  }
 
}
 
 
const same =
  await pool.query(
    `
      SELECT
        id
 
      FROM contact_identifiers
 
      WHERE contact_id =
        $1
 
        AND identifier_type =
          $2
 
        AND normalized_value =
          $3
 
      LIMIT 1
    `,
    [
      contactId,
      type,
      normalized
    ]
  );
 
 
if (
  same.rows[0]
) {
 
  await pool.query(
    `
      UPDATE contact_identifiers
 
      SET
        identifier_value =
          $2,
 
        source_platform =
          COALESCE(
            $3,
            source_platform
          ),
 
        is_primary =
          is_primary
          OR
          $4,
 
        updated_at =
          NOW()
 
      WHERE id =
        $1
    `,
    [
      same.rows[0].id,
      clean,
      sourcePlatform,
      isPrimary
    ]
  );
 
} else {
 
  await pool.query(
    `
      INSERT INTO contact_identifiers (
 
        contact_id,
 
        identifier_type,
 
        identifier_value,
 
        normalized_value,
 
        source_platform,
 
        is_primary,
 
        human_verified
 
      )
 
      VALUES (
 
        $1,
 
        $2,
 
        $3,
 
        $4,
 
        $5,
 
        $6,
 
        TRUE
 
      )
    `,
    [
      contactId,
      type,
      clean,
      normalized,
      sourcePlatform,
      isPrimary
    ]
  );
 
}
 
}
 
 
async function findContactByIdentifier(
type,
value
) {
 
const normalized =
  normalizeIdentityValue(
    value
  );
 
 
if (!normalized) {
  return null;
}
 
 
const result =
  await pool.query(
    `
      SELECT
        c.*
 
      FROM contact_identifiers i
 
      JOIN contacts c
        ON c.id =
           i.contact_id
 
      WHERE i.identifier_type =
        $1
 
        AND i.normalized_value =
        $2
 
      ORDER BY
        i.is_primary DESC,
        i.id ASC
 
      LIMIT 1
    `,
    [
      type,
      normalized
    ]
  );
 
 
return (
  result.rows[0]
  ||
  null
);
 
}
 
 
async function getContactByIdentityKey(
key
) {
 
const result =
  await pool.query(
    `
      SELECT *
      FROM contacts
 
      WHERE memory_identity_key =
        $1
 
      LIMIT 1
    `,
    [
      key
    ]
  );
 
 
return (
  result.rows[0]
  ||
  null
);
 
}
 
 
/* ==================================================
 FRAUEN PROFILE
================================================== */
 
async function ensureWomanProfile(
woman
) {
 
let contact =
  await getContactByIdentityKey(
    woman.identityKey
  );
 
 
const phone =
  woman.phoneNumber
    ? String(
        woman.phoneNumber
      )
        .replace(
          /\D/g,
          ""
        )
    : null;
 
 
if (
  !contact
  &&
  phone
) {
 
  contact =
    await findContactByIdentifier(
      "phone",
      phone
    );
 
}
 
 
if (!contact) {
 
  const result =
    await pool.query(
      `
        INSERT INTO contacts (
 
          whatsapp_jid,
 
          display_name,
 
          canonical_name,
 
          memory_identity_key,
 
          identity_locked,
 
          phone_number,
 
          country,
 
          city,
 
          primary_language,
 
          source_platform,
 
          current_platform,
 
          platform_status,
 
          whatsapp_display_name,
 
          contact_status,
 
          relationship_stage,
 
          auto_reply_enabled,
 
          date_lock_enabled,
 
          first_contact_at,
 
          updated_at
 
        )
 
        VALUES (
 
          $1,
 
          $2,
 
          $2,
 
          $3,
 
          TRUE,
 
          $4,
 
          $5,
 
          $6,
 
          $7,
 
          $8,
 
          $8,
 
          $9,
 
          $10,
 
          'active',
 
          'new',
 
          TRUE,
 
          FALSE,
 
          NOW(),
 
          NOW()
 
        )
 
        RETURNING *
      `,
      [
        createProfileJid(
          woman.identityKey
        ),
        woman.canonicalName,
        woman.identityKey,
        phone,
        woman.country || null,
        woman.city || null,
        woman.language || null,
        woman.sourcePlatform || null,
        woman.platformStatus || null,
        woman.whatsappDisplayName || null
      ]
    );
 
 
  contact =
    result.rows[0];
 
} else {
 
  const result =
    await pool.query(
      `
        UPDATE contacts
 
        SET
          canonical_name =
            COALESCE(
              $2,
              canonical_name
            ),
 
          display_name =
            COALESCE(
              display_name,
              $2
            ),
 
          phone_number =
            COALESCE(
              $3,
              phone_number
            ),
 
          country =
            COALESCE(
              $4,
              country
            ),
 
          city =
            COALESCE(
              $5,
              city
            ),
 
          primary_language =
            COALESCE(
              $6,
              primary_language
            ),
 
          source_platform =
            COALESCE(
              source_platform,
              $7
            ),
 
          current_platform =
            COALESCE(
              $7,
              current_platform
            ),
 
          platform_status =
            COALESCE(
              $8,
              platform_status
            ),
 
          whatsapp_display_name =
            COALESCE(
              $9,
              whatsapp_display_name
            ),
 
          memory_identity_key =
            COALESCE(
              memory_identity_key,
              $10
            ),
 
          identity_locked =
            TRUE,
 
          updated_at =
            NOW()
 
        WHERE id =
          $1
 
        RETURNING *
      `,
      [
        contact.id,
        woman.canonicalName,
        phone,
        woman.country || null,
        woman.city || null,
        woman.language || null,
        woman.sourcePlatform || null,
        woman.platformStatus || null,
        woman.whatsappDisplayName || null,
        woman.identityKey
      ]
    );
 
 
  contact =
    result.rows[0];
 
}
 
 
await pool.query(
  `
    INSERT INTO contact_memory_profiles (
      contact_id
    )
 
    VALUES (
      $1
    )
 
    ON CONFLICT (
      contact_id
    )
 
    DO NOTHING
  `,
  [
    contact.id
  ]
);
 
 
await addContactIdentifier({
 
  contactId:
    contact.id,
 
  type:
    "identity_key",
 
  value:
    woman.identityKey,
 
  isPrimary:
    true
 
});
 
 
await addContactIdentifier({
 
  contactId:
    contact.id,
 
  type:
    "canonical_name",
 
  value:
    woman.canonicalName,
 
  isPrimary:
    true
 
});
 
 
for (
  const alias
  of woman.aliases || []
) {
 
  await addContactIdentifier({
 
    contactId:
      contact.id,
 
    type:
      "alias",
 
    value:
      alias
 
  });
 
}
 
 
if (phone) {
 
  await addContactIdentifier({
 
    contactId:
      contact.id,
 
    type:
      "phone",
 
    value:
      phone,
 
    sourcePlatform:
      "whatsapp",
 
    isPrimary:
      true
 
  });
 
}
 
 
if (
  woman.whatsappDisplayName
) {
 
  await addContactIdentifier({
 
    contactId:
      contact.id,
 
    type:
      "whatsapp_display_name",
 
    value:
      woman.whatsappDisplayName,
 
    sourcePlatform:
      "whatsapp"
 
  });
 
}
 
 
return contact;
 
}
 
 
/* ==================================================
 VERIFIED SEED MEMORY
================================================== */
 
async function upsertVerifiedSeedMemory({
contactId,
category,
memoryKey,
memoryValue,
importance = 3
}) {
 
const existing =
  await pool.query(
    `
      SELECT *
 
      FROM memory_items
 
      WHERE contact_id =
        $1
 
        AND category =
          $2
 
        AND memory_key =
          $3
 
        AND status =
          'active'
 
      ORDER BY
        id DESC
 
      LIMIT 1
    `,
    [
      contactId,
      category,
      memoryKey
    ]
  );
 
 
if (
  existing.rows[0]
) {
 
  await pool.query(
    `
      UPDATE memory_items
 
      SET
        memory_value =
          $2::jsonb,
 
        memory_type =
          'explicit_fact',
 
        confidence =
          1.0,
 
        human_review_status =
          'confirmed',
 
        human_note =
          'Manuell gepflegtes Frauen-Memory UPDATE3.',
 
        human_reviewed_at =
          NOW(),
 
        importance =
          $3,
 
        use_in_reply =
          TRUE,
 
        updated_at =
          NOW()
 
      WHERE id =
        $1
    `,
    [
      existing.rows[0].id,
      JSON.stringify(
        memoryValue
      ),
      clampImportance(
        importance
      )
    ]
  );
 
} else {
 
  await pool.query(
    `
      INSERT INTO memory_items (
 
        contact_id,
 
        category,
 
        memory_key,
 
        memory_value,
 
        memory_type,
 
        confidence,
 
        status,
 
        human_review_status,
 
        human_note,
 
        human_reviewed_at,
 
        importance,
 
        use_in_reply
 
      )
 
      VALUES (
 
        $1,
 
        $2,
 
        $3,
 
        $4::jsonb,
 
        'explicit_fact',
 
        1.0,
 
        'active',
 
        'confirmed',
 
        'Manuell gepflegtes Frauen-Memory UPDATE3.',
 
        NOW(),
 
        $5,
 
        TRUE
 
      )
    `,
    [
      contactId,
      category,
      memoryKey,
      JSON.stringify(
        memoryValue
      ),
      clampImportance(
        importance
      )
    ]
  );
 
}
 
}
 
 
/* ==================================================
 KONTAKT MEMORY PROFIL
================================================== */
 
async function getContactMemoryProfile(
contactId
) {
 
const result =
  await pool.query(
    `
      SELECT *
 
      FROM contact_memory_profiles
 
      WHERE contact_id =
        $1
 
      LIMIT 1
    `,
    [
      contactId
    ]
  );
 
 
return (
  result.rows[0]
  ||
  null
);
 
}
 
 
/* ==================================================
 PROFILE SNAPSHOT
================================================== */
 
async function applyProfileSnapshot(
contactId,
snapshot,
{
  humanSeed = false
} = {}
) {
 
const current =
  await getContactMemoryProfile(
    contactId
  );
 
 
const values =
  PROFILE_COLUMNS.map(
    column => {
 
      const incoming =
        snapshot?.[column]
        &&
        typeof snapshot[column]
        ===
        "object"
        &&
        !Array.isArray(
          snapshot[column]
        )
 
          ? snapshot[column]
 
          : {};
 
 
      const currentColumn =
        current?.[column]
        &&
        typeof current[column]
        ===
        "object"
        &&
        !Array.isArray(
          current[column]
        )
 
          ? current[column]
 
          : {};
 
 
      if (
        humanSeed
      ) {
 
        return JSON.stringify(
          mergeProfileObjects(
            currentColumn,
            incoming
          )
        );
 
      }
 
 
      if (
        Object.keys(
          currentColumn
        ).length > 0
        &&
        Object.keys(
          incoming
        ).length === 0
      ) {
 
        return JSON.stringify(
          currentColumn
        );
 
      }
 
 
      return JSON.stringify(
        incoming
      );
 
    }
  );
 
 
const assignments =
  PROFILE_COLUMNS.map(
    (column, index) =>
      `${column} = $${index + 1}::jsonb`
  );
 
 
values.push(
  contactId
);
 
 
await pool.query(
  `
    UPDATE contact_memory_profiles
 
    SET
      ${assignments.join(",")},
 
      profile_version =
        profile_version + 1,
 
      last_memory_update_at =
        NOW(),
 
      updated_at =
        NOW()
 
    WHERE contact_id =
      $${PROFILE_COLUMNS.length + 1}
  `,
  values
);
 
}
 
 
/* ==================================================
 FRAUEN MEMORY LADEN
================================================== */
 
async function seedWomenMemory() {
 
for (
  const woman
  of WOMEN_SEED
) {
 
  const contact =
    await ensureWomanProfile(
      woman
    );
 
 
  const snapshot =
    Object.fromEntries(
      PROFILE_COLUMNS.map(
        key => [
          key,
          woman.profile?.[key] || {}
        ]
      )
    );
 
 
  await applyProfileSnapshot(
    contact.id,
    snapshot,
    {
      humanSeed:
        true
    }
  );
 
 
  for (
    const key
    of PROFILE_COLUMNS
  ) {
 
    const value =
      snapshot[key];
 
 
    if (
      value
      &&
      typeof value === "object"
      &&
      !Array.isArray(
        value
      )
      &&
      Object.keys(
        value
      ).length
    ) {
 
      await upsertVerifiedSeedMemory({
 
        contactId:
          contact.id,
 
        category:
          key,
 
        memoryKey:
          `seed_${key}`,
 
        memoryValue:
          value,
 
        importance:
          [
            "current_context",
            "open_threads",
            "relationship",
            "children",
            "marcel_knowledge_map"
          ].includes(
            key
          )
            ? 5
            : 3
 
      });
 
    }
 
  }
 
}
 
 
console.log(
  `Frauen-Memory geladen: ${WOMEN_SEED.length} getrennte Profile.`
);
 
}
 
 
/* ==================================================
 KONTAKT AUFLÖSUNG
================================================== */
 
async function ensureContact(
jid
) {
 
const phone =
  (
    isTestJid(
      jid
    )
    ||
    isProfileJid(
      jid
    )
  )
 
    ? null
 
    : jid
        ?.split("@")
        ?.[0]
        ?.replace(
          /\D/g,
          ""
        )
        ||
        null;
 
 
let contact =
  phone
    ? await findContactByIdentifier(
        "phone",
        phone
      )
    : null;
 
 
if (!contact) {
 
  contact =
    await findContactByIdentifier(
      "whatsapp_jid",
      jid
    );
 
}
 
 
if (!contact) {
 
  const direct =
    await pool.query(
      `
        SELECT *
 
        FROM contacts
 
        WHERE whatsapp_jid =
          $1
 
        LIMIT 1
      `,
      [
        jid
      ]
    );
 
 
  contact =
    direct.rows[0]
    ||
    null;
 
}
 
 
if (contact) {
 
  if (
    phone
    &&
    contact.whatsapp_jid !== jid
  ) {
 
    const conflict =
      await pool.query(
        `
          SELECT
            id
 
          FROM contacts
 
          WHERE whatsapp_jid =
            $1
 
            AND id <>
              $2
 
          LIMIT 1
        `,
        [
          jid,
          contact.id
        ]
      );
 
 
    if (
      conflict.rows[0]
    ) {
 
      throw new Error(
        `WhatsApp-JID ${jid} ist bereits einem anderen Kontakt zugeordnet.`
      );
 
    }
 
 
    await pool.query(
      `
        UPDATE messages
 
        SET whatsapp_jid =
          $2
 
        WHERE whatsapp_jid =
          $1
      `,
      [
        contact.whatsapp_jid,
        jid
      ]
    );
 
 
    const updated =
      await pool.query(
        `
          UPDATE contacts
 
          SET
            whatsapp_jid =
              $2,
 
            phone_number =
              COALESCE(
                $3,
                phone_number
              ),
 
            current_platform =
              'whatsapp',
 
            platform_status =
              'WHATSAPP_ACTIVE',
 
            last_message_at =
              NOW(),
 
            updated_at =
              NOW()
 
          WHERE id =
            $1
 
          RETURNING *
        `,
        [
          contact.id,
          jid,
          phone
        ]
      );
 
 
    contact =
      updated.rows[0];
 
  } else {
 
    const updated =
      await pool.query(
        `
          UPDATE contacts
 
          SET
            phone_number =
              COALESCE(
                phone_number,
                $2
              ),
 
            last_message_at =
              NOW(),
 
            updated_at =
              NOW()
 
          WHERE id =
            $1
 
          RETURNING *
        `,
        [
          contact.id,
          phone
        ]
      );
 
 
    contact =
      updated.rows[0];
 
  }
 
 
  await addContactIdentifier({
 
    contactId:
      contact.id,
 
    type:
      "whatsapp_jid",
 
    value:
      jid,
 
    sourcePlatform:
      "whatsapp",
 
    isPrimary:
      true
 
  });
 
 
  if (phone) {
 
    await addContactIdentifier({
 
      contactId:
        contact.id,
 
      type:
        "phone",
 
      value:
        phone,
 
      sourcePlatform:
        "whatsapp",
 
      isPrimary:
        true
 
    });
 
  }
 
 
  await pool.query(
    `
      INSERT INTO contact_memory_profiles (
        contact_id
      )
 
      VALUES (
        $1
      )
 
      ON CONFLICT (
        contact_id
      )
 
      DO NOTHING
    `,
    [
      contact.id
    ]
  );
 
 
  return contact;
 
}
 
 
const result =
  await pool.query(
    `
      INSERT INTO contacts (
 
        whatsapp_jid,
 
        phone_number,
 
        current_platform,
 
        platform_status,
 
        first_contact_at,
 
        last_message_at,
 
        updated_at
 
      )
 
      VALUES (
 
        $1,
 
        $2,
 
        CASE
          WHEN $2 IS NULL
            THEN NULL
          ELSE
            'whatsapp'
        END,
 
        CASE
          WHEN $2 IS NULL
            THEN NULL
          ELSE
            'WHATSAPP_ACTIVE'
        END,
 
        NOW(),
 
        NOW(),
 
        NOW()
 
      )
 
      ON CONFLICT (
        whatsapp_jid
      )
 
      DO UPDATE SET
 
        phone_number =
          COALESCE(
            contacts.phone_number,
            EXCLUDED.phone_number
          ),
 
        last_message_at =
          NOW(),
 
        updated_at =
          NOW()
 
      RETURNING *
    `,
    [
      jid,
      phone
    ]
  );
 
 
contact =
  result.rows[0];
 
 
await pool.query(
  `
    INSERT INTO contact_memory_profiles (
      contact_id
    )
 
    VALUES (
      $1
    )
 
    ON CONFLICT (
      contact_id
    )
 
    DO NOTHING
  `,
  [
    contact.id
  ]
);
 
 
await addContactIdentifier({
 
  contactId:
    contact.id,
 
  type:
    "whatsapp_jid",
 
  value:
    jid,
 
  sourcePlatform:
    "whatsapp",
 
  isPrimary:
    true
 
});
 
 
if (phone) {
 
  await addContactIdentifier({
 
    contactId:
      contact.id,
 
    type:
      "phone",
 
    value:
      phone,
 
    sourcePlatform:
      "whatsapp",
 
    isPrimary:
      true
 
  });
 
}
 
 
return contact;
 
}
 
 
async function getContactByJid(
jid
) {
 
const result =
  await pool.query(
    `
      SELECT *
 
      FROM contacts
 
      WHERE whatsapp_jid =
        $1
 
      LIMIT 1
    `,
    [
      jid
    ]
  );
 
 
return (
  result.rows[0]
  ||
  null
);
 
}
 
 
async function getContactById(
contactId
) {
 
const result =
  await pool.query(
    `
      SELECT *
 
      FROM contacts
 
      WHERE id =
        $1
 
      LIMIT 1
    `,
    [
      contactId
    ]
  );
 
 
return (
  result.rows[0]
  ||
  null
);
 
}
 
 
/* ==================================================
 TESTKONTAKT
================================================== */
 
async function createTestContact({
name,
country = null,
city = null,
language = null
}) {
 
const cleanName =
  normalizeText(
    name
  );
 
 
if (!cleanName) {
 
  throw new Error(
    "Testkontakt braucht einen Namen."
  );
 
}
 
 
const jid =
  `test-${createTestSlug(cleanName)}@persona.test`;
 
 
const result =
  await pool.query(
    `
      INSERT INTO contacts (
 
        whatsapp_jid,
 
        display_name,
 
        country,
 
        city,
 
        primary_language,
 
        source_platform,
 
        current_platform,
 
        source_profile_name,
 
        contact_status,
 
        relationship_stage,
 
        auto_reply_enabled,
 
        date_lock_enabled,
 
        first_contact_at,
 
        last_message_at,
 
        updated_at
 
      )
 
      VALUES (
 
        $1,
 
        $2,
 
        $3,
 
        $4,
 
        $5,
 
        'persona_test',
 
        'persona_test',
 
        $2,
 
        'active',
 
        'new',
 
        TRUE,
 
        FALSE,
 
        NOW(),
 
        NOW(),
 
        NOW()
 
      )
 
      RETURNING *
    `,
    [
      jid,
      cleanName,
      normalizeText(
        country
      )
      ||
      null,
      normalizeText(
        city
      )
      ||
      null,
      normalizeText(
        language
      )
      ||
      null
    ]
  );
 
 
await pool.query(
  `
    INSERT INTO contact_memory_profiles (
      contact_id
    )
 
    VALUES (
      $1
    )
 
    ON CONFLICT (
      contact_id
    )
 
    DO NOTHING
  `,
  [
    result.rows[0].id
  ]
);
 
 
return result.rows[0];
 
}
 
 
async function getTestContacts() {
 
const result =
  await pool.query(
    `
      SELECT
 
        id,
 
        whatsapp_jid,
 
        display_name,
 
        country,
 
        city,
 
        primary_language,
 
        relationship_stage,
 
        created_at,
 
        updated_at
 
      FROM contacts
 
      WHERE whatsapp_jid
        LIKE '%@persona.test'
 
      ORDER BY
        updated_at DESC,
        display_name ASC
    `
  );
 
 
return result.rows;
 
}
 
 
/* ==================================================
 NACHRICHTEN
================================================== */
 
async function saveMessage(
jid,
direction,
text,
whatsappMessageId = null,
options = {}
) {
 
const contact =
  await ensureContact(
    jid
  );
 
 
const result =
  await pool.query(
    `
      INSERT INTO messages (
 
        whatsapp_jid,
 
        direction,
 
        message_text,
 
        whatsapp_message_id,
 
        processing_status,
 
        duplicate_of_message_id
 
      )
 
      VALUES (
 
        $1,
 
        $2,
 
        $3,
 
        $4,
 
        $5,
 
        $6
 
      )
 
      RETURNING *
    `,
    [
      jid,
      direction,
      text || null,
      whatsappMessageId,
      options.processingStatus || "processed",
      options.duplicateOfMessageId || null
    ]
  );
 
 
await pool.query(
  `
    UPDATE contacts
 
    SET
      last_message_at =
        NOW(),
 
      updated_at =
        NOW()
 
    WHERE id =
      $1
  `,
  [
    contact.id
  ]
);
 
 
return result.rows[0];
 
}
 
 
/* ==================================================
 DUPLIKAT
================================================== */
 
async function getLastIncomingMessage(
jid
) {
 
const result =
  await pool.query(
    `
      SELECT *
 
      FROM messages
 
      WHERE whatsapp_jid =
        $1
 
        AND direction =
          'incoming'
 
        AND message_text
          IS NOT NULL
 
      ORDER BY
        id DESC
 
      LIMIT 1
    `,
    [
      jid
    ]
  );
 
 
return (
  result.rows[0]
  ||
  null
);
 
}
 
 
async function detectImmediateDuplicate(
jid,
text
) {
 
const last =
  await getLastIncomingMessage(
    jid
  );
 
 
if (!last) {
  return null;
}
 
 
if (
  normalizeForDuplicate(
    last.message_text
  )
  !==
  normalizeForDuplicate(
    text
  )
) {
 
  return null;
 
}
 
 
const ageMinutes =
  (
    Date.now()
    -
    new Date(
      last.created_at
    ).getTime()
  )
  /
  60000;
 
 
return (
  Number.isFinite(
    ageMinutes
  )
  &&
  ageMinutes
  <=
  DUPLICATE_WINDOW_MINUTES
)
 
  ? last
 
  : null;
 
}
 
 
/* ==================================================
 DUPLIKAT ANTWORT MIT SPRACHERKENNUNG V1.7.2
================================================== */
 
async function duplicateReplyForContact(
contact,
jid,
incomingText
) {
 
const language =
  await resolveReplyLanguage(
    contact,
    jid,
    incomingText
  );
 
 
console.log(
  "Duplikat-Sprache erkannt:",
  language,
  "Kontakt:",
  contact?.display_name
  ||
  contact?.canonical_name
  ||
  jid
);
 
 
if (
  language === "es"
) {
 
  return (
    "Esa me llegó dos veces ? "
    +
    "¿Fue sin querer o querías asegurarte de que la viera?"
  );
 
}
 
 
if (
  language === "de"
) {
 
  return (
    "Die kam gerade zweimal ? "
    +
    "War das aus Versehen oder wolltest du sichergehen, dass ich sie sehe?"
  );
 
}
 
 
return (
  "That one just came through twice ? "
  +
  "Accident, or were you making sure I saw it?"
);
 
}
 
 
/* ==================================================
 EDITED MESSAGE
================================================== */
 
async function updateEditedIncomingMessage({
jid,
whatsappMessageId,
newText
}) {
 
if (
  !jid
  ||
  !whatsappMessageId
  ||
  !normalizeText(
    newText
  )
) {
 
  return null;
 
}
 
 
const result =
  await pool.query(
    `
      UPDATE messages
 
      SET
        original_message_text =
          COALESCE(
            original_message_text,
            message_text
          ),
 
        message_text =
          $3,
 
        is_edited =
          TRUE,
 
        edited_at =
          NOW()
 
      WHERE whatsapp_jid =
        $1
 
        AND whatsapp_message_id =
          $2
 
        AND direction =
          'incoming'
 
      RETURNING *
    `,
    [
      jid,
      whatsappMessageId,
      normalizeText(
        newText
      )
    ]
  );
 
 
return (
  result.rows[0]
  ||
  null
);
 
}
 
 
/* ==================================================
 VERLAUF
================================================== */
 
async function getConversationHistory(
jid,
beforeMessageId = null
) {
 
let result;
 
 
if (beforeMessageId) {
 
  result =
    await pool.query(
      `
        SELECT
 
          id,
 
          direction,
 
          message_text,
 
          is_edited,
 
          created_at
 
        FROM messages
 
        WHERE whatsapp_jid =
          $1
 
          AND message_text
            IS NOT NULL
 
          AND id <
            $2
 
        ORDER BY
          id DESC
 
        LIMIT 30
      `,
      [
        jid,
        beforeMessageId
      ]
    );
 
} else {
 
  result =
    await pool.query(
      `
        SELECT
 
          id,
 
          direction,
 
          message_text,
 
          is_edited,
 
          created_at
 
        FROM messages
 
        WHERE whatsapp_jid =
          $1
 
          AND message_text
            IS NOT NULL
 
        ORDER BY
          id DESC
 
        LIMIT 30
      `,
      [
        jid
      ]
    );
 
}
 
 
return result.rows.reverse();
 
}
 
 
/* ==================================================
 DASHBOARD CHATVERLAUF
 READ ONLY
================================================== */
 
async function getDashboardConversationHistory(
jid,
limit = 200
) {
 
const safeLimit =
  Math.max(
    1,
    Math.min(
      500,
      Number(limit) || 200
    )
  );
 
 
const result =
  await pool.query(
    `
      SELECT
 
        id,
 
        direction,
 
        message_text,
 
        whatsapp_message_id,
 
        is_edited,
 
        edited_at,
 
        original_message_text,
 
        processing_status,
 
        duplicate_of_message_id,
 
        created_at
 
      FROM messages
 
      WHERE whatsapp_jid =
        $1
 
        AND message_text
          IS NOT NULL
 
      ORDER BY
        id DESC
 
      LIMIT $2
    `,
    [
      jid,
      safeLimit
    ]
  );
 
 
return result.rows
  .reverse()
  .map(
    message => ({
 
      id:
        message.id,
 
      direction:
        message.direction,
 
      text:
        message.message_text,
 
      whatsappMessageId:
        message.whatsapp_message_id,
 
      edited:
        message.is_edited
        ===
        true,
 
      editedAt:
        message.edited_at,
 
      originalText:
        message.original_message_text,
 
      processingStatus:
        message.processing_status,
 
      duplicateOfMessageId:
        message.duplicate_of_message_id,
 
      createdAt:
        message.created_at
 
    })
  );
 
}
 
 
/* ==================================================
 DASHBOARD NACHRICHTENANZAHL
 READ ONLY
================================================== */
 
async function getDashboardMessageCount(
jid
) {
 
const result =
  await pool.query(
    `
      SELECT
        COUNT(*)::integer
          AS count
 
      FROM messages
 
      WHERE whatsapp_jid =
        $1
 
        AND message_text
          IS NOT NULL
    `,
    [
      jid
    ]
  );
 
 
return Number(
  result.rows[0]?.count
  ||
  0
);
 
}
 
 
/* ==================================================
 WHATSAPP HISTORICAL IMPORT V1
 Vollstaendigen Export senden; Aufteilung/Deduplizierung passiert intern.
================================================== */
 
function parseWhatsAppExportDate(datePart, timePart) {
const d = normalizeText(datePart).match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
const t = normalizeText(timePart).replace(/\u202f|\u00a0/g, " ").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
if (!d || !t) return null;
let year = Number(d[3]);
if (year < 100) year += 2000;
let hour = Number(t[1]);
const minute = Number(t[2]);
const second = Number(t[3] || 0);
const ap = normalizeText(t[4]).toUpperCase();
if (ap === "PM" && hour < 12) hour += 12;
if (ap === "AM" && hour === 12) hour = 0;
const value = new Date(year, Number(d[2]) - 1, Number(d[1]), hour, minute, second, 0);
return Number.isNaN(value.getTime()) ? null : value;
}
 
function parseWhatsAppExport(rawText) {
const lines = String(rawText || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
const patterns = [
  /^\[(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\]\s*([^:]+):\s?(.*)$/i,
  /^(\d{1,2}[.\/-]\d{1,2}[.\/-]\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?)\s*[-–]\s*([^:]+):\s?(.*)$/i
];
const messages = [];
let current = null;
const flush = () => {
  if (current) {
    current.text = String(current.text || "").trim();
    if (current.createdAt && current.sender && current.text) messages.push(current);
  }
  current = null;
};
for (const line of lines) {
  let match = null;
  for (const pattern of patterns) {
    match = line.match(pattern);
    if (match) break;
  }
  if (match) {
    flush();
    const createdAt = parseWhatsAppExportDate(match[1], match[2]);
    if (createdAt) current = { createdAt, sender: normalizeText(match[3]), text: match[4] || "" };
  } else if (current) {
    current.text += `\n${line}`;
  }
}
flush();
return messages;
}
 
function normalizeImportSender(value) {
return normalizeText(value).toLocaleLowerCase("de-DE").replace(/\s+/g, " ");
}
 
function historicalImportHash({ jid, direction, createdAt, text }) {
return crypto.createHash("sha256").update([
  jid,
  direction,
  new Date(createdAt).toISOString(),
  normalizeForDuplicate(text)
].join("|")).digest("hex");
}
 
async function historicalMessageAlreadyExists({ jid, direction, createdAt, text, sourceHash, usedExistingIds = new Set() }) {
const byHash = await pool.query(
  `SELECT id FROM messages WHERE import_source_hash = $1 LIMIT 1`,
  [sourceHash]
);
if (byHash.rows[0]) return byHash.rows[0];
 
// Cross-Source-Fallback: Live-WhatsApp und TXT-Export koennen dieselbe Nachricht
// mit unterschiedlicher Zeitzonen-/Importzeit gespeichert haben. Deshalb vergleichen
// wir Richtung + exakt normalisierten Text in einem grossen Zeitfenster und nehmen
// den zeitlich naechsten, noch nicht fuer eine andere Exportzeile verwendeten Treffer.
const usedIds = [...usedExistingIds].map(Number).filter(Number.isInteger);
const nearby = await pool.query(
  `SELECT id, message_text, created_at
     FROM messages
    WHERE whatsapp_jid = $1
      AND direction = $2
      AND created_at BETWEEN $3::timestamptz - INTERVAL '18 hours'
                         AND $3::timestamptz + INTERVAL '18 hours'
      AND NOT (id = ANY($4::bigint[]))
    ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - $3::timestamptz))) ASC
    LIMIT 120`,
  [jid, direction, createdAt, usedIds]
);
return nearby.rows.find(row =>
  normalizeForDuplicate(row.message_text) === normalizeForDuplicate(text)
) || null;
}
 
async function importWhatsAppHistory({ contact, rawText, marcelSenderNames = [], senderMapping = null }) {
 const parsed = parseWhatsAppExport(rawText);
 if (!parsed.length) throw new Error("Keine WhatsApp-Nachrichten im unterstuetzten Exportformat erkannt.");
 
 // WICHTIG: parseWhatsAppExport liest den Absender AUSSCHLIESSLICH aus dem
 // strukturellen Absenderfeld vor dem Doppelpunkt. Namen/Emojis im Nachrichtentext
 // werden niemals zur Identitaets- oder Richtungsbestimmung benutzt.
 const senders = [...new Set(parsed.map(item => item.sender))];
 const senderSet = new Set(senders.map(normalizeImportSender));
 
 const explicitMarcelSender = normalizeText(senderMapping?.marcelSender);
 const explicitContactSender = normalizeText(senderMapping?.contactSender);
 const hasExplicitMapping = Boolean(explicitMarcelSender && explicitContactSender);
 
 if (hasExplicitMapping) {
   const marcelKey = normalizeImportSender(explicitMarcelSender);
   const contactKey = normalizeImportSender(explicitContactSender);
 
   if (marcelKey === contactKey) {
     throw new Error("Marcel und Kontakt duerfen nicht derselbe WhatsApp-Absender sein.");
   }
   if (!senderSet.has(marcelKey)) {
     throw new Error(`Bestaetigter Marcel-Absender wurde im Export nicht gefunden: ${explicitMarcelSender}`);
   }
   if (!senderSet.has(contactKey)) {
     throw new Error(`Bestaetigter Kontakt-Absender wurde im Export nicht gefunden: ${explicitContactSender}`);
   }
 
   // Die manuelle Bestaetigung ist die hoechste Instanz. Ab hier wird NICHT mehr
   // anhand von Marcel-Namen, Kontakt-Namen oder Nachrichtentext geraten.
   const unexpected = senders.filter(sender => {
     const key = normalizeImportSender(sender);
     return key !== marcelKey && key !== contactKey;
   });
 
   if (unexpected.length) {
     const error = new Error(`Weitere Absender im Export erkannt: ${unexpected.join(", ")}. Bitte Zuordnung pruefen.`);
     error.code = "SENDER_CONFIRMATION_REQUIRED";
     error.senders = senders;
     throw error;
   }
 }
 
 const marcelNames = new Set([
   "Marcel",
   "Marcel Marlow",
   ...marcelSenderNames
 ].map(normalizeImportSender).filter(Boolean));
 
 if (!hasExplicitMapping) {
   const nonMarcelSenders = senders.filter(sender => !marcelNames.has(normalizeImportSender(sender)));
   if (nonMarcelSenders.length !== 1 || senders.length !== 2) {
     const error = new Error(`Absender muessen eindeutig bestaetigt werden: ${senders.join(", ")}.`);
     error.code = "SENDER_CONFIRMATION_REQUIRED";
     error.senders = senders;
     throw error;
   }
 }
 
 const batchId = `wa-import-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
 let imported = 0;
 let duplicates = 0;
 let incoming = 0;
 let outgoing = 0;
 const newMessageIds = [];
 const usedExistingIds = new Set();
 
 const explicitMarcelKey = normalizeImportSender(explicitMarcelSender);
 const explicitContactKey = normalizeImportSender(explicitContactSender);
 
 for (const item of parsed) {
   const senderKey = normalizeImportSender(item.sender);
   let direction;
 
   if (hasExplicitMapping) {
     if (senderKey === explicitMarcelKey) direction = "outgoing";
     else if (senderKey === explicitContactKey) direction = "incoming";
     else continue; // Sicherheitsnetz; sollte wegen obiger Validierung nie eintreten.
   } else {
     direction = marcelNames.has(senderKey) ? "outgoing" : "incoming";
   }
 
   const sourceHash = historicalImportHash({
     jid: contact.whatsapp_jid,
     direction,
     createdAt: item.createdAt,
     text: item.text
   });
 
   const existing = await historicalMessageAlreadyExists({
     jid: contact.whatsapp_jid,
     direction,
     createdAt: item.createdAt,
     text: item.text,
     sourceHash,
     usedExistingIds
   });
 
   if (existing) {
     usedExistingIds.add(Number(existing.id));
     duplicates += 1;
     continue;
   }
 
   const inserted = await pool.query(
     `INSERT INTO messages (
       whatsapp_jid, direction, message_text, whatsapp_message_id,
       processing_status, created_at, import_source_hash, import_batch_id
     ) VALUES ($1,$2,$3,$4,'historical_imported',$5,$6,$7)
     ON CONFLICT (import_source_hash) WHERE import_source_hash IS NOT NULL DO NOTHING
     RETURNING id`,
     [
       contact.whatsapp_jid,
       direction,
       item.text,
       `historical-${sourceHash.slice(0, 24)}`,
       item.createdAt,
       sourceHash,
       batchId
     ]
   );
 
   if (!inserted.rows[0]) {
     duplicates += 1;
     continue;
   }
 
   imported += 1;
   direction === "incoming" ? incoming += 1 : outgoing += 1;
   newMessageIds.push(inserted.rows[0].id);
 }
 
 if (imported > 0) {
   await pool.query(
     `UPDATE contacts
      SET first_contact_at = COALESCE(LEAST(first_contact_at,$2::timestamptz),$2::timestamptz),
          last_message_at = GREATEST(COALESCE(last_message_at,$3::timestamptz),$3::timestamptz),
          updated_at = NOW()
      WHERE id = $1`,
     [contact.id, parsed[0].createdAt, parsed[parsed.length - 1].createdAt]
   );
 }
 
 return {
   batchId,
   parsed: parsed.length,
   imported,
   duplicates,
   incoming,
   outgoing,
   senders,
   senderMapping: hasExplicitMapping ? {
     marcelSender: explicitMarcelSender,
     contactSender: explicitContactSender,
     confirmed: true
   } : null,
   newMessageIds
 };
}
 
/* ==================================================
 HISTORICAL MEMORY BACKFILL V2
 Kontakt + Marcel getrennt; semantische Konsolidierung
================================================== */
async function ensureHistoricalMemoryReviewTable() {
 await pool.query(`CREATE TABLE IF NOT EXISTS memory_import_review (
   id BIGSERIAL PRIMARY KEY, subject_type TEXT NOT NULL, contact_id BIGINT,
   decision TEXT NOT NULL, category TEXT, memory_key TEXT, existing_memory_key TEXT,
   proposed_value JSONB NOT NULL DEFAULT '{}'::jsonb, evidence TEXT, reason TEXT,
   source_type TEXT DEFAULT 'whatsapp_historical_import', status TEXT DEFAULT 'pending',
   created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
 )`);
}
function historicalConversationRows(rawText, senderMapping) {
 const parsed=parseWhatsAppExport(rawText), m=normalizeImportSender(senderMapping?.marcelSender), c=normalizeImportSender(senderMapping?.contactSender);
 return parsed.filter(x=>[m,c].includes(normalizeImportSender(x.sender))).map(x=>({role:normalizeImportSender(x.sender)===m?'Marcel':'Kontakt',createdAt:x.createdAt,text:normalizeText(x.text)})).filter(x=>x.text);
}
function compactMemoryValue(value) { return value&&typeof value==='object'&&!Array.isArray(value)?value:{value:value??null}; }
async function createHistoricalReview({subjectType,contactId,decision,item}) {
 await ensureHistoricalMemoryReviewTable();
 await pool.query(`INSERT INTO memory_import_review (subject_type,contact_id,decision,category,memory_key,existing_memory_key,proposed_value,evidence,reason) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,[
   subjectType,contactId||null,decision,normalizeText(item?.category)||null,normalizeText(item?.memory_key)||null,normalizeText(item?.existing_memory_key)||null,JSON.stringify(compactMemoryValue(item?.memory_value)),normalizeText(item?.evidence)||null,normalizeText(item?.reason)||null
 ]);
}
async function applyHistoricalMarcelDecisions(items,contactId) {
 const stats={same:0,updated:0,created:0,review:0}; if(!Array.isArray(items))return stats;
 for(const item of items.slice(0,30)) {
   const d=normalizeText(item?.decision).toUpperCase(),cat=normalizeText(item?.category)||'general',key=normalizeText(item?.memory_key),oldKey=normalizeText(item?.existing_memory_key),val=compactMemoryValue(item?.memory_value),imp=clampImportance(item?.importance);
   if(d==='SAME'){stats.same++;continue;}
   if(d==='CONTRADICTION'||d==='UNCERTAIN'){await createHistoricalReview({subjectType:'marcel',contactId,decision:d,item});stats.review++;continue;}
   if(d==='UPDATE'&&oldKey){
     const row=(await pool.query(`SELECT * FROM marcel_memory WHERE memory_key=$1 LIMIT 1`,[oldKey])).rows[0];
     if(row?.human_verified===true){await createHistoricalReview({subjectType:'marcel',contactId,decision:'UNCERTAIN',item:{...item,reason:`UPDATE betrifft verifiziertes Marcel-Memory: ${oldKey}`}});stats.review++;continue;}
     if(row){await pool.query(`UPDATE marcel_memory SET category=$2,memory_value=$3::jsonb,importance=GREATEST(importance,$4),source_type='whatsapp_historical_import',human_verified=FALSE,allowed_for_bot=TRUE,status='active',updated_at=NOW() WHERE id=$1`,[row.id,cat,JSON.stringify(val),imp]);stats.updated++;continue;}
   }
   if((d==='NEW'||d==='UPDATE')&&key){const r=await pool.query(`INSERT INTO marcel_memory (category,memory_key,memory_value,status,importance,sensitivity,source_type,human_verified,allowed_for_bot,usage_notes) VALUES ($1,$2,$3::jsonb,'active',$4,$5,'whatsapp_historical_import',FALSE,TRUE,$6) ON CONFLICT (memory_key) DO NOTHING RETURNING id`,[cat,key,JSON.stringify(val),imp,['normal','personal','intimate'].includes(item?.sensitivity)?item.sensitivity:'normal',normalizeText(item?.reason)||'Semantisch aus historischem WhatsApp-Verlauf extrahiert.']);if(r.rows[0])stats.created++;else stats.same++;}
 } return stats;
}
async function applyHistoricalContactDecisions(items,contactId) {
 const stats={same:0,updated:0,created:0,review:0}; if(!Array.isArray(items))return stats;
 for(const item of items.slice(0,30)){
   const d=normalizeText(item?.decision).toUpperCase();
   if(d==='SAME'){stats.same++;continue;}
   if(d==='CONTRADICTION'||d==='UNCERTAIN'){await createHistoricalReview({subjectType:'contact',contactId,decision:d,item});stats.review++;continue;}
   const oldId=Number(item?.existing_memory_id); if(d==='UPDATE'&&Number.isInteger(oldId)&&oldId>0){await retireMemoryItems(contactId,[oldId]);stats.updated++;}
   if(d==='NEW'||d==='UPDATE'){const before=Number((await pool.query(`SELECT COUNT(*)::int count FROM memory_items WHERE contact_id=$1`,[contactId])).rows[0]?.count||0);await applyMemoryItems(contactId,[{category:item?.category,memory_key:item?.memory_key,memory_value:item?.memory_value,memory_type:item?.memory_type||'self_reported',confidence:item?.confidence??0.9,importance:item?.importance??3,source_quote:item?.evidence||null,use_in_reply:item?.use_in_reply!==false}],null,normalizeText(item?.evidence));const after=Number((await pool.query(`SELECT COUNT(*)::int count FROM memory_items WHERE contact_id=$1`,[contactId])).rows[0]?.count||0);if(after>before)stats.created++;}
 } return stats;
}
async function ensureHistoricalBackfillJobsTable() {
 await pool.query(`CREATE TABLE IF NOT EXISTS historical_memory_backfill_jobs (
   job_id TEXT PRIMARY KEY, contact_id BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
   total_chunks INTEGER NOT NULL DEFAULT 0, completed_chunks INTEGER NOT NULL DEFAULT 0,
   contact_stats JSONB NOT NULL DEFAULT '{}'::jsonb, marcel_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
   error_text TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), completed_at TIMESTAMPTZ
 )`);
}
function historicalChunkCount(rowCount,size=45,overlap=8){if(rowCount<=0)return 0;if(rowCount<=size)return 1;return 1+Math.ceil((rowCount-size)/(size-overlap));}
async function updateHistoricalBackfillJob(jobId,patch={}) {
 if(!jobId)return; await ensureHistoricalBackfillJobsTable();
 const fields=[],values=[]; let i=1;
 for(const [column,value] of Object.entries(patch)){fields.push(`${column}=$${i++}${['contact_stats','marcel_stats'].includes(column)?'::jsonb':''}`);values.push(['contact_stats','marcel_stats'].includes(column)?JSON.stringify(value):value);}
 if(!fields.length)return; values.push(jobId);
 await pool.query(`UPDATE historical_memory_backfill_jobs SET ${fields.join(', ')}, updated_at=NOW() WHERE job_id=$${i}`,values);
}
async function runHistoricalMemoryBackfill({contact,rawText,senderMapping,jobId=null}) {
 const rows=historicalConversationRows(rawText,senderMapping);
 if(!rows.length){await updateHistoricalBackfillJob(jobId,{status:'completed',total_chunks:0,completed_chunks:0,contact_stats:{},marcel_stats:{}});return {status:'empty',chunks:0};}
 await ensureHistoricalMemoryReviewTable();
 const SIZE=45,OVERLAP=8,totalChunks=historicalChunkCount(rows.length,SIZE,OVERLAP),totals={chunks:0,contact:{same:0,updated:0,created:0,review:0},marcel:{same:0,updated:0,created:0,review:0}};
 await updateHistoricalBackfillJob(jobId,{status:'running',total_chunks:totalChunks,completed_chunks:0,contact_stats:totals.contact,marcel_stats:totals.marcel});
 for(let start=0;start<rows.length;start+=SIZE-OVERLAP){
   const chunk=rows.slice(start,start+SIZE); if(!chunk.length)break;
   const [contactItems,marcelItems]=await Promise.all([getRelevantMemoryItems(contact.id,180),pool.query(`SELECT id,category,memory_key,memory_value,importance,human_verified,source_type FROM marcel_memory WHERE status='active' AND (valid_until IS NULL OR valid_until>NOW()) ORDER BY importance DESC,updated_at DESC LIMIT 250`).then(r=>r.rows)]);
   const cm=contactItems.map(x=>`ID=${x.id}|${x.category}.${x.memory_key}|human=${x.human_review_status}|${renderJson(x.human_corrected_value||x.memory_value)}`).join('\n');
   const mm=marcelItems.map(x=>`KEY=${x.memory_key}|${x.category}|verified=${x.human_verified===true}|${renderJson(x.memory_value)}`).join('\n');
   const convo=chunk.map(x=>`[${new Date(x.createdAt).toISOString()}] ${x.role}: ${x.text}`).join('\n');
   const response=await openai.responses.create({model:MODEL,instructions:`Du bist der semantische Memory-Konsolidierer fuer Marcels WhatsApp-System. Antworte ausschliesslich mit gueltigem JSON. Verstehe den Dialog als Zusammenhang: Pronomen, kurze Antworten, Rueckbezuege, Korrekturen, Ironie und unterschiedliche Formulierungen desselben Sachverhalts. ZWEI GEHIRNE STRENG TRENNEN: contact_items sind Fakten ueber den Kontakt; marcel_items sind Fakten ueber Marcel. Entscheide semantisch: SAME = gleicher Sachverhalt trotz anderer Formulierung, nichts neu anlegen. UPDATE = gleicher Sachverhalt mit neuer/praeziser/zeitlich aktualisierter Information. CONTRADICTION = echter Widerspruch. NEW = wirklich neuer langfristig/relevant nutzbarer Sachverhalt. UNCERTAIN = Bedeutung, Person, Zeitbezug oder Faktstatus nicht sicher. Keine banalen Flirtphrasen, Emojis, Begruessungen oder Vermutungen speichern. Human/verifiziertes Wissen nie automatisch ersetzen. Bei UPDATE Kontakt existing_memory_id setzen; bei SAME/UPDATE Marcel existing_memory_key setzen. memory_key kurz, stabil, snake_case; bei SAME/UPDATE bestehenden Key verwenden. Bei Unsicherheit UNCERTAIN. JSON exakt: {"contact_items":[{"decision":"SAME|UPDATE|CONTRADICTION|NEW|UNCERTAIN","existing_memory_id":null,"category":"","memory_key":"","memory_value":{},"memory_type":"self_reported|explicit_fact|observed_pattern|interpretation|temporary_state","confidence":0.9,"importance":3,"use_in_reply":true,"evidence":"","reason":""}],"marcel_items":[{"decision":"SAME|UPDATE|CONTRADICTION|NEW|UNCERTAIN","existing_memory_key":null,"category":"","memory_key":"","memory_value":{},"importance":3,"sensitivity":"normal|personal|intimate","evidence":"","reason":""}]}`,
     input:`KONTAKT: ${contact.display_name||contact.canonical_name||contact.whatsapp_jid}\n\nBESTEHENDES KONTAKT-MEMORY:\n${cm||'[keine]'}\n\nBESTEHENDES MARCEL-MEMORY:\n${mm||'[keine]'}\n\nDIALOG-AUSSCHNITT CHRONOLOGISCH:\n${convo}\n\nKonsolidiere nur Memory-wuerdige Informationen.`});
   const parsed=safeJsonParse(response.output_text,{contact_items:[],marcel_items:[]})||{}; const cs=await applyHistoricalContactDecisions(parsed.contact_items||[],contact.id),ms=await applyHistoricalMarcelDecisions(parsed.marcel_items||[],contact.id);
   for(const k of Object.keys(totals.contact))totals.contact[k]+=cs[k]||0; for(const k of Object.keys(totals.marcel))totals.marcel[k]+=ms[k]||0; totals.chunks++; await updateHistoricalBackfillJob(jobId,{status:'running',total_chunks:totalChunks,completed_chunks:totals.chunks,contact_stats:totals.contact,marcel_stats:totals.marcel}); if(start+SIZE>=rows.length)break;
 }
 await updateHistoricalBackfillJob(jobId,{status:'completed',total_chunks:totalChunks,completed_chunks:totals.chunks,contact_stats:totals.contact,marcel_stats:totals.marcel,completed_at:new Date()}); console.log('Historical Memory Backfill fertig:',{contact:contact.display_name||contact.canonical_name||contact.whatsapp_jid,...totals}); return {status:'completed',...totals};
}
async function scheduleHistoricalMemoryBackfill(payload){await ensureHistoricalBackfillJobsTable();const jobId=`memory-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;const rows=historicalConversationRows(payload.rawText,payload.senderMapping);const totalChunks=historicalChunkCount(rows.length);await pool.query(`INSERT INTO historical_memory_backfill_jobs (job_id,contact_id,status,total_chunks,completed_chunks) VALUES ($1,$2,'queued',$3,0)`,[jobId,payload.contact.id,totalChunks]);setTimeout(()=>{runHistoricalMemoryBackfill({...payload,jobId}).catch(async error=>{console.error('Historical Memory Backfill fehlgeschlagen:',error);try{await updateHistoricalBackfillJob(jobId,{status:'failed',error_text:String(error?.message||error)});}catch{}});},300);return {jobId,totalChunks};}
 
/* ==================================================
 DASHBOARD WHATSAPP-EXPORT IMPORT V1
================================================== */
 
app.post("/dashboard-api/import-whatsapp", async (req, res) => {
try {
  if (!dashboardApiReady(res)) return;
  if (!dashboardApiAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
  }
 
  const contactId = Number(req.body?.contactId);
  const chatText = String(req.body?.chatText || "");
  const marcelSenderNames = Array.isArray(req.body?.marcelSenderNames) ? req.body.marcelSenderNames : [];
const senderMapping = req.body?.senderMapping && typeof req.body.senderMapping === "object"
? {
marcelSender: normalizeText(req.body.senderMapping.marcelSender),
contactSender: normalizeText(req.body.senderMapping.contactSender)
}
: null;
  if (!Number.isInteger(contactId) || contactId <= 0) {
    return res.status(400).json({ ok: false, error: "Ungueltige Kontakt-ID." });
  }
  if (!chatText.trim()) {
    return res.status(400).json({ ok: false, error: "Der WhatsApp-Export ist leer." });
  }
 
  const contactResult = await pool.query(`SELECT * FROM contacts WHERE id = $1 LIMIT 1`, [contactId]);
  const contact = contactResult.rows[0];
  if (!contact) return res.status(404).json({ ok: false, error: "Kontakt nicht gefunden." });
 
  const result = await importWhatsAppHistory({ contact, rawText: chatText, marcelSenderNames, senderMapping });
  console.log("WhatsApp Historical Import:", contact.display_name || contact.canonical_name || contact.whatsapp_jid, result);
 
  const backfillJob = await scheduleHistoricalMemoryBackfill({ contact, rawText: chatText, senderMapping });
 
  return res.json({
    ok: true,
    contact: {
      id: contact.id,
      name: contact.display_name || contact.canonical_name || null,
      jid: contact.whatsapp_jid
    },
    ...result,
    memoryBackfill: {
      status: "started",
      jobId: backfillJob.jobId,
      totalChunks: backfillJob.totalChunks,
      message: "Import und Deduplizierung fertig. Semantischer Memory-Backfill fuer Kontakt und Marcel wurde gestartet."
    }
  });
} catch (error) {
console.error("WhatsApp Historical Import Fehler:", error);
if (error?.code === "SENDER_CONFIRMATION_REQUIRED") {
return res.status(409).json({
ok: false,
code: "SENDER_CONFIRMATION_REQUIRED",
error: error?.message || "Absender muessen bestaetigt werden.",
senders: Array.isArray(error?.senders) ? error.senders : []
});
}
return res.status(500).json({
ok: false,
error: error?.message || "WhatsApp-Export konnte nicht importiert werden."
});
}
});
 
 
app.get("/dashboard-api/import-whatsapp-status", async (req,res)=>{
 try{
   if(!dashboardApiReady(res))return; if(!dashboardApiAuthorized(req))return res.status(401).json({ok:false,error:"Nicht autorisiert."});
   const jobId=normalizeText(req.query?.jobId); if(!jobId)return res.status(400).json({ok:false,error:"jobId fehlt."});
   await ensureHistoricalBackfillJobsTable();
   const row=(await pool.query(`SELECT job_id,contact_id,status,total_chunks,completed_chunks,contact_stats,marcel_stats,error_text,created_at,updated_at,completed_at FROM historical_memory_backfill_jobs WHERE job_id=$1 LIMIT 1`,[jobId])).rows[0];
   if(!row)return res.status(404).json({ok:false,error:"Memory-Job nicht gefunden."});
   return res.json({ok:true,job:{jobId:row.job_id,contactId:row.contact_id,status:row.status,totalChunks:row.total_chunks,completedChunks:row.completed_chunks,contact:row.contact_stats||{},marcel:row.marcel_stats||{},error:row.error_text||null,completedAt:row.completed_at||null}});
 }catch(error){console.error('Memory-Status Fehler:',error);return res.status(500).json({ok:false,error:"Memory-Status konnte nicht geladen werden."});}
});
 
/* ==================================================
 MEMORY ITEMS
================================================== */
 
async function getRelevantMemoryItems(
contactId,
limit = 60
) {
 
const result =
  await pool.query(
    `
      SELECT *
 
      FROM memory_items
 
      WHERE contact_id =
        $1
 
        AND status =
          'active'
 
        AND use_in_reply =
          TRUE
 
        AND (
          valid_until IS NULL
          OR valid_until > NOW()
        )
 
        AND human_review_status
          <> 'rejected'
 
      ORDER BY
 
        CASE
 
          WHEN human_review_status IN (
            'confirmed',
            'corrected'
          )
 
          THEN 0
 
          ELSE 1
 
        END,
 
        importance DESC,
 
        updated_at DESC
 
      LIMIT $2
    `,
    [
      contactId,
      limit
    ]
  );
 
 
return result.rows;
 
}
 
 
async function getHistoricalMemoryItems(
contactId,
limit = 200
) {
 
const result =
  await pool.query(
    `
      SELECT *
 
      FROM memory_items
 
      WHERE contact_id =
        $1
 
        AND status
          <> 'active'
 
      ORDER BY
        created_at DESC
 
      LIMIT $2
    `,
    [
      contactId,
      limit
    ]
  );
 
 
return result.rows;
 
}
 
 
/* ==================================================
 MEMORY EVENTS
================================================== */
 
async function getRelevantMemoryEvents(
contactId,
limit = 30
) {
 
const result =
  await pool.query(
    `
      SELECT *
 
      FROM memory_events
 
      WHERE contact_id =
        $1
 
        AND (
 
          event_status IN (
            'active',
            'open'
          )
 
          OR (
 
            requires_follow_up =
              TRUE
 
            AND follow_up_status NOT IN (
              'completed',
              'cancelled'
            )
 
          )
 
        )
 
      ORDER BY
        importance DESC,
        started_at DESC
 
      LIMIT $2
    `,
    [
      contactId,
      limit
    ]
  );
 
 
return result.rows;
 
}
 
 
async function getAllMemoryEvents(
contactId,
limit = 200
) {
 
const result =
  await pool.query(
    `
      SELECT *
 
      FROM memory_events
 
      WHERE contact_id =
        $1
 
      ORDER BY
        created_at DESC
 
      LIMIT $2
    `,
    [
      contactId,
      limit
    ]
  );
 
 
return result.rows;
 
}
 
 
/* ==================================================
 MARCEL MEMORY LADEN
================================================== */
 
async function getMarcelMemory(
limit = 60
) {
 
const result =
  await pool.query(
    `
      SELECT
 
        category,
 
        memory_key,
 
        memory_value,
 
        importance,
 
        usage_notes
 
      FROM marcel_memory
 
      WHERE status =
        'active'
 
        AND allowed_for_bot =
          TRUE
 
        AND (
          valid_until IS NULL
          OR valid_until > NOW()
        )
 
      ORDER BY
        importance DESC,
        updated_at DESC
 
      LIMIT $1
    `,
    [
      limit
    ]
  );
 
 
return result.rows;
 
}
 
 
async function getMarcelLiveState() {
 
const result =
  await pool.query(
    `
      SELECT *
 
      FROM marcel_live_state
 
      WHERE id =
        1
 
      LIMIT 1
    `
  );
 
 
return (
  result.rows[0]
  ||
  {}
);
 
}
 
 
/* ==================================================
 MEMORY CONTEXT
================================================== */
 
function buildMemoryContext({
contact,
profile,
memoryItems,
memoryEvents,
marcelMemory,
liveState
}) {
 
const profileData =
  profile
 
    ? Object.fromEntries(
        PROFILE_COLUMNS.map(
          column => [
            column,
            profile[column] || {}
          ]
        )
      )
 
    : {};
 
 
const renderedItems =
  memoryItems.length
 
    ? memoryItems
        .map(
          item => {
 
            const value =
              item.human_review_status
              ===
              "corrected"
              &&
              item.human_corrected_value
 
                ? item.human_corrected_value
 
                : item.memory_value;
 
 
            return (
              `#${item.id}`
              +
              `|${item.category}.${item.memory_key}`
              +
              `|${item.memory_type}`
              +
              `|review=${item.human_review_status}`
              +
              `|importance=${item.importance}`
              +
              `|${renderJson(value)}`
            );
 
          }
        )
        .join("\n")
 
    : "[keine]";
 
 
const renderedEvents =
  memoryEvents.length
 
    ? memoryEvents
        .map(
          event =>
            `#${event.id}`
            +
            `|${event.event_type}/${event.event_subtype || "-"}`
            +
            `|${renderJson(event.event_data)}`
        )
        .join("\n")
 
    : "[keine]";
 
 
const renderedMarcelMemory =
  marcelMemory.length
 
    ? marcelMemory
        .map(
          memory =>
            `${memory.category}.${memory.memory_key}`
            +
            `|${renderJson(memory.memory_value)}`
            +
            `|${memory.usage_notes || ""}`
        )
        .join("\n")
 
    : "[keine]";
 
 
return `
==================================================
LANGZEIT-GEDÄCHTNIS V1.7.2
==================================================
 
KONTAKT:
 
${renderJson({
 
id:
  contact?.id,
 
memory_identity_key:
  contact?.memory_identity_key,
 
canonical_name:
  contact?.canonical_name,
 
display_name:
  contact?.display_name,
 
whatsapp_display_name:
  contact?.whatsapp_display_name,
 
country:
  contact?.country,
 
city:
  contact?.city,
 
primary_language:
  contact?.primary_language,
 
source_platform:
  contact?.source_platform,
 
current_platform:
  contact?.current_platform,
 
platform_status:
  contact?.platform_status,
 
relationship_stage:
  contact?.relationship_stage
 
})}
 
 
==================================================
MARCEL LIVE STATE
==================================================
 
${renderJson(
liveState
)}
 
 
==================================================
AKTUELLES FRAUENPROFIL
==================================================
 
${renderJson(
profileData
)}
 
 
==================================================
AKTIVE MEMORIES
==================================================
 
${renderedItems}
 
 
==================================================
EVENTS
==================================================
 
${renderedEvents}
 
 
==================================================
MARCEL MEMORY
==================================================
 
${renderedMarcelMemory}
 
 
==================================================
REGELN
==================================================
 
- Nur ACTIVE gilt aktuell.
 
- Human confirmed/corrected
hat Vorrang.
 
- Frau und Marcel nie vermischen.
 
- Gleichnamige Frauen nie
nur anhand Namen zusammenführen.
 
- Dani != Daniela Messe != Dángela.
 
- Kate Castillo != alte Kathe.
 
- Paola Maza != ältere Paola.
 
- Karla Tinder != Karla Instagram.
 
- marcel_knowledge_map =
nur was diese Frau über Marcel weiß.
 
- Bestehende Fragen
nicht erneut stellen.
 
- Nach Plattformwechsel
Verlauf fortsetzen.
 
- Sprache des Kontakts
und des aktuellen Gesprächs beachten.
 
- Memory bedeutet NICHT,
alle bekannten Details
in einer Antwort auszugeben.
 
- Persönliche Informationen über Marcel
stufenweise preisgeben.
 
- Erst die tatsächlich gestellte Frage
in natürlicher Tiefe beantworten.
 
- Wenn sie mehrere echte Fragen stellt,
diese beantworten,
aber keine zusätzlichen Memory-Details
ungefragt anhängen.
 
- Vor einer Rückfrage prüfen,
was über die Frau bereits bekannt ist.
 
- Niemals nach etwas fragen,
das das Frauen-Memory
bereits eindeutig beantwortet.
 
- Beispiel:
Wenn bekannt ist,
dass sie ein Kind hat,
nicht fragen:
"Hast du Kinder?"
 
Falls das Thema weitere Kinder ist,
eher kurz:
"Und bist du noch offen für Kinder?"
`;
 
}
 
 
/* ==================================================
 KI ANTWORT
================================================== */
 
async function generateAIReply(
jid,
incomingText,
incomingMessageDbId = null,
extraInstructions = ""
) {
 
let conversation = "";
let memoryContext = "";
let resolvedLanguage = null;
 
 
if (jid) {
 
  const contact =
    (
      await getContactByJid(
        jid
      )
    )
    ||
    (
      await ensureContact(
        jid
      )
    );
 
 
  const [
    history,
    profile,
    memoryItems,
    memoryEvents,
    marcelMemory,
    liveState
  ] =
    await Promise.all([
 
      getConversationHistory(
        jid,
        incomingMessageDbId
      ),
 
      getContactMemoryProfile(
        contact.id
      ),
 
      getRelevantMemoryItems(
        contact.id
      ),
 
      getRelevantMemoryEvents(
        contact.id
      ),
 
      getMarcelMemory(),
 
      getMarcelLiveState()
 
    ]);
 
 
  conversation =
    history
      .map(
        item =>
          `${item.direction === "incoming" ? "Andere Person" : "Marcel"}: ${item.message_text}`
      )
      .join("\n");
 
 
  memoryContext =
    buildMemoryContext({
 
      contact,
 
      profile,
 
      memoryItems,
 
      memoryEvents,
 
      marcelMemory,
 
      liveState
 
    });
 
 
  resolvedLanguage =
    await resolveReplyLanguage(
      contact,
      jid,
      incomingText
    );
 
}
 
 
const languageInstruction =
  resolvedLanguage
 
    ? (
        "Bevorzugte Antwortsprache für diese Nachricht: "
        +
        languageNameFromCode(
          resolvedLanguage
        )
        +
        "."
      )
 
    : "";
 
 
const response =
  await openai.responses.create({
 
    model:
      MODEL,
 
 
    instructions: `
${MARCEL_PERSONA_V1_7_2}
 
${memoryContext}
 
${languageInstruction}
 
Nutze Verlauf
als Kurzzeitgedächtnis
und aktive Memories
als Langzeitwissen.
 
Widersprich bekannten Fakten nicht.
 
Frage nichts erneut.
 
SEHR WICHTIG:
 
Memory ist Hintergrundwissen
und keine Aufforderung,
alle Details auszugeben.
 
Beantworte nur die tatsächlich
gestellten Fragen
in natürlicher Tiefe.
 
Wenn Marcel z.B.
nach seinen Kindern gefragt wird,
reiche nicht automatisch
Namen und Alter mit,
nur weil sie im Memory stehen.
 
Bei einfacher Frage:
"Ja, zwei.
Einen Jungen und ein Mädchen."
 
Weitere Details erst,
wenn danach gefragt wird
oder sie später natürlich relevant sind.
 
Wenn die Frau mehrere Fragen stellt,
beantworte ihre echten Fragen,
aber füge keine unnötigen
zusätzlichen Marcel-Fakten hinzu.
 
Bevor du eine Rückfrage stellst,
prüfe Frauenprofil,
aktive Memories
und Gesprächsverlauf.
 
Frage niemals etwas,
das über sie bereits bekannt ist.
 
Formuliere Rückfragen kurz
und wie ein echter WhatsApp-Chat.
 
Nicht:
"Und du, würdest du irgendwann gerne
noch weitere Kinder haben?"
 
Wenn passend eher:
"Und bist du noch offen für Kinder?"
 
Keine KI-Füllsätze.
 
Keine Eigenschaftslisten.
 
Keine künstlichen Kosenamen.
 
${extraInstructions || ""}
 
Gib ausschließlich
Marcels Nachricht aus.
`,
 
 
    input: `
==================================================
BISHERIGER VERLAUF
==================================================
 
${conversation || "[keiner]"}
 
 
==================================================
NEUE NACHRICHT
==================================================
 
${incomingText}
 
 
==================================================
AUFGABE
==================================================
 
Schreibe Marcels Antwort.
 
Beantworte,
was wirklich gefragt wurde.
 
Nutze Memory,
aber schütte es nicht aus.
 
Prüfe vor Rückfragen,
was über die Frau bereits bekannt ist.
`
  });
 
 
return (
  response.output_text
    ?.trim()
  ||
  ""
);
 
}
 
 
/* ==================================================
 MEMORY SUCHEN
================================================== */
 
async function findSimilarActiveMemory(
contactId,
category,
key
) {
 
const result =
  await pool.query(
    `
      SELECT *
 
      FROM memory_items
 
      WHERE contact_id =
        $1
 
        AND category =
          $2
 
        AND memory_key =
          $3
 
        AND status =
          'active'
 
      ORDER BY
        updated_at DESC
 
      LIMIT 1
    `,
    [
      contactId,
      category,
      key
    ]
  );
 
 
return (
  result.rows[0]
  ||
  null
);
 
}
 
 
/* ==================================================
 MEMORY RETIRE
================================================== */
 
async function retireMemoryItems(
contactId,
ids
) {
 
const safeIds =
  cleanIntegerArray(
    ids
  );
 
 
if (!safeIds.length) {
  return;
}
 
 
await pool.query(
  `
    UPDATE memory_items
 
    SET
      status =
        'superseded',
 
      valid_until =
        COALESCE(
          valid_until,
          NOW()
        ),
 
      updated_at =
        NOW()
 
    WHERE contact_id =
      $1
 
      AND id =
        ANY(
          $2::bigint[]
        )
 
      AND status =
        'active'
 
      AND human_review_status NOT IN (
        'confirmed',
        'corrected'
      )
  `,
  [
    contactId,
    safeIds
  ]
);
 
}
 
 
/* ==================================================
 KINDER LOGIK
================================================== */
 
function childSignalFromMemory(
category,
key,
value
) {
 
if (
  normalizeText(
    category
  )
    .toLowerCase()
  !==
  "children"
) {
 
  return null;
 
}
 
 
const memoryKey =
  normalizeText(
    key
  )
    .toLowerCase();
 
 
const memoryValue =
  value
  &&
  typeof value === "object"
 
    ? value
 
    : {};
 
 
if (
  memoryKey.includes(
    "has_no_children"
  )
  ||
  (
    memoryKey.includes(
      "has_children"
    )
    &&
    (
      memoryValue.has_children === false
      ||
      memoryValue.value === false
    )
  )
  ||
  memoryValue.child_count === 0
  ||
  memoryValue.count === 0
) {
 
  return "none";
 
}
 
 
if (
  memoryKey.includes(
    "has_son"
  )
  ||
  memoryValue.has_son === true
  ||
  memoryValue.son === true
) {
 
  return "son";
 
}
 
 
if (
  memoryKey.includes(
    "has_daughter"
  )
  ||
  memoryValue.has_daughter === true
  ||
  memoryValue.daughter === true
) {
 
  return "daughter";
 
}
 
 
if (
  memoryKey.includes(
    "has_children"
  )
  ||
  memoryValue.has_children === true
  ||
  Number(
    memoryValue.child_count
  ) > 0
  ||
  Number(
    memoryValue.count
  ) > 0
) {
 
  return "children";
 
}
 
 
return null;
 
}
 
 
/* ==================================================
 DETERMINISTISCHER WIDERSPRUCH
================================================== */
 
async function detectDeterministicContradiction(
contactId,
item
) {
 
const newSignal =
  childSignalFromMemory(
 
    item?.category,
 
    item?.memory_key,
 
    item?.memory_value
 
  );
 
 
if (!newSignal) {
  return null;
}
 
 
const active =
  (
    await getRelevantMemoryItems(
      contactId,
      200
    )
  )
    .filter(
      memory =>
        normalizeText(
          memory.category
        )
          .toLowerCase()
        ===
        "children"
    );
 
 
for (
  const existing
  of active
) {
 
  const value =
    existing.human_review_status
    ===
    "corrected"
    &&
    existing.human_corrected_value
 
      ? existing.human_corrected_value
 
      : existing.memory_value;
 
 
  const oldSignal =
    childSignalFromMemory(
 
      existing.category,
 
      existing.memory_key,
 
      value
 
    );
 
 
  const conflict =
    (
      newSignal === "none"
      &&
      [
        "son",
        "daughter",
        "children"
      ].includes(
        oldSignal
      )
    )
    ||
    (
      oldSignal === "none"
      &&
      [
        "son",
        "daughter",
        "children"
      ].includes(
        newSignal
      )
    );
 
 
  if (conflict) {
    return existing;
  }
 
}
 
 
return null;
 
}
 
 
/* ==================================================
 CONTRADICTION EVENT
================================================== */
 
async function createContradictionEvent({
contactId,
existingItem,
proposedItem,
incomingMessageDbId,
incomingText
}) {
 
await pool.query(
  `
    INSERT INTO memory_events (
 
      contact_id,
 
      event_type,
 
      event_subtype,
 
      title,
 
      event_data,
 
      event_status,
 
      importance,
 
      sensitivity,
 
      source_message_ids,
 
      evidence_summary,
 
      marcel_review_required
 
    )
 
    VALUES (
 
      $1,
 
      'possible_contradiction',
 
      'deterministic_fact_conflict',
 
      'Möglicher Widerspruch',
 
      $2::jsonb,
 
      'active',
 
      4,
 
      'personal',
 
      $3::jsonb,
 
      $4,
 
      TRUE
 
    )
  `,
  [
    contactId,
 
    JSON.stringify({
 
      existing_memory_id:
        existingItem.id,
 
      existing_fact: {
 
        category:
          existingItem.category,
 
        memory_key:
          existingItem.memory_key,
 
        memory_value:
          existingItem.memory_value
 
      },
 
      proposed_fact: {
 
        category:
          proposedItem.category,
 
        memory_key:
          proposedItem.memory_key,
 
        memory_value:
          proposedItem.memory_value
 
      }
 
    }),
 
    JSON.stringify(
      incomingMessageDbId
        ? [
            incomingMessageDbId
          ]
        : []
    ),
 
    normalizeText(
      incomingText
    )
    ||
    "Neue Aussage kollidiert mit bestehendem Fakt."
  ]
);
 
}
 
 
/* ==================================================
 MEMORY ITEMS ANWENDEN
================================================== */
 
async function applyMemoryItems(
contactId,
items,
sourceId,
incomingText = ""
) {
 
if (
  !Array.isArray(
    items
  )
) {
 
  return;
 
}
 
 
for (
  const item
  of items.slice(
    0,
    25
  )
) {
 
  const category =
    normalizeText(
      item?.category
    );
 
 
  const key =
    normalizeText(
      item?.memory_key
    );
 
 
  if (
    !category
    ||
    !key
  ) {
 
    continue;
 
  }
 
 
  const contradiction =
    await detectDeterministicContradiction(
      contactId,
      item
    );
 
 
  if (contradiction) {
 
    await createContradictionEvent({
 
      contactId,
 
      existingItem:
        contradiction,
 
      proposedItem:
        item,
 
      incomingMessageDbId:
        sourceId,
 
      incomingText
 
    });
 
 
    continue;
 
  }
 
 
  const existing =
    await findSimilarActiveMemory(
      contactId,
      category,
      key
    );
 
 
  if (
    existing
    &&
    [
      "confirmed",
      "corrected"
    ].includes(
      existing.human_review_status
    )
  ) {
 
    continue;
 
  }
 
 
  const memoryType =
    [
      "self_reported",
      "explicit_fact",
      "observed_pattern",
      "interpretation",
      "temporary_state"
    ].includes(
      item?.memory_type
    )
 
      ? item.memory_type
 
      : "interpretation";
 
 
  const value =
    item?.memory_value
    &&
    typeof item.memory_value
    ===
    "object"
    &&
    !Array.isArray(
      item.memory_value
    )
 
      ? item.memory_value
 
      : {
          value:
            item?.memory_value
            ??
            null
        };
 
 
  const confidence =
    clampConfidence(
      item?.confidence
    );
 
 
  const importance =
    clampImportance(
      item?.importance
    );
 
 
  const quote =
    normalizeText(
      item?.source_quote
    )
    ||
    null;
 
 
  if (existing) {
 
    if (
      renderJson(
        existing.memory_value
      )
      ===
      renderJson(
        value
      )
    ) {
 
      await pool.query(
        `
          UPDATE memory_items
 
          SET
            confidence =
              GREATEST(
                confidence,
                $2
              ),
 
            source_quote =
              COALESCE(
                $3,
                source_quote
              ),
 
            source_message_id =
              COALESCE(
                $4,
                source_message_id
              ),
 
            importance =
              GREATEST(
                importance,
                $5
              ),
 
            updated_at =
              NOW()
 
          WHERE id =
            $1
        `,
        [
          existing.id,
          confidence,
          quote,
          sourceId || null,
          importance
        ]
      );
 
 
      continue;
 
    }
 
 
    await pool.query(
      `
        UPDATE memory_items
 
        SET
          status =
            'superseded',
 
          valid_until =
            NOW(),
 
          updated_at =
            NOW()
 
        WHERE id =
          $1
      `,
      [
        existing.id
      ]
    );
 
  }
 
 
  const validUntilHours =
    item?.valid_until_hours
    == null
 
      ? null
 
      : Number(
          item.valid_until_hours
        );
 
 
  await pool.query(
    `
      INSERT INTO memory_items (
 
        contact_id,
 
        category,
 
        memory_key,
 
        memory_value,
 
        memory_type,
 
        confidence,
 
        source_message_id,
 
        source_quote,
 
        valid_from,
 
        valid_until,
 
        supersedes_memory_id,
 
        importance,
 
        use_in_reply
 
      )
 
      VALUES (
 
        $1,
 
        $2,
 
        $3,
 
        $4::jsonb,
 
        $5,
 
        $6,
 
        $7,
 
        $8,
 
        NOW(),
 
        CASE
 
          WHEN $9::double precision
            IS NULL
 
          THEN NULL
 
          ELSE
 
            NOW()
 
            +
 
            (
              $9::text
              ||
              ' hours'
            )::interval
 
        END,
 
        $10,
 
        $11,
 
        $12
 
      )
    `,
    [
      contactId,
      category,
      key,
      JSON.stringify(
        value
      ),
      memoryType,
      confidence,
      sourceId || null,
      quote,
      Number.isFinite(
        validUntilHours
      )
        ? validUntilHours
        : null,
      existing?.id || null,
      importance,
      item?.use_in_reply !== false
    ]
  );
 
}
 
}
 
 
/* ==================================================
 MEMORY EVENTS ANWENDEN
================================================== */
 
async function applyMemoryEvents(
contactId,
events,
sourceId
) {
 
if (
  !Array.isArray(
    events
  )
) {
 
  return;
 
}
 
 
for (
  const event
  of events.slice(
    0,
    20
  )
) {
 
  const eventType =
    normalizeText(
      event?.event_type
    );
 
 
  if (!eventType) {
    continue;
  }
 
 
  await pool.query(
    `
      INSERT INTO memory_events (
 
        contact_id,
 
        event_type,
 
        event_subtype,
 
        title,
 
        event_data,
 
        event_status,
 
        importance,
 
        sensitivity,
 
        source_message_ids,
 
        evidence_summary,
 
        requires_follow_up,
 
        follow_up_status,
 
        bot_action,
 
        marcel_review_required
 
      )
 
      VALUES (
 
        $1,
 
        $2,
 
        $3,
 
        $4,
 
        $5::jsonb,
 
        'active',
 
        $6,
 
        $7,
 
        $8::jsonb,
 
        $9,
 
        $10,
 
        CASE
 
          WHEN $10 =
            TRUE
 
          THEN 'pending'
 
          ELSE 'none'
 
        END,
 
        $11,
 
        $12
 
      )
    `,
    [
      contactId,
      eventType,
      normalizeText(
        event?.event_subtype
      )
      ||
      null,
      normalizeText(
        event?.title
      )
      ||
      null,
      JSON.stringify(
        event?.event_data
        &&
        typeof event.event_data
        ===
        "object"
 
          ? event.event_data
 
          : {}
      ),
      clampImportance(
        event?.importance
      ),
      [
        "normal",
        "personal",
        "intimate"
      ].includes(
        event?.sensitivity
      )
        ? event.sensitivity
        : "normal",
      JSON.stringify(
        sourceId
          ? [
              sourceId
            ]
          : []
      ),
      normalizeText(
        event?.evidence_summary
      )
      ||
      null,
      event?.requires_follow_up
      ===
      true,
      normalizeText(
        event?.bot_action
      )
      ||
      null,
      event?.marcel_review_required
      ===
      true
    ]
  );
 
}
 
}
 
 
/* ==================================================
 MEMORY EXTRACTOR
================================================== */
 
async function extractMemoryUpdates({
jid,
contactId,
incomingText,
incomingMessageDbId,
outgoingText,
outgoingMessageDbId
}) {
 
const [
  history,
  profile,
  items,
  events,
  liveState
] =
  await Promise.all([
 
    getConversationHistory(
      jid
    ),
 
    getContactMemoryProfile(
      contactId
    ),
 
    getRelevantMemoryItems(
      contactId,
      100
    ),
 
    getRelevantMemoryEvents(
      contactId,
      50
    ),
 
    getMarcelLiveState()
 
  ]);
 
 
const memoryText =
  items
    .map(
      item =>
        `ID=${item.id}`
        +
        `|${item.category}.${item.memory_key}`
        +
        `|review=${item.human_review_status}`
        +
        `|${renderJson(
          item.human_review_status
          ===
          "corrected"
          &&
          item.human_corrected_value
 
            ? item.human_corrected_value
 
            : item.memory_value
        )}`
    )
    .join("\n");
 
 
const response =
  await openai.responses.create({
 
    model:
      MODEL,
 
 
    instructions: `
Du bist Memory-Extractor.
 
Antworte nicht der Frau.
 
Neue Fakten erkennen.
 
Alte Fakten nicht neu speichern.
 
Temporäre Zustände sauber ersetzen.
 
Widersprüche nicht blind überschreiben.
 
Human confirmed/corrected Memory
niemals überschreiben oder retiren.
 
Gleichnamige Frauen nie vermischen.
 
Dani != Daniela Messe != Dángela.
 
Kate Castillo != alte Kathe.
 
Paola Maza != ältere Paola.
 
Karla Tinder != Karla Instagram.
 
Frau,
Marcel
und Dritte
strikt trennen.
 
marcel_knowledge_map
nur für Wissen dieser Frau über Marcel.
 
Wenn die Frau überwiegend
in einer bestimmten Sprache schreibt
und das für zukünftige Antworten
relevant ist,
darf diese Information
im Bereich communication
gespeichert werden.
 
WICHTIG:
 
Progressive Disclosure
ist eine Antwortregel
und verändert NICHT,
wie vollständig Memory
intern gespeichert werden darf.
 
Der Extractor darf also
weiterhin genaue Fakten speichern.
 
Nur der Reply-Bot
darf nicht automatisch
alle gespeicherten Details
in einer Antwort preisgeben.
 
Gib ausschließlich JSON:
 
{
"retire_item_ids": [],
"items": [],
"events": [],
"profile_snapshot": {
  ${PROFILE_COLUMNS
    .map(
      column =>
        `"${column}": {}`
    )
    .join(",")}
}
}
`,
 
 
    input: `
==================================================
LIVE STATE
==================================================
 
${renderJson(
liveState
)}
 
 
==================================================
BISHERIGES PROFIL
==================================================
 
${renderJson(
profile || {}
)}
 
 
==================================================
AKTIVE MEMORIES
==================================================
 
${memoryText || "[keine]"}
 
 
==================================================
VERLAUF
==================================================
 
${history
.slice(
  -20
)
.map(
  item =>
    `${item.direction === "incoming" ? "Sie" : "Marcel"}: ${item.message_text}`
)
.join("\n")}
 
 
==================================================
NEU SIE
==================================================
 
${incomingText}
 
 
==================================================
MARCEL ANTWORT
==================================================
 
${outgoingText}
 
 
==================================================
AUFGABE
==================================================
 
Aktualisiere Memory.
`
  });
 
 
const emptySnapshot =
  Object.fromEntries(
    PROFILE_COLUMNS.map(
      column => [
        column,
        {}
      ]
    )
  );
 
 
const parsed =
  safeJsonParse(
    response.output_text,
    {
      retire_item_ids: [],
      items: [],
      events: [],
      profile_snapshot:
        emptySnapshot
    }
  );
 
 
if (
  !parsed
  ||
  typeof parsed !== "object"
) {
 
  return;
 
}
 
 
await retireMemoryItems(
  contactId,
  parsed.retire_item_ids || []
);
 
 
await applyMemoryItems(
  contactId,
  parsed.items || [],
  incomingMessageDbId,
  incomingText
);
 
 
await applyMemoryEvents(
  contactId,
  parsed.events || [],
  incomingMessageDbId
);
 
 
await applyProfileSnapshot(
  contactId,
  parsed.profile_snapshot
  ||
  emptySnapshot
);
 
 
console.log(
  "Langzeit-Memory V1.7.2 aktualisiert."
);
 
}
 
 
/* ==================================================
 MEMORY UPDATE ASYNCHRON
================================================== */
 
function scheduleMemoryUpdate(
payload
) {
 
setTimeout(
  () => {
 
    extractMemoryUpdates(
      payload
    )
      .catch(
        error =>
          console.error(
            "Memory-Update fehlgeschlagen:",
            error
          )
      );
 
  },
  250
);
 
}
 
 
/* ==================================================
 TEST PASSWORT
================================================== */
 
function personaPasswordCorrect(
password
) {
 
const expected =
  process.env
    .PERSONA_TEST_PASSWORD;
 
 
return (
  !!expected
  &&
  password === expected
);
 
}
 
 
/* ==================================================
 TEST SNAPSHOT
================================================== */
 
async function getTestContactSnapshot(
jid
) {
 
const contact =
  await getContactByJid(
    jid
  );
 
 
if (!contact) {
  return null;
}
 
 
const [
  history,
  profile,
  activeItems,
  historicalItems,
  events,
  liveState
] =
  await Promise.all([
 
    getConversationHistory(
      jid
    ),
 
    getContactMemoryProfile(
      contact.id
    ),
 
    getRelevantMemoryItems(
      contact.id,
      250
    ),
 
    getHistoricalMemoryItems(
      contact.id,
      250
    ),
 
    getAllMemoryEvents(
      contact.id,
      200
    ),
 
    getMarcelLiveState()
 
  ]);
 
 
return {
 
  contact,
 
  history,
 
  profile,
 
  activeItems,
 
  historicalItems,
 
  events,
 
  liveState
 
};
 
}
 
 
/* ==================================================
 DASHBOARD API AUTH
 READ ONLY V0.2
================================================== */
 
function dashboardApiAuthorized(
req
) {
 
const expectedSecret =
  normalizeText(
    process.env.DASHBOARD_API_SECRET
  );
 
 
if (!expectedSecret) {
  return false;
}
 
 
const authorization =
  normalizeText(
    req.headers.authorization
  );
 
 
if (
  !authorization.startsWith(
    "Bearer "
  )
) {
 
  return false;
 
}
 
 
const receivedSecret =
  normalizeText(
    authorization.slice(
      "Bearer ".length
    )
  );
 
 
if (!receivedSecret) {
  return false;
}
 
 
const expectedBuffer =
  Buffer.from(
    expectedSecret,
    "utf8"
  );
 
 
const receivedBuffer =
  Buffer.from(
    receivedSecret,
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
 
 
function dashboardApiReady(
res
) {
 
if (
  !process.env.DASHBOARD_API_SECRET
) {
 
  console.error(
    "DASHBOARD_API_SECRET fehlt in Railway."
  );
 
 
  res
    .status(500)
    .json({
 
      ok:
        false,
 
      error:
        "Dashboard-API ist nicht konfiguriert."
 
    });
 
 
  return false;
 
}
 
 
return true;
 
}
 
 
/* ==================================================
 DASHBOARD KONTAKTLISTE
 READ ONLY
================================================== */
 
app.get(
"/dashboard-api/contacts",
async (req, res) => {
 
  try {
 
    if (
      !dashboardApiReady(
        res
      )
    ) {
 
      return;
 
    }
 
 
    if (
      !dashboardApiAuthorized(
        req
      )
    ) {
 
      return res
        .status(401)
        .json({
 
          ok:
            false,
 
          error:
            "Nicht autorisiert."
 
        });
 
    }
 
 
    const result =
      await pool.query(
        `
          SELECT
 
            c.id,
 
            c.whatsapp_jid,
 
            c.phone_number,
 
            c.display_name,
 
            c.nickname,
 
            c.canonical_name,
 
            c.whatsapp_display_name,
 
            c.country,
 
            c.city,
 
            c.timezone,
 
            c.primary_language,
 
            c.source_platform,
 
            c.current_platform,
 
            c.platform_status,
 
            c.contact_status,
 
            c.relationship_stage,
 
            c.auto_reply_enabled,
 
            c.date_lock_enabled,
 
            c.manual_review_required,
 
            c.first_contact_at,
 
            c.last_message_at,
 
            c.memory_identity_key,
 
            c.identity_locked,
 
            c.created_at,
 
            c.updated_at,
 
            last_message.id
              AS last_message_id,
 
            last_message.direction
              AS last_message_direction,
 
            last_message.message_text
              AS last_message_text,
 
            last_message.is_edited
              AS last_message_is_edited,
 
            last_message.created_at
              AS last_message_created_at,
 
            (
              SELECT COUNT(*)
 
              FROM memory_items mi
 
              WHERE mi.contact_id =
                c.id
 
                AND mi.status =
                  'active'
 
                AND mi.human_review_status
                  <> 'rejected'
            )::integer
              AS active_memory_count,
 
            (
              SELECT COUNT(*)
 
              FROM memory_items mi
 
              WHERE mi.contact_id =
                c.id
 
                AND mi.status
                  <> 'active'
            )::integer
              AS historical_memory_count,
 
            (
              SELECT COUNT(*)
 
              FROM memory_events me
 
              WHERE me.contact_id =
                c.id
            )::integer
              AS event_count,
 
            (
              SELECT COUNT(*)
 
              FROM memory_events me
 
              WHERE me.contact_id =
                c.id
 
                AND me.marcel_review_required =
                  TRUE
 
                AND me.event_status IN (
                  'active',
                  'open'
                )
            )::integer
              AS review_required_count
 
          FROM contacts c
 
 
          LEFT JOIN LATERAL (
 
            SELECT
 
              m.id,
 
              m.direction,
 
              m.message_text,
 
              m.is_edited,
 
              m.created_at
 
            FROM messages m
 
            WHERE m.whatsapp_jid =
              c.whatsapp_jid
 
              AND m.message_text
                IS NOT NULL
 
            ORDER BY
              m.id DESC
 
            LIMIT 1
 
          ) last_message
            ON TRUE
 
 
          WHERE c.whatsapp_jid
            NOT LIKE '%@persona.test'
 
 
          ORDER BY
 
            COALESCE(
              last_message.created_at,
              c.last_message_at,
              c.updated_at,
              c.created_at
            )
            DESC,
 
            COALESCE(
              c.canonical_name,
              c.display_name,
              c.whatsapp_display_name,
              c.whatsapp_jid
            )
            ASC
        `
      );
 
 
    const contacts =
      result.rows.map(
        contact => {
 
          const isProfileOnly =
            isProfileJid(
              contact.whatsapp_jid
            );
 
 
          return {
 
            id:
              contact.id,
 
            jid:
              contact.whatsapp_jid,
 
            phoneNumber:
              contact.phone_number,
 
            name:
              contact.canonical_name
              ||
              contact.display_name
              ||
              contact.whatsapp_display_name
              ||
              "Unbekannter Kontakt",
 
            displayName:
              contact.display_name,
 
            whatsappDisplayName:
              contact.whatsapp_display_name,
 
            nickname:
              contact.nickname,
 
            city:
              contact.city,
 
            country:
              contact.country,
 
            timezone:
              contact.timezone,
 
            language:
              contact.primary_language,
 
            sourcePlatform:
              contact.source_platform,
 
            currentPlatform:
              contact.current_platform,
 
            platformStatus:
              contact.platform_status,
 
            contactStatus:
              contact.contact_status,
 
            relationshipStage:
              contact.relationship_stage,
 
            autoReply:
              contact.auto_reply_enabled
              !==
              false,
 
            dateLock:
              contact.date_lock_enabled
              ===
              true,
 
            manualReviewRequired:
              contact.manual_review_required
              ===
              true,
 
            identityKey:
              contact.memory_identity_key,
 
            identityLocked:
              contact.identity_locked
              ===
              true,
 
            profileOnly:
              isProfileOnly,
 
            firstContactAt:
              contact.first_contact_at,
 
            lastMessageAt:
              contact.last_message_created_at
              ||
              contact.last_message_at,
 
            createdAt:
              contact.created_at,
 
            updatedAt:
              contact.updated_at,
 
            lastMessage:
              contact.last_message_text
                ? {
 
                    id:
                      contact.last_message_id,
 
                    direction:
                      contact.last_message_direction,
 
                    text:
                      contact.last_message_text,
 
                    edited:
                      contact.last_message_is_edited
                      ===
                      true,
 
                    createdAt:
                      contact.last_message_created_at
 
                  }
                : null,
 
            memoryStatus: {
 
              active:
                Number(
                  contact.active_memory_count
                  ||
                  0
                ),
 
              historical:
                Number(
                  contact.historical_memory_count
                  ||
                  0
                ),
 
              events:
                Number(
                  contact.event_count
                  ||
                  0
                ),
 
              reviewRequired:
                Number(
                  contact.review_required_count
                  ||
                  0
                )
 
            }
 
          };
 
        }
      );
 
 
    return res.json({
 
      ok:
        true,
 
      readOnly:
        true,
 
      count:
        contacts.length,
 
      contacts
 
    });
 
 
  } catch (error) {
 
    console.error(
      "Dashboard Kontakte Fehler:",
      error
    );
 
 
    return res
      .status(500)
      .json({
 
        ok:
          false,
 
        error:
          "Dashboard-Kontakte konnten nicht geladen werden."
 
      });
 
  }
 
}
);
 
 
/* ==================================================
 DASHBOARD EINZELKONTAKT
 CHAT + PROFIL + MEMORY + EVENTS
 READ ONLY V0.2
================================================== */
 
app.get(
"/dashboard-api/contacts/:id",
async (req, res) => {
 
  try {
 
    if (
      !dashboardApiReady(
        res
      )
    ) {
 
      return;
 
    }
 
 
    if (
      !dashboardApiAuthorized(
        req
      )
    ) {
 
      return res
        .status(401)
        .json({
 
          ok:
            false,
 
          error:
            "Nicht autorisiert."
 
        });
 
    }
 
 
    const contactId =
      Number(
        req.params.id
      );
 
 
    if (
      !Number.isInteger(
        contactId
      )
      ||
      contactId <= 0
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
 
 
    const contact =
      await getContactById(
        contactId
      );
 
 
    if (
      !contact
    ) {
 
      return res
        .status(404)
        .json({
 
          ok:
            false,
 
          error:
            "Kontakt nicht gefunden."
 
        });
 
    }
 
 
    if (
      isTestJid(
        contact.whatsapp_jid
      )
    ) {
 
      return res
        .status(404)
        .json({
 
          ok:
            false,
 
          error:
            "Kontakt nicht gefunden."
 
        });
 
    }
 
 
    const [
      messages,
      totalMessages,
      profile,
      activeItems,
      historicalItems,
      events
    ] =
      await Promise.all([
 
        getDashboardConversationHistory(
          contact.whatsapp_jid,
          200
        ),
 
        getDashboardMessageCount(
          contact.whatsapp_jid
        ),
 
        getContactMemoryProfile(
          contact.id
        ),
 
        getRelevantMemoryItems(
          contact.id,
          250
        ),
 
        getHistoricalMemoryItems(
          contact.id,
          250
        ),
 
        getAllMemoryEvents(
          contact.id,
          200
        )
 
      ]);
 
 
    const cleanProfile =
      profile
 
        ? Object.fromEntries(
            PROFILE_COLUMNS.map(
              column => [
                column,
                profile[column] || {}
              ]
            )
          )
 
        : Object.fromEntries(
            PROFILE_COLUMNS.map(
              column => [
                column,
                {}
              ]
            )
          );
 
 
    const profileSummary =
      cleanProfile.profile_summary
      &&
      typeof cleanProfile.profile_summary
      ===
      "object"
 
        ? cleanProfile.profile_summary
 
        : {};
 
 
    const memoryStatus = {
 
      active:
        activeItems.length,
 
      historical:
        historicalItems.length,
 
      events:
        events.length,
 
      reviewRequired:
        events.filter(
          event =>
            event.marcel_review_required
            ===
            true
            &&
            [
              "active",
              "open"
            ].includes(
              event.event_status
            )
        ).length
 
    };
 
 
    const normalizedActiveItems =
      activeItems.map(
        item => ({
 
          id:
            item.id,
 
          category:
            item.category,
 
          key:
            item.memory_key,
 
          value:
            item.human_review_status
            ===
            "corrected"
            &&
            item.human_corrected_value
 
              ? item.human_corrected_value
 
              : item.memory_value,
 
          originalValue:
            item.memory_value,
 
          memoryType:
            item.memory_type,
 
          confidence:
            item.confidence == null
              ? null
              : Number(
                  item.confidence
                ),
 
          reviewStatus:
            item.human_review_status,
 
          humanCorrectedValue:
            item.human_corrected_value,
 
          humanNote:
            item.human_note,
 
          importance:
            Number(
              item.importance
              ||
              0
            ),
 
          sourceQuote:
            item.source_quote,
 
          validFrom:
            item.valid_from,
 
          validUntil:
            item.valid_until,
 
          useInReply:
            item.use_in_reply
            !==
            false,
 
          createdAt:
            item.created_at,
 
          updatedAt:
            item.updated_at
 
        })
      );
 
 
    const normalizedHistoricalItems =
      historicalItems.map(
        item => ({
 
          id:
            item.id,
 
          category:
            item.category,
 
          key:
            item.memory_key,
 
          value:
            item.human_review_status
            ===
            "corrected"
            &&
            item.human_corrected_value
 
              ? item.human_corrected_value
 
              : item.memory_value,
 
          originalValue:
            item.memory_value,
 
          memoryType:
            item.memory_type,
 
          confidence:
            item.confidence == null
              ? null
              : Number(
                  item.confidence
                ),
 
          status:
            item.status,
 
          reviewStatus:
            item.human_review_status,
 
          humanCorrectedValue:
            item.human_corrected_value,
 
          humanNote:
            item.human_note,
 
          importance:
            Number(
              item.importance
              ||
              0
            ),
 
          sourceQuote:
            item.source_quote,
 
          validFrom:
            item.valid_from,
 
          validUntil:
            item.valid_until,
 
          supersedesMemoryId:
            item.supersedes_memory_id,
 
          createdAt:
            item.created_at,
 
          updatedAt:
            item.updated_at
 
        })
      );
 
 
    const normalizedEvents =
      events.map(
        event => ({
 
          id:
            event.id,
 
          type:
            event.event_type,
 
          subtype:
            event.event_subtype,
 
          title:
            event.title,
 
          data:
            event.event_data,
 
          status:
            event.event_status,
 
          importance:
            Number(
              event.importance
              ||
              0
            ),
 
          sensitivity:
            event.sensitivity,
 
          startedAt:
            event.started_at,
 
          endedAt:
            event.ended_at,
 
          evidenceSummary:
            event.evidence_summary,
 
          sourceMessageIds:
            event.source_message_ids,
 
          relatedMemoryItemIds:
            event.related_memory_item_ids,
 
          relatedEventId:
            event.related_event_id,
 
          requiresFollowUp:
            event.requires_follow_up
            ===
            true,
 
          followUpAfter:
            event.follow_up_after,
 
          followUpStatus:
            event.follow_up_status,
 
          botAction:
            event.bot_action,
 
          marcelReviewRequired:
            event.marcel_review_required
            ===
            true,
 
          createdAt:
            event.created_at,
 
          updatedAt:
            event.updated_at
 
        })
      );
 
 
    return res.json({
 
      ok:
        true,
 
      readOnly:
        true,
 
      totalMessages:
        totalMessages,
 
      contact: {
 
        id:
          contact.id,
 
        jid:
          contact.whatsapp_jid,
 
        phoneNumber:
          contact.phone_number,
 
        name:
          contact.canonical_name
          ||
          contact.display_name
          ||
          contact.whatsapp_display_name
          ||
          "Unbekannter Kontakt",
 
        displayName:
          contact.display_name,
 
        whatsappDisplayName:
          contact.whatsapp_display_name,
 
        nickname:
          contact.nickname,
 
        city:
          contact.city,
 
        country:
          contact.country,
 
        timezone:
          contact.timezone,
 
        language:
          contact.primary_language,
 
        sourcePlatform:
          contact.source_platform,
 
        sourceProfileName:
          contact.source_profile_name,
 
        currentPlatform:
          contact.current_platform,
 
        platformStatus:
          contact.platform_status,
 
        contactStatus:
          contact.contact_status,
 
        relationshipStage:
          contact.relationship_stage,
 
        autoReply:
          contact.auto_reply_enabled
          !==
          false,
 
        dateLock:
          contact.date_lock_enabled
          ===
          true,
 
        manualReviewRequired:
          contact.manual_review_required
          ===
          true,
 
        locationContext:
          contact.location_context
          ||
          {},
 
        relocationContext:
          contact.relocation_context
          ||
          {},
 
        identityKey:
          contact.memory_identity_key,
 
        identityLocked:
          contact.identity_locked
          ===
          true,
 
        profileOnly:
          isProfileJid(
            contact.whatsapp_jid
          ),
 
        firstContactAt:
          contact.first_contact_at,
 
        lastMessageAt:
          contact.last_message_at,
 
        createdAt:
          contact.created_at,
 
        updatedAt:
          contact.updated_at,
 
        age:
          profileSummary.age
          ??
          null,
 
        profession:
          profileSummary.profession
          ??
          null
 
      },
 
      messages,
 
      profile:
        cleanProfile,
 
      activeItems:
        normalizedActiveItems,
 
      historicalItems:
        normalizedHistoricalItems,
 
      events:
        normalizedEvents,
 
      memoryStatus
 
    });
 
 
  } catch (error) {
 
    console.error(
      "Dashboard Einzelkontakt Fehler:",
      error
    );
 
 
    return res
      .status(500)
      .json({
 
        ok:
          false,
 
        error:
          "Dashboard-Kontakt konnte nicht geladen werden."
 
      });
 
  }
 
}
);
 
 
/* ==================================================
 STARTSEITE
================================================== */
 
app.get(
"/",
(req, res) => {
 
  res.send(
    `Marcel WhatsApp Bot V1.7.2 läuft. WhatsApp-Status: ${whatsappStatus}`
  );
 
}
);
 
 
/* ==================================================
 DB TEST
================================================== */
 
app.get(
"/db-test",
async (req, res) => {
 
  try {
 
    const result =
      await pool.query(
        "SELECT NOW() AS server_time"
      );
 
 
    res.json({
 
      ok:
        true,
 
      serverTime:
        result.rows[0]
          .server_time
 
    });
 
 
  } catch (error) {
 
    console.error(
      "DB-Test Fehler:",
      error
    );
 
 
    res
      .status(500)
      .json({
 
        ok:
          false,
 
        error:
          "Datenbankverbindung fehlgeschlagen"
 
      });
 
  }
 
}
);
 
 
/* ==================================================
 MEMORY STATUS
================================================== */
 
app.get(
"/memory-status",
async (req, res) => {
 
  try {
 
    const result =
      await pool.query(
        `
          SELECT
 
            (
              SELECT COUNT(*)
              FROM contacts
            )
            AS contacts,
 
            (
              SELECT COUNT(*)
              FROM messages
            )
            AS messages,
 
            (
              SELECT COUNT(*)
              FROM memory_items
            )
            AS memory_items,
 
            (
              SELECT COUNT(*)
              FROM memory_items
              WHERE status = 'active'
            )
            AS active_memory_items,
 
            (
              SELECT COUNT(*)
              FROM memory_events
            )
            AS memory_events,
 
            (
              SELECT COUNT(*)
              FROM contacts
              WHERE memory_identity_key
                IS NOT NULL
            )
            AS women_registry_contacts
        `
      );
 
 
    res.json({
 
      ok:
        true,
 
      ...result.rows[0]
 
    });
 
 
  } catch (error) {
 
    console.error(
      "Memory-Status Fehler:",
      error
    );
 
 
    res
      .status(500)
      .json({
 
        ok:
          false,
 
        error:
          "Memory-Status konnte nicht geladen werden."
 
      });
 
  }
 
}
);
 
 
/* ==================================================
 PAIRING CODE
================================================== */
 
app.get(
"/pairing-code",
(req, res) => {
 
  if (
    !WHATSAPP_ENABLED
  ) {
 
    return res.send(
      "WhatsApp ist deaktiviert. Kein Pairing, kein Socket, kein Reconnect."
    );
 
  }
 
 
  if (pairingCode) {
 
    return res.send(
      `Pairing Code: ${pairingCode}`
    );
 
  }
 
 
  res.send(
    "Noch kein Pairing-Code verfügbar."
  );
 
}
);
 
 
/* ==================================================
 PERSONA TEST UI
================================================== */
 
app.get(
"/persona-test",
(req, res) => {
 
  res.send(
`<!doctype html>
 
<html lang="de">
 
<head>
 
<meta charset="utf-8">
 
<meta
name="viewport"
content="width=device-width,initial-scale=1,viewport-fit=cover"
>
 
<title>
Marcel Memory Test V1.7.2
</title>
 
<style>
 
*{
box-sizing:border-box;
}
 
body{
font-family:
  -apple-system,
  BlinkMacSystemFont,
  "Segoe UI",
  Arial,
  sans-serif;
 
background:#111;
color:#fff;
 
max-width:850px;
 
margin:0 auto;
padding:20px;
}
 
h1{
font-size:34px;
line-height:1.1;
margin:20px 0 24px;
}
 
p{
line-height:1.45;
}
 
input,
button,
select,
textarea,
pre{
width:100%;
padding:14px;
margin:7px 0;
border:0;
border-radius:12px;
box-sizing:border-box;
font-size:16px;
}
 
input,
select,
textarea,
pre{
background:#222;
color:#fff;
}
 
textarea{
min-height:110px;
resize:vertical;
}
 
button{
background:#f4f4f4;
color:#1677ff;
font-weight:700;
cursor:pointer;
-webkit-appearance:none;
appearance:none;
}
 
button:disabled{
opacity:.5;
}
 
#chat{
margin-top:12px;
}
 
.msg{
padding:11px 12px;
margin:7px 0;
border-radius:12px;
white-space:pre-wrap;
word-break:break-word;
}
 
.her{
background:#333;
margin-right:12%;
}
 
.me{
background:#173b26;
margin-left:12%;
}
 
.speaker{
font-size:11px;
opacity:.65;
margin-bottom:4px;
}
 
.status{
min-height:24px;
margin:8px 0 2px;
font-size:14px;
line-height:1.35;
}
 
.status.ok{
color:#7fe08a;
}
 
.status.error{
color:#ff7b7b;
}
 
.status.loading{
color:#9abfff;
}
 
pre{
white-space:pre-wrap;
word-break:break-word;
min-height:80px;
}
 
.section-title{
font-size:18px;
font-weight:700;
margin-top:22px;
}
 
.muted{
color:#aaa;
font-size:13px;
}
 
</style>
 
</head>
 
 
<body>
 
 
<h1>
Marcel Memory Test V1.7.2
</h1>
 
 
<p>
WhatsApp bleibt bei WHATSAPP_ENABLED=false komplett aus.
</p>
 
 
<input
id="passwordInput"
type="password"
placeholder="Passwort"
autocomplete="current-password"
>
 
 
<button
id="loadContactsButton"
type="button"
>
Testkontakte laden
</button>
 
 
<div
id="globalStatus"
class="status"
></div>
 
 
<select id="contactsSelect">
 
<option value="">
  -- auswählen --
</option>
 
</select>
 
 
<input
id="newContactNameInput"
type="text"
placeholder="Neue Testfrau"
autocomplete="off"
>
 
 
<button
id="createContactButton"
type="button"
>
Anlegen
</button>
 
 
<div
id="createStatus"
class="status"
></div>
 
 
<div
id="chat"
></div>
 
 
<textarea
id="messageInput"
placeholder="Ihre Nachricht"
></textarea>
 
 
<button
id="sendMessageButton"
type="button"
>
Testen
</button>
 
 
<div
id="sendStatus"
class="status"
></div>
 
 
<div class="section-title">
Memory / Profil
</div>
 
 
<pre id="outputBox"></pre>
 
 
<script>
 
(function(){
 
"use strict";
 
 
const passwordInput =
  document.getElementById(
    "passwordInput"
  );
 
 
const loadContactsButton =
  document.getElementById(
    "loadContactsButton"
  );
 
 
const contactsSelect =
  document.getElementById(
    "contactsSelect"
  );
 
 
const newContactNameInput =
  document.getElementById(
    "newContactNameInput"
  );
 
 
const createContactButton =
  document.getElementById(
    "createContactButton"
  );
 
 
const chatElement =
  document.getElementById(
    "chat"
  );
 
 
const messageInput =
  document.getElementById(
    "messageInput"
  );
 
 
const sendMessageButton =
  document.getElementById(
    "sendMessageButton"
  );
 
 
const outputBox =
  document.getElementById(
    "outputBox"
  );
 
 
const globalStatus =
  document.getElementById(
    "globalStatus"
  );
 
 
const createStatus =
  document.getElementById(
    "createStatus"
  );
 
 
const sendStatus =
  document.getElementById(
    "sendStatus"
  );
 
 
function getPassword(){
 
  return String(
    passwordInput.value || ""
  );
 
}
 
 
function setStatus(
  element,
  text,
  type = ""
){
 
  element.textContent =
    text || "";
 
 
  element.className =
    "status"
    +
    (
      type
        ? " " + type
        : ""
    );
 
}
 
 
function escapeHtml(value){
 
  return String(
    value ?? ""
  )
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );
 
}
 
 
async function apiRequest(
  url,
  options = {}
){
 
  let response;
 
 
  try{
 
    response =
      await fetch(
        url,
        options
      );
 
  }catch(error){
 
    throw new Error(
      "Server nicht erreichbar: "
      +
      (
        error?.message
        ||
        "Netzwerkfehler"
      )
    );
 
  }
 
 
  const rawText =
    await response.text();
 
 
  let data;
 
 
  try{
 
    data =
      rawText
        ? JSON.parse(
            rawText
          )
        : {};
 
  }catch{
 
    throw new Error(
      rawText
      ||
      "Ungültige Serverantwort."
    );
 
  }
 
 
  if(
    !response.ok
  ){
 
    throw new Error(
      data?.error
      ||
      "Serverfehler"
    );
 
  }
 
 
  return data;
 
}
 
 
function renderChat(
  history
){
 
  if(
    !Array.isArray(
      history
    )
    ||
    history.length === 0
  ){
 
    chatElement.innerHTML =
      '<div class="muted">Noch kein Testverlauf.</div>';
 
 
    return;
 
  }
 
 
  chatElement.innerHTML =
    history
      .map(
        item => {
 
          const incoming =
            item.direction
            ===
            "incoming";
 
 
          return (
            '<div class="msg '
            +
            (
              incoming
                ? "her"
                : "me"
            )
            +
            '">'
            +
            '<div class="speaker">'
            +
            (
              incoming
                ? "Sie"
                : "Marcel"
            )
            +
            (
              item.is_edited
                ? " · bearbeitet"
                : ""
            )
            +
            '</div>'
            +
            escapeHtml(
              item.message_text
            )
            +
            '</div>'
          );
 
        }
      )
      .join("");
 
}
 
 
function renderSnapshot(
  data,
  extra = {}
){
 
  renderChat(
    data?.history || []
  );
 
 
  outputBox.textContent =
    JSON.stringify(
      {
 
        ...extra,
 
        contact:
          data?.contact
          ||
          null,
 
        profile:
          data?.profile
          ||
          {},
 
        active:
          data?.activeItems
          ||
          [],
 
        historical:
          data?.historicalItems
          ||
          [],
 
        events:
          data?.events
          ||
          [],
 
        liveState:
          data?.liveState
          ||
          {}
 
      },
      null,
      2
    );
 
}
 
 
async function loadContacts(
  keepJid = null
){
 
  if(
    !getPassword()
  ){
 
    setStatus(
      globalStatus,
      "Bitte zuerst das Passwort eingeben.",
      "error"
    );
 
 
    return;
 
  }
 
 
  setStatus(
    globalStatus,
    "Testkontakte werden geladen ...",
    "loading"
  );
 
 
  loadContactsButton.disabled =
    true;
 
 
  try{
 
    const data =
      await apiRequest(
        "/persona-test/contacts",
        {
 
          method:
            "POST",
 
          headers:{
            "Content-Type":
              "application/json"
          },
 
          body:
            JSON.stringify({
              password:
                getPassword()
            })
 
        }
      );
 
 
    contactsSelect.innerHTML =
      '<option value="">-- auswählen --</option>';
 
 
    for(
      const contact
      of data.contacts || []
    ){
 
      const option =
        document.createElement(
          "option"
        );
 
 
      option.value =
        contact.whatsapp_jid;
 
 
      let label =
        contact.display_name
        ||
        contact.whatsapp_jid;
 
 
      if(
        contact.city
        ||
        contact.country
      ){
 
        label +=
          " · "
          +
          [
            contact.city,
            contact.country
          ]
            .filter(
              Boolean
            )
            .join(
              ", "
            );
 
      }
 
 
      option.textContent =
        label;
 
 
      contactsSelect.appendChild(
        option
      );
 
    }
 
 
    if(
      keepJid
    ){
 
      const exists =
        Array.from(
          contactsSelect.options
        )
        .some(
          option =>
            option.value
            ===
            keepJid
        );
 
 
      if(
        exists
      ){
 
        contactsSelect.value =
          keepJid;
 
 
        await loadSnapshot();
 
      }
 
    }
 
 
    setStatus(
      globalStatus,
      String(
        data.contacts?.length || 0
      )
      +
      " Testkontakt(e) geladen.",
      "ok"
    );
 
 
  }catch(error){
 
    console.error(
      error
    );
 
 
    setStatus(
      globalStatus,
      error.message,
      "error"
    );
 
 
  }finally{
 
    loadContactsButton.disabled =
      false;
 
  }
 
}
 
 
async function createNewTestContact(){
 
  const contactName =
    String(
      newContactNameInput.value
      ||
      ""
    )
      .trim();
 
 
  if(
    !getPassword()
  ){
 
    setStatus(
      createStatus,
      "Bitte zuerst das Passwort eingeben.",
      "error"
    );
 
 
    return;
 
  }
 
 
  if(
    !contactName
  ){
 
    setStatus(
      createStatus,
      "Bitte einen Namen eingeben.",
      "error"
    );
 
 
    return;
 
  }
 
 
  createContactButton.disabled =
    true;
 
 
  setStatus(
    createStatus,
    "Testkontakt wird angelegt ...",
    "loading"
  );
 
 
  try{
 
    const data =
      await apiRequest(
        "/persona-test/create-contact",
        {
 
          method:
            "POST",
 
          headers:{
            "Content-Type":
              "application/json"
          },
 
          body:
            JSON.stringify({
 
              password:
                getPassword(),
 
              name:
                contactName
 
            })
 
        }
      );
 
 
    if(
      !data?.contact?.whatsapp_jid
    ){
 
      throw new Error(
        "Der Server hat keine Testkontakt-ID zurückgegeben."
      );
 
    }
 
 
    const newJid =
      data.contact.whatsapp_jid;
 
 
    newContactNameInput.value =
      "";
 
 
    await loadContacts(
      newJid
    );
 
 
    setStatus(
      createStatus,
      "Testkontakt "
      +
      (
        data.contact.display_name
        ||
        contactName
      )
      +
      " wurde angelegt.",
      "ok"
    );
 
 
  }catch(error){
 
    console.error(
      error
    );
 
 
    setStatus(
      createStatus,
      error.message,
      "error"
    );
 
 
  }finally{
 
    createContactButton.disabled =
      false;
 
  }
 
}
 
 
async function loadSnapshot(){
 
  const jid =
    String(
      contactsSelect.value
      ||
      ""
    );
 
 
  if(
    !jid
  ){
 
    chatElement.innerHTML =
      '<div class="muted">Bitte einen Testkontakt auswählen.</div>';
 
 
    outputBox.textContent =
      "";
 
 
    return;
 
  }
 
 
  try{
 
    const data =
      await apiRequest(
        "/persona-test/snapshot",
        {
 
          method:
            "POST",
 
          headers:{
            "Content-Type":
              "application/json"
          },
 
          body:
            JSON.stringify({
 
              password:
                getPassword(),
 
              jid
 
            })
 
        }
      );
 
 
    renderSnapshot(
      data
    );
 
 
  }catch(error){
 
    console.error(
      error
    );
 
 
    outputBox.textContent =
      "FEHLER:\\n"
      +
      error.message;
 
  }
 
}
 
 
async function sendTestMessage(){
 
  const jid =
    String(
      contactsSelect.value
      ||
      ""
    );
 
 
  const message =
    String(
      messageInput.value
      ||
      ""
    )
      .trim();
 
 
  if(
    !getPassword()
  ){
 
    setStatus(
      sendStatus,
      "Bitte zuerst das Passwort eingeben.",
      "error"
    );
 
 
    return;
 
  }
 
 
  if(
    !jid
  ){
 
    setStatus(
      sendStatus,
      "Bitte zuerst einen Testkontakt auswählen.",
      "error"
    );
 
 
    return;
 
  }
 
 
  if(
    !message
  ){
 
    setStatus(
      sendStatus,
      "Bitte eine Nachricht eingeben.",
      "error"
    );
 
 
    return;
 
  }
 
 
  sendMessageButton.disabled =
    true;
 
 
  setStatus(
    sendStatus,
    "Antwort und Memory werden verarbeitet ...",
    "loading"
  );
 
 
  try{
 
    const data =
      await apiRequest(
        "/persona-test/message",
        {
 
          method:
            "POST",
 
          headers:{
            "Content-Type":
              "application/json"
          },
 
          body:
            JSON.stringify({
 
              password:
                getPassword(),
 
              jid,
 
              message
 
            })
 
        }
      );
 
 
    messageInput.value =
      "";
 
 
    renderSnapshot(
      data.snapshot,
      {
 
        reply:
          data.reply,
 
        duplicate:
          data.duplicate,
 
        replyLanguage:
          data.replyLanguage
          ||
          null
 
      }
    );
 
 
    setStatus(
      sendStatus,
      data.duplicate
        ? "Doppelte Nachricht erkannt. Kein zweites Memory erzeugt."
        : "Antwort und Memory wurden gespeichert.",
      "ok"
    );
 
 
  }catch(error){
 
    console.error(
      error
    );
 
 
    setStatus(
      sendStatus,
      error.message,
      "error"
    );
 
 
  }finally{
 
    sendMessageButton.disabled =
      false;
 
  }
 
}
 
 
loadContactsButton
  .addEventListener(
    "click",
    () => {
 
      loadContacts();
 
    }
  );
 
 
createContactButton
  .addEventListener(
    "click",
    () => {
 
      createNewTestContact();
 
    }
  );
 
 
contactsSelect
  .addEventListener(
    "change",
    () => {
 
      loadSnapshot();
 
    }
  );
 
 
sendMessageButton
  .addEventListener(
    "click",
    () => {
 
      sendTestMessage();
 
    }
  );
 
 
newContactNameInput
  .addEventListener(
    "keydown",
    event => {
 
      if(
        event.key === "Enter"
      ){
 
        event.preventDefault();
 
 
        createNewTestContact();
 
      }
 
    }
  );
 
 
})();
 
</script>
 
 
</body>
 
</html>`
  );
 
}
);
 
 
/* ==================================================
 TESTKONTAKTE LADEN
================================================== */
 
app.post(
"/persona-test/contacts",
async (req, res) => {
 
  try {
 
    if (
      !personaPasswordCorrect(
        req.body.password
      )
    ) {
 
      return res
        .status(401)
        .json({
 
          error:
            "Falsches Passwort."
 
        });
 
    }
 
 
    const contacts =
      await getTestContacts();
 
 
    res.json({
 
      ok:
        true,
 
      contacts
 
    });
 
 
  } catch (error) {
 
    console.error(
      "Testkontakte Fehler:",
      error
    );
 
 
    res
      .status(500)
      .json({
 
        error:
          error?.message
          ||
          "Testkontakte konnten nicht geladen werden."
 
      });
 
  }
 
}
);
 
 
/* ==================================================
 TESTKONTAKT ANLEGEN
================================================== */
 
app.post(
"/persona-test/create-contact",
async (req, res) => {
 
  try {
 
    if (
      !personaPasswordCorrect(
        req.body.password
      )
    ) {
 
      return res
        .status(401)
        .json({
 
          error:
            "Falsches Passwort."
 
        });
 
    }
 
 
    const name =
      normalizeText(
        req.body.name
      );
 
 
    if (!name) {
 
      return res
        .status(400)
        .json({
 
          error:
            "Bitte einen Namen für den Testkontakt eingeben."
 
        });
 
    }
 
 
    const contact =
      await createTestContact({
 
        name,
 
        country:
          req.body.country || null,
 
        city:
          req.body.city || null,
 
        language:
          req.body.language || null
 
      });
 
 
    console.log(
      "Neuer Testkontakt angelegt:",
      contact.display_name,
      contact.whatsapp_jid
    );
 
 
    res.json({
 
      ok:
        true,
 
      contact
 
    });
 
 
  } catch (error) {
 
    console.error(
      "Testkontakt anlegen Fehler:",
      error
    );
 
 
    res
      .status(500)
      .json({
 
        error:
          error?.message
          ||
          "Testkontakt konnte nicht angelegt werden."
 
      });
 
  }
 
}
);
 
 
/* ==================================================
 TEST SNAPSHOT
================================================== */
 
app.post(
"/persona-test/snapshot",
async (req, res) => {
 
  try {
 
    if (
      !personaPasswordCorrect(
        req.body.password
      )
    ) {
 
      return res
        .status(401)
        .json({
 
          error:
            "Falsches Passwort."
 
        });
 
    }
 
 
    const jid =
      normalizeText(
        req.body.jid
      );
 
 
    if (
      !isTestJid(
        jid
      )
    ) {
 
      return res
        .status(400)
        .json({
 
          error:
            "Ungültiger Testkontakt."
 
        });
 
    }
 
 
    const snapshot =
      await getTestContactSnapshot(
        jid
      );
 
 
    if (!snapshot) {
 
      return res
        .status(404)
        .json({
 
          error:
            "Testkontakt nicht gefunden."
 
        });
 
    }
 
 
    res.json(
      snapshot
    );
 
 
  } catch (error) {
 
    console.error(
      "Snapshot Fehler:",
      error
    );
 
 
    res
      .status(500)
      .json({
 
        error:
          error?.message
          ||
          "Snapshot konnte nicht geladen werden."
 
      });
 
  }
 
}
);
 
 
/* ==================================================
 TEST MESSAGE
================================================== */
 
app.post(
"/persona-test/message",
async (req, res) => {
 
  try {
 
    if (
      !personaPasswordCorrect(
        req.body.password
      )
    ) {
 
      return res
        .status(401)
        .json({
 
          error:
            "Falsches Passwort."
 
        });
 
    }
 
 
    const jid =
      normalizeText(
        req.body.jid
      );
 
 
    const text =
      normalizeText(
        req.body.message
      );
 
 
    if (
      !isTestJid(
        jid
      )
    ) {
 
      return res
        .status(400)
        .json({
 
          error:
            "Ungültiger Testkontakt."
 
        });
 
    }
 
 
    if (!text) {
 
      return res
        .status(400)
        .json({
 
          error:
            "Keine Nachricht eingegeben."
 
        });
 
    }
 
 
    const contact =
      await getContactByJid(
        jid
      );
 
 
    if (!contact) {
 
      return res
        .status(404)
        .json({
 
          error:
            "Testkontakt nicht gefunden."
 
        });
 
    }
 
 
    const duplicate =
      await detectImmediateDuplicate(
        jid,
        text
      );
 
 
    if (duplicate) {
 
      await saveMessage(
        jid,
        "incoming",
        text,
        `test-in-${Date.now()}`,
        {
 
          processingStatus:
            "duplicate",
 
          duplicateOfMessageId:
            duplicate.id
 
        }
      );
 
 
      const replyLanguage =
        await resolveReplyLanguage(
          contact,
          jid,
          text
        );
 
 
      const reply =
        await duplicateReplyForContact(
          contact,
          jid,
          text
        );
 
 
      await saveMessage(
        jid,
        "outgoing",
        reply,
        `test-out-${Date.now()}`,
        {
 
          processingStatus:
            "duplicate_reply"
 
        }
      );
 
 
      return res.json({
 
        ok:
          true,
 
        duplicate:
          true,
 
        reply,
 
        replyLanguage,
 
        snapshot:
          await getTestContactSnapshot(
            jid
          )
 
      });
 
    }
 
 
    const incoming =
      await saveMessage(
        jid,
        "incoming",
        text,
        `test-in-${Date.now()}`
      );
 
 
    const replyLanguage =
      await resolveReplyLanguage(
        contact,
        jid,
        text
      );
 
 
    const reply =
      await generateAIReply(
        jid,
        text,
        incoming.id
      );
 
 
    if (!reply) {
 
      return res
        .status(500)
        .json({
 
          error:
            "OpenAI hat keine Antwort erzeugt."
 
        });
 
    }
 
 
    const outgoing =
      await saveMessage(
        jid,
        "outgoing",
        reply,
        `test-out-${Date.now()}`
      );
 
 
    await extractMemoryUpdates({
 
      jid,
 
      contactId:
        contact.id,
 
      incomingText:
        text,
 
      incomingMessageDbId:
        incoming.id,
 
      outgoingText:
        reply,
 
      outgoingMessageDbId:
        outgoing.id
 
    });
 
 
    res.json({
 
      ok:
        true,
 
      duplicate:
        false,
 
      reply,
 
      replyLanguage,
 
      snapshot:
        await getTestContactSnapshot(
          jid
        )
 
    });
 
 
  } catch (error) {
 
    console.error(
      "Testnachricht Fehler:",
      error
    );
 
 
    res
      .status(500)
      .json({
 
        error:
          error?.message
          ||
          "Testnachricht konnte nicht verarbeitet werden."
 
      });
 
  }
 
}
);
 
 
/* ==================================================
 WHATSAPP INCOMING HANDLER
================================================== */
 
async function handleIncomingTextMessage(
message
) {
 
const jid =
  message.key.remoteJid;
 
 
if (
  !jid
  ||
  jid.endsWith(
    "@g.us"
  )
  ||
  message.key.fromMe
) {
 
  return;
 
}
 
 
const text =
  extractTextFromMessageContent(
    message.message
  );
 
 
if (!text) {
  return;
}
 
 
let contact =
  await ensureContact(
    jid
  );
 
 
const duplicate =
  await detectImmediateDuplicate(
    jid,
    text
  );
 
 
if (duplicate) {
 
  await saveMessage(
    jid,
    "incoming",
    text,
    message.key.id || null,
    {
 
      processingStatus:
        "duplicate",
 
      duplicateOfMessageId:
        duplicate.id
 
    }
  );
 
 
  if (
    contact?.auto_reply_enabled !== false
    &&
    contact?.date_lock_enabled !== true
  ) {
 
    const reply =
      await duplicateReplyForContact(
        contact,
        jid,
        text
      );
 
 
    await sock.sendMessage(
      jid,
      {
        text:
          reply
      }
    );
 
 
    await saveMessage(
      jid,
      "outgoing",
      reply,
      null,
      {
        processingStatus:
          "duplicate_reply"
      }
    );
 
  }
 
 
  return;
 
}
 
 
const incoming =
  await saveMessage(
    jid,
    "incoming",
    text,
    message.key.id || null
  );
 
 
contact =
  await getContactByJid(
    jid
  );
 
 
if (
  contact?.auto_reply_enabled === false
  ||
  contact?.date_lock_enabled === true
) {
 
  return;
 
}
 
 
const reply =
  await generateAIReply(
    jid,
    text,
    incoming.id
  );
 
 
if (!reply) {
  return;
}
 
 
await sock.sendMessage(
  jid,
  {
    text:
      reply
  }
);
 
 
const outgoing =
  await saveMessage(
    jid,
    "outgoing",
    reply
  );
 
 
scheduleMemoryUpdate({
 
  jid,
 
  contactId:
    contact.id,
 
  incomingText:
    text,
 
  incomingMessageDbId:
    incoming.id,
 
  outgoingText:
    reply,
 
  outgoingMessageDbId:
    outgoing.id
 
});
 
}
 
 
/* ==================================================
 WHATSAPP EDIT HANDLER
================================================== */
 
async function handleEditedMessageUpdate(
entry
) {
 
try {
 
  const jid =
    entry
      ?.key
      ?.remoteJid;
 
 
  const whatsappMessageId =
    entry
      ?.key
      ?.id;
 
 
  if (
    !jid
    ||
    !whatsappMessageId
    ||
    entry?.key?.fromMe
    ||
    jid.endsWith(
      "@g.us"
    )
  ) {
 
    return;
 
  }
 
 
  const text =
    extractEditedText(
      entry.update
    );
 
 
  if (!text) {
    return;
  }
 
 
  const updated =
    await updateEditedIncomingMessage({
 
      jid,
 
      whatsappMessageId,
 
      newText:
        text
 
    });
 
 
  if (updated) {
 
    console.log(
      "WhatsApp-Nachricht bearbeitet:",
      whatsappMessageId,
      text
    );
 
  }
 
 
} catch (error) {
 
  console.error(
    "Edit-Verarbeitung fehlgeschlagen:",
    error
  );
 
}
 
}
 
 
/* ==================================================
 WHATSAPP START
================================================== */
 
async function startWhatsApp() {
 
if (
  !WHATSAPP_ENABLED
) {
 
  whatsappStatus =
    "disabled";
 
 
  console.log(
    "WhatsApp deaktiviert. Kein Socket, kein Pairing, kein Reconnect."
  );
 
 
  return;
 
}
 
 
whatsappStatus =
  "starting";
 
 
const {
  state,
  saveCreds
} =
  await useMultiFileAuthState(
    "/app/auth_info"
  );
 
 
const {
  version
} =
  await fetchLatestBaileysVersion();
 
 
sock =
  makeWASocket({
 
    version,
 
    auth:
      state,
 
    logger,
 
    shouldSyncHistoryMessage:
      () => false
 
  });
 
 
sock.ev.on(
  "creds.update",
  saveCreds
);
 
 
sock.ev.on(
  "messages.upsert",
  async event => {
 
    if (
      event.type !== "notify"
      ||
      event.requestId
    ) {
 
      return;
 
    }
 
 
    for (
      const message
      of event.messages
    ) {
 
      try {
 
        await handleIncomingTextMessage(
          message
        );
 
 
      } catch (error) {
 
        console.error(
          "Incoming Fehler:",
          error
        );
 
      }
 
    }
 
  }
);
 
 
sock.ev.on(
  "messages.update",
  async updates => {
 
    for (
      const entry
      of updates
    ) {
 
      await handleEditedMessageUpdate(
        entry
      );
 
    }
 
  }
);
 
 
sock.ev.on(
  "connection.update",
  async update => {
 
    const {
      connection,
      lastDisconnect,
      qr
    } =
      update;
 
 
    if (
      connection === "open"
    ) {
 
      whatsappStatus =
        "connected";
 
 
      pairingCode =
        null;
 
 
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
      qr
      &&
      !state.creds.registered
      &&
      !pairingCode
    ) {
 
      const phone =
        process.env
          .WHATSAPP_PHONE_NUMBER;
 
 
      if (phone) {
 
        try {
 
          pairingCode =
            await sock.requestPairingCode(
              phone.replace(
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
        statusCode
        !==
        DisconnectReason.loggedOut
      ) {
 
        console.log(
          "WhatsApp getrennt. Neuer Verbindungsversuch in 5 Sekunden."
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
 
 
/* ==================================================
 SERVER START
================================================== */
 
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
 
 
  startWhatsApp()
    .catch(
      console.error
    );
 
}
);
 
