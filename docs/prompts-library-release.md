# prompts.chat – isolierter Release

Basis: `b42e82eabb996a08f134f661433733d4aff719e4`. Nur lokale Vorbereitung,
keine Veröffentlichung, Migration, neue Abhängigkeit oder kostenpflichtige API.

## Umsetzung

Die gezielte Codeprüfung fand keinen vorhandenen allgemeinen MCP-Client oder
Werkzeugkatalog. Wiederverwendet werden der bestehende Brain-Session-Login,
Dashboard-Proxy, Backend-Bearer und das bestehende Glass-Design. Der spezialisierte
Adapter `brain-integrations/prompts-library.js` unterstützt ausschließlich:

* `search_prompts`: `query`, `limit=10`, optional `category` und `tag` als Slugs.
* `get_prompt`: `id`, fest `fill_variables=false`; keine Elicitation.
* `search_skills`: `query`, `limit=10`, optional `category` und `tag`.
* `get_skill`: `id`; Dateien werden nur als Daten angezeigt.

Parameter und Verfügbarkeit am 24.10.2026 tatsächlich mit `tools/list` am
[offiziellen MCP-Endpunkt](https://prompts.chat/api/mcp) geprüft, inklusive
`initialize` und `notifications/initialized`. Der dokumentierte zusätzliche
Parameter `fill_variables` wurde anhand des tatsächlichen Werkzeugschemas
verifiziert. Keine Schreib-/Verbesserungswerkzeuge freigegeben.
Quellen: [API](https://prompts.chat/docs/api), [Repository](https://github.com/f/prompts.chat).

Die geschützte Seite `/Brain/prompt-library` ist direkt in den bestehenden
Brain-Tabs und zusätzlich in der Welt-Navigation verlinkt. Bestehende Workspace-
Router und Komponenten bleiben unverändert. Suche, Kategorien/Tags, Detailansicht,
Dateiauswahl, Originalquelle, Sicherheitsstatus und bewusstes Kopieren mit
Quellenhinweis sind vorhanden. Skill-Voraussetzungen/Runtime-Hinweise und
Überschneidungen mit vorhandenen Brain-Funktionen werden regelbasiert angezeigt,
ausdrücklich ohne Kompatibilitäts- oder Sicherheitsfreigabe.

## Grenzen und Schutz

Keine zusätzliche KI, DB, Hintergrundjobs, Installation, Dateizugriffe oder
automatische Übernahme in Brain-Kontext. Kein Zugriff des Adapters auf private
Brain-Daten oder Konten. Nur ausdrücklich eingegebene öffentliche Suchbegriffe,
Filter und öffentliche IDs werden übertragen; unbekannte Eingabefelder verworfen.
Offensichtliche Zugangsdaten, E-Mail-Adressen und URLs werden als Suche abgewiesen.
Dies ersetzt nicht die Benutzerentscheidung, ausschließlich öffentliche Begriffe
einzugeben. Keine eingehenden Cookies, Bearer- oder API-Schlüssel an prompts.chat.

Festes HTTPS-Ziel ohne Weiterleitungen, vier erlaubte Werkzeuge, keine ausgehenden
Links aus Fremdinhalten abrufen, keine fremden MCP-Rückrufe ausführen. Externe
Inhalte werden per `textContent` angezeigt und nie als Markdown/HTML ausgeführt.
Auch Skill-Dateinamen sind nur Anzeigetext. Nutzungsrechte verbleiben bei der
jeweiligen Quelle; keine pauschale Lizenz-/Sicherheitsfreigabe.

Pro Serverprozess: 30 Bibliotheksanfragen/Minute, höchstens zwei parallele externe
Anfragen, 15 Sekunden Gesamt-Timeout, Antwort maximal 1 MiB, höchstens 60 Dateien,
40 öffentliche Cache-Einträge für drei Minuten. Nach drei Fehlern 30 Sekunden
Pause. Kein persistenter Speicher und keine laufenden Abos. API-Ausfälle betreffen
ausschließlich die Bibliothek; Oberfläche zeigt einen verständlichen Fehler.

## Gezielte Nachweise

* `node --test test/prompts-library.test.js test/web-ui-navigation.test.js`:
  **11/11 bestanden**. Handshake, vier Werkzeuge, Filter, Cache, Authentifizierung,
  ausdrückliche Suchfreigabe, Eingabe-/Werkzeug-Allowlist, private Zusatzfelder,
  Größenlimit, Rate-Limit und Fehler-Cooldown geprüft.
* Live gegen offiziellen MCP: beide Suchen und beide Einzelabrufe erfolgreich.
  Ein gefundener Skill lieferte sechs Dateien einschließlich `SKILL.md` und Python.
  Keine fremden Dateien gespeichert oder ausgeführt.
* Lokaler echter Browser mit regulärem Testlogin, unverändertem Dashboard-Proxy
  und echtem öffentlichen MCP: Prompt suchen/öffnen/kopieren; Skills suchen,
  Voraussetzungen ansehen und Dateien wechseln; Python als reiner PRE-Text ohne
  Script-/Iframe-/Img-Kindelemente. Direkter Einstieg aus den echten Brain-Tabs
  geprüft. Kein produktiver Login und keine privaten Produktionsdaten verwendet.
* 390×844 und 320×740 Browser-Viewport: Seitenbreite gleich Scrollbreite
  (375/375 beziehungsweise 305/305 Pixel). Mobiler Detailaufruf springt direkt
  zum Inhalt; Rücksprung zur Ergebnisliste geprüft. Viewport zurückgesetzt.
* Nicht erreichbarer externer Dienst wurde im lokalen eingeschränkten Runner
  tatsächlich als verständlicher Fehler angezeigt. Nach regulärer Netzwerkfreigabe
  funktionierte derselbe Browserablauf ohne Codeänderung.
* JavaScript-Syntaxprüfung und `git diff --check` erfolgreich.

Release erst nach ausdrücklicher Freigabe. Keine Migration oder Kontenaktivierung
notwendig. Rückfall: vorherigen Code-Release `b42e82e` wieder bereitstellen;
es gibt keine neu gespeicherten Daten oder Datenbankschritte zurückzusetzen.
