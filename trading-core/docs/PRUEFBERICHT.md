# Marcel Trading – Prüf- und Änderungsbericht

Stand: 20.09.2026. Prüfungen in isolierter Arbeitskopie, nicht auf der Produktionsseite.

## Was tatsächlich ausgeführt wurde

| Prüfung | Ergebnis |
|---|---:|
| Neue Trading-/API-/Provider-/Gateway-/Update-/Readiness-Tests (Node) | 51 bestanden |
| Bestehende Webnavigation-/Tinder-Abgrenzungs-/Brain-Präsentationsregressionen | 27 bestanden |
| **Node gesamt** | **78 bestanden, 0 fehlgeschlagen, 0 übersprungen** |
| Python-Datenfeed-/SQLite-Outbox-Tests | 4 bestanden |
| UI-Funktions-/Layoutchecks | 19 bestanden |
| JavaScript-Syntaxchecks | 21 bestanden |
| Baseline-Dateivergleich | 299 Originaldateien unverändert; 2 gezielt geändert |
| Windows-Pfadprüfung | keine Case-insensitive-Dateikollisionen |
| Trading-Migration ohne --apply | nur Dry-run; keine DB-Verbindung/Änderung |

Die Node-Tests testen u. a. echte HTTP-Routen eines isolierten lokalen Servers: privaten Zugriff, getrennte Admin/Feed/Reader-Rollen, Idempotenz, Snapshot-Prüfsummen und Unveränderlichkeit, manuell bestätigte Fills/Teil-Exits, Gebühren/R-Berechnung, oversell-Abwehr, PNG/JPEG-Anhänge, Korrekturereignisse, echte vs. hypothetische Auswertungen, Dateipersistenz und Neustart, Quellenausfälle, Datenlücken/mehrdeutige OHLC-Kerzen sowie einen konfliktgeschützten Update-Lauf.

Das Update wurde insbesondere gegen einen zusätzlich veränderten zentralen index.js und einen unveränderten Tinder-Bereich getestet. Neuere andere Inhalte bleiben bestehen. Ein Konflikt oder eine abweichende Integrationsstelle verursacht einen Abbruch statt Überschreiben. Wiederholtes identisches Einspielen ist idempotent.

## Zusätzlicher echter Pakettest

Das erzeugte Update wurde auf eine frisch entpackte Kopie der Original-ZIP angewendet. Der resultierende Projektstand stimmte Datei für Datei mit dem gebauten Stand überein. Alle 299 geschützten Originaldateien blieben identisch. Erneute identische Anwendung änderte keine Datei. Die 78 Node-Tests wurden auch auf dieser installierten Kopie erneut ausgeführt: ebenfalls 78 bestanden, 0 Fehler. Dies war eine lokale Wegwerf-Kopie, nicht GitHub oder Produktion.

## UI-Testmethode

Die tatsächlichen HTML-/CSS-/JavaScript-Dateien wurden in Chromium gerendert. Das Testsystem blockiert URL-Navigation per Browserrichtlinie. Deshalb wurde der Code für den Test offline geladen und dessen API-Aufrufe ausschließlich zum echten lokalen HTTP-Server durchgereicht. Das war kein Test mit frei erfundenen API-Resultaten; aber **kein Test des gehosteten Modulladers oder einer echten Safari/iPad-Installation**.

Geprüft wurden alle acht Bereiche, Anlegen eines Plans samt dauerhaftem Snapshot, manuelle Ausführung in derselben Minute, Touch-Zone, Replay-Kennzeichnung, keine JavaScript-Laufzeitfehler und kein horizontaler Dokumentüberlauf bei 1180×820, 1024×768, 820×1180 und 390×844. Zusätzlich existiert eine 1366×1024-Ansicht. Screenshots sind echte Renderings des ausgelieferten Programms mit ausdrücklich synthetischen Demo-Daten, keine neuen KI-Mockups.

## Was NICHT als geprüft behauptet wird

- Kein Deployment auf MarcelMarlow.com, Vercel, Railway oder GitHub.
- Keine Verbindung zur produktiven oder zu einer realen Test-PostgreSQL-Instanz. Der SQL-Repositoryadapter und die Migration sind implementiert; der eigens gelieferte Wegwerf-DB-Smoke-Test konnte hier mangels DB/pg-Runtime nicht ausgeführt werden.
- Kein Abruf mit persönlichen Databento-/Trading-Economics-/FRED-Zugangsdaten. Provider-Parser, Requests, Fehlerfälle und Kostenlimit sind gegen Testantworten geprüft, nicht gegen ein lizenziertes Livekonto.
- Kein gebautes/gestartetes Docker-Image in dieser Umgebung. Der optionale Feed-Dockerfile wird mitgeliefert.
- Keine nativen iPad/Safari-, langen Dauerlast-, Börsen-Fill-, Backup-Restore- oder produktiven Berechtigungsprüfungen.
- Kein gesamter Lauf aller alten Repositorytests. Ausgeführt wurden die oben genannten bestehenden Regressionen, nicht ein erfundenes „alles im alten Projekt bestanden“.
- Kein bereits trainiertes Master-Brain-Modell, keine Performance-/Gewinngarantie.

## Änderungen an vorhandenen Dateien

**Trading/index.html:** Platzhalter durch die manuelle Cockpit-Oberfläche ersetzt.

**index.js:** exakt drei zusätzliche Zeilen (ein Import, ein Kommentar, eine Router-Registrierung). Keine bestehende Zeile entfernt oder geändert, keine Trading-Geschäftslogik hineingeschrieben. Routing nur bei `TRADING_ENABLED=true`.

Alle anderen 299 Originaldateien sind byte-identisch zur hochgeladenen ZIP. Insbesondere bleiben Tinder, Device-Bridge, bestehende Brain-/Memory-/Woman-Strukturen, alte Migrationen, globale Styles, `package.json`, Middleware und Vercel-Konfiguration unverändert.

## Datenbank

Eigenes Schema `marcel_trading`; ausschließlich additive neue Tabellen/Indizes/Funktion/Trigger. Keine Fremdschlüssel oder Schreibpfade in die bestehenden Brains. Append-only-Trigger für entscheidungsrelevante Datensätze. Migration mit Transaktion, Lock, Checksumme und ausdrücklichem `--apply`. Ein bereits vorhandenes Schema ohne passenden Versionsnachweis wird nicht übernommen.

Vor Produktivfreischaltung: PostgreSQL-Backup, explizite Migration, `preflight --production --db --http`, authentifizierter Browser-Roundtrip, anschließend die realen lizenzierten Datenzugänge testen. Diese Betriebsfreischaltung ist von der gelieferten Implementierung getrennt.

## Paketnutzung

Komplettpaket = integrierter Quellcode auf Basis der hochgeladenen ZIP. Updatepaket = nur Trading-Dateien und konfliktgeschützte minimale index.js-Integration. Für einen neueren Terra/GitHub-Stand **nicht** das Komplettpaket darüberkopieren.

Ausgangs-ZIP SHA256: `28e94765ff437bc5361ceecb07c717c603d4c1eea5dd415e044caf868e146ee2`.

Logs, UI-Checkliste, Screenshots und Syntaxliste liegen unter `trading-core/evidence/`.
