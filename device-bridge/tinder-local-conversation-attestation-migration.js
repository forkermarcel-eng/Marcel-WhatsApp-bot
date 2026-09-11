import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  assertTinderLocalConversationAttestationSchemaReady,
  inspectTinderLocalConversationAttestationSchema,
  preflightTinderLocalConversationAttestationMigration,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE
} from "./tinder-local-conversation-attestation-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createExplicitTinderFoundationMigrationRunner,
  createTinderFoundationMigrationDiagnosticError,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";

/* ==================================================
TINDER LOCAL CONVERSATION ATTESTATION — EXPLICIT DDL

The sole DDL authority for the bounded local-attestation contract. Importing
this module does nothing; no startup, route, command, heartbeat, reader, or
launcher invokes it. Its source is fixed and complete before any DB client is
opened, and its read-only preflight rejects active legacy V1 sync permits.
================================================== */

export const TINDER_LOCAL_CONVERSATION_ATTESTATION_MIGRATION_DIAGNOSTIC_STAGES =
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;
export const TINDER_LOCAL_CONVERSATION_ATTESTATION_MIGRATION_DIAGNOSTIC_REASONS = Object.freeze([
  "TINDER_LOCAL_CONVERSATION_ATTESTATION_POSTCHECK_SCHEMA_INVALID"
]);

const MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260911_tinder_local_conversation_attestation_foundation.sql", import.meta.url),
  "utf8"
);

// This list enforces ordered executable statement boundaries. The reviewed
// digest below then requires equality of the complete fixed source, not merely
// matching statement prefixes.
const EXPECTED_STATEMENT_HEADS = Object.freeze([
  "ALTER TABLE device_bridge_commands DROP CONSTRAINT device_bridge_commands_command_type_check_v5",
  "ALTER TABLE device_bridge_commands ADD CONSTRAINT device_bridge_commands_command_type_check_v6 CHECK (command_type IN",
  "CREATE TABLE tinder_local_conversation_attestation_permits",
  "ALTER TABLE tinder_local_conversation_attestation_permits ADD CONSTRAINT tinder_local_conversation_attestation_permits_command_device_fkey FOREIGN KEY (command_id, device_id) REFERENCES device_bridge_commands(command_id, device_id) ON DELETE RESTRICT",
  "CREATE UNIQUE INDEX idx_tinder_local_conversation_attestation_active_device ON tinder_local_conversation_attestation_permits",
  "CREATE INDEX idx_tinder_local_conversation_attestation_device_expiry ON tinder_local_conversation_attestation_permits",
  "CREATE INDEX idx_tinder_local_conversation_attestation_binding_created ON tinder_local_conversation_attestation_permits",
  "CREATE TABLE tinder_local_conversation_attestation_audit",
  "ALTER TABLE tinder_local_conversation_attestation_audit ADD CONSTRAINT tinder_local_conversation_attestation_audit_scope_fkey FOREIGN KEY (command_id, device_id, binding_id, binding_revision) REFERENCES tinder_local_conversation_attestation_permits (command_id, device_id, binding_id, binding_revision) ON DELETE RESTRICT",
  "CREATE INDEX idx_tinder_local_conversation_attestation_audit_command_created ON tinder_local_conversation_attestation_audit",
  "ALTER TABLE tinder_visible_chat_sync_permits ADD COLUMN permit_contract_version SMALLINT NOT NULL DEFAULT 1",
  "ALTER TABLE tinder_visible_chat_sync_permits ALTER COLUMN permit_contract_version DROP DEFAULT",
  "ALTER TABLE tinder_visible_chat_sync_permits ADD COLUMN attestation_command_id UUID",
  "ALTER TABLE tinder_visible_chat_sync_permits ADD COLUMN binding_id UUID",
  "ALTER TABLE tinder_visible_chat_sync_permits ADD COLUMN binding_revision INTEGER",
  "ALTER TABLE tinder_visible_chat_sync_permits ADD CONSTRAINT tinder_visible_chat_sync_permits_attestation_command_id_fkey FOREIGN KEY (attestation_command_id) REFERENCES tinder_local_conversation_attestation_permits(command_id) ON DELETE RESTRICT",
  "ALTER TABLE tinder_visible_chat_sync_permits ADD CONSTRAINT tinder_visible_chat_sync_permits_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES contact_human_armed_conversation_bindings(binding_id) ON DELETE RESTRICT",
  "ALTER TABLE tinder_visible_chat_sync_permits ADD CONSTRAINT tinder_visible_chat_sync_permits_attestation_scope_fkey FOREIGN KEY (attestation_command_id, device_id, binding_id, binding_revision) REFERENCES tinder_local_conversation_attestation_permits (command_id, device_id, binding_id, binding_revision) ON DELETE RESTRICT",
  "ALTER TABLE tinder_visible_chat_sync_permits ADD CONSTRAINT tinder_visible_chat_sync_permits_contract_version_check CHECK (permit_contract_version IN (1, 2))",
  "ALTER TABLE tinder_visible_chat_sync_permits ADD CONSTRAINT tinder_visible_chat_sync_permits_contract_attestation_check CHECK (",
  "CREATE INDEX idx_tinder_visible_chat_sync_permit_attestation_binding_created ON tinder_visible_chat_sync_permits"
]);

