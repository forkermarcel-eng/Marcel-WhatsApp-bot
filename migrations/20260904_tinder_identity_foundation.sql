-- T3 Tinder Identity Foundation — PREPARATION ONLY.
--
-- This file is deliberately NOT imported by index.js, initDatabase(), or any
-- Device Bridge runtime initializer.  It must be reviewed and applied through
-- a separate, explicit local migration procedure before any route is enabled.
-- Prerequisite: the existing contacts, contact_identifiers and canonical T2
-- tinder_visible_chat_captures table already exist.  T3 never creates or
-- weakens the capture table: T2 owns its signed-ingress and fingerprint-
-- deduplication contract.

-- T3 is deliberately additive to the canonical T2 capture table.  A missing
-- table is a deployment/order error, not a reason for this migration to
-- create an older, weaker capture-table variant.
DO $$
BEGIN
  IF to_regclass('public.tinder_visible_chat_captures') IS NULL THEN
    RAISE EXCEPTION
      'T3 migration blocked: canonical T2 tinder_visible_chat_captures foundation is required';
  END IF;
END
$$;

-- A channel-native contact has no WhatsApp conversation identifier.  NULL is
-- intentional; it is not a synthetic channel identifier.
ALTER TABLE contacts
  ALTER COLUMN whatsapp_jid DROP NOT NULL;

-- Legacy rows retain their existing boolean authority.  New T3 rows record
-- the explicit human source and time without rewriting legacy provenance.
ALTER TABLE contact_identifiers
  ADD COLUMN IF NOT EXISTS verification_source TEXT,
  ADD COLUMN IF NOT EXISTS verified_by TEXT,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- Fail closed: an existing duplicate confirmed Tinder identifier must be
-- manually resolved before the database can enforce unique ownership.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM contact_identifiers
    WHERE identifier_type = 'tinder_profile'
      AND human_verified = TRUE
    GROUP BY normalized_value
    HAVING COUNT(DISTINCT contact_id) > 1
  ) THEN
    RAISE EXCEPTION
      'T3 migration blocked: duplicate confirmed tinder_profile identifiers require human resolution';
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_contact_identifiers_tinder_confirmed_unique
ON contact_identifiers (identifier_type, normalized_value)
WHERE identifier_type = 'tinder_profile'
  AND human_verified = TRUE;

CREATE INDEX IF NOT EXISTS
  idx_tinder_visible_chat_captures_mapping_time
ON tinder_visible_chat_captures (mapping_status, received_at DESC);

CREATE INDEX IF NOT EXISTS
  idx_tinder_visible_chat_captures_contact_time
ON tinder_visible_chat_captures (resolved_contact_id, received_at DESC)
WHERE resolved_contact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tinder_identity_mapping_audit (
  mapping_audit_id BIGSERIAL PRIMARY KEY,

  capture_id UUID NOT NULL
    REFERENCES tinder_visible_chat_captures(capture_id)
    ON DELETE RESTRICT,

  action TEXT NOT NULL
    CHECK (action IN ('MAP_EXISTING', 'CREATE_NEW', 'CONFLICT_BLOCKED')),

  actor TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual_dashboard'
    CHECK (source = 'manual_dashboard'),

  request_reference TEXT,

  old_mapping_status TEXT,
  new_mapping_status TEXT,

  old_contact_id INTEGER
    REFERENCES contacts(id)
    ON DELETE SET NULL,

  new_contact_id INTEGER
    REFERENCES contacts(id)
    ON DELETE SET NULL,

  identifier_id BIGINT
    REFERENCES contact_identifiers(id)
    ON DELETE SET NULL,

  details JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object'),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS
  idx_tinder_identity_mapping_audit_capture_time
ON tinder_identity_mapping_audit (capture_id, created_at DESC);
