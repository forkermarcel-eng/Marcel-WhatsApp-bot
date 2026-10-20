# Marcel Brain – Code- und Schnittstelleninventar

Basis: Commit e2d41dbda3562ee2284ded1d666fcd002bb973a4; Inventur am 20.10.2026 vor Implementierung der Organisation. 381 Git-Dateien, 317 textuelle Quell-/Konfigurations-/Dokumentdateien statisch erfasst; Binärdateien nicht als Code analysiert. Rohinhalte privater Wissensdatensätze, Zugangsdaten und Chattexte wurden nicht in dieses Dokument kopiert. Live-Prüfung beschränkt auf Metadaten, Datensatzanzahlen und Feature-Schalter; keine Fremdsystemanmeldung oder Handels-/Nachrichtenaktion.

## Architektur und Laufzeit

Browser → Vercel-Login/Middleware → authentifizierter Dashboard-Proxy → Express index.js → bestehender PostgreSQL-Pool. Separate Geräte/Worker sind keine automatisch als aktiv zu wertenden API-Anbindungen. Railway-Metadaten: endearing-endurance: keine aktuelle Deploymentbestätigung; Postgres: SUCCESS; cooperative-kindness: SUCCESS; Marcel-Tinder-bot: keine aktuelle Deploymentbestätigung. Vercel-Projekt marcel-whats-app-bot, main, Domain marcelmarlow.com, Node 24. Backend cooperative-kindness erfolgreich auf derselben Basis; Postgres erfolgreich. Kein neu eingerichteter Dienst.

### Frontends

- Analyse/index.html
- Brain/index.html
- Dashboard/index.html
- Einstellungen/index.html
- Hub/index.html
- Instagram/index.html
- Kontakte/index.html
- Tinder/index.html
- Trading/index.html
- X/index.html

## Schnittstellenregister

Die Statusbezeichnung bezieht sich auf den genannten Prüfbereich. Deployment/Konfiguration allein beweisen keine vollständige Geräte-/Provider-End-to-End-Verbindung.

### Hauptbackend / WhatsApp

- Zweck/Implementierung: index.js; services/whatsapp-media.js
- Anbieter: Baileys/WhatsApp; OpenAI
- Authentifizierung: WhatsApp-Session in PostgreSQL; OPENAI_API_KEY serverseitig
- Kosten/Tarif: WhatsApp-Flag standardmäßig false; OpenAI nutzungsabhängig
- Quelle → Ziel: Kontakte/Nachrichten/Medien ↔ PostgreSQL; WhatsApp nur bei Freigabe
- Aktualisierung/Hintergrund: Nachrichteneingang, Memory-Extraktion, Reconnect-Timer
- Abhängigkeiten: Express-Hauptprozess und PostgreSQL
- Status: **Lokal funktionsfähig**
- Befund/Fehlergrenzen: Produktivprozess erfolgreich; persönlicher WhatsApp-Versand nicht ausgelöst. Legacy-Import/Cleanup-Routen besitzen explizite Backend-Authprüfungen.
- Lokale Portabilität: Node/PostgreSQL lokal übertragbar; WhatsApp-Gerätesitzung separat schützen

### Vercel-Weboberflächen / Proxy

- Zweck/Implementierung: middleware.js; api/login.js; api/dashboard/*.js; zehn */index.html
- Anbieter: Vercel/GitHub/Railway
- Authentifizierung: Signierter Login-Cookie; Proxy nutzt DASHBOARD_API_SECRET; Backend-Bearer timingSafeEqual
- Kosten/Tarif: Bestehende Hosting-Tarife; keine zusätzlichen aktiviert
- Quelle → Ziel: Browser ↔ Vercel ↔ Railway
- Aktualisierung/Hintergrund: Request-basiert; Git-Deploy main
- Abhängigkeiten: Vercel Functions, Node 24, Railway-URL/Secrets
- Status: **Produktiv und geprüft**
- Befund/Fehlergrenzen: Aktueller Commit e2d41db; Browser nicht persönlich angemeldet.
- Lokale Portabilität: Statische Frontends + Reverse Proxy lokal ersetzbar; Login-Schlüssel migrieren

### Dokumentenwissen

- Zweck/Implementierung: brain-knowledge/{discover,extract,model,search,repository,service,routes,transfer}.js
- Anbieter: PostgreSQL; optional node:sqlite
- Authentifizierung: Dashboard-Bearer; BRAIN_KNOWLEDGE_ENABLED/WRITES
- Kosten/Tarif: Kein externer Suchdienst; bestehende DB
- Quelle → Ziel: Dokumente → documents/entries/evidence/relations/reviews/meta
- Aktualisierung/Hintergrund: Explizite Imports; kein heimlicher Gesamtdateiscan je Anfrage
- Abhängigkeiten: Knowledge-Service, Source-Provenienz, Import-CLI
- Status: **Produktiv und geprüft**
- Befund/Fehlergrenzen: 91 Dokumente, 10911 Einträge; keine Inhaltswerte im Bericht. Fehlende/ausgeschlossene Quellen bleiben erkennbar.
- Lokale Portabilität: PostgreSQL und SQLite sowie JSON-Transfer vorhanden; Originaldateien separat sichern

### Persönliche Fakten / Review / Live-State

- Zweck/Implementierung: index.js; brain-chat/{facts,routes,retrieval}.js
- Anbieter: Bestehende PostgreSQL-Tabellen
- Authentifizierung: Owner-Review, allowed_for_bot, human_verified, sensitivity/valid_until
- Kosten/Tarif: Bestehende DB; optionale OpenAI-Klassifizierung nutzungsabhängig
- Quelle → Ziel: marcel_memory / marcel_live_state / Audit → autorisierter Wissensabruf
- Aktualisierung/Hintergrund: Request-basiert, explizite Review-Änderungen
- Abhängigkeiten: Review-Log, direkte Faktenleser, Kommunikationsregeln
- Status: **Produktiv und geprüft**
- Befund/Fehlergrenzen: 98 persönliche Datensätze; Werte nicht veröffentlicht. Seed in index.js ist separater Quellpfad.
- Lokale Portabilität: Tabellen und Flags exportieren; keine sensible Faktenfreigabe automatisch erweitern

### Brain Chat / Lernsystem / Projektgedächtnis

- Zweck/Implementierung: brain-chat/{routes,service,retrieval,learning,proposals,document-import}.js
- Anbieter: Knowledge-Modus, optional OpenAI oder lokales Modell
- Authentifizierung: BRAIN_CHAT_ENABLED; paid/local jeweils eigenes Freigabe-Flag
- Kosten/Tarif: Produktiv knowledge, paid API false
- Quelle → Ziel: Unterhaltungen in Knowledge-meta; Vorschläge/Projektentscheidungen zunächst Review
- Aktualisierung/Hintergrund: SSE je Anfrage; Idempotenz über requestId und Revision
- Abhängigkeiten: Knowledge-Repository, persönliche Faktenleser
- Status: **Produktiv und geprüft**
- Befund/Fehlergrenzen: BRAIN_CHAT_MODE=knowledge; keine laufende freie Modellgenerierung behauptet.
- Lokale Portabilität: JSON/SQLite/PostgreSQL; Vorschlagszustände mitnehmen

### Lokale KI (Ollama / llama.cpp / Qwen)

- Zweck/Implementierung: brain-chat/local-model.js
- Anbieter: OpenAI-kompatible lokale HTTP-API
- Authentifizierung: Explizites LOCAL_APPROVED; ausschließlich Loopback
- Kosten/Tarif: Keine Installation/kein Cloud-Fallback
- Quelle → Ziel: Wissenskontext → lokale /v1/chat/completions
- Aktualisierung/Hintergrund: SSE pro Anfrage, 90s Timeout
- Abhängigkeiten: Lokales Modell separat benötigt
- Status: **Nur vorbereitet**
- Befund/Fehlergrenzen: Produktiv keine LOCAL-Konfiguration; Qwen ist mögliche Modellwahl, kein installierter Dienst.
- Lokale Portabilität: Für lokalen Rechner geeignet; URL/Modell erst nach Inbetriebnahme freigeben

### Welt / Geokodierung / Wetter / News

- Zweck/Implementierung: brain-world/{routes,service,geography,sources,presentation}.js
- Anbieter: OSM Nominatim/Wikipedia/Wikidata/MET Norway/USGS/RSS
- Authentifizierung: Öffentliche begrenzte Serverabrufe; Dashboard-Bearer für App
- Kosten/Tarif: Kostenlos unter Quellenbedingungen; MET CC BY 4.0, OSM ODbL
- Quelle → Ziel: Öffentliche Quellen → marcel_world; Favoriten/Bookmarks auf ausdrückliche Aktion
- Aktualisierung/Hintergrund: 5min Hintergrund, 60s Bereinigung, 72h Newsaufbewahrung; quellspezifischer Cache
- Abhängigkeiten: Express, vorhandener PostgreSQL-Pool
- Status: **Produktiv und geprüft**
- Befund/Fehlergrenzen: Generischer Welt-Service importiert einen bestehenden Trading-HTTP-Helfer; Finanzportal ist davon entkoppelt.
- Lokale Portabilität: Node und Postgres lokal; Netzabrufe/Attribution bleiben nötig

