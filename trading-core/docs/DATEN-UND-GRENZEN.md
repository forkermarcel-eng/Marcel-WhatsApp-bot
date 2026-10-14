# Datenbedeutung, Grenzen, Lizenzen

## Drei getrennte Wahrheiten

1. **Plan:** das, was Marcel vor einem möglichen Entry festgelegt hat. Speichern ist keine Order.
2. **Marktberührung / Schätzung:** ein unabhängiger Kursfeed hat den Limitpreis erreicht oder überschritten. Das beweist weder Ausführung noch Queue-Position, verfügbare Liquidität oder Slippage.
3. **Tatsächlicher Trade:** Marcel hat Entry und Exit ausdrücklich mit Preis, Menge, Zeit und Gebühren bestätigt. Nur diese abgeschlossenen Trades gehen in die echten Gewinn-/Verlustkennzahlen ein.

Ein Datenfeed kann ausfallen, verzögert sein oder einen anderen Future-Monat abbilden. Keine Werte aus einer fehlenden Quelle erfinden. Für statistische Auswertung identisches Instrument, Rohkontrakt, Zeitzone und Ausgangsauflösung verwenden. Die Quelle und ihr Timestamp bleiben sichtbar.

## OHLCV / Replay

Bei einer Kerze sind High und Low, nicht deren Reihenfolge bekannt. Werden Entry und SL/TP in derselben Kerze berührt oder später SL und TP zugleich, lautet das Ergebnis **mehrdeutig**. Ohne feinere Daten gibt es keinen künstlichen Gewinner. Fehlende Abschnitte sind **unvollständig**. MFE/MAE schließen zeitlich unklare Entry-/Exit-Kerzenextreme aus und sind damit **konservative Untergrenzen**; keine tickgenaue Auswertung.

Replay spielt vorhandene Kerzen ab und verbirgt später erfasste Zeichnungen. Er ist keine Rekonstruktion der Orderbuch-Queue und kein Nachweis, dass historische manuelle Blöcke damals tatsächlich gesehen wurden. Retrospektive Pläne sind gekennzeichnet und aus dem normalen Learning-/Live-Ergebnisvergleich ausgeschlossen.

Ein gespeicherter Ablaufzeitpunkt begrenzt den betrachteten Planzeitraum. Die Webseite storniert keine echten Orders und schließt keine echten Positionen. Persönlicher Feierabend und Prop-Cutoff bleiben vom Trader zu erfüllen.

## Statistiken

- Winrate/R/P&L: bestätigte abgeschlossene Trades, einschließlich erfasster Gebühren.
- Fill-Rate: manuell bestätigte Entries im Verhältnis zu erfassten nichtretrospektiven Plänen; noch wartende Pläne sind im Nenner. Nicht als endgültige statistische Fill-Wahrscheinlichkeit ausgeben.
- Drawdown: realisierte Trade-zu-Trade-Kurve, **kein vollständiger Intraday-Equity-Drawdown** eines Prop-Kontos.
- Aktuelle Ansichten sind für das persönliche Journal ausgelegt; serverseitige Sicherheitslimits begrenzen Listen. Das vollständige Archiv wird durch PostgreSQL-Backups gesichert, nicht ausschließlich den JSON-Download.
- Ähnliche Setups: transparente Merkmalsähnlichkeit, kein gelerntes Modell und keine Gewinnprognose.

## Schutz der ursprünglichen Daten

Trading besitzt nur das neue Schema `marcel_trading`. Keine bestehenden Tabellen/Spalten, keine Fremdschlüssel zu Brains, keine Änderungen an alten Migrationen. Entscheidungssnapshots, Pläne, tatsächliche Ausführungen, Reviews, Kontext und Audit sind append-only. Ein Benutzer mit DB-Superuser-Rechten kann Daten technisch weiterhin manipulieren; dies ist keine manipulationssichere Börsenbuchführung.

Screenshots werden serverseitig privat gespeichert und nur authentifiziert ausgeliefert. Vor dem Upload Passwörter, Personen-/Kontodaten schwärzen. Nur PNG/JPEG; der Browser verkleinert Bilder. Fremde API-Keys gehören ausschließlich in ENV, nicht in Screenshots oder Notizen.

## Datenlizenz und Abhängigkeiten

Für Futures-Marktinformationen sind Anbieterzugang, CME-Entitlements und die erlaubte Nutzung/Anzeige in einer privaten Webseite mit dem Datenanbieter zu klären. Eine öffentlich zugängliche Seite, Weitergabe an Dritte oder nichtangezeigte maschinelle Verarbeitung kann andere Rechte erfordern. Das private Login ersetzt keine Lizenzvereinbarung. Es wird kein Marktdaten-Abonnement durch den Code abgeschlossen.

