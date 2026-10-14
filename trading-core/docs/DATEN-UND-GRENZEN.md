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

Die im Gespräch genannten GitHub-Projekte waren Architektur-/Funktionsreferenzen. **In diesem Paket sind weder LuxAlgo-Journal noch OpenTerminal, OpenTraderWorld, Deltalytix oder TradingView/Pine-Code gebündelt.** Der neue Trading-Code und die Canvas-Oberfläche wurden hier eigenständig implementiert. Deshalb gibt es auch keine Behauptung, deren vollständige Funktionen wären übernommen worden. Keine zusätzlichen Root-npm-Pakete.

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
