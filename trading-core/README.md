# Marcel Trading Cockpit

**Fertiger Quellcode für ein manuelles Journal und Analyse-Cockpit. Keine Orderausführung.**

Integration auf dem aktuellen Marcel-AI-main vom 14.10.2026: lokal portiert,
nicht produktiv freigeschaltet. Die September-Prüfung unter
`docs/PRUEFBERICHT.md` ist historisch, kein aktueller Deployment-Nachweis.
Der alte ZIP-Installer wurde wegen eines Zielkonflikts nicht angewendet.

Die Plattform speichert deine Entscheidungen, nicht deine Broker-Zugangsdaten. Es gibt keinen Topstep-Connector, kein automatisches Auslesen einer Brokerseite und keine Schnittstelle, die Orders senden, verändern oder schließen kann.

## Erst ansehen – ohne etwas zu installieren oder zu deployen

1. Komplett-ZIP in einen **eigenen neuen Ordner** entpacken. Nicht über einen laufenden Tinder-Arbeitsordner kopieren.
2. Mit vorhandenem **Node.js 22+** unter Windows `trading-core/Start-Demo.cmd` doppelklicken. Alternativ im Repo: `node trading-core/server/standalone.js --demo`.
3. Im Browser `http://127.0.0.1:3090/Trading/` öffnen. Das Konsolenfenster bleibt offen.

Die Demo benötigt die installierten Projektabhängigkeiten (`npm ci`), aber keine DB oder API-Keys. Sie enthält **ausschließlich synthetische Beispiele** und zeigt einen auffälligen Hinweis. Eingaben in diesem Modus verschwinden beim Serverneustart. Die Demo bindet absichtlich nur localhost; auf einem anderen Gerät ist diese Adresse nicht der Rechner. Der reale iPad-Zugang erfolgt nach kontrollierter Bereitstellung über die vorhandene HTTPS-Webseite.

## Was das Produkt enthält

- Responsive dunkle/goldene Oberfläche für iPad quer/hoch, Desktop und Telefon; bestehende Marcel-AI-Navigation bleibt erhalten.
- Gold, Nasdaq und Dow im Fokus, optional WTI, Bitcoin und USD-Nikkei. Die Instrumenttabelle ist **keine Freigabeliste einer Propfirma**.
- Eigener Kerzenchart, M1/M5/M15/M30/H1/H4/D1, EMA 20/50/100/200, Volumen, Pan/Zoom, Crosshair, Demand-/Supply-Rechtecke, Linien, Freihandzeichnen und PNG-Export. Preise und Zeiten einer Zeichnung lassen sich bearbeiten.
- Limit-Planer mit exaktem Kontrakt, Richtung, Entry, SL, TP, Stückzahl, Kosten, Zeitfenster, Blockalter, News-Kontext, Gegenargument und struktureller Invalidierung.
- Automatische Risiko-/CRV-Rechnung. Struktur-SL und Stückzahl sind getrennt; bewusste Budget-/CRV-Abweichungen benötigen eine Begründung.
- Unveränderliche Decision Snapshots mit SHA256, damaligem Kontext, Zeichnungen und Screenshots. Ein späteres Review ändert nicht die frühere Entscheidung.
- Wirkliche Ausführungen und Teil-Exits werden **manuell bestätigt**. Fehler werden durch ein zusätzliches Korrekturereignis berichtigt, nicht heimlich gelöscht.
- Journal, Abend-/Morgenreviews, Kein-Trade/Kein-Fill, Pre-/Post-Screenshots, Playbooks, bestätigte P&L-/R-/Drawdown-Auswertung, Filter, ähnliche frühere Setups.
- Konservative OHLCV-Auswertung für mögliche Limitberührung, SL/TP-Reihenfolge, MFE/MAE; mehrdeutige Kerzen oder Datenlücken werden nicht als sichere Gewinner verbucht.
- Quellenbasierte Nachrichtenüberschriften, Kalender, Makro-Notizen, FRED-Tageswerte, unabhängiger Databento-Import und separater laufender OHLCV-Worker.
- JSON-/CSV-Export, Markdown-Übergabeprotokoll und ein getrennt geschützter Read-only-JSONL-Anschluss für das spätere lokale Master Brain.

**Nicht vorgetäuscht:** Der Code enthält keine bereits trainierte Trading-KI, keine automatisch bewiesene Trefferquote, keinen Reuters-Volltextvertrag, keinen Tick-/Level-2-Feed und keine garantierten Echtgeldfills. „Ähnliche Setups“ ist ein transparenter regelbasierter Vergleich. Automatische Orderblock-/SMC-Erkennung und fremde Pine-Skripte sind nicht eingebaut; die Blöcke werden bewusst manuell gezeichnet und begründet.

