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
import { DEVICE_BRIDGE_PROTOCOL } from "./device-bridge/protocol-v1.js";
import { initializeDeviceBridgeDatabase } from "./device-bridge/initialization.js";
import {
  createAdminEnrollmentCodeHandler,
  createDeviceEnrollmentHandler
} from "./device-bridge/enrollment.js";
import { registerDeviceBridgeBlock3Routes } from "./device-bridge/block3-routes.js";
import {
  deviceBridgeFoundationMiddleware,
  deviceBridgeRawBodyErrorMiddleware,
  requireDeviceBridgeReady
} from "./device-bridge/readiness.js";
import { createContactMediaService } from "./services/contact-media.js";
import { createContactIdentityService } from "./services/contact-identities.js";

const { Pool } = pg;

const app = express();
const port = process.env.PORT || 3000;

/* ==================================================
DEVICE BRIDGE T0 — PROTOCOL V1 RAW BODY
================================================== */
app.use(
  "/device-bridge/v1",
  express.raw({
    type: "application/json",
    limit: DEVICE_BRIDGE_PROTOCOL.maximumRequestBytes
  })
);
app.use("/device-bridge/v1", deviceBridgeRawBodyErrorMiddleware);
app.use("/device-bridge/v1", deviceBridgeFoundationMiddleware);

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
const { listContactMedia } = createContactMediaService(pool);
const {
  listContactIdentities,
  listContactIdentityMap,
  upsertContactIdentity,
  removeContactIdentity
} = createContactIdentityService(pool);

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


==================================================GELD
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

Identitäten nur über die gespeicherte Kontakt-ID,
den Memory Identity Key oder bestätigte Identifier
wie Telefonnummer, WhatsApp-JID oder Username zuordnen.

Ein gleicher oder ähnlicher Name allein reicht niemals
zum Zusammenführen zweier Kontakte.


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
) );

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
FRAUEN MEMORY SEMANTIK V1.9
Gemeinsame Regeln fuer Live-Extractor und Historical Backfill.
Keine UI-, Import-, Uebersetzungs- oder Marcel-Brain-Logik.
================================================== */
const WOMAN_MEMORY_SEMANTIC_CORE = `
SEMANTIK-REGELN FUER FRAUEN-MEMORY:

1. PERSON / SUBJEKT ZUERST BESTIMMEN
- contact_items und das Frauenprofil enthalten nur Wissen ueber DIESE Frau bzw. ihre Beziehung/Interaktion mit Marcel.
- Aussagen ueber Marcel gehoeren nicht als Frauenfakt gespeichert; im Historical Backfill gehoeren sie in marcel_items.
- Aussagen ueber Mutter, Vater, Kinder, Geschwister, Freunde, Ex-Partner, Kollegen oder andere Dritte niemals der Frau selbst zuschreiben.
- Bei Dritten die Beziehung im Key/Wert ausdruecken, z.B. mother_birthday, son_age, sister_job. Ein Geburtstag der Mutter ist niemals profile_summary.birthday der Frau.
- Pronomen und kurze Rueckbezuege nur zuordnen, wenn der Dialogkontext die Person eindeutig macht. Bei Unsicherheit nichts als sicheren Fakt speichern.

2. FAKTART RICHTIG WAEHLEN
- self_reported: Die Frau sagt einen Fakt ueber sich selbst ausdruecklich.
- explicit_fact: Ein klarer, objektiver Fakt ist eindeutig belegt.
- observed_pattern: Erst bei wiederholtem Verhalten ueber mehrere Nachrichten/Gelegenheiten; niemals aus einer einzelnen Reaktion eine Persoenlichkeit machen.
- interpretation: Nur wenn wirklich nuetzlich und gut belegt; vorsichtig formulieren, niedrigere confidence. Keine Gedanken, Motive oder Gefuehle erfinden.
- temporary_state: Kurzfristiger Zustand wie heute muede, gerade krank, aktuell Stress, momentan bei der Mutter, diese Woche viel Arbeit. Solche Zustaende duerfen nicht als dauerhafte Eigenschaft gespeichert werden.

3. ZEITBEZUG / EREIGNIS VS. DAUERZUSTAND
- Woerter wie heute, morgen, gestern, gerade, momentan, aktuell, diese Woche, spaeter, gleich, seit ein paar Tagen sind starke Hinweise auf temporaeren Zustand oder Ereignis.
- Termine, Dates, Vorstellungsgespraeche, Pruefungen, Arzttermine, Fluege, Reisen, Geburtstagsfeiern, konkrete Treffen, Reparaturen und einzelne Krankheits-/Schmerzepisoden sind Ereignisse, keine dauerhaften Profilmerkmale.
- Ein vergangenes Ereignis darf als shared_history/meaningful_details relevant bleiben, aber nicht so gespeichert werden, als sei es weiterhin aktuell.
- temporary_state soll eine plausible valid_until_hours bekommen, wenn die Dauer aus dem Kontext abschaetzbar ist: heute/gerade typischerweise 24h, diese Woche bis etwa 168h. Keine kuenstlich lange Gueltigkeit.
- Langfristige Fakten wie Beruf, Studium, Kinder, Wohnort, feste Vorlieben oder ausdrueckliche Beziehungsabsicht haben normalerweise kein Ablaufdatum.

4. GEBURTSTAG / ALTER
- profile_summary.birthday, birth_day, birth_month, birth_year und age beziehen sich ausschliesslich auf die Frau selbst.
- "Der Geburtstag meiner Mutter ist am 29. August" => Familienwissen ueber die Mutter, niemals Geburtstag der Frau.
- Wenn nur Tag/Monat der Frau bekannt sind, kein Jahr erfinden. Wenn Alter und Geburtstag spaeter ueber die verifizierte Kontaktlogik ein Jahr ergeben, hat diese Human-/Kontaktlogik Vorrang.
- Alter einer dritten Person (z.B. Sohn 5) nie als Alter der Frau speichern.

5. ARBEIT / AUSBILDUNG
- "Ich arbeite als/in ..." oder eindeutig aktueller Beruf => work_education als dauerhafter aktueller Fakt.
- Jobverlust, Jobsuche, Bewerbung oder Vorstellungsgespraech sind nicht automatisch der aktuelle Beruf. Jobverlust kann den alten Beruf historisch machen; Jobsuche/Interview ist Zustand/Ereignis.
- "Ich habe morgen ein Vorstellungsgespraech" => Ereignis, nicht current_job.
- Studium/Universitaet nur als aktuell speichern, wenn es tatsaechlich die Frau betrifft und nicht nur ein Plan, Wunsch oder die Ausbildung einer dritten Person ist.

6. GESUNDHEIT
- Akute Schmerzen, Krankheit, Erschoepfung oder Stress eines Tages => temporary_state oder event.
- health als dauerhafter Profilbereich nur fuer laenger anhaltende, wiederkehrende, diagnostizierte oder ausdruecklich als dauerhaft beschriebene Themen.
- Ursache und Person nicht erfinden. "Nackenschmerzen nach der Arbeit" bedeutet nicht automatisch chronische Krankheit.

7. BEZIEHUNG / GEFUEHLE / GEMEINSAME DYNAMIK
- Ausdrueckliche Dating-Absicht (z.B. feste Beziehung suchen) darf dauerhaft unter relationship gespeichert werden.
- Einzelne warme/flirtige Saetze sind nicht automatisch Liebe, Bindung, Exklusivitaet oder Angst vor Verlust.
- Konkrete gemeinsame Erlebnisse und Running Gags eher shared_history/running_gags; dauerhafte Gefuehle nur bei klarer Aussage oder wiederholter belastbarer Evidenz.
- Aussagen Marcels ueber seine eigenen Gefuehle nicht als Gefuehl der Frau speichern.

8. EROTIK / INTIMITAET
- sexuality_intimacy nur fuer klar sexuelle/intime Fakten, Vorlieben, Grenzen oder eindeutig bestaetigte intime Dynamik.
- Keine sexuelle Orientierung, Vorliebe, Zustimmung oder Bereitschaft aus Flirt, Emojis, Foto, Kuss-Emoji oder zweideutiger Nachricht ableiten.
- Alltag, Arbeit, Gesundheit, Familie und allgemeine Zuneigung nicht wegen einzelner Woerter in Erotik verschieben.

9. KATEGORIEN STABIL VERWENDEN
- profile_summary: nur stabile Basisdaten der Frau.
- personality: stabile Selbstbeschreibung oder mehrfach beobachtetes Muster, nicht Tagesstimmung.
- family/children: Familie und Kinder inklusive klar bezeichneten Drittpersonen.
- work_education: Beruf, Arbeit, Ausbildung, Studium.
- financial_context: finanzielle Lage/Bitten nur wenn tatsaechlich belegt.
- health: dauerhafte/relevante Gesundheit; akute Episode als temporary/event.
- relationship: Dating-Ziel, stabile Beziehungsinformationen/Gefuehle.
- sexuality_intimacy: nur eindeutig intime/sexuelle Inhalte.
- communication: Kommunikationsstil, Sprache, wiederkehrende Kommunikationsvorlieben.
- lifestyle_routines/preferences/dislikes: stabile Routinen und Vorlieben.
- goals_dreams/plans: echte Zukunftsplaene; konkrete bevorstehende Termine zusaetzlich/lieber als event.
- living_situation/travel_future_location: aktuelle stabile Wohn-/Ortslage bzw. belastbare Reise-/Umzugsplaene.
- shared_history/meaningful_details/running_gags: nur echte gemeinsame Erlebnisse, gemeinsame Referenzen, besondere gemeinsame Gespraeche oder Running Gags. Ein Fakt aus ihrer eigenen Vergangenheit wird NICHT allein dadurch shared_history, dass sie Marcel davon erzaehlt hat.
- current_context: nur kurzfristig aktueller Kontext; nicht als Ersatz fuer dauerhafte Kategorien missbrauchen.
- marcel_knowledge_map: ausschliesslich was diese Frau nachweislich ueber Marcel weiss.

10. DEDUPLIKATION / UPDATE / WIDERSPRUCH
- Gleicher Sachverhalt trotz anderer Formulierung ist kein neuer Fakt.
- EIN KERNFAKT = EIN MEMORY-ITEM = EINE PRIMAERE KATEGORIE. Auch wenn ein Sachverhalt thematisch zu mehreren Kategorien passt, denselben Kernfakt niemals als mehrere Items in family, relationship, shared_history, meaningful_details usw. wiederholen.
- Waehle fuer jeden Kernfakt genau die fachlich beste primaere Kategorie. Andere thematische Bezuege duerfen im memory_value als Kontext erhalten bleiben, aber nicht als zusaetzliche Kopien desselben Fakts.
- Keine Information darf durch Dedup verloren gehen: Wenn zwei Formulierungen denselben Kernfakt enthalten, fuehre die nuetzlichen Details in EINEM vollstaendigen memory_value zusammen.
- shared_history ist keine Auffangkategorie fuer alles, was die Frau Marcel erzaehlt hat. Nur wirklich gemeinsame Erlebnisse/Referenzen zwischen Marcel und der Frau gehoeren dort hinein.
- Pruefe Duplikate kategorienuebergreifend ueber den gesamten aktiven Frauen-Memory-Bestand, nicht nur innerhalb der vorgeschlagenen Kategorie.
- Fuer denselben Sachverhalt einen stabilen snake_case memory_key kategorienuebergreifend wiederverwenden.
- Neue praezisere oder zeitlich aktuellere Information zum selben Sachverhalt => bestehenden Fakt aktualisieren/superseden statt Parallel-Duplikat.
- Einen alten Fakt nur retiren, wenn die neue Aussage denselben Gegenstand und dieselbe Person eindeutig ersetzt oder widerspricht. Nicht retiren, nur weil er in der aktuellen Nachricht nicht erwaehnt wird.
- Human confirmed/corrected Fakten niemals automatisch ueberschreiben oder retiren.

11. EVIDENZ / SICHERHEIT
- source_quote/evidence moeglichst wortnah aus der tatsaechlichen Nachricht; keine erfundene Belegstelle.
- Bei Ironie, Sarkasmus, Uebersetzungsunsicherheit, unklarem Pronomen, unklarer Person oder widerspruechlichem Kontext konservativ sein.
- Lieber keinen Fakt speichern als einen falschen Fakt ueber die falsche Person.

12. PROFILE SNAPSHOT
- profile_snapshot ist die konsolidierte, aktuell gueltige Langzeitansicht und kein Nachrichtenprotokoll.
- Keine kurzfristigen Tageszustaende oder einmaligen Events in den Snapshot einbrennen.
- Bereits vorhandene, weiterhin gueltige Profilinformationen erhalten; nur mit neuer eindeutiger Evidenz korrigieren/aktualisieren.
- Drittpersonen nur in passenden Familien-/Kontextstrukturen ablegen, niemals als Basisdaten der Frau.
`;

const WOMAN_MEMORY_LIVE_OUTPUT_RULES = `
LIVE-EXTRACTOR OUTPUT:
- retire_item_ids: nur eindeutige ersetzte/widersprochene aktive Memory-IDs, niemals Human-confirmed/corrected.
- items: maximal wirklich neue oder aktualisierte Memory-Fakten. Struktur pro Item:
{"category":"","memory_key":"stable_snake_case","memory_value":{},"memory_type":"self_reported|explicit_fact|observed_pattern|interpretation|temporary_state","confidence":0.0,"importance":1,"use_in_reply":true,"source_quote":"","valid_until_hours":null}
- events: fuer konkrete zeitgebundene Ereignisse. Struktur pro Event:
{"event_type":"","event_subtype":"","title":"","event_data":{},"importance":1,"sensitivity":"normal|personal|intimate","evidence_summary":"","requires_follow_up":false,"bot_action":"","marcel_review_required":false}
- profile_snapshot: alle vorgesehenen PROFILE_COLUMNS liefern; stabile aktuelle Langzeitdaten konsolidieren, temporaere Zustaende/Events nicht als Dauerprofil schreiben.
- Eine Nachricht darf sowohl einen dauerhaften Fakt als auch ein Ereignis enthalten, wenn beides getrennt korrekt ist. Beispiel: "Ich bin Krankenschwester und habe morgen ein Vorstellungsgespraech" => Berufsfakt + Interview-Event; das Interview ist nicht der Beruf.
`;

const WOMAN_MEMORY_HISTORICAL_RULES = `
HISTORICAL BACKFILL:
- Ziel ist langfristig nutzbares, konsolidiertes Memory aus einem alten Chatverlauf, nicht die Speicherung jedes damaligen Tageszustands.
- Reine vergangene Tageszustaende und einzelne alte Termine/Events normalerweise nicht als aktives Langzeit-contact_item anlegen.
- Ein vergangenes Ereignis nur als langfristigen Fakt aufnehmen, wenn seine dauerhafte Folge oder gemeinsame Bedeutung spaeter relevant ist; dann klar als Vergangenheit/shared_history/meaningful_details formulieren, nicht als aktuellen Zustand.
- SAME/UPDATE/CONTRADICTION/NEW/UNCERTAIN semantisch gegen bestehendes Memory entscheiden.
- Bei unklarer Person, Zeit oder Bedeutung UNCERTAIN statt falscher Zuordnung.
`;




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
language.includes("english")   ||
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
  Array.isArray(       current
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
          item.category           )
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
DATENBANK INITIALISIEREN
================================================== */

async function initDatabase() {

await initializeDeviceBridgeDatabase(pool);

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

  ADD COLUMN IF NOT EXISTS whatsapp_username TEXT,
  ADD COLUMN IF NOT EXISTS current_platform TEXT,

  ADD COLUMN IF NOT EXISTS platform_status TEXT,

  ADD COLUMN IF NOT EXISTS identity_locked BOOLEAN
    DEFAULT FALSE,

  ADD COLUMN IF NOT EXISTS birth_day SMALLINT,

  ADD COLUMN IF NOT EXISTS birth_month SMALLINT,

  ADD COLUMN IF NOT EXISTS birth_year SMALLINT,

  ADD COLUMN IF NOT EXISTS birth_year_inferred BOOLEAN
    DEFAULT FALSE,

  ADD COLUMN IF NOT EXISTS manual_contact_fields JSONB
    DEFAULT '{}'::jsonb,

  ADD COLUMN IF NOT EXISTS manual_contact_updated_at TIMESTAMPTZ
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

  ADD COLUMN IF NOT EXISTS import_batch_id TEXT,

  ADD COLUMN IF NOT EXISTS translation_de TEXT,

  ADD COLUMN IF NOT EXISTS translated_at TIMESTAMPTZ,

  ADD COLUMN IF NOT EXISTS translation_model TEXT,

  ADD COLUMN IF NOT EXISTS translation_source_hash TEXT
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
    )       .join(",")},

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
ALTER TABLE marcel_memory

  ADD COLUMN IF NOT EXISTS human_review_action TEXT,

  ADD COLUMN IF NOT EXISTS human_review_note TEXT,

  ADD COLUMN IF NOT EXISTS human_reviewed_at TIMESTAMPTZ
`);


await pool.query(`
CREATE TABLE IF NOT EXISTS marcel_memory_review_log (

  id BIGSERIAL PRIMARY KEY,

  memory_id BIGINT
    REFERENCES marcel_memory(id)
    ON DELETE SET NULL,

  memory_key TEXT NOT NULL,

  action TEXT NOT NULL,

  old_value JSONB,

  new_value JSONB,

  old_status TEXT,

  new_status TEXT,

  correction_de TEXT,

  reviewed_by TEXT
    DEFAULT 'marcel_dashboard',

  reviewed_at TIMESTAMPTZ
    DEFAULT NOW()

)
`);


await pool.query(`
CREATE INDEX IF NOT EXISTS
idx_marcel_memory_review_log_memory

