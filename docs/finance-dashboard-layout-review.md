# Finanz-Dashboard: Layoutkorrektur und zurückgestellte Kursversorgung

Stand: 19.10.2026. Lokale Umsetzung auf Basis von aa5589e. Die ausdrückliche Nutzerentscheidung lautet: „Layout fertigstellen; fehlende Kurse klar kennzeichnen“. Kein neuer Anbieter, kein kostenpflichtiger Tarif und kein produktives Deployment in diesem Schritt.

## Ergebnis

- Desktop: Marktüberblick links, eine scrollbar nutzbare Wirtschaftsnachrichtenliste rechts, unveränderter Wirtschaftskalender darunter über die volle Breite.
- Die separate Darstellung „Heute wichtig“ ist durch lokale Themenfilter derselben Nachrichtenliste ersetzt: Alle, Inflation, Zinsen/Zentralbanken, Unternehmen/Börsen, Geopolitik, Energie/Rohstoffe, Kryptowährungen. Keine zusätzlichen RSS-Anfragen beim Filtern; aktiver Filter bleibt bei Aktualisierung erhalten.
- Bestehende finanzen.net- und FinanzNachrichten.de-Feeds, Rechtebeschränkungen, 72-Stunden-Cache, Quellenlinks und Veröffentlichungstermine bleiben erhalten. Keine nicht freigegebenen Kurztexte oder Bilder. Deduplizierung zusätzlich anhand normalisierter gleicher Überschriften; Sortierung nach Veröffentlichungszeit.
- Acht exakt benannte Instrumente: DAX, S&P 500, Nasdaq 100, Dow Jones, Goldpreis, Bitcoin/USD, EUR/USD und Brent-Öl. Alle derzeit ohne freigegebenen Dashboard-Kursadapter: ausdrücklich „Nicht verfügbar“, mit aufklappbarer Begründung, ohne Ersatzkurse oder erfundene Sparklines. Das ist keine abgeschlossene Marktdatenintegration.
- Der Finanzservice fragt keine Trading-Kerzen und keine offiziellen Anleihe-/Dollar-Ersatzindikatoren mehr ab. Trading-Dateien, Datenversorgung, Strategien und Datenbestände wurden nicht verändert. Bestehende Welt-Marktdatenroute bleibt unverändert.

## Nachvollziehbare Ursache der alten Kurse

`brain-world/markets.js` las bisher ausschließlich gespeicherte Trading-Kerzen. Die Finanzoberfläche konnte mit ihrem 60-Sekunden-Leseintervall keine neuen Kurse erzeugen. `trading-core/workers/context.js` sieht zwar einen 10-Minuten-Abruf vor, doch `refreshMassiveMarkets` in `trading-core/server/providers.js` begrenzt einen 14-Tage-Zeitraum auf 120 aufsteigend sortierte Minuten und verarbeitet keine Folgeseite. Dadurch werden frühe Abschnitte statt der neuesten 120 Minuten abgerufen; wiederholte erfolgreiche Abfragen garantieren keinen aktuellen Datenstand. Dies ist ein konkreter Codefehler, nicht bloß ein UI-Symbolproblem. Ob jeder beobachtete alte Datensatz ausschließlich hierdurch entstand, ist damit nicht bewiesen. Die Korrektur dieses Trading-Abrufs wurde wegen des ausdrücklichen Änderungsverbots nicht vorgenommen.

## Bestehende Berechtigungen und Anbieterprüfung

Nur vorhandene Variablennamen geprüft: TRADING_MASSIVE_ENABLED und TRADING_MASSIVE_API_KEY; keine Twelve-Data-/Finnhub-Konfiguration gefunden. Keine Zugangsdaten ausgegeben. Zwei lesende Massive-Abfragen aus dem bestehenden Backend:

- I:SPX, Previous Day: HTTP 403, NOT_AUTHORIZED.
- I:NDX, Previous Day: HTTP 200, ein Datensatz, Stand 16.10.2026. Dies belegt Tagesdatenzugriff, keine aktuelle Intraday-Berechtigung, keine vollständige Instrumentabdeckung und keine gesonderte Weiterveröffentlichungslizenz.

