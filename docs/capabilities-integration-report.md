# Marcel Brain – Capability-Integration

Stand: 26.10.2026. Isolierter lokaler Release auf Basis von `15d5645b844435a7ce24e6ef4080bb26e8b359d4`. Kein Produktionsdeployment, keine Migration, kein neuer Dienst, keine Modellanfrage. Der Release-Commit ist über `git log -1 -- docs/capabilities-integration-report.md` bestimmbar; er wird im Abschluss genannt.

## Ergebnis und belastbare Grenzen

Die bestehende Brain-Verarbeitung besitzt jetzt eine selektive, versionierte Capability-Registry mit 4253 Einträgen: 28 Repositories, 410 Skill-Dateien und 3564 Referenzdateien sowie offizielle Referenzen, Kategorien und lokale Werkzeugadapter. Das ist ein vollständiger Metadatenindex der aufgenommenen Bäume, kein geprüfter Vollimport aller Inhalte und keine Installation ihrer Programme. Vier ausgewählte MIT-Regelwerke sind nach Inhaltsprüfung lokal als nicht ausführbare Referenzdaten eingebunden; ein Expo-Regelwerk bleibt in Quarantäne. Weitere Inhalte werden ausschließlich gezielt zur Benutzerprüfung von einem festgehaltenen Commit geladen.

Die bestehende Bibliotheksseite wird erweitert. Der vorhandene Brain-Antwortpfad wählt bei passenden Entwicklungsaufgaben Fachbereich, Rollenplan und begrenzte freigegebene Referenzdaten. Der produktive Wissensmodus bleibt erhalten; hier werden nachvollziehbare Arbeitspläne und Referenzen geliefert, keine ausgeführten Programme behauptet. Die vorhandene optionale Modellverbindung bekommt dieselben begrenzten Daten als Benutzerkontext, niemals als übergeordnete Systemanweisung. Ein lokales Modell wurde nicht installiert oder gestartet.

**Teilweise vorbereitet bleiben native Builds, vollständige Geräte-/Desktopsteuerung und allgemeine Medienproduktion.** Die kleinen Quellstarter sind keine vollständigen gebauten App-Projekte. Rollenpläne sind überprüfbare Aufgabenmetadaten, keine dauerhaft laufenden oder automatisch ausführenden Unteragenten. Manuell eingetragene Artefakte sind ausdrücklich unbestätigte Berichte.

## 0 – Ausgangsarchitektur und Bestand

Gezielt untersucht und weiterverwendet: `index.js` (Routenregistrierung), `brain-chat/service.js` (Wissensabruf, System-/Benutzerkontext, bestehender Generator), `brain-chat/model.js` und `local-model.js` (bestehende zentrale Modellverbindung), Sprach-/Stilmodule, `brain-knowledge` (Repository, Metadaten, Schreibfreigabe), `prompts-library` und bestehende Agent-Bibliotheksnutzung, Dashboard-Proxy und `Brain/prompt-library.*`. Deployment-/Paketkonfiguration wird nicht verändert. Bestehender Docker-Runtime-Stand Node 22/Python 3.12 bleibt unberührt; lokale Tests liefen auf Node 24.19.0.

Die neue Arbeit liegt in eigenem Worktree/Branch. Organisation, Trading, Marktanalyse, Nachrichten, Kalender, E-Mail und Migrationen werden nicht geändert. Die neuen optionalen Metadaten nutzen die vorhandene Repository-Schnittstelle ohne Schemaanpassung. Kein vorhandener Inhalt wird überschrieben oder gelöscht.

## 1 – Registry, Suche und sichere Übernahme

