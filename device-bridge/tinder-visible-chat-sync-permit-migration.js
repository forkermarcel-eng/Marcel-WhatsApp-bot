import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  assertTinderVisibleChatSyncPermitSchemaReady,
  inspectTinderVisibleChatSyncPermitSchema,
  preflightTinderVisibleChatSyncPermitMigration,
  TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE
} from "./tinder-visible-chat-sync-permit-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createExplicitTinderFoundationMigrationRunner,
  createTinderFoundationMigrationDiagnosticError,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";

/* ==================================================
TINDER V4 VISIBLE-CHAT SYNC PERMIT — EXPLICIT DDL

No route, startup owner, or capture ingress reaches this runner. It is only a
future, separately approved DDL authority; this module performs nothing at
import time.
================================================== */

export const TINDER_VISIBLE_CHAT_SYNC_PERMIT_MIGRATION_DIAGNOSTIC_STAGES =
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;
export const TINDER_VISIBLE_CHAT_SYNC_PERMIT_MIGRATION_DIAGNOSTIC_REASONS = Object.freeze([
  "TINDER_VISIBLE_CHAT_SYNC_PERMIT_POSTCHECK_SCHEMA_INVALID"
]);

const MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260907_tinder_visible_chat_sync_permit_foundation.sql", import.meta.url),
  "utf8"
);

const EXPECTED_STATEMENT_HEADS = Object.freeze([
  "ALTER TABLE device_bridge_commands DROP CONSTRAINT device_bridge_commands_command_type_check_v3",
  "ALTER TABLE device_bridge_commands ADD CONSTRAINT device_bridge_commands_command_type_check_v5",
  "CREATE TABLE IF NOT EXISTS tinder_visible_chat_sync_permits",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_tinder_visible_chat_sync_permit_active_device",
  "CREATE INDEX IF NOT EXISTS idx_tinder_visible_chat_sync_permit_device_expiry",
  "CREATE INDEX IF NOT EXISTS idx_tinder_visible_chat_sync_permit_source_capture",
  "CREATE TABLE IF NOT EXISTS tinder_official_app_resume_permits",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_tinder_official_app_resume_permit_active_device",
  "CREATE INDEX IF NOT EXISTS idx_tinder_official_app_resume_permit_source_created",
  "CREATE TABLE IF NOT EXISTS tinder_visible_chat_sync_transcripts",
  "CREATE INDEX IF NOT EXISTS idx_tinder_visible_chat_sync_transcript_source_received",
  "CREATE INDEX IF NOT EXISTS idx_tinder_visible_chat_sync_transcript_device_received"
]);

export function assertTinderVisibleChatSyncPermitMigrationSource(source) {
  return assertFixedTinderFoundationMigrationSource(source, {
    label: "Tinder visible-chat sync permit foundation",
    expectedStatementHeads: EXPECTED_STATEMENT_HEADS
  });
}

export function validateTinderVisibleChatSyncPermitMigrationSource(source) {
  assertTinderVisibleChatSyncPermitMigrationSource(source);
  return { valid: true };
}

function lockedRelations(preflight) {
  const relations = new Set([
    ...REQUIRED_TABLES,
    "tinder_visible_chat_captures",
    "contact_human_armed_conversation_bindings",
    "contact_human_armed_conversation_binding_permits",
    "contact_human_armed_conversation_binding_audit"
  ]);
  if (preflight?.foundation?.state === TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.CANONICAL) {
    relations.add("tinder_visible_chat_sync_permits");
    relations.add("tinder_official_app_resume_permits");
    relations.add("tinder_visible_chat_sync_transcripts");
  }
  return [...relations];
}

const runner = createExplicitTinderFoundationMigrationRunner({
  label: "Tinder visible-chat sync permit foundation",
  migrationSql: MIGRATION_SQL,
  validateSource: validateTinderVisibleChatSyncPermitMigrationSource,
  preflight: preflightTinderVisibleChatSyncPermitMigration,
  postcheck: async (client, { applied }) => {
    if (applied) {
      const foundation = await inspectTinderVisibleChatSyncPermitSchema(client);
      if (foundation.state !== TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.CANONICAL) {
        throw createTinderFoundationMigrationDiagnosticError(
          "TINDER_VISIBLE_CHAT_SYNC_PERMIT_POSTCHECK_SCHEMA_INVALID"
        );
      }
    }
    const checked = await preflightTinderVisibleChatSyncPermitMigration(client);
    if (applied) await assertTinderVisibleChatSyncPermitSchemaReady(client);
    return checked;
  },
  lockRelations: lockedRelations,
  advisoryLock: { namespace: 7421, key: 44 },
  diagnosticReasonCodes: TINDER_VISIBLE_CHAT_SYNC_PERMIT_MIGRATION_DIAGNOSTIC_REASONS
});

/** Read-only rollback-only pre-DDL validation of the exact fixed runner. */
export const validateTinderVisibleChatSyncPermitPreDdl = runner.validatePreDdl;

/** Explicit only. No route or startup caller reaches this DDL authority. */
export const migrateTinderVisibleChatSyncPermitFoundation = runner.migrate;

export function getTinderVisibleChatSyncPermitMigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}
