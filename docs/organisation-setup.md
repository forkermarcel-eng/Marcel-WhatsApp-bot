# Persönliche Organisation: Einrichtung und Prüfgrenzen

Stand 20.10.2026. Der neue Bereich nutzt den bestehenden PostgreSQL-Pool und dieselbe Dashboard-Authentifizierung. Keine zweite KI, kein neuer externer Dienst, keine Änderung an Trading, Voice, Smart Home oder den bestehenden Designansichten.

## Implementierung

`brain-organisation/` enthält Repository, Provider-Adapter, Versandmailparser, Anwendungslogik und HTTP-Registrierung. `index.js` importiert und registriert nur das Modul. `Brain/organisation.html` ist eine kleine separate Bedienansicht; die bestehende Hauptnavigation bleibt unverändert. `api/dashboard/marcel-brain.js?resource=organisation` verwendet den bestehenden authentifizierten Proxy.

Die additive Migration `migrations/20261020_brain_organisation.sql` erstellt ausschließlich `marcel_organisation.items` mit den Sammlungen shipment, audit, settings und mail_seen. Keine bestehenden Tabellen werden geändert. Parameterisierte SQL-Abfragen und ein Transaktionslock verhindern konkurrierende Dubletten und Quotenüberschreitungen. Es gibt keine automatische Schemaänderung beim Serverstart.

## Apple / CalDAV

**Lokal funktionsfähig, echte Verbindung extern blockiert.** Implementiert: Kalenderermittlung, serverseitige Kalender-Allowlist, Zeitraum-/Titelsuche, Lesen, Erstellen, Ändern und gesondert freigegebenes Löschen. Ganztägige Daten behalten ihren Kalendertag; Uhrzeiten benötigen einen expliziten UTC-Offset. ETags schützen vor dem Überschreiben zwischenzeitlicher Änderungen. Stabile UIDs und bedingtes Anlegen verhindern doppelte Termine. Serienänderungen und Serienlöschungen werden ausdrücklich abgelehnt; dafür bleibt der Kalenderclient erforderlich.

Benötigte Server-Secrets nach ausdrücklicher Apple-Freigabe:

- `ORGANISATION_ICLOUD_APPROVED=true`
- `ORGANISATION_ICLOUD_USERNAME` und `ORGANISATION_ICLOUD_APP_PASSWORD`
- `ORGANISATION_CALENDAR_URLS`: JSON-Liste der kanonischen erlaubten CalDAV-Sammlungs-URLs
- Schreibzugriff separat: `ORGANISATION_CALENDAR_WRITE_APPROVED=true`
- Löschzugriff zusätzlich: `ORGANISATION_CALENDAR_DELETE_APPROVED=true`; jeder Löschaufruf benötigt auch eine konkrete Bestätigung.

