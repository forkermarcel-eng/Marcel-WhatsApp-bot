import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  assertHumanArmedConversationBindingFoundationSchemaReady,
  HUMAN_ARMED_CONVERSATION_BINDING_FOUNDATION_STATE,
  inspectHumanArmedConversationBindingFoundationSchema,
  preflightHumanArmedConversationBindingFoundationMigration
} from "./tinder-human-armed-conversation-binding-foundation-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createTinderFoundationMigrationDiagnosticError,
  createExplicitTinderFoundationMigrationRunner,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";

/* ==================================================
T2 HUMAN-ARMED CONVERSATION BINDING — EXPLICIT DDL

There is no startup, route or ingress owner for this migration. The only
future authority is this fixed runner after a separate human release.
================================================== */

export const HUMAN_ARMED_CONVERSATION_BINDING_MIGRATION_DIAGNOSTIC_STAGES =
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;
export const HUMAN_ARMED_CONVERSATION_BINDING_MIGRATION_DIAGNOSTIC_REASONS = Object.freeze([
  "HUMAN_ARMED_CONVERSATION_BINDING_POSTCHECK_SCHEMA_INVALID"
]);

const MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260907_tinder_human_armed_conversation_binding_foundation.sql", import.meta.url),
  "utf8"
);

const EXPECTED_STATEMENT_HEADS = Object.freeze([
  "ALTER TABLE device_bridge_commands DROP CONSTRAINT device_bridge_commands_command_type_check_v1",
  "ALTER TABLE device_bridge_commands ADD CONSTRAINT device_bridge_commands_command_type_check_v2",
  "CREATE TABLE IF NOT EXISTS contact_human_armed_conversation_bindings",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_human_armed_conversation_binding_active_device_ref",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_human_armed_conversation_binding_active_unscoped_ref",
  "CREATE INDEX IF NOT EXISTS idx_human_armed_conversation_binding_contact_state",
  "CREATE INDEX IF NOT EXISTS idx_human_armed_conversation_binding_source_capture",
  "CREATE TABLE IF NOT EXISTS contact_human_armed_conversation_binding_permits",
  "CREATE INDEX IF NOT EXISTS idx_harmed_conv_binding_permit_state_expiry",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_harmed_conv_binding_permit_consumed_capture",
  "CREATE TABLE IF NOT EXISTS contact_human_armed_conversation_binding_audit",
  "CREATE INDEX IF NOT EXISTS idx_human_armed_conversation_binding_audit_binding_time",
  "CREATE INDEX IF NOT EXISTS idx_human_armed_conversation_binding_audit_capture_time"
]);

export function assertHumanArmedConversationBindingFoundationMigrationSource(source) {
  return assertFixedTinderFoundationMigrationSource(source, {
    label: "Human-armed conversation binding foundation",
    expectedStatementHeads: EXPECTED_STATEMENT_HEADS
  });
}

export function validateHumanArmedConversationBindingFoundationMigrationSource(source) {
  assertHumanArmedConversationBindingFoundationMigrationSource(source);
  return { valid: true };
}

function lockedRelations(preflight) {
  const relations = new Set([
    ...REQUIRED_TABLES,
    "contacts",
    "contact_identifiers",
    "tinder_visible_chat_captures",
    "tinder_identity_mapping_audit",
    "contact_conversation_bindings",
    "contact_conversation_binding_audit"
  ]);
  if (preflight?.foundation?.state === "CANONICAL") {
    relations.add("contact_human_armed_conversation_bindings");
    relations.add("contact_human_armed_conversation_binding_permits");
    relations.add("contact_human_armed_conversation_binding_audit");
  }
  return [...relations];
}

const runner = createExplicitTinderFoundationMigrationRunner({
  label: "Human-armed conversation binding foundation",
  migrationSql: MIGRATION_SQL,
  validateSource: validateHumanArmedConversationBindingFoundationMigrationSource,
  preflight: preflightHumanArmedConversationBindingFoundationMigration,
  postcheck: async (client, { applied }) => {
    if (applied) {
      const foundation = await inspectHumanArmedConversationBindingFoundationSchema(client);
      if (foundation.state !== HUMAN_ARMED_CONVERSATION_BINDING_FOUNDATION_STATE.CANONICAL) {
        throw createTinderFoundationMigrationDiagnosticError(
          "HUMAN_ARMED_CONVERSATION_BINDING_POSTCHECK_SCHEMA_INVALID"
        );
      }
    }
    const checked = await preflightHumanArmedConversationBindingFoundationMigration(client);
    if (applied) await assertHumanArmedConversationBindingFoundationSchemaReady(client);
    return checked;
  },
  lockRelations: lockedRelations,
  advisoryLock: { namespace: 7421, key: 38 },
  diagnosticReasonCodes: HUMAN_ARMED_CONVERSATION_BINDING_MIGRATION_DIAGNOSTIC_REASONS
});

/** Read-only rollback-only pre-DDL validation of the exact fixed runner. */
export const validateHumanArmedConversationBindingFoundationPreDdl = runner.validatePreDdl;

/** Explicit only. No route or startup caller reaches this DDL authority. */
export const migrateHumanArmedConversationBindingFoundation = runner.migrate;

export function getHumanArmedConversationBindingFoundationMigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}
