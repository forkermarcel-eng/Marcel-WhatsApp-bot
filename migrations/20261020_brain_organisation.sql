BEGIN;
CREATE SCHEMA IF NOT EXISTS marcel_organisation;
CREATE TABLE IF NOT EXISTS marcel_organisation.items(
 kind text NOT NULL CHECK(kind IN ('shipment','audit','settings','mail_seen')),
 id text NOT NULL,
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 PRIMARY KEY(kind,id)
);
COMMIT;
