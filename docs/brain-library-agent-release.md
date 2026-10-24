# Brain – begrenzte automatische Bibliotheksnutzung

Lokaler Release auf `6d9073532ae2b6bfaaed22b6817adfad17bff126`.
Keine Veröffentlichung, Migration, neue Abhängigkeit oder zusätzliche KI.

## Bestehender Verarbeitungspfad

`brain-chat/routes.js` → `createBrainChat().send()` in `brain-chat/service.js`
→ `brain-chat/retrieval.js` (Fakten/Dokumente) → vorhandener Wissens-, lokaler
oder ausdrücklich freigegebener Modellpfad. Das Modell hat weiterhin **keine
ausführbaren Tools**. Kein neuer Agent, SDK, Tool-Loop oder Modellwechsel.
`query()` bleibt eine reine Wissensabfrage; die Ergänzung betrifft Chat-Nachrichten.

Die Ergänzung `brain-chat/library.js` wird erst nach vorhandener Recherche
aufgerufen. Eigene Quellen haben Vorrang. Faktenantworten, Literal-/Import-/
Wissensvorschläge, native Bereiche (Wetter, Kalender, Mail, Trading, Nachrichten
usw.), einfache Gespräche/Erklärfragen und persönlicher Quellen-/Verlaufskontext
lösen keine automatische Bibliothekssuche aus. Eine aktivierte persönliche
Suchoption allein exportiert nichts und verhindert bei leerem privaten Kontext
nicht die Auswahl einer öffentlichen Arbeitsvorlage.

Begrenzte Aufgabenerkennung: Code Review, Unit-Tests, Blogtexte, Projektplanung,
Datenanalyse und Backup-Planung. Skill-Entdeckung wird bei passenden Erweiterungs-
fragen sowie Backup-Aufgaben bevorzugt. Nach außen gehen ausschließlich feste
öffentliche Themenbegriffe aus diesem Katalog und öffentliche IDs, **niemals**
Benutzernachrichten, Projekt-/Personennamen, Verlauf oder interne Quellen.

Der bestehende MCP-Client wird gemeinsam mit der unveränderten Bibliotheksseite
verwendet: gleiche Allowlist, öffentlicher Cache und Gesamt-Anfragebegrenzung.
Pro Chat-Nachricht maximal eine Suche und ein Einzelabruf, sechs Sekunden
Zusatzbudget inklusive Abbruchschutz. Keine weiteren LLM-Aufrufe zum Routing
oder Bewerten. Relevanz nach Titel/Beschreibung/Tags, Mindestscore, gleicher ID,
Mindestinhalt und konservativer Filter gegen offensichtliche Injektions-/
Geheimnis-/Befehlsmuster. Kein Treffer, ungeeigneter Inhalt, Timeout oder Ausfall:
bisherigen Antwortpfad weiterverwenden, nichts erfinden.

## Verwendung und Isolation

Eine passende Promptvorlage wird begrenzt als **ungeprüfte Datennachricht** vor
der eigentlichen Benutzeraufgabe in den vorhandenen Modellkontext gegeben.
Der Fremdtext gelangt nicht in Systemanweisungen. Eine feste Schutzregel
verhindert die Zuschreibung neuer Systemregeln oder Berechtigungen. Es gibt
unabhängig davon keine ausführbare Werkzeug-, Datei- oder Deployment-Schnittstelle.
Die Filter sind keine allgemeine Sicherheitszertifizierung fremder Vorlagen.

Bei Skills gelangen nur Beschreibung, Dateinamen und geprüfte Anzeigefelder der
Voraussetzungsübersicht in die Antwort; **keine Skript- oder SKILL.md-Inhalte**
werden als Modellanweisungen übernommen. Nur Vorschläge, keine Installation.
Vor Installation/zusätzlichen Berechtigungen wird ausdrücklich gefragt. Der
Wissensmodus zeigt stattdessen die bezeichnete Originalvorlage bzw. einen
Skillvorschlag samt Quellenhinweis und Berechtigungsfrage; keine erfundene
generierte Aufgabenerledigung. Lokaler Modellfehler behält den kostenfreien
Wissensfallback bei, einschließlich einer bereits ausgewählten Vorlage.

Zusätzlich zur regulären Chatantwort werden nur Quellenmetadaten im bestehenden
Chat-Verlauf gespeichert; keine Skill-Dateiinhalte und keine Einträge im
Wissens-/Regelarchiv. Vorhandene Review- und Importwege bleiben
unverändert. Öffentlicher Cache enthält keine Benutzerkontexte. Die bestehende
Ein-Eigentümer-Authentifizierung wird beibehalten; keine neue Mehrbenutzerverwaltung.
UI einzig geändert: externe Vorlagen werden korrekt als „Externe Arbeitsvorlage“
statt als „Gespeichertes Wissen“ bezeichnet. Bibliotheksseite und Workspaces
bleiben unverändert.

## Gezielte Prüfung

`node --test test/brain-library-agent.test.js test/brain-chat.test.js test/prompts-library.test.js`:
**20/20 bestanden**. Normale Gespräche, eigene Quellen, persönliche Fakten/
Verläufe, feste öffentliche Argumente, maximal zwei Werkzeugaufrufe, Auswahl,
Modelldaten-/Systemtrennung, keine Skill-Dateiausführung, Fehler-/Injektions-
fallback, hängender Transport, Abbruch, Gesprächsisolation, lokale Modellfehler,
vorhandener Chat-/Proxy-/MCP-Schutz geprüft.

Live mit isoliertem SQLite-Testwissen und ohne Modellaufrufe:
Code Review → Promptvorlage; Backup-Planung → Skill mit Python-/Dateihinweisen.
`unit testing` lieferte bei der Prüfung keine Skills; dieser Fall bleibt bewusst
ohne erfundenen Treffer. Regulärer lokaler Login und voller HTTP-Proxy-/SSE-Ablauf
mit aktivierter persönlicher Suchoption: Login 200, Unterhaltung 201, normale
Nachricht 200 ohne Bibliothek, Prompt-Nachricht 200, Skill-Nachricht 200;
unauthentifiziert 401. Keine Wissenseinträge erzeugt. Kein Produktionszugriff.

Browserprüfung nicht durchgeführt: aktuelle Browserinventur leer, Erstellen
eines IAB-Tabs meldet „Browser is not available“. Daher nur der vollständige
HTTP-/SSE-Nachweis, keine behauptete visuelle Abnahme. JavaScript-Syntax und
`git diff --check` erfolgreich. Keine Änderungen an produktiven Konfigurationen.

Nach gesonderter Deploymentfreigabe exakt den Release veröffentlichen. Kein
Datenbankschritt notwendig; Rückfall durch erneute Bereitstellung von `6d90735`,
ohne Löschung oder Datenrestore. Neue Chat-Metadaten bleiben als JSON erhalten.
