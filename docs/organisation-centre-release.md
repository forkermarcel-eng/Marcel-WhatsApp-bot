# Organisationszentrale – isolierter Release, 24.10.2026

Basis: `5bb47db49fff1c61297ffdb2cfdb50410cc0002d`. Nicht veröffentlicht.
Keine Migration, Provideraktivierung oder Änderung an Trading,
Marktanalyse, Nachrichten, Wetter oder Finanzen.

## Bestand und tatsächliche Bedienbarkeit

| Bereich | Vorhanden | Ergänzt / verbleibende Grenze |
|---|---|---|
| E-Mail | Parser ausdrücklich ausgewählter Versandmails; lesender Providervertrag | IMAP-/SMTP-Adapter ergänzt: Posteingang/Lesen/Gesendet, Suche unter den letzten 50 Nachrichten, private persistente Entwürfe, Schreiben und einzeln bestätigter Versand. **Produktiv fehlt das autorisierte Konto; dort bleibt der Client gesperrt.** Kein automatischer Versand. Kein OAuth-Registrierungsassistent, keine Anhänge oder HTML-Vorschau. |
| Kalender | Echter iCloud-CalDAV-Adapter, Allowlist, ETags, CRUD, Versandtermin-Opt-in | Tages-/Wochen-/Monatsdarstellung; ganztägige und zeitgebundene Termine erstellen/bearbeiten. Serien und Erinnerungen verbleiben im Kalenderclient. Freigegebenes Löschen bleibt mit Einzelbestätigung erhalten. |
| Dokumente/Post | Bestehendes Dokumentenwissen und dessen Quellen | Private Textvorgänge mit Ablage/Status/Suche; Quellenliste und lesende Anzeige importierter Textauszüge. Kein Binärdatei-Upload oder Originaldatei-Viewer. Keine Originaldatei wird verändert. |
| Sendungen | DHL-Adapter, Verlauf/Backoff/Retention, sechs manuell erfassbare Dienste, Versandmailvorschau | Bestehende Bedienung in eigener Sektion zugänglich. Hermes/DPD/GLS/UPS/Amazon Logistics haben weiterhin keine automatische Trackinganbindung. |
| Navigation | Bestehende Brain-Navigation und geschützte Organisationsseite | Link „Organisation“; vier direkt erreichbare Bereiche und mobile Gestaltung. |

Produktionsprüfung ausschließlich lesend: Railway `SUCCESS`, Commit `5bb47db`;
Organisationsübersicht HTTP 200; iCloud, DHL und Mail jeweils nicht konfiguriert.
Es wurden keine privaten Inhalte für Tests verwendet und keine Anbieter abgefragt.

## Speicherung und Sicherheit

Entwürfe und Postvorgänge liegen als versionierte Datensätze mit Präfix
`owner-desk-{draft|document}-` in der **bestehenden** `settings`-Sammlung von
`marcel_organisation.items`. Bestehende Datensätze werden nicht umgeschrieben.
Änderungen verlangen passende Versionen; fremde IDs und Sammlungstypen werden
abgewiesen. Export/Restore verwendet weiterhin den bestehenden privaten Export.

Die Anwendung besitzt weiterhin genau einen konfigurierten Dashboard-Eigentümer.
Die bestehenden Session- und Backend-Bearer-Prüfungen schützen alle Operationen;
keine vom Browser wählbare Benutzeridentität, keine öffentliche neue API.
Das ist keine neue Mehrbenutzerverwaltung. Bei späterer Einführung mehrerer
Konten muss deren Mandantentrennung gesondert umgesetzt werden.

Dokumentauszüge verwenden ausschließlich bekannte Dokument-IDs im bestehenden
Wissensspeicher; kein Zugriff auf vom Client übergebene Dateipfade. Externe
Inhalte werden als Text dargestellt. Schreiben erfolgt ausschließlich durch
das Absenden des jeweiligen Formulars. Kein Lösch-Endpunkt für Post/Entwürfe.

## Gezielte Prüfung

