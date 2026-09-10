import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  assertTinderOfficialAppResumePermitV2SchemaReady,
  inspectTinderOfficialAppResumePermitV2Schema,
  preflightTinderOfficialAppResumePermitV2Migration,
  TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE
} from "./tinder-visible-chat-sync-permit-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createExplicitTinderFoundationMigrationRunner,
  createTinderFoundationMigrationDiagnosticError,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";

/* ==================================================
TINDER OFFICIAL-APP RESUME PERMIT V2 — EXPLICIT DDL

This versioned runner is the only DDL authority for fresh, separately
auditable launcher-only permits.  It has no route, startup, heartbeat or
Android invocation path; importing it performs no database action.
================================================== */

export const TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_MIGRATION_DIAGNOSTIC_STAGES =
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;
export const TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_MIGRATION_DIAGNOSTIC_REASONS = Object.freeze([
  "TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_POSTCHECK_SCHEMA_INVALID"
]);

const MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260910_tinder_official_app_resume_permit_v2.sql", import.meta.url),
  "utf8"
);

const EXPECTED_STATEMENT_HEADS = Object.freeze([
  "ALTER TABLE tinder_official_app_resume_permits ADD COLUMN permit_contract_version SMALLINT NOT NULL DEFAULT 1",
  "ALTER TABLE tinder_official_app_resume_permits ALTER COLUMN permit_contract_version DROP DEFAULT",
  "ALTER TABLE tinder_official_app_resume_permits ADD COLUMN binding_id UUID",
  "ALTER TABLE tinder_official_app_resume_permits ADD COLUMN binding_revision INTEGER",
  "ALTER TABLE tinder_official_app_resume_permits DROP CONSTRAINT tinder_official_app_resume_permits_source_capture_id_key",
  "ALTER TABLE tinder_official_app_resume_permits ADD CONSTRAINT tinder_official_app_resume_permits_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES contact_human_armed_conversation_bindings(binding_id) ON DELETE RESTRICT",
  "ALTER TABLE tinder_official_app_resume_permits ADD CONSTRAINT tinder_official_app_resume_permits_contract_version_check CHECK (permit_contract_version IN (1, 2))",
  "ALTER TABLE tinder_official_app_resume_permits ADD CONSTRAINT tinder_official_app_resume_permits_contract_binding_check CHECK ( (permit_contract_version = 1 AND binding_id IS NULL AND binding_revision IS NULL) OR (permit_contract_version = 2 AND binding_id IS NOT NULL AND binding_revision IS NOT NULL AND binding_revision > 0) )",
  "CREATE INDEX idx_tinder_official_app_resume_permit_binding_revision_created ON tinder_official_app_resume_permits (binding_id, binding_revision, created_at DESC) WHERE binding_id IS NOT NULL"
]);

function normalizeExactFixedStatement(value) {
  // The reviewed V2 file has no SQL literals/comments whose semantics depend
  // on whitespace. Keeping the comparison local to this fixed migration
  // rejects appended ALTER subcommands that a head-only allowlist would miss.
  return String(value)
    .replace(/--[^\r\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function assertTinderOfficialAppResumePermitV2MigrationSource(source) {
  const statements = assertFixedTinderFoundationMigrationSource(source, {
    label: "Tinder official-app resume permit V2",
    expectedStatementHeads: EXPECTED_STATEMENT_HEADS
  });
  if (!statements.every((statement, index) =>
    normalizeExactFixedStatement(statement)
      === normalizeExactFixedStatement(EXPECTED_STATEMENT_HEADS[index])
  )) {
    throw new Error("Tinder official-app resume permit V2 source is not an exact reviewed migration.");
  }
  return statements;
}

export function validateTinderOfficialAppResumePermitV2MigrationSource(source) {
  assertTinderOfficialAppResumePermitV2MigrationSource(source);
  return { valid: true };
}

function lockedRelations() {
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
  label: "Tinder official-app resume permit V2",
  migrationSql: MIGRATION_SQL,
  validateSource: validateTinderOfficialAppResumePermitV2MigrationSource,
  preflight: preflightTinderOfficialAppResumePermitV2Migration,
  postcheck: async (client, { applied }) => {
    if (applied) {
      const foundation = await inspectTinderOfficialAppResumePermitV2Schema(client);
      if (foundation.state !== TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.CANONICAL) {
        throw createTinderFoundationMigrationDiagnosticError(
          "TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_POSTCHECK_SCHEMA_INVALID"
        );
      }
    }
    const checked = await preflightTinderOfficialAppResumePermitV2Migration(client);
    if (applied) await assertTinderOfficialAppResumePermitV2SchemaReady(client);
    return checked;
  },
  lockRelations: lockedRelations,
  advisoryLock: { namespace: 7421, key: 45 },
  diagnosticReasonCodes: TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_MIGRATION_DIAGNOSTIC_REASONS
});

/** Read-only rollback-only pre-DDL validation of the exact fixed runner. */
export const validateTinderOfficialAppResumePermitV2PreDdl = runner.validatePreDdl;

/** Explicit only. No route, startup caller or device command reaches this DDL authority. */
export const migrateTinderOfficialAppResumePermitV2 = runner.migrate;

export function getTinderOfficialAppResumePermitV2MigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}
