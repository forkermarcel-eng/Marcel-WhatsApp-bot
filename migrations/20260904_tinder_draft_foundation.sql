-- T4 Tinder Draft Foundation — PREPARATION ONLY.
--
-- This migration is deliberately NOT imported by index.js, initDatabase(), a
-- Device Bridge initializer, or any deployment hook.  It requires the reviewed
-- T3 identity foundation to have been applied first, and must be executed only
-- through a separate, explicit migration procedure. The reviewed runner owns
-- the transaction; this source must not BEGIN or COMMIT independently.

-- Identity revision is owned by the capture mapping record, never derived from
-- a display name or transient thread fingerprint.  Defaults retain the T3
-- history until a confirmed mapping changes it.
ALTER TABLE tinder_visible_chat_captures
  ADD COLUMN IF NOT EXISTS identity_revision INTEGER NOT NULL DEFAULT 1
    CHECK (identity_revision > 0),
  ADD COLUMN IF NOT EXISTS human_takeover_active BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS handoff_active BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing T3 mapping writes stay compatible.  When a mapping changes after
-- this reviewed migration, its authoritative revision advances atomically.
CREATE OR REPLACE FUNCTION t4_bump_tinder_capture_identity_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.mapping_status IS DISTINCT FROM NEW.mapping_status
     OR OLD.human_review_status IS DISTINCT FROM NEW.human_review_status
     OR OLD.resolved_contact_id IS DISTINCT FROM NEW.resolved_contact_id THEN
    NEW.identity_revision := OLD.identity_revision + 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS t4_tinder_capture_identity_revision ON tinder_visible_chat_captures;

CREATE TRIGGER t4_tinder_capture_identity_revision
BEFORE UPDATE OF mapping_status, human_review_status, resolved_contact_id
ON tinder_visible_chat_captures
FOR EACH ROW
EXECUTE FUNCTION t4_bump_tinder_capture_identity_revision();

CREATE TABLE IF NOT EXISTS tinder_reply_drafts (
  draft_id UUID PRIMARY KEY,

  channel TEXT NOT NULL DEFAULT 'tinder'
    CHECK (channel = 'tinder'),

  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'APPROVED', 'REJECTED', 'STALE')),

  contact_id INTEGER NOT NULL
    REFERENCES contacts(id)
    ON DELETE RESTRICT,

  capture_id UUID NOT NULL
    REFERENCES tinder_visible_chat_captures(capture_id)
    ON DELETE RESTRICT,

  runtime_thread_fingerprint CHAR(64) NOT NULL
    CHECK (runtime_thread_fingerprint ~ '^[0-9a-f]{64}$'),

  capture_revision INTEGER NOT NULL
    CHECK (capture_revision > 0),

  identity_revision INTEGER NOT NULL
    CHECK (identity_revision > 0),

  original_draft TEXT NOT NULL
    CHECK (char_length(original_draft) BETWEEN 1 AND 8000),

  -- No translation model is invoked in T4.  This is merely the original
  -- draft when its source language is German; otherwise it is NULL.
  control_draft_de TEXT
    CHECK (control_draft_de IS NULL OR char_length(control_draft_de) BETWEEN 1 AND 8000),

  source_language TEXT
    CHECK (source_language IS NULL OR char_length(source_language) BETWEEN 1 AND 32),

  model_version TEXT NOT NULL
    CHECK (char_length(model_version) BETWEEN 1 AND 160),

  stale_reason TEXT
    CHECK (stale_reason IS NULL OR stale_reason IN (
      'NEWER_CAPTURE_REVISION',
      'THREAD_CHANGED',
      'IDENTITY_MAPPING_CHANGED',
      'HUMAN_TAKEOVER',
      'HANDOFF',
      'GATE_CLOSED'
    )),

  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,

  CHECK ((status = 'STALE') = (stale_reason IS NOT NULL)),
  CHECK (
    control_draft_de IS NULL
    OR COALESCE(
      lower(source_language) IN ('de', 'deutsch', 'german')
      OR lower(source_language) LIKE 'de-%',
      FALSE
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_tinder_reply_drafts_contact_status_time
ON tinder_reply_drafts (contact_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tinder_reply_drafts_thread_revision
ON tinder_reply_drafts (runtime_thread_fingerprint, capture_revision DESC);

CREATE TABLE IF NOT EXISTS tinder_reply_draft_audit (
  draft_audit_id BIGSERIAL PRIMARY KEY,

  draft_id UUID NOT NULL
    REFERENCES tinder_reply_drafts(draft_id)
    ON DELETE RESTRICT,

  capture_id UUID NOT NULL
    REFERENCES tinder_visible_chat_captures(capture_id)
    ON DELETE RESTRICT,

  action TEXT NOT NULL
    CHECK (action IN ('DRAFT_CREATED', 'DRAFT_STALE')),

  actor TEXT NOT NULL,

  source TEXT NOT NULL DEFAULT 'tinder_draft_foundation'
    CHECK (source = 'tinder_draft_foundation'),

  previous_status TEXT,
  new_status TEXT NOT NULL,

  reason TEXT,

  details JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object'),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (new_status IN ('DRAFT', 'STALE')),
  CHECK ((action = 'DRAFT_CREATED') = (new_status = 'DRAFT')),
  CHECK ((action = 'DRAFT_STALE') = (new_status = 'STALE'))
);

CREATE INDEX IF NOT EXISTS idx_tinder_reply_draft_audit_draft_time
ON tinder_reply_draft_audit (draft_id, created_at DESC);
