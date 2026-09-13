import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
import {
  assertTinderUnboundInboxConversationSweepSchemaReady,
  inspectTinderUnboundInboxConversationSweepSchema,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_BODY,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_LEGACY_IMMUTABLE_GUARD_BODY,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE
} from "../device-bridge/tinder-unbound-inbox-conversation-sweep-schema.js";
import {
  getTinderUnboundInboxConversationSweepMigrationFailureDiagnostic,
  migrateTinderUnboundInboxConversationSweepFoundation,
  validateTinderUnboundInboxConversationSweepPreDdl
} from "../device-bridge/tinder-unbound-inbox-conversation-sweep-migration.js";
import {
  getTinderUnboundInboxConversationSweepTriggerRepairMigrationFailureDiagnostic,
  migrateTinderUnboundInboxConversationSweepTriggerRepair,
  validateTinderUnboundInboxConversationSweepTriggerRepairPreDdl
} from "../device-bridge/tinder-unbound-inbox-conversation-sweep-trigger-repair-migration.js";
import {
  createPgTinderUnboundInboxConversationSweepRepository,
  createTinderUnboundInboxConversationSweepService,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS
} from "../services/tinder-unbound-inbox-conversation-sweep.js";
import {
  T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES
} from "../device-bridge/protocol-v1.js";
import { runTinderUnboundInboxConversationSweepPreflightCli } from "../scripts/preflight-tinder-unbound-inbox-conversation-sweep.js";
import {
  createDeviceBridgeLegacyRealPostgresFixture,
  withDisposableDeviceBridgeRealPostgresDatabase
} from "./helpers/device-bridge-real-postgres-fixture.js";

/*
 * This opt-in suite uses only the dedicated loopback fixture.  It never reads
 * DATABASE_URL; the helper rejects every non-loopback target before creating
 * its disposable database.
 */

async function createContactFixture(pool) {
  await pool.query("CREATE TABLE contacts (id SERIAL PRIMARY KEY, whatsapp_jid TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())");
  await pool.query("CREATE TABLE contact_identifiers (id BIGSERIAL PRIMARY KEY, contact_id INTEGER NOT NULL, identifier_type TEXT NOT NULL, identifier_value TEXT NOT NULL, normalized_value TEXT NOT NULL, source_platform TEXT, is_primary BOOLEAN, human_verified BOOLEAN, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ)");
  await pool.query("ALTER TABLE contacts ADD COLUMN display_name TEXT, ADD COLUMN canonical_name TEXT, ADD COLUMN memory_identity_key TEXT, ADD COLUMN identity_locked BOOLEAN DEFAULT FALSE, ADD COLUMN source_platform TEXT, ADD COLUMN current_platform TEXT, ADD COLUMN platform_status TEXT, ADD COLUMN contact_status TEXT DEFAULT 'active', ADD COLUMN relationship_stage TEXT DEFAULT 'new', ADD COLUMN auto_reply_enabled BOOLEAN DEFAULT TRUE, ADD COLUMN manual_review_required BOOLEAN DEFAULT FALSE, ADD COLUMN first_contact_at TIMESTAMPTZ");
  await pool.query("CREATE TABLE contact_memory_profiles (contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE)");
}

async function prepareV6Foundation(pool) {
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
}

function legacyV8MigrationSource() {
  const source = readFileSync(
    new URL("../migrations/20260912_tinder_unbound_inbox_conversation_sweep_foundation.sql", import.meta.url),
    "utf8"
  );
  const functionStart = source.indexOf("CREATE FUNCTION tinder_unbound_inbox_sweep_immutable_terminal_guard()");
  const bodyStart = source.indexOf("BEGIN", functionStart);
  const bodyEnd = source.indexOf("$guard$;", bodyStart);
  assert.ok(functionStart >= 0 && bodyStart > functionStart && bodyEnd > bodyStart);
  assert.match(source.slice(bodyStart, bodyEnd), /inbox_observation_nonce/);
  assert.match(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_BODY, /ELSIF TG_TABLE_NAME/);
  return `${source.slice(0, bodyStart)}${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_LEGACY_IMMUTABLE_GUARD_BODY.trim()}\n${source.slice(bodyEnd)}`;
}

