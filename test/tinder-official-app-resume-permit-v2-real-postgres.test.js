import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
import {
  assertTinderOfficialAppResumePermitV2SchemaReady,
  preflightTinderOfficialAppResumePermitV2Migration
} from "../device-bridge/tinder-visible-chat-sync-permit-schema.js";
import {
  getTinderOfficialAppResumePermitV2MigrationFailureDiagnostic,
  migrateTinderOfficialAppResumePermitV2,
  validateTinderOfficialAppResumePermitV2PreDdl
} from "../device-bridge/tinder-official-app-resume-permit-v2-migration.js";
import {
  runTinderOfficialAppResumePermitV2PreflightCli
} from "../scripts/preflight-tinder-official-app-resume-permit-v2.js";
import {
  createDeviceBridgeLegacyRealPostgresFixture,
  withDisposableDeviceBridgeRealPostgresDatabase
} from "./helpers/device-bridge-real-postgres-fixture.js";
import { T2_DEVICE_CAPABILITIES, T4_RESUME_DEVICE_CAPABILITIES } from "../device-bridge/protocol-v1.js";
import { processHeartbeatTransaction } from "../device-bridge/heartbeat.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const INSTALLATION_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const CAPTURE_ID = "b565e8a7-ef60-42d0-b19d-26e7904390fa";
const LEGACY_COMMAND_ID = "d565e8a7-ef60-42d0-b19d-26e7904390fa";
const DELIVERY_BINDING_ID = "f565e8a7-ef60-42d0-b19d-26e7904390fa";
const DELIVERY_ARM_COMMAND_ID = "1765e8a7-ef60-42d0-b19d-26e7904390fa";
const DELIVERY_RESUME_COMMAND_ID = "2765e8a7-ef60-42d0-b19d-26e7904390fa";
const DELIVERY_KEY_ID = "3765e8a7-ef60-42d0-b19d-26e7904390fa";
const THREAD_FINGERPRINT = "a".repeat(64);
const CAPTURE_FINGERPRINT = "b".repeat(64);

