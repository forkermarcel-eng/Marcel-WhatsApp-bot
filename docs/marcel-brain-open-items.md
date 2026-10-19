# Marcel Brain – offene Punkte und externe Blocker

Stand: 19.10.2026. Diese Punkte sind nicht verdeckt; sie sind in der Master-Abnahme als `PARTIAL` oder `UNVERIFIED` geführt.

| Bereich | Status | Konkreter Blocker / nächster Schritt |
| --- | --- | --- |
| Visuelle Produktionsabnahme | UNVERIFIED | Eine authentifizierte Browser-Sitzung für die veröffentlichte Marcel-Brain-Domain fehlt. Nach Login: Brain, Weltmarker/Zoom, News, Wetter, Finanzen sowie Mobilansicht gegen die Referenz prüfen. |
| Massive als Echtzeitfeed | BLOCKED | Der verwendete Tarif/Entitlement liefert keine zugesicherte Echtzeit. Die Anwendung speichert/zeigt deshalb ausschließlich verzögerte Daten. Für Echtzeit wäre eine ausdrückliche Tarif- und Kostenfreigabe nötig. |
| Wetterradar/Unwetter | NOT STARTED | Es gibt keine kostenfrei freigegebene Radar-/Warnquelle im Bestand. Vor Ergänzung Anbieter, Lizenz und Rate-Limit prüfen. |
| Lokaler KI-Motor | BLOCKED | Kein lokaler Ollama/Qwen/llama.cpp-Server, Modellgewicht oder Hardwareziel konfiguriert. Der Adapter akzeptiert nur Loopback-Verbindungen. |
| iPhone-App | BLOCKED | Apple Developer Signing, Gerät und private Pairing-Freigabe fehlen. |
| Sprache/Smart Home | BLOCKED | Mikrofone, Home-Assistant-Endpunkt und ausdrückliche Haushalts-/Datenschutzfreigabe fehlen. |
| Social-Media-Discovery/Publishing | BLOCKED | Keine Account-/API-Berechtigung. Entwürfe bleiben bis zu expliziter Freigabe lokal und unveröffentlicht. |
| Automatisierte Browser-Performance-Messung | NOT STARTED | Keine dauerhafte, datenschutzgeprüfte RUM-/Synthetic-Monitoring-Infrastruktur konfiguriert. |

## Datenbankänderungen

Dieser Release enthält keine produktive Datenbankmigration. Die einzige Produktionsschreibfunktion ist die ausdrücklich gewünschte, opt-in Massive-Synchronisierung; sie legt ausschließlich zusätzliche/upsertbare `marcel_trading.candles` mit Quelle `massive-delayed` für bereits vorhandene Kontrakte an. Der frische Dump liegt nur im privaten Windows-Tempordner; die ausschließlich für den Test angelegte Restore-Datenbank wurde entfernt.
