-- Tinder V4 visible-chat sync foundation — explicit migration only.
--
-- The Android payload has no identity or conversation reference. A permit is
-- created only for an already SAFE/RESOLVED/CONFIRMED server-side source
-- capture selected by the authenticated dashboard path. The separate V4
-- transcript therefore never derives a person, contact, conversation or
-- binding identifier from Android UI data.
--
-- No startup, route registration, capture ingress, or scheduler imports this
-- migration. It remains an explicit runner-only DDL authority.

ALTER TABLE device_bridge_commands
  DROP CONSTRAINT device_bridge_commands_command_type_check_v3;

ALTER TABLE device_bridge_commands
  ADD CONSTRAINT device_bridge_commands_command_type_check_v5
  CHECK (command_type IN (
    'PING', 'REQUEST_STATUS', 'STOP_BRIDGE',
    'CONNECT_TINDER', 'DISCONNECT_TINDER',
    'ARM_TINDER_CONVERSATION_BINDING',
    'SEND_TINDER_DRAFT',
    'SYNC_TINDER_VISIBLE_CHAT',
    'RESUME_OFFICIAL_TINDER_APP'
  ));

CREATE TABLE IF NOT EXISTS tinder_visible_chat_sync_permits (
  command_id UUID PRIMARY KEY
    REFERENCES device_bridge_commands(command_id)
    ON DELETE RESTRICT,
  device_id UUID NOT NULL
    REFERENCES device_bridge_devices(device_id)
    ON DELETE RESTRICT,
  -- Server-side only: never supplied in an Android command or upload body.
  source_capture_id UUID NOT NULL
    REFERENCES tinder_visible_chat_captures(capture_id)
    ON DELETE RESTRICT,
  permit_state TEXT NOT NULL DEFAULT 'ISSUED'
    CHECK (permit_state IN ('ISSUED', 'STAGED', 'CONSUMED', 'EXPIRED', 'CANCELLED')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  staged_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Required by the transcript's composite target FK.  It prevents a
  -- transcript from mixing any command, device or source capture from a
  -- different server-issued permit.
  UNIQUE (command_id, device_id, source_capture_id),
  CHECK (expires_at > issued_at),
  CHECK (
    (permit_state = 'ISSUED' AND staged_at IS NULL AND consumed_at IS NULL AND closed_at IS NULL)
    OR
    (permit_state = 'STAGED' AND staged_at IS NOT NULL AND consumed_at IS NULL AND closed_at IS NULL)
    OR
    (permit_state = 'CONSUMED' AND staged_at IS NOT NULL AND consumed_at IS NOT NULL AND closed_at IS NULL)
    OR
    (permit_state IN ('EXPIRED', 'CANCELLED') AND consumed_at IS NULL AND closed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tinder_visible_chat_sync_permit_active_device
ON tinder_visible_chat_sync_permits (device_id)
WHERE permit_state IN ('ISSUED', 'STAGED');

CREATE INDEX IF NOT EXISTS idx_tinder_visible_chat_sync_permit_device_expiry
ON tinder_visible_chat_sync_permits (device_id, permit_state, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_tinder_visible_chat_sync_permit_source_capture
ON tinder_visible_chat_sync_permits (source_capture_id, created_at DESC);

-- A separate durable command-scoped permit for one standard official-Tinder
-- launcher dispatch. It never authorizes a transcript, conversation
-- selection, identity association, UI click, or Android-provided target.
CREATE TABLE IF NOT EXISTS tinder_official_app_resume_permits (
  command_id UUID PRIMARY KEY
    REFERENCES device_bridge_commands(command_id)
    ON DELETE RESTRICT,
  device_id UUID NOT NULL
    REFERENCES device_bridge_devices(device_id)
    ON DELETE RESTRICT,
  source_capture_id UUID NOT NULL
    REFERENCES tinder_visible_chat_captures(capture_id)
    ON DELETE RESTRICT,
  permit_state TEXT NOT NULL DEFAULT 'ISSUED'
    CHECK (permit_state IN ('ISSUED', 'DISPATCHED', 'EXPIRED', 'CANCELLED')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  dispatched_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (command_id, device_id, source_capture_id),
  -- The selected confirmed source capture can authorize one standard
  -- launcher-dispatch command exactly once, including terminal failure.
  UNIQUE (source_capture_id),
  CHECK (expires_at > issued_at),
  CHECK (
    (permit_state = 'ISSUED' AND dispatched_at IS NULL AND closed_at IS NULL)
    OR
    (permit_state = 'DISPATCHED' AND dispatched_at IS NOT NULL AND closed_at IS NULL)
    OR
    (permit_state IN ('EXPIRED', 'CANCELLED') AND dispatched_at IS NULL AND closed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tinder_official_app_resume_permit_active_device
ON tinder_official_app_resume_permits (device_id)
WHERE permit_state = 'ISSUED';

CREATE INDEX IF NOT EXISTS idx_tinder_official_app_resume_permit_source_created
ON tinder_official_app_resume_permits (source_capture_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tinder_visible_chat_sync_transcripts (
  sync_id UUID PRIMARY KEY,
  command_id UUID NOT NULL UNIQUE,
  -- Both target columns are server-owned permit facts, never Android input.
  source_capture_id UUID NOT NULL,
  device_id UUID NOT NULL,
  sync_schema_version TEXT NOT NULL
    CHECK (sync_schema_version = 'tinder-visible-chat-sync-v1'),
  source_package TEXT NOT NULL
    CHECK (source_package = 'com.tinder'),
  layout_schema_version TEXT NOT NULL
    CHECK (layout_schema_version = 'tinder-zte-visible-chat-scroll-v1'),
  sync_started_at TIMESTAMPTZ NOT NULL,
  sync_completed_at TIMESTAMPTZ NOT NULL,
  initial_visible_node_count INTEGER NOT NULL CHECK (initial_visible_node_count > 0),
  final_visible_node_count INTEGER NOT NULL CHECK (final_visible_node_count > 0),
  segment_count INTEGER NOT NULL CHECK (segment_count BETWEEN 1 AND 8),
  overlap_count INTEGER NOT NULL CHECK (overlap_count BETWEEN 0 AND 100),
  -- Command-scoped transcript integrity/dedupe value, never a T2 capture ID.
  transcript_fingerprint CHAR(64) NOT NULL
    CHECK (transcript_fingerprint ~ '^[0-9a-f]{64}$'),
  visible_messages JSONB NOT NULL
    CHECK (jsonb_typeof(visible_messages) = 'array')
    CHECK (jsonb_array_length(visible_messages) BETWEEN 1 AND 100),
  sync_safety_status TEXT NOT NULL CHECK (sync_safety_status = 'SAFE'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (command_id, device_id, source_capture_id)
    REFERENCES tinder_visible_chat_sync_permits(command_id, device_id, source_capture_id)
    ON DELETE RESTRICT,
  CHECK (sync_completed_at >= sync_started_at)
);

CREATE INDEX IF NOT EXISTS idx_tinder_visible_chat_sync_transcript_source_received
ON tinder_visible_chat_sync_transcripts (source_capture_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_tinder_visible_chat_sync_transcript_device_received
ON tinder_visible_chat_sync_transcripts (device_id, received_at DESC);
