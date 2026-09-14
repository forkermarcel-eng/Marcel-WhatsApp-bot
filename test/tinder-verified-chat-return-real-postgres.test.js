import assert from "node:assert/strict";
import test from "node:test";
import { migrateDeviceBridgeAckCanonicalization } from "../device-bridge/ack-canonicalization.js";
import { migrateDeviceBridgeSchema } from "../device-bridge/database.js";
import { verifyDeviceBridgeSchema } from "../device-bridge/schema-readiness.js";
import { migrateContactConversationBindingFoundation } from "../device-bridge/contact-conversation-binding-foundation-migration.js";
import { migrateTinderIdentityFoundation } from "../device-bridge/tinder-identity-foundation-migration.js";
import { migrateTinderVisibleChatCaptureSchema } from "../device-bridge/tinder-visible-chat-capture-migration.js";
import { migrateTinderDraftFoundation } from "../device-bridge/tinder-draft-foundation-migration.js";
import { migrateTinderManualSendFoundation } from "../device-bridge/tinder-manual-send-foundation-migration.js";
import { migrateTinderManualSendCommand } from "../device-bridge/tinder-manual-send-command-migration.js";
import { migrateHumanArmedConversationBindingFoundation } from "../device-bridge/tinder-human-armed-conversation-binding-foundation-migration.js";
import { migrateTinderVisibleChatSyncPermitFoundation } from "../device-bridge/tinder-visible-chat-sync-permit-migration.js";
import { migrateTinderOfficialAppResumePermitV2 } from "../device-bridge/tinder-official-app-resume-permit-v2-migration.js";
import { migrateTinderLocalConversationAttestation } from "../device-bridge/tinder-local-conversation-attestation-migration.js";
import { migrateTinderUnboundInboxConversationSweepFoundation } from "../device-bridge/tinder-unbound-inbox-conversation-sweep-migration.js";
import {
  assertTinderVerifiedChatReturnSchemaReady
} from "../device-bridge/tinder-verified-chat-return-schema.js";
import {
  assertTinderUnboundInboxConversationSweepRuntimeSchemaReady
} from "../device-bridge/tinder-unbound-inbox-conversation-sweep-runtime-schema.js";
import {
  migrateTinderVerifiedChatReturnFoundation,
  validateTinderVerifiedChatReturnPreDdl
} from "../device-bridge/tinder-verified-chat-return-migration.js";
import {
  runTinderVerifiedChatReturnPreflightCli
} from "../scripts/preflight-tinder-verified-chat-return.js";

/*
 * Opt-in only: the fixture itself refuses anything except the explicitly
 * supplied loopback DEVICE_BRIDGE_REAL_PG_TEST_URL and creates a disposable
 * database.  This suite never reads the application's DATABASE_URL.
 */

const REAL_PG_TEST_URL_CONFIGURED = typeof process.env.DEVICE_BRIDGE_REAL_PG_TEST_URL === "string"
  && process.env.DEVICE_BRIDGE_REAL_PG_TEST_URL.trim().length > 0;

async function loopbackFixture() {
  // Keep the opt-in dependency lazy: without the dedicated variable this
  // suite is skipped before it resolves `pg` or attempts any connection.
  return import("./helpers/device-bridge-real-postgres-fixture.js");
}

async function createContactFixture(pool) {
  await pool.query("CREATE TABLE contacts (id SERIAL PRIMARY KEY, whatsapp_jid TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())");
  await pool.query("CREATE TABLE contact_identifiers (id BIGSERIAL PRIMARY KEY, contact_id INTEGER NOT NULL, identifier_type TEXT NOT NULL, identifier_value TEXT NOT NULL, normalized_value TEXT NOT NULL, source_platform TEXT, is_primary BOOLEAN, human_verified BOOLEAN, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)");
  await pool.query("ALTER TABLE contacts ADD COLUMN display_name TEXT, ADD COLUMN canonical_name TEXT, ADD COLUMN memory_identity_key TEXT, ADD COLUMN identity_locked BOOLEAN DEFAULT FALSE, ADD COLUMN source_platform TEXT, ADD COLUMN current_platform TEXT, ADD COLUMN platform_status TEXT, ADD COLUMN contact_status TEXT DEFAULT 'active', ADD COLUMN relationship_stage TEXT DEFAULT 'new', ADD COLUMN auto_reply_enabled BOOLEAN DEFAULT TRUE, ADD COLUMN manual_review_required BOOLEAN DEFAULT FALSE, ADD COLUMN first_contact_at TIMESTAMPTZ");
  await pool.query("CREATE TABLE contact_memory_profiles (contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE)");
}

