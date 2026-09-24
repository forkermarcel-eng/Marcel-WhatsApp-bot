-- Block 2: additive normal Tinder product objects only.
-- This file is intentionally not executed by application startup.  The
-- explicit Block-2 migration runner owns the surrounding transaction.
-- It has no capture, mapping, permit, receipt, audit, trigger, or CASCADE path.

CREATE TABLE tinder_conversations (
  conversation_id UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT,
  channel TEXT NOT NULL DEFAULT 'tinder' CHECK (channel = 'tinder'),
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  history_complete BOOLEAN NOT NULL DEFAULT FALSE,
  profile_synced_at TIMESTAMPTZ,
  history_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX tinder_conversations_device_updated_idx
  ON tinder_conversations(device_id, updated_at DESC);

CREATE TABLE tinder_conversation_messages (
  message_id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES tinder_conversations(conversation_id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  direction TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  message_text TEXT NOT NULL,
  visible_time TEXT,
  visible_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id, ordinal)
);

CREATE INDEX tinder_conversation_messages_conversation_ordinal_idx
  ON tinder_conversation_messages(conversation_id, ordinal);
