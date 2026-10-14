# Installation und Freischaltung

## 1. Vorab: nicht die fertige ZIP über einen neueren main kopieren

Der aktuelle Trading-Kandidat wurde in einer separaten Arbeitskopie auf
`origin/main` (Basis `463ef281fdc5b387392f92a9c56eb9aa1fe389e7`) portiert.
Die September-ZIP ist nur die Modulquelle. Ihr Installer-Dry-Run meldete
einen Konflikt bei `Trading/index.html` und wurde nicht angewendet.
Die Registrierung steht jetzt hinter den vorhandenen Body-Parsern.
Tinder und Shared-Module bleiben unverändert. Keine Migration, Freischaltung
oder Bereitstellung ist durch die lokale Integration bereits erfolgt.

## 2. Vorhandenes Backend / PostgreSQL

Die aktuelle Root-`package.json` verlangt Node >= 22.12.0. `pg` ist bereits enthalten. Keine neue Root-Abhängigkeit und keine Änderung am vorhandenen Startskript erforderlich.

Ein bestehendes, überprüfbares PostgreSQL-Backup anlegen. Dann **nur** Folgendes in der dafür vorgesehenen Backend-Umgebung ausführen:

```sh
node trading-core/migrate.js
# Erst nach Backup und bewusstem Migrationsentscheid:
node trading-core/migrate.js --apply
```

`DATABASE_URL` kommt aus der vorhandenen Backend-Umgebung. Die Migration verändert ausschließlich das neue Schema `marcel_trading`. Sie läuft transaktional mit Advisory Lock; bereits identische Migrationen werden nicht erneut angewendet. Abweichende Checksummen werden abgelehnt. Nicht die alten, allgemeinen WhatsApp-/Tinder-Migrationskommandos dafür starten.

Optional kann ein Datenbankadministrator eine dedizierte Trading-Rolle mit Rechten nur für `marcel_trading` einrichten. Das ist eine zusätzliche Betriebsmaßnahme, kein zwingender Eingriff in bestehende Brain-Tabellen. Die Standardintegration verwendet den vorhandenen Pool, aber alle Trading-Abfragen sind schemaqualifiziert.

### Backend-ENV

```text
TRADING_ENABLED=true
TRADING_API_SECRET=<eigener zufälliger langer Schlüssel>
TRADING_INGEST_TOKEN=<anderer zufälliger Schlüssel, nur falls Feed aktiv>
TRADING_INTELLIGENCE_TOKEN=<dritter Schlüssel, erst wenn Master-Brain-Lesezugang gebraucht>
```