ON marcel_memory_review_log (
  memory_id,
  reviewed_at DESC
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

  location_status TEXT       DEFAULT 'living',

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
CREATE TABLE IF NOT EXISTS marcel_live_state_audit (

  id BIGSERIAL PRIMARY KEY,

  changed_at TIMESTAMPTZ NOT NULL
    DEFAULT NOW(),

  source TEXT NOT NULL
    DEFAULT 'manual_dashboard',

  actor TEXT,

  request_reference TEXT,

  changed_fields JSONB NOT NULL
    DEFAULT '[]'::jsonb,

  old_values JSONB NOT NULL
    DEFAULT '{}'::jsonb,

  new_values JSONB NOT NULL
    DEFAULT '{}'::jsonb

)
`);


await pool.query(`
CREATE INDEX IF NOT EXISTS
idx_marcel_live_state_audit_changed_at

ON marcel_live_state_audit (
  changed_at DESC
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

console.log(
"Frauen-Kontakte: PostgreSQL ist die einzige Datenquelle; kein Frauen-Code-Seed wird geladen."
);


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
    }     },
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
  {       parents_still_married:
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

    WHERE marcel_memory.human_reviewed_at
      IS NULL
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
  "whatsapp_jid",
  "whatsapp_username"
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
KONTAKT MEMORY PROFIL
================================================== */

async function getContactMemoryProfile(
contactId
) {

const result =
await pool.query(
  `
    SELECT
      cmp.*,
      c.birth_day
        AS contact_birth_day,
      c.birth_month
        AS contact_birth_month,
      c.birth_year
        AS contact_birth_year,
      c.birth_year_inferred
        AS contact_birth_year_inferred

    FROM contact_memory_profiles cmp

    JOIN contacts c
      ON c.id =
        cmp.contact_id

    WHERE cmp.contact_id =
      $1

    LIMIT 1
  `,
  [
    contactId
  ]
);


const row =
result.rows[0]
||
null;


if (!row) {
return null;
}


const {
contact_birth_day: contactBirthDay,
contact_birth_month: contactBirthMonth,
contact_birth_year: contactBirthYear,
contact_birth_year_inferred: contactBirthYearInferred,
...profileRow
} = row;


const profileSummary =
isPlainObject(
  profileRow.profile_summary
)

  ? {
      ...profileRow.profile_summary
    }

  : {};


const birthday =
resolveContactBirthdayData({
  contact: {
    birth_day:
      contactBirthDay,
    birth_month:
      contactBirthMonth,
    birth_year:
      contactBirthYear,
    birth_year_inferred:
      contactBirthYearInferred
  },
  profile:
    profileRow,
  memoryItems:
    []
});


if (birthday.birthDay) {
profileSummary.birth_day =
  birthday.birthDay;
}


if (birthday.birthMonth) {
profileSummary.birth_month =
  birthday.birthMonth;
}


if (birthday.birthYear) {
profileSummary.birth_year =
  birthday.birthYear;
}


if (
birthday.birthDay
&&
birthday.birthMonth
) {
profileSummary.birthday = {
  ...(isPlainObject(
    profileSummary.birthday
  )
    ? profileSummary.birthday
    : {}),
  day:
    birthday.birthDay,
  month:
    birthday.birthMonth,
  ...(birthday.birthYear
    ? {
        year:
          birthday.birthYear
      }
    : {}),
  ...(birthday.birthYearInferred
    ? {
        year_inferred:
          true
      }
    : {})
};
}


if (birthday.age != null) {
profileSummary.age =
  birthday.age;
}



return {
...profileRow,
profile_summary:
  profileSummary
};

}/* ==================================================
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
    conflict.rows[0]     ) {

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
await pool.query(     `
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

      translation_de,

      translated_at,

      translation_model,

      translation_source_hash,

      created_at

    FROM messages

    WHERE whatsapp_jid =
      $1

      AND message_text
        IS NOT NULL

    ORDER BY
      id DESC

    LIMIT $2     `,
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

    translationDe:
      message.translation_de,

    translatedAt:
      message.translated_at,

    translationModel:
      message.translation_model,

    createdAt:
      message.created_at

  })
);

}


/* ==================================================
DASHBOARD KI-UEBERSETZUNG DEUTSCH
- nur letzte 24 Stunden
- OpenAI statt Wort-fuer-Wort-Uebersetzer
- gecacht direkt an der Nachricht
================================================== */

function dashboardTranslationSourceHash(
text
) {

return crypto
.createHash(
  "sha256"
)
.update(
  normalizeText(text),
  "utf8"
)
.digest(
  "hex"
);

}


async function translateDashboardMessagesToGerman(
jid,
limit = 200
) {

const safeLimit =
Math.max(
  1,
  Math.min(
    200,
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
      translation_de,
      translation_source_hash,
      created_at
    FROM messages
    WHERE whatsapp_jid = $1
      AND message_text IS NOT NULL
      AND created_at >= NOW() - INTERVAL '24 hours'
    ORDER BY id DESC
    LIMIT $2
  `,
  [
    jid,
    safeLimit
  ]
);


const rows =
result.rows.reverse();


const emojiOnlyRows =
rows.filter(
  row =>
    !/[\p{L}\p{N}]/u.test(
      normalizeText(
        row.message_text
      )
    )
);


for (
const row
of emojiOnlyRows
) {

if (
  normalizeText(
    row.translation_de
  )
) {

  await pool.query(
    `
    UPDATE messages
    SET
      translation_de = NULL,
      translated_at = NULL,
      translation_model = NULL,
      translation_source_hash = NULL
    WHERE id = $1
    `,
    [
      row.id
    ]
  );


  row.translation_de = null;
  row.translation_source_hash = null;

}

}


const hasTranslatableText =
text =>
  /[\p{L}\p{N}]/u.test(
    normalizeText(
      text       )
  );


const pending =
rows.filter(
  row => {

    if (
      !hasTranslatableText(
        row.message_text
      )
    ) {

      return false;

    }


    const sourceHash =
      dashboardTranslationSourceHash(
        row.message_text
      );


    return (
      !normalizeText(
        row.translation_de
      )
      ||
      row.translation_source_hash
      !==
      sourceHash
    );

  }
);


if (
pending.length === 0
) {

return {
  translated:
    0,
  cached:
    rows.length,
  considered:
    rows.length
};

}


let translatedCount = 0;


for (
let start = 0;
start < pending.length;
start += 40
) {


const batch =
  pending.slice(
    start,
    start + 40
  );


const contextRows =
  rows.filter(
    row => {

      const firstId =
        Number(
          batch[0]?.id
          ||
          0
        );

      const lastId =
        Number(
          batch[batch.length - 1]?.id
          ||
          0
        );

      return (
        Number(row.id) >= firstId - 8
        &&
        Number(row.id) <= lastId + 8
      );

    }
  );


const response =
  await openai.responses.create({

    model:
      MODEL,

    instructions: `
Du bist der hochwertige Deutsch-Uebersetzer fuer Marcels privates WhatsApp-Dashboard.
Uebersetze Bedeutung und Ton natuerlich ins Deutsche, NICHT sklavisch Wort fuer Wort.
Beruecksichtige den Dialogkontext.
Besonders wichtig sind kolumbianisches/lateinamerikanisches Spanisch, Slang, Ironie, Neckereien, Kosenamen, Flirt, romantische Aussagen, sexuelle Doppeldeutigkeiten und vulgaere Sprache.
Entschaerfe sexuelle oder derbe Aussagen nicht. Uebertreibe sie aber auch nicht.
Beispiele fuer das Prinzip: Ein spielerisches Wort wie "zicke" darf nicht semantisch zu "Huendin/bitch" entgleisen. "Das klingt gut" darf nicht wegen einer woertlichen Fehlinterpretation zu "lecker" werden, wenn der Kontext das nicht meint.
Wenn eine Formulierung mehrdeutig ist, waehle die im Gespraechskontext wahrscheinlichste deutsche Bedeutung.
Namen, Emojis und erkennbare Eigennamen erhalten.
Antworte ausschliesslich mit gueltigem JSON im Format:
{"translations":[{"id":123,"de":"Natuerliche deutsche Uebersetzung"}]}
Fuer jede unter ZU UEBERSETZEN angegebene ID genau einen Eintrag liefern.
`,

    input: `
KONTEXT LETZTE NACHRICHTEN:
${contextRows
.map(
 row =>
   `[${row.id}] ${row.direction === "incoming" ? "Sie" : "Marcel"}: ${row.message_text}`
)
.join("\\n")}

ZU UEBERSETZEN:
${batch
.map(
 row =>
   `[${row.id}] ${row.direction === "incoming" ? "Sie" : "Marcel"}: ${row.message_text}`
)
.join("\\n")}
`

  });


const parsed =
  safeJsonParse(
    response.output_text,
    {
      translations:
        []
    }
  );


const translations =
  Array.isArray(
    parsed?.translations
  )

    ? parsed.translations

    : [];


const byId =
  new Map(
    translations
      .map(
        item => [
          Number(
            item?.id
          ),
          normalizeText(
            item?.de
          )
        ]
      )
      .filter(
        ([id, text]) =>
          Number.isInteger(id)
          &&
          id > 0
          &&
          Boolean(text)         )
  );


for (
  const row
  of batch
) {

  const german =
    byId.get(
      Number(
        row.id
      )
    );


  if (
    !german
  ) {

    continue;

  }


  const sourceHash =
    dashboardTranslationSourceHash(
      row.message_text
    );


  await pool.query(
    `

      UPDATE messages
      SET
        translation_de = $2,
        translated_at = NOW(),
        translation_model = $3,
        translation_source_hash = $4
      WHERE id = $1
    `,
    [
      row.id,
      german,
      MODEL,
      sourceHash
    ]
  );


  translatedCount++;

}

}


return {
translated:
  translatedCount,
cached:
  rows.length - pending.length,
considered:
  rows.length
};

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
[sourceHash] );
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

async function importWhatsAppHistory({ contact, rawText, marcelSenderNames = [], senderMapping = null, dryRun = false, replaceExisting = false }) {
const parsed = parseWhatsAppExport(rawText);
if (!parsed.length) throw new Error("Keine WhatsApp-Nachrichten im unterstuetzten Exportformat erkannt.");

const senders = [...new Set(parsed.map(item => item.sender))];
const senderSet = new Set(senders.map(normalizeImportSender));
const explicitMarcelSender = normalizeText(senderMapping?.marcelSender);
const explicitContactSender = normalizeText(senderMapping?.contactSender);
const hasExplicitMapping = Boolean(explicitMarcelSender && explicitContactSender);

if (hasExplicitMapping) {
 const marcelKey = normalizeImportSender(explicitMarcelSender);
 const contactKey = normalizeImportSender(explicitContactSender);
 if (marcelKey === contactKey) throw new Error("Marcel und Kontakt duerfen nicht derselbe WhatsApp-Absender sein.");
 if (!senderSet.has(marcelKey)) throw new Error(`Bestaetigter Marcel-Absender wurde im Export nicht gefunden: ${explicitMarcelSender}`);
 if (!senderSet.has(contactKey)) throw new Error(`Bestaetigter Kontakt-Absender wurde im Export nicht gefunden: ${explicitContactSender}`);
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

const marcelNames = new Set(["Marcel", "Marcel Marlow", ...marcelSenderNames].map(normalizeImportSender).filter(Boolean));
if (!hasExplicitMapping) {
 const nonMarcelSenders = senders.filter(sender => !marcelNames.has(normalizeImportSender(sender)));
 if (nonMarcelSenders.length !== 1 || senders.length !== 2) {
   const error = new Error(`Absender muessen eindeutig bestaetigt werden: ${senders.join(", ")}.`);
   error.code = "SENDER_CONFIRMATION_REQUIRED";
   error.senders = senders;
   throw error;
 }
}

const explicitMarcelKey = normalizeImportSender(explicitMarcelSender);
const explicitContactKey = normalizeImportSender(explicitContactSender);
const prepared = parsed.map(item => {
 const senderKey = normalizeImportSender(item.sender);
 let direction;
 if (hasExplicitMapping) {
   if (senderKey === explicitMarcelKey) direction = "outgoing";
   else if (senderKey === explicitContactKey) direction = "incoming";
   else return null;
 } else {
   direction = marcelNames.has(senderKey) ? "outgoing" : "incoming";
 }
 const sourceHash = historicalImportHash({ jid: contact.whatsapp_jid, direction, createdAt: item.createdAt, text: item.text });
 return { ...item, direction, sourceHash };
}).filter(Boolean);

const existingCountResult = await pool.query(
 `SELECT COUNT(*)::int AS count FROM messages WHERE whatsapp_jid = $1`,
 [contact.whatsapp_jid]
);
const existingMessages = Number(existingCountResult.rows[0]?.count || 0);
const incoming = prepared.filter(item => item.direction === "incoming").length;
const outgoing = prepared.filter(item => item.direction === "outgoing").length;

if (replaceExisting) {
 if (dryRun) {
   return {
     batchId: null, parsed: prepared.length, imported: prepared.length, duplicates: 0,
     incoming, outgoing, senders,
     senderMapping: hasExplicitMapping ? { marcelSender: explicitMarcelSender, contactSender: explicitContactSender, confirmed: true } : null,
     newMessageIds: [], dryRun: true, replaceExisting: true,
     existingMessages, wouldDelete: existingMessages, wouldImport: prepared.length, wouldRemain: prepared.length
   };
 }

 const client = await pool.connect();
 const batchId = `wa-replace-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
 const newMessageIds = [];
 try {
   await client.query("BEGIN");
   await client.query(`DELETE FROM messages WHERE whatsapp_jid = $1`, [contact.whatsapp_jid]);

   for (const item of prepared) {
     const inserted = await client.query(
       `INSERT INTO messages (
          whatsapp_jid, direction, message_text, whatsapp_message_id,
          processing_status, created_at, import_source_hash, import_batch_id
        ) VALUES ($1,$2,$3,$4,'historical_imported',$5,$6,$7)

        RETURNING id`,
       [contact.whatsapp_jid, item.direction, item.text, `historical-${item.sourceHash.slice(0,24)}`, item.createdAt, item.sourceHash, batchId]
     );
     newMessageIds.push(inserted.rows[0].id);
   }

   if (prepared.length) {
     await client.query(
       `UPDATE contacts SET first_contact_at=$2::timestamptz,last_message_at=$3::timestamptz,updated_at=NOW() WHERE id=$1`,
       [contact.id, prepared[0].createdAt, prepared[prepared.length - 1].createdAt]
     );
   }

   await client.query("COMMIT");
   return {
     batchId, parsed: prepared.length, imported: prepared.length, duplicates: 0,
     incoming, outgoing, senders,
     senderMapping: hasExplicitMapping ? { marcelSender: explicitMarcelSender, contactSender: explicitContactSender, confirmed: true } : null,
     newMessageIds, dryRun: false, replaceExisting: true,
     deletedPreviousMessages: existingMessages, remainingMessages: prepared.length
   };
 } catch (error) {
   try { await client.query("ROLLBACK"); } catch {}
   throw error;
 } finally {
   client.release();
 }
}

const batchId = `wa-import-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
let imported = 0, duplicates = 0, importedIncoming = 0, importedOutgoing = 0;
const newMessageIds = [], usedExistingIds = new Set();

for (const item of prepared) {
 const existing = await historicalMessageAlreadyExists({
   jid: contact.whatsapp_jid, direction: item.direction, createdAt: item.createdAt,
   text: item.text, sourceHash: item.sourceHash, usedExistingIds
 });
 if (existing) { usedExistingIds.add(Number(existing.id)); duplicates += 1; continue; }
 if (dryRun) {
   imported += 1;
   item.direction === "incoming" ? importedIncoming += 1 : importedOutgoing += 1;
   continue;
 }
 const inserted = await pool.query(
   `INSERT INTO messages (whatsapp_jid,direction,message_text,whatsapp_message_id,processing_status,created_at,import_source_hash,import_batch_id)
    VALUES ($1,$2,$3,$4,'historical_imported',$5,$6,$7)
    ON CONFLICT (import_source_hash) WHERE import_source_hash IS NOT NULL DO NOTHING RETURNING id`,
   [contact.whatsapp_jid,item.direction,item.text,`historical-${item.sourceHash.slice(0,24)}`,item.createdAt,item.sourceHash,batchId]
 );
 if (!inserted.rows[0]) { duplicates += 1; continue; }
 imported += 1;
 item.direction === "incoming" ? importedIncoming += 1 : importedOutgoing += 1;
 newMessageIds.push(inserted.rows[0].id);
}

if (!dryRun && imported > 0) {
 await pool.query(
   `UPDATE contacts SET first_contact_at=COALESCE(LEAST(first_contact_at,$2::timestamptz),$2::timestamptz),
    last_message_at=GREATEST(COALESCE(last_message_at,$3::timestamptz),$3::timestamptz),updated_at=NOW() WHERE id=$1`,
   [contact.id, parsed[0].createdAt, parsed[parsed.length - 1].createdAt]
 );
}

return {
 batchId, parsed: parsed.length, imported, duplicates,
 incoming: importedIncoming, outgoing: importedOutgoing, senders,

 senderMapping: hasExplicitMapping ? { marcelSender: explicitMarcelSender, contactSender: explicitContactSender, confirmed: true } : null,    newMessageIds, dryRun: Boolean(dryRun), replaceExisting: false
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

 const response=await openai.responses.create({model:MODEL,instructions:`Du bist der semantische Memory-Konsolidierer fuer Marcels WhatsApp-System. Antworte ausschliesslich mit gueltigem JSON. Verstehe den Dialog als Zusammenhang: Pronomen, kurze Antworten, Rueckbezuege, Korrekturen, Ironie und unterschiedliche Formulierungen desselben Sachverhalts. ZWEI GEHIRNE STRENG TRENNEN: contact_items sind Fakten ueber den Kontakt; marcel_items sind Fakten ueber Marcel.

${WOMAN_MEMORY_SEMANTIC_CORE}

${WOMAN_MEMORY_HISTORICAL_RULES}

Entscheide semantisch: SAME = gleicher Sachverhalt trotz anderer Formulierung, nichts neu anlegen. UPDATE = gleicher Sachverhalt mit neuer/praeziser/zeitlich aktualisierter Information. CONTRADICTION = echter Widerspruch. NEW = wirklich neuer langfristig/relevant nutzbarer Sachverhalt. UNCERTAIN = Bedeutung, Person, Zeitbezug oder Faktstatus nicht sicher. Keine banalen Flirtphrasen, Emojis, Begruessungen oder Vermutungen speichern. Human/verifiziertes Wissen nie automatisch ersetzen. Bei UPDATE Kontakt existing_memory_id setzen; bei SAME/UPDATE Marcel existing_memory_key setzen. memory_key kurz, stabil, snake_case; bei SAME/UPDATE bestehenden Key verwenden. Bei Unsicherheit UNCERTAIN. JSON exakt: {"contact_items":[{"decision":"SAME|UPDATE|CONTRADICTION|NEW|UNCERTAIN","existing_memory_id":null,"category":"","memory_key":"","memory_value":{},"memory_type":"self_reported|explicit_fact|observed_pattern|interpretation|temporary_state","confidence":0.9,"importance":3,"use_in_reply":true,"evidence":"","reason":""}],"marcel_items":[{"decision":"SAME|UPDATE|CONTRADICTION|NEW|UNCERTAIN","existing_memory_key":null,"category":"","memory_key":"","memory_value":{},"importance":3,"sensitivity":"normal|personal|intimate","evidence":"","reason":""}]}`,
   input:`KONTAKT: ${contact.display_name||contact.canonical_name||contact.whatsapp_jid}\n\nBESTEHENDES KONTAKT-MEMORY:\n${cm||'[keine]'}\n\nBESTEHENDES MARCEL-MEMORY:\n${mm||'[keine]'}\n\nDIALOG-AUSSCHNITT CHRONOLOGISCH:\n${convo}\n\nKonsolidiere nur Memory-wuerdige Informationen.`});
 const parsed=safeJsonParse(response.output_text,{contact_items:[],marcel_items:[]})||{}; const cs=await applyHistoricalContactDecisions(parsed.contact_items||[],contact.id),ms=await applyHistoricalMarcelDecisions(parsed.marcel_items||[],contact.id);
 for(const k of Object.keys(totals.contact))totals.contact[k]+=cs[k]||0; for(const k of Object.keys(totals.marcel))totals.marcel[k]+=ms[k]||0; totals.chunks++; await updateHistoricalBackfillJob(jobId,{status:'running',total_chunks:totalChunks,completed_chunks:totals.chunks,contact_stats:totals.contact,marcel_stats:totals.marcel}); if(start+SIZE>=rows.length)break;
}
await updateHistoricalBackfillJob(jobId,{status:'completed',total_chunks:totalChunks,completed_chunks:totals.chunks,contact_stats:totals.contact,marcel_stats:totals.marcel,completed_at:new Date()}); console.log('Historical Memory Backfill fertig:',{contact:contact.display_name||contact.canonical_name||contact.whatsapp_jid,...totals}); return {status:'completed',...totals};
}

async function scheduleHistoricalMemoryBackfill(payload){await ensureHistoricalBackfillJobsTable();const jobId=`memory-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;const rows=historicalConversationRows(payload.rawText,payload.senderMapping);const totalChunks=historicalChunkCount(rows.length);await pool.query(`INSERT INTO historical_memory_backfill_jobs (job_id,contact_id,status,total_chunks,completed_chunks) VALUES ($1,$2,'queued',$3,0)`,[jobId,payload.contact.id,totalChunks]);setTimeout(()=>{runHistoricalMemoryBackfill({...payload,jobId}).catch(async error=>{console.error('Historical Memory Backfill fehlgeschlagen:',error);try{await updateHistoricalBackfillJob(jobId,{status:'failed',error_text:String(error?.message||error)});}catch{}});},300);return {jobId,totalChunks};}

/* ==================================================
WHATSAPP DUPLICATE CLEANUP V1
Sicherheitsprinzip:
1) preview = nur pruefen, niemals loeschen
2) execute = nur mit exakt passendem confirmationToken
3) es werden ausschliesslich Nachrichten geloescht
4) Memories / Kontakte werden niemals angefasst
5) Cleanup ist an den hochgeladenen WhatsApp-Export gebunden
================================================== */

function duplicateCleanupToken(payload) {
return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function buildWhatsAppDuplicateCleanupPlan({ contact, rawText, senderMapping }) {
const parsed = parseWhatsAppExport(rawText);
if (!parsed.length) throw new Error("Keine WhatsApp-Nachrichten im unterstuetzten Exportformat erkannt.");

const marcelSender = normalizeImportSender(senderMapping?.marcelSender);
const contactSender = normalizeImportSender(senderMapping?.contactSender);
if (!marcelSender || !contactSender || marcelSender === contactSender) {
 throw new Error("Fuer den Cleanup muss die Absender-Zuordnung eindeutig bestaetigt sein.");
}

const senders = [...new Set(parsed.map(item => item.sender))];
const senderSet = new Set(senders.map(normalizeImportSender));
if (!senderSet.has(marcelSender) || !senderSet.has(contactSender)) {
 throw new Error("Die bestaetigten Absender passen nicht zum WhatsApp-Export.");
}

const rowsResult = await pool.query(
 `SELECT id, direction, message_text, created_at, import_source_hash, import_batch_id,
         whatsapp_message_id, processing_status
    FROM messages
   WHERE whatsapp_jid = $1
   ORDER BY created_at ASC, id ASC`,
 [contact.whatsapp_jid]
);
const dbRows = rowsResult.rows;

/*
* CLEANUP V2
*
* Hintergrund:
* - Alte Nachrichten koennen aus dem frueheren Railway-Import stammen.
* - Neue Nachrichten aus dem Dashboard-Import tragen import_source_hash /
*   import_batch_id bzw. processing_status = historical_imported.
* - Beide Importwege koennen fuer dieselbe echte WhatsApp-Nachricht
*   unterschiedliche DB-Zeitpunkte erzeugt haben.
*
* Sicherheitsprinzip:
* Fuer jede einzelne Zeile des hochgeladenen WhatsApp-Exports suchen wir

* getrennt genau EINEN alten/Legacy-Treffer und genau EINEN neuen
* Historical-Import-Treffer. Nur wenn BEIDE fuer dieselbe Exportzeile
* existieren, wird der Historical-Import-Treffer als Dublette markiert.
*
* Dadurch werden gleiche Texte wie "Hola", Herzen usw. nicht global
* zusammengeworfen. Jede DB-Zeile darf nur einmal verwendet werden.
*/
const usedLegacyIds = new Set();
const usedHistoricalIds = new Set();
const candidateDeleteIds = new Set();
const groups = [];

const isHistoricalRow = row =>
 Boolean(
   row.import_source_hash ||
   row.import_batch_id ||
   String(row.processing_status || "").toLowerCase().includes("historical") ||
   String(row.whatsapp_message_id || "").startsWith("historical-")
 );

const nearestUnusedMatch = ({ item, direction, historical }) => {
 const normalizedText = normalizeForDuplicate(item.text);
 if (!normalizedText) return null;

 const exportMs = item.createdAt.getTime();
 const usedIds = historical ? usedHistoricalIds : usedLegacyIds;
 const candidates = dbRows
   .filter(row => {
     const id = Number(row.id);
     if (usedIds.has(id)) return false;
     if (row.direction !== direction) return false;
     if (isHistoricalRow(row) !== historical) return false;
     if (normalizeForDuplicate(row.message_text) !== normalizedText) return false;

     const rowMs = new Date(row.created_at).getTime();
     return Number.isFinite(rowMs) &&
       Math.abs(rowMs - exportMs) <= 18 * 60 * 60 * 1000;
   })      .sort((a, b) => {
     const da = Math.abs(new Date(a.created_at).getTime() - exportMs);
     const db = Math.abs(new Date(b.created_at).getTime() - exportMs);
     if (da !== db) return da - db;
     return Number(a.id) - Number(b.id);
   });

 return candidates[0] || null;
};

for (let exportIndex = 0; exportIndex < parsed.length; exportIndex += 1) {
 const item = parsed[exportIndex];
 const senderKey = normalizeImportSender(item.sender);
 const direction =
   senderKey === marcelSender
     ? "outgoing"
     : senderKey === contactSender
       ? "incoming"
       : null;

 if (!direction) continue;

 const legacy = nearestUnusedMatch({
   item,
   direction,
   historical: false
 });

 const historical = nearestUnusedMatch({
   item,
   direction,
   historical: true
 });

 /*
  * Treffer werden auch dann reserviert, wenn nur eine Seite existiert.
  * So kann dieselbe DB-Zeile nicht spaeter einer wiederholten Nachricht
  * mit identischem Text zugeordnet werden.
  */
 if (legacy) usedLegacyIds.add(Number(legacy.id));
 if (historical) usedHistoricalIds.add(Number(historical.id));

 /*
  * Nur der klare Cross-Source-Fall wird geloescht:
  * dieselbe Exportzeile hat sowohl einen Legacy- als auch einen
  * Historical-Treffer. Der alte Datensatz bleibt, der spaeter durch
  * den Dashboard-Import entstandene Historical-Datensatz wird entfernt.
  */

 if (!legacy || !historical) continue;

 const deleteId = Number(historical.id);
 candidateDeleteIds.add(deleteId);

 groups.push({
   exportIndex,
   direction,
   textPreview: normalizeText(item.text).slice(0, 140),
   exportCreatedAt: item.createdAt.toISOString(),
   keepId: Number(legacy.id),
   keepCreatedAt: new Date(legacy.created_at).toISOString(),
   deleteIds: [deleteId],
   deleteCreatedAt: [new Date(historical.created_at).toISOString()]
 });
}

const deleteIds = [...candidateDeleteIds].sort((a, b) => a - b);
const payload = {
 contactId: Number(contact.id),
 jid: contact.whatsapp_jid,
 parsed: parsed.length,
 databaseMessages: dbRows.length,
 deleteIds
};

return {
 ...payload,
 duplicateGroups: groups.length,
 wouldDelete: deleteIds.length,
 wouldKeep: Math.max(0, dbRows.length - deleteIds.length),
 groups: groups.slice(0, 200),
 confirmationToken: duplicateCleanupToken(payload)
};
}

app.post("/dashboard-api/cleanup-whatsapp-duplicates", async (req, res) => {
try {
 if (!dashboardApiReady(res)) return;
 if (!dashboardApiAuthorized(req)) {
   return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
 }

 const contactId = Number(req.body?.contactId);
 const chatText = String(req.body?.chatText || "");
 const action = normalizeText(req.body?.action).toLowerCase() === "execute" ? "execute" : "preview";
 const suppliedToken = normalizeText(req.body?.confirmationToken);
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

 const plan = await buildWhatsAppDuplicateCleanupPlan({ contact, rawText: chatText, senderMapping });

 if (action !== "execute") {
   return res.json({
     ok: true,
     preview: true,
     contact: { id: contact.id, name: contact.display_name || contact.canonical_name || null, jid: contact.whatsapp_jid },
     parsed: plan.parsed,
     databaseMessages: plan.databaseMessages,
     duplicateGroups: plan.duplicateGroups,
     wouldDelete: plan.wouldDelete,
     wouldKeep: plan.wouldKeep,
     groups: plan.groups,
     confirmationToken: plan.confirmationToken,
     message: plan.wouldDelete > 0

       ? `Pruefung fertig. ${plan.wouldDelete} sichere Dubletten wuerden geloescht. Bis jetzt wurde NICHTS geloescht.`
       : "Pruefung fertig. Keine sicheren Dubletten gefunden. Bis jetzt wurde NICHTS geloescht."
   });
 }

 if (!suppliedToken || suppliedToken !== plan.confirmationToken) {
   return res.status(409).json({
     ok: false,
     code: "CLEANUP_CONFIRMATION_REQUIRED",
     error: "Sicherheitsbestaetigung fehlt oder die Daten haben sich seit der Vorschau geaendert. Bitte Cleanup erneut pruefen.",
     wouldDelete: plan.wouldDelete,
     confirmationToken: plan.confirmationToken
   });
 }

 if (!plan.deleteIds.length) {
   return res.json({ ok: true, deleted: 0, message: "Keine sicheren Dubletten vorhanden. Nichts geloescht." });
 }

 // Noch einmal hart auf denselben Kontakt begrenzen. Es werden NUR messages geloescht.
 const deleted = await pool.query(
   `DELETE FROM messages
     WHERE whatsapp_jid = $1
       AND id = ANY($2::bigint[])
     RETURNING id`,
   [contact.whatsapp_jid, plan.deleteIds]
 );

 console.log("WhatsApp Duplicate Cleanup fertig:", {
   contact: contact.display_name || contact.canonical_name || contact.whatsapp_jid,
   deleted: deleted.rowCount,
   requested: plan.deleteIds.length
 });

 return res.json({
   ok: true,
   deleted: deleted.rowCount,
   remainingEstimate: Math.max(0, plan.databaseMessages - deleted.rowCount),
   memoryTouched: false,
   message: `${deleted.rowCount} sichere Dubletten geloescht. Memories wurden nicht veraendert.`
 });
} catch (error) {
 console.error("WhatsApp Duplicate Cleanup Fehler:", error);
 return res.status(500).json({ ok: false, error: error?.message || "Dubletten-Cleanup fehlgeschlagen." });
}
});

/* ==================================================
DASHBOARD WHATSAPP-EXPORT IMPORT V1
================================================== */

app.post("/dashboard-api/import-whatsapp", async (req, res) => {  try {
 if (!dashboardApiReady(res)) return;
 if (!dashboardApiAuthorized(req)) return res.status(401).json({ ok:false, error:"Nicht autorisiert." });

 const contactId = Number(req.body?.contactId);
 const chatText = String(req.body?.chatText || "");
 const marcelSenderNames = Array.isArray(req.body?.marcelSenderNames) ? req.body.marcelSenderNames : [];
 const senderMapping = req.body?.senderMapping && typeof req.body.senderMapping === "object"
   ? { marcelSender: normalizeText(req.body.senderMapping.marcelSender), contactSender: normalizeText(req.body.senderMapping.contactSender) }
   : null;

 if (!Number.isInteger(contactId) || contactId <= 0) return res.status(400).json({ok:false,error:"Ungueltige Kontakt-ID."});
 if (!chatText.trim()) return res.status(400).json({ok:false,error:"Der WhatsApp-Export ist leer."});

 const contact = (await pool.query(`SELECT * FROM contacts WHERE id=$1 LIMIT 1`,[contactId])).rows[0];

 if (!contact) return res.status(404).json({ok:false,error:"Kontakt nicht gefunden."});

 const action = normalizeText(req.body?.action).toLowerCase() === "import" ? "import" : "preview";
 const result = await importWhatsAppHistory({
   contact, rawText:chatText, marcelSenderNames, senderMapping,
   dryRun: action !== "import", replaceExisting:true
 });

 if (action !== "import") {
   return res.json({
     ok:true, preview:true, replaceExisting:true,
     contact:{id:contact.id,name:contact.display_name||contact.canonical_name||null,jid:contact.whatsapp_jid},
     parsed:result.parsed,
     duplicates:result.existingMessages,
     newMessages:result.wouldImport,
     incoming:result.incoming,outgoing:result.outgoing,
     senders:result.senders,senderMapping:result.senderMapping,
     existingMessages:result.existingMessages,
     wouldDelete:result.wouldDelete,
     wouldImport:result.wouldImport,
     wouldRemain:result.wouldRemain,
     message:`Vorschau fertig. ${result.existingMessages} bisherige Nachrichten werden ersetzt und ${result.wouldImport} Nachrichten aus der TXT neu aufgebaut. Bis jetzt wurde NICHTS veraendert.`
   });
 }

 const backfillJob = result.imported > 0
   ? await scheduleHistoricalMemoryBackfill({contact,rawText:chatText,senderMapping})
   : null;

 return res.json({
   ok:true,replaceExisting:true,
   contact:{id:contact.id,name:contact.display_name||contact.canonical_name||null,jid:contact.whatsapp_jid},
   ...result,
   memoryBackfill:backfillJob
     ? {status:"started",jobId:backfillJob.jobId,totalChunks:backfillJob.totalChunks,message:"WhatsApp-Verlauf ersetzt. Memory-Backfill wurde gestartet."}
     : {status:"skipped",reason:"Keine Nachrichten fuer Memory-Backfill."}
 });
} catch(error) {
 console.error("WhatsApp Authoritative Replace Fehler:",error);
 if(error?.code==="SENDER_CONFIRMATION_REQUIRED") {
   return res.status(409).json({ok:false,code:"SENDER_CONFIRMATION_REQUIRED",error:error?.message||"Absender muessen bestaetigt werden.",senders:Array.isArray(error?.senders)?error.senders:[]});
 }
 return res.status(500).json({ok:false,error:error?.message||"WhatsApp-Export konnte nicht ersetzt werden."});
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
        column => [             column,
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

whatsapp_username:
contact?.whatsapp_username,

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

- Kontakt-ID, Memory Identity Key und bestätigte Identifier
haben Vorrang vor Namensähnlichkeit.

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
SHARED REPLY CORE
================================================== */

async function generateSharedReply({
incomingText,
conversation = "",
memoryContext = "",
resolvedLanguage = null,
extraInstructions = "",
channelLabel = "Chat"
}) {

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
und wie ein echter ${channelLabel}-Chat.

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
WHATSAPP REPLY ADAPTER
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


return generateSharedReply({

incomingText,

conversation,

memoryContext,

resolvedLanguage,

extraInstructions,

channelLabel:
  "WhatsApp"

});

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

      AND memory_key =
        $2

      AND status =
        'active'

    ORDER BY
      updated_at DESC

    LIMIT 1
  `,
  [
    contactId,
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
[     contactId,

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


const value =     item?.memory_value
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

const effectiveValidUntilHours =
  Number.isFinite(
    validUntilHours
  )
    ? Math.max(
        1,
        validUntilHours
      )
    : memoryType === "temporary_state"
      ? 24
      : null;


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
    effectiveValidUntilHours,
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

    )     `,
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
      `|type=${item.memory_type}`
      +
      `|review=${item.human_review_status}`
      +
      `|importance=${item.importance}`
      +
      `|valid_until=${item.valid_until || "-"}`
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


const eventText =
events
  .map(
    event =>
      `ID=${event.id}`
      +
      `|${event.event_type}/${event.event_subtype || "-"}`
      +
      `|status=${event.event_status}`
      +
      `|${renderJson(
        event.event_data
      )}`
      +
      `|evidence=${normalizeText(
        event.evidence_summary
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

${WOMAN_MEMORY_SEMANTIC_CORE}

${WOMAN_MEMORY_LIVE_OUTPUT_RULES}

ZUSAETZLICHE SYSTEMREGELN:
- Neue Fakten erkennen, aber alte Fakten nicht neu speichern.
- Temporaere Zustaende sauber ersetzen/ablaufen lassen.
- Widersprueche nicht blind ueberschreiben.
- Human confirmed/corrected Memory niemals ueberschreiben oder retiren.
- Gleichnamige Frauen nie vermischen. Kontakt-ID, Memory Identity Key und bestätigte Identifier haben Vorrang vor Namensähnlichkeit.
- Frau, Marcel und Dritte strikt trennen.
- marcel_knowledge_map nur fuer Wissen dieser Frau ueber Marcel.
- Wenn die Frau ueberwiegend in einer bestimmten Sprache schreibt und das fuer zukuenftige Antworten relevant ist, darf diese Information im Bereich communication gespeichert werden.
- Progressive Disclosure ist nur eine Antwortregel. Intern darf Memory vollstaendig und praezise sein; der Reply-Bot entscheidet separat, was er preisgibt.
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
AKTUELLE SYSTEMZEIT
==================================================

${new Date().toISOString()}


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
BEREITS GESPEICHERTE EVENTS
==================================================

${eventText || "[keine]"}


==================================================
VERLAUF
==================================================

${history
.slice(
-20
)
.map(
item =>
  `[${new Date(item.created_at).toISOString()}] ${item.direction === "incoming" ? "Sie" : "Marcel"}: ${item.message_text}`
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
DEVICE BRIDGE T0 — PROTOCOL V1 ENROLLMENT ROUTES
================================================== */

const adminEnrollmentCodeHandler =
createAdminEnrollmentCodeHandler(pool);

const deviceEnrollmentHandler =
createDeviceEnrollmentHandler(pool);

app.post(
  "/dashboard-api/device-bridge/enrollment-codes",
  async (req, res) => {

    if (!dashboardApiReady(res)) return;

    if (!dashboardApiAuthorized(req)) {
      return res.status(401).json({
        ok: false,
        error: "Nicht autorisiert."
      });
    }

    if (!requireDeviceBridgeReady(res)) return;

    return adminEnrollmentCodeHandler(req, res);

  }
);

app.post(
  "/device-bridge/v1/enroll",
  deviceEnrollmentHandler
);

registerDeviceBridgeBlock3Routes({
  app,
  pool,
  dashboardApiReady,
  dashboardApiAuthorized,
  requireDeviceBridgeReady
});


/* ==================================================
DASHBOARD KONTAKT-STAMMDATEN
- manuelle Werte haben Vorrang vor Seeds
- Geburtsdatum -> Alter wird dynamisch berechnet
- intern weiterhin kanonische Bot-Werte
================================================== */

function dashboardContactError(
message,
statusCode = 400
) {

const error =
new Error(
  message
);

error.statusCode =
statusCode;

return error;

}


function normalizeDashboardPhoneNumber(
value
) {

const digits =
String(
  value
  ??
  ""
)
  .replace(
    /\D/g,
    ""
  );


if (!digits) {
return null;
}


if (
digits.length < 7
||
digits.length > 16
) {

throw dashboardContactError(
  "Die Telefonnummer ist ungültig."
);

}


return digits;

}



function normalizeDashboardWhatsAppUsername(
value
) {

const clean =
normalizeText(
  value
);

if (!clean) {
return null;
}

const username =
clean
  .replace(/^https?:\/\/(?:www\.)?wa\.me\//i, "")
  .replace(/^@+/, "")
  .trim();

if (
!username
||
username.length > 100
||
/\s/.test(username)
) {
throw dashboardContactError(
  "Der WhatsApp-Username ist ungültig."
);
}

return `@${username}`;
}


function normalizeDashboardCountryValue(
value
) {

const clean =
normalizeText(
  value
);

if (!clean) {
return null;
}

const normalized =
normalizeIdentityValue(
  clean
);

const map = {
"deutschland":
  "Germany",
"germany":
  "Germany",
"kolumbien":
  "Colombia",
"colombia":
  "Colombia",
"spanien":
  "Spain",
"spain":
  "Spain",
"kenia":
  "Kenya",
"kenya":
  "Kenya",
"tschechien":
  "Czech Republic",
"czech republic":
  "Czech Republic",
"philippinen":
  "Philippines",
"philippines":
  "Philippines",
"mexiko":
  "Mexico",
"mexico":
  "Mexico",
"osterreich":
  "Austria",
"österreich":
  "Austria",
"austria":
  "Austria"
};

return map[normalized]
||
clean;

}


function normalizeDashboardCityValue(
value
) {

const clean =
normalizeText(
  value
);

if (!clean) {
return null;
}

const normalized =
normalizeIdentityValue(
  clean
);

if (
normalized === "munchen"
||
normalized === "muenchen"
||
normalized === "munich"
) {
return "Munich";
}

return clean;

}


function normalizeDashboardLanguageValue(
value
) {

const clean =
normalizeText(
  value
);

if (!clean) {
return null;
}

const normalized =
normalizeIdentityValue(
  clean
);

if (
[
  "spanisch",
  "spanish",
  "espanol",
  "español"
].includes(
  normalized
)
) {
return "Spanish";
}

if (
[
  "deutsch",
  "german"
].includes(
  normalized
)
) {
return "German";
}

if (
[
  "englisch",
  "english"
].includes(
  normalized
)
) {
return "English";
}

return clean;

}


function dashboardIntegerOrNull(
value,
min,
max
) {

if (
value === undefined
||
value === null
||
normalizeText(
  value
) === ""
) {
return null;
}

const number =
Number(
  value
);

if (
!Number.isInteger(
  number
)
||
number < min
||
number > max
) {
return false;
}

return number;

}


function dashboardBirthMonthNumber(
value
) {

const numeric =
dashboardIntegerOrNull(
  value,
  1,
  12
);

if (
numeric !== null
&&
numeric !== false
) {
return numeric;
}

const normalized =
normalizeIdentityValue(
  value
)
  .replace(
    /\./g,
    ""
  );

const months = {
january: 1,
januar: 1,
enero: 1,
february: 2,
februar: 2,
febrero: 2,
march: 3,
marz: 3,
maerz: 3,
marzo: 3,
april: 4,
abril: 4,
may: 5,
mai: 5,
mayo: 5,
june: 6,
juni: 6,
junio: 6,
july: 7,
juli: 7,
julio: 7,
august: 8,
agosto: 8,
september: 9,
septiembre: 9,
october: 10,
oktober: 10,
octubre: 10,
november: 11,
noviembre: 11,
december: 12,
dezember: 12,
diciembre: 12
};

return months[normalized]
||
null;

}


function dashboardBirthdayPartsValid(
day,
month,
year = 2000
) {

if (
!Number.isInteger(
  day
)
||

!Number.isInteger(
  month
)
||
!Number.isInteger(
  year
)
) {
return false;
}

const date =
new Date(
  Date.UTC(
    year,
    month - 1,
    day
  )
);

return (
date.getUTCFullYear() === year
&&
date.getUTCMonth() === month - 1
&&
date.getUTCDate() === day
);

}


function dashboardNormalizeBirthYear(
value
) {

const year =
dashboardIntegerOrNull(
  value,
  1900,
  2200
);

return year;

}


function dashboardParseBirthdayText(
value
) {

const text =
normalizeText(
  value
);

if (!text) {
return {};
}

let match =
text.match(
  /^(\d{4})-(\d{1,2})-(\d{1,2})$/
);

if (match) {
return {
  year:
    Number(
      match[1]
    ),
  month:
    Number(
      match[2]
    ),
  day:
    Number(
      match[3]
    )
};
}

match =
text.match(
  /^(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{4}))?$/
);

if (match) {
return {
  day:
    Number(
      match[1]
    ),
  month:
    Number(
      match[2]
    ),
  ...(match[3]
    ? {
        year:
          Number(
            match[3]
          )
      }
    : {})
};
}

match =
text.match(
  /^(\d{1,2})\.?\s+(?:de\s+)?([\p{L}.]+)(?:\s+(?:de\s+)?(\d{4}))?$/iu
);

if (match) {
const month =
  dashboardBirthMonthNumber(
    match[2]
  );

if (month) {
  return {
    day:
      Number(
        match[1]
      ),
    month,
    ...(match[3]
      ? {
          year:
            Number(
              match[3]
            )
        }
      : {})
  };
}
}

match =
text.match(
  /^([\p{L}.]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/iu
);

if (match) {
const month =
  dashboardBirthMonthNumber(
    match[1]
  );

if (month) {
  return {
    day:
      Number(
        match[2]
      ),
    month,
    ...(match[3]
      ? {
          year:
            Number(
              match[3]
            )
        }
      : {})
  };
}
}

return {};

}


function dashboardBirthdayKeyKind(
value
) {

const key =
normalizeIdentityValue(
  value
)
  .replace(
    /[^a-z0-9]+/g,
    "_"
  )
  .replace(
    /^_+|_+$/g,
    ""
  );

if (
[
  "birthday",
  "birthdate",
  "birthday_date",
  "birth_date",
  "date_birth",
  "date_of_birth",
  "dob",
  "fecha_de_nacimiento",
  "fecha_nacimiento"
].includes(
  key
)
) {
return "birthday";
}

if (
[
  "birth_day",
  "birthday_day",
  "day_of_birth"
].includes(
  key
)
) {
return "day";
}

if (
[
  "birth_month",
  "birthday_month",
  "month_of_birth"
].includes(
  key
)
) {
return "month";
}

if (
[
  "birth_year",
  "birthday_year",
  "year_of_birth"
].includes(
  key
)
) {
return "year";
}

return null;

}


function collectDashboardBirthdayParts(
value,
output = {},

keyHint = "",
birthdayContext = false,
depth = 0
) {

if (
value === undefined
||
value === null
||
depth > 7
) {
return output;
}

const kind =
dashboardBirthdayKeyKind(
  keyHint
);

const inBirthday =
birthdayContext
||
kind === "birthday";


if (
typeof value !== "object"
||
Array.isArray(
  value
)
) {

if (kind === "birthday") {
  const parsed =
    dashboardParseBirthdayText(
      value
    );

  if (
    output.day == null
    &&
    parsed.day
  ) {
    output.day =
      parsed.day;
  }

  if (
    output.month == null
    &&
    parsed.month
  ) {
    output.month =
      parsed.month;
  }

  if (
    output.year == null
    &&
    parsed.year
  ) {
    output.year =
      parsed.year;
  }
}

if (
  kind === "day"
  &&
  output.day == null
) {
  const day =
    dashboardIntegerOrNull(
      value,
      1,
      31
    );

  if (
    day !== false
    &&
    day !== null
  ) {
    output.day =
      day;
  }
}

if (
  kind === "month"
  &&
  output.month == null
) {
  const month =
    dashboardBirthMonthNumber(
      value
    );

  if (month) {
    output.month =
      month;
  }
}

if (
  kind === "year"
  &&
  output.year == null
) {
  const year =
    dashboardNormalizeBirthYear(
      value
    );

  if (
    year !== false
    &&
    year !== null
  ) {
    output.year =
      year;
  }
}

return output;
}


if (
isPlainObject(
  value
)
) {

for (
  const [
    childKey,
    childValue
  ]
  of Object.entries(
    value
  )
) {

  const normalizedChild =
    normalizeIdentityValue(
      childKey
    )
      .replace(
        /[^a-z0-9]+/g,
        "_"
      );

  const childKind =
    dashboardBirthdayKeyKind(
      childKey
    );

  if (
    inBirthday
    &&
    childKind == null
    &&
    [
      "day",
      "date"
    ].includes(
      normalizedChild
    )
  ) {
    const day =
      dashboardIntegerOrNull(
        childValue,
        1,
        31
      );

    if (
      output.day == null
      &&
      day !== false
      &&
      day !== null
    ) {
      output.day =
        day;
    }

    continue;
  }

  if (
    inBirthday
    &&
    childKind == null
    &&
    normalizedChild === "month"
  ) {
    const month =
      dashboardBirthMonthNumber(
        childValue
      );

    if (
      output.month == null
      &&
      month
    ) {
      output.month =
        month;
    }

    continue;
  }

  if (
    inBirthday
    &&
    childKind == null
    &&
    normalizedChild === "year"
  ) {
    const year =
      dashboardNormalizeBirthYear(

        childValue
      );

    if (
      output.year == null
      &&
      year !== false
      &&
      year !== null
    ) {
      output.year =
        year;
    }

    continue;
  }

  collectDashboardBirthdayParts(
    childValue,
    output,
    childKey,
    inBirthday,
    depth + 1
  );
}
}

return output;

}


function dashboardAgeFromValue(
value
) {

if (
value === undefined
||
value === null
) {
return null;
}

if (
typeof value === "number"
||
typeof value === "string"
) {
const match =
  String(
    value
  )
    .match(
      /\b(1[89]|[2-9]\d|1[0-2]\d)\b/
    );

return match
  ? Number(
      match[1]
    )
  : null;
}

if (
isPlainObject(
  value
)
) {
for (
  const key
  of [
    "age",
    "years",
    "value"
  ]
) {
  if (
    Object.prototype.hasOwnProperty.call(
      value,
      key
    )
  ) {
    const age =
      dashboardAgeFromValue(
        value[key]
      );

    if (age != null) {
      return age;
    }
  }
}
}

return null;

}


function dashboardReportedAge(
profile,
memoryItems = []
) {

const items =
Array.isArray(
  memoryItems
)

  ? memoryItems

  : [];


const ageFromItems = (
requireHumanReview
) => {

for (
  const item
  of items
) {

  const key =
    normalizeIdentityValue(
      item?.memory_key
      ??
      item?.key
    )
      .replace(
        /[^a-z0-9]+/g,
        "_"
      );

  if (
    ![
      "age",
      "current_age"
    ].includes(
      key
    )
  ) {
    continue;
  }

  const reviewStatus =
    item?.human_review_status
    ??
    item?.reviewStatus
    ??
    null;

  if (
    requireHumanReview
    &&
    ![
      "confirmed",
      "corrected"
    ].includes(
      reviewStatus
    )
  ) {
    continue;
  }

  const value =
    reviewStatus === "corrected"
    &&
    (
      item?.human_corrected_value
      ??
      item?.humanCorrectedValue
    )

      ? (
          item?.human_corrected_value
          ??
          item?.humanCorrectedValue
        )

      : (
          item?.memory_value
          ??
          item?.value
        );

  const age =
    dashboardAgeFromValue(
      value
    );

  if (age != null) {
    return age;
  }
}

return null;
};


const humanAge =
ageFromItems(
  true
);

if (humanAge != null) {
return humanAge;
}


const direct =
dashboardAgeFromValue(
  profile?.profile_summary?.age
);

if (direct != null) {
return direct;
}


return ageFromItems(
false
);

}

function dashboardTodayParts() {

const parts =
new Intl.DateTimeFormat(
  "en-CA",
  {
    timeZone:
      "Europe/Berlin",
    year:
      "numeric",
    month:
      "2-digit",

    day:
      "2-digit"
  }
)
  .formatToParts(
    new Date()
  );

const values =
Object.fromEntries(
  parts.map(
    part => [
      part.type,
      part.value
    ]
  )
);

return {
year:
  Number(
    values.year
  ),
month:
  Number(
    values.month
  ),
day:
  Number(
    values.day
  )
};

}


function calculateDashboardAge(
day,
month,
year,
today = dashboardTodayParts()
) {

if (
!dashboardBirthdayPartsValid(
  day,
  month,
  year
)
) {
return null;
}

let age =
today.year
-
year;

const birthdayPassed =
today.month > month
||
(
  today.month === month
  &&
  today.day >= day
);

if (!birthdayPassed) {
age -= 1;
}

return age >= 0
? age
: null;

}


function inferDashboardBirthYear(
day,
month,
age,
today = dashboardTodayParts()
) {

if (
!Number.isInteger(
  age
)
||
age < 0
||
!dashboardBirthdayPartsValid(
  day,
  month,
  2000
)
) {
return null;
}

const birthdayPassed =
today.month > month
||
(
  today.month === month
  &&
  today.day >= day
);

return birthdayPassed
? today.year - age
: today.year - age - 1;

}


function resolveContactBirthdayData({
contact = {},
profile = {},
memoryItems = []
} = {}) {

const extracted = {};

collectDashboardBirthdayParts(
profile,
extracted,
"profile"
);

for (
const item
of Array.isArray(
  memoryItems
)
  ? memoryItems
  : []
) {

const value =
  item?.human_review_status === "corrected"
  &&
  item?.human_corrected_value

    ? item.human_corrected_value

    : (
        item?.memory_value
        ??
        item?.value
      );

collectDashboardBirthdayParts(
  value,
  extracted,
  item?.memory_key
  ??
  item?.key
  ??
  ""
);
}

const contactDay =
dashboardIntegerOrNull(
  contact?.birth_day
  ??
  contact?.birthDay,
  1,
  31
);

const contactMonth =
dashboardIntegerOrNull(
  contact?.birth_month
  ??
  contact?.birthMonth,
  1,
  12
);

const contactYear =
dashboardNormalizeBirthYear(
  contact?.birth_year
  ??
  contact?.birthYear
);

const birthDay =
contactDay !== false
&&
contactDay !== null

  ? contactDay

  : (
      extracted.day
      ||
      null
    );

const birthMonth =
contactMonth !== false
&&
contactMonth !== null

  ? contactMonth

  : (
      extracted.month
      ||
      null
    );

const actualBirthYear =
contactYear !== false
&&
contactYear !== null

  ? contactYear

  : (
      extracted.year
      ||
      null
    );

const reportedAge =
dashboardReportedAge(
  profile,
  memoryItems
);

let suggestedBirthYear =
null;

if (
!actualBirthYear
&&
birthDay
&&
birthMonth
&&
reportedAge != null
) {
suggestedBirthYear =
  inferDashboardBirthYear(

    birthDay,
    birthMonth,
    reportedAge
  );
}

const effectiveYear =
actualBirthYear
||
suggestedBirthYear;

const age =
effectiveYear
&&
birthDay
&&
birthMonth

  ? calculateDashboardAge(
      birthDay,
      birthMonth,
      effectiveYear
    )

  : reportedAge;

const storedYearInferred =
Boolean(
  contact?.birth_year_inferred
  ??
  contact?.birthYearInferred
);

return {
birthDay,
birthMonth,
birthYear:
  actualBirthYear,
suggestedBirthYear,
effectiveBirthYear:
  effectiveYear,
birthYearInferred:
  actualBirthYear
    ? storedYearInferred
    : Boolean(
        suggestedBirthYear
      ),
age:
  age == null
    ? null
    : Number(
        age
      ),
reportedAge
};

}


function dashboardBirthdayLabel(
birthday,
{
includeInferredYear = false
} = {}
) {

const day =
birthday?.birthDay;

const month =
birthday?.birthMonth;

if (
!day
||
!month
) {
return null;
}

const months = [
"",
"Januar",
"Februar",
"März",
"April",
"Mai",
"Juni",
"Juli",
"August",
"September",
"Oktober",
"November",
"Dezember"
];

const showYear =
birthday.birthYear
&&
(
  includeInferredYear
  ||
  birthday.birthYearInferred !== true
);

return (
`${day}. ${months[month]}`
+
(
  showYear
    ? ` ${birthday.birthYear}`
    : ""
)
);

}


function createDashboardContactIdentityKey(
name
) {

const base =
normalizeIdentityValue(
  name
)
  .replace(
    /[^a-z0-9]+/g,
    "_"
  )
  .replace(
    /^_+|_+$/g,
    ""
  )
  .slice(
    0,
    48
  )
||
"kontakt";

return (
"dashboard_"
+
base
+
"_"
+
Date.now()
+
"_"
+
crypto
  .randomBytes(
    3
  )
  .toString(
    "hex"
  )
);

}


async function upsertDashboardVerifiedContactMemory({
contactId,
category,
memoryKey,
memoryValue,
importance = 5,
note = "Von Marcel im Dashboard als Kontaktdatum bestätigt."
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

      status =
        'active',

      valid_until =
        NULL,

      human_review_status =
        'confirmed',

      human_corrected_value =
        NULL,

      human_note =
        $3,

      human_reviewed_at =
        NOW(),

      importance =
        GREATEST(

          importance,
          $4
        ),

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
    note,
    clampImportance(
      importance
    )
  ]
);

return;
}

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
    $5,
    NOW(),
    $6,
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
  note,
  clampImportance(
    importance
  )
]
);

}


async function syncDashboardBirthdayProfile({
contactId,
birthDay,
birthMonth,
birthYear,
birthYearInferred
}) {

if (
!birthDay
||
!birthMonth
) {
return;
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
  contactId
]
);

const current =
await pool.query(
  `
    SELECT profile_summary

    FROM contact_memory_profiles

    WHERE contact_id =
      $1

    LIMIT 1
  `,
  [
    contactId
  ]
);

const summary =
isPlainObject(
  current.rows[0]?.profile_summary
)

  ? {
      ...current.rows[0].profile_summary
    }

  : {};

summary.birth_day =
birthDay;

summary.birth_month =
birthMonth;

if (birthYear) {
summary.birth_year =
  birthYear;
}

summary.birthday = {
...(isPlainObject(
  summary.birthday
)
  ? summary.birthday
  : {}),
day:
  birthDay,
month:
  birthMonth,
...(birthYear
  ? {
      year:
        birthYear
    }
  : {}),
...(birthYearInferred
  ? {
      year_inferred:
        true
    }
  : {})
};

await pool.query(
`
  UPDATE contact_memory_profiles

  SET
    profile_summary =
      $2::jsonb,

    profile_version =
      profile_version + 1,

    updated_at =
      NOW()

  WHERE contact_id =
    $1
`,
[
  contactId,
  JSON.stringify(
    summary
  )
]
);

}


function dashboardContactBirthInput(
body = {},
fallback = {}
) {

const day =
dashboardIntegerOrNull(
  body.birthDay,
  1,
  31
);

const month =
dashboardIntegerOrNull(
  body.birthMonth,
  1,
  12
);

const year =
dashboardNormalizeBirthYear(
  body.birthYear
);

const age =
dashboardIntegerOrNull(
  body.age,
  0,
  130
);

if (
day === false
||
month === false
||
year === false
||
age === false
) {

throw dashboardContactError(
  "Geburtstag oder Alter ist ungültig."
);
}

const effectiveDay =
day
??
fallback.birthDay
??
null;

const effectiveMonth =
month
??
fallback.birthMonth
??
null;

let effectiveYear =
year
??
fallback.birthYear
??
null;

let inferred =
Boolean(
  body.birthYearInferred
);

const ageForInference =
age
??
fallback.age
??
null;

if (
effectiveDay
&&
effectiveMonth
&&
effectiveYear
&&
!dashboardBirthdayPartsValid(
  effectiveDay,
  effectiveMonth,
  effectiveYear
)
) {
throw dashboardContactError(
  "Das Geburtsdatum ist ungültig."
);
}

if (
effectiveDay
&&
effectiveMonth
&&
!effectiveYear
&&
ageForInference != null
) {
effectiveYear =
  inferDashboardBirthYear(
    effectiveDay,
    effectiveMonth,
    ageForInference
  );

inferred =
  true;
}

if (
effectiveDay
&&
effectiveMonth
&&
effectiveYear
&&
age != null
) {
const calculated =
  calculateDashboardAge(
    effectiveDay,
    effectiveMonth,
    effectiveYear
  );

if (
  calculated != null
  &&
  calculated !== age
) {
  throw dashboardContactError(
    `Alter und Geburtsdatum passen nicht zusammen. Aus dem Datum ergibt sich aktuell ${calculated}.`
  );
}
}

return {
birthDay:
  effectiveDay,
birthMonth:
  effectiveMonth,
birthYear:
  effectiveYear,
birthYearInferred:
  Boolean(
    effectiveYear
    &&
    inferred
  ),
age:
  effectiveDay
  &&
  effectiveMonth
  &&
  effectiveYear

    ? calculateDashboardAge(
        effectiveDay,
        effectiveMonth,
        effectiveYear
      )

    : ageForInference
};

}


async function syncDashboardReportedAgeProfile({
contactId,
age
}) {

if (
age == null
) {
return;
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
  contactId
]
);

const current =
await pool.query(
  `
    SELECT profile_summary
    FROM contact_memory_profiles
    WHERE contact_id = $1
    LIMIT 1
  `,
  [
    contactId
  ]
);

const summary =
isPlainObject(
  current.rows[0]?.profile_summary
)
  ? {
      ...current.rows[0].profile_summary
    }
  : {};

summary.age =
age;

await pool.query(
`
  UPDATE contact_memory_profiles
  SET
    profile_summary = $2::jsonb,
    profile_version = profile_version + 1,
    updated_at = NOW()
  WHERE contact_id = $1
`,
[
  contactId,
  JSON.stringify(
    summary
  )
]
);

}


async function retireDashboardReportedAgeMemory(
contactId
) {

await pool.query(
`
  UPDATE memory_items
  SET
    status = 'superseded',
    valid_until = COALESCE(valid_until, NOW()),
    updated_at = NOW()
  WHERE contact_id = $1

    AND category = 'profile_summary'
    AND memory_key = 'age'
    AND status = 'active'
    AND human_note = 'Von Marcel im Dashboard als Kontaktdatum bestätigt.'
`,
[
  contactId
]
);

}


async function applyDashboardContactHumanFacts({
contactId,
city,
country,
language,
birthday,
age
}) {

if (city) {
await upsertDashboardVerifiedContactMemory({
  contactId,
  category:
    "profile_summary",
  memoryKey:
    "city",
  memoryValue: {
    city
  },
  importance:
    4
});
}

if (country) {
await upsertDashboardVerifiedContactMemory({
  contactId,
  category:
    "profile_summary",
  memoryKey:
    "country",
  memoryValue: {
    country
  },
  importance:
    4
});
}

if (language) {
await upsertDashboardVerifiedContactMemory({
  contactId,
  category:
    "communication",
  memoryKey:
    "primary_language",
  memoryValue: {
    language
  },
  importance:
    5
});
}

if (
age != null
&&
!(
  birthday?.birthDay
  &&
  birthday?.birthMonth
  &&
  birthday?.birthYear
)
) {
await upsertDashboardVerifiedContactMemory({
  contactId,
  category:
    "profile_summary",
  memoryKey:
    "age",
  memoryValue: {
    years:
      age
  },
  importance:
    5
});

await syncDashboardReportedAgeProfile({
  contactId,
  age
});
}

if (
birthday?.birthDay
&&
birthday?.birthMonth
&&
birthday?.birthYear
) {
await retireDashboardReportedAgeMemory(
  contactId
);
}

if (
birthday?.birthDay
&&
birthday?.birthMonth
) {
await upsertDashboardVerifiedContactMemory({
  contactId,
  category:
    "profile_summary",
  memoryKey:
    "birthday",
  memoryValue: {
    day:
      birthday.birthDay,
    month:
      birthday.birthMonth,
    ...(birthday.birthYear
      ? {
          year:
            birthday.birthYear
        }
      : {}),
    ...(birthday.birthYearInferred
      ? {
          birth_year_inferred:
            true
        }
      : {})
  },
  importance:
    5
});

await syncDashboardBirthdayProfile({
  contactId,
  ...birthday
});
}

}


/* ==================================================
DASHBOARD INHALTS-UEBERSETZUNG DEUTSCH
- nur Praesentationsschicht
- Bot-/Memory-Originale bleiben unveraendert
- persistenter Cache nach Inhalt + Kontext
================================================== */

let dashboardContentTranslationTableReady = false;

async function ensureDashboardContentTranslationTable() {

if (dashboardContentTranslationTableReady) {
return;
}

await pool.query(`
CREATE TABLE IF NOT EXISTS dashboard_content_translations (
  cache_key TEXT PRIMARY KEY,
  source_text TEXT NOT NULL,
  context_hint TEXT,
  translation_de TEXT NOT NULL,
  translation_model TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
)
`);


dashboardContentTranslationTableReady = true;
}

function dashboardContentTranslationKey(
text,
contextHint = "dashboard"
) {

return crypto
.createHash("sha256")
.update(
  `${normalizeText(contextHint)}\n${normalizeText(text)}`,
  "utf8"
)
.digest("hex");
}

function dashboardTextNeedsTranslation(
value
) {

const text =
normalizeText(value);

if (
!text
||
!/[\p{L}]/u.test(text)
) {
return false;
}

if (
/^(https?:\/\/|www\.)/i.test(text)
||
/^@\S+$/.test(text)
||
/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)
) {
return false;
}

return true;
}

function collectDashboardTranslationLeaves(
value,
contextHint,
target
) {

if (typeof value === "string") {

if (
  !dashboardTextNeedsTranslation(value)
) {
  return;
}

const sourceText =
  normalizeText(value);

const cacheKey =
  dashboardContentTranslationKey(
    sourceText,
    contextHint
  );

if (!target.has(cacheKey)) {
  target.set(
    cacheKey,
    {
      cacheKey,
      sourceText,
      contextHint
    }
  );
}

return;
}

if (Array.isArray(value)) {

for (const item of value) {
  collectDashboardTranslationLeaves(
    item,
    `${contextHint}[]`,
    target     );
}

return;
}

if (
value
&&
typeof value === "object"
) {

for (
  const [key, item]
  of Object.entries(value)
) {

  collectDashboardTranslationLeaves(
    item,
    `${contextHint}.${key}`,
    target
  );
}
}
}

function applyDashboardTranslationLeaves(
value,
contextHint,
translations
) {

if (typeof value === "string") {

if (
  !dashboardTextNeedsTranslation(value)
) {
  return value;
}

const sourceText =
  normalizeText(value);

const cacheKey =
  dashboardContentTranslationKey(
    sourceText,
    contextHint
  );

return (
  translations.get(cacheKey)
  ||
  value
);
}

if (Array.isArray(value)) {

return value.map(
  item =>
    applyDashboardTranslationLeaves(
      item,
      `${contextHint}[]`,
      translations
    )
);
}

if (
value
&&
typeof value === "object"
) {

return Object.fromEntries(
  Object.entries(value)
    .map(
      ([key, item]) => [
        key,
        applyDashboardTranslationLeaves(
          item,
          `${contextHint}.${key}`,
          translations
        )
      ]
    )
);
}

return value;
}

function dashboardTranslationBatches(
entries,
maxItems = 35,
maxCharacters = 12000
) {

const batches = [];
let current = [];
let characters = 0;

for (const entry of entries) {

const size =
  entry.sourceText.length
  +
  entry.contextHint.length;

if (
  current.length
  &&
  (
    current.length >= maxItems
    ||
    characters + size > maxCharacters
  )
) {

  batches.push(current);
  current = [];
  characters = 0;
}

current.push(entry);
characters += size;
}

if (current.length) {

batches.push(current);
}

return batches;
}

async function saveDashboardTranslationCacheRows(
rows
) {

if (!rows.length) {
return;
}

const values = [];
const placeholders = [];

rows.forEach(
(row, index) => {

  const base =
    index * 5;

  placeholders.push(
    `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`
  );

  values.push(
    row.cacheKey,
    row.sourceText,
    row.contextHint,
    row.translationDe,
    MODEL
  );
}
);

await pool.query(
`
  INSERT INTO dashboard_content_translations (
    cache_key,
    source_text,
    context_hint,
    translation_de,
    translation_model
  )
  VALUES ${placeholders.join(",")}
  ON CONFLICT (cache_key)
  DO UPDATE SET
    source_text = EXCLUDED.source_text,
    context_hint = EXCLUDED.context_hint,       translation_de = EXCLUDED.translation_de,
    translation_model = EXCLUDED.translation_model,
    updated_at = NOW()
`,
values
);
}

async function translateDashboardValueListToGerman(
entries = []
) {

const originals =
entries.map(
  entry => entry?.value
);

if (!entries.length) {
return originals;
}

try {

await ensureDashboardContentTranslationTable();

const leaves =
  new Map();

entries.forEach(
  (entry, index) => {

    collectDashboardTranslationLeaves(
      entry?.value,
      normalizeText(
        entry?.contextHint
      )
      ||
      `dashboard.${index}`,
      leaves
    );
  }
);

const uniqueEntries =
  [...leaves.values()];

if (!uniqueEntries.length) {
  return originals;
}

const translations =
  new Map();

const cacheKeys =
  uniqueEntries.map(
    entry => entry.cacheKey
  );

const cachedResult =
  await pool.query(
    `
      SELECT
        cache_key,
        translation_de
      FROM dashboard_content_translations
      WHERE cache_key = ANY($1::text[])
    `,
    [cacheKeys]
  );

for (
  const row
  of cachedResult.rows
) {

  if (
    normalizeText(
      row.translation_de
    )
  ) {

    translations.set(
      row.cache_key,
      row.translation_de
    );
  }
}

const missing =
  uniqueEntries.filter(
    entry =>
      !translations.has(
        entry.cacheKey
      )
  );

const batches =
  dashboardTranslationBatches(
    missing
  );

for (const batch of batches) {

  try {

    const numbered =
      batch.map(
        (entry, index) => ({
          id:
            index + 1,
          context:
            entry.contextHint,
          text:
            entry.sourceText
        })
      );

    const response =
      await openai.responses.create({
        model:
          MODEL,
        instructions: `
Du bist die reine Deutsch-Praesentationsschicht fuer Marcels privates WhatsApp-Dashboard.

Die gelieferten Texte stammen aus internem Bot-Memory, Profilen, Events oder Live-State.
Uebersetze jeden gelieferten TEXT natuerlich und vollstaendig ins Deutsche.
Die internen Bot-Daten bleiben Englisch; du erzeugst ausschliesslich die deutsche Anzeige.

REGELN:
- Englisch, Spanisch und gemischte Texte ins Deutsche uebersetzen.
- Bereits korrektes Deutsch unveraendert lassen.
- Keine Fakten erfinden, ergaenzen, bewerten oder abschwaechen.
- Ganze Aussagen sinngemaess uebersetzen, niemals einzelne Woerter zu Mischsaetzen zusammenbauen.
- Namen, WhatsApp-Namen, Handles, Emojis, URLs, Telefonnummern und erkennbare Eigennamen erhalten.
- Orts- und Laendernamen in der im Deutschen ueblichen Form anzeigen, wenn es eine etablierte deutsche Form gibt, z.B. Munich -> Muenchen, Germany -> Deutschland, Colombia -> Kolumbien. Medellin/Medellín bleibt Medellín.
- Sprachbezeichnungen deutsch anzeigen, z.B. Spanish -> Spanisch, English -> Englisch.
- Status- und Zeitangaben natuerlich deutsch anzeigen, z.B. planned -> geplant, approximately 6 to 8 weeks -> ungefaehr 6 bis 8 Wochen.
- Sexuelle, romantische oder derbe Inhalte in ihrer Bedeutung erhalten; weder entschaerfen noch verschaerfen.
- CONTEXT dient nur zum Verstehen. CONTEXT selbst nicht uebersetzen oder ausgeben.

Antworte ausschliesslich mit gueltigem JSON:
{"translations":[{"id":1,"de":"Deutsche Anzeige"}]}
Fuer jede gelieferte ID genau einen Eintrag liefern.
`,
        input:
          JSON.stringify({
            items:
              numbered
          })
      });

    const parsed =
      safeJsonParse(
        response.output_text,
        {
          translations:
            []
        }
      );

    const returned =
      Array.isArray(
        parsed?.translations
      )
      ? parsed.translations
      : [];

    const byId =
      new Map(
        returned
          .map(
            item => [
              Number(
                item?.id
              ),
              normalizeText(
                item?.de
              )
            ]
          )
          .filter(               ([id, german]) =>
              Number.isInteger(id)
              &&
              id > 0
              &&
              Boolean(german)
          )
      );

    const rowsToCache = [];

    batch.forEach(
      (entry, index) => {

        const german =
          byId.get(
            index + 1
          );

        if (!german) {
          return;
        }

        translations.set(
          entry.cacheKey,
          german
        );

        rowsToCache.push({
          cacheKey:
            entry.cacheKey,
          sourceText:
            entry.sourceText,
          contextHint:
            entry.contextHint,
          translationDe:
            german
        });
      }
    );

    await saveDashboardTranslationCacheRows(
      rowsToCache
    );

  } catch (error) {


    console.error(
      "Dashboard-Inhaltsübersetzung Batch-Fehler:",
      error
    );
  }
}

return entries.map(
  (entry, index) =>
    applyDashboardTranslationLeaves(
      entry?.value,
      normalizeText(
        entry?.contextHint
      )
      ||
      `dashboard.${index}`,
      translations
    )
);

} catch (error) {

console.error(
  "Dashboard-Inhaltsübersetzung Fehler:",
  error
);

return originals;
}
}

/* ==================================================
DASHBOARD STRUKTUR-PRAESENTATION DEUTSCH
- fuer Memory-/Event-JSON
- uebersetzt auch semantische Objekt-Schluessel
- Originalwerte bleiben nur im Bot-/Memory-System
================================================== */

function dashboardStructuredValueNeedsTranslation(
value
) {

if (value == null) {
return false;
}

if (typeof value === "string") {
return dashboardTextNeedsTranslation(value);
}

if (
typeof value === "number"
||
typeof value === "boolean"
) {
return false;
}

if (Array.isArray(value)) {
return value.length > 0;
}

if (typeof value === "object") {
return Object.keys(value).length > 0;
}

return false;
}

function dashboardJsonTypeMatches(
sourceValue,
translatedValue
) {

if (sourceValue === null) {
return translatedValue === null;
}

if (Array.isArray(sourceValue)) {
return Array.isArray(translatedValue);
}

if (typeof sourceValue === "object") {
return (
  translatedValue
  &&
  typeof translatedValue === "object"
  &&
  !Array.isArray(translatedValue)
);
}

return (
typeof sourceValue
===
typeof translatedValue
);
}

function dashboardStructuredSourceText(
value
) {

try {
return JSON.stringify(value);
} catch {
return renderJson(value);
}
}

async function translateDashboardStructuredValueListToGerman(
entries = []
) {

const originals =
entries.map(
  entry => entry?.value
);

if (!entries.length) {
return originals;
}

try {

await ensureDashboardContentTranslationTable();

const prepared =
  entries.map(
    (entry, index) => {

      const contextHint =
        `structured|${normalizeText(entry?.contextHint) || `dashboard.${index}`}`;
      const value =
        entry?.value;

      const sourceText =
        dashboardStructuredSourceText(
          value
        );

      return {
        value,
        contextHint,
        sourceText,
        cacheKey:
          dashboardContentTranslationKey(
            sourceText,
            contextHint
          ),
        needsTranslation:
          dashboardStructuredValueNeedsTranslation(
            value
          )
      };
    }
  );

const translatable =
  prepared.filter(
    entry =>
      entry.needsTranslation
  );

if (!translatable.length) {
  return originals;
}

const translations =
  new Map();

const uniqueByKey =
  new Map();

for (const entry of translatable) {

  if (!uniqueByKey.has(entry.cacheKey)) {
    uniqueByKey.set(
      entry.cacheKey,
      entry
    );
  }
}

const uniqueEntries =
  [...uniqueByKey.values()];

const cacheKeys =
  uniqueEntries.map(
    entry => entry.cacheKey
  );

const cachedResult =
  await pool.query(
    `
      SELECT
        cache_key,
        translation_de
      FROM dashboard_content_translations
      WHERE cache_key = ANY($1::text[])
    `,
    [cacheKeys]
  );

for (const row of cachedResult.rows) {

  try {

    translations.set(
      row.cache_key,
      JSON.parse(
        row.translation_de
      )
    );

  } catch {
    // Ungueltigen Cache ignorieren und neu uebersetzen.
  }
}

const missing =
  uniqueEntries.filter(
    entry =>
      !translations.has(
        entry.cacheKey
      )
  );

const batches =
  dashboardTranslationBatches(
    missing
  );

for (const batch of batches) {

  try {

    const numbered =
      batch.map(
        (entry, index) => ({
          id:
            index + 1,
          context:
            entry.contextHint,
          value:
            entry.value
        })
      );

    const response =
      await openai.responses.create({
        model:
          MODEL,
        instructions: `
Du erzeugst ausschliesslich die deutsche PRAESENTATIONSFORM fuer strukturierte Daten in Marcels privatem WhatsApp-Dashboard.
Die Originaldaten im Bot und in PostgreSQL duerfen nicht veraendert werden.

Du bekommst pro ID einen JSON-WERT. Dieser Wert kann Objekt, Array, String, Zahl, Boolean oder null sein.

REGELN FUER DIE DEUTSCHE ANZEIGE:
- Bei OBJEKTEN jeden semantischen Objekt-Schluessel in eine kurze, natuerliche deutsche Anzeige-Bezeichnung uebersetzen.
Beispiel: "interview_was_brief": true -> "Vorstellungsgespraech war kurz": true.
Beispiel: "wants_to_continue_seeing_her": true -> "Moechte sie weitersehen": true.
- String-Werte natuerlich und vollstaendig ins Deutsche uebersetzen.
- Zahlen, Booleans und null als Datentyp unveraendert lassen.
- Arrays und Objektstruktur erhalten.
- Keine Eintraege hinzufuegen, entfernen, zusammenfassen oder interpretieren.
- Wenn zwei Schluessel auf dieselbe deutsche Form kaemen, unterschiedlich formulieren, damit kein Eintrag verloren geht.
- Bereits korrektes Deutsch unveraendert lassen.
- Namen, WhatsApp-Namen, Handles, Emojis, URLs, Telefonnummern, Datumswerte und erkennbare Eigennamen erhalten.
- Orts- und Laendernamen in der im Deutschen ueblichen Form anzeigen, wenn etabliert: Munich -> Muenchen, Germany -> Deutschland, Colombia -> Kolumbien; Medellín bleibt Medellín.
- Sprachbezeichnungen deutsch anzeigen: Spanish -> Spanisch, English -> Englisch.
- Ganze englische oder spanische Aussagen sinngemaess uebersetzen, keine Deutsch-Englisch-Mischsaetze.
- Sexuelle, romantische oder derbe Inhalte bedeutungstreu erhalten; weder entschaerfen noch verschaerfen.

- CONTEXT dient nur zum Verstehen und wird nicht ausgegeben.

Antworte ausschliesslich mit gueltigem JSON:
{"translations":[{"id":1,"de_value":{}}]}
DE_VALUE muss denselben JSON-Datentyp und dieselbe Grundstruktur wie VALUE haben.
Fuer jede gelieferte ID genau einen Eintrag liefern.
`,
        input:
          JSON.stringify({
            items:
              numbered
          })
      });

    const parsed =
      safeJsonParse(
        response.output_text,
        {
          translations:
            []
        }
      );

    const returned =
      Array.isArray(
        parsed?.translations
      )
      ? parsed.translations
      : [];

    const byId =
      new Map();

    for (const item of returned) {

      const id =
        Number(
          item?.id
        );
      if (
        !Number.isInteger(id)
        ||
        id <= 0
      ) {
        continue;
      }

      if (
        Object.prototype.hasOwnProperty.call(
          item,
          "de_value"
        )
      ) {

        byId.set(
          id,
          item.de_value
        );

      } else if (
        Object.prototype.hasOwnProperty.call(
          item,
          "deValue"
        )
      ) {

        byId.set(
          id,
          item.deValue
        );
      }
    }

    const rowsToCache = [];

    batch.forEach(
      (entry, index) => {

        const id =
          index + 1;

        if (!byId.has(id)) {
          return;
        }

        const germanValue =
          byId.get(id);

        if (
          !dashboardJsonTypeMatches(
            entry.value,
            germanValue
          )
        ) {
          return;
        }

        translations.set(
          entry.cacheKey,
          germanValue
        );

        rowsToCache.push({
          cacheKey:
            entry.cacheKey,
          sourceText:
            entry.sourceText,
          contextHint:
            entry.contextHint,
          translationDe:
            JSON.stringify(
              germanValue
            )
        });
      }
    );

    await saveDashboardTranslationCacheRows(
      rowsToCache
    );

  } catch (error) {

    console.error(
      "Dashboard-Strukturübersetzung Batch-Fehler:",
      error
    );
  }
}

return prepared.map(
  entry =>
    translations.has(
      entry.cacheKey
    )
    ? translations.get(
        entry.cacheKey
      )
    : entry.value
);

} catch (error) {

console.error(
  "Dashboard-Strukturübersetzung Fehler:",
  error
);

return originals;
}
}

/* ==================================================
DASHBOARD KONTAKTLISTE
LESEN + SEPARATE WRITE-ROUTEN
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

          c.whatsapp_username,

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

          c.birth_day,

          c.birth_month,

          c.birth_year,
          c.birth_year_inferred,

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


  const contactIdentityMap =
    await listContactIdentityMap(
      result.rows.map(contact => contact.id)
    );

  const contacts =
    result.rows.map(
      contact => {

        const isProfileOnly =
          isProfileJid(
            contact.whatsapp_jid
          );


        const birthday =
          resolveContactBirthdayData({
            contact
          });


        return {

          id:
            contact.id,

          jid:
            contact.whatsapp_jid,
          phoneNumber:
            contact.phone_number,

          whatsappUsername:
            contact.whatsapp_username,

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

          birthDay:
            birthday.birthDay,

          birthMonth:
            birthday.birthMonth,

          birthYear:

            birthday.birthYear,

          suggestedBirthYear:
            birthday.suggestedBirthYear,

          birthYearInferred:
            birthday.birthYearInferred,

          age:
            birthday.age,

          birthdayLabel:
            dashboardBirthdayLabel(
              birthday
            ),

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

          identities:
            contactIdentityMap.get(String(contact.id)) || [],

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

      ok:           false,

      error:
        "Dashboard-Kontakte konnten nicht geladen werden."

    });

}

}
);


/* ==================================================
DASHBOARD KONTAKT ANLEGEN
POST /dashboard-api/contacts
================================================== */

app.post(
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

  const name =
    normalizeText(
      req.body?.name
    );

  if (!name) {
    throw dashboardContactError(
      "Bitte einen Namen eingeben."
    );
  }

  const phone =
    normalizeDashboardPhoneNumber(
      req.body?.phoneNumber
    );

  if (phone) {
    const phoneOwner =
      await findContactByIdentifier(
        "phone",
        phone
      );

    if (phoneOwner) {
      throw dashboardContactError(
        "Diese Telefonnummer ist bereits einem anderen Kontakt zugeordnet.",
        409
      );
    }
  }

  const whatsappUsername =
    normalizeDashboardWhatsAppUsername(
      req.body?.whatsappUsername
    );

  if (whatsappUsername) {
    const usernameOwner =
      await findContactByIdentifier(
        "whatsapp_username",
        whatsappUsername
      );

    if (usernameOwner) {
      throw dashboardContactError(
        "Dieser WhatsApp-Username ist bereits einem anderen Kontakt zugeordnet.",
        409
      );
    }
  }

  const country =
    normalizeDashboardCountryValue(
      req.body?.country
    );

  const city =
    normalizeDashboardCityValue(
      req.body?.city
    );

  const language =
    normalizeDashboardLanguageValue(
      req.body?.language
    );

  const birthday =
    dashboardContactBirthInput(
      req.body || {},
      {}
    );

  const identityKey =
    createDashboardContactIdentityKey(
      name
    );

  const manualFields = {
    canonical_name:
      true,
    display_name:
      true,
    ...(Object.prototype.hasOwnProperty.call(
      req.body || {},
      "phoneNumber"
    )
      ? {
          phone_number:
            true
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(
      req.body || {},
      "whatsappUsername"
    )
      ? {
          whatsapp_username:
            true
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(
      req.body || {},
      "city"
    )
      ? {
          city:
            true
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(
      req.body || {},
      "country"
    )
      ? {
          country:
            true
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(
      req.body || {},
      "language"
    )
      ? {
          primary_language:
            true
        }
      : {}),
    ...(birthday.birthDay
    ||
    birthday.birthMonth
    ||
    birthday.birthYear
      ? {
          birthday:
            true
        }
      : {})
  };

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
          whatsapp_username,
          country,
          city,
          primary_language,
          source_platform,
          platform_status,
          contact_status,
          relationship_stage,
          auto_reply_enabled,
          date_lock_enabled,
          birth_day,
          birth_month,
          birth_year,
          birth_year_inferred,
          manual_contact_fields,
          manual_contact_updated_at,
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
          'dashboard',
          'CONTACT_KNOWN',
          'active',
          'new',
          TRUE,
          FALSE,
          $9,
          $10,
          $11,
          $12,
          $13::jsonb,
          NOW(),
          NOW(),
          NOW()
        )
        RETURNING *
      `,
      [
        createProfileJid(
          identityKey
        ),
        name,
        identityKey,
        phone,
        whatsappUsername,
        country,
        city,
        language,
        birthday.birthDay,
        birthday.birthMonth,
        birthday.birthYear,
        birthday.birthYearInferred,
        JSON.stringify(
          manualFields
        )
      ]
    );

  const contact =
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
      "identity_key",
    value:
      identityKey,
    isPrimary:
      true
  });

  await addContactIdentifier({
    contactId:
      contact.id,
    type:
      "canonical_name",
    value:
      name,
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

  if (whatsappUsername) {
    await addContactIdentifier({
      contactId:
        contact.id,
      type:
        "whatsapp_username",
      value:
        whatsappUsername,
      sourcePlatform:
        "whatsapp",
      isPrimary:
        true
    });
  }

  await applyDashboardContactHumanFacts({
    contactId:
      contact.id,
    city,
    country,
    language,
    birthday,
    age:
      birthday.age
  });

  const birthdayDisplay =
    resolveContactBirthdayData({
      contact
    });

  return res
    .status(201)
    .json({
      ok:
        true,
      contact: {
        id:
          contact.id,
        jid:
          contact.whatsapp_jid,
        name,
        displayName:
          name,
        phoneNumber:
          phone,
        whatsappUsername:
          whatsappUsername,
        city:
          city,
        country:
          country,
        language:
          language,
        birthDay:
          birthdayDisplay.birthDay,
        birthMonth:
          birthdayDisplay.birthMonth,
        birthYear:
          birthdayDisplay.birthYear,
        birthYearInferred:
          birthdayDisplay.birthYearInferred,
        age:
          birthdayDisplay.age,
        birthdayLabel:
          dashboardBirthdayLabel(
            birthdayDisplay
          )
      }
    });

} catch (error) {

  console.error(
    "Dashboard Kontakt anlegen Fehler:",
    error
  );

  return res
    .status(
      Number(
        error?.statusCode
      )
      ||
      500
    )
    .json({
      ok:

        false,
      error:
        error?.message
        ||
        "Kontakt konnte nicht angelegt werden."
    });
}
}
);


/* ==================================================
DASHBOARD KONTAKT BEARBEITEN
PATCH /dashboard-api/contacts/:id
================================================== */

app.patch(
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
    throw dashboardContactError(
      "Ungültige Kontakt-ID."
    );
  }

  const current =
    await getContactById(
      contactId
    );

  if (
    !current
    ||
    isTestJid(
      current.whatsapp_jid
    )
  ) {
    throw dashboardContactError(
      "Kontakt nicht gefunden.",
      404
    );
  }

  const currentProfile =
    await getContactMemoryProfile(
      contactId
    );

  const currentBirthday =
    resolveContactBirthdayData({
      contact:
        current,
      profile:
        currentProfile || {},
      memoryItems:
        []
    });

  const body =
    req.body
    &&
    typeof req.body === "object"

      ? req.body

      : {};

  const nameProvided =
    Object.prototype.hasOwnProperty.call(
      body,
      "name"
    );

  const phoneProvided =
    Object.prototype.hasOwnProperty.call(
      body,
      "phoneNumber"
    );

  const usernameProvided =
    Object.prototype.hasOwnProperty.call(
      body,
      "whatsappUsername"
    );

  const cityProvided =
    Object.prototype.hasOwnProperty.call(
      body,
      "city"
    );

  const countryProvided =
    Object.prototype.hasOwnProperty.call(
      body,
      "country"
    );

  const languageProvided =
    Object.prototype.hasOwnProperty.call(
      body,
      "language"
    );

  const birthdayProvided =
    [
      "birthDay",
      "birthMonth",
      "birthYear",
      "age"
    ].some(
      key =>
        Object.prototype.hasOwnProperty.call(
          body,
          key
        )
    );

  const name =
    nameProvided
      ? normalizeText(
          body.name
        )
      : (
          current.canonical_name
          ||
          current.display_name
          ||
          current.whatsapp_display_name
          ||
          ""
        );

  if (!name) {
    throw dashboardContactError(
      "Der Kontakt braucht einen Namen."
    );
  }

  const phone =
    phoneProvided
      ? normalizeDashboardPhoneNumber(
          body.phoneNumber
        )

      : current.phone_number;

  if (phoneProvided && phone) {
    const conflict =
      await pool.query(
        `
          SELECT c.id

          FROM contact_identifiers i

          JOIN contacts c
            ON c.id =
              i.contact_id

          WHERE i.identifier_type =
            'phone'

            AND i.normalized_value =
              $1

            AND c.id <>
              $2

          LIMIT 1
        `,
        [
          normalizeIdentityValue(
            phone
          ),
          contactId
        ]
      );

    if (conflict.rows[0]) {
      throw dashboardContactError(
        "Diese Telefonnummer ist bereits einem anderen Kontakt zugeordnet.",
        409
      );
    }
  }

  const whatsappUsername =
    usernameProvided
      ? normalizeDashboardWhatsAppUsername(
          body.whatsappUsername
        )
      : current.whatsapp_username;

  if (usernameProvided && whatsappUsername) {
    const conflict =
      await pool.query(
        `
          SELECT c.id

          FROM contact_identifiers i

          JOIN contacts c
            ON c.id = i.contact_id

          WHERE i.identifier_type =
            'whatsapp_username'

            AND i.normalized_value = $1

            AND c.id <> $2

          LIMIT 1
        `,
        [
          normalizeIdentityValue(
            whatsappUsername
          ),
          contactId
        ]
      );

    if (conflict.rows[0]) {
      throw dashboardContactError(
        "Dieser WhatsApp-Username ist bereits einem anderen Kontakt zugeordnet.",
        409
      );
    }
  }

  const city =
    cityProvided
      ? normalizeDashboardCityValue(
          body.city
        )
      : current.city;

  const country =
    countryProvided
      ? normalizeDashboardCountryValue(
          body.country
        )
      : current.country;

  const language =
    languageProvided
      ? normalizeDashboardLanguageValue(
          body.language
        )
      : current.primary_language;

  const birthday =
    birthdayProvided
      ? dashboardContactBirthInput(
          body,
          currentBirthday
        )
      : currentBirthday;

  const manualFields = {
    ...(isPlainObject(
      current.manual_contact_fields
    )
      ? current.manual_contact_fields
      : {}),
    ...(nameProvided
      ? {
          canonical_name:
            true,
          display_name:
            true
        }
      : {}),
    ...(phoneProvided
      ? {
          phone_number:
            true
        }
      : {}),
    ...(usernameProvided
      ? {
          whatsapp_username:
            true
        }
      : {}),
    ...(cityProvided
      ? {
          city:
            true
        }
      : {}),
    ...(countryProvided
      ? {
          country:
            true
        }
      : {}),
    ...(languageProvided
      ? {
          primary_language:
            true
        }
      : {}),
    ...(birthdayProvided
      ? {
          birthday:
            true
        }
      : {})
  };

  const result =
    await pool.query(
      `
        UPDATE contacts

        SET
          canonical_name =
            $2,

          display_name =
            $2,

          phone_number =
            $3,

          city =
            $4,

          country =
            $5,

          primary_language =
            $6,

          whatsapp_username =
            $7,

          birth_day =
            $8,

          birth_month =
            $9,

          birth_year =
            $10,

          birth_year_inferred =
            $11,

          manual_contact_fields =
            $12::jsonb,

          manual_contact_updated_at =
            NOW(),

          updated_at =

            NOW()

        WHERE id =
          $1

        RETURNING *
      `,
      [
        contactId,
        name,
        phone,
        city,
        country,
        language,
        whatsappUsername,
        birthday.birthDay,
        birthday.birthMonth,
        birthday.birthYear,
        birthday.birthYearInferred,
        JSON.stringify(
          manualFields
        )
      ]
    );

  const updated =
    result.rows[0];

  if (nameProvided) {
    await addContactIdentifier({
      contactId,
      type:
        "canonical_name",
      value:
        name,
      isPrimary:
        true
    });
  }

  if (phoneProvided) {
    await pool.query(
      `
        DELETE FROM contact_identifiers

        WHERE contact_id =
          $1

          AND identifier_type =
            'phone'
      `,
      [
        contactId
      ]
    );

    if (phone) {
      await addContactIdentifier({
        contactId,
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
  }
  if (usernameProvided) {
    await pool.query(
      `
        DELETE FROM contact_identifiers
        WHERE contact_id = $1
          AND identifier_type = 'whatsapp_username'
      `,
      [
        contactId
      ]
    );

    if (whatsappUsername) {
      await addContactIdentifier({
        contactId,
        type:
          "whatsapp_username",
        value:
          whatsappUsername,
        sourcePlatform:
          "whatsapp",
        isPrimary:
          true
      });
    }
  }

  await applyDashboardContactHumanFacts({
    contactId,
    city:
      cityProvided
        ? city
        : null,
    country:
      countryProvided
        ? country
        : null,
    language:
      languageProvided
        ? language
        : null,
    birthday:
      birthdayProvided
        ? birthday
        : null,
    age:
      birthdayProvided
        ? birthday.age
        : null
  });

  const displayBirthday =
    resolveContactBirthdayData({
      contact:
        updated
    });

  return res.json({
    ok:
      true,
    message:
      "Kontaktdaten gespeichert.",
    contact: {
      id:
        updated.id,
      jid:
        updated.whatsapp_jid,
      name:
        updated.canonical_name
        ||
        updated.display_name,
      displayName:
        updated.display_name,
      whatsappDisplayName:
        updated.whatsapp_display_name,
      phoneNumber:
        updated.phone_number,
      whatsappUsername:
        updated.whatsapp_username,
      city:
        updated.city,
      country:
        updated.country,
      language:
        updated.primary_language,
      birthDay:
        displayBirthday.birthDay,
      birthMonth:
        displayBirthday.birthMonth,
      birthYear:
        displayBirthday.birthYear,
      birthYearInferred:
        displayBirthday.birthYearInferred,
      age:
        displayBirthday.age,
      birthdayLabel:
        dashboardBirthdayLabel(
          displayBirthday
        )
    }
  });

} catch (error) {

  console.error(
    "Dashboard Kontakt bearbeiten Fehler:",
    error
  );

  return res
    .status(
      Number(
        error?.statusCode
      )
      ||

      500
    )
    .json({
      ok:
        false,
      error:
        error?.message
        ||
        "Kontaktdaten konnten nicht gespeichert werden."
    });
}
}
);




/* ==================================================
DASHBOARD KONTAKT ENDGUELTIG LOESCHEN
DELETE /dashboard-api/contacts/:id
- entfernt nur kontaktbezogene Daten
- Marcel Brain / Marcel Memory / Live State bleiben erhalten
- laufender Historical-Memory-Backfill blockiert das Loeschen
================================================== */

app.delete(
"/dashboard-api/contacts/:id",
async (req, res) => {

let client = null;

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
    throw dashboardContactError(
      "Ungültige Kontakt-ID."
    );
  }


  const confirmation =
    normalizeText(
      req.body?.confirmation
    );


  if (
    confirmation !==
      "DELETE_CONTACT_PERMANENTLY"
  ) {
    throw dashboardContactError(
      "Löschen wurde nicht eindeutig bestätigt.",
      400
    );
  }


  await ensureHistoricalMemoryReviewTable();
  await ensureHistoricalBackfillJobsTable();
  await ensureProfileJsonImportRunsTable();


  const runningBackfill =
    await pool.query(
      `
        SELECT job_id,
               status

        FROM historical_memory_backfill_jobs

        WHERE contact_id =
          $1

          AND status IN (
            'queued',
            'running'
          )

        ORDER BY created_at DESC

        LIMIT 1
      `,
      [
        contactId
      ]
    );


  if (
    runningBackfill.rows[0]
  ) {
    throw dashboardContactError(
      "Für diesen Kontakt läuft noch eine Memory-Analyse. Bitte warten, bis sie abgeschlossen ist, und danach erneut löschen.",
      409
    );
  }


  client =
    await pool.connect();


  await client.query(
    "BEGIN"
  );


  const contactResult =
    await client.query(
      `
        SELECT *

        FROM contacts

        WHERE id =
          $1

        FOR UPDATE
      `,
      [
        contactId
      ]
    );


  const contact =
    contactResult.rows[0]
    ||
    null;


  if (
    !contact
    ||
    isTestJid(
      contact.whatsapp_jid
    )
  ) {
    throw dashboardContactError(
      "Kontakt nicht gefunden.",
      404
    );
  }


  const contactName =
    contact.canonical_name
    ||
    contact.display_name
    ||
    contact.whatsapp_display_name
    ||
    "Unbekannter Kontakt";


  const jidResult =
    await client.query(
      `
        SELECT identifier_value

        FROM contact_identifiers

        WHERE contact_id =
          $1

          AND identifier_type =
            'whatsapp_jid'
      `,
      [
        contactId
      ]
    );


  const whatsappJids =
    [
      contact.whatsapp_jid,
      ...jidResult.rows.map(
        row =>
          normalizeText(
            row.identifier_value
          )
      )
    ]
      .filter(
        Boolean
      )
      .filter(
        (
          value,
          index,
          values
        ) =>
          values.indexOf(
            value
          ) === index
      );


  const [
    memoryCountResult,
    eventCountResult,
    mediaCountResult,
    profileCountResult,
    identifierCountResult,
    profileImportCountResult,
    contactReviewCountResult,
    marcelReviewCountResult
  ] =
    await Promise.all([
      client.query(
        `SELECT COUNT(*)::int AS count FROM memory_items WHERE contact_id = $1`,
        [
          contactId
        ]
      ),
      client.query(
        `SELECT COUNT(*)::int AS count FROM memory_events WHERE contact_id = $1`,
        [
          contactId
        ]
      ),
      client.query(
        `SELECT COUNT(*)::int AS count FROM media WHERE contact_id = $1`,
        [
          contactId
        ]
      ),
      client.query(
        `SELECT COUNT(*)::int AS count FROM contact_memory_profiles WHERE contact_id = $1`,
        [
          contactId
        ]
      ),
      client.query(
        `SELECT COUNT(*)::int AS count FROM contact_identifiers WHERE contact_id = $1`,
        [
          contactId
        ]
      ),
      client.query(
        `SELECT COUNT(*)::int AS count FROM profile_json_import_runs WHERE contact_id = $1`,
        [
          contactId
        ]
      ),
      client.query(
        `
          SELECT COUNT(*)::int AS count

          FROM memory_import_review

          WHERE contact_id =
            $1

            AND LOWER(
              subject_type
            ) <> 'marcel'
        `,
        [
          contactId
        ]
      ),
      client.query(
        `
          SELECT COUNT(*)::int AS count

          FROM memory_import_review

          WHERE contact_id =
            $1

            AND LOWER(
              subject_type
            ) = 'marcel'
        `,
        [
          contactId
        ]
      )
    ]);


  let messageCount =
    0;


  if (
    whatsappJids.length
  ) {
    const messageCountResult =
      await client.query(
        `
          SELECT COUNT(*)::int AS count

          FROM messages

          WHERE whatsapp_jid =
            ANY(
              $1::text[]
            )
        `,
        [
          whatsappJids
        ]
      );

    messageCount =
      Number(
        messageCountResult.rows[0]?.count
        ||
        0
      );
  }


  const backfillDeleteResult =
    await client.query(
      `
        DELETE FROM historical_memory_backfill_jobs

        WHERE contact_id =
          $1
      `,
      [
        contactId
      ]
    );


  const contactReviewDeleteResult =
    await client.query(
      `
        DELETE FROM memory_import_review

        WHERE contact_id =
          $1

          AND LOWER(
            subject_type
          ) <> 'marcel'
      `,
      [
        contactId
      ]
    );


  let messageDeleteResult = {
    rowCount:
      0
  };


  if (
    whatsappJids.length
  ) {
    messageDeleteResult =
      await client.query(
        `
          DELETE FROM messages

          WHERE whatsapp_jid =
            ANY(
              $1::text[]
            )
        `,
        [
          whatsappJids
        ]
      );
  }


  const contactDeleteResult =
    await client.query(
      `
        DELETE FROM contacts

        WHERE id =
          $1

        RETURNING id
      `,
      [
        contactId
      ]
    );


  if (
    !contactDeleteResult.rows[0]
  ) {
    throw dashboardContactError(
      "Kontakt konnte nicht gelöscht werden.",
      409
    );
  }


  await client.query(
    "COMMIT"
  );


  return res.json({
    ok:
      true,
    deleted:
      true,
    contact: {
      id:
        contactId,
      name:
        contactName
    },
    deletedData: {
      messages:
        Number(
          messageDeleteResult.rowCount
          ??
          messageCount
        ),
      womanMemoryItems:
        Number(
          memoryCountResult.rows[0]?.count
          ||
          0
        ),
      womanEvents:
        Number(
          eventCountResult.rows[0]?.count
          ||
          0
        ),
      media:
        Number(
          mediaCountResult.rows[0]?.count
          ||
          0
        ),
      profileRows:
        Number(
          profileCountResult.rows[0]?.count
          ||
          0
        ),
      identifiers:
        Number(
          identifierCountResult.rows[0]?.count
          ||
          0
        ),
      profileJsonImports:
        Number(
          profileImportCountResult.rows[0]?.count
          ||
          0
        ),
      contactReviewRows:
        Number(
          contactReviewDeleteResult.rowCount
          ??
          contactReviewCountResult.rows[0]?.count
          ??
          0
        ),
      historicalBackfillJobs:
        Number(
          backfillDeleteResult.rowCount
          ||
          0
        )
    },
    marcelData: {
      preserved:
        true,
      preservedMarcelReviewRows:
        Number(
          marcelReviewCountResult.rows[0]?.count
          ||
          0
        )
    },
    message:
      `Kontakt „${contactName}“ und seine kontaktbezogenen Daten wurden gelöscht. Marcel Brain und Marcel Memory bleiben erhalten.`
  });

} catch (error) {

  if (client) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch (
      rollbackError
    ) {
      console.error(
        "Rollback beim Kontakt löschen fehlgeschlagen:",
        rollbackError
      );
    }
  }


  console.error(
    "Dashboard Kontakt löschen Fehler:",
    error
  );


  return res
    .status(
      Number(
        error?.statusCode
      )
      ||
      500
    )
    .json({
      ok:
        false,
      error:
        error?.message
        ||
        "Kontakt konnte nicht gelöscht werden."
    });

} finally {

  if (client) {
    client.release();
  }
}
}
);


/* ==================================================
DASHBOARD PROFIL-JSON IMPORT V1
- iPhone-freundliche .json-Datei
- Vorschau vor dem Schreiben
- Fakten landen als human-confirmed im Frauengehirn
================================================== */

function normalizeDashboardProfileImport(profile) {

if (!isPlainObject(profile)) {
throw dashboardContactError("Die Profil-Datei ist ungültig.");
}

const schema = normalizeText(profile.schema);
if (schema !== "marcel-woman-profile-v1") {
throw dashboardContactError("Nicht unterstütztes Profil-Dateiformat.");
}

const contact = isPlainObject(profile.contact) ? profile.contact : {};
const source = isPlainObject(profile.source) ? profile.source : {};
const rawFacts = Array.isArray(profile.facts) ? profile.facts : [];

if (!rawFacts.length) {
throw dashboardContactError("Die Profil-Datei enthält keine Fakten.");
}

if (rawFacts.length > 100) {
throw dashboardContactError("Die Profil-Datei enthält zu viele Fakten.");
}

const facts = rawFacts.map((item, index) => {
if (!isPlainObject(item)) {
  throw dashboardContactError(`Fakt ${index + 1} ist ungültig.`);
}

const rawCategory = normalizeText(item.category);
const normalizedCategory = normalizeIdentityValue(rawCategory)
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

const categoryAliases = {
  relationships: "relationship",
  relationship_status: "relationship",
  dating: "relationship",
  dating_intention: "relationship",
  dating_intentions: "relationship",
  family_children: "family",
  work: "work_education",
  education: "work_education",
  job: "work_education",
  work_and_education: "work_education",
  religion: "religion_values",
  values: "religion_values",
  sexuality: "sexuality_intimacy",
  intimacy: "sexuality_intimacy",
  lifestyle: "lifestyle_routines",
  routines: "lifestyle_routines",
  goals: "goals_dreams",
  dreams: "goals_dreams",
  travel: "travel_future_location",
  future_location: "travel_future_location",
  boundaries: "personal_boundaries",
  stress_support: "stress_support_style",
  social: "social_circle",
  social_network: "social_circle",
  socialmedia: "social_media",
  meaningful_detail: "meaningful_details",
  history: "shared_history",
  context: "current_context"
};

const category = PROFILE_COLUMNS.includes(normalizedCategory)
  ? normalizedCategory
  : (categoryAliases[normalizedCategory] || normalizedCategory);

const rawKey = normalizeText(item.key);
const key = normalizeIdentityValue(rawKey)
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

if (!PROFILE_COLUMNS.includes(category)) {
  throw dashboardContactError(
    `Fakt ${index + 1}: Kategorie „${rawCategory || "(leer)"}“ ist ungültig. Erlaubt sind: ${PROFILE_COLUMNS.join(", ")}.`
  );
}

if (!key) {
  throw dashboardContactError(
    `Fakt ${index + 1}: Schlüssel „${rawKey || "(leer)"}“ ist ungültig.`
  );
}
const rawValue = item.value;
const value = isPlainObject(rawValue)
  ? rawValue
  : { value: rawValue ?? null };

return {
  category,
  key,
  value,
  importance: clampImportance(item.importance),
  evidence: normalizeText(item.evidence) || null
};
});

const age = dashboardIntegerOrNull(contact.age, 0, 130);
if (age === false) {
throw dashboardContactError("Das Alter in der Profil-Datei ist ungültig.");
}

const birthDay = dashboardIntegerOrNull(contact.birthDay, 1, 31);
const birthMonth = dashboardIntegerOrNull(contact.birthMonth, 1, 12);
const birthYear = dashboardNormalizeBirthYear(contact.birthYear);

if (birthDay === false || birthMonth === false || birthYear === false) {
throw dashboardContactError("Das Geburtsdatum in der Profil-Datei ist ungültig.");
}

return {
schema,
contact: {
  name: normalizeText(contact.name) || null,
  whatsappUsername: normalizeDashboardWhatsAppUsername(contact.whatsappUsername),
  city: normalizeDashboardCityValue(contact.city),
  country: normalizeDashboardCountryValue(contact.country),
  language: normalizeDashboardLanguageValue(contact.language),
  age,
  birthDay,
  birthMonth,
  birthYear
},
source: {
  platform: normalizeText(source.platform).toLowerCase() || "unknown",
  capturedAt: normalizeText(source.capturedAt) || null,
  matchDate: normalizeText(source.matchDate) || null,
  profileName: normalizeText(source.profileName) || normalizeText(contact.name) || null
},
facts
};
}

function profileImportSnapshotFromFacts(facts) {
const snapshot = {};
for (const fact of facts) {
if (!snapshot[fact.category]) snapshot[fact.category] = {};
if (isPlainObject(fact.value)) {
  snapshot[fact.category] = mergeProfileObjects(snapshot[fact.category], fact.value);
} else {
  snapshot[fact.category][fact.key] = fact.value;
}
}
return snapshot;
}

async function ensureProfileJsonImportRunsTable() {
await pool.query(`
CREATE TABLE IF NOT EXISTS profile_json_import_runs (
  import_id TEXT PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source_platform TEXT,
  status TEXT NOT NULL DEFAULT 'applied',
  before_contact JSONB NOT NULL DEFAULT '{}'::jsonb,
  before_profile JSONB,
  before_username_identifiers JSONB NOT NULL DEFAULT '[]'::jsonb,
  touched_memory_pairs JSONB NOT NULL DEFAULT '[]'::jsonb,
  before_memory_rows JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_memory_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  undone_at TIMESTAMPTZ
)
`);
}

function profileImportTouchedMemoryPairs(profile, birthday) {
const pairs = profile.facts.map(fact => ({ category: fact.category, key: fact.key }));
if (profile.contact.city) pairs.push({ category: 'profile_summary', key: 'city' });
if (profile.contact.country) pairs.push({ category: 'profile_summary', key: 'country' });
if (profile.contact.language) pairs.push({ category: 'communication', key: 'primary_language' });
if (profile.contact.age != null || (birthday?.birthDay && birthday?.birthMonth && birthday?.birthYear)) {
pairs.push({ category: 'profile_summary', key: 'age' });
}
if (birthday?.birthDay && birthday?.birthMonth) pairs.push({ category: 'profile_summary', key: 'birthday' });
const seen = new Set();
return pairs.filter(pair => {
const id = `${pair.category}\u0000${pair.key}`;
if (seen.has(id)) return false;
seen.add(id);
return true;
});
}

async function profileImportMemoryRows(contactId, pairs) {
if (!pairs.length) return [];
const values = [contactId];
const clauses = pairs.map(pair => {
values.push(pair.category, pair.key);
const c = values.length - 1;
const k = values.length;
return `(category=$${c} AND memory_key=$${k})`;
});
const result = await pool.query(
`SELECT * FROM memory_items WHERE contact_id=$1 AND (${clauses.join(' OR ')}) ORDER BY id`,
values
);
return result.rows;
}

async function restoreProfileImportMemoryRow(row, contactId) {
await pool.query(
`UPDATE memory_items SET
   category=$3,memory_key=$4,memory_value=$5::jsonb,memory_type=$6,confidence=$7,
   source_message_id=$8,source_quote=$9,source_context=$10::jsonb,valid_from=$11,valid_until=$12,
   status=$13,supersedes_memory_id=$14,human_review_status=$15,human_corrected_value=$16::jsonb,
   human_note=$17,human_reviewed_at=$18,importance=$19,use_in_reply=$20,updated_at=$21
 WHERE id=$1 AND contact_id=$2`,
[
  row.id, contactId, row.category, row.memory_key, JSON.stringify(row.memory_value || {}), row.memory_type,
  row.confidence, row.source_message_id, row.source_quote, JSON.stringify(row.source_context || {}),
  row.valid_from, row.valid_until, row.status, row.supersedes_memory_id, row.human_review_status,
  row.human_corrected_value == null ? null : JSON.stringify(row.human_corrected_value), row.human_note,
  row.human_reviewed_at, row.importance, row.use_in_reply, row.updated_at
]
);
}

async function undoDashboardProfileJsonImport({ contactId, importId }) {
await ensureProfileJsonImportRunsTable();
const run = (await pool.query(
`SELECT * FROM profile_json_import_runs WHERE import_id=$1 AND contact_id=$2 LIMIT 1`,
[importId, contactId]
)).rows[0];
if (!run) throw dashboardContactError('Profil-Import zum Rückgängig-Machen nicht gefunden.', 404);
if (run.status === 'undone') {
return { alreadyUndone: true };
}
if (run.status !== 'applied') throw dashboardContactError('Dieser Profil-Import kann nicht rückgängig gemacht werden.', 409);

const beforeContact = isPlainObject(run.before_contact) ? run.before_contact : {};
const beforeProfile = isPlainObject(run.before_profile) ? run.before_profile : null;
const beforeIdentifiers = Array.isArray(run.before_username_identifiers) ? run.before_username_identifiers : [];
const beforeMemoryRows = Array.isArray(run.before_memory_rows) ? run.before_memory_rows : [];
const createdMemoryIds = Array.isArray(run.created_memory_ids) ? run.created_memory_ids.map(Number).filter(Number.isInteger) : [];

if (createdMemoryIds.length) {
await pool.query(`DELETE FROM memory_items WHERE contact_id=$1 AND id=ANY($2::bigint[])`, [contactId, createdMemoryIds]);
}
for (const row of beforeMemoryRows) {
await restoreProfileImportMemoryRow(row, contactId);
}

await pool.query(
`UPDATE contacts SET
   whatsapp_username=$2,city=$3,country=$4,primary_language=$5,source_platform=$6,
   source_profile_name=$7,manual_contact_fields=$8::jsonb,manual_contact_updated_at=$9,updated_at=NOW()
 WHERE id=$1`,
[
  contactId, beforeContact.whatsapp_username ?? null, beforeContact.city ?? null,
  beforeContact.country ?? null, beforeContact.primary_language ?? null, beforeContact.source_platform ?? null,
  beforeContact.source_profile_name ?? null, JSON.stringify(beforeContact.manual_contact_fields || {}),
  beforeContact.manual_contact_updated_at ?? null
]
);

await pool.query(`DELETE FROM contact_identifiers WHERE contact_id=$1 AND identifier_type='whatsapp_username'`, [contactId]);
for (const identifier of beforeIdentifiers) {
await pool.query(
  `INSERT INTO contact_identifiers
    (contact_id,identifier_type,identifier_value,normalized_value,source_platform,is_primary,human_verified,created_at,updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
  [contactId, identifier.identifier_type, identifier.identifier_value, identifier.normalized_value,
   identifier.source_platform, identifier.is_primary, identifier.human_verified,
   identifier.created_at || new Date(), identifier.updated_at || new Date()]
);
}

if (beforeProfile) {
const assignments = PROFILE_COLUMNS.map((column, index) => `${column}=$${index + 1}::jsonb`);
const values = PROFILE_COLUMNS.map(column => JSON.stringify(beforeProfile[column] || {}));
values.push(beforeProfile.profile_version || 1, beforeProfile.last_memory_update_at || null, contactId);
await pool.query(
  `UPDATE contact_memory_profiles SET ${assignments.join(',')},
     profile_version=$${PROFILE_COLUMNS.length + 1},
     last_memory_update_at=$${PROFILE_COLUMNS.length + 2},updated_at=NOW()
   WHERE contact_id=$${PROFILE_COLUMNS.length + 3}`,
  values
);
} else {
await pool.query(`DELETE FROM contact_memory_profiles WHERE contact_id=$1`, [contactId]);
}

await pool.query(
`UPDATE profile_json_import_runs SET status='undone',undone_at=NOW() WHERE import_id=$1`,
[importId]
);
return { alreadyUndone: false };
}

app.post(
"/dashboard-api/profile-import",
async (req, res) => {
try {
  if (!dashboardApiReady(res)) return;
  if (!dashboardApiAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
  }

  const contactId = Number(req.body?.contactId);
  if (!Number.isInteger(contactId) || contactId <= 0) {
    throw dashboardContactError("Ungültige Kontakt-ID.");
  }

  const selectedContact = await getContactById(contactId);
  if (!selectedContact || isTestJid(selectedContact.whatsapp_jid)) {
    throw dashboardContactError("Kontakt nicht gefunden.", 404);
  }

  const requestedAction = normalizeText(req.body?.action).toLowerCase();
  if (requestedAction === 'undo') {
    const importId = normalizeText(req.body?.importId);
    if (!importId) throw dashboardContactError('Import-ID fehlt.');
    const undo = await undoDashboardProfileJsonImport({ contactId, importId });
    return res.json({
      ok: true,
      undone: true,
      alreadyUndone: undo.alreadyUndone,
      message: undo.alreadyUndone
        ? 'Der Profil-Import war bereits rückgängig gemacht.'
        : 'Der Profil-Import wurde vollständig rückgängig gemacht.'
    });
  }

  const profile = normalizeDashboardProfileImport(req.body?.profile);
  const action = requestedAction === "import" ? "import" : "preview";

  const selectedName = selectedContact.canonical_name || selectedContact.display_name || selectedContact.whatsapp_display_name || "Unbekannter Kontakt";
  const nameWarning = profile.contact.name && normalizeIdentityValue(profile.contact.name) !== normalizeIdentityValue(selectedName)
    ? `Profilname „${profile.contact.name}“ weicht vom ausgewählten Kontakt „${selectedName}“ ab.`
    : null;

  const preview = {
    schema: profile.schema,
    sourcePlatform: profile.source.platform,
    sourceProfileName: profile.source.profileName,
    profileName: profile.contact.name,
    whatsappUsername: profile.contact.whatsappUsername,
    age: profile.contact.age,
    city: profile.contact.city,
    country: profile.contact.country,
    language: profile.contact.language,
    factCount: profile.facts.length,
    facts: profile.facts,
    warning: nameWarning
  };

  if (action !== "import") {
    return res.json({
      ok: true,
      preview: true,
      contact: { id: selectedContact.id, name: selectedName },
      profile: preview
    });
  }

  if (nameWarning && req.body?.confirmNameMismatch !== true) {
    return res.status(409).json({
      ok: false,
      code: "PROFILE_NAME_MISMATCH",
      error: `${nameWarning} Bitte die Zuordnung ausdrücklich bestätigen.`,
      profile: preview
    });
  }

  if (profile.contact.whatsappUsername) {
    const conflict = await pool.query(
      `SELECT contact_id FROM contact_identifiers WHERE identifier_type='whatsapp_username' AND normalized_value=$1 AND contact_id<>$2 LIMIT 1`,
      [normalizeIdentityValue(profile.contact.whatsappUsername), contactId]
    );
    if (conflict.rows[0]) {
      throw dashboardContactError("Dieser WhatsApp-Username ist bereits einem anderen Kontakt zugeordnet.", 409);
    }
  }

  const birthday = (profile.contact.birthDay || profile.contact.birthMonth || profile.contact.birthYear || profile.contact.age != null)
    ? dashboardContactBirthInput({
        birthDay: profile.contact.birthDay,
        birthMonth: profile.contact.birthMonth,
        birthYear: profile.contact.birthYear,
        age: profile.contact.age
      }, {})
    : null;

  await ensureProfileJsonImportRunsTable();
  const importId = `profile-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  const touchedPairs = profileImportTouchedMemoryPairs(profile, birthday);
  const beforeMemoryRows = await profileImportMemoryRows(contactId, touchedPairs);
  const beforeMemoryIds = new Set(beforeMemoryRows.map(row => Number(row.id)));
  const beforeProfile = (await pool.query(`SELECT * FROM contact_memory_profiles WHERE contact_id=$1 LIMIT 1`, [contactId])).rows[0] || null;
  const beforeIdentifiers = (await pool.query(`SELECT * FROM contact_identifiers WHERE contact_id=$1 AND identifier_type='whatsapp_username' ORDER BY id`, [contactId])).rows;
  const beforeContact = {
    whatsapp_username: selectedContact.whatsapp_username ?? null,
    city: selectedContact.city ?? null,
    country: selectedContact.country ?? null,
    primary_language: selectedContact.primary_language ?? null,
    source_platform: selectedContact.source_platform ?? null,
    source_profile_name: selectedContact.source_profile_name ?? null,
    manual_contact_fields: selectedContact.manual_contact_fields || {},
    manual_contact_updated_at: selectedContact.manual_contact_updated_at ?? null
  };

  const currentManual = isPlainObject(selectedContact.manual_contact_fields) ? selectedContact.manual_contact_fields : {};
  const manualFields = {
    ...currentManual,
    ...(profile.contact.whatsappUsername ? { whatsapp_username: true } : {}),
    ...(profile.contact.city ? { city: true } : {}),
    ...(profile.contact.country ? { country: true } : {}),
    ...(profile.contact.language ? { primary_language: true } : {})
  };

  await pool.query(
    `UPDATE contacts SET
       whatsapp_username=COALESCE($2,whatsapp_username),
       city=COALESCE($3,city),
       country=COALESCE($4,country),
       primary_language=COALESCE($5,primary_language),
       source_platform=CASE WHEN $6<>'' THEN $6 ELSE source_platform END,
       source_profile_name=COALESCE($7,source_profile_name),
       manual_contact_fields=$8::jsonb,
       manual_contact_updated_at=NOW(),
       updated_at=NOW()
     WHERE id=$1`,
    [
      contactId,
      profile.contact.whatsappUsername,
      profile.contact.city,
      profile.contact.country,
      profile.contact.language,
      profile.source.platform,
      profile.source.profileName,
      JSON.stringify(manualFields)
    ]
  );

  if (profile.contact.whatsappUsername) {
    await pool.query(`DELETE FROM contact_identifiers WHERE contact_id=$1 AND identifier_type='whatsapp_username'`, [contactId]);
    await addContactIdentifier({
      contactId,
      type: "whatsapp_username",
      value: profile.contact.whatsappUsername,
      sourcePlatform: "whatsapp",
      isPrimary: true
    });
  }

  await applyDashboardContactHumanFacts({
    contactId,
    city: profile.contact.city,
    country: profile.contact.country,
    language: profile.contact.language,
    birthday,
    age: birthday ? birthday.age : profile.contact.age
  });

  const sourceLabel = profile.source.platform || "Profil";
  for (const fact of profile.facts) {
    const note = `Von Marcel per Profil-JSON importiert (${sourceLabel}).${fact.evidence ? ` Quelle: ${fact.evidence}` : ""}`;
    await upsertDashboardVerifiedContactMemory({
      contactId,
      category: fact.category,
      memoryKey: fact.key,
      memoryValue: fact.value,
      importance: fact.importance,
      note
    });
  }

  const snapshot = profileImportSnapshotFromFacts(profile.facts);
  if (Object.keys(snapshot).length) {
    await applyProfileSnapshot(contactId, snapshot, { humanSeed: true });
  }

  const afterMemoryRows = await profileImportMemoryRows(contactId, touchedPairs);
  const createdMemoryIds = afterMemoryRows.map(row => Number(row.id)).filter(memoryId => !beforeMemoryIds.has(memoryId));
  await pool.query(
    `INSERT INTO profile_json_import_runs
      (import_id,contact_id,source_platform,status,before_contact,before_profile,before_username_identifiers,touched_memory_pairs,before_memory_rows,created_memory_ids)
     VALUES ($1,$2,$3,'applied',$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb)`,
    [
      importId, contactId, profile.source.platform,
      JSON.stringify(beforeContact), beforeProfile ? JSON.stringify(beforeProfile) : null,
      JSON.stringify(beforeIdentifiers), JSON.stringify(touchedPairs), JSON.stringify(beforeMemoryRows),
      JSON.stringify(createdMemoryIds)
    ]
  );

  return res.json({
    ok: true,
    imported: true,
    importId,
    contact: { id: contactId, name: selectedName },
    profile: preview,
    message: `${profile.facts.length} Profil-Fakten wurden als bestätigtes Frauen-Memory gespeichert.`
  });
} catch (error) {
  console.error("Dashboard Profil-JSON Import Fehler:", error);
  return res.status(Number(error?.statusCode) || 500).json({
    ok: false,
    error: error?.message || "Profil-Datei konnte nicht importiert werden."
  });
}
}
);

/* ==================================================
DASHBOARD MARCEL BRAIN
READ ONLY V0.2 + DEUTSCHE PRAESENTATION
================================================== */

app.get(
"/dashboard-api/marcel-brain",
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


  const [
    memoryResult,
    liveState
  ] =
    await Promise.all([

      pool.query(
        `
          SELECT
            id,
            category,
            memory_key,
            memory_value,
            status,
            importance,
            sensitivity,
            source_type,
            human_verified,
            human_review_action,
            human_review_note,
            human_reviewed_at,
            valid_from,
            valid_until,
            allowed_for_bot,
            usage_notes,
            created_at,
            updated_at
          FROM marcel_memory
          WHERE status = 'active'
            AND (
              valid_until IS NULL
              OR valid_until > NOW()
            )
          ORDER BY
            human_verified ASC,
            importance DESC,
            updated_at DESC
        `
      ),

      getMarcelLiveState()

    ]);


  const items =
    memoryResult.rows.map(
      item => ({
        id:
          item.id,
        category:
          item.category,
        key:
          item.memory_key,
        value:
          item.memory_value,
        status:
          item.status,
        importance:
          Number(
            item.importance
            ||
            0
          ),
        sensitivity:
          item.sensitivity,
        sourceType:
          item.source_type,
        humanVerified:
          item.human_verified
          ===
          true,
        humanReviewAction:
          item.human_review_action,
        humanReviewNote:
          item.human_review_note,
        humanReviewedAt:
          item.human_reviewed_at,
        validFrom:
          item.valid_from,
        validUntil:
          item.valid_until,
        allowedForBot:
          item.allowed_for_bot
          !==
          false,
        usageNotes:
          item.usage_notes,
        createdAt:
          item.created_at,
        updatedAt:
          item.updated_at
      })
    );


  const liveStateDisplaySource = {
    current_country:

      liveState?.current_country,
    current_city:
      liveState?.current_city,
    location_status:
      liveState?.location_status,
    relocation_target_country:
      liveState?.relocation_target_country,
    relocation_target_city:
      liveState?.relocation_target_city,
    relocation_stage:
      liveState?.relocation_stage,
    relocation_eta:
      liveState?.relocation_eta,
    temporary_travel_country:
      liveState?.temporary_travel_country,
    temporary_travel_city:
      liveState?.temporary_travel_city,
    housing_stage:
      liveState?.housing_stage
  };


  const translatedLiveStateFields =
    (
      await translateDashboardValueListToGerman([
        {
          contextHint:
            "marcel_live_state",
          value:               liveStateDisplaySource
        }
      ])
    )[0]
    ||
    liveStateDisplaySource;


  const translatedMemoryValues =
    await translateDashboardStructuredValueListToGerman(
      items.map(
        item => ({
          contextHint:
            `marcel_memory.${item.category || "general"}.${item.key || "value"}`,
          value:
            item.value
        })
      )
    );


  const translatedLiveState = {
    ...(liveState || {}),
    ...translatedLiveStateFields
  };


  const translatedItems =
    items.map(
      (item, index) => ({
        ...item,
        originalValue:
          item.value,
        value:
          translatedMemoryValues[index]
          ??
          item.value
      })
    );


  const reviewRequired =
    translatedItems.filter(
      item =>
        item.humanVerified
        !==
        true
    ).length;


  return res.json({
    ok:
      true,
    readOnly:
      true,
    presentationLanguage:
      "de",
    reviewRequired,
    count:
      translatedItems.length,
    liveState:
      translatedLiveState,
    items:
      translatedItems
  });


} catch (error) {

  console.error(
    "Dashboard Marcel Brain Fehler:",
    error
  );


  return res
    .status(500)
    .json({
      ok:
        false,
      error:
        "Marcel Brain konnte nicht geladen werden."
    });

}

}
);