function tracePool(pool, { afterQuery } = {}) {
  const records = [];
  return {
    records,
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params) {
          records.push({ sql: String(sql), params: params || [] });
          const result = await client.query(sql, params);
          await afterQuery?.({ sql: String(sql), params: params || [], client, result });
          return result;
        },
        release(error) { return client.release(error); }
      };
    },
    async end() {}
  };
}

async function insertV8Device(pool, label) {
  const deviceId = randomUUID();
  await pool.query(
    `INSERT INTO device_bridge_devices (
       device_id, installation_id, display_name, configuration_revision
     ) VALUES ($1,$2,$3,1)`,
    [deviceId, randomUUID(), `unbound-sweep-${label}`]
  );
  return deviceId;
}

async function insertV8ReadCommand(pool, deviceId) {
  const commandId = randomUUID();
  await pool.query(
    `INSERT INTO device_bridge_commands (
       command_id, device_id, protocol_version, command_type, payload,
       configuration_revision, expires_at
     ) VALUES ($1,$2,1,'READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT','{}'::jsonb,1,NOW() + INTERVAL '3 minutes')`,
    [commandId, deviceId]
  );
  return commandId;
}

async function insertActiveV8Scope(client, { deviceId, commandId, slotOrdinal = 1 }) {
  const sweepId = randomUUID();
  await client.query(
    `INSERT INTO tinder_unbound_inbox_conversation_sweeps (
       sweep_id, device_id, inbox_heartbeat_sequence, inbox_observation_nonce,
       active_command_id, expires_at
     ) VALUES ($1,$2,1,$3,$4,NOW() + INTERVAL '30 minutes')`,
    [sweepId, deviceId, randomUUID(), commandId]
  );
  await client.query(
    `INSERT INTO tinder_unbound_inbox_conversation_sweep_steps (
       command_id, sweep_id, device_id, slot_ordinal, child_kind, expires_at
     ) VALUES ($1,$2,$3,$4,'READ',NOW() + INTERVAL '3 minutes')`,
    [commandId, sweepId, deviceId, slotOrdinal]
  );
  return { sweepId, deviceId, commandId, slotOrdinal };
}

async function insertV8Transcript(pool, { sweepId, deviceId, commandId }) {
  const transcriptId = randomUUID();
  await pool.query(
    `INSERT INTO tinder_unbound_inbox_conversation_sweep_transcripts (
       transcript_id, command_id, sweep_id, device_id, source_package,
       layout_schema_version, sync_started_at, sync_completed_at,
       initial_visible_node_count, final_visible_node_count, segment_count,
       overlap_count, transcript_fingerprint, visible_messages,
       transcript_safety_status, received_at
     ) VALUES ($1,$2,$3,$4,'com.tinder','tinder-zte-visible-chat-scroll-v1',
       NOW(),NOW(),1,1,1,0,$5,'[]'::jsonb,'SAFE',NOW())`,
    [transcriptId, commandId, sweepId, deviceId, "a".repeat(64)]
  );
  return transcriptId;
}

test("real loopback PostgreSQL applies, postchecks, and recognizes canonical V8 sweep foundation", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV6Foundation(pool);
    assert.deepEqual(await validateTinderUnboundInboxConversationSweepPreDdl(pool), {
      migrated: false,
      preflight: { foundation: { state: "UPGRADE_REQUIRED" }, mutate: true }
    });
    assert.deepEqual(await migrateTinderUnboundInboxConversationSweepFoundation(pool), {
      migrated: true,
      preflight: { foundation: { state: "UPGRADE_REQUIRED" }, mutate: true }
    });
    const client = await pool.connect();
    try {
      await assertTinderUnboundInboxConversationSweepSchemaReady(client);
    } finally {
      client.release();
    }
    assert.deepEqual(await validateTinderUnboundInboxConversationSweepPreDdl(pool), {
      migrated: false,
      preflight: { foundation: { state: "CANONICAL" }, mutate: false }
    });
  }, { prefix: "marcel_unbound_sweep_v8" });
});