- `brain-capabilities/registry.js`: kategorisierte Suche nach Text, Technologie/Sprache, Plattform, Kosten, Lizenz, Status; Pagination, Versionsmetadaten, gezieltes Laden. Suche ist deterministische Wortsuche, keine garantierte semantische Bewertung.
- `data/catalog.json`: vollständige Einzelinventur mit Quelle, Commit, Lizenz, Anforderungen und Status. `data/sources.json`: gelesene Dateien, ausgewählte Abhängigkeiten und Inspektionsgrenzen. `data/requested-sources.json`: alle ursprünglich geforderten Quellen. `data/coverage.json`: jede angeforderte Fähigkeit, ohne stilles Entfernen.
- Referenzabruf ausschließlich über freigegebene, gepinnte GitHub-Raw-Pfade; keine Weiterleitungen, 12 Sekunden Timeout, 256 KiB Begrenzung, begrenzter Cache. Nur Vorschau; Kürzung wird angezeigt. Keine wiederholten Vollimporte in den Systemprompt.
- Neu vorgeschlagene Inhalte durchlaufen Hash, Herkunft, Lizenzangabe, heuristische Sicherheitsprüfung, Quarantäne und ausdrücklichen Review. Aktivierung erteilt keine Ausführungsberechtigung. Gleiche Familie besitzt einen aktiven Versionsindex; erneute Freigabe einer früheren Version ermöglicht Rücknahme.
- Erkannt werden Instruktionsüberschreibung, Geheimniszugriffe, Installations-/Privilegienhinweise und unsichtbare Steuerzeichen. Das ersetzt keine manuelle Prüfung und ist keine Sicherheitszertifizierung.

### Tatsächlich übernommene Regelwerke

