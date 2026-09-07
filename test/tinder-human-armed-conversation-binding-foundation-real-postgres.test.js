import assert from "node:assert/strict";
import test from "node:test";
import { migrateDeviceBridgeAckCanonicalization } from "../device-bridge/ack-canonicalization.js";
import { migrateDeviceBridgeSchema } from "../device-bridge/database.js";
import {
  assertHumanArmedConversationBindingFoundationSchemaReady,
  preflightHumanArmedConversationBindingFoundationMigration
} from "../device-bridge/tinder-human-armed-conversation-binding-foundation-schema.js";
import {
  getHumanArmedConversationBindingFoundationMigrationFailureDiagnostic,
  migrateHumanArmedConversationBindingFoundation,
  validateHumanArmedConversationBindingFoundationPreDdl
} from "../device-bridge/tinder-human-armed-conversation-binding-foundation-migration.js";
import {
  runHumanArmedConversationBindingFoundationPreflightCli
} from "../scripts/preflight-tinder-human-armed-conversation-binding-foundation.js";
import { verifyDeviceBridgeSchema } from "../device-bridge/schema-readiness.js";
import { migrateContactConversationBindingFoundation } from "../device-bridge/contact-conversation-binding-foundation-migration.js";
import { migrateTinderIdentityFoundation } from "../device-bridge/tinder-identity-foundation-migration.js";
import { migrateTinderVisibleChatCaptureSchema } from "../device-bridge/tinder-visible-chat-capture-migration.js";
import {
  createDeviceBridgeLegacyRealPostgresFixture,
  withDisposableDeviceBridgeRealPostgresDatabase
} from "./helpers/device-bridge-real-postgres-fixture.js";
import {
  createPgTinderCaptureRepository,
  createTinderCaptureStore
} from "../services/tinder-capture-store.js";
import {
  createPgTinderHumanArmedConversationBindingRepository,
  createTinderHumanArmedConversationBindingService
} from "../services/tinder-human-armed-conversation-binding.js";
import { T2_DEVICE_CAPABILITIES } from "../device-bridge/protocol-v1.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const INSTALLATION_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const SOURCE_CAPTURE_ID = "b565e8a7-ef60-42d0-b19d-26e7904390fa";
const BINDING_ID = "c565e8a7-ef60-42d0-b19d-26e7904390fa";
const ARM_COMMAND_ID = "d565e8a7-ef60-42d0-b19d-26e7904390fa";
const V3_CAPTURE_ID = "f565e8a7-ef60-42d0-b19d-26e7904390fa";
const THREAD_FINGERPRINT = "a".repeat(64);
const SOURCE_CAPTURE_FINGERPRINT = "b".repeat(64);
const V3_CAPTURE_FINGERPRINT = "c".repeat(64);

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
      id SERIAL PRIMARY KEY,
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

async function addRuntimeContactColumns(pool) {
  await pool.query(`
    ALTER TABLE contacts
      ADD COLUMN display_name TEXT,
      ADD COLUMN canonical_name TEXT,
      ADD COLUMN memory_identity_key TEXT,
      ADD COLUMN identity_locked BOOLEAN DEFAULT FALSE,
      ADD COLUMN source_platform TEXT,
      ADD COLUMN current_platform TEXT,
      ADD COLUMN platform_status TEXT,
      ADD COLUMN contact_status TEXT DEFAULT 'active',
      ADD COLUMN relationship_stage TEXT DEFAULT 'new',
      ADD COLUMN auto_reply_enabled BOOLEAN DEFAULT TRUE,
      ADD COLUMN manual_review_required BOOLEAN DEFAULT FALSE,
      ADD COLUMN first_contact_at TIMESTAMPTZ
  `);
  await pool.query(`
    CREATE TABLE contact_memory_profiles (
      contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE
    )
  `);
}

