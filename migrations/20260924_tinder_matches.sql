-- Block 2: additive Tinder Match product object only.
-- The explicit migration runner owns transaction, locks, and postcheck.
-- No product-row data path, trigger, function, capture, mapping, or CASCADE.

ALTER TABLE tinder_conversations
  ADD CONSTRAINT tinder_conversations_conversation_id_device_id_key
  UNIQUE (conversation_id, device_id);

CREATE TABLE tinder_matches (
  match_id UUID PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT,
  conversation_id UUID NULL,
  tile JSONB NOT NULL,
  carousel_position INTEGER NOT NULL CHECK (carousel_position >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT tinder_matches_conversation_device_fkey
    FOREIGN KEY (conversation_id, device_id)
    REFERENCES tinder_conversations(conversation_id, device_id)
    ON DELETE RESTRICT
);

CREATE INDEX tinder_matches_device_carousel_position_idx
  ON tinder_matches(device_id, carousel_position);
