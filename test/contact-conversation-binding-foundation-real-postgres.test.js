import assert from "node:assert/strict";
import test from "node:test";
import { migrateDeviceBridgeAckCanonicalization } from "../device-bridge/ack-canonicalization.js";
import { migrateDeviceBridgeSchema } from "../device-bridge/database.js";
import {
  assertContactConversationBindingFoundationSchemaReady,
  preflightContactConversationBindingFoundationMigration
} from "../device-bridge/contact-conversation-binding-foundation-schema.js";
import {
  getContactConversationBindingFoundationMigrationFailureDiagnostic,
  migrateContactConversationBindingFoundation,
  validateContactConversationBindingFoundationPreDdl
} from "../device-bridge/contact-conversation-binding-foundation-migration.js";
import {
  runContactConversationBindingFoundationPreflightCli
} from "../scripts/preflight-contact-conversation-binding-foundation.js";
import { verifyDeviceBridgeSchema } from "../device-bridge/schema-readiness.js";
import { migrateTinderIdentityFoundation } from "../device-bridge/tinder-identity-foundation-migration.js";
import { migrateTinderVisibleChatCaptureSchema } from "../device-bridge/tinder-visible-chat-capture-migration.js";
import {
  createDeviceBridgeLegacyRealPostgresFixture,
  withDisposableDeviceBridgeRealPostgresDatabase
} from "./helpers/device-bridge-real-postgres-fixture.js";

async function withClient(pool, callback) {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

async function createT3ContactFixture(pool) {
  await pool.query(`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY,
      whatsapp_jid TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE contact_identifiers (
      id BIGSERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL,
      identifier_type TEXT NOT NULL,
      identifier_value TEXT NOT NULL,
      normalized_value TEXT NOT NULL,
      source_platform TEXT,
      is_primary BOOLEAN,
      human_verified BOOLEAN,
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ
    )
  `);
}

async function prepareCanonicalT3Dependencies(pool) {
  await createDeviceBridgeLegacyRealPostgresFixture(pool);
  await createT3ContactFixture(pool);
  assert.deepEqual(await migrateDeviceBridgeAckCanonicalization(pool), { migrated: true });
  assert.deepEqual(await migrateDeviceBridgeSchema(pool), { migrated: true });
  assert.deepEqual(await verifyDeviceBridgeSchema(pool), { ready: true });
  assert.equal((await migrateTinderVisibleChatCaptureSchema(pool)).migrated, true);
  assert.equal((await migrateTinderIdentityFoundation(pool)).migrated, true);
}

function tracePool(pool, { afterQuery } = {}) {
  const records = [];
  let ended = false;
  return {
    records,
    get ended() { return ended; },
    async connect() {
      const rawClient = await pool.connect();
      return {
        async query(sql, params) {
          const record = { sql: String(sql), params: params || [] };
          records.push(record);
          const result = await rawClient.query(sql, params);
          await afterQuery?.({ ...record, rawClient, result, records });
          return result;
        },
        release(error) {
          return rawClient.release(error);
        }
      };
    },
    async end() {
      ended = true;
    }
  };
}

async function bindingTablesPresent(pool) {
  const result = await pool.query(`
    SELECT count(*)::integer AS relation_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname IN ('contact_conversation_bindings', 'contact_conversation_binding_audit')
  `);
  return result.rows[0]?.relation_count === 2;
}

test("real loopback PostgreSQL applies, postchecks, commits and rechecks the exact conversation-binding foundation", { timeout: 45_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareCanonicalT3Dependencies(pool);

    const before = await validateContactConversationBindingFoundationPreDdl(pool);
    assert.deepEqual(before, {
      migrated: false,
      preflight: { binding: { state: "ABSENT" }, mutate: true }
    });
    assert.equal(await bindingTablesPresent(pool), false);

    const applied = await migrateContactConversationBindingFoundation(pool);
    assert.deepEqual(applied, {
      migrated: true,
      preflight: { binding: { state: "ABSENT" }, mutate: true }
    });
    assert.equal(await bindingTablesPresent(pool), true);
    await withClient(pool, assertContactConversationBindingFoundationSchemaReady);

    const after = await validateContactConversationBindingFoundationPreDdl(pool);
    assert.deepEqual(after, {
      migrated: false,
      preflight: { binding: { state: "CANONICAL" }, mutate: false }
    });
  }, { prefix: "marcel_cbind" });
});