## Dateien und Isolation

```text
Trading/                     Oberfläche + Canvas + reine Finanzberechnungen
api/trading.js               private Vercel-Weiterleitung zum eigenen Backend
trading-core/server/         API, Repository, Datenanbieter, separater Testserver
trading-core/schema.sql       ausschließlich neues Schema marcel_trading
trading-core/workers/         unabhängiger Feed und optionaler Kontext-Sync
trading-core/tests/           reproduzierbare Tests, optionaler PostgreSQL-Smoke
trading-core/docs/            Konfiguration, Protokoll, Daten-/Sicherheitsregeln
trading-core/evidence/        optionaler Ausgabeort lokaler UI-Testnachweise
trading-core/tools/           konfliktgeschützte Update-Logik
```

`Trading` und `trading-core` sind absichtlich verschieden benannt, auch unter Windows. Nur `Trading/index.html` wird ersetzt. `index.js` bekommt genau **einen Import, eine Kommentarzeile und einen Registrierungsaufruf**. Bestehende Tinder-, Brain-, SQL-, Middleware-, Paket- und Vercel-Konfigurationen wurden nicht verändert.

## Einspielen ohne Terra zu überschreiben

Die folgende Installer-Anleitung beschreibt das historische September-Paket,
nicht den bereits portierten aktuellen Worktree. Hier den Installer NICHT
erneut anwenden. Aktueller Source und geschützte Shared-Module haben Vorrang.

Die vollständige ZIP ist zum Anschauen und als integrierte Referenz. **Für einen inzwischen weiterentwickelten GitHub-Stand niemals das Komplettpaket darüberkopieren.**

Das Update-Paket wird außerhalb des Ziel-Repos entpackt. Zuerst:

```sh
node apply-trading-update.mjs /PFAD/ZUM/AKTUELLEN-REPO
```

Das ist nur die Vorschau. Bei konfliktfreiem Ergebnis:

```sh
node apply-trading-update.mjs /PFAD/ZUM/AKTUELLEN-REPO --apply
```

Windows-Beispiel: `node apply-trading-update.mjs "C:\Projekte\Marcel-WhatsApp-bot" --apply`.

Der Installer prüft die Payload-Hashes, lehnt veränderte Zieldateien ab und registriert Trading in `index.js` nur an einem eindeutigen `app`-/`pool`-Anker. Neuere andere `index.js`-Inhalte bleiben erhalten. Backups liegen **neben**, nicht innerhalb des Web-Repos. Er führt weder Migrationen noch Deployments aus. Auch dieser Schutz ersetzt keine separate Arbeitskopie: nicht gleichzeitig dieselben Integrationsdateien editieren.

## Aktivierung im vorhandenen System

Vollständige Anleitung: **[docs/INSTALLATION.md](docs/INSTALLATION.md)**.

In Kürze: Update prüfen → Backup der Datenbank → ausschließlich die neue Trading-Migration gezielt ausführen → identischen privaten API-Schlüssel in Vercel und eigenem Backend setzen → `TRADING_ENABLED=true` im Backend → kontrolliertes Deployment → Health-/UI-Prüfung → unabhängige Datenzugänge konfigurieren.

Der bestehende gemeinsame Login bleibt. Ohne Migration/Datenzugänge zeigt die Anwendung den passenden Fehler-/Leerzustand statt Beispielwerte. PostgreSQL ist für den produktiven Betrieb vorgesehen; lokale Dateipersistenz ist ausdrücklich nur für einen lokalen Einzelprozess.

## Kurse und Kontext

**Kostenloser Default-Kontext:** Treasury nominal/real, Fed H.10 Broad USD
(nicht DXY) und Kalender von BLS, BEA, Fed/FOMC, Census, EIA und Treasury.
FRED und Trading Economics bleiben optionale Ergänzungen. Bestehende RSS-News
werden erhalten und regelbasiert nach Macro-/Geopolitik-Themen priorisiert.
`POST resource=sync` verwendet den bestehenden Context-Pfad mit Quellen-Caches;
Bootstrap berechnet erklärbaren Market Context aus gespeicherten Daten, ohne
neuen Providerabruf. Kein Dauerworker wird durch diesen Release gestartet.
Quellen, Lizenzen, Updatefrequenzen und Grenzen stehen in
[DATEN-UND-GRENZEN.md](docs/DATEN-UND-GRENZEN.md) und
[INSTALLATION.md](docs/INSTALLATION.md).