Die im Gespräch genannten GitHub-Projekte waren Architektur-/Funktionsreferenzen. **In diesem Paket sind weder LuxAlgo-Journal noch OpenTerminal, OpenTraderWorld, Deltalytix oder TradingView/Pine-Code gebündelt.** Die Canvas-Oberfläche wurde eigenständig implementiert. Für offizielle Kontextquellen werden die unten dokumentierten Parserbibliotheken wiederverwendet.

Verwendete Laufzeitabhängigkeit: bestehendes `pg` aus dem Originalprojekt. Optionaler Feed: `databento==0.86.0` aus PyPI, SDK-Lizenz und Vendor-Bedingungen gelten. Der Dockerfile verwendet das offizielle Python-Image. Die Anbieter-/SDK-Verbindungen sind implementiert und gegen Testantworten geprüft; ein End-to-End-Test mit privaten lizenzierten Zugangsdaten steht außerhalb dieser lokalen Testumgebung.

Offizielle Referenzen:
- https://databento.com/docs/api-reference-historical/timeseries/timeseries-get-range
- https://databento.com/docs/api-reference-live/client
- https://pypi.org/project/databento/
- https://docs.tradingeconomics.com/economic_calendar/snapshot/
- https://fred.stlouisfed.org/docs/api/fred/series_observations.html
- https://www.federalreserve.gov/feeds/feeds.htm
- https://www.ecb.europa.eu/home/html/rss.en.html

Öffentliche Headlines sind Quellenberichte, keine automatisch bestätigten Tatsachen. Keine automatische KI-News-Zusammenfassung oder Ableitung eines „sicheren“ Long/Short-Signals. Das Cockpit dokumentiert die manuelle Analyse und bietet strukturierten Kontext.

## Context-Block: Open-Source-First-Prüfung (14.10.2026)

