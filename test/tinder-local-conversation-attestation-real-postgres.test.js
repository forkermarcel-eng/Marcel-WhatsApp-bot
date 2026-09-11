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
import { migrateTinderOfficialAppResumePermitV2 } from "../device-bridge/tinder-official-app-resume-permit-v2-migration.js";
import {
  assertTinderLocalConversationAttestationSchemaReady
} from "../device-bridge/tinder-local-conversation-attestation-schema.js";
import {
  getTinderLocalConversationAttestationMigrationFailureDiagnostic,
  migrateTinderLocalConversationAttestation,
  validateTinderLocalConversationAttestationPreDdl
} from "../device-bridge/tinder-local-conversation-attestation-migration.js";
import {
  createDeviceBridgeLegacyRealPostgresFixture,
  withDisposableDeviceBridgeRealPostgresDatabase
} from "./helpers/device-bridge-real-postgres-fixture.js";

async function createContactFixture(pool) {
  await pool.query("CREATE TABLE contacts (id SERIAL PRIMARY KEY, whatsapp_jid TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())");
  await pool.query("CREATE TABLE contact_identifiers (id BIGSERIAL PRIMARY KEY, contact_id INTEGER NOT NULL, identifier_type TEXT NOT NULL, identifier_value TEXT NOT NULL, normalized_value TEXT NOT NULL, source_platform TEXT, is_primary BOOLEAN, human_verified BOOLEAN, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)");
  await pool.query("ALTER TABLE contacts ADD COLUMN display_name TEXT, ADD COLUMN canonical_name TEXT, ADD COLUMN memory_identity_key TEXT, ADD COLUMN identity_locked BOOLEAN DEFAULT FALSE, ADD COLUMN source_platform TEXT, ADD COLUMN current_platform TEXT, ADD COLUMN platform_status TEXT, ADD COLUMN contact_status TEXT DEFAULT 'active', ADD COLUMN relationship_stage TEXT DEFAULT 'new', ADD COLUMN auto_reply_enabled BOOLEAN DEFAULT TRUE, ADD COLUMN manual_review_required BOOLEAN DEFAULT FALSE, ADD COLUMN first_contact_at TIMESTAMPTZ");
  await pool.query("CREATE TABLE contact_memory_profiles (contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE)");
}

async function prepareV5Foundation(pool) {
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
}

async function insertDevice(pool, suffix) {
  const deviceId = randomUUID();
  await pool.query(
    `INSERT INTO device_bridge_devices (
       device_id, installation_id, display_name, configuration_revision
     ) VALUES ($1,$2,$3,1)`,
    [deviceId, randomUUID(), `local-attestation-device-${suffix}`]
  );
  return deviceId;
}

async function insertContact(pool, suffix) {
  const result = await pool.query(
    "INSERT INTO contacts (whatsapp_jid) VALUES ($1) RETURNING id",
    [`local-attestation-${suffix}@example.invalid`]
  );
  return result.rows[0].id;
}

async function insertCapture(pool, { deviceId, suffix }) {
  const captureId = randomUUID();
  const nibble = suffix === "a" ? "a" : "b";
  await pool.query(
    `INSERT INTO tinder_visible_chat_captures (
       capture_id, device_id, capture_schema_version, source_package,
       capture_safety_status, runtime_thread_fingerprint, capture_fingerprint,
       capture_revision, visible_thread_metadata, visible_messages,
       captured_at, received_at
     ) VALUES ($1,$2,'local-test','com.tinder','SAFE',$3,$4,1,'{}'::jsonb,'[]'::jsonb,NOW(),NOW())`,
    [captureId, deviceId, nibble.repeat(64), (suffix === "a" ? "c" : "d").repeat(64)]
  );
  return captureId;
}

async function insertBinding(pool, { deviceId, captureId, contactId, suffix }) {
  const bindingId = randomUUID();
  await pool.query(
    `INSERT INTO contact_human_armed_conversation_bindings (
       binding_id, channel, reference_kind, reference_hash, device_id,
       contact_id, source_capture_id, verified_by
     ) VALUES ($1,'tinder','tinder_human_armed_conversation_v1',$2,$3,$4,$5,'local-test')`,
    [bindingId, (suffix === "a" ? "e" : "f").repeat(64), deviceId, contactId, captureId]
  );
  return bindingId;
}

async function insertStageCommand(pool, deviceId) {
  const commandId = randomUUID();
  await pool.query(
    `INSERT INTO device_bridge_commands (
       command_id, device_id, protocol_version, command_type, payload,
       configuration_revision, expires_at
     ) VALUES ($1,$2,1,'STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION','{}'::jsonb,1,NOW() + INTERVAL '10 minutes')`,
    [commandId, deviceId]
  );
  return commandId;
}

