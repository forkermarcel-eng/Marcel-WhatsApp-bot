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
import { createAdminDeviceStatusHandler } from "../device-bridge/admin.js";
import {
  runTinderOfficialAppResumePermitV2PreflightCli
} from "../scripts/preflight-tinder-official-app-resume-permit-v2.js";
import {
  createDeviceBridgeLegacyRealPostgresFixture,
  withDisposableDeviceBridgeRealPostgresDatabase
} from "./helpers/device-bridge-real-postgres-fixture.js";
import { T2_DEVICE_CAPABILITIES, T4_RESUME_DEVICE_CAPABILITIES } from "../device-bridge/protocol-v1.js";
import { processHeartbeatTransaction } from "../device-bridge/heartbeat.js";
import {
  TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_CLASS_FAMILIES,
  TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ROLE_COUNTS,
  TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_VIEW_ID_STATES
} from "../device-bridge/tinder-official-resume-schema-evidence-contract.js";

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

function boundedCounts(fields, nonZero = {}) {
  return Object.fromEntries(fields.map(field => [field, nonZero[field] || 0]));
}

function schemaEvidenceHeartbeat(sequence) {
  return {
    ...deliveryHeartbeat(sequence),
    tinder_official_resume_handoff: {
      stage: "BLOCKED",
      reason: "UNREVIEWED_OFFICIAL_SURFACE"
    },
    tinder_official_resume_schema_evidence: {
      evidence_version: "tinder-official-resume-schema-profile-v1",
      safety_status: "BLOCKED_UNKNOWN_STRUCTURE",
      tree_truncated: false,
      visible_node_count: 4,
      maximum_visible_depth: 3,
      class_family_counts: boundedCounts(
        TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_CLASS_FAMILIES,
        { TEXT_VIEW: 1, EDIT_TEXT: 1, RECYCLER_VIEW: 1, FRAME_LAYOUT: 1 }),
      view_id_state_counts: boundedCounts(
        TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_VIEW_ID_STATES,
        { ABSENT: 2, STATIC_TINDER_ID: 2 }),
      role_counts: boundedCounts(
        TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ROLE_COUNTS,
        { HEADER_CONTAINER: 1, MESSAGE_LIST: 1, COMPOSER_CONTAINER: 1,
          COMPOSER_EDITABLE: 1, MESSAGE_TEXT_LEAF: 1 }),
      relation_flags: {
        header_before_message_list: true,
        message_list_before_composer: true,
        message_list_has_text_leaf: true,
        composer_has_editable_leaf: true,
        has_clickable_node: true,
        has_long_clickable_node: false,
        has_scrollable_node: true,
        has_text_present_node: true,
        has_content_description_present_node: false
      }
    }
  };
}

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

async function markCurrentV2ResumeDeliveredAndAcknowledged(pool) {
  await pool.query(
    `UPDATE device_bridge_commands
        SET terminal_status='SUCCEEDED', terminal_at=NOW()
      WHERE command_id=$1`,
    [DELIVERY_RESUME_COMMAND_ID]
  );
  await pool.query(
    `UPDATE tinder_official_app_resume_permits
        SET permit_state='DISPATCHED', dispatched_at=NOW()
      WHERE command_id=$1`,
    [DELIVERY_RESUME_COMMAND_ID]
  );
  await pool.query(
    `INSERT INTO device_bridge_command_acks
       (command_id, device_id, status, occurred_at, result, error, body_sha256, accepted_at)
     VALUES ($1,$2,'SUCCEEDED',NOW(),$3::jsonb,NULL,$4,NOW())`,
    [DELIVERY_RESUME_COMMAND_ID, DEVICE_ID,
      JSON.stringify({ official_tinder_app_resume: "INTENT_DISPATCHED" }),
      "c".repeat(64)]
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

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
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

test("real loopback heartbeat accepts one server-provenanced schema profile and rejects a second", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV1Foundation(pool);
    await migrateTinderOfficialAppResumePermitV2(pool);
    await seedCurrentV2ResumeDeliveryFixture(pool);
    await markCurrentV2ResumeDeliveredAndAcknowledged(pool);

    const first = await processHeartbeatTransaction(
      pool, deliveryAuth(1), schemaEvidenceHeartbeat(1), new Date());
    assert.deepEqual(first.commands, []);
    const audit = await pool.query(
      `SELECT command_id, details
         FROM device_bridge_audit_events
        WHERE device_id=$1
          AND event_type='HEARTBEAT_ACCEPTED'
          AND details ? 'tinder_official_resume_schema_evidence'`,
      [DEVICE_ID]
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].command_id, DELIVERY_RESUME_COMMAND_ID);
    assert.deepEqual(audit.rows[0].details, {
      tinder_official_resume_handoff: {
        stage: "BLOCKED",
        reason: "UNREVIEWED_OFFICIAL_SURFACE"
      },
      tinder_official_resume_schema_evidence:
        schemaEvidenceHeartbeat(1).tinder_official_resume_schema_evidence
    });

    await assert.rejects(
      () => processHeartbeatTransaction(
        pool, deliveryAuth(2), schemaEvidenceHeartbeat(2), new Date()),
      error => error?.code === "TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ALREADY_REPORTED"
        && error?.deviceBridgeHeartbeatFailureStage === "SCHEMA_EVIDENCE_AUTHORIZATION"
    );
    const after = await pool.query(
      `SELECT COUNT(*)::int AS audit_count,
              (SELECT last_heartbeat_sequence
                 FROM device_bridge_devices
                WHERE device_id=$1) AS last_sequence
         FROM device_bridge_audit_events
        WHERE device_id=$1
          AND event_type='HEARTBEAT_ACCEPTED'
          AND details ? 'tinder_official_resume_schema_evidence'`,
      [DEVICE_ID]
    );
    assert.deepEqual(after.rows[0], { audit_count: 1, last_sequence: "1" });
  }, { prefix: "marcel_resume_v2_schema_evidence" });
});