// SHA-256 of the reviewed source after only normalizing Windows line endings
// and surrounding blank space. Any executable, literal, relation, constraint,
// comment, or statement-order edit requires an intentional source review.
const REVIEWED_SOURCE_SHA256 = "7a8d3da70f7716f66a5295981029c7f063cde7ebf17b40f8f796ef35b90398e9";

function canonicalFixedSource(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

export function assertTinderLocalConversationAttestationMigrationSource(source) {
  const canonical = canonicalFixedSource(source);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (digest !== REVIEWED_SOURCE_SHA256) {
    throw new Error("Tinder local conversation attestation source is not an exact reviewed migration.");
  }
  return assertFixedTinderFoundationMigrationSource(canonical, {
    label: "Tinder local conversation attestation",
    expectedStatementHeads: EXPECTED_STATEMENT_HEADS
  });
}

export function validateTinderLocalConversationAttestationMigrationSource(source) {
  assertTinderLocalConversationAttestationMigrationSource(source);
  return { valid: true };
}

function lockedRelations() {
  // All relations exist before this additive migration. New attestation
  // relations cannot be locked before creation, while every predecessor whose
  // facts are inspected, referenced, or altered is locked against a TOCTOU.
  return [...new Set([
    ...REQUIRED_TABLES,
    "tinder_visible_chat_captures",
    "contact_human_armed_conversation_bindings",
    "contact_human_armed_conversation_binding_permits",
    "contact_human_armed_conversation_binding_audit",
    "tinder_visible_chat_sync_permits",
    "tinder_official_app_resume_permits",
    "tinder_visible_chat_sync_transcripts"
  ])];
}

const runner = createExplicitTinderFoundationMigrationRunner({
  label: "Tinder local conversation attestation",
  migrationSql: MIGRATION_SQL,
  validateSource: validateTinderLocalConversationAttestationMigrationSource,
  preflight: preflightTinderLocalConversationAttestationMigration,
  postcheck: async (client, { applied }) => {
    if (applied) {
      const foundation = await inspectTinderLocalConversationAttestationSchema(client);
      if (foundation.state !== TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE.CANONICAL) {
        throw createTinderFoundationMigrationDiagnosticError(
          "TINDER_LOCAL_CONVERSATION_ATTESTATION_POSTCHECK_SCHEMA_INVALID"
        );
      }
    }
    const checked = await preflightTinderLocalConversationAttestationMigration(client);
    if (applied) await assertTinderLocalConversationAttestationSchemaReady(client);
    return checked;
  },
  lockRelations: lockedRelations,
  advisoryLock: { namespace: 7421, key: 47 },
  transactionIsolation: "READ COMMITTED",
  diagnosticReasonCodes: TINDER_LOCAL_CONVERSATION_ATTESTATION_MIGRATION_DIAGNOSTIC_REASONS
});

/** Read-only rollback-only pre-DDL validation of the exact fixed runner. */
export const validateTinderLocalConversationAttestationPreDdl = runner.validatePreDdl;

/** Explicit only; no startup or device operation reaches this DDL authority. */
export const migrateTinderLocalConversationAttestation = runner.migrate;

export function getTinderLocalConversationAttestationMigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}
