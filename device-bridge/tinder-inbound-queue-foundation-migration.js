import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  assertTinderInboundQueueFoundationSchemaReady,
  preflightTinderInboundQueueFoundationMigration
} from "./tinder-inbound-queue-foundation-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createExplicitTinderFoundationMigrationRunner,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";

/* ==================================================
T6 — EXPLICIT INBOUND QUEUE FOUNDATION MIGRATION
================================================== */

export const T6_INBOUND_QUEUE_MIGRATION_DIAGNOSTIC_STAGES = TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;
const T6_INBOUND_QUEUE_MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260905_tinder_inbound_queue_foundation.sql", import.meta.url), "utf8"
);
const T6_EXPECTED_STATEMENT_HEADS = Object.freeze([
  "DO",
  "CREATE TABLE IF NOT EXISTS tinder_inbound_work_items",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_tinder_inbound_work_one_open_thread",
  "CREATE INDEX IF NOT EXISTS idx_tinder_inbound_work_due",
  "CREATE INDEX IF NOT EXISTS idx_tinder_inbound_work_contact_status",
  "CREATE TABLE IF NOT EXISTS tinder_inbound_work_events",
  "CREATE INDEX IF NOT EXISTS idx_tinder_inbound_work_events_work_time",
  "CREATE TABLE IF NOT EXISTS tinder_inbound_work_audit",
  "CREATE INDEX IF NOT EXISTS idx_tinder_inbound_work_audit_work_time"
]);

export function assertTinderInboundQueueFoundationMigrationSource(source) {
  return assertFixedTinderFoundationMigrationSource(source, {
    label: "T6 Tinder inbound queue foundation", expectedStatementHeads: T6_EXPECTED_STATEMENT_HEADS
  });
}

export function validateTinderInboundQueueFoundationMigrationSource(source) {
  assertTinderInboundQueueFoundationMigrationSource(source);
  return { valid: true };
}

function lockedRelations(preflight) {
  const relations = new Set([
    ...REQUIRED_TABLES,
    "contacts", "contact_identifiers", "tinder_visible_chat_captures", "tinder_identity_mapping_audit",
    "tinder_reply_drafts", "tinder_reply_draft_audit"
  ]);
  if (preflight?.inboundQueue?.state === "CANONICAL") {
    relations.add("tinder_inbound_work_items");
    relations.add("tinder_inbound_work_events");
    relations.add("tinder_inbound_work_audit");
  }
  return [...relations];
}

const runner = createExplicitTinderFoundationMigrationRunner({
  label: "T6 Tinder inbound queue foundation",
  migrationSql: T6_INBOUND_QUEUE_MIGRATION_SQL,
  validateSource: validateTinderInboundQueueFoundationMigrationSource,
  preflight: preflightTinderInboundQueueFoundationMigration,
  postcheck: async (client, { applied }) => {
    const checked = await preflightTinderInboundQueueFoundationMigration(client);
    if (applied) await assertTinderInboundQueueFoundationSchemaReady(client);
    return checked;
  },
  lockRelations: lockedRelations,
  advisoryLock: { namespace: 7421, key: 60 }
});

export const validateTinderInboundQueueFoundationPreDdl = runner.validatePreDdl;
export const migrateTinderInboundQueueFoundation = runner.migrate;
export function getTinderInboundQueueFoundationMigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}