async function insertSyncCommand(pool, deviceId) {
  const commandId = randomUUID();
  await pool.query(
    `INSERT INTO device_bridge_commands (
       command_id, device_id, protocol_version, command_type, payload,
       configuration_revision, expires_at
     ) VALUES ($1,$2,1,'SYNC_TINDER_VISIBLE_CHAT','{}'::jsonb,1,NOW() + INTERVAL '10 minutes')`,
    [commandId, deviceId]
  );
  return commandId;
}

async function insertAttestationPermit(pool, {
  commandId, deviceId, bindingId, bindingRevision = 1
}) {
  await pool.query(
    `INSERT INTO tinder_local_conversation_attestation_permits (
       command_id, device_id, binding_id, binding_revision, permit_contract_version,
       expires_at
     ) VALUES ($1,$2,$3,$4,1,NOW() + INTERVAL '10 minutes')`,
    [commandId, deviceId, bindingId, bindingRevision]
  );
}

async function createAttestationScopeFixtures(pool) {
  const deviceA = await insertDevice(pool, "a");
  const deviceB = await insertDevice(pool, "b");
  const contactA = await insertContact(pool, "a");
  const contactB = await insertContact(pool, "b");
  const captureA = await insertCapture(pool, { deviceId: deviceA, suffix: "a" });
  const captureB = await insertCapture(pool, { deviceId: deviceB, suffix: "b" });
  const bindingA = await insertBinding(pool, { deviceId: deviceA, captureId: captureA, contactId: contactA, suffix: "a" });
  const bindingB = await insertBinding(pool, { deviceId: deviceB, captureId: captureB, contactId: contactB, suffix: "b" });
  const commandA = await insertStageCommand(pool, deviceA);
  await insertAttestationPermit(pool, { commandId: commandA, deviceId: deviceA, bindingId: bindingA });
  return { deviceA, deviceB, captureA, captureB, bindingA, bindingB, commandA };
}

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

function pauseBeforeFirstTableLockPool(pool, barrier) {
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, ...args) {
          const statement = String(sql);
          barrier.sql.push(statement);
          if (!barrier.paused && /^\s*LOCK TABLE\b/i.test(statement)) {
            barrier.paused = true;
            barrier.firstLockReached.resolve();
            await barrier.continueLocks.promise;
          }
          return client.query(sql, ...args);
        },
        release(error) { return client.release(error); }
      };
    }
  };
}

test("real loopback PostgreSQL applies and postchecks the local conversation attestation foundation", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV5Foundation(pool);
    assert.deepEqual(await validateTinderLocalConversationAttestationPreDdl(pool), {
      migrated: false,
      preflight: { foundation: { state: "UPGRADE_REQUIRED" }, mutate: true }
    });
    assert.deepEqual(await migrateTinderLocalConversationAttestation(pool), {
      migrated: true,
      preflight: { foundation: { state: "UPGRADE_REQUIRED" }, mutate: true }
    });
    const client = await pool.connect();
    try {
      await assertTinderLocalConversationAttestationSchemaReady(client);
    } finally {
      client.release();
    }
    assert.deepEqual(await validateTinderLocalConversationAttestationPreDdl(pool), {
      migrated: false,
      preflight: { foundation: { state: "CANONICAL" }, mutate: false }
    });
  }, { prefix: "marcel_local_attestation" });
});

