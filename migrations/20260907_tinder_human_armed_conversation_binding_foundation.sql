-- Human-armed conversation binding foundation — explicit migration only.
--
-- This does not alter the source-observed V2 binding contract. It adds a
-- separate, human-confirmed association and one-use device command permits.
-- No startup, HTTP route or capture ingress imports this file.

ALTER TABLE device_bridge_commands
  DROP CONSTRAINT device_bridge_commands_command_type_check_v1;

ALTER TABLE device_bridge_commands
  ADD CONSTRAINT device_bridge_commands_command_type_check_v2
  CHECK (command_type IN (
    'PING', 'REQUEST_STATUS', 'STOP_BRIDGE',
    'CONNECT_TINDER', 'DISCONNECT_TINDER',
    'ARM_TINDER_CONVERSATION_BINDING'
  ));

CREATE TABLE IF NOT EXISTS contact_human_armed_conversation_bindings (
  binding_id UUID PRIMARY KEY,
  channel TEXT NOT NULL
    CHECK (channel IN ('tinder', 'whatsapp')),
  reference_kind TEXT NOT NULL,
  reference_hash CHAR(64) NOT NULL
    CHECK (reference_hash ~ '^[0-9a-f]{64}$'),
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
      AND reference_kind = 'tinder_human_armed_conversation_v1'
      AND device_id IS NOT NULL
      AND source_capture_id IS NOT NULL)
    OR
    (channel = 'whatsapp'
      AND reference_kind = 'whatsapp_human_armed_conversation_ref_v1'
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_human_armed_conversation_binding_active_device_ref
ON contact_human_armed_conversation_bindings (channel, reference_kind, device_id, reference_hash)
WHERE binding_state = 'CONFIRMED'
  AND device_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_human_armed_conversation_binding_active_unscoped_ref
ON contact_human_armed_conversation_bindings (channel, reference_kind, reference_hash)
WHERE binding_state = 'CONFIRMED'
  AND device_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_human_armed_conversation_binding_contact_state
ON contact_human_armed_conversation_bindings (contact_id, binding_state, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_human_armed_conversation_binding_source_capture
ON contact_human_armed_conversation_bindings (source_capture_id)
WHERE source_capture_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS contact_human_armed_conversation_binding_permits (
  command_id UUID PRIMARY KEY
    REFERENCES device_bridge_commands(command_id)
    ON DELETE RESTRICT,
  binding_id UUID NOT NULL
    REFERENCES contact_human_armed_conversation_bindings(binding_id)
    ON DELETE RESTRICT,
  device_id UUID NOT NULL
    REFERENCES device_bridge_devices(device_id)
    ON DELETE RESTRICT,
  binding_revision INTEGER NOT NULL
    CHECK (binding_revision > 0),
  permit_state TEXT NOT NULL DEFAULT 'ISSUED'
    CHECK (permit_state IN ('ISSUED', 'CONSUMED')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_capture_id UUID
    REFERENCES tinder_visible_chat_captures(capture_id)
    ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > issued_at),
  CHECK (
    (permit_state = 'ISSUED' AND consumed_at IS NULL AND consumed_capture_id IS NULL)
    OR
    (permit_state = 'CONSUMED' AND consumed_at IS NOT NULL AND consumed_capture_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_harmed_conv_binding_permit_state_expiry
ON contact_human_armed_conversation_binding_permits
  (binding_id, device_id, permit_state, expires_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_harmed_conv_binding_permit_consumed_capture
ON contact_human_armed_conversation_binding_permits (consumed_capture_id)
WHERE consumed_capture_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS contact_human_armed_conversation_binding_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  binding_id UUID NOT NULL
    REFERENCES contact_human_armed_conversation_bindings(binding_id)
    ON DELETE RESTRICT,
  capture_id UUID
    REFERENCES tinder_visible_chat_captures(capture_id)
    ON DELETE RESTRICT,
  action TEXT NOT NULL
    CHECK (action IN ('CREATE', 'ARM_ISSUED', 'PERMIT_CONSUMED', 'REVOKE', 'CONFLICT_BLOCKED')),
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
      'reference_hash', 'reference_token', 'permit_id', 'command_id',
      'raw_unique_id', 'visible_name', 'message_text', 'capture_fingerprint',
      'runtime_thread_fingerprint'
    ])),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_human_armed_conversation_binding_audit_binding_time
ON contact_human_armed_conversation_binding_audit (binding_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_human_armed_conversation_binding_audit_capture_time
ON contact_human_armed_conversation_binding_audit (capture_id, created_at DESC)
WHERE capture_id IS NOT NULL;