### Finanzportal-Nachrichten / Kalender

- Zweck/Implementierung: brain-world/finance.js; finance-sources.js; Brain/finance-view.*
- Anbieter: finanzen.net, FinanzNachrichten.de, Eurostat, EZB, Fed, BLS, BEA
- Authentifizierung: Öffentliche Zugänge, keine Trading-Schlüssel
- Kosten/Tarif: Kostenlos; nur freigegebene Headlines/Links, keine ungeklärten Artikelbilder
- Quelle → Ziel: Eigene Quellen → marcel_world.cache finance-portal:v2
- Aktualisierung/Hintergrund: RSS 10min, Kalender 30min, sichtbare UI 60s; bestehender 5min-Timer
- Abhängigkeiten: Eigener Finanzcache; keine Trading-Tabellen
- Status: **Produktiv und geprüft**
- Befund/Fehlergrenzen: 50 Meldungen/42 Termine zuletzt geprüft; keine Vorhersagewerte aus Kalenderzeiten ableiten.
- Lokale Portabilität: Vollständig mit Node/Postgres übertragbar

### Finanzportal-Marktanzeige

- Zweck/Implementierung: Brain/finance-widget{,-frame}.js; finance-widget.html
- Anbieter: TradingView Market Overview
- Authentifizierung: Anonyme isolierte Anzeige; keine API-Anmeldung
- Kosten/Tarif: Kostenloses Widget mit unverändertem Branding; Datenrechte je Symbol
- Quelle → Ziel: TradingView direkt im isolierten Browserframe; kein Export/DB-Import
- Aktualisierung/Hintergrund: Anbieterseitige Aktualisierung, nur sichtbarer Workspace
- Abhängigkeiten: Externer Widgetdienst; kein Trading-Bot
- Status: **Produktiv und geprüft**
- Befund/Fehlergrenzen: DAX EOD; US-Indizes/Gold/Brent als CFD-Referenzen bezeichnet. Nicht alle Originalindizes verfügbar.
- Lokale Portabilität: Frontend lokal möglich, Marktdaten weiterhin extern

### Trading (Inventur, unverändert)

- Zweck/Implementierung: Trading/; trading-core/server, workers, tests, docs; api/trading.js
- Anbieter: Massive, offizielle Behördenfeeds; optionale Databento-/Ingest-Adapter
- Authentifizierung: Eigene TRADING_ Secrets und Freigaben
- Kosten/Tarif: Massive-Entitlement; Databento potenziell kostenpflichtig; keine Käufe
- Quelle → Ziel: Eigene marcel_trading-Tabellen; keine Abhängigkeit des Organisations-/Finanzportals
- Aktualisierung/Hintergrund: Eigener context Worker, quellspezifische Intervalle
- Abhängigkeiten: Trading-spezifischer Dienstcode und Datenbank
- Status: **Produktiv und geprüft**
- Befund/Fehlergrenzen: Konfiguration/Tabellen/Deployment geprüft; keine Handelsaktion. Bekannter 120-Minuten-Aufwärtsabruf aus 14 Tagen bleibt unverändert dokumentiert.
- Lokale Portabilität: Eigener Export/Repository; keine Änderung in diesem Auftrag

### Tinder-Mirror / Discovery / Nachrichtenfreigaben

- Zweck/Implementierung: tinder-mirror/; services/contact-identities.js; device-bridge/; index.js
- Anbieter: Lokale Geräte-/Bridge-Protokolle, kein erfundener offizieller Tinder-Privat-API-Zugang
- Authentifizierung: Enrollment-Schlüssel, Nonces, Permits, Bestätigungen, Owner-Review
- Kosten/Tarif: Bestehende Geräte/Hosting; kein neuer Dienst
- Quelle → Ziel: Geräteereignisse → public.tinder_*, Kontakte, Shared Media
- Aktualisierung/Hintergrund: pg-boss Discovery opt-in; Bridge-Jobs/Acks
- Abhängigkeiten: Android/Bridge-Hardware extern; vorhandener PostgreSQL-Pool
- Status: **Nur vorbereitet**
- Befund/Fehlergrenzen: Transport-Flag true, separate Railway-Serviceinstanz ohne aktuelle Deploymentbestätigung; nicht als aktuell getestete Geräteverbindung ausgeben.
- Lokale Portabilität: Protokoll transportierbar; Geräteprüfung und Schlüssel neu bewerten

### Kontakte / Medien / Kanalidentitäten

- Zweck/Implementierung: services/contact-{identities,channel,media}.js; shared-media/; Kontakte/
- Anbieter: PostgreSQL, Sharp, vorhandene Medienquellen
- Authentifizierung: Dashboard-Auth, bestehende Channel-Bindings/ACL
- Kosten/Tarif: Bestehender Speicher; keine neuen Cloudkonten
- Quelle → Ziel: contacts/contact_identifiers/media_assets/links
- Aktualisierung/Hintergrund: Request-/Ingress-basiert, migrationsgesteuert
- Abhängigkeiten: Shared-Media-Runtime und Identitätsauflösung
- Status: **Produktiv und geprüft**
- Befund/Fehlergrenzen: 71 Kontakte vorhanden; keine privaten Profile ausgelesen.
- Lokale Portabilität: DB + Originalmedien sichern; keine reinen DB-Exporte als vollständige Medienkopie behaupten

### Instagram / X / Social Drafts

- Zweck/Implementierung: Instagram/; X/; brain-integrations/social-drafts.js
- Anbieter: Kein aktiver Posting-Anbieter
- Authentifizierung: Entwürfe/Adapterfreigabe; kein Versand ohne ausdrückliche Aktion
- Kosten/Tarif: Kein neues Konto/keine Bezahl-API
- Quelle → Ziel: Vorbereitete Entwürfe, keine echte Veröffentlichung
- Aktualisierung/Hintergrund: Keine automatische Veröffentlichung
- Abhängigkeiten: Zukünftige Provideradapter nötig
- Status: **Nur vorbereitet**
- Befund/Fehlergrenzen: Vorhandene Dashboards ehrliche Leerzustände; keine produktive Social-Anbindung behaupten.
- Lokale Portabilität: Entwurfsmodell lokal portabel

### Voice / Home Assistant (nur Inventur)

- Zweck/Implementierung: brain-integrations/voice.js; home-assistant.js
- Anbieter: Optionale Voice-Transporte/privates Home Assistant
- Authentifizierung: Explizite Adapter-/Entity-Freigaben; Loopback/private IP
- Kosten/Tarif: Kein laufender zusätzlicher Dienst durch diesen Auftrag
- Quelle → Ziel: Nicht auf Produktionsroute montierte Adapter
- Aktualisierung/Hintergrund: Kein neuer Job
- Abhängigkeiten: Hardware/Token extern erforderlich
- Status: **Nur vorbereitet**
- Befund/Fehlergrenzen: Keine neue Sprach-, Haushalts- oder Smart-Home-Funktion implementieren.
- Lokale Portabilität: Private Schnittstellen für spätere lokale Umgebung

### iCloud / persönlicher CalDAV

- Zweck/Implementierung: Vor diesem Auftrag nicht vorhanden; Umsetzung folgt nach Inventur
- Anbieter: Apple iCloud / CalDAV
- Authentifizierung: Keine Autorisierung vorhanden; Apple-Login ausdrücklich nicht erlaubt ohne Freigabe
- Kosten/Tarif: App-spezifisches Passwort/2FA möglich; Providerreichweite nicht kalenderbezogen garantiert
- Quelle → Ziel: Künftiger Kalenderadapter mit lokaler Allowlist und Audit
- Aktualisierung/Hintergrund: Noch kein persönlicher Kalenderjob
- Abhängigkeiten: Explizite Zugangsdaten/Accountfreigabe fehlen
- Status: **Extern blockiert**
- Befund/Fehlergrenzen: Wirtschaftskalender sind keine persönliche Kalenderintegration.
- Lokale Portabilität: Standard-CalDAV lokal betreibbar

### DHL / Paketverwaltung

