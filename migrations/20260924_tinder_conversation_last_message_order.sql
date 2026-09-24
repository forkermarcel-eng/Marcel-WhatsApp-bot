-- Block 2: additive, source-faithful ordering fields only.
-- The explicit migration runner owns the surrounding lock and transaction.
-- No data backfill, data rewrite, trigger, function, or CASCADE path exists.

ALTER TABLE tinder_conversations
  ADD COLUMN last_message_visible_time TEXT;

ALTER TABLE tinder_conversations
  ADD COLUMN inbox_position INTEGER;

ALTER TABLE tinder_conversations
  ADD CONSTRAINT tinder_conversations_inbox_position_nonnegative_check
  CHECK (inbox_position IS NULL OR inbox_position >= 0);

CREATE INDEX tinder_conversations_device_inbox_position_idx
  ON tinder_conversations(device_id, inbox_position);
