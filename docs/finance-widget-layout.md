# Finanzportal: kostenloses TradingView-Widget und kompaktes Layout

## Umfang

Nur Finanz-Frontend und seine Tests/Dokumentation. Eigene Wirtschaftsfeeds und offizielle Kalender, ihre serverseitigen Intervalle, Finanzcache und Datenbankstruktur bleiben unverändert. Keine Trading-Imports, Massive-Anfragen, Trading-Kerzen, Orders oder Änderungen an anderen Workspaces.

## Geprüfte kostenlose Lösung

Offizielles TradingView Market Overview Widget, `showChart:false`, dunkles Design, deutsche Oberfläche. Keine Anmeldung, kein API-Schlüssel, kein bezahlter Tarif und kein TradingView-Konto wurde eingerichtet. Ein frisches anonymes Chrome-Profil zeigte tatsächlich numerische Kurse; es wurde nicht lediglich eine Widget-Hülle getestet.

Offizielle Grundlagen:
- https://www.tradingview.com/widget/ — kostenlose Widgets mit Standard-Branding
- https://www.tradingview.com/widget-docs/widgets/watchlists/market-overview/ — offizieller Embed und Konfiguration
- https://www.tradingview.com/widget-docs/faq/data/ — Datenrechte je Börse; Forex/Krypto laut Anbieter Echtzeit, sonst teils verzögert/EOD; keine Datenexport-/API-Nutzung
- https://www.tradingview.com/widget-docs/faq/general/ — Attribution, Größen und Datenschutz
- https://www.tradingview.com/policies/ — persönliche/interne reine Anzeige und unveränderte Attribution

Die private passwortgeschützte Nutzung erfolgt als reine persönliche Informationsanzeige nach diesen veröffentlichten Bedingungen; keine gesonderte schriftliche Vertragsfreigabe wird behauptet. Es gibt keinen Verkauf/Export von Widget-Daten und keinen Bezug zum eigenen Trading-System. Eine spätere kommerzielle Weiterverwertung wäre separat zu prüfen. Branding, Widgetlogo und Quellenlink bleiben sichtbar und werden weder überdeckt noch entfernt.

## Instrumente und tatsächliche Einschränkungen

| Widgetsymbol | Beschriftung und belegtes Verhalten |
|---|---|
| INDEX:DEU40 | DAX, ausdrücklich Schlusskurs/EOD. Im Widget mit E-Kennzeichnung; nicht als laufender Kassakurs behauptet. |
| FOREXCOM:SPXUSD | S&P-500-CFD-Referenz, kein Originalindexkurs. Numerischer Wert sichtbar. |
| FOREXCOM:NSXUSD | Nasdaq-100-CFD-Referenz, kein Originalindexkurs. Numerischer Wert sichtbar, während Beobachtung verändert. |
| TVC:GOLD | Gold-CFD, USD/Unze. Numerischer Wert sichtbar, während Beobachtung verändert. |
| TVC:UKOIL | Brent-CFD-Referenz, kein eigener Futures-Kontrakt. Numerischer Wert sichtbar. |
| FX:EURUSD | EUR/USD-Devisenkurs. Numerischer Wert sichtbar, während Beobachtung verändert. |

SP:SPX und NASDAQ:NDX wurden zunächst tatsächlich im Widget geprüft und lieferten dort keine Werte. Sie wurden nicht als funktionierende Originalindizes ausgegeben. Die stattdessen gewählten FOREXCOM-Referenzen werden jeweils ausdrücklich als CFD bezeichnet. Weitere Indizes oder andere Futures wurden nicht ungeprüft ergänzt.

Zwei Screenshots im Abstand von 30 Sekunden zeigten Änderungen bei Nasdaq-CFD, Gold-CFD und EUR/USD ohne Reload. Das belegt laufende Anbieteraktualisierung dieser Referenzen, nicht eine verbindliche Tickfrequenz oder Echtzeitgarantie aller Märkte. DAX blieb EOD; Brent zeigte im Prüfzeitraum keinen Wechsel. Keine Kurswerte oder WebSocket-Marktdaten wurden aus dem Widget ausgelesen, gespeichert oder als eigene API verwendet.

## Isolierung und Datenschutz