| tzzs/apple-design-skill / SKILL.md | reviewed-reference-data | MIT | [Quelle](https://github.com/tzzs/apple-design-skill/blob/0387580473df697d1de037987f7ca94c9564cf72/SKILL.md) |
| AvdLee/SwiftUI-Agent-Skill / skills/swiftui-expert-skill/SKILL.md | reviewed-reference-data | MIT | [Quelle](https://github.com/AvdLee/SwiftUI-Agent-Skill/blob/204dba7c67256a8b707ee3fbc5759a824191974f/skills/swiftui-expert-skill/SKILL.md) |
| GuillemRoca/agent-skills-android / skills/android-architecture/SKILL.md | reviewed-reference-data | MIT | [Quelle](https://github.com/GuillemRoca/agent-skills-android/blob/68fd141eec5ad2029ae8393e510dbe46dea48c36/skills/android-architecture/SKILL.md) |
| expo/skills / plugins/expo/skills/expo-native-ui/SKILL.md | quarantine | MIT | [Quelle](https://github.com/expo/skills/blob/d5caf7fdf8b4854351f05841a7e315ac87ad7d24/plugins/expo/skills/expo-native-ui/SKILL.md) |
| addyosmani/web-quality-skills / skills/accessibility/SKILL.md | reviewed-reference-data | MIT | [Quelle](https://github.com/addyosmani/web-quality-skills/blob/afa8da942115f2961fdbfa80807ea0b232ff6c00/skills/accessibility/SKILL.md) |

Die vier freigegebenen Texte liegen mit SHA-256 und Original-Lizenzen unter `brain-capabilities/skills/reviewed` und `licenses`. Ein eng begrenztes .gitattributes stabilisiert die Hash-geprüften Referenzbytes auch bei Windows-Checkouts. Je Antwort werden höchstens 3000 Zeichen selektiv als fremde Referenzdaten verwendet. Andere upstream-Dateien sind nicht automatisch für den Agenten freigegeben. Expo enthält unter anderem einen externen Feedback-Aufruf über npx; außerdem markiert die konservative Prüfung process.env.EXPO_OS als Verdachtsfall. Keine dieser Anweisungen wurde ausgeführt.

## 2–9 – Fachbereiche und Werkzeuge

| Phase | Tatsächlich integriert/geprüft | Vorbereitet oder konkret begrenzt |
|---|---|---|
| 2 Apple | Apple Design und SwiftUI Expert, sämtliche gefundenen Referenzpfade, lokale selektive Regeltexte; SwiftUI-Starter und Buildpfad | Community-Projekte, keine Apple-Repositories. [Apple HIG](https://developer.apple.com/design/human-interface-guidelines/) und [SwiftUI](https://developer.apple.com/documentation/swiftui/) maßgeblich. Xcode, Simulator, Instruments, XCTest, Signierung und Store-Veröffentlichung erfordern macOS/Xcode und ggf. Konto; auf Windows nicht gebaut. |
| 3 Android | Alle sechs angeforderten Repositories, offizielle CLI-Referenz, Compose/Tests/Architektur-Metadaten, geprüftes Architekturregelwerk, Kotlin-Starter; tatsächliche ADB-Versionsabfrage | Gradle-Aufruf endet mit fehlender Runtime; kein SDK-/Emulator-/APK-/AAB-Nachweis. Android-MCP benötigt Python >=3.13 und passt nicht unverändert zur bisherigen Python-3.12-Produktionsruntime. Kein Gerätezugriff oder neuer Server. |
| 4 Cross-Platform | Expo/Flutter/React Native, Router/EAS/Device-Metadaten; Routing und Quellstarter geprüft | Keine Stackmigration, kein EAS-Aufruf, kein SDK-/Dependency-Install, kein vollständiger Cross-Build. Flutter bleibt auffindbar. Expo-Rohskill nicht automatisch freigeschaltet. |
| 5 Web/E-Commerce | Next/React/Vue/Nuxt/Angular/Astro/WordPress/Shopify und weitere angeforderte Kategorien; Nuxt UI Skills durch offizielle Doku bestätigt; individuelle Web-Studie erstellt und im Browser bedient | Keine Shopkonten, Zahlungen, Käufe oder CMS-Änderungen. Plattform-/Plugin-/Datenlizenzen separat. Kein pauschales Freigeben fremder Pakete. |
| 6 Creative | Creative-Director-Plan, Design-/Accessibility-Quellen, projektbezogener Präferenzvorschlag über vorhandenen Reviewweg; Original-Webdesign mit Desktop-/Mobilnachweis | Keine automatische Annahme persönlicher Vorlieben; bestehende Wissensschreibsperre wird respektiert. Figma-Quelle ist ein Leitfaden, kein installierter Server; Konto/Rechte/API-Limits offen. |
| 7 Sprachen/Architektur | Alle verlangten Sprachen und Querschnittsthemen als erweiterbare Kategorie/Referenzen, sprachbezogene Filter und deterministisches Routing | Kein Compiler-/Fachverständnisnachweis für jede Sprache allein durch Registrierung. Keine zusätzlichen Modelle. |
| 8 Medien | Einheitliche lokale Adapterliste, FFmpeg-Version und echter 1-Sekunden-VP9/WebM-Export aus synthetischem Bild sowie Decodierung; begrenzte feste Argumente | Installierter FFmpeg-Build unterstützt lavfi/MPEG4-Test nicht. Allgemeine Timeline, Audio, Untertitel, Transkription und 3D nur vorbereitete Adapter. ComfyUI/GIMP/Blender/ImageMagick ohne nachgewiesene Runtime/Gewichte/GPU. DaVinci ist ausgeschlossen. |
| 9 Automation | Lokaler Browseradapter mit isoliertem Profil, Loopback-URL, kontrolliertem DOM-Lesen tatsächlich ausgeführt; vorhandenes Browserwerkzeug für Formulare/Screenshots/responsives UI verwendet; freigegebener Quelldateischreiber praktisch geprüft | Vollständige Netzwerk-/Konsolen-/Accessibility-/Device-/Desktop-MCP-Anbindung nicht installiert/gestartet. Bestehende autorisierte Verbindungen können später verbunden werden. Keine fremde Browsersitzung übernommen. |

Die Fachbegriffe der Phasen bleiben vollständig in [coverage.json](../brain-capabilities/data/coverage.json) auffindbar. Registrierung bedeutet Wissens-/Planungsabdeckung, nicht automatische operative Vollausführung.

## 10 – Hauptbrain, Rollen und Arbeitsablauf

`planTask` erstellt Fachrollen und Übergaben mit Abhängigkeiten, Artefakten, maximal zwei Versuchen, Abbruch und kontrollierten Freigaben. Zusätzliche Creative-/Media-/Deployment-Rollen werden bedarfsabhängig gewählt. Alle verlangten Rollen sind im Inventar erhalten. Das vorhandene zentrale Modell bleibt die einzige optionale Generierung; derzeit sind keine eigenständigen Modellarbeiter aktiv. Kein Modellaufruf wurde für diese Abnahme benötigt.

`state.js` speichert Ablaufstatus in bestehenden privaten Repository-Metadaten. Revisionsprüfung verhindert verlorene parallele Änderungen; Vorgänger müssen abgeschlossen sein. Ein manueller Prüfeintrag trägt verified:false und löst keine Befehle aus. Eigenständige automatische Ausführung mehrstufiger Agentenjobs ist damit noch nicht behauptet oder aktiviert.

Der lokale Werkzeugweg in `tools.js`/`scripts/brain-capabilities.mjs` ist von der gehosteten API getrennt. Railway/Vercel-Ausführung wird abgelehnt. Prozesse laufen ohne Shell mit festen Argumenten, Zeit-/Ausgabegrenzen und Abbruchsignal. Schreib- und Browseroperationen benötigen den Fingerprint des genauen Auftrags. Pfade müssen real innerhalb des freigegebenen Arbeitsbereichs liegen; Quelldateien werden nur neu angelegt, nicht überschrieben. Das ermöglicht individuelle Artefakte, statt ein Standardlayout für jedes Projekt zu erzwingen.

## 11 – Erweiterbarkeit und 12 – Dashboard

Kandidatenaufnahme, Review, aktiver Versionsindex und Rücknahme sind implementiert. Herkunftsprüfung und Sicherheitswarnungen sind sichtbar; externe Installationen, Kontoverbindungen und Publikationen werden dadurch nicht genehmigt. Automatische Webrecherche/Quellvollprüfung ist kein neuer Hintergrunddienst; Kandidaten können über vorhandene Recherchefähigkeiten gefunden und kontrolliert eingereicht werden.

Die vorhandene Seite `/Brain/prompt-library` erhält eine Capability-Sektion mit Such-/Bereichs-/Plattform-/Lizenz-/Kosten-/Status-/Sprachfiltern, Details, Voraussetzungen, Version, letzter Prüfung, Textvorschau und Workflow-/Reviewfunktionen. prompts.chat-Suche und bestehende Navigation bleiben erhalten. Desktop 1536×900 und Mobil 390×844 wurden lokal mit bestehender Authentifizierung bedient. Kein horizontaler Überlauf. Erfolgreicher gepinnter SwiftUI-Referenzabruf: 6073 Zeichen als Text. Externe Inhalte werden mit textContent dargestellt.

## 13 – konkrete Praxisabnahme

[Maschinenlesbarer Nachweis](capability-evidence/verification.json) enthält Routingergebnisse und Laufzeitgrenzen. [Artefakte](capability-evidence/) enthalten ausschließlich synthetische lokale Testinhalte.

1. Android-Fähigkeit gesucht, Architekturregelwerk und Kotlin-Quelldatei/Buildpfad vorbereitet; ADB-Version tatsächlich geprüft. Kein Build/Emulator verfügbar nachgewiesen.
2. SwiftUI-Fähigkeit gesucht, gepinnte Referenz im Browser geladen, SwiftUI-Quelldatei/Buildpfad vorbereitet. Kein iOS-Build auf Windows.
3. Eigenständige Meridian-Webstudie erstellt, Syntax geprüft, im Browser Desktop/Mobil visuell geprüft und Lichtwechsel bedient. Kein verpflichtendes Standardtemplate für Brain-Aufträge.
4. Expo-/Flutter-Routing und Referenzen aufgerufen; Quellstarter erzeugt. Fehlende Projekt-/SDK-Buildstufen ausgewiesen.
5. Videoaufgabe korrekt zur Medienrolle geroutet (Fehler Export/Expo behoben). Echter VP9/WebM-Export 19.474 Bytes und Decodierung erfolgreich.
6. Aufgabenplan erstellt, gestartet, manueller Artefaktbericht erfasst, Abbruch über die echte lokale Bibliotheksoberfläche geprüft.
7. Installationsanweisung bleibt quarantänisiert; API kennt keinen execute/install/publish-Vorgang. Quelltext wird nicht ausgeführt.
8. 80/80 gezielte Tests, 0 Fehler, 0 übersprungen. Bestehender Chat, vier Sprachprofile, passiver Stilbeobachter, Bibliotheksagent, Lernsystem, Organisation, Marktanalyse-Authentifizierung und prompts.chat geprüft. Keine Live-Orders/echten E-Mails. Trading wird durch unveränderten Quellstand geschützt, kein vollständiger Trading-Produktionsfunktionstest behauptet.

Testaufruf: node --test test/brain-capabilities.test.js test/brain-chat.test.js test/brain-language.test.js test/brain-style-observer.test.js test/brain-library-agent.test.js test/brain-learning.test.js test/organisation.test.js test/market-analysis-auth.test.js test/prompts-library.test.js. Dazu Syntax- und Git-Diffprüfung. Bestehende Lockfile-Abhängigkeiten isoliert mit npm ci --ignore-scripts installiert; keine neuen Paketabhängigkeiten, keine Installationsskripte.

## Vollständige Quelleninventur

Alle 28 Bäume wurden auf festgehaltene Commits indexiert. README/Lizenz/Paketmetadaten und ausgewählte Skill-Texte tatsächlich gelesen; genaue Dateien stehen im sources.json. **Kein vollständiges Codeaudit sämtlicher upstream-Skripte und keine Abhängigkeitszertifizierung.** Referenzzahlen in der Tabelle werden aus den Manifesten abgeleitet; verbindliche Einzeldateiliste ist catalog.json.

| Repository | Festgehaltener Commit | Lizenzbefund | Skills | Referenzen | Runtime-/Nutzungsgrenze |
|---|---|---|---:|---:|---|
| [skydoves/android-testing-skills](https://github.com/skydoves/android-testing-skills) | `8665ed59643c90eb1056a256a6ddec161aa1cfa1` | Apache-2.0 | 54 | 0 | Markdown/reference metadata; no independent runtime installed; Executing recommendations requires separately reviewed SDK/tools |
| [android/skills](https://github.com/android/skills) | `4ebabf2b0fd6c04b7150023c8b612f80592a6226` | Apache-2.0 | 33 | 285 | Markdown/reference metadata; no independent runtime installed; Executing recommendations requires separately reviewed SDK/tools |
| [GuillemRoca/agent-skills-android](https://github.com/GuillemRoca/agent-skills-android) | `68fd141eec5ad2029ae8393e510dbe46dea48c36` | MIT | 30 | 1 | Markdown/reference metadata; no independent runtime installed; Executing recommendations requires separately reviewed SDK/tools |
| [chrisbanes/skills](https://github.com/chrisbanes/skills) | `183cfc9bf112d7a27488e80f6e445e9556644866` | Apache-2.0 | 19 | 71 | Node.js engine not declared in inspected package; Dependencies in inspected package.json; no upstream installation |
| [CursorTouch/Android-MCP](https://github.com/CursorTouch/Android-MCP) | `35759d88561946b962275ed193fd1c6e322ab4a9` | MIT | 0 | 0 | Python >=3.13; Dependencies in inspected pyproject.toml; no installation |
| [new-silvermoon/awesome-android-agent-skills](https://github.com/new-silvermoon/awesome-android-agent-skills) | `82900eacc8dbe13de93c6310af27b9df4b2bd2f6` | Apache-2.0 | 17 | 0 | Markdown/reference metadata; no independent runtime installed; Executing recommendations requires separately reviewed SDK/tools |
| [flutter/agent-plugins](https://github.com/flutter/agent-plugins) | `f813a46b18456a20f37eb5784c091b7d945c3b4b` | BSD-review | 31 | 12 | Markdown/reference metadata; no independent runtime installed; Executing recommendations requires separately reviewed SDK/tools |
| [expo/skills](https://github.com/expo/skills) | `d5caf7fdf8b4854351f05841a7e315ac87ad7d24` | MIT | 25 | 95 | Node.js engine not declared in inspected package; Dependencies in inspected package.json; no upstream installation |
| [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) | `294f403f2fe94ae86fc086181ebc1c1ec5b5c990` | Apache-2.0 | 1 | 0 | Node.js >=20; Dependencies in inspected package.json; no upstream installation |
| [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) | `063bee94c3f4df8453406c830b0a7df0f2860278` | unverified | 9 | 202 | Node.js engine not declared in inspected package; Dependencies in inspected package.json; no upstream installation |
| [callstack/agent-device](https://github.com/callstack/agent-device) | `5b61e8a9ad3d16d34c4462ca6749937571b54c88` | MIT | 4 | 0 | Node.js >=22.12; Dependencies in inspected package.json; no upstream installation |
| [addyosmani/web-quality-skills](https://github.com/addyosmani/web-quality-skills) | `afa8da942115f2961fdbfa80807ea0b232ff6c00` | MIT | 6 | 9 | Markdown/reference metadata; no independent runtime installed; Executing recommendations requires separately reviewed SDK/tools |
| [vercel/next.js](https://github.com/vercel/next.js) | `502b6b7daf220f4516eb2d8b7e750ce6874ac201` | MIT | 27 | 21 | Node.js >=20.9.0; Dependencies in inspected package.json; no upstream installation |
| [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | `6743a347db6229848348024388033e830ae4af42` | Apache-2.0 | 26 | 1079 | Node.js >=18.19.0; Dependencies in inspected package.json; no upstream installation |
| [GoogleChrome/modern-web-guidance](https://github.com/GoogleChrome/modern-web-guidance) | `65e7edd67e77420eaf02c5df00fdc0521417d809` | Apache-2.0 | 2 | 215 | Node.js >=20.0.0; Dependencies in inspected package.json; no upstream installation |
| [WordPress/agent-skills](https://github.com/WordPress/agent-skills) | `eff3785fc28c4380d172094518c66a6a997c95d4` | GPL-review | 19 | 88 | Markdown/reference metadata; no independent runtime installed; Executing recommendations requires separately reviewed SDK/tools |
| [shadcn-ui/ui](https://github.com/shadcn-ui/ui) | `8f04138777c1b6996e709993362a7b0a12888ecf` | MIT | 2 | 23 | Node.js engine not declared in inspected package; Dependencies in inspected package.json; no upstream installation |
| [Shopify/agent-skills](https://github.com/Shopify/agent-skills) | `6b9ed0552d5116ee33d0e211dfa6681f2f5bdffe` | unverified | 30 | 1032 | Markdown/reference metadata; no independent runtime installed; Executing recommendations requires separately reviewed SDK/tools |
| [antfu/skills](https://github.com/antfu/skills) | `8886fe2d385d3644cbb47e46ae9cb1cf09307d3b` | MIT | 12 | 142 | Node.js engine not declared in inspected package; Dependencies in inspected package.json; no upstream installation |
| [figma/mcp-server-guide](https://github.com/figma/mcp-server-guide) | `056adaf7564d3dc5fa2e1c7828bbec925d5fa6bb` | unverified | 32 | 153 | Documentation guide, not an executable MCP server; Figma authorization, actual server and API terms separately required |
| [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp) | `0c4107acbecb75472b23c05c0e42471a0011874f` | Apache-2.0 | 0 | 0 | Node.js >=18; Dependencies in inspected package.json; no upstream installation |
| [withastro/astro](https://github.com/withastro/astro) | `c3185b764e14f50664b0e63ec665804fdecf685e` | MIT | 10 | 19 | Node.js >=22.23.4; Dependencies in inspected package.json; no upstream installation |
| [angular/angular](https://github.com/angular/angular) | `6d32550fbbae49851a680b3dc1281d8b899352e7` | MIT | 7 | 46 | Node.js engine not declared in inspected package; Dependencies in inspected package.json; no upstream installation |
| [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | `2a54e28eebb8537dc60af667dbe98e58df9a49e5` | Apache-2.0 | 7 | 7 | Node.js ^20.19.0 || ^22.12.0 || >=23; Dependencies in inspected package.json; no upstream installation |
| [googlechrome/lighthouse](https://github.com/googlechrome/lighthouse) | `1a4ffa418258919adbbf6ccca548c02e0092bafd` | Apache-2.0 | 3 | 0 | Node.js >=22.19; Dependencies in inspected package.json; no upstream installation |
| [tzzs/apple-design-skill](https://github.com/tzzs/apple-design-skill) | `0387580473df697d1de037987f7ca94c9564cf72` | MIT | 1 | 15 | Markdown/reference metadata; no independent runtime installed; Executing recommendations requires separately reviewed SDK/tools |
| [AvdLee/SwiftUI-Agent-Skill](https://github.com/AvdLee/SwiftUI-Agent-Skill) | `204dba7c67256a8b707ee3fbc5759a824191974f` | MIT | 2 | 35 | Node.js engine not declared in inspected package; Dependencies in inspected package.json; no upstream installation |
| [nuxt/ui](https://github.com/nuxt/ui) | `832f1580496eb435f4b3426032fd7adbec0f3d6e` | MIT | 1 | 14 | Node.js ^20.19.0 || >=22.12.0; Dependencies in inspected package.json; no upstream installation |

Original-Lizenztexte werden, soweit gefunden, unter `brain-capabilities/licenses` erhalten. Drei Quellen ohne verifizierte Root-Lizenz (vercel-labs/agent-skills, Shopify/agent-skills, figma/mcp-server-guide) bleiben Metadaten/Verweise; keine pauschale Codeübernahme. GPL-/BSD- und Datei-/Drittmaterialbedingungen sind bei späterer tatsächlicher Nutzung gesondert einzuhalten. Keine Nutzungsrechte für fremde Bilder, Modelle, Shops oder Daten durch diesen Index behauptet.

### Offizielle Referenzen und Abrufgrenzen

Offizielle Referenzen pro Technologie stehen als Einzelobjekte im Katalog. 67 unterschiedliche Referenz-URLs wurden zusätzlich per HTTP geprüft: 63 antworteten mit 200; prompts.chat MCP-GET mit 405 ist bei POST-Schnittstelle kein Ausfall. Ein alter ImageMagick-Usage-Link mit 404 wurde durch die offizielle Homepage ersetzt; deren erneuter Abruf ist nicht nachgewiesen. Zwei FFmpeg-Dokumentationsabrufe waren im lokalen Netzwerk blockiert; der lokale FFmpeg-Lauf ist davon unabhängig nachgewiesen. Apple-Dokumentation ist teilweise JavaScript-basiert; Index/Primärlinks ersetzen keinen vollständigen Dokumentationsmirror. Die mitgeteilten Apple-Quellen sind vollständig als Quellen und gefundene Referenzpfade aufgenommen, nicht als offizielles Apple-Material bezeichnet.

## Kosten, Datenschutz, Bestand und Release

Keine bezahlten APIs, Konten, Modellgewichte, zusätzlichen Dienste, Migrationen oder Veröffentlichungen aktiviert. Scanner/Registry/Planung benötigen keine Modell-Tokens; lokale Rechenleistung, Hosting und Speicher sind dennoch nicht generell kostenlos. Spätere native Signierung/Stores, EAS, Commerce, Figma, Cloud-Browser oder Modelle können Rechte/Kosten erfordern und bleiben freigabepflichtig.

Keine privaten Chat-/Projekttexte werden an Quellen übertragen. Nur öffentliche, feste Quellpfade werden auf ausdrücklichen Vorschauabruf geladen. Normale Gespräche und vorhandene Wissens-/Organisations-/Trading-/Marktanalysefragen behalten Vorrang und starten keine neue Capability-Suche. Schreibfreigaben, Authentifizierung und Benutzergrenzen werden weiterverwendet.

Geänderte Bestandsdateien ausschließlich: `index.js`, `brain-chat/service.js`, `api/dashboard/marcel-brain.js`, `Brain/prompt-library.html`, `Brain/prompt-library.css`. Neue Dateien: `brain-capabilities/**`, `Brain/capabilities.js`, `scripts/brain-capabilities.mjs`, `test/brain-capabilities.test.js` sowie dieser Bericht und synthetische Nachweise. Paketdateien, produktive Konfiguration, bestehende Kernmodule und Migrationen bleiben unverändert.

Release nur lokal. Vor einer Veröffentlichung ist gesonderte Deploymentfreigabe nötig. Rücknahme: vorherigen Commit veröffentlichen und Capability-Verknüpfung entfernen; keine Schema-Rückmigration/kein Löschen bestehender Daten erforderlich. Optionale neue Metadaten können ungenutzt bestehen bleiben. Nicht vorhandene SDKs, macOS, Geräte, genehmigte Modellgewichte oder Kontozugriffe dürfen nicht durch eine Freigabe des Web-Releases als vorhanden gelten.
