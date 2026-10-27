# Interne Capability-Bibliothek sichtbar machen

Lokaler Release auf `2e976e28e46a75a8f26f7eff30f54cfa4238a71d`, 27.10.2026. Nicht veröffentlicht.

## Bestand und Änderung

Die 4.253 Einträge liegen unverändert in `brain-capabilities/data/catalog.json`. Quellen und Referenzpfade stammen aus `data/sources.json`. `registry.js` liefert Such-/Kategorie-/Plattform-/Status-/Lizenz-/Sprach-/Kostenfilter und paginierte Ergebnisse über die vorhandene authentifizierte Capability-API. Der bestehende Brain-Antwortpfad verwendet diese Registry selektiv; er wurde nicht geändert.

Nur die vorhandene Bibliotheksoberfläche wird ergänzt:

- „Marcel Brain – Fähigkeiten“ erscheint vor der öffentlichen Suche, direkt unter dem Seitenkopf.
- Gesamtbestand und gefilterte Trefferzahl werden getrennt aus der API angezeigt. Zunächst 30 Einträge, Nachladen in Seiten; kein Vollkatalogdownload.
- Karten zeigen Name, Kategorie, vorhandene Kurzbeschreibung bzw. ehrlichen Fehlhinweis, Quelle, Plattformen, Integrationstatus und Referenztyp.
- Details laden die vorhandenen Metadaten bei Auswahl nach; Quellreferenzen mit Commit-Pfaden sind aufklappbar. Höchstens zwölf Pfade pro Detailansicht, weitere über die interne Suche.
- Vorhandene Statuswerte werden verständlich bezeichnet, insbesondere „Werkzeug lokal ausführbar“ nur bei entsprechendem Katalogstatus. Daraus folgt keine Ausführbarkeit auf Railway oder auf jedem angezeigten Betriebssystem; der bestehende Nachweis bleibt in den Details sichtbar.
- Eintragstyp und Integrationstatus bleiben getrennt: eine verfügbare Referenz kann weiterhin eine Inhaltsfreigabe benötigen.
- Deutsche Suchbegriffe „Webseiten“/„Automatisierung“ werden nur in dieser Oberfläche auf vorhandene englische Katalogbegriffe abgebildet. Keine neuen Einträge oder erfundenen Treffer.
- Öffentliche prompts.chat-Suche bleibt separat und behält ausdrückliche Zustimmung vor einer Suchübertragung. Ihr JavaScript ist unverändert.

## Gezielte lokale Abnahme

Synthetischer lokaler Benutzer, bestehende Authentifizierung, isolierter In-Memory-Speicher. Keine Produktionsdaten oder Kontoverbindungen.

- Gesamtzahl 4.253 stimmt mit API überein; 28 Repositories/410 Skilldateien angezeigt.
- Erstabruf 30 Karten; Nachladen 60 Karten. Kein vollständiger Katalog im Browser geladen.
- SwiftUI + Apple: 40 Treffer. Detail geöffnet, 35 vorhandene Quellreferenzen angezeigt, tatsächlicher gepinnter Referenztext geladen (6.073 Zeichen).
- Statusfilter „Werkzeug lokal ausführbar“: 5 vorhandene Einträge. Filterreset erfolgreich.
- „Webseiten“: 3.101 vorhandene Treffer über lokale Begriffsabbildung.
- Vor öffentlicher Suche: keine Anfrage an die öffentliche Suchroute. Öffentlich freigegebener Testbegriff „code review“: 10 echte prompts.chat-Ergebnisse im Browser.
- Desktop 1440×1000 und Smartphone 390×844 visuell/bedienbar geprüft. Mobil scrollWidth 375 bei Viewport 390, kein horizontaler Überlauf.
- `node --test test/brain-capabilities.test.js test/prompts-library.test.js`: 18 bestanden, 0 Fehler/übersprungen.
- JavaScript-Syntax und `git diff --check` erfolgreich.
- Katalog, Quellen, Registry, APIs, Brain-Antwortpfad, öffentliche Suchlogik, Trading, Marktanalyse, Organisation und Migrationen per Git-Vergleich unverändert. Kein zusätzlicher umfangreicher Regressionstest behauptet.

Geänderte Produktdateien ausschließlich `Brain/prompt-library.html`, `Brain/prompt-library.css`, `Brain/capabilities.js`; zusätzlich dieser Nachweis. Keine Installation, Adapteraktivierung, Migration, neuen Dienste oder Produktionsveröffentlichung. Der lokale Release wartet auf gesonderte Deploymentfreigabe.