test("real loopback PostgreSQL recognizes and repairs only the legacy V8 immutable trigger without weakening terminal guards", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV6Foundation(pool);
    // This fixture deliberately reconstructs the historical catalog body only
    // to prove upgrade detection and repair.  It does not use Production data.
    await pool.query(legacyV8MigrationSource());
    assert.deepEqual(await inspectTinderUnboundInboxConversationSweepSchema(pool), {
      state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.TRIGGER_REPAIR_REQUIRED
    });

    const deviceId = await insertV8Device(pool, "legacy-trigger-repair");
    const commandId = await insertV8ReadCommand(pool, deviceId);
    const setupClient = await pool.connect();
    let scope;
    try {
      await setupClient.query("BEGIN");
      scope = await insertActiveV8Scope(setupClient, { deviceId, commandId });
      await setupClient.query("COMMIT");
    } finally {
      try { await setupClient.query("ROLLBACK"); } catch {
        // The committed setup transaction is already closed.
      }
      setupClient.release();
    }
    await assert.rejects(
      () => pool.query(
        `UPDATE tinder_unbound_inbox_conversation_sweep_steps
            SET child_state='EXPIRED', closed_at=NOW(), terminal_reason='CHILD_EXPIRED'
          WHERE command_id=$1`,
        [scope.commandId]
      ),
      error => error?.code === "42703"
    );

    assert.deepEqual(await validateTinderUnboundInboxConversationSweepTriggerRepairPreDdl(pool), {
      migrated: false,
      preflight: { foundation: { state: "TRIGGER_REPAIR_REQUIRED" }, mutate: true }
    });
    assert.deepEqual(await migrateTinderUnboundInboxConversationSweepTriggerRepair(pool), {
      migrated: true,
      preflight: { foundation: { state: "TRIGGER_REPAIR_REQUIRED" }, mutate: true }
    });
    assert.deepEqual(await inspectTinderUnboundInboxConversationSweepSchema(pool), {
      state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.CANONICAL
    });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE tinder_unbound_inbox_conversation_sweeps
            SET sweep_state='STOPPED', active_command_id=NULL, closed_at=NOW(), terminal_reason='CHILD_EXPIRED'
          WHERE sweep_id=$1`,
        [scope.sweepId]
      );
      await client.query(
        `UPDATE tinder_unbound_inbox_conversation_sweep_steps
            SET child_state='EXPIRED', closed_at=NOW(), terminal_reason='CHILD_EXPIRED'
          WHERE command_id=$1`,
        [scope.commandId]
      );
      await client.query("COMMIT");
      await assert.rejects(
        () => client.query(
          "UPDATE tinder_unbound_inbox_conversation_sweep_steps SET terminal_reason='UNKNOWN_OUTCOME' WHERE command_id=$1",
          [scope.commandId]
        ),
        error => error?.code === "P0001" && error?.message === "terminal unbound Inbox sweep step is immutable"
      );
    } finally {
      try { await client.query("ROLLBACK"); } catch {
        // The successful COMMIT or failed statement has already closed its transaction.
      }
      client.release();
    }
  }, { prefix: "marcel_unbound_sweep_v8_trigger_repair" });
});

test("real loopback V8 preflight is repeatable-read/read-only and rolls back without DDL or locks", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV6Foundation(pool);
    const trace = tracePool(pool);
    const result = await runTinderUnboundInboxConversationSweepPreflightCli({
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
      stage: "RESULT_VALIDATION"
    });
    assert.equal(trace.records[0]?.sql.trim(), "BEGIN");
    assert.equal(trace.records[1]?.sql.trim(), "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    assert.equal(trace.records.at(-1)?.sql.trim(), "ROLLBACK");
    assert.equal(trace.records.some(record => /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|LOCK)\b/i.test(record.sql)), false);
  }, { prefix: "marcel_unbound_sweep_v8_preflight" });
});

test("real loopback V8 postcheck drift rolls back the whole apply and never commits", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV6Foundation(pool);
    let injected = false;
    const trace = tracePool(pool, {
      async afterQuery({ sql, client }) {
        if (injected || !sql.includes("CREATE TABLE tinder_unbound_inbox_conversation_sweeps")) return;
        injected = true;
        await client.query(
          "CREATE INDEX idx_tinder_unbound_inbox_sweep_postcheck_injected ON tinder_unbound_inbox_conversation_sweeps (issued_at)"
        );
      }
    });
    const error = await migrateTinderUnboundInboxConversationSweepFoundation(trace).catch(value => value);
    assert.equal(injected, true);
    assert.deepEqual(getTinderUnboundInboxConversationSweepMigrationFailureDiagnostic(error), {
      stage: "POSTCHECK",
      code: "DATABASE_OPERATION_FAILED",
      transaction: "STARTED",
      rollback: "COMPLETED",
      ddl_started: true,
      reason: "TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_POSTCHECK_SCHEMA_INVALID"
    });
    assert.equal(trace.records.some(record => record.sql.trim() === "COMMIT"), false);
    assert.equal(trace.records.some(record => record.sql.trim() === "ROLLBACK"), true);
    assert.deepEqual(await inspectTinderUnboundInboxConversationSweepSchema(pool), {
      state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.UPGRADE_REQUIRED
    });
    const residual = await pool.query(
      "SELECT to_regclass('idx_tinder_unbound_inbox_sweep_postcheck_injected') AS relation_name"
    );
    assert.equal(residual.rows[0]?.relation_name, null);
  }, { prefix: "marcel_unbound_sweep_v8_postcheck_rollback" });
});

test("real loopback V8 binds parent, child, transcript, and audit provenance to one sweep/device", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV6Foundation(pool);
    await migrateTinderUnboundInboxConversationSweepFoundation(pool);
    const constraints = await pool.query(
      `SELECT conname
         FROM pg_constraint
        WHERE conrelid IN (
          'tinder_unbound_inbox_conversation_sweep_steps'::regclass,
          'tinder_unbound_inbox_conversation_sweep_transcripts'::regclass,
          'tinder_unbound_inbox_conversation_sweep_audit'::regclass
        )
          AND contype='f'
        ORDER BY conname ASC`
    );
    const names = new Set(constraints.rows.map(row => row.conname));
    for (const name of [
      "tinder_unbound_inbox_conversation_sweep_steps_sweep_device_fkey",
      "tinder_unbound_inbox_conversation_sweep_steps_transcript_scope",
      "tinder_unbound_inbox_sweep_transcripts_step_scope_fkey",
      "tinder_unbound_inbox_conversation_sweep_audit_sweep_device_fkey",
      "tinder_unbound_inbox_conversation_sweep_audit_step_scope_fkey",
      "tinder_unbound_inbox_sweep_audit_transcript_scope_fkey"
    ]) assert.equal(names.has(name), true, name);
    const commandConstraints = await pool.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid='device_bridge_commands'::regclass AND contype='c'`
    );
    assert.equal(commandConstraints.rows.some(row => row.conname === "device_bridge_commands_command_type_check_v6"), false);
    assert.equal(commandConstraints.rows.some(row => row.conname === "device_bridge_commands_command_type_check_v8"), true);
    await pool.query(
      "CREATE INDEX idx_tinder_unbound_inbox_conversation_sweep_unexpected_drift ON tinder_unbound_inbox_conversation_sweeps (issued_at)"
    );
    assert.deepEqual(await inspectTinderUnboundInboxConversationSweepSchema(pool), {
      state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.INVALID
    });
    await assert.rejects(
      () => assertTinderUnboundInboxConversationSweepSchemaReady(pool),
      /not ready/
    );
  }, { prefix: "marcel_unbound_sweep_v8_provenance" });
});

