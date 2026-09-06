import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  assertTinderIdentityFoundationSchemaReady,
  inspectTinderIdentityFoundationSchema,
  TINDER_IDENTITY_FOUNDATION_STATE,
  preflightTinderIdentityFoundationMigration
} from "./tinder-identity-foundation-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createTinderFoundationMigrationDiagnosticError,
  createExplicitTinderFoundationMigrationRunner,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";

/* ==================================================
T3 — EXPLICIT IDENTITY FOUNDATION MIGRATION
================================================== */

export const T3_IDENTITY_MIGRATION_DIAGNOSTIC_STAGES = TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;
export const T3_IDENTITY_MIGRATION_DIAGNOSTIC_REASONS = Object.freeze([
  "T3_POSTCHECK_IDENTITY_SCHEMA_INVALID"
]);

const T3_IDENTITY_MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260904_tinder_identity_foundation.sql", import.meta.url),
  "utf8"
);

const T3_EXPECTED_STATEMENT_HEADS = Object.freeze([
  "DO",
  "ALTER TABLE contacts ALTER COLUMN whatsapp_jid DROP NOT NULL",
  "ALTER TABLE contact_identifiers ADD COLUMN IF NOT EXISTS verification_source TEXT",
  "DO",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_identifiers_tinder_confirmed_unique",
  "CREATE INDEX IF NOT EXISTS idx_tinder_visible_chat_captures_mapping_time",
  "CREATE INDEX IF NOT EXISTS idx_tinder_visible_chat_captures_contact_time",
  "CREATE TABLE IF NOT EXISTS tinder_identity_mapping_audit",
  "CREATE INDEX IF NOT EXISTS idx_tinder_identity_mapping_audit_capture_time"
]);

export function assertTinderIdentityFoundationMigrationSource(source) {
  return assertFixedTinderFoundationMigrationSource(source, {
    label: "T3 identity foundation",
    expectedStatementHeads: T3_EXPECTED_STATEMENT_HEADS
  });
}

export function validateTinderIdentityFoundationMigrationSource(source) {
  assertTinderIdentityFoundationMigrationSource(source);
  return { valid: true };
}

function lockedRelations(preflight) {
  const relations = new Set([
    ...REQUIRED_TABLES,
    "contacts",
    "contact_identifiers",
    "tinder_visible_chat_captures"
  ]);
  if (preflight?.identity?.state === "CANONICAL") {
    relations.add("tinder_identity_mapping_audit");
  }
  return [...relations];
}

const runner = createExplicitTinderFoundationMigrationRunner({
  label: "T3 identity foundation",
  migrationSql: T3_IDENTITY_MIGRATION_SQL,
  validateSource: validateTinderIdentityFoundationMigrationSource,
  preflight: preflightTinderIdentityFoundationMigration,
  postcheck: async (client, { applied }) => {
    // Inspect before the strict preflight so a completed fixed T3 DDL that
    // still fails its own target contract produces one bounded, actionable
    // reason instead of an undifferentiated database-operation failure.
    // A catalog/query failure still escapes without a fabricated reason.
    if (applied) {
      const identity = await inspectTinderIdentityFoundationSchema(client);
      if (identity.state !== TINDER_IDENTITY_FOUNDATION_STATE.CANONICAL) {
        throw createTinderFoundationMigrationDiagnosticError(
          "T3_POSTCHECK_IDENTITY_SCHEMA_INVALID"
        );
      }
    }
    const checked = await preflightTinderIdentityFoundationMigration(client);
    if (applied) await assertTinderIdentityFoundationSchemaReady(client);
    return checked;
  },
  lockRelations: lockedRelations,
  advisoryLock: { namespace: 7421, key: 30 },
  diagnosticReasonCodes: T3_IDENTITY_MIGRATION_DIAGNOSTIC_REASONS
});

/** Read-only, rollback-only validation of the exact T3 pre-DDL path. */
export const validateTinderIdentityFoundationPreDdl = runner.validatePreDdl;

/** Explicit, unrouted T3 DDL authority. The CLI must require --apply. */
export const migrateTinderIdentityFoundation = runner.migrate;

export function getTinderIdentityFoundationMigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}
