import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  assertTinderAutomationControlFoundationSchemaReady,
  preflightTinderAutomationControlFoundationMigration
} from "./tinder-automation-control-foundation-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createExplicitTinderFoundationMigrationRunner,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";

/* ==================================================
T7 — EXPLICIT PERSISTENT AUTOMATION-CONTROL MIGRATION

No import path registers this runner with startup, a route, a worker, a
device command, or an automation action. The CLI below is its sole future
mutation seam and separately requires --apply.
================================================== */

export const T7_AUTOMATION_CONTROL_MIGRATION_DIAGNOSTIC_STAGES = TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;

const T7_AUTOMATION_CONTROL_MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260906_tinder_automation_control_foundation.sql", import.meta.url),
  "utf8"
);

const T7_EXPECTED_STATEMENT_HEADS = Object.freeze([
  "DO",
  "CREATE TABLE IF NOT EXISTS tinder_automation_global_control",
  "INSERT INTO tinder_automation_global_control",
  "CREATE TABLE IF NOT EXISTS tinder_automation_contact_controls",
  "CREATE INDEX IF NOT EXISTS idx_tinder_automation_contact_controls_state",
  "CREATE TABLE IF NOT EXISTS tinder_automation_control_audit",
  "CREATE INDEX IF NOT EXISTS idx_tinder_automation_control_audit_scope_time",
  "CREATE INDEX IF NOT EXISTS idx_tinder_automation_control_audit_contact_time",
  "INSERT INTO tinder_automation_control_audit"
]);

export function assertTinderAutomationControlFoundationMigrationSource(source) {
  return assertFixedTinderFoundationMigrationSource(source, {
    label: "T7 Tinder automation-control foundation",
    expectedStatementHeads: T7_EXPECTED_STATEMENT_HEADS
  });
}

export function validateTinderAutomationControlFoundationMigrationSource(source) {
  assertTinderAutomationControlFoundationMigrationSource(source);
  return { valid: true };
}

function lockedRelations(preflight) {
  const relations = new Set([
    ...REQUIRED_TABLES,
    "contacts",
    "contact_identifiers",
    "tinder_visible_chat_captures",
    "tinder_identity_mapping_audit",
    "tinder_reply_drafts",
    "tinder_reply_draft_audit"
  ]);
  if (preflight?.automationControl?.state === "CANONICAL") {
    relations.add("tinder_automation_global_control");
    relations.add("tinder_automation_contact_controls");
    relations.add("tinder_automation_control_audit");
  }
  return [...relations];
}

const runner = createExplicitTinderFoundationMigrationRunner({
  label: "T7 Tinder automation-control foundation",
  migrationSql: T7_AUTOMATION_CONTROL_MIGRATION_SQL,
  validateSource: validateTinderAutomationControlFoundationMigrationSource,
  preflight: preflightTinderAutomationControlFoundationMigration,
  postcheck: async (client, { applied }) => {
    const checked = await preflightTinderAutomationControlFoundationMigration(client);
    if (applied) await assertTinderAutomationControlFoundationSchemaReady(client);
    return checked;
  },
  lockRelations: lockedRelations,
  advisoryLock: { namespace: 7421, key: 70 }
});

/** Read-only, rollback-only validation of the exact T7 pre-DDL path. */
export const validateTinderAutomationControlFoundationPreDdl = runner.validatePreDdl;

/** Explicit, unrouted T7 DDL authority. The CLI must require --apply. */
export const migrateTinderAutomationControlFoundation = runner.migrate;

export function getTinderAutomationControlFoundationMigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}