async function prepareV8Foundation(pool, { createDeviceBridgeLegacyRealPostgresFixture }) {
  await createDeviceBridgeLegacyRealPostgresFixture(pool);
  await createContactFixture(pool);
  await migrateDeviceBridgeAckCanonicalization(pool);
  await migrateDeviceBridgeSchema(pool);
  assert.deepEqual(await verifyDeviceBridgeSchema(pool), { ready: true });
  await migrateTinderVisibleChatCaptureSchema(pool);
  await migrateTinderIdentityFoundation(pool);
  await migrateContactConversationBindingFoundation(pool);
  await migrateTinderDraftFoundation(pool);
  await migrateTinderManualSendFoundation(pool);
  await migrateHumanArmedConversationBindingFoundation(pool);
  await migrateTinderManualSendCommand(pool);
  await migrateTinderVisibleChatSyncPermitFoundation(pool);
  await migrateTinderOfficialAppResumePermitV2(pool);
  await migrateTinderLocalConversationAttestation(pool);
  const v8 = await migrateTinderUnboundInboxConversationSweepFoundation(pool);
  assert.equal(v8.migrated, true);
}

function tracePool(pool) {
  const records = [];
  return {
    records,
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params) {
          records.push({ sql: String(sql), params: params || [] });
          return client.query(sql, params);
        },
        release(error) { return client.release(error); }
      };
    },
    async end() {}
  };
}

test("real loopback PostgreSQL applies V8 -> V9, postchecks canonical, commits, and preserves protected canonical preflight", {
  timeout: 60_000,
  skip: !REAL_PG_TEST_URL_CONFIGURED && "DEVICE_BRIDGE_REAL_PG_TEST_URL is not configured"
}, async () => {
  const fixture = await loopbackFixture();
  await fixture.withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV8Foundation(pool, fixture);

    assert.deepEqual(await validateTinderVerifiedChatReturnPreDdl(pool), {
      migrated: false,
      preflight: { foundation: { state: "UPGRADE_REQUIRED" }, mutate: true }
    });

    assert.deepEqual(await migrateTinderVerifiedChatReturnFoundation(pool), {
      migrated: true,
      preflight: { foundation: { state: "UPGRADE_REQUIRED" }, mutate: true }
    });

    const client = await pool.connect();
    try {
      await assertTinderVerifiedChatReturnSchemaReady(client);
      await assertTinderUnboundInboxConversationSweepRuntimeSchemaReady(client);
    } finally {
      client.release();
    }

    assert.deepEqual(await validateTinderVerifiedChatReturnPreDdl(pool), {
      migrated: false,
      preflight: { foundation: { state: "CANONICAL" }, mutate: false }
    });
  }, { prefix: "marcel_verified_return_v9" });
});

test("real loopback V9 CLI preflight is repeatable-read/read-only, rollback-only, and performs no DDL or locks", {
  timeout: 60_000,
  skip: !REAL_PG_TEST_URL_CONFIGURED && "DEVICE_BRIDGE_REAL_PG_TEST_URL is not configured"
}, async () => {
  const fixture = await loopbackFixture();
  await fixture.withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV8Foundation(pool, fixture);
    await migrateTinderVerifiedChatReturnFoundation(pool);

    const trace = tracePool(pool);
    // The CLI's production configuration key is supplied only with the
    // already validated explicit loopback fixture URL. `createPool` is
    // injected with the disposable pool, so no runtime/Production URL is read
    // or contacted by this test.
    const result = await runTinderVerifiedChatReturnPreflightCli({
      environment: { DATABASE_URL: fixture.localDeviceBridgeRealPostgresTestUrl().toString() },
      createPool: async () => trace,
      logger: { log() {}, error() {} }
    });

    assert.deepEqual(result, {
      ok: true,
      reason: "ALREADY_CANONICAL",
      foundation_state: "CANONICAL",
      migration_required: false,
      transaction: "READ_ONLY_REPEATABLE_READ",
      rollback: "COMPLETED",
      stage: "RESULT_VALIDATION"
    });
    assert.equal(trace.records[0]?.sql.trim(), "BEGIN");
    assert.equal(trace.records[1]?.sql.trim(), "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    assert.equal(trace.records.at(-1)?.sql.trim(), "ROLLBACK");
    assert.equal(trace.records.some(record => /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|LOCK)\b/i.test(record.sql)), false);
  }, { prefix: "marcel_verified_return_v9_preflight" });
});
