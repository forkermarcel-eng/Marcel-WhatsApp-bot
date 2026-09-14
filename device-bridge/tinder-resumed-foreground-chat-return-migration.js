import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  assertTinderResumedForegroundChatReturnSchemaReady,
  inspectTinderResumedForegroundChatReturnSchema,
  preflightTinderResumedForegroundChatReturnMigration,
  TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE
} from "./tinder-resumed-foreground-chat-return-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createExplicitTinderFoundationMigrationRunner,
  createTinderFoundationMigrationDiagnosticError,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";
import { withDeviceBridgeReadOnlyTransaction } from "./read-only-transaction.js";

/* Explicit V9 -> V10 DDL only. No route/startup/runtime path invokes it. */

export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_MIGRATION_DIAGNOSTIC_STAGES =
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;
export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_MIGRATION_DIAGNOSTIC_REASONS = Object.freeze([
  "TINDER_RESUMED_FOREGROUND_CHAT_RETURN_POSTCHECK_SCHEMA_INVALID"
]);

const MIGRATION_SQL = readFileSync(new URL(
  "../migrations/20260914_tinder_resumed_foreground_chat_return_permit_v10.sql", import.meta.url), "utf8");
const EXPECTED_STATEMENT_HEADS = Object.freeze([
  "ALTER TABLE device_bridge_commands DROP CONSTRAINT device_bridge_commands_command_type_check_v9",
  "ALTER TABLE device_bridge_commands ADD CONSTRAINT device_bridge_commands_command_type_check_v10 CHECK (command_type IN",
  "CREATE TABLE tinder_resumed_foreground_chat_return_permits",
  "ALTER TABLE tinder_resumed_foreground_chat_return_permits ADD CONSTRAINT tinder_resumed_foreground_chat_return_permits_command_device_fkey FOREIGN KEY (command_id, device_id) REFERENCES device_bridge_commands(command_id, device_id) ON DELETE RESTRICT",
  "CREATE UNIQUE INDEX idx_tinder_resumed_foreground_chat_return_active_device ON tinder_resumed_foreground_chat_return_permits",
  "CREATE INDEX idx_tinder_resumed_foreground_chat_return_resume_created ON tinder_resumed_foreground_chat_return_permits",
  "CREATE TABLE tinder_resumed_foreground_chat_return_audit",
  "ALTER TABLE tinder_resumed_foreground_chat_return_audit ADD CONSTRAINT tinder_resumed_foreground_chat_return_audit_scope_fkey FOREIGN KEY (command_id, device_id) REFERENCES tinder_resumed_foreground_chat_return_permits(command_id, device_id) ON DELETE RESTRICT",
  "CREATE INDEX idx_tinder_resumed_foreground_chat_return_audit_command_created ON tinder_resumed_foreground_chat_return_audit",
  "CREATE FUNCTION tinder_resumed_foreground_chat_return_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS",
  "CREATE FUNCTION tinder_resumed_foreground_chat_return_resume_scope_guard() RETURNS trigger LANGUAGE plpgsql AS",
  "CREATE TRIGGER tinder_resumed_foreground_chat_return_resume_scope BEFORE INSERT OR UPDATE ON tinder_resumed_foreground_chat_return_permits",
  "CREATE TRIGGER tinder_resumed_foreground_chat_return_permit_immutable BEFORE UPDATE OR DELETE ON tinder_resumed_foreground_chat_return_permits",
  "CREATE TRIGGER tinder_resumed_foreground_chat_return_audit_immutable BEFORE UPDATE OR DELETE ON tinder_resumed_foreground_chat_return_audit"
]);

// Updated only with the exact complete reviewed V10 migration source.
const REVIEWED_SOURCE_SHA256 = "09c30aa7cf7305502ffc8536db92bd9275741c4f294fe5991d767f35d1a5f79b";
function canonicalFixedSource(value) { return String(value || "").replace(/\r\n/g, "\n").trim(); }

export function assertTinderResumedForegroundChatReturnMigrationSource(source) {
  const canonical = canonicalFixedSource(source);
  if (createHash("sha256").update(canonical, "utf8").digest("hex") !== REVIEWED_SOURCE_SHA256) {
    throw new Error("Tinder resumed foreground chat return source is not an exact reviewed migration.");
  }
  return assertFixedTinderFoundationMigrationSource(canonical, {
    label: "Tinder resumed foreground chat return", expectedStatementHeads: EXPECTED_STATEMENT_HEADS
  });
}
export function validateTinderResumedForegroundChatReturnMigrationSource(source) {
  assertTinderResumedForegroundChatReturnMigrationSource(source);
  return { valid: true };
}

function lockedRelations() {
  // V10's own two relations are additive and do not exist before fixed DDL.
  // Lock only exact V9/V8 predecessors whose catalog/data define this upgrade.
  return [...new Set([
    ...REQUIRED_TABLES,
    "contacts", "tinder_visible_chat_captures", "contact_human_armed_conversation_bindings",
    "contact_human_armed_conversation_binding_permits", "contact_human_armed_conversation_binding_audit",
    "tinder_visible_chat_sync_permits", "tinder_official_app_resume_permits",
    "tinder_visible_chat_sync_transcripts", "tinder_local_conversation_attestation_permits",
    "tinder_local_conversation_attestation_audit", "tinder_unbound_inbox_conversation_sweeps",
    "tinder_unbound_inbox_conversation_sweep_steps", "tinder_unbound_inbox_conversation_sweep_transcripts",
    "tinder_unbound_inbox_conversation_sweep_audit", "tinder_verified_chat_return_permits",
    "tinder_verified_chat_return_audit"
  ])];
}

export function createTinderResumedForegroundChatReturnMigrationRunner({
  migrationSql = MIGRATION_SQL,
  validateSource = validateTinderResumedForegroundChatReturnMigrationSource,
  preflight = preflightTinderResumedForegroundChatReturnMigration,
  inspectSchema = inspectTinderResumedForegroundChatReturnSchema,
  assertSchemaReady = assertTinderResumedForegroundChatReturnSchemaReady
} = {}) {
  return createExplicitTinderFoundationMigrationRunner({
    label: "Tinder resumed foreground chat return", migrationSql, validateSource, preflight,
    postcheck: async (client, { applied }) => {
      if (applied) {
        const foundation = await inspectSchema(client);
        if (foundation.state !== TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.CANONICAL) {
          throw createTinderFoundationMigrationDiagnosticError(
            "TINDER_RESUMED_FOREGROUND_CHAT_RETURN_POSTCHECK_SCHEMA_INVALID");
        }
      }
      const checked = await preflight(client);
      if (applied) await assertSchemaReady(client);
      return checked;
    },
    lockRelations: lockedRelations, advisoryLock: { namespace: 7421, key: 54 },
    transactionIsolation: "READ COMMITTED",
    diagnosticReasonCodes: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_MIGRATION_DIAGNOSTIC_REASONS
  });
}

const runner = createTinderResumedForegroundChatReturnMigrationRunner();
export async function validateTinderResumedForegroundChatReturnPreDdl(pool) {
  validateTinderResumedForegroundChatReturnMigrationSource(MIGRATION_SQL);
  return withDeviceBridgeReadOnlyTransaction(pool, client => preflightTinderResumedForegroundChatReturnMigration(client));
}
export const migrateTinderResumedForegroundChatReturnFoundation = runner.migrate;
export function getTinderResumedForegroundChatReturnMigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}