**Zusätzliche Futures-Historie: Massive.** `TRADING_MASSIVE_ENABLED=true` und
`TRADING_MASSIVE_API_KEY` werden ausschließlich serverseitig konfiguriert.
`POST /trading-api?resource=history` akzeptiert explizit `provider: "massive"`
mit `instrument`, exaktem `contract`, `from` und `to` (ISO mit Zeitzone).
Das bestehende Cockpit bietet dieselbe Auswahl über `/api/trading`.
Verwendet wird `/futures/v1/aggs/{ticker}`, `resolution=1min`, UTC-Nanosekunden
mit inklusivem Start/exklusivem Ende. Zeiträume müssen auf Minuten liegen,
sind höchstens sieben Tage lang und dürfen nicht in die Zukunft reichen.
Pagination ist auf denselben HTTPS-Endpunkt und zwölf Seiten begrenzt.
Die Quelle ist `massive-historical`, gespeichert wird ausschließlich in der
bestehenden Candle-Tabelle. Identische Minuten werden dedupliziert; widersprüchliche
Doppelwerte brechen den Abruf ab. Wiederholte Requests können erneut Provider-Kosten
verursachen, erzeugen durch den bestehenden Unique-Key aber keine doppelten DB-Zeilen.
Es gibt keine automatische Symbolübersetzung, keinen Massive-Liveworker und keine
kostenlose Nutzungsgarantie. Ohne `provider` bleibt das bisherige Databento-Verhalten
einschließlich Kostenprüfung erhalten; explizit `provider: "databento"` ist ebenfalls möglich.

**Kurse:** Databento GLBX.MDP3 für exakt konfigurierte Futures-Monate. Historie per REST, fortlaufend abgeschlossene Ein-Minuten-Kerzen über einen separaten Python-Prozess. Livebars sind nicht Tickkurse. Kalender/FRED/RSS sind separate Quellen. DXY ist ohne eigenen ICE-Datenzugang eine ausdrücklich manuelle Beobachtung; der FRED-Breitdollarindex wird nicht DXY genannt.

**Ohne bezahlten Feed:** reales Journal/Planung sofort nach Backend-Setup nutzbar; lizenzierte OHLCV-CSV manuell importierbar. Marktanzeige bleibt ansonsten leer. API-Keys allein sind kein Beleg für CME-Entitlements oder Weiterverteilungsrechte.

**Pips:** Bei Gold gilt hier ausschließlich Marcels Konvention: 1 angezeigter Pip = 0,1 Gold-Preisabstand. Ein Micro-Gold-Kontrakt bewegt dabei 1 USD. Das ist keine universelle Definition für CFD-Broker. Bei Nasdaq/Dow sind es Indexpunkte. Die Werte und Kosten werden sichtbar ausgewiesen.

## Prüfungen

```sh
node --test trading-core/tests/*.test.js test/*.test.js
python -m unittest discover -s trading-core/tests -p "test_*.py"
node trading-core/migrate.js
node trading-core/preflight.js
```

Optionaler UI-Test: lokalen flüchtigen Demo-Server frisch starten; mit installiertem Playwright/Chromium `python trading-core/tests/ui_smoke.py` ausführen. Er arbeitet ausschließlich auf der ausdrücklich erkannten Demo und erzeugt Screenshot-/JSON-Nachweise. `TRADING_TEST_CHROMIUM` erlaubt vorhandenes Chrome; `TRADING_TEST_OUTPUT` legt einen temporären Ausgabeort außerhalb des Repos fest. Die Offline-Render-Testmethode ist im Prüfbericht beschrieben. Die zusätzlichen aktuellen Integrationsprüfungen verwenden Express auf localhost, einen vollständig isolierten VM-Serverstart und PGlite im RAM; sie ersetzen keinen echten PostgreSQL-/Deployment-Test.

`migrate.js` ohne `--apply` ist nur ein Dry-run. Einzelheiten und Grenzen der ausgeführten Prüfungen stehen im mitgelieferten Prüfbericht. Die Tests enthalten echte lokale HTTP-Aufrufe; kostenpflichtige Datenanbieter werden in Tests gemockt.

## Daten sichern

Anhang-Binärdaten und Kerzendaten liegen in PostgreSQL. Der normale JSON-Export enthält Metadaten und ist **kein vollständiges Datenbankbackup**. Für vollständige Sicherung das separate `marcel_trading`-Schema mit dem vom Betreiber vorgesehenen PostgreSQL-Backup sichern. Kein `DROP SCHEMA` gegen Produktion ausführen. API-/Feed-/Brain-Schlüssel nur in privaten Umgebungsvariablen, niemals in Screenshots, Chat, Git oder Frontend eintragen.
