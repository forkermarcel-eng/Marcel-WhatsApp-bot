# World Experience 2.0 — 18. Oktober 2026

Erweitert den Produktionsstand `31bf848` in der vorhandenen Brain-Anwendung.
Keine neue Anwendung, kein zusätzlicher Dienst, keine kostenpflichtige KI.

## Änderungen

- Desktop: Fensterhöhe, kompakte Orts-/Wetterkarte über dem Globus, unabhängig
  scrollende Nachrichten. Mobil: untereinander angeordnete Bereiche.
- Weltweite manuelle Ortssuche und Kartenwahl; echte deutsche/englische
  Namensvarianten aus Nominatim, keine erfundenen Übersetzungen.
- Kurze deutsche Ortsbeschreibung, separate vollständige Details und ausschließlich
  dem Wikidata-Objekt zugeordnete, frei lizenzierte Bilder mit Quellenangabe.
- Deutsche Nachrichten als Standard; internationale Originale separat.
- 55 konfigurierte Quellen. Neue Endpunkte wurden auf öffentlich erreichbare
  RSS-/Atom-Einträge geprüft. NIUS verwendet die kanonische Adresse `nius.de/rss`.
  BILD verwendet `bild.de/feed/alles.xml`; dessen explizite CET-/CEST-Datumsfelder
  werden mit dem richtigen UTC-Offset geparst. FOCUS, WDR und kicker bleiben
  mit dem tatsächlichen Fehlerstatus außerhalb der aktiven Quellenliste.
- Geografie: Natural-Earth-Länder und tatsächlich vom Nutzer aufgelöste Orte;
  Titelbezug, Feed-Koordinate und USGS-Ereignis sind unterschiedliche Belege.
  Der Herkunftsstaat eines Verlags erzeugt keinen Ereignisort.
- Dynamische Zoomcluster behalten alle Artikel-IDs und eine reale
  Mitgliederkoordinate. Klick öffnet zugehörige Artikel; rückseitige Marker
  sind verdeckt. Drag/Pinch löst keinen Kartenklick aus.
- USGS-Erdbeben erhalten deutsche Titel, Magnitude und Ereigniskoordinaten.
- Favoriten liegen in bestehendem `marcel_knowledge.meta`, Artikelverweise im
  bestehenden Wissensarchiv. RBB/NDR-Lesezeichen speichern nur Quellenlink und
  persönliche Notiz. Keine zweite Wissensdatenbank und keine neue Migration.
- Statische NASA-Tag-/Nachtaufnahmen, dünne Atmosphäre und bei Ruhe pausierender
  WebGL-Renderloop. Bewegungsreduktion und abschaltbare Wetteranimationen.

## Sicherung und Schutz des Bestands

Frischer, ausdrücklich erlaubter PostgreSQL-Custom-Dump mit erfolgreichem
vollständigem Test-Restore. Private lokale Kopie außerhalb Git:
`%TEMP%/marcel-world2-20261018.dump`, 17.494.284 Bytes.
Ausgangsbestand: 98 Memory-Zeilen, davon 38 bestätigt, 10.911 Wissenseinträge,
2 gespeicherte Gespräche. Keine Änderung dieser Bestände für die Umsetzung.
Der vorherige Release und sein Backup bleiben verfügbar.

Rollback: Anwendungsstand `31bf848` erneut veröffentlichen. Kein destruktiver
Datenbankrollback nötig. Bestehende 72-Stunden-Aufbewahrung und minütliche
physische Bereinigung bleiben aktiv; gespeicherte Artikel bleiben bestehen.

## Verifikation und Grenzen

Bestehende vollständige `npm test`-Suite erfolgreich. Zwölf gezielte Tests
prüfen unter anderem Sprachen, geografische Trennung, unbekannte Länder,
Cluster, Zeitstempel, persistente Favoriten, Authentifizierung und Archivierung.
Browserprüfung mit echten öffentlichen Daten bei 1448×1000, 1366×768,
1024×768 und 390×844; Desktop ohne Dokumentüberlauf. Marker, Drag, Suche,
Wetter, Favoriten, Sprachwechsel und Rückkehr zum Brain wurden bedient.

Es gibt keine behauptete vollständige Lokalabdeckung. Ohne belegbare lokale
Artikel erscheint ein ehrlicher Leerzustand. Titelbezüge sind keine verifizierten
Ereignisorte. Nicht geokodierte Artikel bleiben lesbar, erhalten aber keinen
erfundenen Punkt. Nominatim wird nur durch konkrete Nutzeraktionen angefragt,
nicht zur massenhaften Geokodierung von Meldungen. Ausfälle von Quellen,
fehlende deutsche Texte oder fehlende Bildrechte bleiben sichtbar.
