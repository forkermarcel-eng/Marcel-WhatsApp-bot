import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  assertContactConversationBindingFoundationSchemaReady,
  CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE,
  inspectContactConversationBindingFoundationSchema,
  preflightContactConversationBindingFoundationMigration
} from "./contact-conversation-binding-foundation-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createTinderFoundationMigrationDiagnosticError,
  createExplicitTinderFoundationMigrationRunner,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";

/* ==================================================
SHARED CHANNEL CONVERSATION BINDING — EXPLICIT MIGRATION

No startup import, route or runtime caller owns this DDL authority. A future
human-binding route may use it only after this explicit runner is separately
reviewed, released and invoked with --apply.
================================================== */

export const CONTACT_CONVERSATION_BINDING_MIGRATION_DIAGNOSTIC_STAGES =
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;
export const CONTACT_CONVERSATION_BINDING_MIGRATION_DIAGNOSTIC_REASONS = Object.freeze([
  "CONVERSATION_BINDING_POSTCHECK_SCHEMA_INVALID"
]);

const MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260907_contact_conversation_binding_foundation.sql", import.meta.url),
  "utf8"
);

const EXPECTED_STATEMENT_HEADS = Object.freeze([
  "DO",
  "CREATE TABLE IF NOT EXISTS contact_conversation_bindings",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_conversation_binding_active_device_ref",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_conversation_binding_active_unscoped_ref",
  "CREATE INDEX IF NOT EXISTS idx_contact_conversation_binding_contact_state",
  "CREATE INDEX IF NOT EXISTS idx_contact_conversation_binding_source_capture",
  "CREATE TABLE IF NOT EXISTS contact_conversation_binding_audit",
  "CREATE INDEX IF NOT EXISTS idx_contact_conversation_binding_audit_binding_time",
  "CREATE INDEX IF NOT EXISTS idx_contact_conversation_binding_audit_capture_time"
]);

export function assertContactConversationBindingFoundationMigrationSource(source) {
  return assertFixedTinderFoundationMigrationSource(source, {
    label: "Contact conversation binding foundation",
    expectedStatementHeads: EXPECTED_STATEMENT_HEADS
  });
}

export function validateContactConversationBindingFoundationMigrationSource(source) {
  assertContactConversationBindingFoundationMigrationSource(source);
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
  if (preflight?.binding?.state === "CANONICAL") {
    relations.add("contact_conversation_bindings");
    relations.add("contact_conversation_binding_audit");
  }
  return [...relations];
}

const runner = createExplicitTinderFoundationMigrationRunner({
  label: "Contact conversation binding foundation",
  migrationSql: MIGRATION_SQL,
  validateSource: validateContactConversationBindingFoundationMigrationSource,
  preflight: preflightContactConversationBindingFoundationMigration,
  postcheck: async (client, { applied }) => {
    // Preserve a bounded distinction between a fixed DDL that is visible but
    // structurally noncanonical and an unexpected catalog/query failure.
    // The latter deliberately remains generic and never leaks database data.
    if (applied) {
      const binding = await inspectContactConversationBindingFoundationSchema(client);
      if (binding.state !== CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE.CANONICAL) {
        throw createTinderFoundationMigrationDiagnosticError(
          "CONVERSATION_BINDING_POSTCHECK_SCHEMA_INVALID"
        );
      }
    }
    const checked = await preflightContactConversationBindingFoundationMigration(client);
    if (applied) await assertContactConversationBindingFoundationSchemaReady(client);
    return checked;
  },
  lockRelations: lockedRelations,
  advisoryLock: { namespace: 7421, key: 31 },
  diagnosticReasonCodes: CONTACT_CONVERSATION_BINDING_MIGRATION_DIAGNOSTIC_REASONS
});

export const validateContactConversationBindingFoundationPreDdl = runner.validatePreDdl;
export const migrateContactConversationBindingFoundation = runner.migrate;
export function getContactConversationBindingFoundationMigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}
