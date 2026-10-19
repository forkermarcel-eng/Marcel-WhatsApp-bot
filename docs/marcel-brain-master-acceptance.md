# Marcel Brain – Master-Abnahme

Stand: 19.10.2026. Quellen dieses Registers sind Master Night Build (1/4), Fortsetzung (2/4), Ausführungsplan (3/4), Ergänzung (4/4) und *Premium Design & Live-Data Integration*. `PASS` bedeutet mit Code und gezieltem Test belegt; `PARTIAL` bedeutet implementiert, aber nicht vollständig unter Produktionsbedingungen abgenommen; `BLOCKED` benennt eine externe Voraussetzung. Dieses Dokument behauptet keinen Abschluss für PARTIAL oder BLOCKED.

| ID / Anforderung | Status | Umsetzung und Nachweis |
| --- | --- | --- |
| MN-1 Bestehende Systeme, Daten und produktive Daten schützen | PASS | Additive Module/Schemas, keine Migration in diesem Stand; frischer Dump und Restore-Check vor Release, siehe Testprotokoll. |
| MN-2 Zwei getrennte 3D-Ansichten (Brain und Welt) | PASS | `Brain/brain.html`, `Brain/world.html`, getrennte Workspace-Controller und Styles. |
| MN-3 Brain: bestehendes Gehirn, Erde, Energieverbindungen, räumliche Tiefe | PARTIAL | Bestehende Szene wurde erhalten; `Brain/workspaces.css` ergänzt holografische Licht-, Tiefen- und Glass-Layer. Visuelle Abnahme im authentifizierten Produktionsbrowser fehlt. |
| MN-4 Welt: Weltraum, große Kugel, Ortskarte und Nachrichtenleiste | PASS | `Brain/world.html`, `Brain/world.js`, `Brain/world.css`, `brain-world/routes.js`; UI-Regressionstests decken die Workspace-Struktur ab. |
| MN-5 Apple Liquid Glass, keine endlose Seite | PASS | Glass-Tokens, feste Arbeitsflächen und responsive CSS in `Brain/workspaces.css`/`Brain/world.css`; Desktop- und Mobil-Regression geprüft. |
| MN-6 Kugelsteuerung, Kamera-Fixierung, Zoom und Marker-Klick | PASS | Cluster-/Marker- und Fokuslogik in `Brain/world.js`; `npm run test:brain-world` deckt Klick, Zoom und Ortswechsel ab. |
| MN-7 Weltweite Ortssuche: Koordinaten, Kamera, Karte, Wetter, Ortsnews | PASS | `brain-world/service.js`, Routen und World-UI verbinden Geocoding, Fokus, Wetter und gefilterte News. |
| MN-8 Eigenständige News-Ansicht, deutsche und internationale Quellen | PASS | `Brain/workspaces.js`, `brain-world/sources.js`; 55 produktive Quellen und aktive Nachrichten wurden beim Audit gezählt. |
| MN-9 Automatische News-Aktualisierung und 72-Stunden-Ablauf | PASS | `brain-world/routes.js` synchronisiert/cleant; TTL in `brain-world/service.js`; Audit: 2.773 aktive, innerhalb 24 h bezogene Meldungen. |
| MN-10 Merken/Archiv für Nachrichten | PASS | Bookmark-/Archivpfade in `brain-world/service.js` und Workspace. |
| MN-11 Ortsinformationen und animiertes Wetter | PARTIAL | Orts- und Vorhersageansicht mit Open-Meteo/MET-Norway-Anbindung, Wetterzuständen in `Brain/workspaces.js`; Unwetter- und Radardaten sind noch nicht angebunden. |
| MN-12 Eigenständige Finanzansicht und vorhandene Trading-Anbindung | PASS | Markt-Workspace, Chart und gespeicherte Reihen in `Brain/workspaces.js`, `brain-world/markets.js`, `trading-core`. |
| MN-13 Tatsächliche Kurse, Charts, Wirtschaftsnachrichten und keine erfundenen Live-Daten | PASS | Massive wird als `massive-delayed` gespeichert und UI/API kennzeichnen sie als verzögert; Trading-News laufen im Kontextworker. Keine Broker- oder Order-Verbindung. |
| MN-14 Voll funktionsfähige interne Navigation | PASS | Brain, Welt, News, Wetter, Finanzen und die übrigen Zielrouten sind in `Brain/workspaces.js` verdrahtet; Web-UI-Test deckt Wechsel ab. |
| MN-15 Wissensabruf: bestätigte Fakten, aktuelles Wissen, Projekte, Dokumente, Historie | PASS | `brain-chat/facts.js`, `brain-chat/retrieval.js`, `brain-knowledge/routes.js`; Night-Build-Tests prüfen Faktenpriorität und Retrieval. |
| MN-16 `index.js` untersuchen, Wissen erhalten, modularisieren | PASS | Routen/Policies in `brain-*`, `services/communication-policies.js` und `trading-core` extrahiert; vollständiger Server-Import wird isoliert getestet. |
| MN-17 Zentrales Projekt- und Entscheidungsgedächtnis | PASS | Reviewbare Projekt-/Entscheidungsflüsse in `brain-chat/learning.js` und Memory-Routen; keine automatische Freigabe persönlicher Behauptungen. |
| MN-18 Bücher/Dokumente, Version/Herkunft, Duplikate und Widerspruchsreview | PASS | Sichere Import-/Extraktionspfade einschließlich EPUB in `brain-knowledge/extract.js`; Provenienz/Review in Knowledge-Modulen. |
| MN-19 Kommunikation-DNA, Korrekturen und Persönlichkeit | PASS | `services/communication-policies.js`, `brain-chat/learning.js`; die reale Serverstart-Regression importiert die Policy unverändert. |
| MN-20 Lokaler KI-Motor, Datenportabilität, Cloud-zu-PC | PARTIAL | Loopback-only Adapter für Ollama/Qwen/llama.cpp und Export-/Restore-Werkzeuge vorbereitet. Lokales Modell, Hardware und Modellgewicht sind nicht vorhanden/konfiguriert. |
| MN-21 Performance, Reaktionszeiten und Messbarkeit | PARTIAL | Begrenzte Abrufe, Caches, Größenlimits und isolierte Provider-Tests vorhanden. Keine dauerhaft erhobene Browser-RUM-Metrik. |
| MN-22 iPhone/privater lokaler Zugang | PARTIAL | Architektur und sichere lokale Adapter vorbereitet; keine signierte iPhone-App bzw. Gerätefreigabe vorhanden. |
| MN-23 Social Media, Rezepte, Discovery, Freigabe vor Veröffentlichung | PARTIAL | Entwurfs-/Freigabeadapter in `brain-integrations/social-drafts.js`; keine Konten- oder Plattformberechtigung, daher keine Discovery/Publikation. |
| MN-24 Smart Home/WLAN-Mikrofone und Sprache | PARTIAL | `brain-integrations/home-assistant.js` und `voice.js` sind explizit deaktivierte, lokale Vorbereitungen. Hardware, Home-Assistant-Endpunkt und Einwilligung fehlen. |
| PD-1 Einheitliche Premium-Designsprache/desktop und mobil | PARTIAL | Liquid-Glass- und responsive Arbeitsflächen implementiert und lokal gerendert; authentifizierte Produktionsansicht noch nicht visuell abgenommen. |
| PD-2 Magazin-News mit Bildern/Karussells/Interaktion | PASS | News-Workspace und Quell-/Cache-Layer liefern bebilderte, navigierbare Kacheln; Feed- und Cache-Tests bestanden. |
| PD-3 Echte Wettervorhersage | PASS | Provider-Adapter statt Fixture-Daten im produktiven Pfad; lokale UI-Prüfung der Ortswechsel bestanden. |
| PD-4 Live-Finanzdaten: Anbieter prüfen, Aktualisierung reparieren | PASS | Massive-Anbindung untersucht und integriert: opt-in, maximal vier vorhandene Kontrakte, zehnminütiger Takt, keine Symbolerfindung, verzögerte Kennzeichnung. Der bestehende News-Worker protokollierte erfolgreiche 200/304-Abrufe. |
| PD-5 Veröffentlichung und veröffentlichte Website prüfen | PARTIAL | Deployment-Commit wird erstellt/über die bestehende Pipeline veröffentlicht. Externe Website kann ohne angemeldete Sitzung nur auf `/login` geprüft werden; siehe offene Punkte. |

## Massive: konkrete Integration

`refreshMassiveMarkets()` in `trading-core/server/providers.js` ruft ausschließlich den vorhandenen Massive-Schlüssel ab, nur bei `TRADING_MASSIVE_ENABLED=true`, höchstens vier bereits gespeicherte Kontrakte und maximal alle zehn Minuten aus `trading-core/workers/context.js`. Jede Kerze wird als `massive-delayed` mit Quelle, Zeit und Auflösung gespeichert. Fehlgeschlagene Abrufe verändern keine vorhandenen Kerzen. Der kostenlose Tarif kann historische/verzögerte Daten liefern; der Code behauptet deshalb keinen Echtzeitkurs.

