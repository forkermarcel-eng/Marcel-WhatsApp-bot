-- T2 visible-chat capture storage — PREPARATION ONLY.
--
-- This file is deliberately NOT imported by index.js, runtime initialization,
-- or any Device Bridge migration runner. Apply it only through a separately
-- reviewed, explicit production migration after an independent schema
-- preflight. Until then, the signed ingress returns a controlled 503.

BEGIN;

CREATE TABLE IF NOT EXISTS tinder_visible_chat_captures (
  capture_id UUID PRIMARY KEY,

  device_id UUID NOT NULL
    REFERENCES device_bridge_devices(device_id)
    ON DELETE RESTRICT,

  capture_schema_version TEXT NOT NULL
    CHECK (char_length(capture_schema_version) BETWEEN 1 AND 80),

  source_platform TEXT NOT NULL DEFAULT 'tinder'
    CHECK (source_platform = 'tinder'),

  source_package TEXT NOT NULL
    CHECK (source_package = 'com.tinder'),

  capture_safety_status TEXT NOT NULL
    CHECK (capture_safety_status = 'SAFE'),

  -- This is a short-lived technical correlation value, never a person ID.
  runtime_thread_fingerprint CHAR(64) NOT NULL
    CHECK (runtime_thread_fingerprint ~ '^[0-9a-f]{64}$'),

  capture_fingerprint CHAR(64) NOT NULL
    CHECK (capture_fingerprint ~ '^[0-9a-f]{64}$'),

  capture_revision INTEGER NOT NULL
    CHECK (capture_revision > 0),

  visible_thread_metadata JSONB NOT NULL
    CHECK (jsonb_typeof(visible_thread_metadata) = 'object'),

  visible_messages JSONB NOT NULL
    CHECK (jsonb_typeof(visible_messages) = 'array'),

  mapping_status TEXT NOT NULL DEFAULT 'NEEDS_HUMAN_MAPPING'
    CHECK (mapping_status IN ('NEEDS_HUMAN_MAPPING', 'RESOLVED', 'CONFLICT')),

  human_review_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (human_review_status IN ('PENDING', 'CONFIRMED', 'REJECTED')),

  resolved_contact_id INTEGER
    REFERENCES contacts(id)
    -- A resolved mapping must retain its resolved contact.  SET NULL would
    -- violate the RESOLVED/non-null consistency check below during deletion.
    ON DELETE RESTRICT,

  mapping_reviewed_by TEXT,
  mapping_reviewed_at TIMESTAMPTZ,

  provenance JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(provenance) = 'object'),

  captured_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK ((mapping_status = 'RESOLVED') = (resolved_contact_id IS NOT NULL)),
  UNIQUE (device_id, runtime_thread_fingerprint, capture_revision)
);

COMMIT;