/* ==================================================
MARCEL BRAIN REVIEW / HUMAN-IN-THE-LOOP
- bestaetigen
- ablehnen
- auf Deutsch korrigieren, intern Englisch speichern
================================================== */

async function normalizeMarcelReviewCorrectionToEnglish({
currentValue,
correctionDe,
memoryKey,
category
}) {

const correction =
normalizeText(
  correctionDe
);

if (!correction) {
throw new Error(
  "Bitte die Korrektur eingeben."
);
}

const response =
await openai.responses.create({
  model:
    MODEL,
  instructions: `
Du aktualisierst EINEN bereits vorhandenen Fakt in Marcels internem Bot-Memory.


WICHTIG:
- Marcel gibt die Korrektur auf Deutsch ein.
- Das interne Memory bleibt Englisch und verwendet bei Objekten stabile englische snake_case Keys.
- Aendere nur das, was Marcels Korrektur tatsaechlich korrigiert oder praezisiert.
- Teile des bisherigen Memory-Werts, denen Marcel nicht widerspricht, bleiben erhalten.
- Keine Fakten erfinden, ergaenzen oder interpretieren.
- Namen, Eigennamen, Zahlen, Daten, Handles und Telefonnummern korrekt erhalten.
- Der JSON-Grundtyp des neuen memory_value MUSS gleich bleiben:
Objekt bleibt Objekt, Array bleibt Array, String bleibt String, Zahl bleibt Zahl, Boolean bleibt Boolean.
- Bei Objekten englische snake_case Keys verwenden.
- String-Inhalte fuer das interne Bot-Memory natuerlich auf Englisch formulieren.
- Wenn der komplette Fakt falsch ist, ist dafuer die separate Ablehnen-Funktion zustaendig; hier nur korrigieren.

Antworte ausschliesslich mit gueltigem JSON:
{"memory_value": <vollstaendig korrigierter Memory-Wert>}
`,
  input:
    JSON.stringify({
      category:
        category || null,
      memory_key:
        memoryKey || null,
      current_memory_value:
        currentValue,
      correction_de:
        correction
    })
});

const parsed =
safeJsonParse(
  response.output_text,
  null
);

if (
!parsed
||
!Object.prototype.hasOwnProperty.call(
  parsed,
  "memory_value"
)
) {
throw new Error(
  "Die Korrektur konnte nicht sicher in das interne Memory übertragen werden."
);
}

const nextValue =
parsed.memory_value;

if (
!dashboardJsonTypeMatches(
  currentValue,
  nextValue
)
) {
throw new Error(     "Die Korrektur hat eine unerwartete Datenstruktur erzeugt und wurde deshalb nicht gespeichert."
);
}

return nextValue;
}


