# Vorbereiteter Onlinegang · 18.10.2026

## Geprüfter Releaseweg

- Repository `forkermarcel-eng/Marcel-WhatsApp-bot`, lokaler Branch `main`.
- GitHub `main` per Connector: `6b6c13fb826c305cfc8473aa1875a7482e03d105`.
- Vercel-Projekt `marcel-whats-app-bot`, `prj_GAEC9OFDwq6UGv2koGhaYg83T8Mc`,
  Node 24.x, Framework `null`. Bestehende statische HTML-Seiten und Node-API,
  kein zusätzlicher Frontend-Bundler. Neun vorhandene API-Dateien; keine neue Function.
- `marcelmarlow.com` zeigt READY-Produktionsdeployment
  `dpl_DWMUi8zXebMWxk857JEDPQQF3cVh`, Git-Quelle main/6b6c13f.
- GitHub-Status für 6b6c13f: Vercel success, Railway success. Das ist ein
  Deploymentstatus, kein aktueller Railway-Laufzeit-/Datenbanknachweis.
- Vercel-Environment-Metadaten bestätigen die vorhandenen Namen
  `RAILWAY_BACKEND_URL`, `DASHBOARD_API_SECRET`, `DASHBOARD_USERNAME`,
  `DASHBOARD_PASSWORD`. Werte wurden nicht entschlüsselt oder ausgegeben.
- Railway-Direktprüfung konnte keine Verbindung herstellen (CLI meldet
  `Unable to get home directory`). Backend-Environment, Datenbankschema, Backup
  und aktuelle Fact-Zahlen sind daher offen. 16 Themen / 97 aktive API-Fakten /
  37 menschlich bestätigte Fakten bleiben gemeldete Referenzen, keine Livezählung.

## Kleiner Deployment-Diff

Bestehende `/Brain/`-Dateien, neue reine Brain-Module und die bestehende
`api/dashboard/marcel-brain.js`-Function mit `resource=chat` verwenden.
`index.js` enthält nur Registrierung/Import der Chatroute; keine neue Framework-
oder Hostingabhängigkeit. Login, HMAC-Cookie, Backend-Bearer und übrige Kanäle
bleiben bestehen. Ein Push auf main kann die vorhandenen Git-Deployments auslösen;
deshalb kein Push vor Freigabe.

## Freizugebende Reihenfolge

1. Railway-Ziel/Branch und PostgreSQL-Ziel lesend bestätigen; geprüftes Backup
   einschließlich Restore-Nachweis bereitstellen. Keine bestehenden Geheimnisse ändern.
2. Wenn das Schema fehlt, ausschließlich die vorbereitete
   `migrations/20261018_brain_knowledge_foundation.sql` anwenden. Sechs Tabellen
   im Namespace `marcel_knowledge`; keine Änderung an `marcel_memory`/Live State.
3. Privates Transferartefakt außerhalb Git mit `brain-transfer.mjs plan --target`
   abgleichen. Bei ID-Konflikten stoppen, nie bestehende Daten überschreiben.
4. Separat freigegebenen Import ausführen. `apply` verlangt erwarteten DB-Namen,
   explizites Schreibflag und einen menschlich geprüften Backup-/Restore-Nachweis.
   Der Nachweis ist ein Betriebsbeleg; das Script führt selbst keinen Restore aus.
5. Backend-Environment: `BRAIN_CHAT_ENABLED=true`, `BRAIN_KNOWLEDGE_ENABLED=true`,
   `BRAIN_KNOWLEDGE_WRITES=true` für explizite Owner-Reviews/Imports,
   `BRAIN_CHAT_MODE=knowledge`, `BRAIN_CHAT_PAID_API_ENABLED=false`.
   `BRAIN_KNOWLEDGE_FILE` in Railway nicht setzen. Vorhandene DB/API-Secrets behalten.
6. Freigegebenen Commit über den bestehenden GitHub-/Vercel-/Railway-Weg
   veröffentlichen. Keine private SQLite-Datei und keinen Export in Git aufnehmen.
7. Angemeldet prüfen: Wissensmodus, Quellenabruf, Gespräch erneut öffnen,
   TXT-Export, Lernvorschau, unautorisierter Zugriff verweigert. Kein bezahlter Modelltest.

## Dauerhafte Daten / späterer eigener Rechner

Cloud: bestehende PostgreSQL-DB, `marcel_knowledge.meta` für `brain-chat:<uuid>`;
dieselben sechs Collections enthalten Indextexte, Quellen, Beziehungen, Korrekturen
und Reviews. Lokal: vorhandene `.local-knowledge/marcel-brain.sqlite`.
Es wird keine zweite produktive Datenbank eingerichtet.

`node scripts/brain-transfer.mjs export --db <existing-sqlite> --out <private-json>`
exportiert alle sechs Collections einschließlich Gesprächen. `plan --file <json>`
ist offline und schreibt nicht in die Datenbank. PostgreSQL-Übernahme ist
transaktional und idempotent; abweichende IDs brechen den Gesamtimport ab.

Der JSON-Export enthält **keine Original-Dokument-/Medienbytes**, keine Secrets
und keinen Dump der bestehenden anderen PostgreSQL-Tabellen. Für Cloud-to-Local
zusätzlich geprüften nativen PostgreSQL-Dump, Dokument-/Medienablage und deren
Hashes sowie sichere Konfigurationsreferenzen übernehmen. Exportierte Quellenpfade
dienen als Inventar, nicht als Nachweis mitgesicherter Dateien. Suchindizes können
aus erhaltenen Texten/Metadaten rekonstruiert werden; ein Modellwechsel ändert sie nicht.

Die lokale Ablage liegt im OneDrive-Pfad, ist nicht durch diese Module verschlüsselt
und kein geprüfter Restore. Hosting-/Datenbankspeicher können weiter Kosten haben;
die Kostensperre verhindert zusätzliche Brain-Modell-API-Aufrufe.
