# Brain-Hauptansicht — holografischer Weltzugang

19. Oktober 2026. Ausgangsstand: produktiver GitHub-main-Commit `bd94d44`.

## Umfang und Trennung

`Brain/index.html` lädt zwei neue, lokale Dateien: `hologram.js` und
`hologram.css`. Die bestehende Gehirn-Engine `scene.js`, ihre Geometrien,
Aktivierungen und Interaktionen bleiben bytegleich. Hauptnavigation und
Chat-Markup/-Handler sind unverändert.

Die Mini-Kugel verwendet die vorhandene Three.js-Version und die vorhandenen
Natural-Earth-Konturen, eigene Kamera und Rotation, transparente Flächen,
Konturlinien, zwölf dezente Netzwerkbahnen und Lichtimpulse. Drei animierte
SVG-Verbindungen verknüpfen Gehirn und Mini-Kugel. Keine Nachrichtendaten,
Ortsauswahl, Labels, Filter oder persistierten Kamerazustände in der Vorschau.

Alle Änderungen an bestehenden Elementen sind auf `[data-scene=brain]`
begrenzt. Die ursprüngliche geografische Kugel ist dort ausgeblendet; ihr
bestehender IntersectionObserver stoppt das Rendering. In der Weltansicht
bleiben deren Dateien, Darstellung und Steuerung vollständig unverändert.
Die neue Mini-Kugel und Energieanimation pausieren außerhalb der Brain-Ansicht.

## Bedienung und Leistung

Der native, tastaturbedienbare Kugel-Button öffnet nach 240 ms die bestehende
Weltansicht. Kamera und Auswahl dieser Ansicht bleiben erhalten. Rückkehr zur
Brain-Ansicht setzt die unabhängige holografische Rotation fort.

Maximal 24 Bilder/s, mobil/sparsam 20, Canvas-2D-Fallback 12. Begrenzte
Pixelauflösung und Partikelanzahl, keine zusätzlichen Rendering-Bibliotheken.
Die bestehende Animationspause und die Betriebssystemeinstellung für reduzierte
Bewegung werden berücksichtigt. Auf schmalen Displays entfallen die quer
verlaufenden Energiepfade zugunsten der unverdeckten bestehenden Chatbedienung.
Bei WebGL-Ausfall bleibt eine vereinfachte animierte Konturenansicht bedienbar.

## Sicherung und Abnahme

Produktiven Quellstand vor Änderungen gesichert:
`%TEMP%/marcel-brain-before-hologram-bd94d44.zip`, 8.684.742 Bytes.
SHA-256: `8467f115a4344e89bc5201186e46e78adbdceebeb4fd29b6c47a20a03bd7cbdc`.
Keine Datenbankmigration oder produktiven Datenänderungen. Der bereits
wiederhergestellte private Produktionsdump bleibt außerhalb Git verfügbar.
Read-only geprüft: 98 Memory-Zeilen, 38 bestätigt, 10.911 Wissenseinträge,
zwei gespeicherte Gespräche.

- 26 vorhandene gezielte Präsentations-/Navigationstests erfolgreich.
- Browserprüfung des tatsächlichen Codes mit bestehenden authentifizierten
  APIs; keine Chatnachricht gesendet und keine Daten geschrieben.
- Rotation, Lichtverbindungen, Hover, Mausklick, Tastaturwechsel, Rückkehr,
  unveränderte Auswahl/Zoom und markerfreie Vorschau geprüft.
- Chat-Eingabe auf Desktop geometrisch identisch; mobil vollständig bedienbar.
- GPU-Aufrufprüfung: keine Draw-Aufrufe der großen Erde in der Brain-Ansicht;
  keine Hologramm-Aufrufe nach Wechsel zur Weltansicht.
- Reduzierte Bewegung hält die Animationszeit an. Erzwungener Kontextverlust
  aktiviert den funktionierenden 2D-Fallback.
- Vorher-/Nachher-Vergleich der Weltansicht bei 1448×1000, 1366×768,
  1024×768 und 390×844: identische geprüfte Rechtecke und berechnete Stile.

Rollback: `bd94d44` erneut über die bestehende Pipeline veröffentlichen.
Keine Datenbankmaßnahmen erforderlich.