- Zweck/Implementierung: Vor diesem Auftrag nicht vorhanden; Umsetzung folgt nach Inventur
- Anbieter: DHL Shipment Tracking Unified
- Authentifizierung: DHL-API-Key nach Registrierung/Freigabe
- Kosten/Tarif: DHL nennt derzeit 250 Testabrufe/Tag und 1 Abruf je 5s; tatsächliche Quote im Account prüfen
- Quelle → Ziel: Künftige manuell hinzugefügte Sendungen → eigener Organisationsspeicher
- Aktualisierung/Hintergrund: Polling nur nach Providerfreigabe und Quotenprüfung
- Abhängigkeiten: Kein DHL-Schlüssel konfiguriert
- Status: **Extern blockiert**
- Befund/Fehlergrenzen: Keine Geschäftskunden-/Privatkunden-Vollabdeckung voraussetzen.
- Lokale Portabilität: Normalisierte Statusdaten/Adapter lokal portabel

### Amazon-/Versandmail-Erkennung / IMAP

- Zweck/Implementierung: Vor diesem Auftrag nicht vorhanden; Umsetzung folgt nach Inventur
- Anbieter: Freigegebene Nachrichten, später IMAP-Adapter
- Authentifizierung: Kein Postfach freigegeben; keine Cookies/Privatseiten/API erfinden
- Kosten/Tarif: Kein Postfach/Abonnement eingerichtet
- Quelle → Ziel: Künftige freigegebene Versandmail → gemeinsame Sendung; niemals Mail-Anweisungen ausführen
- Aktualisierung/Hintergrund: Kein aktiver Mailabruf
- Abhängigkeiten: Spätere Mailbox, Ordner-/Nachrichtenfreigabe und MIME-Provider nötig
- Status: **Extern blockiert**
- Befund/Fehlergrenzen: HACS-Projekte MIT geprüft; Home-Assistant-Abhängigkeit nicht installieren.
- Lokale Portabilität: Neutrales Mail-Envelope/Providerinterface lokal möglich

## Wissensbestand – exakte reine Anzahlabfragen

- contacts: 71
- messages: 5259
- personal_memory: 98
- memory_items: 553
- memory_events: 2
- conversation_memory: 70
- review: 11
- knowledge_documents: 91
- knowledge_entries: 10911
- knowledge_evidence: 13645
- knowledge_reviews: 0
- knowledge_relations: 14177
- knowledge_meta: 5

PostgreSQL-Statistikschätzungen n_live_tup waren teils null trotz vorhandener Datensätze; deshalb wurden obige counts explizit geprüft. Daraus wurden keine Löschungen/Leerzustände abgeleitet. Fachquellen und persönliche Fakten sind getrennt. Historie/Meinung/Plan/Hypothese sind eigene Knowledge-Arten. Projekte und Kommunikationsregeln kommen aus Dokumenten sowie expliziten Chatvorschlägen; persönliches Wissen verlangt Review. Direkte Owner-Fakten haben eigene flags und Gültigkeit.

Importpfade: discover/extract/service (DOCX, EPUB, PDF, Text/JSON) sowie learning/document-import im Chat; historische WhatsApp-Importe sind ein eigener privater Kontaktpfad und kein pauschal freigegebener Wissensimport. Deduplizierung über Inhalts-/Dokumenthashes und Evidenzbezüge. EXPECTED_DOCUMENTS in discover.js registriert sieben erwartete Hauptdokumente, fehlende Pfade bleiben als missing sichtbar; ausgeschlossene Drittpersonen-Chats werden nicht als importiertes Wissen ausgegeben. Neue Rohdatei-Imports dürfen nicht nur wegen eines vorhandenen Indexes als vollständig exportiert gelten. Verwaisungs-/Duplikatprüfung wird separat aggregiert, keine automatischen Reparaturen.

## index.js – belastbare Modulgrenzen

18599 Zeilen; 145 Top-Level-Funktionsdeklarationen per Acorn-AST (temporäres Analysewerkzeug, keine Projektabhängigkeit). Textsuche findet zusätzlich verschachtelte Deklarationen. Keine doppelten Top-Level-Funktionsnamen. Semantisch ähnliche Normalisierer/Übersetzer sind keine nachgewiesenen identischen Funktionen.

Größte tatsächliche Funktionen:

| Funktion | Zeilen (Basis) | Größe | Direkte interne Aufrufe |
|---|---|---|---|
| initDatabase | 1398–2166 | 769 | seedMarcelMemory |
| seedMarcelMemory | 2173–2623 | 451 | keine direkten lokalen Funktionsaufrufe erkannt |
| ensureContact | 3203–3639 | 437 | isTestJid, isProfileJid, findContactByIdentifier, addContactIdentifier |
| applyMemoryItems | 6835–7206 | 372 | normalizeText, detectDeterministicContradiction, createContradictionEvent, findSimilarActiveMemory, clampConfidence, clampImportance, renderJson |
| translateDashboardMessagesToGerman | 4479–4820 | 342 | normalizeText, dashboardTranslationSourceHash, safeJsonParse |
| translateDashboardStructuredValueListToGerman | 10829–11144 | 316 | ensureDashboardContentTranslationTable, normalizeText, dashboardStructuredSourceText, dashboardContentTranslationKey, dashboardStructuredValueNeedsTranslation, dashboardTranslationBatches, safeJsonParse, dashboardJsonTypeMatches, saveDashboardTranslationCacheRows |
| extractMemoryUpdates | 7395–7678 | 284 | getConversationHistory, getContactMemoryProfile, getRelevantMemoryItems, getRelevantMemoryEvents, getMarcelLiveState, renderJson, normalizeText, safeJsonParse, retireMemoryItems, applyMemoryItems, applyMemoryEvents, applyProfileSnapshot |
| collectDashboardBirthdayParts | 8617–8877 | 261 | dashboardBirthdayKeyKind, dashboardParseBirthdayText, dashboardIntegerOrNull, dashboardBirthMonthNumber, dashboardNormalizeBirthYear, isPlainObject, normalizeIdentityValue, collectDashboardBirthdayParts |
| startWhatsApp | 18308–18560 | 253 | handleIncomingTextMessage, handleEditedMessageUpdate |
| buildMemoryContext | 5836–6085 | 250 | renderJson |
| translateDashboardValueListToGerman | 10499–10748 | 250 | ensureDashboardContentTranslationTable, collectDashboardTranslationLeaves, normalizeText, dashboardTranslationBatches, safeJsonParse, saveDashboardTranslationCacheRows, applyDashboardTranslationLeaves |
| detectLanguageFromText | 740–956 | 217 | normalizeText |
| resolveReplyLanguage | 1193–1391 | 199 | languageCodeFromStoredValue, getContactMemoryProfile, extractLanguageHintsFromObject, getRelevantMemoryItems, normalizeText, renderJson, detectLanguageFromText, getConversationHistory, languageFromCountry |
| addContactIdentifier | 2630–2828 | 199 | normalizeText, normalizeIdentityValue |
| resolveContactBirthdayData | 9205–9393 | 189 | collectDashboardBirthdayParts, dashboardIntegerOrNull, dashboardNormalizeBirthYear, dashboardReportedAge, inferDashboardBirthYear, calculateDashboardAge |
| handleIncomingTextMessage | 18030–18215 | 186 | extractTextFromMessageContent, ensureContact, detectImmediateDuplicate, saveMessage, duplicateReplyForContact, getContactByJid, generateAIReply, scheduleMemoryUpdate |

Initialisierung initDatabase und seedMarcelMemory sind eng mit pool, Tabellen und Startreihenfolge verbunden. Seed-Fakten sind fest eingebaut; vorhandene Werte dürfen nicht ungeprüft durch Code-Seeds überschrieben oder in Dokumentation offengelegt werden. Die System-/Memory-Prompts liegen überwiegend in services/communication-policies.js, zusätzliche Modellinstruktionen in brain-chat/model.js und index.js. Modell-/Gating-Abhängigkeiten und persönliche Kontextgrenzen vor jeder Extraktion sichern.

Sichere spätere Reihenfolge: (1) reine Text-/Datum-/Birthday-Normalisierer mit Golden-Tests; (2) Übersetzungscache mit explizitem pool/client/model; (3) Memory-Provenienz/Review mit eigener Transaktionsschnittstelle; (4) Kontaktidentitätszugriffe erst nach Channel-/Migrationstests; (5) WhatsApp-Lifecycle zuletzt. DDL/Seeds nicht nebenbei modularisieren. Die vorhandenen isolierten Module Knowledge, Chat, World, Shared Media und Kommunikationspolicies weiterverwenden. Keine vollständige Verdachtszerlegung in diesem Auftrag.

Versteckte Kopplungen: globale pool/openai/MODEL, WhatsApp-Socket und Sessionzustand, Initialisierung beim Modulimport/Serverstart, verzögerte Backfills, gemeinsame Auth-Helfer, persönliche Review-Flags. Alte Dashboard-Import/Cleanup-Routen liegen außerhalb der neueren Registermodule. Die Handler prüfen dashboardApiReady und dashboardApiAuthorized vor Verarbeitung; keine ungeschützte Route wurde aufgrund ihrer Position im Monolithen behauptet. Vercel-Zugriffsschutz ersetzt diese Backend-Autorisierung nicht. Keine unautorisierten Mutationsproben wurden ausgeführt.