test("real loopback V8 cleans a legacy expired parent's still-active child and permits the next fresh sweep", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV6Foundation(pool);
    await migrateTinderUnboundInboxConversationSweepFoundation(pool);

    const deviceId = await insertV8Device(pool, "expired-parent-active-child");
    const oldCommandId = await insertV8ReadCommand(pool, deviceId);
    const client = await pool.connect();
    let oldScope;
    try {
      await client.query("BEGIN");
      oldScope = await insertActiveV8Scope(client, { deviceId, commandId: oldCommandId });
      await client.query("COMMIT");
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The committed setup transaction is already closed.
      }
      client.release();
    }

    await pool.query(
      `UPDATE device_bridge_devices
          SET bridge_service_state='RUNNING', tinder_state='CONNECTED', automation_state='STOPPED',
              capabilities=$2::jsonb, last_heartbeat_sequence=17, last_accepted_heartbeat_at=NOW()
        WHERE device_id=$1`,
      [deviceId, JSON.stringify(T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES)]
    );
    await pool.query(
      `UPDATE device_bridge_commands
          SET issued_at=NOW() - INTERVAL '4 minutes', expires_at=NOW() - INTERVAL '1 minute'
        WHERE command_id=$1`,
      [oldCommandId]
    );
    await pool.query(
      `UPDATE tinder_unbound_inbox_conversation_sweeps
          SET sweep_state='EXPIRED', active_command_id=NULL, closed_at=NOW(), terminal_reason='SWEEP_EXPIRED',
              issued_at=NOW() - INTERVAL '6 minutes', expires_at=NOW() - INTERVAL '1 minute'
        WHERE sweep_id=$1`,
      [oldScope.sweepId]
    );
    await pool.query(
      `UPDATE tinder_unbound_inbox_conversation_sweep_steps
          SET issued_at=NOW() - INTERVAL '4 minutes', expires_at=NOW() - INTERVAL '1 minute'
        WHERE command_id=$1`,
      [oldCommandId]
    );

    const repository = createPgTinderUnboundInboxConversationSweepRepository(pool);
    const newSweepId = randomUUID();
    const newCommandId = randomUUID();
    const observationNonce = randomUUID();
    const result = await repository.withTransaction(transaction =>
      createTinderUnboundInboxConversationSweepService(repository, {
        createSweepId: () => newSweepId,
        createCommandId: () => newCommandId,
        createAuditId: randomUUID,
        now: () => new Date()
      }).startUnboundInboxConversationSweepFromFreshInboxObservation(transaction, {
        deviceId,
        heartbeatSequence: 17,
        observationNonce,
        inboxNavigation: {
          stage: "INBOX_READY", reason: "NONE", visible_conversation_count: 1,
          observed_event_count: 1, observation_kind: "FRESH_REVIEWED_INBOX_V1",
          observation_nonce: observationNonce
        }
      })
    );

    assert.deepEqual(result, { status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS.QUEUED });
    const oldState = await pool.query(
      `SELECT sweep.sweep_state, sweep.terminal_reason,
              step.child_state, step.terminal_reason AS child_terminal_reason,
              command.terminal_status
         FROM tinder_unbound_inbox_conversation_sweeps sweep
         JOIN tinder_unbound_inbox_conversation_sweep_steps step ON step.sweep_id=sweep.sweep_id
         JOIN device_bridge_commands command ON command.command_id=step.command_id
        WHERE sweep.sweep_id=$1`,
      [oldScope.sweepId]
    );
    assert.deepEqual(oldState.rows, [{
      sweep_state: "EXPIRED", terminal_reason: "SWEEP_EXPIRED",
      child_state: "EXPIRED", child_terminal_reason: "CHILD_EXPIRED",
      terminal_status: "EXPIRED"
    }]);
    const activeChildren = await pool.query(
      `SELECT sweep.sweep_id, step.command_id
         FROM tinder_unbound_inbox_conversation_sweeps sweep
         JOIN tinder_unbound_inbox_conversation_sweep_steps step ON step.sweep_id=sweep.sweep_id
        WHERE sweep.device_id=$1 AND sweep.sweep_state='ACTIVE'
          AND step.child_state IN ('ISSUED','STAGED','RETURN_STAGED')`,
      [deviceId]
    );
    assert.deepEqual(activeChildren.rows, [{ sweep_id: newSweepId, command_id: newCommandId }]);
    const audit = await pool.query(
      `SELECT sweep_id, action, reason_code
         FROM tinder_unbound_inbox_conversation_sweep_audit
        WHERE sweep_id IN ($1,$2)
        ORDER BY created_at ASC, audit_id ASC`,
      [oldScope.sweepId, newSweepId]
    );
    assert.equal(audit.rows.some(row => row.action === "CHILD_EXPIRED" && row.reason_code === "CHILD_EXPIRED"), true);
    assert.equal(audit.rows.some(row => row.sweep_id === oldScope.sweepId && row.action === "SWEEP_EXPIRED"), false);
    assert.equal(audit.rows.some(row => row.action === "SWEEP_ISSUED"), true);
    assert.equal(audit.rows.some(row => row.action === "READ_ISSUED"), true);
  }, { prefix: "marcel_unbound_sweep_v8_expired_parent_child" });
});