app.post(
"/dashboard-api/marcel-brain",
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

  const memoryId =
    Number(
      req.body?.memoryId
    );

  const action =
    normalizeText(
      req.body?.action
    )
    .toLowerCase();

  const correctionDe =
    normalizeText(
      req.body?.correctionDe
    );

  if (
    !Number.isInteger(
      memoryId
    )
    ||
    memoryId <= 0
  ) {
    return res
      .status(400)
      .json({
        ok:
          false,
        error:
          "Ungültige Marcel-Memory-ID."
      });
  }

  if (
    ![
      "confirm",
      "reject",
      "correct"
    ].includes(
      action
    )
  ) {
    return res
      .status(400)
      .json({
        ok:
          false,
        error:
          "Unbekannte Review-Aktion."
      });
  }

  const initialResult =

    await pool.query(
      `
        SELECT
          id,
          category,
          memory_key,
          memory_value,
          status,
          importance,
          human_verified,
          allowed_for_bot,
          valid_until
        FROM marcel_memory
        WHERE id = $1
        LIMIT 1
      `,
      [
        memoryId
      ]
    );

  const initial =
    initialResult.rows[0];

  if (!initial) {
    return res
      .status(404)
      .json({
        ok:
          false,
        error:
          "Marcel-Memory nicht gefunden."
      });
  }

  if (
    initial.status
    !==
    "active"
  ) {
    return res
      .status(409)
      .json({
        ok:
          false,
        error:
          "Dieser Fakt ist nicht mehr aktiv. Bitte Marcel Brain neu laden."
      });
  }

  let correctedValue =
    null;

  if (
    action
    ===
    "correct"
  ) {

    if (!correctionDe) {
      return res
        .status(400)
        .json({
          ok:
            false,
          error:
            "Bitte die richtige Information eingeben."
        });
    }

    correctedValue =
      await normalizeMarcelReviewCorrectionToEnglish({
        currentValue:
          initial.memory_value,
        correctionDe,
        memoryKey:
          initial.memory_key,
        category:
          initial.category
      });
  }

  const client =
    await pool.connect();

  try {

    await client.query(
      "BEGIN"
    );
    const lockedResult =
      await client.query(
        `
          SELECT
            id,
            category,
            memory_key,
            memory_value,
            status,
            importance,
            human_verified,
            allowed_for_bot,
            valid_until
          FROM marcel_memory
          WHERE id = $1
          FOR UPDATE
        `,
        [
          memoryId
        ]
      );

    const current =
      lockedResult.rows[0];

    if (!current) {
      const error =
        new Error(
          "Marcel-Memory nicht gefunden."
        );
      error.statusCode = 404;
      throw error;
    }

    if (
      current.status
      !==
      "active"
    ) {
      const error =
        new Error(
          "Dieser Fakt wurde inzwischen verändert. Bitte Marcel Brain neu laden."
        );
      error.statusCode = 409;
      throw error;
    }

    if (
      action
      ===
      "correct"
      &&
      renderJson(
        current.memory_value
      )
      !==
      renderJson(
        initial.memory_value
      )
    ) {
      const error =
        new Error(
          "Dieser Fakt wurde inzwischen verändert. Bitte Marcel Brain neu laden und die Korrektur erneut prüfen."

        );
      error.statusCode = 409;
      throw error;
    }

    const oldValue =
      current.memory_value;

    const oldStatus =
      current.status;

    let newValue =
      oldValue;

    let newStatus =
      oldStatus;

    if (
      action
      ===
      "confirm"
    ) {

      await client.query(
        `
          UPDATE marcel_memory
          SET
            human_verified = TRUE,
            allowed_for_bot = TRUE,
            human_review_action = 'confirmed',
            human_review_note = NULL,
            human_reviewed_at = NOW(),
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          memoryId
        ]
      );

    } else if (
      action
      ===
      "reject"
    ) {

      newStatus =
        "rejected";

      await client.query(
        `
          UPDATE marcel_memory
          SET
            status = 'rejected',
            human_verified = TRUE,
            allowed_for_bot = FALSE,
            valid_until = NOW(),
            human_review_action = 'rejected',
            human_review_note = 'Von Marcel im Dashboard als falsch markiert.',
            human_reviewed_at = NOW(),
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          memoryId
        ]
      );

    } else {

      newValue =
        correctedValue;

      await client.query(
        `
          UPDATE marcel_memory
          SET
            memory_value = $2::jsonb,
            human_verified = TRUE,
            allowed_for_bot = TRUE,
            human_review_action = 'corrected',
            human_review_note = $3,
            human_reviewed_at = NOW(),
            updated_at = NOW()
          WHERE id = $1
        `,
        [
          memoryId,
          JSON.stringify(
            correctedValue
          ),
          correctionDe
        ]
      );
    }

    await client.query(
      `
        INSERT INTO marcel_memory_review_log (
          memory_id,
          memory_key,
          action,
          old_value,
          new_value,
          old_status,
          new_status,
          correction_de,
          reviewed_by
        )
        VALUES (
          $1,
          $2,
          $3,
          $4::jsonb,
          $5::jsonb,
          $6,             $7,
          $8,
          'marcel_dashboard'
        )
      `,
      [
        memoryId,
        current.memory_key,
        action,
        JSON.stringify(
          oldValue
        ),
        JSON.stringify(
          newValue
        ),
        oldStatus,
        newStatus,
        correctionDe || null
      ]
    );

    await client.query(
      "COMMIT"
    );

  } catch (error) {

    try {
      await client.query(

        "ROLLBACK"
      );
    } catch {}

    throw error;

  } finally {

    client.release();
  }

  return res.json({
    ok:
      true,
    memoryId,
    action,
    message:
      action === "confirm"
      ? "Fakt bestätigt."
      : action === "reject"
      ? "Fakt als falsch markiert und für den Bot deaktiviert."
      : "Korrektur gespeichert und als menschlich bestätigt markiert."
  });

} catch (error) {

  console.error(
    "Marcel Brain Review Fehler:",
    error
  );

  return res
    .status(
      Number(
        error?.statusCode
      )
      ||
      500
    )
    .json({
      ok:
        false,
      error:
        error?.message
        ||
        "Marcel Brain konnte nicht aktualisiert werden."
    });
}
}
);