## Authentifizierung, Kosten, Backup und Portabilität

Neue APIs müssen Dashboard-Bearer vor jedem Datenzugriff prüfen und private/no-store setzen. Keine Secrets im Browser, Export oder Log. Bestehende Budgetfreigabe paid=false verhindert bezahlte Brain-Chat-Generierung, nicht pauschal jeden älteren OpenAI-Aufruf in index.js. Keine unkontrollierte Tarifaktivierung.

Backup: pg_dump Custom-Archiv plus pg_restore; archiviertes Verzeichnis allein ist kein Wiederherstellungstest. scripts/backup-postgres-over-tunnel.mjs und restore-verify-postgres-over-tunnel.mjs existieren. Knowledge-Transfer verlangt konkreten Datenbanknamen und Backup-/Restore-Nachweis; Originalmedien/-dokumente zusätzlich sichern. Für neue Organisationsmigration vor Anwendung frische Sicherung und echten isolierten Restore prüfen.

## Konfigurationsinventar (nur Namen)

Produktiv vorhanden: OPENAI_API_KEY, TRADING_ENABLED, TRADING_MASSIVE_ENABLED, TRADING_NEWS_ENABLED, BRAIN_KNOWLEDGE_WRITES, RAILWAY_SERVICE_MARCEL_TINDER_BOT_URL, BRAIN_CHAT_MODE, BRAIN_CHAT_ENABLED, TINDER_DISCOVERY_TRANSPORT_ENABLED, TRADING_MASSIVE_API_KEY, BRAIN_CHAT_PAID_API_ENABLED, WHATSAPP_PHONE_NUMBER, DASHBOARD_API_SECRET, BRAIN_KNOWLEDGE_ENABLED. Kein ICLOUD/CALDAV/DHL/IMAP-Zugang konfiguriert. Explizite Brain-Schalter: {"BRAIN_KNOWLEDGE_WRITES":"true","BRAIN_CHAT_MODE":"knowledge","BRAIN_CHAT_ENABLED":"true","BRAIN_CHAT_PAID_API_ENABLED":"false","BRAIN_KNOWLEDGE_ENABLED":"true"}.

Alle im Quellcode erkannten Konfigurationsnamen nach Datei:

- api/dashboard/cleanup-whatsapp-duplicates.js: DASHBOARD_PASSWORD, RAILWAY_BACKEND_URL, DASHBOARD_API_SECRET
- api/dashboard/import-whatsapp.js: DASHBOARD_PASSWORD, RAILWAY_BACKEND_URL, DASHBOARD_API_SECRET
- api/dashboard/profile-import.js: DASHBOARD_PASSWORD, RAILWAY_BACKEND_URL, DASHBOARD_API_SECRET
- api/dashboard/tinder.js: DASHBOARD_PASSWORD, RAILWAY_BACKEND_URL, DASHBOARD_API_SECRET
- api/login.js: DASHBOARD_USERNAME, DASHBOARD_PASSWORD
- api/trading.js: DASHBOARD_PASSWORD, TRADING_PUBLIC_ORIGIN, TRADING_BACKEND_URL, RAILWAY_BACKEND_URL, TRADING_API_SECRET, DASHBOARD_API_SECRET
- brain-chat/local-model.js: BRAIN_CHAT_LOCAL_APPROVED, BRAIN_CHAT_LOCAL_URL, BRAIN_CHAT_LOCAL_MODEL
- brain-chat/model.js: BRAIN_CHAT_PAID_API_ENABLED
- brain-chat/routes.js: BRAIN_CHAT_ENABLED, BRAIN_KNOWLEDGE_FILE, RAILWAY_ENVIRONMENT_ID, BRAIN_CHAT_MODE, BRAIN_CHAT_PAID_API_ENABLED, BRAIN_CHAT_LOCAL_APPROVED
- brain-knowledge/routes.js: BRAIN_KNOWLEDGE_ENABLED, BRAIN_KNOWLEDGE_FILE, RAILWAY_ENVIRONMENT_ID, BRAIN_KNOWLEDGE_WRITES
- index.js: PORT, DATABASE_URL, TINDER_DISCOVERY_TRANSPORT_ENABLED, OPENAI_API_KEY, WHATSAPP_ENABLED, DUPLICATE_WINDOW_MINUTES, OPENAI_MODEL, DASHBOARD_API_SECRET
- middleware.js: DASHBOARD_PASSWORD
- scripts/backup-postgres-over-tunnel.mjs: DATABASE_URL, DATABASE_PUBLIC_URL, PG_AUDIT_DUMP_PATH, PG_AUDIT_TUNNEL_PORT, PG_DUMP_PATH, PG_AUDIT_TUNNEL_HOST
- scripts/brain-transfer.mjs: DATABASE_URL
- scripts/contact-channel-migration.js: DATABASE_URL
- scripts/import-brain-knowledge.mjs: RAILWAY_ENVIRONMENT_ID
- scripts/import-whatsapp-chat.js: IMPORT_TIMEZONE_OFFSET, DATABASE_URL
- scripts/migrate-device-bridge-ack-canonicalization.js: DATABASE_URL
- scripts/pgboss-migration.js: DATABASE_URL
- scripts/postgres-readonly-audit.mjs: DATABASE_URL, DATABASE_PUBLIC_URL, PG_AUDIT_DATABASE, PG_AUDIT_TUNNEL_PORT, PG_AUDIT_TUNNEL_HOST
- scripts/probe-live-brain.mjs: BRAIN_LIVE_BASE_URL, DASHBOARD_API_SECRET
- scripts/remove-owned-restore-databases.mjs: PG_OWNED_RESTORE_DATABASE, DATABASE_URL, DATABASE_PUBLIC_URL, PG_AUDIT_TUNNEL_PORT, PG_AUDIT_TUNNEL_HOST
- scripts/restore-verify-postgres-over-tunnel.mjs: DATABASE_URL, DATABASE_PUBLIC_URL, PG_AUDIT_DUMP_PATH, PG_AUDIT_TUNNEL_PORT, PG_AUDIT_RESTORE_DATABASE, PG_AUDIT_TUNNEL_HOST, PG_RESTORE_PATH
- scripts/shared-media-content-migration.js: DATABASE_URL
- scripts/shared-media-migration.js: DATABASE_URL
- scripts/start-brain-chat.mjs: RAILWAY_ENVIRONMENT_ID, DASHBOARD_USERNAME, DASHBOARD_PASSWORD, BRAIN_KNOWLEDGE_FILE, BRAIN_CHAT_MODEL, OPENAI_MODEL, OPENAI_API_KEY, BRAIN_CHAT_PORT
- scripts/tinder-block2-correct-existing-history.mjs: APPIUM_BASE_URL, TINDER_MIRROR_BASE_URL, APPIUM_SESSION, DASHBOARD_API_SECRET, TINDER_BLOCK2_CORRECTION_LIMIT, TINDER_BLOCK2_MAX_UPWARD_GESTURES, TINDER_DEVICE_VERSION_CODE, TINDER_BLOCK2_DIRECT_REPAIR_CONVERSATION_ID
- scripts/tinder-block2-initial-sync.mjs: APPIUM_SESSION, DASHBOARD_API_SECRET, TINDER_DEVICE_VERSION_CODE, APPIUM_BASE_URL, TINDER_MIRROR_BASE_URL, SHARED_MEDIA_ENABLED, TINDER_BLOCK2_MAX_INBOX_GESTURES, TINDER_BLOCK2_MAX_UPWARD_GESTURES, TINDER_BLOCK2_MAX_PROFILE_GESTURES
- scripts/tinder-block2-last-message-order-migration.js: DATABASE_URL
- scripts/tinder-block2-match-initial-sync.mjs: APPIUM_SESSION, DASHBOARD_API_SECRET, TINDER_DEVICE_VERSION_CODE, APPIUM_BASE_URL, TINDER_MIRROR_BASE_URL, TINDER_BLOCK2_MAX_MATCH_GESTURES, SHARED_MEDIA_ENABLED
- scripts/tinder-block2-match-live-profile.mjs: APPIUM_SESSION, TINDER_MATCH_REQUEST_JSON, APPIUM_BASE_URL, TINDER_MATCH_LIVE_MAX_CAROUSEL_GESTURES, TINDER_MATCH_LIVE_MAX_PROFILE_GESTURES
- scripts/tinder-block2-matches-migration.js: DATABASE_URL
- scripts/tinder-conversation-mirror-migration.js: DATABASE_URL
- scripts/tinder-discovery-worker.mjs: TINDER_SSH_TARGET, TINDER_DATABASE_TUNNEL_PORT, TINDER_SSH_IDENTITY_FILE, TINDER_RECONCILIATION_INTERVAL_MS, DATABASE_URL
- scripts/tinder-match-lifecycle-migration.js: DATABASE_URL
- scripts/tinder-match-profile-migration.js: DATABASE_URL
- shared-media/dashboard-proxy.js: RAILWAY_BACKEND_URL, DASHBOARD_API_SECRET
- shared-media/runtime.js: SHARED_MEDIA_ENABLED, MEDIA_STORAGE_ROOT, RAILWAY_ENVIRONMENT_ID, RAILWAY_VOLUME_MOUNT_PATH, FFMPEG_PATH, FFPROBE_PATH
- test/brain-chat.test.js: DASHBOARD_PASSWORD, RAILWAY_BACKEND_URL, DASHBOARD_API_SECRET
- test/brain-experience.preview.mjs: BRAIN_PREVIEW_RECORDING, BRAIN_PREVIEW_PORT
- test/marcel-brain-manual-write.test.js: DASHBOARD_PASSWORD, RAILWAY_BACKEND_URL, DASHBOARD_API_SECRET
- test/tinder-contact-proxy.test.js: DASHBOARD_PASSWORD, DASHBOARD_API_SECRET, RAILWAY_BACKEND_URL
- test/tinder-worker-runtime.test.js: DATABASE_URL, TINDER_DEVICE_VERSION_CODE, APPIUM_SESSION
- tinder-mirror/local-appium-discovery-runtime.js: ADB_PATH, ANDROID_HOME, LOCALAPPDATA, ANDROID_SERIAL, APPIUM_BASE_URL, APPIUM_SESSION
- tinder-mirror/local-process-match.js: TINDER_MIRROR_BASE_URL, APPIUM_SESSION, APPIUM_BASE_URL, DASHBOARD_API_SECRET, SHARED_MEDIA_ENABLED
- trading-core/migrate.js: DATABASE_URL
- trading-core/preflight.js: TRADING_ENABLED, DATABASE_URL, TRADING_API_SECRET, DASHBOARD_API_SECRET, TRADING_INGEST_TOKEN, TRADING_INTELLIGENCE_TOKEN, TRADING_BACKEND_URL, RAILWAY_BACKEND_URL
- trading-core/server/api.js: TRADING_API_SECRET, DASHBOARD_API_SECRET, TRADING_INGEST_TOKEN, TRADING_INTELLIGENCE_TOKEN, TRADING_DEMO, TRADING_DEBUG, TRADING_ENABLED, TRADING_NEWS_ENABLED
- trading-core/server/context-sync.js: TRADING_NEWS_ENABLED, TRADING_ECONOMIC_CALENDAR_KEY, TRADING_FRED_KEY
- trading-core/server/providers.js: TRADING_NEWS_ENABLED, TRADING_ECONOMIC_CALENDAR_KEY, TRADING_FRED_KEY, TRADING_DATABENTO_KEY, TRADING_DATABENTO_ENABLED, TRADING_MASSIVE_API_KEY, TRADING_MASSIVE_ENABLED, TRADING_INGEST_TOKEN, TRADING_INTELLIGENCE_TOKEN, TRADING_HISTORY_MAX_COST_USD
- trading-core/server/standalone.js: TRADING_PORT, TRADING_HOST, TRADING_LOCAL_FILE, TRADING_ALLOW_FILE_SERVER, DATABASE_URL, TRADING_LOCAL_PASSWORD, DASHBOARD_PASSWORD, TRADING_SECURE_COOKIE, TRADING_DEBUG, TRADING_CONTEXT_POLL, TRADING_CONTEXT_INTERVAL_MS
- trading-core/tests/api.test.js: TRADING_API_SECRET, TRADING_INTELLIGENCE_TOKEN, TRADING_INGEST_TOKEN
- trading-core/tests/current-integration.test.js: TEMP, TMP
- trading-core/tests/gateway.test.js: DASHBOARD_PASSWORD, TRADING_BACKEND_URL, TRADING_API_SECRET
- trading-core/tests/massive.test.js: TRADING_MASSIVE_API_KEY
- trading-core/tests/postgres-smoke.js: TRADING_TEST_DB_ACK, TRADING_TEST_DATABASE_URL, DATABASE_URL
- trading-core/tests/update.test.js: DATABASE_URL
- trading-core/tools/update-engine.mjs: DATABASE_URL
- trading-core/workers/context.js: DATABASE_URL

