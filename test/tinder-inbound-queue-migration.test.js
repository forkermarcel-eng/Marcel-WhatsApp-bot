import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the T6 queue migration is explicit, persistent, Tinder-only, and exact about the 3–4 minute window", () => {
  const migration = readFileSync(
    new URL("../migrations/20260905_tinder_inbound_queue_foundation.sql", import.meta.url),
    "utf8"
  );
  assert.match(migration, /PREPARATION ONLY/);
  assert.doesNotMatch(migration, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tinder_inbound_work_items/i);
  assert.match(migration, /channel = 'tinder'/i);
  assert.match(migration, /runtime_thread_fingerprint_v1/i);
  assert.match(migration, /collection_window_ms BETWEEN 180000 AND 240000/i);
  assert.match(migration, /ELIGIBLE_FOR_NEXT_STAGE/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_tinder_inbound_work_one_open_thread/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tinder_inbound_work_events/i);
  assert.match(migration, /dedup_key CHAR\(64\) NOT NULL UNIQUE/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tinder_inbound_work_audit/i);
  assert.match(migration, /tinder_visible_chat_captures/i);
  assert.match(migration, /identity_revision/i);
});

test("the T6 migration does not create a startup/command/message/draft/send path", () => {
  const migration = readFileSync(
    new URL("../migrations/20260905_tinder_inbound_queue_foundation.sql", import.meta.url),
    "utf8"
  );
  const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+device_bridge_commands/i);
  assert.doesNotMatch(migration, /ALTER\s+TABLE\s+device_bridge_commands/i);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+messages/i);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+tinder_reply_drafts/i);
  assert.doesNotMatch(migration, /SEND_TINDER_DRAFT/i);
  assert.doesNotMatch(index, /20260905_tinder_inbound_queue_foundation\.sql/);
  assert.doesNotMatch(index, /tinder_inbound_work_items[\s\S]{0,120}CREATE TABLE/i);
});

test("T6 only prepares the current Tinder capture foundation and leaves Android/notification implementation out", () => {
  const migration = readFileSync(
    new URL("../migrations/20260905_tinder_inbound_queue_foundation.sql", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(migration, /notification listener|accessibility service|android\.permission|com\.tinder/i);
  assert.doesNotMatch(migration, /CREATE\s+TRIGGER/i);
  assert.doesNotMatch(migration, /CREATE\s+FUNCTION/i);
});
