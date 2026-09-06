import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("T5 migration is explicit-only, additive to T3/T4, and reserves no active Device Bridge command", () => {
  const migration = readFileSync(
    new URL("../migrations/20260905_tinder_manual_send_foundation.sql", import.meta.url),
    "utf8"
  );
  assert.match(migration, /PREPARATION ONLY/);
  assert.doesNotMatch(migration, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS draft_revision INTEGER NOT NULL DEFAULT 1/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tinder_reply_send_approvals/i);
  assert.match(migration, /UNIQUE \(draft_id, draft_revision\)/i);
  assert.match(migration, /thread_ref_kind = 'runtime_thread_fingerprint_v1'/i);
  assert.match(migration, /approved_text_sha256 CHAR\(64\)/i);
  assert.match(migration, /approval_binding_sha256 CHAR\(64\)/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tinder_reply_send_intents/i);
  assert.match(migration, /command_type = 'SEND_TINDER_DRAFT'/i);
  assert.match(migration, /PENDING_T5_WRITER/);
  assert.match(migration, /SEND_RESULT_UNKNOWN/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tinder_reply_send_audit/i);
  assert.match(migration, /DRAFT_REJECTED/);
  assert.doesNotMatch(migration, /ALTER TABLE\s+device_bridge_commands/i);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+device_bridge_commands/i);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+messages/i);
  assert.doesNotMatch(migration, /whatsapp_jid/i);
});

test("no startup initializer, T1 runner, or package hook imports or applies the T5 foundation", () => {
  const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const initialization = readFileSync(new URL("../device-bridge/initialization.js", import.meta.url), "utf8");
  const runner = readFileSync(new URL("../device-bridge/database.js", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../scripts/migrate-device-bridge-t1.js", import.meta.url), "utf8");
  const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  for (const source of [index, initialization, runner, cli, packageJson]) {
    assert.doesNotMatch(source, /20260905_tinder_manual_send_foundation\.sql/);
    assert.doesNotMatch(source, /migrate-tinder-manual-send/);
  }
  assert.doesNotMatch(initialization, /tinder_reply_send_(approvals|intents|audit)/);
  assert.doesNotMatch(runner, /SEND_TINDER_DRAFT/);
});

test("the T5 persistence model keeps raw approved Tinder text in the original draft only and audits bounded IDs/hashes", () => {
  const migration = readFileSync(
    new URL("../migrations/20260905_tinder_manual_send_foundation.sql", import.meta.url),
    "utf8"
  );
  const approvals = migration.slice(
    migration.indexOf("CREATE TABLE IF NOT EXISTS tinder_reply_send_approvals"),
    migration.indexOf("CREATE INDEX IF NOT EXISTS idx_tinder_reply_send_approvals_active_draft")
  );
  const audit = migration.slice(migration.indexOf("CREATE TABLE IF NOT EXISTS tinder_reply_send_audit"));
  assert.doesNotMatch(approvals, /approved_text\s+TEXT/i);
  assert.match(approvals, /approved_text_sha256/i);
  assert.match(audit, /details JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);
  assert.match(migration, /No raw capture content, credentials or copied Tinder/i);
});
