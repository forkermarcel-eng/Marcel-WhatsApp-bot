import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  assertTinderManualSendCommandSchemaReady,
  inspectTinderManualSendCommandSchema,
  preflightTinderManualSendCommandMigration,
  TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE
} from "./tinder-manual-send-command-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createExplicitTinderFoundationMigrationRunner,
  createTinderFoundationMigrationDiagnosticError,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";

/* ==================================================
T5 SIGNED SEND-COMMAND â€” EXPLICIT VOCABULARY DDL

No route, import or startup path invokes this runner.  Its two fixed ALTER
statements are the sole Production DDL authority for enabling the T5 command
type after a separately approved preflight.
================================================== */

export const T5_MANUAL_SEND_COMMAND_MIGRATION_DIAGNOSTIC_STAGES =
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;
export const T5_MANUAL_SEND_COMMAND_MIGRATION_DIAGNOSTIC_REASONS = Object.freeze([
  "T5_MANUAL_SEND_COMMAND_POSTCHECK_SCHEMA_INVALID"
]);

const MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260907_tinder_manual_send_command_protocol.sql", import.meta.url),
  "utf8"
);

const EXPECTED_STATEMENT_HEADS = Object.freeze([
  "ALTER TABLE device_bridge_commands DROP CONSTRAINT device_bridge_commands_command_type_check_v2",
  "ALTER TABLE device_bridge_commands ADD CONSTRAINT device_bridge_commands_command_type_check_v3"
]);

export function assertTinderManualSendCommandMigrationSource(source) {
  return assertFixedTinderFoundationMigrationSource(source, {
    label: "T5 Tinder manual-send command protocol",
    expectedStatementHeads: EXPECTED_STATEMENT_HEADS
  });
}

export function validateTinderManualSendCommandMigrationSource(source) {
  assertTinderManualSendCommandMigrationSource(source);
  return { valid: true };
}

function lockedRelations() {
  return [
    ...new Set([
      ...REQUIRED_TABLES,
      "contacts",
      "contact_identifiers",
      "tinder_visible_chat_captures",
      "tinder_identity_mapping_audit",
      "contact_conversation_bindings",
      "contact_conversation_binding_audit",
      "tinder_reply_drafts",
      "tinder_reply_draft_audit",
      "tinder_reply_send_approvals",
      "tinder_reply_send_intents",
      "tinder_reply_send_audit"
    ])
  ];
}

export function createTinderManualSendCommandMigrationRunner({
  migrationSql = MIGRATION_SQL,
  preflight = preflightTinderManualSendCommandMigration,
  inspectSchema = inspectTinderManualSendCommandSchema,
  assertSchemaReady = assertTinderManualSendCommandSchemaReady
} = {}) {
  return createExplicitTinderFoundationMigrationRunner({
  label: "T5 Tinder manual-send command protocol",
  migrationSql,
  validateSource: validateTinderManualSendCommandMigrationSource,
  preflight,
  postcheck: async (client, { applied }) => {
    if (applied) {
      const inspection = await inspectSchema(client);
      if (inspection.state !== TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE.CANONICAL) {
        throw createTinderFoundationMigrationDiagnosticError(
          "T5_MANUAL_SEND_COMMAND_POSTCHECK_SCHEMA_INVALID"
        );
      }
    }
    const checked = await preflight(client);
    if (applied) await assertSchemaReady(client);
    return checked;
  },
  lockRelations: lockedRelations,
  advisoryLock: { namespace: 7421, key: 51 },
  diagnosticReasonCodes: T5_MANUAL_SEND_COMMAND_MIGRATION_DIAGNOSTIC_REASONS
  });
}

const runner = createTinderManualSendCommandMigrationRunner();

/** Explicit rollback-only pre-DDL validation. */
export const validateTinderManualSendCommandPreDdl = runner.validatePreDdl;

/** Explicit only. It owns no other schema or data change. */
export const migrateTinderManualSendCommand = runner.migrate;

export function getTinderManualSendCommandMigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}