async function prepareDependencies(pool) {
  await createDeviceBridgeLegacyRealPostgresFixture(pool);
  await createT3ContactFixture(pool);
  assert.deepEqual(await migrateDeviceBridgeAckCanonicalization(pool), { migrated: true });
  assert.deepEqual(await migrateDeviceBridgeSchema(pool), { migrated: true });
  assert.deepEqual(await verifyDeviceBridgeSchema(pool), { ready: true });
  assert.equal((await migrateTinderVisibleChatCaptureSchema(pool)).migrated, true);
  assert.equal((await migrateTinderIdentityFoundation(pool)).migrated, true);
  assert.equal((await migrateContactConversationBindingFoundation(pool)).migrated, true);
}

async function seedReadyT2DeviceAndPendingCapture(pool) {
  await pool.query(
    `INSERT INTO device_bridge_devices (
       device_id, installation_id, display_name, enrollment_state,
       bridge_service_state, tinder_state, automation_state, capabilities,
       last_accepted_heartbeat_at
     ) VALUES ($1,$2,'Local human-armed binding device','ACTIVE',
       'RUNNING','CONNECTED','STOPPED',$3::jsonb,NOW())`,
    [DEVICE_ID, INSTALLATION_ID, JSON.stringify(T2_DEVICE_CAPABILITIES)]
  );
  await pool.query(
    `INSERT INTO tinder_visible_chat_captures (
       capture_id, device_id, capture_schema_version, source_package,
       capture_safety_status, runtime_thread_fingerprint, capture_fingerprint,
       capture_revision, visible_thread_metadata, visible_messages,
       mapping_status, human_review_status, provenance, captured_at, received_at
     ) VALUES ($1,$2,'tinder-visible-chat-v2','com.tinder','SAFE',$3,$4,1,
       $5::jsonb,'[]'::jsonb,'NEEDS_HUMAN_MAPPING','PENDING',$6::jsonb,NOW(),NOW())`,
    [
      SOURCE_CAPTURE_ID,
      DEVICE_ID,
      THREAD_FINGERPRINT,
      SOURCE_CAPTURE_FINGERPRINT,
      JSON.stringify({ visibleName: "M", threadFingerprint: THREAD_FINGERPRINT, headerClassName: "fixture.Header" }),
      JSON.stringify({ source: "fixture" })
    ]
  );
}

function safeV3Capture() {
  return {
    captureMetadata: {
      schemaVersion: "tinder-visible-chat-v3",
      sourcePackage: "com.tinder",
      capturedAt: new Date().toISOString(),
      visibleNodeCount: 7,
      captureFingerprint: V3_CAPTURE_FINGERPRINT,
      humanBindingPermit: { command_id: ARM_COMMAND_ID }
    },
    visibleThreadMetadata: {
      visibleName: "M",
      threadFingerprint: THREAD_FINGERPRINT,
      headerClassName: "fixture.Header"
    },
    visibleMessages: [{
      visibleOrder: 1,
      text: "fixture",
      direction: "INCOMING",
      sourceClassName: "fixture.Message"
    }],
    safetyStatus: "SAFE"
  };
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
        release(error) { return rawClient.release(error); }
      };
    },
    async end() { ended = true; }
  };
}

async function humanArmedTablesPresent(pool) {
  const result = await pool.query(`
    SELECT count(*)::integer AS relation_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname IN (
         'contact_human_armed_conversation_bindings',
         'contact_human_armed_conversation_binding_permits',
         'contact_human_armed_conversation_binding_audit'
       )
  `);
  return result.rows[0]?.relation_count === 3;
}

