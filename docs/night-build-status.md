# Master Night Build — lokaler Stand

Kein Production-Deployment und kein weiterer Railway-Zugriff. Die Railway-Sperre
bleibt bestehen: kein Resize, Neustart, SQL, Migration oder Änderung an
Produktionsdaten.

## Lokal umgesetzt

- Freigegebene Memory-Fakten werden vor der Dokumentensuche deterministisch
  beantwortet. Ablauf, Freigabe, Konflikte und Privatsphäre werden geprüft.
- Der Dokumentenabruf misst seine lokalen Teilzeiten, nutzt unveränderte
  Vektoren erneut und vermeidet wiederholtes Durchsuchen der Evidenzliste.
- Vier statische Kommunikationsrichtlinien wurden bytegleich aus `index.js` in
  `services/communication-policies.js` ausgegliedert. Der verbleibende
  `index.js`-Startpfad wurde nicht umgebaut.
- Manuelle Chat- und TXT-Vorschläge für Entscheidungen, Anforderungen,
  Stilregeln, Workflows, Aufgaben und persönliche Angaben bleiben `pending`,
  erhalten Gesprächsbezug und überschreiben bestätigte Fakten nicht. Projekte
  Marcel, LUXE, Barber und Trading bleiben getrennt.
- EPUB, DOCX, TXT, Markdown und JSON können nach Vorschau als prüfpflichtige
  Quelle importiert werden. Stilquelle und Transkript sind eigene Zwecke; eine
  Audiodatei benötigt weiter ein vorhandenes Transkript oder eine spätere lokale
  STT-Anbindung.
- Der lokale Ollama-/llama.cpp-kompatible Adapter verarbeitet begrenztes SSE
  Streaming, akzeptiert ausschließlich Loopback und hat keinen Cloud-Fallback.
- Nachrichten, Wetter und Finanzen haben eigene Weltansichten. Finanzen liest
  nur bereits gespeicherte Trading-Kerzen und kennzeichnet sie als verzögert
  oder veraltet. Wetter nutzt die vorhandenen MET-Daten mit Stunden- und
  Tagesverlauf; nicht angeschlossene Warnungen werden ehrlich benannt.
- Die interne Navigation enthält nur Brain, Welt, Nachrichten, Wetter und
  Finanzen. Die Weltansicht erhielt responsives Liquid Glass, eine lösbare
  Kamerafixierung, größere Markerflächen, progressives Cluster-Zoom und
  optionale Vorschaubilder am nahen Einzelmarker.
- PWA-Metadaten und private, standardmäßig deaktivierte Vorbereitungen für
  lokale Sprache, Home Assistant, Rezeptquellen und Social-Drafts sind vorhanden.
  Sie führen keine Geräteaktion, Veröffentlichung oder Plattformautomatisierung
  aus.
- Lokale Datenportabilität umfasst einen überprüfenden Restore in eine neue
  SQLite-Datei und einen begrenzten Owner-Chat-Export. Es gibt keine zweite
  Produktions-Wissensdatenbank.

## Lokale Prüfung

- Vollständige vorhandene Testsuite erfolgreich; zusätzlich gezielte Night-
  Build-Tests für Fakten, Streaming, EPUB, Lernvorschläge, lokale Adapter,
  Workspaces und 47-Marker-Cluster.
- Browser-Prüfung mit rein synthetischen Daten: Faktenabfrage, Review-Vorschlag,
  Welt-/News-/Wetter-/Finanzansichten, Fixierung sowie 47 einzeln klickbare
  Marker. Desktop und Mobilansicht hatten keinen horizontalen Überlauf.
- Suchbenchmark mit 10.000 synthetischen Einträgen: mittlere warme Suche etwa
  5,2 s auf 53 ms, bei gleichen Treffern. Das ist kein Produktions-Latenzwert.
- Öffentliche RSS-Prüfung: 54 von 55 Quellen erreichbar. Vier geprüfte
  Herausgeber-Weiterleitungen wurden auf ihre kanonischen HTTPS-Feeds umgestellt;
  CBC lief im letzten Prüflauf in ein 12-Sekunden-Timeout.

## Quellen- und Wissensstand

Der private Read-only-Audit fand 63 lesbare Quellen, neun erwartete aber nicht
vorhandene Quellen, eine bewusst ausgeschlossene Drittperson-Unterhaltung und
ein über der 256-MiB-Grenze liegendes Owner-Chatarchiv. Der Audit erzeugt keine
Einträge und vergleicht wegen der Railway-Sperre nicht mit dem Produktionsregister.

## Railway für morgen

1. Volume-Größe im Dashboard bestätigen und den bestehenden PostgreSQL-Dienst
   regulär starten.
2. Readiness, Datenbankname, 98 Memory-Zeilen, 10.911 Wissenseinträge und zwei
   Gespräche zuerst lesend vergleichen.
3. Die drei eindeutig eigenen Restore-Testdatenbanken nur bei eindeutiger
   Identität regulär per SQL entfernen.
4. Den neuen Dump erst danach gegen eine isolierte Wiederherstellung prüfen.
5. Erst nach diesen Prüfungen Quellenregister gegen Produktion abgleichen,
   Review-Vorschläge bewusst prüfen und eine getrennte Deployment-Entscheidung
   treffen.
