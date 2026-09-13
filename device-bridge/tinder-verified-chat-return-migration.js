import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  assertTinderVerifiedChatReturnSchemaReady,
  inspectTinderVerifiedChatReturnSchema,
  preflightTinderVerifiedChatReturnMigration,
  TINDER_VERIFIED_CHAT_RETURN_AUDIT_TABLE,
  TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE,
  TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE
} from "./tinder-verified-chat-return-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createExplicitTinderFoundationMigrationRunner,
  createTinderFoundationMigrationDiagnosticError,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";
import { withDeviceBridgeReadOnlyTransaction } from "./read-only-transaction.js";

/* Explicit V8 -> V9 DDL only.  No route, heartbeat, or dashboard can invoke it. */

export const TINDER_VERIFIED_CHAT_RETURN_MIGRATION_DIAGNOSTIC_STAGES =
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;
export const TINDER_VERIFIED_CHAT_RETURN_MIGRATION_DIAGNOSTIC_REASONS = Object.freeze([
  "TINDER_VERIFIED_CHAT_RETURN_POSTCHECK_SCHEMA_INVALID"
]);

const MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260913_tinder_verified_chat_return_permit_v9.sql", import.meta.url),
  "utf8"
);

const EXPECTED_STATEMENT_HEADS = Object.freeze([
  "ALTER TABLE device_bridge_commands DROP CONSTRAINT device_bridge_commands_command_type_check_v8",
  "ALTER TABLE device_bridge_commands ADD CONSTRAINT device_bridge_commands_command_type_check_v9 CHECK (command_type IN",
  "CREATE TABLE tinder_verified_chat_return_permits",
  "ALTER TABLE tinder_verified_chat_return_permits ADD CONSTRAINT tinder_verified_chat_return_permits_command_device_fkey FOREIGN KEY (command_id, device_id) REFERENCES device_bridge_commands(command_id, device_id) ON DELETE RESTRICT",
  "CREATE UNIQUE INDEX idx_tinder_verified_chat_return_active_device ON tinder_verified_chat_return_permits",
  "CREATE INDEX idx_tinder_verified_chat_return_source_created ON tinder_verified_chat_return_permits",
  "CREATE INDEX idx_tinder_verified_chat_return_resume_created ON tinder_verified_chat_return_permits",
  "CREATE INDEX idx_tinder_verified_chat_return_binding_revision_created ON tinder_verified_chat_return_permits",
  "CREATE TABLE tinder_verified_chat_return_audit",
  "ALTER TABLE tinder_verified_chat_return_audit ADD CONSTRAINT tinder_verified_chat_return_audit_scope_fkey FOREIGN KEY (command_id, device_id, binding_id, binding_revision) REFERENCES tinder_verified_chat_return_permits(command_id, device_id, binding_id, binding_revision) ON DELETE RESTRICT",
  "CREATE INDEX idx_tinder_verified_chat_return_audit_command_created ON tinder_verified_chat_return_audit",
  "CREATE FUNCTION tinder_verified_chat_return_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS",
  "CREATE FUNCTION tinder_verified_chat_return_resume_scope_guard() RETURNS trigger LANGUAGE plpgsql AS",
  "CREATE TRIGGER tinder_verified_chat_return_resume_scope BEFORE INSERT OR UPDATE ON tinder_verified_chat_return_permits",
  "CREATE TRIGGER tinder_verified_chat_return_permit_immutable BEFORE UPDATE OR DELETE ON tinder_verified_chat_return_permits",
  "CREATE TRIGGER tinder_verified_chat_return_audit_immutable BEFORE UPDATE OR DELETE ON tinder_verified_chat_return_audit"
]);

// SHA-256 of the complete reviewed V9 source after line-ending and outer
// whitespace normalization.  A migration source edit must deliberately update
// this digest and its fixed statement contract before any DB connection.
const REVIEWED_SOURCE_SHA256 = "0f8b0d71b1c809f000aafe603880d7237778f74152f9faf2c9637fa09977a3f8";

