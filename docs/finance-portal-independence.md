# Finanzportal: unabhängige Wirtschaftsquellen

Dieser Stand ersetzt die im historischen Bericht `finance-dashboard-layout-review.md` beschriebene Zwischenlösung mit acht leeren Marktkarten. Er veröffentlicht auch das zuvor nur lokale Layout aus 537f885.

## Abgrenzung und entfernte Abhängigkeiten

Das aktive Finanzportal importiert keine Trading-Module mehr. Entfernt wurden PgRepository, Trading-Ereignisse, providerSync, Trading-Kalender-Deduplizierung und Trading-HTTP-Helfer. Die vorher schon entfernten Kerzen-/Massive-Abhängigkeiten bleiben entfernt. Auch der indirekte Import des Welt-Service mit dessen Trading-Helfer wurde durch einen kleinen, eigenständigen Finanz-RSS-Parser ersetzt.

Alle Finanzinhalte werden über öffentliche, schlüssellose Quellen abgerufen und ausschließlich im vorhandenen `marcel_world.cache` unter `finance-portal:v2` gespeichert. Keine Trading-Tabellen oder -Konfigurationen werden gelesen oder geschrieben. Keine Schemaänderung. Der bisherige Cache bleibt unverändert und läuft regulär ab. Der bestehende Hintergrundtimer wird weiterverwendet; seine Finanzaktualisierung läuft unabhängig von der Bereitschaft der Welt-Nachrichtentabelle. Authentifizierung bleibt vor jedem Finanzzugriff erhalten.

Trading-Code, -Scheduler, -Strategien, -Kerzen, -Datenbanktabellen und -Dienste wurden nicht verändert oder abgeschaltet. Die allgemeine Nachrichtenansicht, Welt, Wetter, Brain und Wissen bleiben unverändert.

## Aktive eigene Quellen

Fach-RSS, nur freigegebene verlinkte Überschriften, keine übernommenen Artikelbilder oder Volltexte:
- finanzen.net: https://www.finanzen.net/rss/news und https://www.finanzen.net/rss/analysen
- FinanzNachrichten.de: https://www.finanznachrichten.de/rss-nachrichten-wirtschaft-konjunktur und https://www.finanznachrichten.de/rss-marktberichte
- Rechte: https://www.finanzen.net/dienste/rss und https://www.finanznachrichten.de/service/rss.htm

Direkte öffentliche Wirtschaftskalender:
- Eurostat: https://ec.europa.eu/eurostat/o/calendars/eventsJson, wie auf dem offiziellen Veröffentlichungskalender ausgewiesen
- BLS: https://www.bls.gov/schedule/news_release/bls.ics
- BEA: https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics
- Federal Reserve: https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
- EZB: https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html

FOMC- und EZB-Jahreskalender liefern hier nur Datumsangaben: keine erfundenen Uhrzeiten. ICS-Zeiten werden mit expliziten Zeitzonen und Sommerzeit verarbeitet. BLS-`US-Eastern` wird nach America/New_York normalisiert; Zeitzonendefinitionen sind keine Veröffentlichungstermine. Abgesagte Ereignisse werden ausgelassen. Eine erfolgreiche neue Kalenderantwort ersetzt die bisherige Quellliste, sodass Verschiebungen übernommen werden. Bei Fehlern bleiben letzte gültige Daten mit ihrem ursprünglichen Zeitstempel und Fehler-/Veraltungskennzeichnung erhalten. Keine Konsensprognosen oder Ergebnisse werden aus Termindaten abgeleitet.

Handelsblatt bleibt mangels zusätzlicher kommerzieller Freigabe deaktiviert. WirtschaftsWoche, Börse Frankfurt und Investing.com wurden nicht als angeblich freigegebene Alternativen hinzugefügt. Die vorhandenen rechtmäßig nutzbaren Fachfeeds genügen; kein Scraping-Bypass, keine neuen Schlüssel oder Kosten.

## Oberfläche und Intervalle

Links: „Als Nächstes“ mit fünf tatsächlich belegten bevorstehenden Veröffentlichungen. Rechts: eine einzige scrollbar nutzbare Fachnachrichtenliste mit kompakter Themenorientierung. Darunter: ausführlicher Wirtschaftskalender für die nächsten 30 Tage, einschließlich Quellenlinks und fehlender Werte. Keine acht leeren Kurskarten, keine Trading-Kontrakte und keine Kurscharts. Liquid Glass, Navigation und responsive Grundstruktur bleiben erhalten.

Fach-RSS alle zehn Minuten, Kalender alle 30 Minuten über den vorhandenen Fünf-Minuten-Timer. Conditional Requests, begrenzte Antworten, 12-Sekunden-Timeout und Retry-After. Finanzoberfläche liest alle 60 Sekunden bei sichtbarer geöffneter Ansicht. Themenfilter verursachen keinen Netzabruf. 72-Stunden-Nachrichtenaufbewahrung bleibt bestehen.

## Prüfnachweis

35 gezielte Tests erfolgreich: 13 Finanztests, 13 Welttests, zwei bestehende Workspace-Tests, sieben Navigationstests. Keine Tests deaktiviert.

Unabhängigkeit ausdrücklich geprüft:
- Isolierte PostgreSQL-kompatible PGlite-Datenbank mit ausschließlich `marcel_world.cache`, ohne Trading-Schema oder -Dienste.
- Authentifizierter Finanz-HTTP-Handler funktioniert ohne Welt-Nachrichtentabelle und akzeptiert ausschließlich Finanzcache-SQL.
- Statische Modulprüfung gegen Trading-Imports, Trading-Umgebungsvariablen und Repositories.
- Echter öffentlicher Quellenabruf ohne irgendeinen Trading-Zugang: alle fünf Kalender erfolgreich geparst, 41 anstehende Termine und 25 Fachmeldungen zum lokalen Prüfzeitpunkt.
- Die finanzen.net-Feeds meldeten beim lokalen Abruf HTTP 403; funktionierende FinanzNachrichten.de-Feeds lieferten weiterhin Inhalte. Ihr produktiver Zugriff wird separat geprüft.
- Echte Chrome-Browserprüfung mit diesen Daten: Nachrichten, 30-Tage-Kalender, Themenfilter, automatische 60-Sekunden-Aktualisierung, Originalartikel-Links und Fehlerfall mit Datenerhalt. Null Trading-Anfragen, keine JavaScriptfehler.
- Breiten 320, 360, 390, 768, 1024 und 1440 Pixel ohne horizontales Überlaufen. Echte Safari-/Mobilgeräte standen nicht zur Verfügung.

Screenshots: `tmp/weather-verification/finance-portal-desktop.png` und `finance-portal-mobile.png`. Lokale Screenshots werden nicht als angemeldete Produktionsbrowser-Abnahme ausgegeben.

Vor Release frischer privater Produktionsdump: `%TEMP%/marcel-production-finance-independent-20261020.dump`, 18.516.987 Bytes; `pg_restore --list` mit 662 Archivzeilen erfolgreich. Dies ist eine Archivprüfung, kein neuer vollständiger Restore-Test. Keine produktiven Trading-Daten als Testmaterial verändert.
