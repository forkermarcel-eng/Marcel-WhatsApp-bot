-- Tinder official-app resume permit V2 — explicit migration only.
--
-- V1 records remain historical, terminal and immutable.  This narrow upgrade
-- only makes a later launcher-only permit independently auditable against the
-- already human-confirmed conversation binding/revision that authorized it.
-- It neither creates a new identity nor grants reader, capture, sync, upload,
-- draft, send, swipe, match or call authority.
--
-- No route, startup, heartbeat, capture ingress or scheduler imports this
-- migration.  It is executable solely by the separately approved fixed runner.

ALTER TABLE tinder_official_app_resume_permits
  ADD COLUMN permit_contract_version SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE tinder_official_app_resume_permits
  ALTER COLUMN permit_contract_version DROP DEFAULT;

ALTER TABLE tinder_official_app_resume_permits
  ADD COLUMN binding_id UUID;

ALTER TABLE tinder_official_app_resume_permits
  ADD COLUMN binding_revision INTEGER;

ALTER TABLE tinder_official_app_resume_permits
  DROP CONSTRAINT tinder_official_app_resume_permits_source_capture_id_key;

ALTER TABLE tinder_official_app_resume_permits
  ADD CONSTRAINT tinder_official_app_resume_permits_binding_id_fkey
  FOREIGN KEY (binding_id)
  REFERENCES contact_human_armed_conversation_bindings(binding_id)
  ON DELETE RESTRICT;

ALTER TABLE tinder_official_app_resume_permits
  ADD CONSTRAINT tinder_official_app_resume_permits_contract_version_check
  CHECK (permit_contract_version IN (1, 2));

ALTER TABLE tinder_official_app_resume_permits
  ADD CONSTRAINT tinder_official_app_resume_permits_contract_binding_check
  CHECK (
    (permit_contract_version = 1 AND binding_id IS NULL AND binding_revision IS NULL)
    OR
    (permit_contract_version = 2 AND binding_id IS NOT NULL
      AND binding_revision IS NOT NULL AND binding_revision > 0)
  );

CREATE INDEX idx_tinder_official_app_resume_permit_binding_revision_created
ON tinder_official_app_resume_permits (binding_id, binding_revision, created_at DESC)
WHERE binding_id IS NOT NULL;