Schlüssel lokal erzeugen, beispielsweise mit `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Nicht hierher schicken. Falls bewusst kein eigener `TRADING_API_SECRET` gesetzt ist, wird der bestehende `DASHBOARD_API_SECRET` unterstützt; getrennte Schlüssel sind vorzuziehen.

`index.js` registriert bei `TRADING_ENABLED=true` genau `/trading-api`. Bei false/fehlend wird keine Trading-Route aktiviert. Bestehende Bot-Worker werden nicht von Trading gestartet oder gesteuert.

## 3. Vercel / Webseite

Neue Datei `api/trading.js` und `Trading/` deployen, ohne vorhandene `vercel.json`-/Middleware-Routen zu verändern.

```text
DASHBOARD_PASSWORD=<bestehendes Login-Passwort unverändert>
TRADING_API_SECRET=<derselbe private Admin-Schlüssel wie im Backend>
TRADING_BACKEND_URL=https://DEIN-EIGENES-BACKEND
TRADING_PUBLIC_ORIGIN=https://marcelmarlow.com
```

`RAILWAY_BACKEND_URL` wird als vorhandener Fallback unterstützt. Der Browser ruft nur `/api/trading?resource=...` unter derselben Domain auf. Der Vercel-Handler prüft den bestehenden signierten Login-Cookie, zusätzliche Schreibanforderungen und den Ursprung. Der Admin-Schlüssel verlässt den Server nicht.

Danach mit dem bestehenden Dashboard-Login `/Trading/` öffnen. Unter **Daten & Setup** darf der leere Zustand erscheinen, aber kein HTTP-/Schemafehler. Erst echte Quellen konfigurieren; die Beispieldaten werden nicht produktiv eingespielt.

Backend-Lesetest bei gesetzten Umgebungsvariablen:

```sh
node trading-core/preflight.js --production --db --http
```

Dieser Befehl liest nur. Ohne `--db/--http` werden nur Laufzeit und ENV geprüft.

## 4. Unabhängige Kursdaten

Ein persönlicher Databento-Zugang mit passenden CME/COMEX/CBOT-Berechtigungen und für den vorgesehenen privaten Web-/Nichtanzeige-Gebrauch zulässiger Lizenz wird benötigt. Kein Topstep-Zugang und kein Brokerkonto werden eingebunden.

### Historie

Backend-ENV:

```text
TRADING_DATABENTO_ENABLED=true
TRADING_DATABENTO_KEY=<privater Vendor-Key>
TRADING_HISTORY_MAX_COST_USD=0.50
```

Im Cockpit unter **Daten & Setup → Kontrakte** aktuelle **exakte Rohsymbole** eintragen, beispielsweise das tatsächlich aktive `MGC...`, `MNQ...`, `MYM...`. Beispielmonate im Code sind keine Frontmonat-Empfehlung. Symbole mit `1!`, Cash-Indizes und CFD-Symbole werden nicht still gleichgesetzt.

Über **Historie laden** Zeitraum wählen. Pro Request maximal sieben Tage; vor dem Abruf erfolgt eine Kostenschätzung und ein harter Vergleich mit dem angegebenen Maximalbetrag. Größere Zeiträume in Abschnitten importieren. Die endgültige Abrechnung und das Entitlement liegen beim Datenanbieter.

### Fortlaufende Ein-Minuten-Kerzen

Dafür muss ein **separater dauerhaft laufender Datenprozess** betrieben werden. Nicht als Vercel-Serverless-Timer und nicht als Orderbot.

```sh
python -m pip install -r trading-core/workers/requirements.txt
python trading-core/workers/databento_feed.py
```

Zusätzliche ENV nur für diesen Prozess:

```text
TRADING_DATABENTO_KEY=<Databento-Key>
TRADING_INGEST_TOKEN=<derselbe FEED-Schlüssel wie im Backend, nicht Admin>
TRADING_FEED_SYMBOLS=<exakte aktuelle Rohkontrakte, kommagetrennt>
TRADING_INGEST_URL=https://DEIN-EIGENES-BACKEND/trading-api?resource=ingest
TRADING_FEED_OUTBOX=/private-data/trading/market-outbox.sqlite
```

Ein eigener Dockerfile für diesen Datenservice liegt in `trading-core/workers/Dockerfile`. **Nicht** den vorhandenen WhatsApp-/Tinder-Service auf diesen Dockerfile umstellen. Der Service braucht einen persistenten privaten Datenträger für die Outbox sowie einen Prozessmanager mit begrenztem Neustart-Backoff. Netzwerkfehler werden gepuffert; bei Auth-/Datenfehlern stoppt er statt unendlich ungültige Anfragen zu senden. Nach einem Neustart gibt es keine garantierte lückenlose historische Wiederherstellung: fehlende Abschnitte werden markiert und über die Historienfunktion nachgeladen.

Beim Kontraktwechsel müssen Dashboard-Einstellung **und** Worker-Abonnement angepasst werden; der Worker rollt absichtlich nicht eigenmächtig.

Die Anzeige aktualisiert sich regelmäßig, solange die Seite sichtbar ist. **Abgeschlossene Minutenkerzen sind kein Tickstream und keine sekundengenaue Orderausführung.** Den tatsächlichen Brokerpreis und die echte Ausführung prüfst du weiterhin selbst außerhalb dieser Plattform.

## 5. Nachrichten, Makro, Kalender

```text
TRADING_NEWS_ENABLED=true
TRADING_FRED_KEY=<FRED-Key>
TRADING_ECONOMIC_CALENDAR_KEY=<Trading-Economics-Key>
```

- RSS: Federal Reserve, EZB, BBC Welt/Wirtschaft. Nur Titel, Original-Link und Zeitpunkte; kein Volltextarchiv und kein Reuters-Abonnement.
- FRED: US 2Y/10Y, reale 10Y-Rendite, breiter Dollarindex. **Tageswerte, nicht Live-Renditen.** Breiter Dollarindex ausdrücklich nicht DXY.
- DXY: manuelle Beobachtung mit Quelle/Zeit; keine erfundene kostenlose ICE-Lizenz.
- Trading Economics: Kalender für die nächsten sieben Tage, Quellen-/Aktualitätsstatus. Ohne Key **„nicht konfiguriert“**, nicht „keine News“.

Der Button **Quellen aktualisieren** ist sofort nach ENV-Konfiguration nutzbar. Für regelmäßigen Abruf im Hintergrund einen unabhängigen Node-Service mit derselben DB und den Kontext-Keys starten:

```sh
node trading-core/workers/context.js
```

Standard: 15 Minuten; Mindestintervall fünf Minuten. Alternativ kann ausschließlich der separate Standalone-Server mit `TRADING_CONTEXT_POLL=true` selbst pollen. Nicht beide Varianten doppelt betreiben. Fehler einer Quelle werden angezeigt und nicht mit synthetischem Ersatz überdeckt.

## 6. Master Brain

Vorbereitet ist ausschließlich ein Lesekanal:

```text
GET https://DEIN-EIGENES-BACKEND/trading-api?resource=intelligence
Authorization: Bearer <TRADING_INTELLIGENCE_TOKEN>
```

Er liefert JSONL: getrennte `features` (damals bekannter Entscheidungsstand) und `outcome` (späteres Wissen). Kein direkter DB-Zugang, keine Schreib-/Orderrechte. Vorschläge werden manuell im Cockpit zur Prüfung erfasst. Ein akzeptierter Vorschlag trainiert **nicht** automatisch ein Modell und verändert keine Handelsregeln. Der eigentliche spätere lokale Master-Brain-Dienst ist nicht Teil dieses manuellen Cockpits.

## 7. Start ohne Cloud, aber mit echter lokaler Persistenz

Nur für einen privaten lokalen Einzelprozess:

```text
TRADING_LOCAL_PASSWORD=<eigenes Passwort, mindestens 12 Zeichen>
TRADING_LOCAL_FILE=<privater Pfad außerhalb des Repos>/journal.json
```

Dann `node trading-core/server/standalone.js`. Zugang unter localhost, eigenes Login. Nicht mit `--demo` verwechseln. Für Cloud/Mehrprozessbetrieb PostgreSQL verwenden. Keine lokalen Journaldateien in GitHub oder in ein öffentliches Static-Verzeichnis legen.

## 8. Rücknahme

Im Backend `TRADING_ENABLED=false` und deployen: Trading-API deaktiviert. Bei Bedarf ausschließlich die im Update-Backup aufgelisteten Dateien zurücknehmen. Trading-Daten nicht löschen, nur weil die Oberfläche zurückgesetzt wird. Keine `DROP`-/Brain-/Tinder-Operation nötig.