test("real loopback PostgreSQL applies, postchecks, commits and rechecks the human-armed foundation", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareDependencies(pool);

    const before = await validateHumanArmedConversationBindingFoundationPreDdl(pool);
    assert.deepEqual(before, {
      migrated: false,
      preflight: { foundation: { state: "ABSENT" }, mutate: true }
    });
    assert.equal(await humanArmedTablesPresent(pool), false);

    const applied = await migrateHumanArmedConversationBindingFoundation(pool);
    assert.deepEqual(applied, {
      migrated: true,
      preflight: { foundation: { state: "ABSENT" }, mutate: true }
    });
    assert.equal(await humanArmedTablesPresent(pool), true);
    await withClient(pool, assertHumanArmedConversationBindingFoundationSchemaReady);

    const after = await validateHumanArmedConversationBindingFoundationPreDdl(pool);
    assert.deepEqual(after, {
      migrated: false,
      preflight: { foundation: { state: "CANONICAL" }, mutate: false }
    });
  }, { prefix: "marcel_harmed" });
});

test("real loopback operational preflight is repeatable-read read-only and performs no lock, DDL or write", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareDependencies(pool);
    const trace = tracePool(pool);
    const result = await runHumanArmedConversationBindingFoundationPreflightCli({
      environment: { DATABASE_URL: "postgres://test-only-not-used-by-injected-pool" },
      createPool: async () => trace,
      logger: { log() {}, error() {} }
    });
    assert.deepEqual(result, {
      ok: true,
      reason: "ELIGIBLE_FOR_MIGRATION",
      foundation_state: "ABSENT",
      migration_required: true,
      transaction: "READ_ONLY_REPEATABLE_READ",
      rollback: "COMPLETED"
    });
    assert.equal(trace.records[0]?.sql.trim(), "BEGIN");
    assert.equal(trace.records[1]?.sql.trim(), "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    assert.equal(trace.records.at(-1)?.sql.trim(), "ROLLBACK");
    assert.equal(trace.records.some(record => /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|LOCK)\b/i.test(record.sql)), false);
    assert.equal(trace.ended, true);
    assert.equal(await humanArmedTablesPresent(pool), false);
  }, { prefix: "marcel_harmed_preflight" });
});

test("real loopback postcheck drift rolls back the entire human-armed foundation", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareDependencies(pool);
    let injected = false;
    const trace = tracePool(pool, {
      afterQuery: async ({ sql, rawClient }) => {
        if (!injected && sql.includes("CREATE TABLE IF NOT EXISTS contact_human_armed_conversation_bindings")) {
          injected = true;
          await rawClient.query(
            "ALTER TABLE contact_human_armed_conversation_binding_audit ADD COLUMN injected_postcheck_drift integer"
          );
        }
      }
    });
    const error = await migrateHumanArmedConversationBindingFoundation(trace).catch(value => value);
    assert.equal(injected, true);
    assert.deepEqual(getHumanArmedConversationBindingFoundationMigrationFailureDiagnostic(error), {
      stage: "POSTCHECK",
      code: "DATABASE_OPERATION_FAILED",
      transaction: "STARTED",
      rollback: "COMPLETED",
      ddl_started: true,
      reason: "HUMAN_ARMED_CONVERSATION_BINDING_POSTCHECK_SCHEMA_INVALID"
    });
    assert.equal(trace.records.some(record => record.sql.trim() === "COMMIT"), false);
    assert.equal(trace.records.some(record => record.sql.trim() === "ROLLBACK"), true);
    assert.equal(await humanArmedTablesPresent(pool), false);
    const inspection = await withClient(pool, preflightHumanArmedConversationBindingFoundationMigration);
    assert.deepEqual(inspection, { foundation: { state: "ABSENT" }, mutate: true });
  }, { prefix: "marcel_harmed_rollback" });
});