Secrets ausschließlich in der vorhandenen Secret-Verwaltung hinterlegen, nie im Browser, Export, Git oder Log. Apple verlangt für app-spezifische Passwörter Zwei-Faktor-Authentifizierung. Ein separater Kalender reduziert **nicht** die technische Reichweite des Apple-Zugangs; die Anwendung erzwingt daher zusätzlich die Allowlist. Unterstützte Hosts sind ausschließlich die vorgesehenen HTTPS-iCloud-CalDAV-Hosts. Weiterleitungen mit Kalenderinhalten und fremde Hosts werden abgewiesen. Es wurde keine Apple-Anmeldung durchgeführt. Quelle: [Apple: app-spezifische Passwörter](https://support.apple.com/en-us/102654).

## DHL

**Adapter lokal funktionsfähig; echte Trackingverbindung extern blockiert.** Verwendet wird die offizielle Shipment Tracking Unified API: `https://api-eu.dhl.com/track/shipments`, Header `DHL-API-Key`. Registrierung und Freigabe für den konkreten Verwendungszweck sind erforderlich. Kein Demo-Schlüssel wird als echtes Tracking ausgegeben. Benötigt werden `ORGANISATION_DHL_APPROVED=true` und das Secret `ORGANISATION_DHL_API_KEY`.

Die dokumentierte anfängliche Quote beträgt 250 Aufrufe täglich und höchstens einen Aufruf je fünf Sekunden. Die Implementierung bleibt bei 200/Tag und mindestens 5,1 Sekunden Abstand, persistiert die Quote und prüft alle fünf Minuten höchstens eine fällige Sendung. Erfolgreiche Sendungen werden frühestens nach sechs Stunden erneut geprüft; Fehler führen zu exponentiellem Backoff mit Beachtung von Retry-After. Nach Zustellung enden regelmäßige Abrufe. Eine Statushistorie enthält nur tatsächliche Änderungen. Zustellprognosen sind optional und werden niemals erfunden. Zusätzliche Geschäftskundenfunktionen werden nicht unterstellt.

Trackingdaten dürfen nur für eigene beziehungsweise rechtmäßig autorisierte Sendungen genutzt werden; keine Werbung oder Weitervermarktung. Attribution: **Delivered by Deutsche Post DHL Group**. Neue DHL-Trackingdatensätze werden nach der Zustellung innerhalb der 30-Tage-Frist entfernt; bei unbekanntem Zustelltag vorsorglich sofort. Automatisch erstellte DHL-Kalenderkopien benötigen deshalb auch freigegebenen Löschzugriff. Wird dieser später entzogen, werden lokale Trackingdaten dennoch entfernt und ausschließlich UID/Kalenderadresse für die ausstehende externe Bereinigung aufbewahrt. Die Oberfläche zeigt diese ausstehende Bereinigung an; ohne wiederhergestellten Zugriff kann die fremde Kalenderkopie nicht entfernt werden. Private heruntergeladene Exporte/Sicherungen muss der Eigentümer entsprechend behandeln.

Quellen: [DHL API und Nutzungsbedingungen](https://developer.dhl.com/tracking), [DHL: derzeit kostenlose Unified API](https://support-developer.dhl.com/support/solutions/articles/47001249492-is-the-dhl-shipment-tracking-unified-api-free-of-charge-). Kostenfreiheit und individueller Tarif sind vor realer Aktivierung erneut zu prüfen; kein kostenpflichtiger Zugang wurde gebucht.

## Amazon, weitere Versanddienste und Mail

Geprüft wurden [Huskynarr/hacs-amazon-tracker](https://github.com/Huskynarr/hacs-amazon-tracker) und [brandon-claps/home-assistant-mail-and-packages](https://github.com/brandon-claps/home-assistant-mail-and-packages). Beide verwenden MIT-Lizenzen. Ersteres nutzt Home Assistant/Python und aioimaplib mit IMAP-IDLE sowie regionalen Amazon-Mailmustern einschließlich amazon.de. Das zweite Projekt ist ein größerer Home-Assistant-Mail-/Paketadapter mit versanddienstabhängigen Erkennungsmustern. Beide sind eng an Home Assistant gebunden. Eine vollständige zusätzliche Installation wäre für dieses Node-Projekt unverhältnismäßig. Deshalb wurde ein schlanker eigener Adapter für normalisierte ausgewählte Nachrichten erstellt; kein upstream-Code kopiert. Kein Amazon-Login, Cookie-Scraping, privater Bestellseitenzugriff oder vorausgesetzte Privatkunden-API.

Der Parser erkennt explizite Bestellnummern, bezeichnete Trackingnummern, DHL/Hermes/DPD/GLS/UPS/Amazon Logistics und eindeutig datierte Zustellprognosen in deutschen Versandmails. Relative Wochentage werden nicht geraten. Absender und Nachrichtentext bleiben unzuverlässige externe Daten: kein Ausführen von Anweisungen, keine LLM-Weiterleitung, kein externer Bildabruf, kein Speichern des Rohtexts als Gesprächswissen. Extrahierte Angaben bleiben prüfpflichtige Vorschläge. Absenderdomains allein beweisen keine Echtheit. Tests verwenden ausdrücklich synthetische Nachrichten, keine kopierten privaten Mails. Reale Formatvielfalt ist erst nach freigegebenen Beispielen überprüfbar.

Gemeinsame Sendungsidentität: normalisierter Versanddienst plus Trackingnummer. Eine Amazon- und eine DHL-Meldung derselben Sendung erzeugen keinen zweiten Datensatz. Eine Bestellnummer allein reicht nicht zur Paketzuordnung. Andere Dienste sind manuell verwaltbar; für sie existieren keine erfundenen Tracking-APIs.

`createSelectedMailAdapter` ist der vorbereitete Providervertrag: freigegebener Ordner, explizite Nachrichten-IDs, maximal 30 Nachrichten, lesend, TLS erforderlich, kein Markieren als gelesen. **Kein IMAP-Netzwerkclient und kein Postfach verbunden.** Später muss ein konkret freigegebener Anbieter `readOnlyMessages` implementieren und dessen Authentifizierung/TLS tatsächlich geprüft werden. Keine Antworten oder Weiterleitungen.

## Lieferkalender und Portabilität

Kalenderautomatik ist standardmäßig aus und benötigt ausdrückliches Opt-in sowie erlaubten Zielkalender. Bestätigte konkrete Prognosen erzeugen voraussichtliche ganztägige Termine mit stabiler Sendungs-UID. Änderungen verschieben denselben Termin. Entfällt die Prognose, wird ein vorhandener Termin als nicht mehr bestätigt abgesagt. Ohne Datum entsteht kein Termin. Zustellung ersetzt die Prognose nur bei vorhandenem tatsächlichem Zustelltag. Auditdatensätze protokollieren Änderungen ohne Zugangsdaten.

Übersicht und Kalenderabfrage liefern strukturierte Informationen zu offenen Sendungen, Zustellungen, Prognosen der nächsten sieben Tage und Terminen eines wählbaren Zeitraums. Ein späteres KI-Tool kann dieselbe Service-Schnittstelle verwenden; eine zusätzliche Voice- oder KI-Anbindung wurde nicht aktiviert.

`scripts/organisation-transfer.mjs`: `export --out PRIVATE.json`, `plan --file PRIVATE.json`, `restore --file PRIVATE.json --expected-database NAME --backup-proof PRIVATE.json --approve-write`. Exportdateien enthalten private Organisationsdaten, keine Provider-Secrets. Wiederherstellung verlangt explizite DATABASE_URL, Datenbankabgleich und einen geprüften Backup-/Restore-Nachweis, überschreibt keine abweichenden Datensätze und deaktiviert Kalenderautomatik. Keine bestehende Brain-Datenstruktur wird verändert. Der Organisations-Export ersetzt keinen vollständigen Produktionsdump samt externen Medien. Servermodule funktionieren auch auf einem lokalen Node-/PostgreSQL-Rechner ohne Railway/Vercel-spezifischen Provider.

## Verifikation

14 neue Tests: lokaler HTTP-CalDAV-Server mit CRUD/ETag/Allowlist/Dubletten, Zeitzonen und ICS-Injektion; synthetische DHL-Antworten, Identität/Backoff/Abfragestopp/Aufbewahrung; Versandmailparser und sechs Dienste; ausgewählte Mail-IDs; Export/Restore; PostgreSQL-kompatible Migration; Authentifizierung vor Datenzugriff. Keine echten Apple-/DHL-Ergebnisse werden dadurch behauptet.

Bestehendes `npm test`: 19 Testgruppen ohne Fehler. Lokaler Chrome mit eigener isolierter PostgreSQL-Testdatenbank: Hinzufügen/Deduplizieren, Mailvorschau/-import, Datumsbestätigung, gesperrte Providerbedienung, Export, keine JS-Fehler und kein horizontaler Überlauf bei 1440/390/320 Pixeln.

Frischer privater Produktionsdump (19.104.288 Bytes) vollständig mit PostgreSQL 18 wiederhergestellt: 93 Bestandstabellen. Additive Organisationsmigration auf dieser lokalen Kopie geprüft: 94 Tabellen, Kontakte 71, Nachrichten 5259, Organisation 0. Anwendungstests verwenden ausschließlich eine zweite synthetische lokale Testdatenbank, keine privaten Produktionsdaten als Testmaterial.
