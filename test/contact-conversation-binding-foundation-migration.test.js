import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertContactConversationBindingFoundationMigrationSource,
  validateContactConversationBindingFoundationMigrationSource
} from "../device-bridge/contact-conversation-binding-foundation-migration.js";

const source = readFileSync(
  new URL("../migrations/20260907_contact_conversation_binding_foundation.sql", import.meta.url),
  "utf8"
);

test("binding migration source is fixed before any database path and has no runtime import seam", () => {
  assert.deepEqual(validateContactConversationBindingFoundationMigrationSource(source), { valid: true });
  assert.throws(() => assertContactConversationBindingFoundationMigrationSource(
    source.replace("CREATE INDEX IF NOT EXISTS idx_contact_conversation_binding_source_capture", "ALTER TABLE contacts ADD COLUMN unsafe text")
  ));
  const migrationModule = readFileSync(
    new URL("../device-bridge/contact-conversation-binding-foundation-migration.js", import.meta.url), "utf8"
  );
  assert.doesNotMatch(migrationModule, /from\s+["']\.\/index\.js/);
  assert.doesNotMatch(migrationModule, /register.*Route/i);
  assert.match(migrationModule, /advisoryLock: \{ namespace: 7421, key: 31 \}/);
});
