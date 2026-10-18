# Weltansicht – 18. Oktober 2026

Erweitert die vorhandene `/Brain/`-Anwendung. Ausgangscommit `a3f6f50`,
GitHub main; Vercel `marcel-whats-app-bot`, Railway `spirited-peace` /
production / `cooperative-kindness`. Kein zusätzlicher Hostingdienst.

## Datensicherung und Migration

Vor der Änderung wurde `railway` mit PostgreSQL 18.6 als Custom-Dump gesichert.
Ein vollständiger Restore in `marcel_world_restore_20261018` war erfolgreich.
Die ausdrücklich freigegebene private lokale Kopie liegt außerhalb Git im
Windows-Tempordner (`marcel-before-world-20261018.dump`, 17.293.360 Bytes).
Gesicherter Bestand: 98 Memory-Zeilen / 38 bestätigt, 10.910 Wissenseinträge,
2 gespeicherte Gespräche. Die Migration wurde zuerst am Restore und danach
in Produktion ausgeführt, jeweils mit unveränderten Bestandszahlen.

`migrations/20261018_brain_world.sql` legt ausschließlich den Namespace
`marcel_world` mit `news`, `sources`, `cache` an. Kein implizites DDL im
Anwendungsstart und keine Änderung an bestehenden privaten Tabellen.
Rückweg: Anwendungscommit auf `a3f6f50` zurücksetzen/veröffentlichen;
die additiven Welttabellen können ungenutzt bleiben. Kein destruktiver
Datenbankrollback erforderlich. Dump und Restore-Datenbank sind privat;
Aufbewahrung und spätere Entfernung separat verwalten.

## Datenquellen und Grenzen

- Nominatim / OpenStreetMap: ausdrückliche Suche und einzelne Klickauflösung,
  kein Autocomplete, keine Rasterabfragen, 30 Tage Cache, Datenbank-basierte
  Begrenzung auf höchstens eine neue Abfrage je 1,1 Sekunden für die Anwendung.
  Attribution ODbL. Bei größerem Nutzerkreis eigenen/zugelassenen Dienst verwenden.
  https://operations.osmfoundation.org/policies/nominatim/
- MET Norway Locationforecast: weltweite Modellvorhersagen, keine behaupteten
  Stationsmessungen. Identifizierter Serverabruf, Cache nach Expires, CC BY 4.0.
  Ortszeit über `tz-lookup` und IANA/Intl. Bei Ländern bezieht sich das Wetter
  auf den ausgewählten Koordinatenpunkt, nicht auf das ganze Staatsgebiet.
  Max/Min gelten für die noch vorhandenen Vorhersagestunden des lokalen Tages.
  Gefühlte Temperatur, Regenwahrscheinlichkeit und UV fehlen, wenn nicht geliefert.
  https://docs.api.met.no/doc/TermsOfService.html
- Wikidata: exakter OSM-Wikidata-Verweis; Wikipedia: Ortsüberblick mit Lizenzlink.
  Commons-Bild nur für dasselbe Objekt und mit auslesbarer freier Bildlizenz,
  Urheber und Quelllink; andernfalls neutrale Ortskarte.
- NASA Blue Marble: statische echte Erdtextur, keine Live-Satellitenansicht.
  Quellenangaben in `Brain/assets/ATTRIBUTION.txt`. Vorhandene Three.js-Version.
- Offizielle RSS/Atom-Feeds: aktuelle kurze Feed-Auszüge, Quellenlinks und
  gegebenenfalls vom Feed gelieferte Bildverweise; keine Artikelvolltexte,
  kein Scraping von Bezahlschranken. Nichtdeutsche Originaltitel werden mit
  Sprachkennzeichnung gezeigt; keine kostenpflichtige Übersetzung.

Der bestehende Trading-HTTP-Feedadapter wird wiederverwendet; die eigenen
temporären Welttabellen verhindern, dass die Welt-Bereinigung Trading-Daten
oder privates Wissen löscht. Miniflux/RSSHub würden zusätzliche Dienste
und Betriebsaufwand verursachen. GDELT GEO wurde geprüft, antwortete mit 404;
es wird nicht als funktionierende Datenquelle ausgegeben.

