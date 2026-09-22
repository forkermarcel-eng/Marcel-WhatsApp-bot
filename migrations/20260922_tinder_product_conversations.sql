-- Tinder product conversations — explicit additive cleanup migration.
--
-- Captures remain immutable technical provenance.  This migration adds the
-- durable, identity-independent product object above them.  It contains no
-- data backfill, command/permit/receipt table, trigger, or legacy V8/V9/V10
-- change.  Historical reconciliation is a separately authorized operation.

CREATE TABLE tinder_thread_conversations (
  conversation_id UUID PRIMARY KEY,

  device_id UUID NOT NULL
    REFERENCES device_bridge_devices(device_id)
    ON DELETE RESTRICT,

  -- A device-local correlation bucket only.  It is never returned as a
  -- product ID and is deliberately not UNIQUE: different real threads can
  -- share a visible header-derived observation.
  runtime_thread_fingerprint_hint CHAR(64) NOT NULL
    CHECK (runtime_thread_fingerprint_hint ~ '^[0-9a-f]{64}$'),

  identity_binding_state TEXT NOT NULL DEFAULT 'UNASSIGNED'
    CHECK (identity_binding_state IN ('UNASSIGNED', 'BOUND', 'CONFLICT')),
  resolved_contact_id INTEGER
    REFERENCES contacts(id)
    ON DELETE RESTRICT,

  correlation_state TEXT NOT NULL DEFAULT 'PROVISIONAL'
    CHECK (correlation_state IN ('PROVISIONAL', 'CORRELATED', 'AMBIGUOUS')),
  history_state TEXT NOT NULL DEFAULT 'PARTIAL'
    CHECK (history_state IN ('PARTIAL', 'COMPLETE')),

  -- Product profile state is optional and channel-owned.  It does not store
  -- a platform/person identifier and starts empty until the control layer
  -- has a verified profile observation to project.
  profile_state JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(profile_state) = 'object'),

  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  last_history_at TIMESTAMPTZ NOT NULL,
  last_profile_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK ((identity_binding_state = 'BOUND') = (resolved_contact_id IS NOT NULL)),
  CHECK (last_observed_at >= first_observed_at),
  CHECK (last_history_at >= first_observed_at),
  CHECK (last_profile_at IS NULL OR last_profile_at >= first_observed_at),

  -- This redundant-with-PK pair is intentional: capture links carry the
  -- device scope and reference the exact same device-bound Conversation.
  UNIQUE (conversation_id, device_id)
);

CREATE INDEX idx_tinder_thread_conversations_device_hint
ON tinder_thread_conversations (device_id, runtime_thread_fingerprint_hint, updated_at DESC);

CREATE INDEX idx_tinder_thread_conversations_device_updated
ON tinder_thread_conversations (device_id, updated_at DESC);

-- `capture_id` is already unique.  This fixed pair is the referenced key for
-- a device-bound capture link, so a direct database writer cannot connect a
-- capture from one device to a Conversation on another device.
CREATE UNIQUE INDEX idx_tinder_visible_chat_captures_capture_device
ON tinder_visible_chat_captures (capture_id, device_id);

CREATE TABLE tinder_thread_conversation_capture_links (
  conversation_id UUID NOT NULL,
  capture_id UUID NOT NULL,
  device_id UUID NOT NULL,
  link_method TEXT NOT NULL
    CHECK (link_method IN ('INITIAL', 'ORDERED_MESSAGE_OVERLAP')),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  PRIMARY KEY (conversation_id, capture_id),
  UNIQUE (capture_id),

  FOREIGN KEY (conversation_id, device_id)
    REFERENCES tinder_thread_conversations(conversation_id, device_id)
    ON DELETE RESTRICT,
  FOREIGN KEY (capture_id, device_id)
    REFERENCES tinder_visible_chat_captures(capture_id, device_id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_tinder_thread_conversation_capture_links_conversation_time
ON tinder_thread_conversation_capture_links (conversation_id, linked_at ASC);