function canonicalFixedSource(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

export function assertTinderVerifiedChatReturnMigrationSource(source) {
  const canonical = canonicalFixedSource(source);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (digest !== REVIEWED_SOURCE_SHA256) {
    throw new Error("Tinder verified chat return source is not an exact reviewed migration.");
  }
  return assertFixedTinderFoundationMigrationSource(canonical, {
    label: "Tinder verified chat return",
    expectedStatementHeads: EXPECTED_STATEMENT_HEADS
  });
}

export function validateTinderVerifiedChatReturnMigrationSource(source) {
  assertTinderVerifiedChatReturnMigrationSource(source);
  return { valid: true };
}

function lockedRelations() {
  return [...new Set([
    ...REQUIRED_TABLES,
    "contacts",
    "tinder_visible_chat_captures",
    "contact_human_armed_conversation_bindings",
    "contact_human_armed_conversation_binding_permits",
    "contact_human_armed_conversation_binding_audit",
    "tinder_visible_chat_sync_permits",
    "tinder_official_app_resume_permits",
    "tinder_visible_chat_sync_transcripts",
    "tinder_local_conversation_attestation_permits",
    "tinder_local_conversation_attestation_audit",
    "tinder_unbound_inbox_conversation_sweeps",
    "tinder_unbound_inbox_conversation_sweep_steps",
    "tinder_unbound_inbox_conversation_sweep_transcripts",
    "tinder_unbound_inbox_conversation_sweep_audit",
    TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE,
    TINDER_VERIFIED_CHAT_RETURN_AUDIT_TABLE
  ])];
}

export function createTinderVerifiedChatReturnMigrationRunner({
  migrationSql = MIGRATION_SQL,
  validateSource = validateTinderVerifiedChatReturnMigrationSource,
  preflight = preflightTinderVerifiedChatReturnMigration,
  inspectSchema = inspectTinderVerifiedChatReturnSchema,
  assertSchemaReady = assertTinderVerifiedChatReturnSchemaReady
} = {}) {
  return createExplicitTinderFoundationMigrationRunner({
    label: "Tinder verified chat return",
    migrationSql,
    validateSource,
    preflight,
    postcheck: async (client, { applied }) => {
      if (applied) {
        const foundation = await inspectSchema(client);
        if (foundation.state !== TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.CANONICAL) {
          throw createTinderFoundationMigrationDiagnosticError(
            "TINDER_VERIFIED_CHAT_RETURN_POSTCHECK_SCHEMA_INVALID"
          );
        }
      }
      const checked = await preflight(client);
      if (applied) await assertSchemaReady(client);
      return checked;
    },
    lockRelations: lockedRelations,
    advisoryLock: { namespace: 7421, key: 53 },
    transactionIsolation: "READ COMMITTED",
    diagnosticReasonCodes: TINDER_VERIFIED_CHAT_RETURN_MIGRATION_DIAGNOSTIC_REASONS
  });
}

const runner = createTinderVerifiedChatReturnMigrationRunner();

/**
 * Protected, catalog-only V9 pre-DDL validation.  It deliberately does not
 * reuse the migration runner's locked transaction: that runner must remain
 * READ COMMITTED so its post-lock recheck observes commits made while it was
 * waiting.  The public validation export instead uses the fixed DB-enforced
 * REPEATABLE READ / READ ONLY / ROLLBACK transaction used by the CLI path.
 */
export async function validateTinderVerifiedChatReturnPreDdl(pool) {
  validateTinderVerifiedChatReturnMigrationSource(MIGRATION_SQL);
  return withDeviceBridgeReadOnlyTransaction(pool, client =>
    preflightTinderVerifiedChatReturnMigration(client)
  );
}

/** Explicit only. No runtime path reaches this DDL authority. */
export const migrateTinderVerifiedChatReturnFoundation = runner.migrate;

export function getTinderVerifiedChatReturnMigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}
