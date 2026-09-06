import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  assertTinderDraftFoundationSchemaReady,
  preflightTinderDraftFoundationMigration
} from "./tinder-draft-foundation-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createExplicitTinderFoundationMigrationRunner,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";

/* ==================================================
T4 — EXPLICIT DRAFT FOUNDATION MIGRATION
================================================== */

export const T4_DRAFT_MIGRATION_DIAGNOSTIC_STAGES = TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;

const T4_DRAFT_MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260904_tinder_draft_foundation.sql", import.meta.url),
  "utf8"
);

const T4_EXPECTED_STATEMENT_HEADS = Object.freeze([
  "ALTER TABLE tinder_visible_chat_captures ADD COLUMN IF NOT EXISTS identity_revision INTEGER NOT NULL DEFAULT 1",
  "CREATE OR REPLACE FUNCTION t4_bump_tinder_capture_identity_revision",
  "DROP TRIGGER IF EXISTS t4_tinder_capture_identity_revision ON tinder_visible_chat_captures",
  "CREATE TRIGGER t4_tinder_capture_identity_revision",
  "CREATE TABLE IF NOT EXISTS tinder_reply_drafts",
  "CREATE INDEX IF NOT EXISTS idx_tinder_reply_drafts_contact_status_time",
  "CREATE INDEX IF NOT EXISTS idx_tinder_reply_drafts_thread_revision",
  "CREATE TABLE IF NOT EXISTS tinder_reply_draft_audit",
  "CREATE INDEX IF NOT EXISTS idx_tinder_reply_draft_audit_draft_time"
]);

export function assertTinderDraftFoundationMigrationSource(source) {
  return assertFixedTinderFoundationMigrationSource(source, {
    label: "T4 Tinder draft foundation",
    expectedStatementHeads: T4_EXPECTED_STATEMENT_HEADS
  });
}

export function validateTinderDraftFoundationMigrationSource(source) {
  assertTinderDraftFoundationMigrationSource(source);
  return { valid: true };
}

function lockedRelations(preflight) {
  const relations = new Set([
    ...REQUIRED_TABLES,
    "contacts",
    "contact_identifiers",
    "tinder_visible_chat_captures",
    "tinder_identity_mapping_audit"
  ]);
  if (preflight?.draft?.state === "CANONICAL") {
    relations.add("tinder_reply_drafts");
    relations.add("tinder_reply_draft_audit");
  }
  return [...relations];
}

const runner = createExplicitTinderFoundationMigrationRunner({
  label: "T4 Tinder draft foundation",
  migrationSql: T4_DRAFT_MIGRATION_SQL,
  validateSource: validateTinderDraftFoundationMigrationSource,
  preflight: preflightTinderDraftFoundationMigration,
  postcheck: async (client, { applied }) => {
    const checked = await preflightTinderDraftFoundationMigration(client);
    if (applied) await assertTinderDraftFoundationSchemaReady(client);
    return checked;
  },
  lockRelations: lockedRelations,
  advisoryLock: { namespace: 7421, key: 40 }
});

/** Read-only, rollback-only validation of the exact T4 pre-DDL path. */
export const validateTinderDraftFoundationPreDdl = runner.validatePreDdl;

/** Explicit, unrouted T4 DDL authority. The matching CLI must require --apply. */
export const migrateTinderDraftFoundation = runner.migrate;

export function getTinderDraftFoundationMigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}
