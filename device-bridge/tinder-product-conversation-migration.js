import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertTinderProductConversationSchemaReady,
  inspectTinderProductConversationSchema,
  preflightTinderProductConversationMigration,
  TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE,
  TINDER_PRODUCT_CONVERSATION_TABLE,
  TINDER_PRODUCT_CONVERSATION_CAPTURE_LINK_TABLE
} from "./tinder-product-conversation-schema.js";
import {
  assertFixedTinderFoundationMigrationSource,
  createExplicitTinderFoundationMigrationRunner,
  createTinderFoundationMigrationDiagnosticError,
  getTinderFoundationMigrationFailureDiagnostic,
  TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES
} from "./tinder-foundation-migration-utils.js";

/* ==================================================
TINDER PRODUCT CONVERSATION MIGRATION

The runner owns exactly the additive product schema.  It never reconciles
historical rows, replays commands, or alters any Vx command constraint.
================================================== */

export const TINDER_PRODUCT_CONVERSATION_MIGRATION_DIAGNOSTIC_STAGES = TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES;
export const TINDER_PRODUCT_CONVERSATION_MIGRATION_DIAGNOSTIC_REASONS = Object.freeze([
  "TINDER_PRODUCT_CONVERSATION_POSTCHECK_SCHEMA_INVALID"
]);

const PRODUCT_CONVERSATION_MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260922_tinder_product_conversations.sql", import.meta.url),
  "utf8"
);

// This is the SHA-256 of the reviewed fixed source above.  A source change is
// a new migration review, never an untracked change to a live DDL runner.
const PRODUCT_CONVERSATION_MIGRATION_SOURCE_SHA256 = "c869ef2d2a46095a977acf50f4616ae553b6dbade92a10c24ccb45c217e69068";

const EXPECTED_STATEMENT_HEADS = Object.freeze([
  "CREATE TABLE tinder_thread_conversations",
  "CREATE INDEX idx_tinder_thread_conversations_device_hint",
  "CREATE INDEX idx_tinder_thread_conversations_device_updated",
  "CREATE UNIQUE INDEX idx_tinder_visible_chat_captures_capture_device",
  "CREATE TABLE tinder_thread_conversation_capture_links",
  "CREATE INDEX idx_tinder_thread_conversation_capture_links_conversation_time"
]);

function canonicalMigrationSource(source) {
  // The reviewed SQL semantics are fixed.  Git's Windows checkout conversion
  // must not make the same source fail merely because LF became CRLF, nor
  // should harmless outer whitespace produce a different migration identity.
  return String(source).replace(/\r\n?/g, "\n").trim();
}

function sourceSha256(source) {
  return crypto.createHash("sha256").update(canonicalMigrationSource(source), "utf8").digest("hex");
}

export function assertTinderProductConversationMigrationSource(source) {
  const canonical = canonicalMigrationSource(source);
  const statements = assertFixedTinderFoundationMigrationSource(canonical, {
    label: "Tinder product conversation",
    expectedStatementHeads: EXPECTED_STATEMENT_HEADS
  });
  if (sourceSha256(canonical) !== PRODUCT_CONVERSATION_MIGRATION_SOURCE_SHA256) {
    throw new Error("Tinder product conversation migration source is invalid.");
  }
  return statements;
}

export function validateTinderProductConversationMigrationSource(source) {
  assertTinderProductConversationMigrationSource(source);
  return { valid: true };
}

function lockedRelations(preflight) {
  const relations = new Set([
    "device_bridge_devices",
    "contacts",
    "tinder_visible_chat_captures"
  ]);
  // Never lock a target relation before it exists.  The V9 lock failure came
  // from treating an ABSENT target as if it were already a predecessor.
  if (preflight?.foundation?.state === TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE.CANONICAL) {
    relations.add(TINDER_PRODUCT_CONVERSATION_TABLE);
    relations.add(TINDER_PRODUCT_CONVERSATION_CAPTURE_LINK_TABLE);
  }
  return [...relations];
}

/**
 * The injectable factory exists only so focused local regressions can exercise
 * the fixed runner contract. Runtime and CLI code use the source-owned
 * instance below; callers cannot supply SQL through any route or startup path.
 */
export function createTinderProductConversationMigrationRunner({
  migrationSql = PRODUCT_CONVERSATION_MIGRATION_SQL,
  validateSource = validateTinderProductConversationMigrationSource,
  preflight = preflightTinderProductConversationMigration,
  inspectSchema = inspectTinderProductConversationSchema,
  assertSchemaReady = assertTinderProductConversationSchemaReady
} = {}) {
  return createExplicitTinderFoundationMigrationRunner({
    label: "Tinder product conversation",
    migrationSql,
    validateSource,
    preflight,
    postcheck: async (client, { applied }) => {
      if (applied) {
        const inspection = await inspectSchema(client);
        if (inspection.state !== TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE.CANONICAL) {
          throw createTinderFoundationMigrationDiagnosticError(
            "TINDER_PRODUCT_CONVERSATION_POSTCHECK_SCHEMA_INVALID"
          );
        }
      }
      const checked = await preflight(client);
      if (applied) await assertSchemaReady(client);
      return checked;
    },
    lockRelations: lockedRelations,
    advisoryLock: { namespace: 7421, key: 111 },
    diagnosticReasonCodes: TINDER_PRODUCT_CONVERSATION_MIGRATION_DIAGNOSTIC_REASONS,
    transactionIsolation: "READ COMMITTED"
  });
}

const runner = createTinderProductConversationMigrationRunner();

/** Read-only, rollback-only validation of the exact pre-DDL path. */
export const validateTinderProductConversationPreDdl = runner.validatePreDdl;

/** Explicit, unrouted DDL authority. The CLI must require --apply. */
export async function migrateTinderProductConversation(pool) {
  const result = await runner.migrate(pool);
  if (!result || typeof result.migrated !== "boolean") {
    throw new Error("Tinder product conversation migration did not confirm its commit result.");
  }
  // The runner returns only after its COMMIT query resolves.  Make that fact
  // explicit at this module boundary so the CLI never turns an arbitrary
  // resolved object into a claimed production commit.
  return Object.freeze({
    ...result,
    migrated: result.migrated,
    commitConfirmed: true
  });
}

export function getTinderProductConversationMigrationFailureDiagnostic(error) {
  return getTinderFoundationMigrationFailureDiagnostic(error);
}

export { PRODUCT_CONVERSATION_MIGRATION_SOURCE_SHA256 };