## Routenregister (statische Pfade)

### brain-chat/routes.js

- ALL `/dashboard-api/marcel-brain/chat` (Zeile 37)

### brain-knowledge/routes.js

- ALL `/dashboard-api/marcel-brain/knowledge` (Zeile 18)

### brain-world/routes.js

- ALL `/dashboard-api/marcel-brain/world` (Zeile 9)

### device-bridge/reset-block-routes.js

- POST `/device-bridge/v1/devices/:deviceId/heartbeat` (Zeile 72)
- POST `/device-bridge/v1/devices/:deviceId/commands/:commandId/ack` (Zeile 73)
- POST `/device-bridge/v1/devices/:deviceId/tinder-change-hints` (Zeile 74)
- GET `/dashboard-api/device-bridge/devices` (Zeile 75)
- GET `/dashboard-api/device-bridge/devices/:deviceId/status` (Zeile 76)
- GET `/dashboard-api/device-bridge/devices/:deviceId/commands/:commandId` (Zeile 77)
- POST `/dashboard-api/device-bridge/devices/:deviceId/revoke` (Zeile 78)
- POST `/dashboard-api/device-bridge/devices/:deviceId/commands` (Zeile 79)

### index.js

- USE `/device-bridge/v1` (Zeile 85)
- USE `/device-bridge/v1` (Zeile 92)
- USE `/device-bridge/v1` (Zeile 94)
- POST `/dashboard-api/cleanup-whatsapp-duplicates` (Zeile 5393)
- POST `/dashboard-api/import-whatsapp` (Zeile 5489)
- GET `/dashboard-api/import-whatsapp-status` (Zeile 5550)
- POST `/dashboard-api/device-bridge/enrollment-codes` (Zeile 7938)
- POST `/device-bridge/v1/enroll` (Zeile 7958)
- GET `/dashboard-api/contacts` (Zeile 11151)
- POST `/dashboard-api/contacts` (Zeile 11642)
- PATCH `/dashboard-api/contacts/:id` (Zeile 12051)
- DELETE `/dashboard-api/contacts/:id` (Zeile 12639)
- POST `/dashboard-api/profile-import` (Zeile 13487)
- GET `/dashboard-api/marcel-brain` (Zeile 13707)
- POST `/dashboard-api/marcel-brain` (Zeile 14057)
- POST `/dashboard-api/marcel-brain/classify` (Zeile 14684)
- POST `/dashboard-api/marcel-brain/facts` (Zeile 14708)
- PATCH `/dashboard-api/marcel-brain/facts/:id` (Zeile 14796)
- PATCH `/dashboard-api/marcel-brain/live-state` (Zeile 14878)
- POST `/dashboard-api/contacts/:id/translations` (Zeile 14959)
- POST `/dashboard-api/contacts/:id/identities` (Zeile 15090)
- DELETE `/dashboard-api/contacts/:id/identities` (Zeile 15108)
- GET `/dashboard-api/contacts/:id` (Zeile 15126)
- GET `/` (Zeile 16015)
- GET `/db-test` (Zeile 16031)
- GET `/memory-status` (Zeile 16084)
- GET `/pairing-code` (Zeile 16177)
- GET `/persona-test` (Zeile 16213)
- POST `/persona-test/contacts` (Zeile 17470)
- POST `/persona-test/create-contact` (Zeile 17537)
- POST `/persona-test/snapshot` (Zeile 17644)
- POST `/persona-test/message` (Zeile 17746)

### scripts/night-local-preview.mjs

- USE `/api/dashboard/marcel-brain` (Zeile 10)
- GET `/__fixture` (Zeile 12)
- ALL `/api/dashboard/marcel-brain` (Zeile 16)
- USE `/Brain` (Zeile 20)
- GET `/presentation.js` (Zeile 20)

### scripts/start-brain-chat.mjs

- POST `/api/login` (Zeile 22)
- USE `/api/dashboard/marcel-brain` (Zeile 24)
- GET `/` (Zeile 31)
- GET `/Hub/` (Zeile 32)
- USE `/Brain` (Zeile 33)
- USE `/Brain` (Zeile 34)
- GET `/presentation.js` (Zeile 35)
- GET `/login.html` (Zeile 36)

### shared-media/delivery.js

- GET `/dashboard-api/media/:assetId` (Zeile 10)

### test/brain-world.live-server.mjs

- ALL `/api/dashboard/marcel-brain` (Zeile 11)

### test/tinder-matches.test.js

- POST `/dashboard-api/tinder/matches` (Zeile 244)

### tinder-mirror/media.js

- POST `/dashboard-api/tinder/:ownerType/:ownerId/media` (Zeile 70)

### tinder-mirror/routes.js