test("real loopback status retains accepted V2 schema evidence separately after a later handoff-only heartbeat", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV1Foundation(pool);
    await migrateTinderOfficialAppResumePermitV2(pool);
    await seedCurrentV2ResumeDeliveryFixture(pool);
    await markCurrentV2ResumeDeliveredAndAcknowledged(pool);

    const evidenceHeartbeat = schemaEvidenceHeartbeat(1);
    await processHeartbeatTransaction(pool, deliveryAuth(1), evidenceHeartbeat, new Date());
    const terminalHandoff = evidenceHeartbeat.tinder_official_resume_handoff;
    await processHeartbeatTransaction(pool, deliveryAuth(2), {
      ...deliveryHeartbeat(2),
      tinder_official_resume_handoff: terminalHandoff
    }, new Date());

    const response = responseRecorder();
    await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, response);
    assert.equal(response.statusCode, 200);
    const device = response.body.device;
    assert.equal(device.device_status, "ONLINE");
    assert.deepEqual(device.official_resume_handoff, terminalHandoff);
    assert.equal(device.tinder_official_resume_schema_evidence, null);
    assert.deepEqual(device.last_accepted_official_resume_schema_diagnostic, {
      handoff: terminalHandoff,
      schema_evidence: evidenceHeartbeat.tinder_official_resume_schema_evidence
    });
    const serialized = JSON.stringify(device.last_accepted_official_resume_schema_diagnostic);
    for (const forbidden of ["raw_accessibility_tree", "node_shapes", "fingerprint",
      "package_name", "view_id_token", "class_name", "command_id", "permit_id",
      "source_capture_id", "binding_id", "capture_id", "visible_name", "message_text"]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  }, { prefix: "marcel_resume_v2_historical_status" });
});

test("real loopback status retains bounded passive Inbox evidence after a later ordinary heartbeat", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV1Foundation(pool);
    await migrateTinderOfficialAppResumePermitV2(pool);
    await seedCurrentV2ResumeDeliveryFixture(pool);
    await markCurrentV2ResumeDeliveredAndAcknowledged(pool);

    const diagnostic = {
      stage: "BLOCKED",
      reason: "RUNTIME_GATE_LOST",
      settle_sample_count: 0,
      validation_count: 0
    };
    await processHeartbeatTransaction(pool, deliveryAuth(1), {
      ...deliveryHeartbeat(1),
      tinder_passive_inbox_observation_diagnostic: diagnostic
    }, new Date());
    await processHeartbeatTransaction(pool, deliveryAuth(2), deliveryHeartbeat(2), new Date());

    const response = responseRecorder();
    await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, response);
    assert.equal(response.statusCode, 200);
    const device = response.body.device;
    assert.equal(device.device_status, "ONLINE");
    assert.equal(device.tinder_passive_inbox_observation_diagnostic, null);
    assert.deepEqual(
      device.last_accepted_passive_inbox_observation_diagnostic_after_latest_v2_resume,
      diagnostic
    );
    const serialized = JSON.stringify(
      device.last_accepted_passive_inbox_observation_diagnostic_after_latest_v2_resume
    );
    for (const forbidden of ["permit", "command", "identity", "source", "binding", "capture",
      "header", "text", "fingerprint", "visible_name", "message_text"]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  }, { prefix: "marcel_resume_v2_historical_passive_inbox" });
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