async function withClient(pool, work) {
  const client = await pool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

async function createContactFixture(pool) {
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

async function prepareV1Foundation(pool) {
  await createDeviceBridgeLegacyRealPostgresFixture(pool);
  await createContactFixture(pool);
  await migrateDeviceBridgeAckCanonicalization(pool);
  await migrateDeviceBridgeSchema(pool);
  assert.deepEqual(await verifyDeviceBridgeSchema(pool), { ready: true });
  await migrateTinderVisibleChatCaptureSchema(pool);
  await migrateTinderIdentityFoundation(pool);
  await migrateContactConversationBindingFoundation(pool);
  await addRuntimeContactColumns(pool);
  await migrateTinderDraftFoundation(pool);
  await migrateTinderManualSendFoundation(pool);
  await migrateHumanArmedConversationBindingFoundation(pool);
  await migrateTinderManualSendCommand(pool);
  const applied = await migrateTinderVisibleChatSyncPermitFoundation(pool);
  assert.equal(applied.migrated, true);
}

async function seedLegacyPermit(pool) {
  await pool.query(
    `INSERT INTO device_bridge_devices (
       device_id, installation_id, display_name, enrollment_state,
       bridge_service_state, tinder_state, automation_state, capabilities,
       last_accepted_heartbeat_at
     ) VALUES ($1,$2,'Local resume V2 fixture','ACTIVE',
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
      CAPTURE_ID, DEVICE_ID, THREAD_FINGERPRINT, CAPTURE_FINGERPRINT,
      JSON.stringify({ visibleName: "Fixture", threadFingerprint: THREAD_FINGERPRINT, headerClassName: "fixture.Header" }),
      JSON.stringify({ source: "fixture" })
    ]
  );
  await pool.query(
    `INSERT INTO device_bridge_commands (
       command_id, device_id, protocol_version, command_type, payload,
       configuration_revision, issued_at, expires_at, terminal_status, terminal_at
     ) VALUES ($1,$2,1,'RESUME_OFFICIAL_TINDER_APP','{}'::jsonb,1,
       NOW() - INTERVAL '4 minutes', NOW() - INTERVAL '2 minutes','SUCCEEDED',NOW() - INTERVAL '3 minutes')`,
    [LEGACY_COMMAND_ID, DEVICE_ID]
  );
  await pool.query(
    `INSERT INTO tinder_official_app_resume_permits (
       command_id, device_id, source_capture_id, permit_state,
       issued_at, expires_at, dispatched_at, created_at, updated_at
     ) VALUES ($1,$2,$3,'DISPATCHED',NOW() - INTERVAL '4 minutes',
       NOW() - INTERVAL '2 minutes',NOW() - INTERVAL '3 minutes',NOW(),NOW())`,
    [LEGACY_COMMAND_ID, DEVICE_ID, CAPTURE_ID]
  );
}

async function makeLegacyPermitActive(pool) {
  await pool.query(
    `UPDATE device_bridge_commands
        SET terminal_status=NULL, terminal_at=NULL, expires_at=NOW() + INTERVAL '2 minutes'
      WHERE command_id=$1`,
    [LEGACY_COMMAND_ID]
  );
  await pool.query(
    `UPDATE tinder_official_app_resume_permits
        SET permit_state='ISSUED', dispatched_at=NULL, closed_at=NULL,
            expires_at=NOW() + INTERVAL '2 minutes'
      WHERE command_id=$1`,
    [LEGACY_COMMAND_ID]
  );
}

async function seedCurrentV2ResumeDeliveryFixture(pool) {
  await pool.query(
    `INSERT INTO device_bridge_devices (
       device_id, installation_id, display_name, enrollment_state,
       bridge_service_state, tinder_state, automation_state, capabilities,
       last_accepted_heartbeat_at
     ) VALUES ($1,$2,'Local V2 delivery fixture','ACTIVE',
       'RUNNING','CONNECTED','STOPPED',$3::jsonb,NOW())`,
    [DEVICE_ID, INSTALLATION_ID, JSON.stringify(T4_RESUME_DEVICE_CAPABILITIES)]
  );
  const contact = await pool.query(
    `INSERT INTO contacts (whatsapp_jid, display_name, canonical_name)
     VALUES ('resume-v2-fixture@invalid','Fixture','Fixture')
     RETURNING id`
  );
  const contactId = contact.rows[0]?.id;
  assert.equal(Number.isInteger(contactId), true);
  await pool.query(
    `INSERT INTO tinder_visible_chat_captures (
       capture_id, device_id, capture_schema_version, source_package,
       capture_safety_status, runtime_thread_fingerprint, capture_fingerprint,
       capture_revision, visible_thread_metadata, visible_messages,
       mapping_status, human_review_status, resolved_contact_id, provenance,
       captured_at, received_at
     ) VALUES ($1,$2,'tinder-visible-chat-v2','com.tinder','SAFE',$3,$4,1,
       $5::jsonb,'[]'::jsonb,'RESOLVED','CONFIRMED',$6,$7::jsonb,NOW(),NOW())`,
    [
      CAPTURE_ID, DEVICE_ID, THREAD_FINGERPRINT, CAPTURE_FINGERPRINT,
      JSON.stringify({ visibleName: 'Fixture', threadFingerprint: THREAD_FINGERPRINT, headerClassName: 'fixture.Header' }),
      contactId, JSON.stringify({ source: 'fixture' })
    ]
  );
  await pool.query(
    `INSERT INTO contact_human_armed_conversation_bindings (
       binding_id, channel, reference_kind, reference_hash, device_id, contact_id,
       source_capture_id, binding_state, binding_revision, human_verified,
       verification_source, verified_by
     ) VALUES ($1,'tinder','tinder_human_armed_conversation_v1',$2,$3,$4,
       $5,'CONFIRMED',1,TRUE,'manual_dashboard','fixture')`,
    [DELIVERY_BINDING_ID, "e".repeat(64), DEVICE_ID, contactId, CAPTURE_ID]
  );
  await pool.query(
    `INSERT INTO device_bridge_commands (
       command_id, device_id, protocol_version, command_type, payload,
       configuration_revision, issued_at, expires_at, terminal_status, terminal_at
     ) VALUES ($1,$2,1,'ARM_TINDER_CONVERSATION_BINDING','{}'::jsonb,1,
       NOW() - INTERVAL '2 minutes',NOW() + INTERVAL '2 minutes','SUCCEEDED',NOW() - INTERVAL '1 minute')`,
    [DELIVERY_ARM_COMMAND_ID, DEVICE_ID]
  );
  await pool.query(
    `INSERT INTO contact_human_armed_conversation_binding_permits (
       command_id, binding_id, device_id, binding_revision, permit_state,
       issued_at, expires_at, consumed_at, consumed_capture_id
     ) VALUES ($1,$2,$3,1,'CONSUMED',NOW() - INTERVAL '2 minutes',
       NOW() + INTERVAL '2 minutes',NOW() - INTERVAL '1 minute',$4)`,
    [DELIVERY_ARM_COMMAND_ID, DELIVERY_BINDING_ID, DEVICE_ID, CAPTURE_ID]
  );
  await pool.query(
    `INSERT INTO device_bridge_keys (
       key_id, device_id, algorithm, public_key_spki_der, public_key_fingerprint
     ) VALUES ($1,$2,'EC_P256_SHA256',$3,$4)`,
    [DELIVERY_KEY_ID, DEVICE_ID, Buffer.from([1]), "f".repeat(64)]
  );
  await pool.query(
    `INSERT INTO device_bridge_commands (
       command_id, device_id, protocol_version, command_type, payload,
       configuration_revision, issued_at, expires_at
     ) VALUES ($1,$2,1,'RESUME_OFFICIAL_TINDER_APP','{}'::jsonb,1,
       NOW() - INTERVAL '1 minute',NOW() + INTERVAL '2 minutes')`,
    [DELIVERY_RESUME_COMMAND_ID, DEVICE_ID]
  );
  await pool.query(
    `INSERT INTO tinder_official_app_resume_permits (
       command_id, device_id, source_capture_id, binding_id, binding_revision,
       permit_contract_version, permit_state, issued_at, expires_at
     ) VALUES ($1,$2,$3,$4,1,2,'ISSUED',NOW() - INTERVAL '1 minute',NOW() + INTERVAL '2 minutes')`,
    [DELIVERY_RESUME_COMMAND_ID, DEVICE_ID, CAPTURE_ID, DELIVERY_BINDING_ID]
  );
}

function deliveryHeartbeat(sequence) {
  return {
    protocol_version: 1,
    sequence,
    sent_at: new Date().toISOString(),
    app: { version_name: 'fixture', version_code: 1 },
    device: {
      installation_id: INSTALLATION_ID,
      manufacturer: 'fixture', model: 'fixture', android_api: 35, abis: ['arm64-v8a']
    },
    bridge: { service_state: 'RUNNING', started_at: null, last_successful_heartbeat_at: null },
    capabilities: T4_RESUME_DEVICE_CAPABILITIES,
    tinder_state: 'CONNECTED',
    automation_state: 'STOPPED'
  };
}

function deliveryAuth(sequence) {
  return {
    deviceId: DEVICE_ID,
    keyId: DELIVERY_KEY_ID,
    requestId: randomUUID(),
    contentSha256: `${"a".repeat(63)}${sequence}`
  };
}

function tracePool(pool, { afterQuery } = {}) {
  const records = [];
  return {
    records,
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
    async end() {}
  };
}

test("real loopback PostgreSQL applies V2, preserves an immutable V1 permit and postchecks canonical schema", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV1Foundation(pool);
    await seedLegacyPermit(pool);
    const before = await validateTinderOfficialAppResumePermitV2PreDdl(pool);
    assert.equal(before.migrated, false);
    assert.equal(before.preflight.foundation.state, "UPGRADE_REQUIRED");
    assert.equal(before.preflight.mutate, true);

    const applied = await migrateTinderOfficialAppResumePermitV2(pool);
    assert.equal(applied.migrated, true);
    assert.equal(applied.preflight.foundation.state, "UPGRADE_REQUIRED");
    await withClient(pool, assertTinderOfficialAppResumePermitV2SchemaReady);
    const legacy = await pool.query(
      `SELECT permit_state, permit_contract_version, binding_id, binding_revision
         FROM tinder_official_app_resume_permits
        WHERE command_id=$1`,
      [LEGACY_COMMAND_ID]
    );
    assert.deepEqual(legacy.rows[0], {
      permit_state: "DISPATCHED",
      permit_contract_version: 1,
      binding_id: null,
      binding_revision: null
    });
    const after = await validateTinderOfficialAppResumePermitV2PreDdl(pool);
    assert.equal(after.migrated, false);
    assert.equal(after.preflight.foundation.state, "CANONICAL");
    assert.equal(after.preflight.mutate, false);
  }, { prefix: "marcel_resume_v2" });
});

test("real loopback V2 operational preflight is repeatable-read/read-only and rolls back without locks or DDL", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV1Foundation(pool);
    const trace = tracePool(pool);
    const result = await runTinderOfficialAppResumePermitV2PreflightCli({
      environment: { DATABASE_URL: "postgres://test-only-not-used-by-injected-pool" },
      createPool: async () => trace,
      logger: { log() {}, error() {} }
    });
    assert.deepEqual(result, {
      ok: true,
      reason: "ELIGIBLE_FOR_MIGRATION",
      foundation_state: "UPGRADE_REQUIRED",
      migration_required: true,
      transaction: "READ_ONLY_REPEATABLE_READ",
      rollback: "COMPLETED",
      stage: "VALIDATION_UNCLASSIFIED"
    });
    assert.equal(trace.records[0]?.sql.trim(), "BEGIN");
    assert.equal(trace.records[1]?.sql.trim(), "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    assert.equal(trace.records.at(-1)?.sql.trim(), "ROLLBACK");
    assert.equal(trace.records.some(record => /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|LOCK)\b/i.test(record.sql)), false);
  }, { prefix: "marcel_resume_v2_preflight" });
});

test("real loopback V2 operational preflight blocks an active legacy V1 permit before DDL", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV1Foundation(pool);
    await seedLegacyPermit(pool);
    await makeLegacyPermitActive(pool);
    const trace = tracePool(pool);
    const result = await runTinderOfficialAppResumePermitV2PreflightCli({
      environment: { DATABASE_URL: "postgres://test-only-not-used-by-injected-pool" },
      createPool: async () => trace,
      logger: { log() {}, error() {} }
    });
    assert.deepEqual(result, {
      ok: false,
      reason: "OFFICIAL_APP_RESUME_PERMIT_V2_ACTIVE_LEGACY_PERMIT",
      foundation_state: "UNRESOLVED",
      migration_required: "UNRESOLVED",
      transaction: "READ_ONLY_REPEATABLE_READ",
      rollback: "COMPLETED",
      stage: "ACTIVE_LEGACY_PERMIT_CHECK"
    });
    assert.equal(trace.records.some(record => /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|LOCK)\b/i.test(record.sql)), false);
    assert.equal(trace.records.at(-1)?.sql.trim(), "ROLLBACK");
    const legacy = await pool.query(
      `SELECT permit_state, dispatched_at, closed_at
         FROM tinder_official_app_resume_permits
        WHERE command_id=$1`,
      [LEGACY_COMMAND_ID]
    );
    assert.deepEqual(legacy.rows[0], {
      permit_state: "ISSUED",
      dispatched_at: null,
      closed_at: null
    });
  }, { prefix: "marcel_resume_v2_active_legacy" });
});

test("real loopback heartbeat delivers only a current V2 resume binding snapshot", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV1Foundation(pool);
    await migrateTinderOfficialAppResumePermitV2(pool);
    await seedCurrentV2ResumeDeliveryFixture(pool);

    const delivered = await processHeartbeatTransaction(pool, deliveryAuth(1), deliveryHeartbeat(1), new Date());
    assert.deepEqual(delivered.commands.map(command => command.command_id), [DELIVERY_RESUME_COMMAND_ID]);

    await pool.query(
      `UPDATE contact_human_armed_conversation_bindings
          SET binding_revision=2
        WHERE binding_id=$1`,
      [DELIVERY_BINDING_ID]
    );
    const stale = await processHeartbeatTransaction(pool, deliveryAuth(2), deliveryHeartbeat(2), new Date());
    assert.deepEqual(stale.commands, []);
  }, { prefix: "marcel_resume_v2_delivery_revision" });
});

test("real loopback heartbeat omits an expired V2 resume permit even if its command remains live", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV1Foundation(pool);
    await migrateTinderOfficialAppResumePermitV2(pool);
    await seedCurrentV2ResumeDeliveryFixture(pool);
    await pool.query(
      `UPDATE tinder_official_app_resume_permits
          SET expires_at=NOW() - INTERVAL '1 second'
        WHERE command_id=$1`,
      [DELIVERY_RESUME_COMMAND_ID]
    );
    const response = await processHeartbeatTransaction(pool, deliveryAuth(1), deliveryHeartbeat(1), new Date());
    assert.deepEqual(response.commands, []);
  }, { prefix: "marcel_resume_v2_delivery_expiry" });
});

test("real loopback V2 postcheck drift rolls back the complete V2 delta", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV1Foundation(pool);
    let injected = false;
    const trace = tracePool(pool, {
      afterQuery: async ({ sql, rawClient }) => {
        if (!injected && sql.includes("ADD COLUMN permit_contract_version")) {
          injected = true;
          await rawClient.query(
            "ALTER TABLE tinder_official_app_resume_permits ADD COLUMN injected_postcheck_drift integer"
          );
        }
      }
    });
    const error = await migrateTinderOfficialAppResumePermitV2(trace).catch(value => value);
    assert.equal(injected, true);
    assert.deepEqual(getTinderOfficialAppResumePermitV2MigrationFailureDiagnostic(error), {
      stage: "POSTCHECK",
      code: "DATABASE_OPERATION_FAILED",
      transaction: "STARTED",
      rollback: "COMPLETED",
      ddl_started: true,
      reason: "TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_POSTCHECK_SCHEMA_INVALID"
    });
    assert.equal(trace.records.some(record => record.sql.trim() === "COMMIT"), false);
    assert.equal(trace.records.some(record => record.sql.trim() === "ROLLBACK"), true);
    const column = await pool.query(`
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema=current_schema()
         AND table_name='tinder_official_app_resume_permits'
         AND column_name IN ('permit_contract_version', 'injected_postcheck_drift')
    `);
    assert.equal(column.rows.length, 0);
  }, { prefix: "marcel_resume_v2_rollback" });
});