- GET `/dashboard-api/tinder/matches/:matchId/profile` (Zeile 43)
- POST `/dashboard-api/tinder/matches/:matchId/process` (Zeile 54)
- POST `/dashboard-api/tinder/matches/:matchId/profile` (Zeile 65)
- POST `/dashboard-api/tinder/matches/:matchId/contact` (Zeile 73)
- POST `/dashboard-api/tinder/conversations/:conversationId/contact` (Zeile 84)
- POST `/dashboard-api/tinder/conversations/resolve` (Zeile 98)
- POST `/dashboard-api/tinder/conversations` (Zeile 108)
- POST `/dashboard-api/tinder/conversations/:conversationId/delta` (Zeile 122)
- POST `/dashboard-api/tinder/conversations/:conversationId/inbox-order` (Zeile 141)
- GET `/dashboard-api/tinder/conversations` (Zeile 165)
- GET `/dashboard-api/tinder/conversations/:conversationId` (Zeile 176)
- POST `/dashboard-api/tinder/matches` (Zeile 193)
- POST `/dashboard-api/tinder/matches/inventory` (Zeile 203)
- GET `/dashboard-api/tinder/matches` (Zeile 212)

### trading-core/server/api.js

- ALL `/trading-api` (Zeile 114)

### trading-core/tests/current-integration.test.js

- GET `/existing-route` (Zeile 17)

Dispatch-Operationen ergänzen diese Pfade: World search/reverse/place/weather/news/favorites/saved/finance, Knowledge overview/pending/export/ask/review und Chat conversations/send/query/import/export. Dynamische Routeparameter bleiben Parameter; keine konkreten Kontakt-/Nachrichten-IDs veröffentlicht.

## Datenbankregister

Tatsächlich vorhandene Tabellen (93); Statistikzeilen sind Schätzwerte und werden nicht mit exakten Datenmengen verwechselt.

| Schema | Tabelle | Zuständigkeit |
|---|---|---|
| marcel_knowledge | documents | Dokumentenwissen/Provenienz/Review |
| marcel_knowledge | entries | Dokumentenwissen/Provenienz/Review |
| marcel_knowledge | evidence | Dokumentenwissen/Provenienz/Review |
| marcel_knowledge | meta | Dokumentenwissen/Provenienz/Review |
| marcel_knowledge | relations | Dokumentenwissen/Provenienz/Review |
| marcel_knowledge | reviews | Dokumentenwissen/Provenienz/Review |
| marcel_trading | attachments | Eigenständiges Trading, unverändert |
| marcel_trading | audit | Eigenständiges Trading, unverändert |
| marcel_trading | candles | Eigenständiges Trading, unverändert |
| marcel_trading | commands | Eigenständiges Trading, unverändert |
| marcel_trading | context | Eigenständiges Trading, unverändert |
| marcel_trading | drawings | Eigenständiges Trading, unverändert |
| marcel_trading | estimates | Eigenständiges Trading, unverändert |
| marcel_trading | events | Eigenständiges Trading, unverändert |
| marcel_trading | executions | Eigenständiges Trading, unverändert |
| marcel_trading | news | Eigenständiges Trading, unverändert |
| marcel_trading | observations | Eigenständiges Trading, unverändert |
| marcel_trading | plans | Eigenständiges Trading, unverändert |
| marcel_trading | playbooks | Eigenständiges Trading, unverändert |
| marcel_trading | proposals | Eigenständiges Trading, unverändert |
| marcel_trading | reviews | Eigenständiges Trading, unverändert |
| marcel_trading | schema_versions | Eigenständiges Trading, unverändert |
| marcel_trading | settings | Eigenständiges Trading, unverändert |
| marcel_trading | snapshots | Eigenständiges Trading, unverändert |
| marcel_world | cache | Öffentliche Welt-/Finanzdaten |
| marcel_world | news | Öffentliche Welt-/Finanzdaten |
| marcel_world | sources | Öffentliche Welt-/Finanzdaten |
| pgboss | bam | Jobtransport/Queue |
| pgboss | job | Jobtransport/Queue |
| pgboss | job_common | Jobtransport/Queue |
| pgboss | job_dependency | Jobtransport/Queue |
| pgboss | queue | Jobtransport/Queue |
| pgboss | queue_stats | Jobtransport/Queue |
| pgboss | queue_stats_20260925 | Jobtransport/Queue |
| pgboss | queue_stats_20260926 | Jobtransport/Queue |
| pgboss | schedule | Jobtransport/Queue |
| pgboss | subscription | Jobtransport/Queue |
| pgboss | version | Jobtransport/Queue |
| pgboss | warning | Jobtransport/Queue |
| public | contact_conversation_binding_audit | Kontakte/Imports/Dashboard |
| public | contact_conversation_bindings | Kontakte/Imports/Dashboard |
| public | contact_human_armed_conversation_binding_audit | Kontakte/Imports/Dashboard |
| public | contact_human_armed_conversation_binding_permits | Kontakte/Imports/Dashboard |
| public | contact_human_armed_conversation_bindings | Kontakte/Imports/Dashboard |
| public | contact_identifiers | Kontakte/Imports/Dashboard |
| public | contact_memory_profiles | Persönliches/Gesprächs-/Reviewgedächtnis |
| public | contacts | Kontakte/Imports/Dashboard |
| public | dashboard_content_translations | Kontakte/Imports/Dashboard |
| public | device_bridge_audit_events | Geräteberechtigung/Transport |
| public | device_bridge_command_acks | Geräteberechtigung/Transport |
| public | device_bridge_commands | Geräteberechtigung/Transport |
| public | device_bridge_devices | Geräteberechtigung/Transport |
| public | device_bridge_enrollment_codes | Geräteberechtigung/Transport |
| public | device_bridge_keys | Geräteberechtigung/Transport |
| public | device_bridge_request_nonces | Geräteberechtigung/Transport |
| public | historical_memory_backfill_jobs | Persönliches/Gesprächs-/Reviewgedächtnis |
| public | marcel_live_state | Persönliches/Gesprächs-/Reviewgedächtnis |
| public | marcel_live_state_audit | Persönliches/Gesprächs-/Reviewgedächtnis |
| public | marcel_memory | Persönliches/Gesprächs-/Reviewgedächtnis |
| public | marcel_memory_review_log | Persönliches/Gesprächs-/Reviewgedächtnis |
| public | media | Medien und Verknüpfung |
| public | media_asset_links | Medien und Verknüpfung |
| public | media_assets | Medien und Verknüpfung |
| public | memory_events | Persönliches/Gesprächs-/Reviewgedächtnis |
| public | memory_import_review | Persönliches/Gesprächs-/Reviewgedächtnis |
| public | memory_items | Persönliches/Gesprächs-/Reviewgedächtnis |
| public | messages | Kontakte/Imports/Dashboard |
| public | profile_json_import_runs | Kontakte/Imports/Dashboard |
| public | tinder_conversation_messages | Geräte-/Tinder-Protokoll |
| public | tinder_conversations | Geräte-/Tinder-Protokoll |
| public | tinder_identity_mapping_audit | Geräte-/Tinder-Protokoll |
| public | tinder_local_conversation_attestation_audit | Geräte-/Tinder-Protokoll |
| public | tinder_local_conversation_attestation_permits | Geräte-/Tinder-Protokoll |
| public | tinder_matches | Geräte-/Tinder-Protokoll |
| public | tinder_official_app_resume_permits | Geräte-/Tinder-Protokoll |
| public | tinder_reply_draft_audit | Geräte-/Tinder-Protokoll |
| public | tinder_reply_drafts | Geräte-/Tinder-Protokoll |
| public | tinder_reply_send_approvals | Geräte-/Tinder-Protokoll |
| public | tinder_reply_send_audit | Geräte-/Tinder-Protokoll |
| public | tinder_reply_send_intents | Geräte-/Tinder-Protokoll |
| public | tinder_resumed_foreground_chat_return_audit | Geräte-/Tinder-Protokoll |
| public | tinder_resumed_foreground_chat_return_permits | Geräte-/Tinder-Protokoll |
| public | tinder_thread_conversation_capture_links | Geräte-/Tinder-Protokoll |
| public | tinder_thread_conversations | Geräte-/Tinder-Protokoll |
| public | tinder_unbound_inbox_conversation_sweep_audit | Geräte-/Tinder-Protokoll |
| public | tinder_unbound_inbox_conversation_sweep_steps | Geräte-/Tinder-Protokoll |
| public | tinder_unbound_inbox_conversation_sweep_transcripts | Geräte-/Tinder-Protokoll |
| public | tinder_unbound_inbox_conversation_sweeps | Geräte-/Tinder-Protokoll |
| public | tinder_verified_chat_return_audit | Geräte-/Tinder-Protokoll |
| public | tinder_verified_chat_return_permits | Geräte-/Tinder-Protokoll |
| public | tinder_visible_chat_captures | Geräte-/Tinder-Protokoll |
| public | tinder_visible_chat_sync_permits | Geräte-/Tinder-Protokoll |
| public | tinder_visible_chat_sync_transcripts | Geräte-/Tinder-Protokoll |

