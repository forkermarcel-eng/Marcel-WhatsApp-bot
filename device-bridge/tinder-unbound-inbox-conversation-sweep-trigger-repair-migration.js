import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  assertTinderUnboundInboxConversationSweepSchemaReady,
  inspectTinderUnboundInboxConversationSweepSchema,
  preflightTinderUnboundInboxConversationSweepTriggerRepair,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE
} from "./tinder-unbound-inbox-conversation-sweep-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createExplicitTinderFoundationMigrationRunner,
  createTinderFoundationMigrationDiagnosticError,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";

/* ==================================================
V8 UNBOUND INBOX SWEEP -- EXPLICIT IMMUTABLE TRIGGER REPAIR

This runner has one narrowly bounded authority: replace the exact historical
V8 immutable-trigger function with its corrected, table-scoped body.  It does
not recreate triggers, mutate sweep data, replay commands, or run at startup.
================================================== */

export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRIGGER_REPAIR_MIGRATION_DIAGNOSTIC_STAGES =
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRIGGER_REPAIR_MIGRATION_DIAGNOSTIC_REASONS = Object.freeze([
  "TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRIGGER_REPAIR_POSTCHECK_SCHEMA_INVALID"
]);

const MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260913_tinder_unbound_inbox_conversation_sweep_trigger_repair.sql", import.meta.url),
  "utf8"
);

const EXPECTED_STATEMENT_HEADS = Object.freeze([
  "CREATE OR REPLACE FUNCTION tinder_unbound_inbox_sweep_immutable_terminal_guard() RETURNS trigger LANGUAGE plpgsql AS"
]);

// SHA-256 of the complete reviewed repair source after line-ending and outer
// whitespace normalization.  The exact source is validated before connecting.
const REVIEWED_SOURCE_SHA256 = "a234585468af46ebd8b7c1947b34596f5c883040fde787db6adab55ba5f74e36";

function canonicalFixedSource(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

export function assertTinderUnboundInboxConversationSweepTriggerRepairMigrationSource(source) {
  const canonical = canonicalFixedSource(source);
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (digest !== REVIEWED_SOURCE_SHA256) {
    throw new Error("Tinder unbound Inbox conversation sweep trigger repair source is not an exact reviewed migration.");
  }
  return assertFixedTinderFoundationMigrationSource(canonical, {
    label: "Tinder unbound Inbox conversation sweep trigger repair",
    expectedStatementHeads: EXPECTED_STATEMENT_HEADS
  });
}

export function validateTinderUnboundInboxConversationSweepTriggerRepairMigrationSource(source) {
  assertTinderUnboundInboxConversationSweepTriggerRepairMigrationSource(source);
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
    TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE,
    TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE,
    TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE,
    TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE
  ])];
}

export function createTinderUnboundInboxConversationSweepTriggerRepairMigrationRunner({
  migrationSql = MIGRATION_SQL,
  validateSource = validateTinderUnboundInboxConversationSweepTriggerRepairMigrationSource,
  preflight = preflightTinderUnboundInboxConversationSweepTriggerRepair,
  inspectSchema = inspectTinderUnboundInboxConversationSweepSchema,
  assertSchemaReady = assertTinderUnboundInboxConversationSweepSchemaReady
} = {}) {
  return createExplicitTinderFoundationMigrationRunner({
    label: "Tinder unbound Inbox conversation sweep trigger repair",
    migrationSql,
    validateSource,
    preflight,
    postcheck: async (client, { applied }) => {
    if (applied) {
      const foundation = await inspectSchema(client);
      if (foundation.state !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.CANONICAL) {
        throw createTinderFoundationMigrationDiagnosticError(
          "TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRIGGER_REPAIR_POSTCHECK_SCHEMA_INVALID"
        );
      }
    }
    const checked = await preflight(client);
    if (applied) await assertSchemaReady(client);
    return checked;
    },
    lockRelations: lockedRelations,
    advisoryLock: { namespace: 7421, key: 50 },
    transactionIsolation: "READ COMMITTED",
    diagnosticReasonCodes: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRIGGER_REPAIR_MIGRATION_DIAGNOSTIC_REASONS
  });
}

const runner = createTinderUnboundInboxConversationSweepTriggerRepairMigrationRunner();

/** Read-only rollback-only pre-DDL validation of the exact repair runner. */
export const validateTinderUnboundInboxConversationSweepTriggerRepairPreDdl = runner.validatePreDdl;

/** Explicit only. No route, heartbeat, command, or startup path reaches this DDL authority. */
export const migrateTinderUnboundInboxConversationSweepTriggerRepair = runner.migrate;

export function getTinderUnboundInboxConversationSweepTriggerRepairMigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}
