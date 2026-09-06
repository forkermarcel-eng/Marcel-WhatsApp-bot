import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  assertTinderManualSendFoundationSchemaReady,
  preflightTinderManualSendFoundationMigration
} from "./tinder-manual-send-foundation-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createExplicitTinderFoundationMigrationRunner,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";

/* ==================================================
T5 — EXPLICIT SEALED SEND-FOUNDATION MIGRATION
================================================== */

export const T5_MANUAL_SEND_MIGRATION_DIAGNOSTIC_STAGES = TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;
const T5_MANUAL_SEND_MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260905_tinder_manual_send_foundation.sql", import.meta.url), "utf8"
);
const T5_EXPECTED_STATEMENT_HEADS = Object.freeze([
  "DO",
  "ALTER TABLE tinder_reply_drafts ADD COLUMN IF NOT EXISTS draft_revision INTEGER NOT NULL DEFAULT 1",
  "CREATE TABLE IF NOT EXISTS tinder_reply_send_approvals",
  "CREATE INDEX IF NOT EXISTS idx_tinder_reply_send_approvals_active_draft",
  "CREATE TABLE IF NOT EXISTS tinder_reply_send_intents",
  "CREATE INDEX IF NOT EXISTS idx_tinder_reply_send_intents_pending",
  "CREATE TABLE IF NOT EXISTS tinder_reply_send_audit",
  "CREATE INDEX IF NOT EXISTS idx_tinder_reply_send_audit_draft_time"
]);

export function assertTinderManualSendFoundationMigrationSource(source) {
  return assertFixedTinderFoundationMigrationSource(source, {
    label: "T5 Tinder manual-send foundation",
    expectedStatementHeads: T5_EXPECTED_STATEMENT_HEADS
  });
}

export function validateTinderManualSendFoundationMigrationSource(source) {
  assertTinderManualSendFoundationMigrationSource(source);
  return { valid: true };
}

function lockedRelations(preflight) {
  const relations = new Set([
    ...REQUIRED_TABLES,
    "contacts", "contact_identifiers", "tinder_visible_chat_captures", "tinder_identity_mapping_audit",
    "tinder_reply_drafts", "tinder_reply_draft_audit"
  ]);
  if (preflight?.manualSend?.state === "CANONICAL") {
    relations.add("tinder_reply_send_approvals");
    relations.add("tinder_reply_send_intents");
    relations.add("tinder_reply_send_audit");
  }
  return [...relations];
}

const runner = createExplicitTinderFoundationMigrationRunner({
  label: "T5 Tinder manual-send foundation",
  migrationSql: T5_MANUAL_SEND_MIGRATION_SQL,
  validateSource: validateTinderManualSendFoundationMigrationSource,
  preflight: preflightTinderManualSendFoundationMigration,
  postcheck: async (client, { applied }) => {
    const checked = await preflightTinderManualSendFoundationMigration(client);
    if (applied) await assertTinderManualSendFoundationSchemaReady(client);
    return checked;
  },
  lockRelations: lockedRelations,
  advisoryLock: { namespace: 7421, key: 50 }
});

export const validateTinderManualSendFoundationPreDdl = runner.validatePreDdl;
export const migrateTinderManualSendFoundation = runner.migrate;
export function getTinderManualSendFoundationMigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}