* `node --test test/organisation.test.js test/organisation-desk.test.js test/organisation-mailbox.test.js test/brain-knowledge.test.js`: **30/30 bestanden**. PGlite/SQLite ausschließlich lokal, synthetische Daten. Bestehende Migration nur in isolierter leerer Testdatenbank verwendet.
* `node --test test/web-ui-navigation.test.js`: **7/7 bestanden**.
* Syntaxprüfung der neuen JavaScript-Dateien und `git diff --check`: bestanden.
* Lokaler Browser mit echtem Loginhandler, Sessionprüfung, Dashboard-Proxy und Organisationsroute: Entwurf speichern/wiederöffnen/suchen/bearbeiten; Textvorgang erfassen; sichere Textdarstellung; Archivliste und Auszüge; ganztägige und zeitgebundene Kalendertermine anlegen/bearbeiten; Tages-/Wochen-/Monatswechsel (7/31 Tage nachgewiesen); Sendung erfassen; gesperrter DHL-Abruf.
* Desktop und 390-Pixel-Layout im Browser visuell geprüft; Navigation zwischen Bereichen funktioniert. Kein Test auf einem physischen Smartphone.
* CalDAV/DHL-Tests verwenden isolierte HTTP-/Provider-Fixtures. **Keine erfolgreiche Verbindung zu echten externen Konten behauptet.**
* Mailadaptertests: TLS/Zertifikatsprüfung, IMAP read-only/PEEK, UIDVALIDITY, begrenzte Nachrichtenmenge, kein Datei-/URL-Zugriff im SMTP-Transport, ausdrückliche Versandfreigabe, persistenter Schutz vor Doppelversand einschließlich unklarem SMTP-Ergebnis. Lokaler HTTP-Test über echte Login-/Proxy-/Organisationsroute: Entwurf 200, Versand ohne Bestätigung blockiert (Proxy 502, Backend 403), bestätigter Fixture-Versand 200, Wiederholung 409. Keine echte E-Mail versendet.
* Browser mit lokalem Mailprovider: Posteingang, Nachrichtenlesen und Verfassen sichtbar. **Abschließende Prüfung der neuen HTML-Versandbestätigung noch offen:** Der vorherige native `confirm()` blockiert Browseraktionen; die Browserwerkzeuge erkennen/entfernen dessen Dialog nicht. Die neue Implementierung benutzt stattdessen einen zugänglichen HTML-Dialog. Dessen Bedienung und finale mobile Prüfung nach dieser letzten Änderung dürfen nicht als bestanden gelten. Release bis zu dieser Prüfung nicht vollständig abgenommen.

## Mailkonfiguration und Abhängigkeiten

Der Adapter verbindet sich nur auf Benutzerabruf und bei
`ORGANISATION_MAIL_APPROVED=true`. Er benötigt ausschließlich als Server-Secrets:
`ORGANISATION_MAIL_IMAP_HOST`, `ORGANISATION_MAIL_USERNAME`,
`ORGANISATION_MAIL_APP_PASSWORD`. IMAP: TLS/993 mit Zertifikatsprüfung.
SMTP benötigt zusätzlich `ORGANISATION_MAIL_SEND_APPROVED=true`,
`ORGANISATION_MAIL_SMTP_HOST`, `ORGANISATION_MAIL_FROM`; TLS/465.
`ORGANISATION_MAIL_SENT_FOLDER` benennt optional den tatsächlichen Gesendet-Ordner.
Keine automatische Kontoeinrichtung oder Übernahme der iCloud-Secrets.
Anbieter, die ausschließlich OAuth anbieten, benötigen einen gesonderten Adapter.

Versandbelege liegen mit Präfix `owner-mail-send-` ebenfalls in der vorhandenen
settings-Sammlung. Ein ausstehender/unklarer Versand wird niemals automatisch
wiederholt. SMTP-Annahme ist kein Zustellnachweis. Der SMTP-Server muss für
einen Eintrag im externen Gesendet-Ordner sorgen; lokale Übergabebelege bleiben
unabhängig davon sichtbar. Der Client kopiert keine Mails automatisch auf IMAP.

Exakt gepinnte zusätzliche MIT-Bibliotheken: `imapflow@2.9.1`,
`nodemailer@10.2.1`, `mailparser@3.12.4`; Lizenzdateien der installierten Pakete
gelesen. Technische Grundlage: [ImapFlow](https://imapflow.com/docs/guides/fetching-messages/)
und [Nodemailer SMTP](https://nodemailer.com/smtp).
`npm audit --omit=dev`: keine Meldung für diese drei Pakete; zwei hohe Meldungen
für bereits unverändert vorhandene `body-parser@2.3.0` und `undici@7.30.0`.
Keine allgemeinen Dependency-Upgrades im Organisationsauftrag vorgenommen.

## Release und Rückfall

Nach ausdrücklicher Deploymentfreigabe exakt diesen Commit über den bestehenden
Railway-/Vercel-Releaseweg veröffentlichen, ohne Migration oder Aktivierung
externer Konten/Worker. Danach authentifizierte Oberfläche und bestehende
Organisation prüfen. Bei Fehlern vorherigen Release `5bb47db` wieder zuweisen;
neue private Einträge bleiben erhalten. Kein DROP, keine Löschung und kein
Überschreiben durch einen älteren Dump notwendig.

Konten werden getrennt eingerichtet: iCloud benötigt die bestehenden sicheren
Server-Secrets, erlaubte Kalender und explizite Schreibfreigabe; DHL den
freigegebenen API-Zugang. Details stehen in `docs/organisation-setup.md`.
Mailkonto und passendes freigegebenes Authentifizierungsverfahren sind noch festzulegen;
Zugangsdaten gehören weder in Chat noch Repository.
