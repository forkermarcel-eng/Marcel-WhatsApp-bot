-- Shared channel-conversation binding foundation — PREPARATION ONLY.
--
-- This is deliberately not imported from index.js or any runtime/startup
-- path. It persists only a human-confirmed association between a central
-- contact and a channel conversation reference that is already opaque at the
-- source. It never stores a raw Tinder accessibility ID, display name, chat
-- text, capture fingerprint or runtime fingerprint as an identity.
--
-- WhatsApp is represented as a future adapter shape only. This migration
-- neither starts WhatsApp nor reads, sends or changes WhatsApp data.

DO $$
BEGIN
  IF to_regclass('public.contacts') IS NULL
     OR to_regclass('public.device_bridge_devices') IS NULL
     OR to_regclass('public.tinder_visible_chat_captures') IS NULL THEN
    RAISE EXCEPTION
      'Conversation binding migration requires the canonical contact, Device Bridge and T2 capture foundations';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS contact_conversation_bindings (
  binding_id UUID PRIMARY KEY,

  -- Channel-neutral contract. The fixed kind pair prevents a caller from
  -- silently treating a display value or raw platform identifier as a ref.
  channel TEXT NOT NULL
    CHECK (channel IN ('tinder', 'whatsapp')),
  reference_kind TEXT NOT NULL,
  reference_hash CHAR(64) NOT NULL
    CHECK (reference_hash ~ '^[0-9a-f]{64}$'),

  -- Tinder's locally HMACed UI evidence is device-scoped. A future WhatsApp
  -- adapter is intentionally unscoped here and cannot be activated by this
  -- foundation alone.
  device_id UUID
    REFERENCES device_bridge_devices(device_id)
    ON DELETE RESTRICT,
  contact_id INTEGER NOT NULL
    REFERENCES contacts(id)
    ON DELETE RESTRICT,
  source_capture_id UUID
    REFERENCES tinder_visible_chat_captures(capture_id)
    ON DELETE RESTRICT,

  binding_state TEXT NOT NULL DEFAULT 'CONFIRMED'
    CHECK (binding_state IN ('CONFIRMED', 'REVOKED')),
  binding_revision INTEGER NOT NULL DEFAULT 1
    CHECK (binding_revision > 0),
  human_verified BOOLEAN NOT NULL DEFAULT TRUE
    CHECK (human_verified = TRUE),
  verification_source TEXT NOT NULL DEFAULT 'manual_dashboard'
    CHECK (verification_source = 'manual_dashboard'),
  verified_by TEXT NOT NULL
    CHECK (char_length(verified_by) BETWEEN 1 AND 80),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  revoked_by TEXT,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (
    (channel = 'tinder'
      AND reference_kind = 'tinder_accessibility_header_unique_id_hmac_v1'
      AND device_id IS NOT NULL
      AND source_capture_id IS NOT NULL)
    OR
    (channel = 'whatsapp'
      AND reference_kind = 'whatsapp_conversation_ref_hmac_v1'
      AND device_id IS NULL
      AND source_capture_id IS NULL)
  ),
  CHECK (
    (binding_state = 'CONFIRMED'
      AND revoked_by IS NULL
      AND revoked_at IS NULL
      AND revocation_reason IS NULL)
    OR
    (binding_state = 'REVOKED'
      AND revoked_by IS NOT NULL
      AND revoked_at IS NOT NULL
      AND revocation_reason IN ('HUMAN_REVOKED', 'CONFLICT_SUPERSEDED'))
  )
);

-- PostgreSQL UNIQUE permits several NULLs. Keep the Tinder device scope and
-- future unscoped consumer explicitly separate so an active opaque reference
-- can never silently acquire two confirmed owners.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_conversation_binding_active_device_ref
ON contact_conversation_bindings (channel, reference_kind, device_id, reference_hash)
WHERE binding_state = 'CONFIRMED'
  AND device_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_conversation_binding_active_unscoped_ref
ON contact_conversation_bindings (channel, reference_kind, reference_hash)
WHERE binding_state = 'CONFIRMED'
  AND device_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_contact_conversation_binding_contact_state
ON contact_conversation_bindings (contact_id, binding_state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_conversation_binding_source_capture
ON contact_conversation_bindings (source_capture_id)
WHERE source_capture_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS contact_conversation_binding_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  binding_id UUID NOT NULL
    REFERENCES contact_conversation_bindings(binding_id)
    ON DELETE RESTRICT,
  capture_id UUID
    REFERENCES tinder_visible_chat_captures(capture_id)
    ON DELETE RESTRICT,
  action TEXT NOT NULL
    CHECK (action IN ('CREATE', 'CONFIRM', 'REVOKE', 'CONFLICT_BLOCKED')),
  actor TEXT NOT NULL
    CHECK (char_length(actor) BETWEEN 1 AND 80),
  source TEXT NOT NULL DEFAULT 'manual_dashboard'
    CHECK (source = 'manual_dashboard'),
  old_contact_id INTEGER
    REFERENCES contacts(id)
    ON DELETE SET NULL,
  new_contact_id INTEGER
    REFERENCES contacts(id)
    ON DELETE SET NULL,
  old_binding_revision INTEGER
    CHECK (old_binding_revision IS NULL OR old_binding_revision > 0),
  new_binding_revision INTEGER
    CHECK (new_binding_revision IS NULL OR new_binding_revision > 0),
  reason_code TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object')
    CHECK (NOT (details ?| ARRAY[
      'reference_hash', 'reference_token', 'raw_unique_id', 'visible_name',
      'message_text', 'capture_fingerprint', 'runtime_thread_fingerprint'
    ])),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_conversation_binding_audit_binding_time
ON contact_conversation_binding_audit (binding_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_conversation_binding_audit_capture_time
ON contact_conversation_binding_audit (capture_id, created_at DESC)
WHERE capture_id IS NOT NULL;