test("real loopback PostgreSQL operational preflight is repeatable-read read-only, reports eligibility, and makes no DDL or writes", { timeout: 45_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareCanonicalT3Dependencies(pool);
    const trace = tracePool(pool);
    const output = { log() {}, error() {} };
    const result = await runContactConversationBindingFoundationPreflightCli({
      environment: { DATABASE_URL: "postgres://test-only-not-used-by-injected-pool" },
      createPool: async () => trace,
      logger: output
    });
    assert.deepEqual(result, {
      ok: true,
      reason: "ELIGIBLE_FOR_MIGRATION",
      binding_state: "ABSENT",
      migration_required: true,
      transaction: "READ_ONLY_REPEATABLE_READ",
      rollback: "COMPLETED"
    });
    assert.equal(trace.records[0]?.sql.trim(), "BEGIN");
    assert.equal(trace.records[1]?.sql.trim(), "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    assert.equal(trace.records.at(-1)?.sql.trim(), "ROLLBACK");
    assert.equal(trace.records.some(record => /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|LOCK)\b/i.test(record.sql)), false);
    assert.equal(trace.ended, true);
    assert.equal(await bindingTablesPresent(pool), false);
  }, { prefix: "marcel_cbind_preflight" });
});

test("real loopback PostgreSQL operational preflight fails bounded on partial binding drift without DDL or writes", { timeout: 45_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareCanonicalT3Dependencies(pool);
    await pool.query("CREATE TABLE contact_conversation_bindings (id bigint)");
    const trace = tracePool(pool);
    const output = { log() {}, error() {} };
    const result = await runContactConversationBindingFoundationPreflightCli({
      environment: { DATABASE_URL: "postgres://test-only-not-used-by-injected-pool" },
      createPool: async () => trace,
      logger: output
    });
    assert.deepEqual(result, {
      ok: false,
      reason: "CONVERSATION_BINDING_SCHEMA_INCOMPATIBLE",
      binding_state: "UNRESOLVED",
      migration_required: "UNRESOLVED",
      transaction: "READ_ONLY_REPEATABLE_READ",
      rollback: "COMPLETED"
    });
    assert.equal(trace.records.some(record => /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|LOCK)\b/i.test(record.sql)), false);
    assert.equal(trace.ended, true);
  }, { prefix: "marcel_cbind_preflight_drift" });
});

test("real loopback PostgreSQL rolls back the whole binding foundation when the postcheck sees injected drift", { timeout: 45_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareCanonicalT3Dependencies(pool);
    let injected = false;
    const trace = tracePool(pool, {
      afterQuery: async ({ sql, rawClient }) => {
        if (!injected && sql.includes("CREATE TABLE IF NOT EXISTS contact_conversation_bindings")) {
          injected = true;
          await rawClient.query(
            "ALTER TABLE contact_conversation_binding_audit ADD COLUMN injected_postcheck_drift integer"
          );
        }
      }
    });

    const error = await migrateContactConversationBindingFoundation(trace).catch(value => value);
    assert.equal(injected, true);
    assert.deepEqual(getContactConversationBindingFoundationMigrationFailureDiagnostic(error), {
      stage: "POSTCHECK",
      code: "DATABASE_OPERATION_FAILED",
      transaction: "STARTED",
      rollback: "COMPLETED",
      ddl_started: true,
      reason: "CONVERSATION_BINDING_POSTCHECK_SCHEMA_INVALID"
    });
    assert.equal(trace.records.some(record => record.sql.trim() === "COMMIT"), false);
    assert.equal(trace.records.some(record => record.sql.trim() === "ROLLBACK"), true);
    assert.equal(await bindingTablesPresent(pool), false);
    const inspection = await withClient(pool, preflightContactConversationBindingFoundationMigration);
    assert.deepEqual(inspection, { binding: { state: "ABSENT" }, mutate: true });
  }, { prefix: "marcel_cbind_rb" });
});