test("real loopback service fails closed before ACK, then atomically arms, stores V3 and consumes exactly one permit", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareDependencies(pool);
    await addRuntimeContactColumns(pool);
    assert.equal((await migrateHumanArmedConversationBindingFoundation(pool)).migrated, true);
    await seedReadyT2DeviceAndPendingCapture(pool);

    const repository = createPgTinderHumanArmedConversationBindingRepository(pool);
    const bindingService = createTinderHumanArmedConversationBindingService(repository, {
      createBindingId: () => BINDING_ID,
      createPermitId: () => ARM_COMMAND_ID,
      createReferenceHash: () => "e".repeat(64),
      createIdentityKey: () => "tinder_human_armed_fixture",
      now: () => new Date()
    });
    const armed = await bindingService.armInitialCapture({
      captureId: SOURCE_CAPTURE_ID,
      action: "BIND_CREATE",
      newContactName: "Fixture Contact",
      confirmed: true
    });
    assert.equal(armed.status, "ARMED");
    assert.equal(armed.bindingId, BINDING_ID);
    assert.equal(Number.isInteger(armed.contactId), true);

    const captureStore = createTinderCaptureStore(createPgTinderCaptureRepository(pool), {
      createCaptureId: () => V3_CAPTURE_ID,
      now: () => new Date(),
      humanBindingPermitGateway: {
        authorizeIncomingCapturePermit: (...args) => bindingService.authorizeIncomingCapturePermit(...args),
        consumeAuthorizedIncomingPermit: (...args) => bindingService.consumeAuthorizedIncomingPermit(...args)
      }
    });
    await assert.rejects(
      captureStore.storeSafeCapture({
        deviceId: DEVICE_ID,
        capture: safeV3Capture(),
        provenance: { source: "android_visible_chat", protocolVersion: 1 }
      }),
      error => error?.code === "HUMAN_BINDING_PERMIT_NOT_AVAILABLE"
    );
    const beforeAck = await pool.query(
      `SELECT permit_state, consumed_capture_id
         FROM contact_human_armed_conversation_binding_permits
        WHERE command_id=$1`,
      [ARM_COMMAND_ID]
    );
    assert.deepEqual(beforeAck.rows[0], { permit_state: "ISSUED", consumed_capture_id: null });
    const failedCaptureCount = await pool.query(
      "SELECT COUNT(*)::int AS count FROM tinder_visible_chat_captures WHERE capture_id=$1",
      [V3_CAPTURE_ID]
    );
    assert.equal(failedCaptureCount.rows[0].count, 0);

    await pool.query(
      "UPDATE device_bridge_commands SET terminal_status='SUCCEEDED', terminal_at=NOW() WHERE command_id=$1",
      [ARM_COMMAND_ID]
    );
    await pool.query(
      `INSERT INTO device_bridge_command_acks (
         command_id, device_id, status, occurred_at, result, error, body_sha256
       ) VALUES ($1,$2,'SUCCEEDED',NOW(),$3::jsonb,NULL,$4)`,
      [ARM_COMMAND_ID, DEVICE_ID, JSON.stringify({ conversation_binding_permit: "ARMED" }), "f".repeat(64)]
    );
    const stored = await captureStore.storeSafeCapture({
      deviceId: DEVICE_ID,
      capture: safeV3Capture(),
      provenance: { source: "android_visible_chat", protocolVersion: 1 }
    });
    assert.equal(stored.capture_id, V3_CAPTURE_ID);
    assert.equal(stored.mapping_status, "RESOLVED");
    assert.equal(stored.human_review_status, "CONFIRMED");
    assert.equal(stored.resolved_contact_id, armed.contactId);
    assert.equal(JSON.stringify(stored).includes(ARM_COMMAND_ID), false);

    const permit = await pool.query(
      "SELECT permit_state, consumed_capture_id FROM contact_human_armed_conversation_binding_permits WHERE command_id=$1",
      [ARM_COMMAND_ID]
    );
    assert.deepEqual(permit.rows[0], { permit_state: "CONSUMED", consumed_capture_id: V3_CAPTURE_ID });
    const sourceCapture = await pool.query(
      "SELECT mapping_status, human_review_status, resolved_contact_id FROM tinder_visible_chat_captures WHERE capture_id=$1",
      [SOURCE_CAPTURE_ID]
    );
    assert.deepEqual(sourceCapture.rows[0], {
      mapping_status: "RESOLVED",
      human_review_status: "CONFIRMED",
      resolved_contact_id: armed.contactId
    });
  }, { prefix: "marcel_harmed_service" });
});