Die offiziellen Embed-Ressourcen werden in einem Sandbox-Iframe mit einem `data:`-Dokument eigener opaker Herkunft ausgeführt. Die darin geladene TradingView-Anzeige behält ihre eigene externe Herkunft. Der Bootstrap kann weder Marcel-Brain-DOM noch Anwendungscookies lesen. Lokale Widget-Vorlage und Loader werden authentifiziert vom bestehenden Brain-Pfad geladen und im Arbeitsspeicher wiederverwendet. Sie enthalten ausschließlich statische Konfiguration und keine privaten Anwendungsdaten. Die unveränderte Brain-Middleware schützt die neuen Dateien bereits über `/Brain/:path*`.

Nur der isolierte Bootstrap erhält eine eigene CSP: kein Default-Netzzugriff; Skriptquelle s3.tradingview.com plus festes Bootstrap-Nonce; Framequelle www.tradingview-widget.com. Keine globale CSP-Lockerung, keine Authentifizierungsänderung und keine Weitergabe von Backend-Schlüsseln. Sichtbarer Datenschutzhinweis im Finanzpanel: TradingView erhält beim Abruf insbesondere IP, Widget-Typ, Symbole und Einbettungsadresse gemäß Anbieter-FAQ. Keine pauschale Behauptung, die Einbettung sei ohne Drittanbieterzugriff.

Cross-Origin-Frames werden ausschließlich als Anzeige benutzt. Die App liest keine Preise daraus. Nur eigene Kontrollmeldungen des isolierten Bootstraps werden akzeptiert, geprüft gegen das konkrete Framefenster. Da der Anbieterinhalt absichtlich nicht ausgelesen wird, kann die App nicht für jedes Symbol automatisch entscheiden, ob bereits ein gültiger Kurs eingetroffen ist. Das wird im Hinweis transparent gemacht, statt einen erfolgreichen Frame-Load als erfolgreiche Kursversorgung auszugeben.

Das Widget wird erst beim sichtbaren Finanz-Workspace gestartet. Themenfilter und 60-Sekunden-Finanzrefresh ersetzen nur Nachrichten und Kalender; das Widget wird nicht neu gestartet. Beim Verlassen des Workspace oder unsichtbarem Dokument wird es entfernt. Loaderfehler und Timeout erzeugen einen Fehlerhinweis; Finanznachrichten und Kalender laufen weiter. Eine instabile erste Variante ohne die nötige Herkunft für das verschachtelte Anbieterframe blieb leer und wurde verworfen; nur die im Browser funktionierende isolierte Variante wurde übernommen.

## Layout

Desktop: Marktüberblick links oben, kompakter Kalender links unten, scrollbar nutzbare Fachnachrichten rechts über beide Zeilen. Kalenderbreite bei 1440px: 629px statt zuvor 1274px. Eigene Kalender-Scrollfläche mit maximal 280px Höhe. Kompakte Terminzeilen; Details/Werte weiterhin erst nach Auswahl. Mobil: Marktüberblick, Kalender und Nachrichten untereinander. Kein Chart, Candlestick, Watchlist-Editor, Mikrofon oder zusätzlicher Sprachbutton.

Fachnachrichtenquellen, Filter, Überschriften, Zeitstempel und Originalartikel-Links bleiben bestehen. Keine ungeklärten Artikelbilder hinzugefügt; die bestehenden neutralen Themenelemente bleiben erhalten.

## Tests und Release

36 gezielte Node-Tests erfolgreich. Echte Chrome-Browserprüfung mit 50 tatsächlich produktiv gelieferten Fachmeldungen, 41 offiziellen Terminen und live geladenem TradingView-Widget. Nachgewiesen: tatsächliche Kursdarstellung, sichtbare Kursänderungen nach 30 Sekunden, keine Widget-Neuladung bei Filter/Refresh, kein Zugriff auf Eltern-DOM, Entfernen im unsichtbaren Zustand, isolierter Ausfall bei blockiertem TradingView-Loader und unveränderte Nachrichten-/Kalenderfunktion. Null Trading-Anfragen und keine JavaScriptfehler.

1440, 1024, 768, 390 und 320px ohne horizontale Seitenüberläufe. Mobile Ansicht visuell geprüft; keine echte Safari-/iPhone-Hardware-Abnahme behauptet. Screenshots lokal: `tmp/weather-verification/finance-widget-desktop.png`, `finance-widget-after30s.png`, `finance-widget-mobile.png`.

Rollback-Basis: bisheriger produktiver Commit 24f3f0e. Bestehende vollständige private PostgreSQL-Sicherung `marcel-production-finance-independent-20261020.dump` bleibt erhalten. Dieser Release ändert keine Datenbankdaten oder -struktur; daher kein erneuter Restore-Test oder Schreibtest gegen Produktivdaten erforderlich.