Kein neuer dauerhafter Kursabruf wurde aktiviert. Die übrigen sechs Instrumente wurden nicht über vermeintlich passende Futures-/ETF-Symbole ersetzt. Alle acht sind bis zur freigegebenen Adapterentscheidung gleichartig als nicht angebunden markiert; das bedeutet nicht, dass jeder Anbieter alle acht grundsätzlich sperrt.

| Anbieter | Belastbare Erkenntnisse | Entscheidung |
|---|---|---|
| Massive | Basic: begrenzte Indexticker, fünf Anfragen/Minute, EOD. I:SPX konkret gesperrt; I:NDX EOD erreichbar. Assetklassen und Rechte getrennt. Keine nachgewiesene Acht-Instrumente-/30-Minuten-Abdeckung. | Vorhandenen Trading-Zugang nicht verändern. Kein zusätzlicher Abrufadapter aktiviert. |
| Twelve Data | Basic: acht Credits/Minute, 800/Tag; Forex/Krypto grundsätzlich verfügbar. Keine nachgewiesene kostenlose Vollabdeckung der verlangten Indizes und Referenzpreise. Persönliche/interne Nutzung und externe Darstellung benötigen unterschiedliche Rechte; externe Nutzung nicht pauschal freigegeben. | Neuer Schlüssel und konkrete Rechte-/Abdeckungsprüfung erforderlich, zurückgestellt. |
| Finnhub | Getrennte Aktien-, Forex-/Commodity- und Kryptopakete; ausgewiesene Pakete mit Personal-Use-Lizenz. Kein bestehender Schlüssel und keine nachgewiesene kostenlose Acht-Instrumente-Abdeckung/Darstellungslizenz. | Kein Zugang angelegt und kein Tarif aktiviert. |

Primärquellen:
- https://massive.com/pricing?product=indices
- https://massive.com/docs/rest/indices/overview
- https://massive.com/legal/terms
- https://twelvedata.com/pricing
- https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage
- https://finnhub.io/pricing
- https://api.finnhub.io/pricing-crypto-api

Die veröffentlichte Produktabdeckung ersetzt keinen funktionierenden Zugriffstest oder Darstellungsrechte. Kein kostenloser Anbieter wurde ohne solche Nachweise als zuverlässiger Ersatz behauptet. Keine zusätzlichen Kosten.

## Tatsächliche Intervalle

- Oberfläche: 60 Sekunden lesend, nur während sichtbarer geöffneter Finanzansicht; Filter ohne Netzabruf.
- Fach-RSS: bestehende zehn Minuten mit Conditional Requests und unabhängigem Fehlerstatus.
- Eurostat: bestehende 30 Minuten; übrige Kalender behalten ihre vorhandenen Quellintervalle.
- Neue acht Marktkurse: kein Abruf, Ziel 30 Minuten noch nicht erreicht. Handelszeiten-/Feiertagsbewertung, absolute und prozentuale Veränderung sowie echte instrumenteigene Sparklines müssen mit dem später freigegebenen Adapter geprüft werden. Keine leeren Daten als Echtkurse ausgeben.

## Verifikation

28 gezielte Node-Tests erfolgreich: Finanzservice (sechs), Welt (13), bestehende Night-Workspace-Funktionen (zwei), Navigation (sieben). Zusätzlich echte lokale Chrome-Browserprüfung mit den tatsächlich aus dem Produktivservice gelesenen 32 Fachmeldungen und neun Terminen; nur die bewusst fehlenden Kursfelder wurden durch die neue reale Nichtverfügbarkeitskonfiguration ersetzt, nicht durch Mockkurse.

Geprüft: Desktopanordnung nebeneinander, Kalender unter beiden Spalten, acht fehlende Märkte ohne Micro-Kontrakte, Themenfilter, Filtererhalt bei Refresh, Originalartikel-Links, Kalenderdetails, Fehlerfall mit Datenerhalt. Breiten 1440, 1024, 768, 390, 360 und 320 Pixel ohne horizontales Überlaufen. Keine Browser-JavaScriptfehler. WebKit/Safari und echte iPhone-/Android-Geräte standen nicht zur Verfügung; diese Plattformabnahme wird nicht behauptet.

Screenshots lokal: `tmp/weather-verification/finance-layout-desktop.png`, `finance-layout-mobile.png`. Keine Schemaänderung, kein neuer Scheduler, keine produktiven Daten geändert. Nach Nutzerentscheidung lokal belassen; Live-Website weiterhin vorheriger Stand aa5589e.