/* ==================================================
MARCEL BRAIN MANUAL WRITES
================================================== */

const MARCEL_MANUAL_FACT_CATEGORIES = new Set([
  "identity",
  "languages",
  "work",
  "family",
  "communication",
  "nicknames",
  "lifestyle",
  "food_drinks",
  "skills",
  "personal_stories",
  "relationship_history",
  "relationship_values",
  "marriage_religion",
  "sexuality",
  "housing",
  "preferences",
  "health",
  "travel",
  "finance"
]);

const MARCEL_LIVE_STATE_FIELDS = Object.freeze({
  current_country: "text",
  current_city: "text",
  current_timezone: "text",
  location_status: "text",
  relocation_target_country: "text",
  relocation_target_city: "text",
  relocation_stage: "text",
  relocation_eta: "text",
  temporary_travel_country: "text",
  temporary_travel_city: "text",
  temporary_travel_until: "timestamp",
  housing_stage: "text",
  manual_location_lock: "boolean"
});

function brainWriteError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function assertOnlyBodyFields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw brainWriteError("Ungültiger Request-Body.");
  }
  const unknown = Object.keys(body).filter(key => !allowed.has(key));
  if (unknown.length) {
    throw brainWriteError("Nicht erlaubte Felder im Request.");
  }
}