test("real loopback PostgreSQL rejects mismatched command/device, V4-attestation and audit tuples", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV5Foundation(pool);
    await migrateTinderLocalConversationAttestation(pool);
    const scope = await createAttestationScopeFixtures(pool);

    const wrongDeviceCommand = await insertStageCommand(pool, scope.deviceA);
    await assert.rejects(
      () => insertAttestationPermit(pool, {
        commandId: wrongDeviceCommand,
        deviceId: scope.deviceB,
        bindingId: scope.bindingB
      }),
      error => error?.code === "23503"
        && error?.constraint === "tinder_local_conversation_attestation_permits_command_device_fkey"
    );

    const revisionSyncCommand = await insertSyncCommand(pool, scope.deviceA);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO tinder_visible_chat_sync_permits (
           command_id, device_id, source_capture_id, permit_contract_version,
           attestation_command_id, binding_id, binding_revision, expires_at
         ) VALUES ($1,$2,$3,2,$4,$5,2,NOW() + INTERVAL '10 minutes')`,
        [revisionSyncCommand, scope.deviceA, scope.captureA, scope.commandA, scope.bindingA]
      ),
      error => error?.code === "23503"
        && error?.constraint === "tinder_visible_chat_sync_permits_attestation_scope_fkey"
    );
    await assert.rejects(
      () => pool.query(
        `INSERT INTO tinder_local_conversation_attestation_audit (
           audit_id, command_id, binding_id, binding_revision, device_id,
           action, actor, source, details
         ) VALUES ($1,$2,$3,2,$4,'ISSUED','DASHBOARD_HUMAN','MANUAL_DASHBOARD','{}'::jsonb)`,
        [randomUUID(), scope.commandA, scope.bindingA, scope.deviceA]
      ),
      error => error?.code === "23503"
        && error?.constraint === "tinder_local_conversation_attestation_audit_scope_fkey"
    );

    const validSyncCommand = await insertSyncCommand(pool, scope.deviceA);
    await pool.query(
      `INSERT INTO tinder_visible_chat_sync_permits (
         command_id, device_id, source_capture_id, permit_contract_version,
         attestation_command_id, binding_id, binding_revision, expires_at
       ) VALUES ($1,$2,$3,2,$4,$5,1,NOW() + INTERVAL '10 minutes')`,
      [validSyncCommand, scope.deviceA, scope.captureA, scope.commandA, scope.bindingA]
    );
    await pool.query(
      `INSERT INTO tinder_local_conversation_attestation_audit (
         audit_id, command_id, binding_id, binding_revision, device_id,
         action, actor, source, details
       ) VALUES ($1,$2,$3,1,$4,'ISSUED','DASHBOARD_HUMAN','MANUAL_DASHBOARD','{}'::jsonb)`,
      [randomUUID(), scope.commandA, scope.bindingA, scope.deviceA]
    );

    const syncCommand = await insertSyncCommand(pool, scope.deviceB);
    await assert.rejects(
      () => pool.query(
        `INSERT INTO tinder_visible_chat_sync_permits (
           command_id, device_id, source_capture_id, permit_contract_version,
           attestation_command_id, binding_id, binding_revision, expires_at
         ) VALUES ($1,$2,$3,2,$4,$5,1,NOW() + INTERVAL '10 minutes')`,
        [syncCommand, scope.deviceB, scope.captureB, scope.commandA, scope.bindingB]
      ),
      error => error?.code === "23503"
        && error?.constraint === "tinder_visible_chat_sync_permits_attestation_scope_fkey"
    );

    await assert.rejects(
      () => pool.query(
        `INSERT INTO tinder_local_conversation_attestation_audit (
           audit_id, command_id, binding_id, binding_revision, device_id,
           action, actor, source, details
         ) VALUES ($1,$2,$3,1,$4,'ISSUED','DASHBOARD_HUMAN','MANUAL_DASHBOARD','{}'::jsonb)`,
        [randomUUID(), scope.commandA, scope.bindingB, scope.deviceB]
      ),
      error => error?.code === "23503"
        && error?.constraint === "tinder_local_conversation_attestation_audit_scope_fkey"
    );
  }, { prefix: "marcel_local_attestation_scope" });
});

test("real loopback PostgreSQL locked preflight sees a V1 permit committed after global preflight", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV5Foundation(pool);
    const deviceId = await insertDevice(pool, "barrier");
    const captureId = await insertCapture(pool, { deviceId, suffix: "a" });
    const syncCommand = await insertSyncCommand(pool, deviceId);
    const barrier = {
      paused: false,
      sql: [],
      firstLockReached: deferred(),
      continueLocks: deferred()
    };
    const migration = migrateTinderLocalConversationAttestation(
      pauseBeforeFirstTableLockPool(pool, barrier)
    ).then(() => null, error => error);

    await barrier.firstLockReached.promise;
    await pool.query(
      `INSERT INTO tinder_visible_chat_sync_permits (
         command_id, device_id, source_capture_id, expires_at
       ) VALUES ($1,$2,$3,NOW() + INTERVAL '10 minutes')`,
      [syncCommand, deviceId, captureId]
    );
    barrier.continueLocks.resolve();

    const error = await migration;
    assert.equal(error?.code, "TINDER_LOCAL_CONVERSATION_ATTESTATION_ACTIVE_V1_PERMIT");
    assert.deepEqual(getTinderLocalConversationAttestationMigrationFailureDiagnostic(error), {
      stage: "LOCKED_PREFLIGHT",
      code: "DATABASE_OPERATION_FAILED",
      transaction: "STARTED",
      rollback: "COMPLETED",
      ddl_started: false
    });
    assert.equal(barrier.sql[0], "BEGIN ISOLATION LEVEL READ COMMITTED");
    const commandConstraint = await pool.query(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid='device_bridge_commands'::regclass
          AND contype='c'`
    );
    assert.equal(commandConstraint.rows.some(row => row.conname === "device_bridge_commands_command_type_check_v5"), true);
    assert.equal(commandConstraint.rows.some(row => row.conname === "device_bridge_commands_command_type_check_v6"), false);
  }, { prefix: "marcel_local_attestation_barrier" });
});