## Vollständiger index.js-Funktionsanhang

| Name | Beginn | Ende | Direkte lokale Abhängigkeiten |
|---|---|---|---|
| initializeTinderDiscoveryTransport | 69 | 80 | — |
| normalizeText | 151 | 157 | — |
| normalizeForDuplicate | 160 | 168 | normalizeText |
| normalizeIdentityValue | 171 | 186 | normalizeText |
| renderJson | 189 | 205 | — |
| safeJsonParse | 208 | 289 | — |
| clampConfidence | 292 | 314 | — |
| clampImportance | 317 | 341 | — |
| isTestJid | 344 | 353 | — |
| isProfileJid | 356 | 366 | — |
| createProfileJid | 369 | 393 | normalizeIdentityValue |
| createTestSlug | 396 | 421 | normalizeIdentityValue |
| cleanIntegerArray | 424 | 460 | — |
| extractTextFromMessageContent | 463 | 479 | — |
| extractEditedText | 482 | 491 | extractTextFromMessageContent |
| isPlainObject | 494 | 509 | — |
| mergeProfileObjects | 512 | 579 | isPlainObject, mergeProfileObjects |
| languageCodeFromStoredValue | 675 | 737 | normalizeText |
| detectLanguageFromText | 740 | 956 | normalizeText |
| languageNameFromCode | 959 | 975 | — |
| languageFromCountry | 978 | 1041 | normalizeIdentityValue |
| extractLanguageHintsFromObject | 1044 | 1190 | normalizeIdentityValue |
| resolveReplyLanguage | 1193 | 1391 | languageCodeFromStoredValue, getContactMemoryProfile, extractLanguageHintsFromObject, getRelevantMemoryItems, normalizeText, renderJson, detectLanguageFromText, getConversationHistory, languageFromCountry |
| initDatabase | 1398 | 2166 | seedMarcelMemory |
| seedMarcelMemory | 2173 | 2623 | — |
| addContactIdentifier | 2630 | 2828 | normalizeText, normalizeIdentityValue |
| findContactByIdentifier | 2831 | 2884 | normalizeIdentityValue |
| getContactByIdentityKey | 2887 | 2914 | — |
| getContactMemoryProfile | 2921 | 3069 | isPlainObject, resolveContactBirthdayData |
| applyProfileSnapshot | 3073 | 3196 | getContactMemoryProfile, mergeProfileObjects |
| ensureContact | 3203 | 3639 | isTestJid, isProfileJid, findContactByIdentifier, addContactIdentifier |
| getContactByJid | 3642 | 3670 | — |
| getContactById | 3673 | 3701 | — |
| createTestContact | 3708 | 3852 | normalizeText, createTestSlug |
| getTestContacts | 3855 | 3894 | — |
| saveMessage | 3901 | 3986 | ensureContact |
| getLastIncomingMessage | 3992 | 4029 | — |
| detectImmediateDuplicate | 4031 | 4088 | getLastIncomingMessage, normalizeForDuplicate |
| duplicateReplyForContact | 4095 | 4153 | resolveReplyLanguage |
| updateEditedIncomingMessage | 4160 | 4229 | normalizeText |
| getConversationHistory | 4236 | 4323 | — |
| getDashboardConversationHistory | 4331 | 4450 | — |
| dashboardTranslationSourceHash | 4460 | 4476 | normalizeText |
| translateDashboardMessagesToGerman | 4479 | 4820 | normalizeText, dashboardTranslationSourceHash, safeJsonParse |
| getDashboardMessageCount | 4828 | 4861 | — |
| parseWhatsAppExportDate | 4869 | 4883 | normalizeText |
| parseWhatsAppExport | 4885 | 4916 | parseWhatsAppExportDate, normalizeText |
| normalizeImportSender | 4918 | 4921 | normalizeText |
| historicalImportHash | 4923 | 4930 | normalizeForDuplicate |
| historicalMessageAlreadyExists | 4932 | 4958 | normalizeForDuplicate |
| importWhatsAppHistory | 4960 | 5120 | parseWhatsAppExport, normalizeText, normalizeImportSender, historicalImportHash, historicalMessageAlreadyExists |
| ensureHistoricalMemoryReviewTable | 5126 | 5134 | — |
| historicalConversationRows | 5135 | 5138 | parseWhatsAppExport, normalizeImportSender, normalizeText |
| compactMemoryValue | 5139 | 5139 | — |
| createHistoricalReview | 5140 | 5145 | ensureHistoricalMemoryReviewTable, normalizeText, compactMemoryValue |
| applyHistoricalMarcelDecisions | 5146 | 5160 | normalizeText, compactMemoryValue, clampImportance, createHistoricalReview |
| applyHistoricalContactDecisions | 5161 | 5170 | normalizeText, createHistoricalReview, retireMemoryItems, applyMemoryItems |
| ensureHistoricalBackfillJobsTable | 5171 | 5178 | — |
| historicalChunkCount | 5180 | 5180 | — |
| updateHistoricalBackfillJob | 5181 | 5187 | ensureHistoricalBackfillJobsTable |
| runHistoricalMemoryBackfill | 5188 | 5213 | historicalConversationRows, updateHistoricalBackfillJob, ensureHistoricalMemoryReviewTable, historicalChunkCount, getRelevantMemoryItems, renderJson, safeJsonParse, applyHistoricalContactDecisions, applyHistoricalMarcelDecisions |
| scheduleHistoricalMemoryBackfill | 5215 | 5215 | ensureHistoricalBackfillJobsTable, historicalConversationRows, historicalChunkCount, runHistoricalMemoryBackfill, updateHistoricalBackfillJob |
| duplicateCleanupToken | 5227 | 5229 | — |
| buildWhatsAppDuplicateCleanupPlan | 5231 | 5391 | parseWhatsAppExport, normalizeImportSender, normalizeForDuplicate, normalizeText, duplicateCleanupToken |
| getRelevantMemoryItems | 5566 | 5625 | — |
| getHistoricalMemoryItems | 5628 | 5660 | — |
| getRelevantMemoryEvents | 5667 | 5717 | — |
| getAllMemoryEvents | 5720 | 5749 | — |
| getMarcelMemory | 5757 | 5803 | — |
| getMarcelLiveState | 5806 | 5829 | — |
| buildMemoryContext | 5836 | 6085 | renderJson |
| generateSharedReply | 6092 | 6241 | languageNameFromCode |
| generateAIReply | 6248 | 6365 | getContactByJid, ensureContact, getConversationHistory, getContactMemoryProfile, getRelevantMemoryItems, getRelevantMemoryEvents, getMarcelMemory, getMarcelLiveState, buildMemoryContext, resolveReplyLanguage, generateSharedReply |
| findSimilarActiveMemory | 6372 | 6412 | — |
| retireMemoryItems | 6418 | 6472 | cleanIntegerArray |
| childSignalFromMemory | 6479 | 6596 | normalizeText |
| detectDeterministicContradiction | 6603 | 6707 | childSignalFromMemory, getRelevantMemoryItems, normalizeText |
| createContradictionEvent | 6714 | 6827 | normalizeText |
| applyMemoryItems | 6835 | 7206 | normalizeText, detectDeterministicContradiction, createContradictionEvent, findSimilarActiveMemory, clampConfidence, clampImportance, renderJson |
| applyMemoryEvents | 7213 | 7388 | normalizeText, clampImportance |
| extractMemoryUpdates | 7395 | 7678 | getConversationHistory, getContactMemoryProfile, getRelevantMemoryItems, getRelevantMemoryEvents, getMarcelLiveState, renderJson, normalizeText, safeJsonParse, retireMemoryItems, applyMemoryItems, applyMemoryEvents, applyProfileSnapshot |
| scheduleMemoryUpdate | 7684 | 7706 | extractMemoryUpdates |
| personaPasswordCorrect | 7713 | 7729 | — |
| getTestContactSnapshot | 7736 | 7807 | getContactByJid, getConversationHistory, getContactMemoryProfile, getRelevantMemoryItems, getHistoricalMemoryItems, getAllMemoryEvents, getMarcelLiveState |
| dashboardApiAuthorized | 7815 | 7889 | normalizeText |
| dashboardApiReady | 7892 | 7925 | — |
| dashboardContactError | 7999 | 8014 | — |
| normalizeDashboardPhoneNumber | 8017 | 8053 | dashboardContactError |
| normalizeDashboardWhatsAppUsername | 8057 | 8089 | normalizeText, dashboardContactError |
| normalizeDashboardCountryValue | 8092 | 8151 | normalizeText, normalizeIdentityValue |
| normalizeDashboardCityValue | 8154 | 8184 | normalizeText, normalizeIdentityValue |
| normalizeDashboardLanguageValue | 8187 | 8242 | normalizeText, normalizeIdentityValue |
| dashboardIntegerOrNull | 8245 | 8282 | normalizeText |
| dashboardBirthMonthNumber | 8285 | 8353 | dashboardIntegerOrNull, normalizeIdentityValue |
| dashboardBirthdayPartsValid | 8356 | 8396 | — |
| dashboardNormalizeBirthYear | 8399 | 8412 | dashboardIntegerOrNull |
| dashboardParseBirthdayText | 8415 | 8538 | normalizeText, dashboardBirthMonthNumber |
| dashboardBirthdayKeyKind | 8541 | 8614 | normalizeIdentityValue |
| collectDashboardBirthdayParts | 8617 | 8877 | dashboardBirthdayKeyKind, dashboardParseBirthdayText, dashboardIntegerOrNull, dashboardBirthMonthNumber, dashboardNormalizeBirthYear, isPlainObject, normalizeIdentityValue, collectDashboardBirthdayParts |
| dashboardAgeFromValue | 8880 | 8945 | isPlainObject, dashboardAgeFromValue |
| dashboardReportedAge | 8948 | 9073 | normalizeIdentityValue, dashboardAgeFromValue |
| dashboardTodayParts | 9075 | 9121 | — |
| calculateDashboardAge | 9124 | 9163 | dashboardBirthdayPartsValid |
| inferDashboardBirthYear | 9166 | 9202 | dashboardBirthdayPartsValid |
| resolveContactBirthdayData | 9205 | 9393 | collectDashboardBirthdayParts, dashboardIntegerOrNull, dashboardNormalizeBirthYear, dashboardReportedAge, inferDashboardBirthYear, calculateDashboardAge |
| dashboardBirthdayLabel | 9396 | 9452 | — |
| createDashboardContactIdentityKey | 9455 | 9498 | normalizeIdentityValue |
| upsertDashboardVerifiedContactMemory | 9501 | 9652 | clampImportance |
| syncDashboardBirthdayProfile | 9655 | 9777 | isPlainObject |
| dashboardContactBirthInput | 9780 | 9953 | dashboardIntegerOrNull, dashboardNormalizeBirthYear, dashboardContactError, dashboardBirthdayPartsValid, inferDashboardBirthYear, calculateDashboardAge |
| syncDashboardReportedAgeProfile | 9956 | 10027 | isPlainObject |
| retireDashboardReportedAgeMemory | 10030 | 10053 | — |
| applyDashboardContactHumanFacts | 10056 | 10192 | upsertDashboardVerifiedContactMemory, syncDashboardReportedAgeProfile, retireDashboardReportedAgeMemory, syncDashboardBirthdayProfile |
| ensureDashboardContentTranslationTable | 10204 | 10224 | — |
| dashboardContentTranslationKey | 10226 | 10238 | normalizeText |
| dashboardTextNeedsTranslation | 10240 | 10266 | normalizeText |
| collectDashboardTranslationLeaves | 10268 | 10335 | dashboardTextNeedsTranslation, normalizeText, dashboardContentTranslationKey, collectDashboardTranslationLeaves |
| applyDashboardTranslationLeaves | 10337 | 10401 | dashboardTextNeedsTranslation, normalizeText, dashboardContentTranslationKey, applyDashboardTranslationLeaves |
| dashboardTranslationBatches | 10403 | 10445 | — |
| saveDashboardTranslationCacheRows | 10447 | 10497 | — |
| translateDashboardValueListToGerman | 10499 | 10748 | ensureDashboardContentTranslationTable, collectDashboardTranslationLeaves, normalizeText, dashboardTranslationBatches, safeJsonParse, saveDashboardTranslationCacheRows, applyDashboardTranslationLeaves |
| dashboardStructuredValueNeedsTranslation | 10757 | 10786 | dashboardTextNeedsTranslation |
| dashboardJsonTypeMatches | 10788 | 10816 | — |
| dashboardStructuredSourceText | 10818 | 10827 | renderJson |
| translateDashboardStructuredValueListToGerman | 10829 | 11144 | ensureDashboardContentTranslationTable, normalizeText, dashboardStructuredSourceText, dashboardContentTranslationKey, dashboardStructuredValueNeedsTranslation, dashboardTranslationBatches, safeJsonParse, dashboardJsonTypeMatches, saveDashboardTranslationCacheRows |
| normalizeDashboardProfileImport | 13197 | 13329 | isPlainObject, dashboardContactError, normalizeText, normalizeIdentityValue, clampImportance, dashboardIntegerOrNull, dashboardNormalizeBirthYear, normalizeDashboardWhatsAppUsername, normalizeDashboardCityValue, normalizeDashboardCountryValue, normalizeDashboardLanguageValue |
| profileImportSnapshotFromFacts | 13331 | 13342 | isPlainObject, mergeProfileObjects |
| ensureProfileJsonImportRunsTable | 13344 | 13361 | — |
| profileImportTouchedMemoryPairs | 13363 | 13379 | — |
| profileImportMemoryRows | 13381 | 13395 | — |
| restoreProfileImportMemoryRow | 13397 | 13413 | — |
| undoDashboardProfileJsonImport | 13415 | 13485 | ensureProfileJsonImportRunsTable, dashboardContactError, isPlainObject, restoreProfileImportMemoryRow |
| normalizeMarcelReviewCorrectionToEnglish | 13966 | 14054 | normalizeText, safeJsonParse, dashboardJsonTypeMatches |
| brainWriteError | 14533 | 14537 | — |
| assertOnlyBodyFields | 14539 | 14547 | brainWriteError |
| jsonDepth | 14549 | 14553 | jsonDepth |
| canonicalJson | 14555 | 14564 | canonicalJson |
| normalizedJsonText | 14566 | 14568 | canonicalJson |
| validateManualFactValue | 14570 | 14584 | brainWriteError, jsonDepth |
| validateManualFactFields | 14586 | 14635 | normalizeText, brainWriteError, validateManualFactValue |
| safeExistingFact | 14637 | 14649 | — |
| validateBrainCandidate | 14651 | 14682 | normalizeText, renderJson, validateManualFactValue, validateManualFactFields |
| handleIncomingTextMessage | 18030 | 18215 | extractTextFromMessageContent, ensureContact, detectImmediateDuplicate, saveMessage, duplicateReplyForContact, getContactByJid, generateAIReply, scheduleMemoryUpdate |
| handleEditedMessageUpdate | 18222 | 18301 | extractEditedText, updateEditedIncomingMessage |
| startWhatsApp | 18308 | 18560 | handleIncomingTextMessage, handleEditedMessageUpdate |