function jsonDepth(value, depth = 0) {
  if (depth > 6) return depth;
  if (!value || typeof value !== "object") return depth;
  return Math.max(depth, ...Object.values(value).map(item => jsonDepth(item, depth + 1)));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalJson(value[key]);
      return result;
    }, {});
  }
  return value;
}

function normalizedJsonText(value) {
  return JSON.stringify(canonicalJson(value));
}

function validateManualFactValue(value) {
  if (value === undefined || value === null) {
    throw brainWriteError("Ein Wert ist erforderlich.");
  }
  const encoded = JSON.stringify(value);
  if (
    encoded === undefined
    || encoded.length > 16000
    || jsonDepth(value) > 6
    || (typeof value === "number" && !Number.isFinite(value))
  ) {
    throw brainWriteError("Der Wert ist ungültig oder zu groß.");
  }
  return value;
}

function validateManualFactFields(body, { partial = false } = {}) {
  const result = {};
  if (!partial || Object.prototype.hasOwnProperty.call(body, "category")) {
    const category = normalizeText(body.category).toLowerCase();
    if (!MARCEL_MANUAL_FACT_CATEGORIES.has(category)) {
      throw brainWriteError("Ungültige Kategorie.");
    }
    result.category = category;
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, "key")) {
    const key = normalizeText(body.key).toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,79}$/.test(key)) {
      throw brainWriteError("Ungültiger Memory-Key.");
    }
    result.key = key;
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, "value")) {
    result.value = validateManualFactValue(body.value);
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, "importance")) {
    const importance = Number(body.importance);
    if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
      throw brainWriteError("Importance muss zwischen 1 und 5 liegen.");
    }
    result.importance = importance;
  }
  if (!partial || Object.prototype.hasOwnProperty.call(body, "use_in_reply")) {
    if (typeof body.use_in_reply !== "boolean") {
      throw brainWriteError("use_in_reply muss ein Boolean sein.");
    }
    result.allowedForBot = body.use_in_reply;
  }
  if (Object.prototype.hasOwnProperty.call(body, "valid_until")) {
    if (body.valid_until === null || body.valid_until === "") {
      result.validUntil = null;
    } else {
      const date = new Date(body.valid_until);
      if (!Number.isFinite(date.getTime()) || date <= new Date()) {
        throw brainWriteError("valid_until muss ein gültiger zukünftiger Zeitpunkt sein.");
      }
      result.validUntil = date.toISOString();
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "notes")) {
    const notes = normalizeText(body.notes);
    if (notes.length > 1000) throw brainWriteError("Die Notiz ist zu lang.");
    result.notes = notes || null;
  }
  return result;
}