| Referenz | Prüfung / Entscheidung | Lizenz |
| --- | --- | --- |
| [Macro Desk](https://github.com/tduic/macro-dashboard) | Macro-Regime, RSS/Topics/Related News, Kalender, Cross-Asset und Cache geprüft. FRED-/yfinance- und eigene Kalenderannahmen nicht als kostenlose offizielle Defaultquelle übernommen. Kein Code kopiert. | Beim geprüften Stand keine LICENSE, GitHub license=null; öffentliche Lesbarkeit ist keine Übernahmelizenz. |
| [OpenTerminal](https://github.com/flavin/openterminal) | Provider/Registry, News, FRED/Macro, Kalender und Caching geprüft. Keine komplette Plattform übernommen. ForexFactory/FairEconomy, Yahoo-/Google-Endpunkte nicht automatisch freigeschaltet. | MIT; Datenrechte separat, MIT gilt nicht für fremde Artikel/Marktdaten. |
| [Cheerio 1.2.0](https://github.com/cheeriojs/cheerio) | HTML-/XML-Strukturparser für offizielle Tabellen/Feeds; kein selbst gebauter DOM-Parser. | MIT |
| [node-ical 0.27.3](https://github.com/jens-maus/node-ical) | ICS-Parsing. BLS-Alias US-Eastern vorab auf America/New_York normalisiert; keine Host-Zeit für floating Events. | Apache-2.0 |
| [Luxon 3.7.2](https://github.com/moment/luxon) | Eastern/UTC, DST, Datumskonvertierung. | MIT |

Keine Quellcodekopie aus den beiden Referenzprojekten. Wiederverwendung erfolgt
über die drei veröffentlichten Pakete; deren LICENSE/NOTICE-Dateien bleiben in
der Paketdistribution. Lockfile fixiert Versionen und transitive Abhängigkeiten.
Übliche Quellenadapter, bestehendes Repository und vorhandener Worker ersetzen
keine zweite Plattform. Es wird keine pauschale Daten-Weiterverteilungslizenz
behauptet; Originalquellen bleiben verlinkt, keine Artikelvolltexte/Bilder.

## Offizielle Defaultquellen und geprüfte Ergänzungen

- [Treasury XML](https://home.treasury.gov/interest-rates-data-csv-archive): nominal/real,
  offizieller Tagesstand. bp-Differenzen sind aus aufeinanderfolgenden verfügbaren
  Handelstagen berechnet. 2s10s = 10Y minus 2Y, nur bei identischem Datum.
- [Fed H.10](https://www.federalreserve.gov/releases/h10/summary/jrxwtfb_nb.htm):
  täglicher Nominal Broad Dollar Index, wöchentliche Publikation; kein ICE DXY.
- [BLS ICS](https://www.bls.gov/schedule/news_release/bls.ics),
  [BEA](https://www.bea.gov/news/schedule),
  [FOMC](https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm),
  [Fed-Zeitkalender](https://www.federalreserve.gov/newsevents/calendar.htm),
  [Census](https://www.census.gov/economic-indicators/calendar-listview.html),
  [EIA](https://www.eia.gov/petroleum/supply/weekly/schedule.php),
  [Treasury-Auktionen](https://www.treasurydirect.gov/auctions/upcoming/).
  CPI/NFP/PCE sind einzelne Originalveröffentlichungen, keine erfundenen separaten
  Core-/Unemployment-Events. Bei FOMC umfasst das Decision-Event Meeting/Statement;
  SEP, Press Conference und Minutes separat. Zukünftige Minutes ohne explizites
  Datum sind als offizielle Drei-Wochen-Regel markiert, ohne erfundene Uhrzeit.
- Zusätzlich integriert: [Fed RSS](https://www.federalreserve.gov/feeds/feeds.htm)
  Monetary/Speeches, [EIA RSS](https://www.eia.gov/tools/rssfeeds/),
  [BoJ](https://www.boj.or.jp/en/rss/whatsnew.xml).
  Bestehende ECB/BBC/Fed-Headlines bleiben erhalten. URL-Dedupe, keine Titel-Merges.
- Treasury/Sanctions: offizielle Presseseite geprüft, kein belastbarer RSS-Vertrag
  aus den gelesenen Links bestätigt; kein neuer HTML-News-Scraper aktiviert.
- State Department: aktueller Feedzugang in dieser Prüfung HTTP 403; archivierte
  2021–2025-Feeds ausdrücklich nicht als aktuelle Quelle übernommen.
- White House: aktuelle Newsseite geprüft, kein bestätigter RSS-Link; nicht aktiviert.
- DoD: offizieller RSS-Link liefert nach Redirect auf `www.war.gov` RSS/200.
  Als weitere Primärquelle geeignet, in diesem kleinen Defaultsatz noch nicht
  aktiviert; kein automatisches Aufweichen der bestehenden Redirect-Regel.
- [GDELT DOC 2.0](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/):
  ArtList/JSON für Titel, URL, Domain, Timestamp geprüft. Read-only-Probe HTTP 429;
  deshalb keine notwendige Default-Abhängigkeit. GDELT-Datenzugang vermittelt
  keine Artikelrechte. Keine Volltext-, Bild-, Sentiment- oder KI-Integration.

## Bedeutung und Grenzen des automatischen Kontextes

- Rates RISING/FALLING nur bei gleichgerichteten täglichen 2Y/10Y/real10Y-Deltas,
  sonst MIXED. Fehlende Daten => UNKNOWN. Treasury älter als fünf Tage bzw.
  H.10 älter als elf Tage gelten für Bias als veraltet; Anzeige behält Datumslabel.
- USD: Vorwert/Tagesänderung und 5-Beobachtungstage-Differenz, sofern vorhanden.
  Der Wochenveröffentlichungsrhythmus bleibt sichtbar.
- Cross-Asset: letzte zwei vollständig vergangene UTC-Tage aus bereits vorhandenen
  Kerzen des konfigurierten exakten Kontrakts. Letzter beobachteter Close,
  **kein amtliches Settlement**, kein Livekurs; keine Contract-Roll-Umdeutung.
- Risk-on/off: Nasdaq und Dow gemeinsam steigend/fallend; sonst mixed/unknown.
  Ölrichtung separat. Keine neue Futures-Abfrage durch Bootstrap/Context-Sync.
- News-Topics und Importance sind transparente interne Regeln, nicht von Behörden
  bestätigte Bewertungen. Generalpolitische Meldungen ohne Topic werden nicht
  priorisiert. Geopolitische Kategorien beruhen ausschließlich auf Headlines;
  HIGH braucht mindestens drei aktive Konflikt-Headlines aus zwei Quellen,
  ELEVATED mindestens eine relevante Geopolitikmeldung. Das beweist keine Eskalation.
- LOW bei Kalender/News nur mit aktuell bestätigter Quellenabdeckung. Ausfälle
  bleiben sichtbar. Datum-only wird als Eastern-Tagesfenster behandelt, nicht als
  Mitternachtsrelease. Ferien-/Jahreswechsel und Änderungen von Behördenformaten
  können die Abdeckung begrenzen. Ein leerer Filter beweist kein risikofreies Fenster.
- Gold-Bias: fallende reale Renditen/schwächerer USD/geopolitische Aufmerksamkeit
  sind positive Kontextsignale, steigende reale Renditen/stärkerer USD/Risk-on
  negative. Gegensätzliche oder unvollständige Makrosignale => NEUTRAL.
  Keine KI, kein Preisziel, keine Handlungsempfehlung, kein Send/Brokerpfad.
- Source-Caches in bestehenden Settings, Aktualisierung nur beim expliziten Sync
  bzw. vorhandenen Context-Worker. Kein neuer Worker automatisch gestartet.
- Rücknahme ist Code-Rollback, kein Löschen historischer News/Events erforderlich.
  Kein Schemawechsel; bestehender manueller Context und alle Nicht-Trading-Tabellen
  bleiben außerhalb dieses Blocks.
