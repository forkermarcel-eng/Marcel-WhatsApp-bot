import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../migrations/20260905_t2_visible_chat_capture.sql", import.meta.url),
  "utf8"
);

test("T2 capture migration is explicit-only and isolated from contact identity changes", () => {
  assert.match(migration, /PREPARATION ONLY/);
  assert.match(migration, /CREATE TABLE tinder_visible_chat_captures/i);
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS/i);
  assert.match(migration, /device_id UUID NOT NULL[\s\S]*REFERENCES device_bridge_devices\(device_id\)/i);
  assert.match(migration, /resolved_contact_id INTEGER[\s\S]*REFERENCES contacts\(id\)[\s\S]*ON DELETE RESTRICT/i);
  assert.match(migration, /UNIQUE \(device_id, runtime_thread_fingerprint, capture_revision\)/i);
  assert.match(migration, /UNIQUE \(device_id, runtime_thread_fingerprint, capture_fingerprint\)/i);
  assert.doesNotMatch(migration, /ALTER TABLE contacts/i);
  assert.doesNotMatch(migration, /contact_identifiers/i);
  assert.doesNotMatch(migration, /tinder_identity_mapping_audit/i);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+messages/i);
});
test("T2 capture migration retains fail-closed capture and review constraints", () => {
  assert.match(migration, /source_package = 'com\.tinder'/i);
  assert.match(migration, /capture_safety_status = 'SAFE'/i);
  assert.match(migration, /mapping_status IN \('NEEDS_HUMAN_MAPPING', 'RESOLVED', 'CONFLICT'\)/i);
  assert.match(migration, /human_review_status IN \('PENDING', 'CONFIRMED', 'REJECTED'\)/i);
  assert.match(migration, /\(mapping_status = 'RESOLVED'\) = \(resolved_contact_id IS NOT NULL\)/i);
});