function safeExistingFact(row) {
  return {
    id: row.id,
    category: row.category,
    key: row.memory_key,
    value: row.memory_value,
    importance: Number(row.importance),
    use_in_reply: row.allowed_for_bot !== false,
    valid_until: row.valid_until,
    notes: row.usage_notes,
    updatedAt: row.updated_at
  };
}

function validateBrainCandidate(candidate, index) {
  const kind = normalizeText(candidate?.kind).toLowerCase();
  const confidence = Number(candidate?.confidence);
  if (!["fact", "live_state"].includes(kind) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  const base = {
    id: `candidate-${index + 1}`,
    kind,
    labelDe: normalizeText(candidate?.label_de) || "Erkannte Information",
    displayValueDe: normalizeText(candidate?.display_value_de) || renderJson(candidate?.value),
    permanence: kind === "live_state" ? "current" : normalizeText(candidate?.permanence).toLowerCase() === "limited" ? "limited" : "permanent",
    confidence
  };
  if (kind === "live_state") {
    const field = normalizeText(candidate?.field).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(MARCEL_LIVE_STATE_FIELDS, field)) return null;
    try {
      const value = validateManualFactValue(candidate?.value);
      return { ...base, field, value, useInReply: true, validUntil: null };
    } catch { return null; }
  }
  try {
    const fact = validateManualFactFields({
      category: candidate?.category,
      key: candidate?.key,
      value: candidate?.value,
      importance: candidate?.importance,
      use_in_reply: candidate?.use_in_reply,
      ...(candidate?.valid_until ? { valid_until: candidate.valid_until } : {})
    });
    return { ...base, category: fact.category, key: fact.key, value: fact.value, importance: fact.importance, useInReply: fact.allowedForBot, validUntil: fact.validUntil ?? null };
  } catch { return null; }
}