Die Quellenliste ist erweiterbar (`brain-world/sources.js`). Erreichbarkeit und
frische Meldungen sind getrennt erfasst. Die Oberfläche nennt aktive Quellen,
Fehler, letzte erfolgreiche Abrufe und tatsächliche Themen-/Länderherkunft.
Ein Feedsitz ist niemals ein belegter Ereignisort. Ortsnennungen sind ausdrücklich
ungeprüft. Globusmarker und lokale Treffer verwenden ausschließlich gelieferte
Feed-Koordinaten; viele Quellen liefern keine. Flächendeckende Ereignisgeografie,
Regionsfilter, GDELT-Anreicherung und journalistisch geprüfte Hauptorte fehlen.
Die Weltansicht ist deshalb keine vollständige lokale Nachrichtenabdeckung.

## Jobs und Aufbewahrung

Im bestehenden Railway-Prozess: Quellenprüfung alle fünf Minuten, je Quelle
normalerweise 30 Minuten; ETag/Last-Modified, Fehler mit exponentieller Pause,
PostgreSQL-Advisory-Lock gegen doppelte Worker. Kein Browser/Laptop nötig.
Bereinigung unabhängig vom Feedjob jede Minute. Artikel laufen eine Minute
vor 72 Stunden seit Publikation oder früher ab; API schließt abgelaufene Zeilen
sofort aus. Der Worker löscht physisch, protokolliert Datum und Anzahl in seinem
eigenen Wartungscache. Bei Prozessstillstand folgt Löschung beim Neustart.
Es werden keine eigenen Nachrichtenbilddateien oder Artikelvolltexte angelegt.
Bild-URLs verschwinden mit den temporären Zeilen; fremde Browser-/Publishercaches
können von dieser Anwendung nicht gelöscht werden.

Ein ausdrücklich gemerkter Artikel wird transaktional und idempotent als
`source_reference` mit Dokument und Herkunftsbeleg in den bestehenden
`marcel_knowledge`-Collections abgelegt. Der Artikel wird dadurch weder ein
bestätigter persönlicher Fakt noch eine wissenschaftlich verifizierte Aussage.
Die Welt-Bereinigung greift auf keine dieser Collections zu.

## Erhaltene Bereiche

## Prüfung vor Veröffentlichung

- Vollständiges bestehendes `npm test`: erfolgreich.
- Sechs zusätzliche Welt-Tests: RSS-Sicherheit/Ablauf, freie Orte/Zeitzonen,
  Wettervorhersage, transaktionales Merken/Deduplizierung/Bereinigung,
  Wetterausfall und Zugriffsschutz: erfolgreich.
- Sharp-Patchupdate 0.35.5: Bildpipeline und Medientests erfolgreich;
  npm meldet nach dem Update keine bekannten Sicherheitslücken.
- Browser, reale Provider, getrennte PGlite-Testdatenbank: Geithain,
  Brasilien, Tokio, Shanzu, Medellín; Reverse-Geocoding bei Shanzu;
  MET-Vorhersagen und Commons-Stadtbild mit Urheber/Lizenz geprüft.
- Desktop 1448 × 1086 und mobile Browserbreite 390: kein horizontaler Überlauf.
- 34 konfigurierte Feeds einschließlich offizieller USGS-Erdbebenmeldungen
  mit gelieferten Ereigniskoordinaten; im ersten lokalen Medienabruf 26 mit frischen Meldungen,
  darunter Nation Kenya, The Standard und El Tiempo. Produktionszahlen können
  abweichen und werden erst nach dem Deployment berichtet.

## Bestehendes Brain

Neuronale Geometrie, Impuls-/Knotenanimation, Themenfarben, Wissensreview,
Chat, TXT-Export, Reimport und Lernvorschau bleiben im Bestand. Manuelle
Themen-/Modusbedienung ist ausgeblendet; lokale Kontextaktivierung bleibt.
Die vorhandene lokale Modellschnittstelle ist providerunabhängig; kein neues
Modell installiert und keine kostenpflichtige KI aktiviert. Smartphoneprüfung
im Browser ist kein echter iPhone-Hardwaretest.
