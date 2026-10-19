# Marcel Brain – Testresultate

Stand: 19.10.2026. Alle hier genannten Befehle wurden im Worktree `trading-current-integration` ausgeführt. Zugangsdaten wurden weder ausgegeben noch in dieses Repository geschrieben.

| Prüfung | Ergebnis | Beleg |
| --- | --- | --- |
| Communication-Policy/Serverstart | PASS | `node --test trading-core/tests/current-integration.test.js`: 5/5; der frühere Fixture-Fehler wurde durch vollständige, harmlose Modul-Stubs behoben, der Test bleibt aktiv. |
| Trading Provider und Massive | PASS | `node --test trading-core/tests/providers.test.js trading-core/tests/current-integration.test.js`: 14/14. Der neue Test prüft Opt-in, keine Abrufe ohne Freigabe, Vier-Kontrakt-Grenze, Bearer-Header und Speicherung nur als `massive-delayed`. |
| Kontext-Nachrichten | PASS | Railway-Logs: Contextworker gestartet im 60-s-Takt, erfolgreiche HTTP-200/304-Abrufe, bestehende Backoff-Fehler bleiben sichtbar und werden nicht als Erfolg ausgegeben. |
| Massive-Zugang | PASS | Read-only Probe gegen den bereits konfigurierten Anbieter: HTTP 200, gültige Ergebnisliste; Schlüssel nicht ausgegeben. |
| Brain/World Regression | PASS | Zuvor ausgeführt: `npm run test:night-build` 13/13 und `npm run test:brain-world` 13/13. |
| Workspace/Navigations-UI | PASS | Zuvor ausgeführt: `npm run test:web-ui` 7/7; lokaler Desktop- und Mobile-Snapshot ohne Scroll-/Nav-Regression. |
| Gesamte lokale Testmatrix | PASS | Alle von `npm test` referenzierten Suiten wurden in ihrer jeweiligen npm-Teilgruppe ausgeführt. Die besonders lange Shared-Media-Suite endete mit Exit 0, 66 bestanden, 0 fehlgeschlagen. |
| Produktionsintegrität vor Release | PASS | Read-only Audit: 93 Tabellen, DB 119 MB, 91 Wissensdokumente, 10.911 Einträge, 13.645 Evidenzen, 97 aktive Memories, 37 freigegebene Bot-Memories, 2.773 aktive World-News, 407 Trading-News, 27.546 Kerzen. |
| Frisches Backup und Restore | PASS | Privater Custom-Dump `%TEMP%\\marcel-production-20261019-final.dump`; in `marcel_final_restore_20261019` wiederhergestellt: 93 Tabellen, gleiche Knowledge-/Memory-/Trading-Zählwerte. Testdatenbank danach regulär gelöscht. |
| Produktiver Browser-E2E | UNVERIFIED | Die öffentliche Domain leitet ohne vorhandene Browser-Sitzung nach `/login`; deshalb kein ehrlicher visueller Freigabetest möglich. |

## Nicht ausgeblendet

* `trading-core/tests/context-worker.test.js` existiert nicht; ein Aufruf hat daher bewusst fehlgeschlagen. Der Worker wird über Provider- und vollständigen Server-Starttest abgedeckt, aber der zehnminütige Timer hat noch keinen eigenen isolierten Test.
* Vorherige Tests sind dem damaligen Commitstand zugeordnet. Vor dem Merge wurden die unmittelbar geänderten Provider- und Serverstarttests erneut vollständig ausgeführt.