app.post("/dashboard-api/marcel-brain/classify", async (req, res) => {
  if (!dashboardApiReady(res)) return;
  if (!dashboardApiAuthorized(req)) return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
  try {
    assertOnlyBodyFields(req.body, new Set(["text"]));
    const text = normalizeText(req.body?.text);
    if (text.length < 3 || text.length > 4000) throw brainWriteError("Bitte 3 bis 4.000 Zeichen natürlichen Text eingeben.");
    const existing = (await pool.query(`SELECT category,memory_key,memory_value,human_verified FROM marcel_memory WHERE status='active' ORDER BY importance DESC LIMIT 250`)).rows;
    const response = await openai.responses.create({
      model: MODEL,
      instructions: `Du klassifizierst Marcels eigene, auf Deutsch eingegebene Informationen für das bestehende Marcel-Memory. Du schreibst NICHTS. Liefere nur eine sichere Vorschau. Zerlege den Text in eigenständige Fakten. Nutze dieselbe konservative Memory-Semantik wie der bestehende Extractor: keine Erfindungen, ein Kernfakt pro Kandidat, stabile englische snake_case Keys, kurzfristige Angaben als live_state, langfristige Angaben als fact. Bestehendes menschlich bestätigtes Wissen niemals überschreiben. Erlaubte Fact-Kategorien: ${[...MARCEL_MANUAL_FACT_CATEGORIES].join(", ")}. Erlaubte Live-State-Felder: ${Object.keys(MARCEL_LIVE_STATE_FIELDS).join(", ")}. Interne Werte und Keys kanonisch Englisch; label_de und display_value_de natürlich Deutsch. Bei Unsicherheit confidence unter 0.75. use_in_reply nur wenn die Information sicher für Antworten geeignet ist. importance 1 bis 5. valid_until nur als zukünftiger ISO-Zeitpunkt oder null. Antworte ausschließlich als JSON: {"candidates":[{"kind":"fact|live_state","category":"","key":"","field":"","value":null,"label_de":"","display_value_de":"","permanence":"permanent|limited|current","importance":3,"use_in_reply":true,"valid_until":null,"confidence":0.9}]}`,
      input: JSON.stringify({ text_de: text, existing_memory: existing })
    });
    const parsed = safeJsonParse(response.output_text, { candidates: [] });
    const rawCandidates = Array.isArray(parsed?.candidates) ? parsed.candidates.slice(0, 12) : [];
    const candidates = rawCandidates.map(validateBrainCandidate).filter(Boolean);
    if (!candidates.length) return res.status(422).json({ ok: false, error: "Aus dem Text konnten keine ausreichend strukturierten Informationen erkannt werden." });
    return res.json({ ok: true, previewOnly: true, presentationLanguage: "de", candidates });
  } catch (error) {
    console.error("Marcel Brain Klassifikation Fehler:", error?.message || "unknown");
    return res.status(Number(error?.statusCode) || 500).json({ ok: false, error: error?.statusCode ? error.message : "Der Text konnte nicht sicher analysiert werden." });
  }
});

app.post("/dashboard-api/marcel-brain/facts", async (req, res) => {
  if (!dashboardApiReady(res)) return;
  if (!dashboardApiAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
  }
  try {
    assertOnlyBodyFields(req.body, new Set([
      "category", "key", "value", "importance", "use_in_reply", "valid_until", "notes"
    ]));
    const fact = validateManualFactFields(req.body);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [fact.key]
      );
      const existingResult = await client.query(
        `SELECT * FROM marcel_memory WHERE memory_key = $1 FOR UPDATE`,
        [fact.key]
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (normalizedJsonText(existing.memory_value) === normalizedJsonText(fact.value)) {
          await client.query("COMMIT");
          return res.status(200).json({
            ok: true,
            created: false,
            idempotent: true,
            fact: safeExistingFact(existing)
          });
        }
        await client.query("ROLLBACK");
        return res.status(409).json({
          ok: false,
          conflict: true,
          error: "Für diesen Memory-Key existiert bereits ein anderer Wert.",
          existing: safeExistingFact(existing),
          proposed: {
            category: fact.category,
            key: fact.key,
            value: fact.value,
            importance: fact.importance,
            use_in_reply: fact.allowedForBot,
            valid_until: fact.validUntil ?? null,
            notes: fact.notes ?? null
          }
        });
      }
      const inserted = (await client.query(
        `INSERT INTO marcel_memory (
          category, memory_key, memory_value, status, importance, sensitivity,
          source_type, human_verified, human_review_action, human_review_note,
          human_reviewed_at, valid_until, allowed_for_bot, usage_notes
        ) VALUES ($1,$2,$3::jsonb,'active',$4,'normal','manual_dashboard',TRUE,
          'confirmed',$5,NOW(),$6,$7,$5)
        RETURNING *`,
        [
          fact.category, fact.key, JSON.stringify(fact.value), fact.importance,
          fact.notes ?? null, fact.validUntil ?? null, fact.allowedForBot
        ]
      )).rows[0];
      await client.query(
        `INSERT INTO marcel_memory_review_log
          (memory_id,memory_key,action,old_value,new_value,old_status,new_status,correction_de,reviewed_by)
         VALUES ($1,$2,'create',NULL,$3::jsonb,NULL,'active',NULL,'marcel_dashboard')`,
        [inserted.id, inserted.memory_key, JSON.stringify(inserted.memory_value)]
      );
      await client.query("COMMIT");
      return res.status(201).json({ ok: true, created: true, fact: safeExistingFact(inserted) });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Marcel Brain Fact Create Fehler:", error?.message || "unknown");
    const statusCode = error?.code === "23505" ? 409 : Number(error?.statusCode) || 500;
    return res.status(statusCode).json({
      ok: false,
      error: statusCode === 409
        ? "Dieser Memory-Key wurde inzwischen angelegt oder verändert. Bitte Brain neu laden."
        : error?.statusCode ? error.message : "Marcel-Fakt konnte nicht gespeichert werden."
    });
  }
});

app.patch("/dashboard-api/marcel-brain/facts/:id", async (req, res) => {
  if (!dashboardApiReady(res)) return;
  if (!dashboardApiAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
  }
  try {
    const memoryId = Number(req.params.id);
    if (!Number.isInteger(memoryId) || memoryId <= 0) throw brainWriteError("Ungültige Marcel-Memory-ID.");
    assertOnlyBodyFields(req.body, new Set([
      "category", "key", "value", "importance", "use_in_reply", "valid_until", "notes",
      "expectedUpdatedAt", "explicitConflictConfirmation"
    ]));
    if (req.body.explicitConflictConfirmation !== true) {
      throw brainWriteError("Die bewusste Änderungsbestätigung fehlt.", 409);
    }
    const expected = new Date(req.body.expectedUpdatedAt);
    if (!Number.isFinite(expected.getTime())) throw brainWriteError("expectedUpdatedAt ist ungültig.");
    const editable = ["category", "key", "value", "importance", "use_in_reply", "valid_until", "notes"];
    if (!editable.some(key => Object.prototype.hasOwnProperty.call(req.body, key))) {
      throw brainWriteError("Keine Änderung angegeben.");
    }
    const changes = validateManualFactFields(req.body, { partial: true });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = (await client.query(
        `SELECT * FROM marcel_memory WHERE id = $1 FOR UPDATE`, [memoryId]
      )).rows[0];
      if (!current) throw brainWriteError("Marcel-Memory nicht gefunden.", 404);
      if (current.status !== "active" || current.human_verified !== true) {
        throw brainWriteError("Nur aktive menschlich bestätigte Fakten dürfen hier geändert werden.", 409);
      }
      if (new Date(current.updated_at).toISOString() !== expected.toISOString()) {
        throw brainWriteError("Dieser Fakt wurde inzwischen verändert. Bitte Brain neu laden.", 409);
      }
      const next = {
        category: changes.category ?? current.category,
        key: changes.key ?? current.memory_key,
        value: Object.prototype.hasOwnProperty.call(changes, "value") ? changes.value : current.memory_value,
        importance: changes.importance ?? Number(current.importance),
        allowedForBot: Object.prototype.hasOwnProperty.call(changes, "allowedForBot") ? changes.allowedForBot : current.allowed_for_bot,
        validUntil: Object.prototype.hasOwnProperty.call(changes, "validUntil") ? changes.validUntil : current.valid_until,
        notes: Object.prototype.hasOwnProperty.call(changes, "notes") ? changes.notes : current.usage_notes
      };
      const updated = (await client.query(
        `UPDATE marcel_memory SET
          category=$2,memory_key=$3,memory_value=$4::jsonb,importance=$5,
          allowed_for_bot=$6,valid_until=$7,usage_notes=$8,
          source_type='manual_dashboard',human_verified=TRUE,status='active',
          human_review_action='confirmed',human_review_note=$8,human_reviewed_at=NOW(),updated_at=NOW()
         WHERE id=$1 RETURNING *`,
        [
          memoryId, next.category, next.key, JSON.stringify(next.value), next.importance,
          next.allowedForBot, next.validUntil, next.notes
        ]
      )).rows[0];
      await client.query(
        `INSERT INTO marcel_memory_review_log
          (memory_id,memory_key,action,old_value,new_value,old_status,new_status,correction_de,reviewed_by)
         VALUES ($1,$2,'update',$3::jsonb,$4::jsonb,$5,'active',NULL,'marcel_dashboard')`,
        [memoryId, updated.memory_key, JSON.stringify(current.memory_value), JSON.stringify(updated.memory_value), current.status]
      );
      await client.query("COMMIT");
      return res.json({ ok: true, updated: true, fact: safeExistingFact(updated) });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Marcel Brain Fact Update Fehler:", error?.message || "unknown");
    const statusCode = error?.code === "23505" ? 409 : Number(error?.statusCode) || 500;
    return res.status(statusCode).json({
      ok: false,
      error: statusCode === 409
        ? "Dieser Memory-Key ist bereits vergeben oder wurde inzwischen verändert."
        : error?.statusCode ? error.message : "Marcel-Fakt konnte nicht geändert werden."
    });
  }
});

app.patch("/dashboard-api/marcel-brain/live-state", async (req, res) => {
  if (!dashboardApiReady(res)) return;
  if (!dashboardApiAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
  }
  try {
    assertOnlyBodyFields(req.body, new Set(Object.keys(MARCEL_LIVE_STATE_FIELDS)));
    const entries = Object.entries(req.body);
    if (!entries.length) throw brainWriteError("Keine Zustandsänderung angegeben.");
    const values = {};
    for (const [field, value] of entries) {
      const type = MARCEL_LIVE_STATE_FIELDS[field];
      if (type === "boolean") {
        if (typeof value !== "boolean") throw brainWriteError(`${field} muss ein Boolean sein.`);
        values[field] = value;
      } else if (type === "timestamp") {
        if (value === null || value === "") values[field] = null;
        else {
          const date = new Date(value);
          if (!Number.isFinite(date.getTime())) throw brainWriteError(`${field} ist kein gültiger Zeitpunkt.`);
          values[field] = date.toISOString();
        }
      } else {
        if (value !== null && (typeof value !== "string" || value.trim().length > 200)) {
          throw brainWriteError(`${field} muss Text mit höchstens 200 Zeichen sein.`);
        }
        values[field] = value === null ? null : value.trim() || null;
      }
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = (await client.query(
        `SELECT * FROM marcel_live_state WHERE id=1 FOR UPDATE`
      )).rows[0];
      if (!current) throw brainWriteError("Marcel Live State fehlt.", 404);
      const changedFields = Object.keys(values).filter(
        field => normalizedJsonText(current[field]) !== normalizedJsonText(values[field])
      );
      if (!changedFields.length) {
        await client.query("COMMIT");
        return res.json({ ok: true, updated: false, idempotent: true, liveState: current });
      }
      const parameters = changedFields.map(field => values[field]);
      const assignments = changedFields.map((field, index) => `${field}=$${index + 1}`);
      const updated = (await client.query(
        `UPDATE marcel_live_state SET ${assignments.join(",")},
          updated_by='manual_dashboard',updated_at=NOW() WHERE id=1 RETURNING *`,
        parameters
      )).rows[0];
      const oldValues = Object.fromEntries(changedFields.map(field => [field, current[field]]));
      const newValues = Object.fromEntries(changedFields.map(field => [field, updated[field]]));
      await client.query(
        `INSERT INTO marcel_live_state_audit
          (source,actor,changed_fields,old_values,new_values)
         VALUES ('manual_dashboard','dashboard_user',$1::jsonb,$2::jsonb,$3::jsonb)`,
        [JSON.stringify(changedFields), JSON.stringify(oldValues), JSON.stringify(newValues)]
      );
      await client.query("COMMIT");
      return res.json({ ok: true, updated: true, changedFields, liveState: updated });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error("Marcel Brain Live State Fehler:", error?.message || "unknown");
    return res.status(Number(error?.statusCode) || 500).json({
      ok: false,
      error: error?.statusCode ? error.message : "Aktueller Zustand konnte nicht gespeichert werden."
    });
  }
});


/* ==================================================
DASHBOARD KI-UEBERSETZUNG
POST /dashboard-api/contacts/:id/translations
================================================== */

app.post(
"/dashboard-api/contacts/:id/translations",
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
    ||
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


  const result =
    await translateDashboardMessagesToGerman(
      contact.whatsapp_jid,
      200
    );

  return res.json({
    ok:
      true,
    windowHours:
      24,
    ...result
  });


} catch (error) {

  console.error(
    "Dashboard Übersetzung Fehler:",
    error
  );


  return res
    .status(500)
    .json({
      ok:
        false,
      error:
        "KI-Übersetzung konnte nicht erstellt werden."
    });

}

}
);


/* ==================================================
DASHBOARD EINZELKONTAKT
CHAT + PROFIL + MEMORY + EVENTS
READ ONLY V0.2
================================================== */

app.post(
"/dashboard-api/contacts/:id/identities",
async (req, res) => {
  try {
    if (!dashboardApiReady(res)) return;
    if (!dashboardApiAuthorized(req)) return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
    const contactId = Number(req.params.id);
    if (!Number.isInteger(contactId) || contactId <= 0) throw dashboardContactError("Ungültige Kontakt-ID.");
    const contact = await getContactById(contactId);
    if (!contact || isTestJid(contact.whatsapp_jid)) throw dashboardContactError("Kontakt nicht gefunden.", 404);
    const result = await upsertContactIdentity(contactId, req.body || {});
    return res.status(result.idempotent ? 200 : 201).json({ ok: true, ...result });
  } catch (error) {
    return res.status(Number(error?.statusCode) || 500).json({ ok: false, error: error?.message || "Kanalidentität konnte nicht gespeichert werden." });
  }
}
);

app.delete(
"/dashboard-api/contacts/:id/identities",
async (req, res) => {
  try {
    if (!dashboardApiReady(res)) return;
    if (!dashboardApiAuthorized(req)) return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
    const contactId = Number(req.params.id);
    if (!Number.isInteger(contactId) || contactId <= 0) throw dashboardContactError("Ungültige Kontakt-ID.");
    const contact = await getContactById(contactId);
    if (!contact || isTestJid(contact.whatsapp_jid)) throw dashboardContactError("Kontakt nicht gefunden.", 404);
    const result = await removeContactIdentity(contactId, req.body?.channel);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(Number(error?.statusCode) || 500).json({ ok: false, error: error?.message || "Kanalidentität konnte nicht entfernt werden." });
  }
}
);

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
    events,
    mediaRows,
    identities
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

      getHistoricalMemoryItems(           contact.id,
        250
      ),

      getAllMemoryEvents(
        contact.id,
        200
      ),

      listContactMedia(contact.id),

      listContactIdentities(contact.id)

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


  const birthday =
    resolveContactBirthdayData({
      contact,
      profile:
        cleanProfile,
      memoryItems:
        activeItems
    });


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

        memoryType:             item.memory_type,

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

  const contactDisplaySource = {
    city:
      contact.city,
    country:
      contact.country,
    language:
      contact.primary_language,
    profession:
      profileSummary.profession
      ??
      null,
    locationContext:
      contact.location_context
      ||
      {},
    relocationContext:
      contact.relocation_context
      ||
      {}
  };


  const fixedDisplaySource = {
    contact:
      contactDisplaySource,
    events:
      normalizedEvents.map(
        event => ({
          title:
            event.title,
          evidenceSummary:
            event.evidenceSummary,
          botAction:
            event.botAction
        })
      )
  };


  const translatedFixedDisplay =
    (
      await translateDashboardValueListToGerman([
        {
          contextHint:
            "contact_dashboard",
          value:
            fixedDisplaySource
        }
      ])
    )[0]
    ||       fixedDisplaySource;


  const translatedContactDisplay =
    translatedFixedDisplay.contact
    ||
    contactDisplaySource;


  const translatedEventTexts =
    Array.isArray(
      translatedFixedDisplay.events
    )
    ? translatedFixedDisplay.events
    : fixedDisplaySource.events;


  const structuredDisplayRequests = [
    ...normalizedActiveItems.map(
      item => ({
        contextHint:
          `contact_memory.${item.category || "general"}.${item.key || "value"}`,
        value:
          item.value
      })
    ),

    ...normalizedHistoricalItems.map(
      item => ({
        contextHint:
          `contact_memory.${item.category || "general"}.${item.key || "value"}`,
        value:
          item.value
      })
    ),
    ...normalizedEvents.map(
      event => ({
        contextHint:
          `contact_event.${event.type || "event"}.${event.subtype || "general"}.data`,
        value:
          event.data
      })
    )
  ];


  const structuredDisplayValues =
    await translateDashboardStructuredValueListToGerman(
      structuredDisplayRequests
    );


  const translatedProfile =
    cleanProfile;


  let dashboardDisplayOffset =
    0;


  const translatedActiveItems =
    normalizedActiveItems.map(
      (item, index) => ({
        ...item,
        value:
          structuredDisplayValues[
            dashboardDisplayOffset + index
          ]
          ??
          item.value
      })
    );


  dashboardDisplayOffset +=
    normalizedActiveItems.length;


  const translatedHistoricalItems =
    normalizedHistoricalItems.map(
      (item, index) => ({
        ...item,
        value:
          structuredDisplayValues[
            dashboardDisplayOffset + index
          ]
          ??
          item.value
      })
    );


  dashboardDisplayOffset +=
    normalizedHistoricalItems.length;


  const translatedEvents =
    normalizedEvents.map(
      (event, index) => {

        const translatedText =
          translatedEventTexts[index]
          ||
          {};

        return {
          ...event,
          title:
            translatedText.title
            ??
            event.title,
          data:
            structuredDisplayValues[
              dashboardDisplayOffset + index
            ]
            ??
            event.data,
          evidenceSummary:
            translatedText.evidenceSummary
            ??
            event.evidenceSummary,
          botAction:
            translatedText.botAction
            ??
            event.botAction
        };
      }
    );


  return res.json({

    ok:
      true,

    readOnly:
      true,

    presentationLanguage:
      "de",

    totalMessages:
      totalMessages,

    contact: {

      id:
        contact.id,

      jid:
        contact.whatsapp_jid,

      phoneNumber:
        contact.phone_number,

      whatsappUsername:
        contact.whatsapp_username,

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
        translatedContactDisplay.city
        ??
        contact.city,


      originalCity:
        contact.city,

      country:
        translatedContactDisplay.country
        ??
        contact.country,

      originalCountry:
        contact.country,

      timezone:
        contact.timezone,

      language:
        translatedContactDisplay.language
        ??
        contact.primary_language,

      originalLanguage:
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
        translatedContactDisplay.locationContext
        ??
        contact.location_context
        ??
        {},

      relocationContext:
        translatedContactDisplay.relocationContext
        ??
        contact.relocation_context
        ??
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

      birthDay:
        birthday.birthDay,

      birthMonth:
        birthday.birthMonth,

      birthYear:
        birthday.birthYear,

      suggestedBirthYear:
        birthday.suggestedBirthYear,

      birthYearInferred:
        birthday.birthYearInferred,

      birthdayLabel:
        dashboardBirthdayLabel(
          birthday
        ),

      age:
        birthday.age
        ??
        profileSummary.age
        ??
        null,

      profession:
        translatedContactDisplay.profession
        ??
        profileSummary.profession
        ??
        null

    },

    messages,

    profile:
      translatedProfile,

    activeItems:
      translatedActiveItems,

    historicalItems:
      translatedHistoricalItems,

    events:
      translatedEvents,

    mediaItems:
      mediaRows,

    identities,

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
      result.rows[0]           .server_time

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
content="width=device-width,initial-scale=1,viewport-fit=cover">

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
class="status"></div>


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

return String(     value ?? ""
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
      `test-in-${Date.now()}`,         {

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


/* ==================================================  WHATSAPP INCOMING HANDLER
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
    of event.messages     ) {

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
