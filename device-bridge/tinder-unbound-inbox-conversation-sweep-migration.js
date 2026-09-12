import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  assertTinderUnboundInboxConversationSweepSchemaReady,
  inspectTinderUnboundInboxConversationSweepSchema,
  preflightTinderUnboundInboxConversationSweepMigration,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE
} from "./tinder-unbound-inbox-conversation-sweep-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createExplicitTinderFoundationMigrationRunner,
  createTinderFoundationMigrationDiagnosticError,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";

/* ==================================================
UNBOUND INBOX-CONVERSATION SWEEP -- EXPLICIT V8 DDL

No startup, dashboard route, heartbeat, child command, ingress, V4 sync, or
human-binding path can reach this runner. It is a future,
separately approved DDL authority only.
================================================== */

export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_MIGRATION_DIAGNOSTIC_STAGES =
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_MIGRATION_DIAGNOSTIC_REASONS = Object.freeze([
  "TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_POSTCHECK_SCHEMA_INVALID"
]);

const MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260912_tinder_unbound_inbox_conversation_sweep_foundation.sql", import.meta.url),
  "utf8"
);

const EXPECTED_STATEMENT_HEADS = Object.freeze([
  "ALTER TABLE device_bridge_commands DROP CONSTRAINT device_bridge_commands_command_type_check_v6",
  "ALTER TABLE device_bridge_commands ADD CONSTRAINT device_bridge_commands_command_type_check_v8 CHECK (command_type IN",
  "CREATE TABLE tinder_unbound_inbox_conversation_sweeps",
  "CREATE UNIQUE INDEX idx_tinder_unbound_inbox_conversation_sweep_active_device ON tinder_unbound_inbox_conversation_sweeps",
  "CREATE INDEX idx_tinder_unbound_inbox_conversation_sweep_device_expiry ON tinder_unbound_inbox_conversation_sweeps",
  "CREATE TABLE tinder_unbound_inbox_conversation_sweep_steps",
  "ALTER TABLE tinder_unbound_inbox_conversation_sweep_steps ADD CONSTRAINT tinder_unbound_inbox_conversation_sweep_steps_command_device_fkey FOREIGN KEY (command_id, device_id) REFERENCES device_bridge_commands(command_id, device_id) ON DELETE RESTRICT",
  "ALTER TABLE tinder_unbound_inbox_conversation_sweep_steps ADD CONSTRAINT tinder_unbound_inbox_conversation_sweep_steps_sweep_device_fkey FOREIGN KEY (sweep_id, device_id) REFERENCES tinder_unbound_inbox_conversation_sweeps(sweep_id, device_id) ON DELETE RESTRICT",
  "CREATE UNIQUE INDEX idx_tinder_unbound_inbox_conversation_sweep_active_child_device ON tinder_unbound_inbox_conversation_sweep_steps",
  "CREATE INDEX idx_tinder_unbound_inbox_conversation_sweep_steps_sweep_slot ON tinder_unbound_inbox_conversation_sweep_steps",
  "CREATE INDEX idx_tinder_unbound_inbox_conversation_sweep_steps_device_expiry ON tinder_unbound_inbox_conversation_sweep_steps",
  "CREATE TABLE tinder_unbound_inbox_conversation_sweep_transcripts",
  "ALTER TABLE tinder_unbound_inbox_conversation_sweep_transcripts ADD CONSTRAINT tinder_unbound_inbox_conversation_sweep_transcripts_command_device_fkey FOREIGN KEY (command_id, device_id) REFERENCES tinder_unbound_inbox_conversation_sweep_steps(command_id, device_id) ON DELETE RESTRICT",
  "ALTER TABLE tinder_unbound_inbox_conversation_sweep_transcripts ADD CONSTRAINT tinder_unbound_inbox_conversation_sweep_transcripts_step_scope_fkey FOREIGN KEY (command_id, sweep_id, device_id) REFERENCES tinder_unbound_inbox_conversation_sweep_steps(command_id, sweep_id, device_id) ON DELETE RESTRICT",
  "ALTER TABLE tinder_unbound_inbox_conversation_sweep_steps ADD CONSTRAINT tinder_unbound_inbox_conversation_sweep_steps_transcript_scope FOREIGN KEY (transcript_id, command_id, sweep_id, device_id) REFERENCES tinder_unbound_inbox_conversation_sweep_transcripts(transcript_id, command_id, sweep_id, device_id) ON DELETE RESTRICT",
  "CREATE INDEX idx_tinder_unbound_inbox_conversation_sweep_transcript_device_received ON tinder_unbound_inbox_conversation_sweep_transcripts",
  "CREATE INDEX idx_tinder_unbound_inbox_conversation_sweep_transcript_pending_received ON tinder_unbound_inbox_conversation_sweep_transcripts",
  "CREATE TABLE tinder_unbound_inbox_conversation_sweep_audit",
  "ALTER TABLE tinder_unbound_inbox_conversation_sweep_audit ADD CONSTRAINT tinder_unbound_inbox_conversation_sweep_audit_sweep_device_fkey FOREIGN KEY (sweep_id, device_id) REFERENCES tinder_unbound_inbox_conversation_sweeps(sweep_id, device_id) ON DELETE RESTRICT",
  "ALTER TABLE tinder_unbound_inbox_conversation_sweep_audit ADD CONSTRAINT tinder_unbound_inbox_conversation_sweep_audit_step_scope_fkey FOREIGN KEY (command_id, sweep_id, device_id) REFERENCES tinder_unbound_inbox_conversation_sweep_steps(command_id, sweep_id, device_id) ON DELETE RESTRICT",
  "ALTER TABLE tinder_unbound_inbox_conversation_sweep_audit ADD CONSTRAINT tinder_unbound_inbox_conversation_sweep_audit_transcript_scope_fkey FOREIGN KEY (transcript_id, command_id, sweep_id, device_id) REFERENCES tinder_unbound_inbox_conversation_sweep_transcripts(transcript_id, command_id, sweep_id, device_id) ON DELETE RESTRICT",
  "CREATE INDEX idx_tinder_unbound_inbox_conversation_sweep_audit_sweep_created ON tinder_unbound_inbox_conversation_sweep_audit",
  "CREATE INDEX idx_tinder_unbound_inbox_conversation_sweep_audit_command_created ON tinder_unbound_inbox_conversation_sweep_audit",
  "CREATE FUNCTION tinder_unbound_inbox_conversation_sweep_immutable_terminal_guard() RETURNS trigger LANGUAGE plpgsql AS",
  "CREATE FUNCTION tinder_unbound_inbox_conversation_sweep_active_child_guard() RETURNS trigger LANGUAGE plpgsql AS",
  "CREATE FUNCTION tinder_unbound_inbox_conversation_sweep_audit_scope_guard() RETURNS trigger LANGUAGE plpgsql AS",
  "CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_terminal_immutable BEFORE UPDATE OR DELETE ON tinder_unbound_inbox_conversation_sweeps",
  "CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_step_terminal_immutable BEFORE UPDATE OR DELETE ON tinder_unbound_inbox_conversation_sweep_steps",
  "CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_transcript_immutable BEFORE UPDATE OR DELETE ON tinder_unbound_inbox_conversation_sweep_transcripts",
  "CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_audit_immutable BEFORE UPDATE OR DELETE ON tinder_unbound_inbox_conversation_sweep_audit",
  "CREATE CONSTRAINT TRIGGER tinder_unbound_inbox_conversation_sweep_active_child_scope AFTER INSERT OR UPDATE ON tinder_unbound_inbox_conversation_sweeps DEFERRABLE INITIALLY DEFERRED",
  "CREATE CONSTRAINT TRIGGER tinder_unbound_inbox_conversation_sweep_step_active_child_scope AFTER INSERT OR DELETE OR UPDATE ON tinder_unbound_inbox_conversation_sweep_steps DEFERRABLE INITIALLY DEFERRED",
  "CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_audit_scope BEFORE INSERT OR UPDATE ON tinder_unbound_inbox_conversation_sweep_audit"
]);