test("real loopback V8 rejects cross-step transcript evidence, wrong audit slots, and terminal or deleted active children", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareV6Foundation(pool);
    await migrateTinderUnboundInboxConversationSweepFoundation(pool);

    const deviceA = await insertV8Device(pool, "provenance-a");
    const deviceB = await insertV8Device(pool, "provenance-b");
    const commandA = await insertV8ReadCommand(pool, deviceA);
    const commandB = await insertV8ReadCommand(pool, deviceB);
    const client = await pool.connect();
    let scopeA;
    let scopeB;
    try {
      await client.query("BEGIN");
      scopeA = await insertActiveV8Scope(client, { deviceId: deviceA, commandId: commandA });
      await client.query("COMMIT");
      await client.query("BEGIN");
      scopeB = await insertActiveV8Scope(client, { deviceId: deviceB, commandId: commandB });
      await client.query("COMMIT");

      await client.query(
        `UPDATE tinder_unbound_inbox_conversation_sweep_steps
            SET child_state='STAGED', staged_at=NOW()
          WHERE command_id=$1`,
        [scopeB.commandId]
      );
      const transcriptB = await insertV8Transcript(pool, scopeB);

      await assert.rejects(
        () => client.query(
          `UPDATE tinder_unbound_inbox_conversation_sweep_steps
              SET child_state='TRANSCRIPT_ACCEPTED', transcript_id=$2,
                  staged_at=NOW(), accepted_at=NOW(), closed_at=NOW(),
                  terminal_reason='TRANSCRIPT_ACCEPTED'
            WHERE command_id=$1`,
          [scopeA.commandId, transcriptB]
        ),
        error => error?.code === "23503"
          && error?.constraint === "tinder_unbound_inbox_conversation_sweep_steps_transcript_scope"
      );

      const transcriptA = await insertV8Transcript(pool, scopeA);
      await assert.rejects(
        () => client.query(
          `UPDATE tinder_unbound_inbox_conversation_sweep_steps
              SET child_state='TRANSCRIPT_ACCEPTED', transcript_id=$2,
                  staged_at=NOW(), accepted_at=NOW(), closed_at=NOW(),
                  terminal_reason='TRANSCRIPT_ACCEPTED'
            WHERE command_id=$1`,
          [scopeA.commandId, transcriptA]
        ),
        error => error?.code === "P0001"
          && error?.message === "unbound Inbox sweep active command is outside its scope"
      );

      await assert.rejects(
        () => client.query(
          `INSERT INTO tinder_unbound_inbox_conversation_sweep_audit (
             audit_id, sweep_id, command_id, device_id, slot_ordinal,
             action, actor, source, details
           ) VALUES ($1,$2,$3,$4,2,'READ_STAGED','ANDROID_RUNTIME',
             'SIGNED_DEVICE_INGRESS','{}'::jsonb)`,
          [randomUUID(), scopeA.sweepId, scopeA.commandId, scopeA.deviceId]
        ),
        error => error?.code === "P0001"
          && error?.message === "unbound Inbox sweep child audit slot is outside its scope"
      );

      await client.query("BEGIN");
      await client.query(
        "DELETE FROM tinder_unbound_inbox_conversation_sweep_steps WHERE command_id=$1",
        [scopeA.commandId]
      );
      await assert.rejects(
        () => client.query("COMMIT"),
        error => error?.code === "P0001"
          && error?.message === "unbound Inbox sweep active command is outside its scope"
      );
      await client.query("ROLLBACK");
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The failed deferred commit may already have closed the transaction.
      }
      client.release();
    }
  }, { prefix: "marcel_unbound_sweep_v8_exact_provenance" });
});
