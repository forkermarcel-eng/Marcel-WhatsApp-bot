import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../migrations/20260904_tinder_identity_foundation.sql", import.meta.url),
  "utf8"
);

test("T3 migration is standalone preparation with a channel-native contact shape", () => {
  assert.match(migration, /PREPARATION ONLY/);
  assert.doesNotMatch(migration, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.match(migration, /ALTER TABLE contacts\s+ALTER COLUMN whatsapp_jid DROP NOT NULL/i);
  assert.match(migration, /verification_source TEXT/i);
  assert.match(migration, /verified_by TEXT/i);
  assert.match(migration, /verified_at TIMESTAMPTZ/i);
  assert.doesNotMatch(migration, /@memory\.local/i);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+messages/i);
});

test("T3 migration blocks duplicate confirmed Tinder identities instead of selecting or merging one", () => {
  assert.match(migration, /GROUP BY normalized_value/i);
  assert.match(migration, /COUNT\(DISTINCT contact_id\) > 1/i);
  assert.match(migration, /RAISE EXCEPTION/i);
  assert.match(migration, /idx_contact_identifiers_tinder_confirmed_unique/i);
  assert.match(migration, /identifier_type = 'tinder_profile'/i);
  assert.match(migration, /human_verified = TRUE/i);
});

test("T3 migration is additive to the canonical T2 capture contract and stores mapping audit outside WhatsApp tables", () => {
  assert.match(migration, /to_regclass\('public\.tinder_visible_chat_captures'\)/i);
  assert.match(migration, /canonical T2 tinder_visible_chat_captures foundation is required/i);
  assert.doesNotMatch(migration, /CREATE TABLE IF NOT EXISTS tinder_visible_chat_captures/i);
  assert.doesNotMatch(migration, /UNIQUE \(device_id, runtime_thread_fingerprint, capture_fingerprint\)/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tinder_identity_mapping_audit/i);
  assert.match(migration, /action IN \('MAP_EXISTING', 'CREATE_NEW', 'CONFLICT_BLOCKED'\)/i);
  assert.match(migration, /source = 'manual_dashboard'/i);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+messages/i);
});