// SHA-256 of the complete reviewed fixed source after line-ending and outer
// whitespace normalization. Any relation, literal, trigger, or SQL ordering
// change requires a deliberate review and a new digest.
const REVIEWED_SOURCE_SHA256 = "182aaabf0ccbd8619553caff02db467c8e50da476728b2a7a79c8f2e0230338c";

function canonicalFixedSource(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

export function assertTinderUnboundInboxConversationSweepMigrationSource(source) {
  const canonical = canonicalFixedSource(source);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (digest !== REVIEWED_SOURCE_SHA256) {
    throw new Error("Tinder unbound Inbox conversation sweep source is not an exact reviewed migration.");
  }
  return assertFixedTinderFoundationMigrationSource(canonical, {
    label: "Tinder unbound Inbox conversation sweep",
    expectedStatementHeads: EXPECTED_STATEMENT_HEADS
  });
}

export function validateTinderUnboundInboxConversationSweepMigrationSource(source) {
  assertTinderUnboundInboxConversationSweepMigrationSource(source);
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
  ])];
}

const runner = createExplicitTinderFoundationMigrationRunner({
  label: "Tinder unbound Inbox conversation sweep",
  migrationSql: MIGRATION_SQL,
  validateSource: validateTinderUnboundInboxConversationSweepMigrationSource,
  preflight: preflightTinderUnboundInboxConversationSweepMigration,
  postcheck: async (client, { applied }) => {
    if (applied) {
      const foundation = await inspectTinderUnboundInboxConversationSweepSchema(client);
      if (foundation.state !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.CANONICAL) {
        throw createTinderFoundationMigrationDiagnosticError(
          "TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_POSTCHECK_SCHEMA_INVALID"
        );
      }
    }
    const checked = await preflightTinderUnboundInboxConversationSweepMigration(client);
    if (applied) await assertTinderUnboundInboxConversationSweepSchemaReady(client);
    return checked;
  },
  lockRelations: lockedRelations,
  advisoryLock: { namespace: 7421, key: 50 },
  transactionIsolation: "READ COMMITTED",
  diagnosticReasonCodes: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_MIGRATION_DIAGNOSTIC_REASONS
});

/** Read-only rollback-only pre-DDL validation of the exact fixed runner. */
export const validateTinderUnboundInboxConversationSweepPreDdl = runner.validatePreDdl;

/** Explicit only. No route, child command, or heartbeat reaches this DDL authority. */
export const migrateTinderUnboundInboxConversationSweepFoundation = runner.migrate;

export function getTinderUnboundInboxConversationSweepMigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}