Grenzen: Statische Aufrufkanten erfassen direkte Identifier-Aufrufe, nicht beliebige dynamische Callback-/SQL-/Frameworkbindungen. Es wird keine unbewiesene vollständige semantische Laufzeitabdeckung behauptet. Produktionsanbieter wurden nur bei bereits autorisierten bestehenden Prüfungen tatsächlich aufgerufen.

## Nachtrag: Wissensintegrität und Organisationsmodul

Die ergänzende schreibgeschützte Prüfung fand keine verwaisten Evidenz-/Dokument-/Relationsverweise. Dokumentstatus: 74 processed, 1 active, 1 unreadable, 1 excluded, 9 missing, 5 superseded_source_version. Wissenseinträge: 1643 active, 8766 historical, 501 pending, 1 conflict. Drei Dokumentpfade kommen mehrfach vor; dies kann Quellversionierung sein und ist ohne Inhaltsprüfung kein Löschgrund. Die neun fehlenden Quellen und das unlesbare Dokument bleiben konkrete Prüf-/Beschaffungsaufgaben. Es wurden keine Wissensdaten repariert, geändert oder gelöscht.

Nach Erstellung dieser Inventur wurde das separate Organisationsmodul implementiert. Status: lokal funktionsfähige CalDAV- und DHL-Adapter mit isolierten Tests; echte Apple-/DHL-Verbindungen extern blockiert durch fehlende Freigaben/Secrets. Manuelle Paketverwaltung, synthetisch geprüfte Versandmail-Erkennung, opt-in Lieferkalender, strukturierte Abfragen und privater Export/Restore sind implementiert. Ein Mail-Providervertrag ist nur vorbereitet, kein Postfach verbunden. Details, Rechte, Intervalle, Grenzen, Open-Source-Bewertung und benötigte Freigaben: [organisation-setup.md](organisation-setup.md). Neue Implementierungsorte: brain-organisation/, Brain/organisation.*, migrations/20261020_brain_organisation.sql, scripts/organisation-transfer.mjs, test/organisation.test.js. index.js erhielt ausschließlich Import und Registrierung; keine spekulative Zerlegung und keine Trading-Änderung.
