import assert from "node:assert/strict";
import test from "node:test";
import { migrateDeviceBridgeAckCanonicalization } from "../device-bridge/ack-canonicalization.js";
import { migrateDeviceBridgeSchema } from "../device-bridge/database.js";
import { verifyDeviceBridgeSchema } from "../device-bridge/schema-readiness.js";
import { migrateTinderVisibleChatCaptureSchema } from "../device-bridge/tinder-visible-chat-capture-migration.js";
import {
  getTinderIdentityFoundationMigrationFailureDiagnostic,
  migrateTinderIdentityFoundation,
  validateTinderIdentityFoundationPreDdl
} from "../device-bridge/tinder-identity-foundation-migration.js";
import { inspectTinderIdentityFoundationSchema } from "../device-bridge/tinder-identity-foundation-schema.js";
import {
  getTinderDraftFoundationMigrationFailureDiagnostic,
  migrateTinderDraftFoundation,
  validateTinderDraftFoundationPreDdl
} from "../device-bridge/tinder-draft-foundation-migration.js";
import { inspectTinderDraftFoundationSchema } from "../device-bridge/tinder-draft-foundation-schema.js";
import {
  getTinderManualSendFoundationMigrationFailureDiagnostic,
  migrateTinderManualSendFoundation,
  validateTinderManualSendFoundationPreDdl
} from "../device-bridge/tinder-manual-send-foundation-migration.js";
import { inspectTinderManualSendFoundationSchema } from "../device-bridge/tinder-manual-send-foundation-schema.js";
import {
  getTinderInboundQueueFoundationMigrationFailureDiagnostic,
  migrateTinderInboundQueueFoundation,
  validateTinderInboundQueueFoundationPreDdl
} from "../device-bridge/tinder-inbound-queue-foundation-migration.js";
import { inspectTinderInboundQueueFoundationSchema } from "../device-bridge/tinder-inbound-queue-foundation-schema.js";
import {
  createDeviceBridgeLegacyRealPostgresFixture,
  withDisposableDeviceBridgeRealPostgresDatabase
} from "./helpers/device-bridge-real-postgres-fixture.js";

/*
 * This companion suite is intentionally opt-in.  Its shared disposable-DB
 * fixture accepts only the dedicated loopback test URL and this file is not
 * part of normal test, startup, or deploy scripts.
 */

const DEVICE_ID = "315f0521-1a43-429d-b413-02ca48d0ec34";
const INSTALLATION_ID = "af932d0e-e6a3-4e5b-837a-73e9f4c827bb";

async function withClient(pool, callback) {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

function makeTracePool(pool) {
  const records = [];
  return {
    records,
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params) {
          records.push(String(sql));
          return client.query(sql, params);
        },
        release(error) {
          return client.release(error);
        }
      };
    }
  };
}

async function createT3LegacyContactFixture(pool) {
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

async function prepareCanonicalT2(pool) {
  await createDeviceBridgeLegacyRealPostgresFixture(pool);
  await createT3LegacyContactFixture(pool);
  await pool.query(
    "INSERT INTO device_bridge_devices (device_id, installation_id, display_name) VALUES ($1, $2, $3)",
    [DEVICE_ID, INSTALLATION_ID, "Local Tinder foundation runner test device"]
  );
  assert.deepEqual(await migrateDeviceBridgeAckCanonicalization(pool), { migrated: true });
  assert.deepEqual(await migrateDeviceBridgeSchema(pool), { migrated: true });
  assert.deepEqual(await verifyDeviceBridgeSchema(pool), { ready: true });
  assert.equal((await migrateTinderVisibleChatCaptureSchema(pool)).migrated, true);
}

async function runCanonicalStagesThrough(pool, stage) {
  await prepareCanonicalT2(pool);
  if (stage === "T2") return;
  assert.equal((await migrateTinderIdentityFoundation(pool)).migrated, true);
  if (stage === "T3") return;
  assert.equal((await migrateTinderDraftFoundation(pool)).migrated, true);
  if (stage === "T4") return;
  assert.equal((await migrateTinderManualSendFoundation(pool)).migrated, true);
  if (stage === "T5") return;
  throw new Error(`Unsupported canonical Tinder foundation stage: ${stage}`);
}

function stateFromPreflight(preflight) {
  for (const value of Object.values(preflight)) {
    if (value && typeof value === "object" && typeof value.state === "string") return value.state;
  }
  throw new Error("Expected a bounded Tinder foundation preflight state.");
}

async function assertRunnerValidationAndIdempotence(pool, validatePreDdl, migrate) {
  const before = await validatePreDdl(pool);
  assert.equal(before.migrated, false);
  assert.equal(before.preflight.mutate, true);
  assert.equal(stateFromPreflight(before.preflight), "ABSENT");

  const applied = await migrate(pool);
  assert.equal(applied.migrated, true);
  assert.equal(applied.preflight.mutate, true);

  const after = await validatePreDdl(pool);
  assert.equal(after.migrated, false);
  assert.equal(after.preflight.mutate, false);
  assert.equal(stateFromPreflight(after.preflight), "CANONICAL");

  const idempotent = await migrate(pool);
  assert.equal(idempotent.migrated, false);
  assert.equal(idempotent.preflight.mutate, false);
  assert.equal(stateFromPreflight(idempotent.preflight), "CANONICAL");
}

async function relationColumnSignature(pool, relations) {
  const result = await pool.query(`
    SELECT table_name, column_name, data_type, is_nullable, ordinal_position
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ANY($1)
     ORDER BY table_name, ordinal_position
  `, [relations]);
  return result.rows;
}

function assertNoReviewedDdl(records) {
  const reviewedDdl = /\b(?:ALTER\s+TABLE|CREATE\s+(?:TABLE|INDEX|TRIGGER|OR\s+REPLACE\s+FUNCTION)|DROP\s+TRIGGER|DO\s+\$\$)\b/i;
  assert.equal(records.some(sql => reviewedDdl.test(sql)), false);
  assert.equal(records.some(sql => /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(sql)), false);
  assert.equal(records.some(sql => sql.trim() === "COMMIT"), false);
  assert.equal(records.some(sql => sql.trim() === "ROLLBACK"), true);
}

async function assertPartialStateIsNotRepaired({ pool, relations, inspect, migrate, diagnostic }) {
  const before = await relationColumnSignature(pool, relations);
  const trace = makeTracePool(pool);
  const error = await migrate(trace).catch(value => value);
  assert.ok(error instanceof Error);
  assert.equal(diagnostic(error)?.stage, "GLOBAL_PREFLIGHT");
  assert.equal(diagnostic(error)?.ddl_started, false);
  assert.equal(diagnostic(error)?.rollback, "COMPLETED");
  assertNoReviewedDdl(trace.records);
  assert.deepEqual(await relationColumnSignature(pool, relations), before);
  await withClient(pool, async client => {
    assert.equal((await inspect(client)).state, "INVALID");
  });
}

test("real loopback PostgreSQL validates and idempotently rechecks every T3-T6 runner path", { timeout: 60_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareCanonicalT2(pool);
    await assertRunnerValidationAndIdempotence(
      pool,
      validateTinderIdentityFoundationPreDdl,
      migrateTinderIdentityFoundation
    );
    await assertRunnerValidationAndIdempotence(
      pool,
      validateTinderDraftFoundationPreDdl,
      migrateTinderDraftFoundation
    );
    await assertRunnerValidationAndIdempotence(
      pool,
      validateTinderManualSendFoundationPreDdl,
      migrateTinderManualSendFoundation
    );
    await assertRunnerValidationAndIdempotence(
      pool,
      validateTinderInboundQueueFoundationPreDdl,
      migrateTinderInboundQueueFoundation
    );
  }, { prefix: "marcel_t3_t6_runner_paths" });
});

test("real loopback PostgreSQL refuses representative partial T3-T6 states before reviewed DDL", { timeout: 90_000 }, async () => {
  const scenarios = [
    {
      label: "T3",
      async prepare(pool) {
        await runCanonicalStagesThrough(pool, "T2");
        await pool.query("ALTER TABLE contacts ALTER COLUMN whatsapp_jid DROP NOT NULL");
      },
      relations: ["contacts", "contact_identifiers", "tinder_identity_mapping_audit"],
      inspect: inspectTinderIdentityFoundationSchema,
      migrate: migrateTinderIdentityFoundation,
      diagnostic: getTinderIdentityFoundationMigrationFailureDiagnostic
    },
    {
      label: "T4",
      async prepare(pool) {
        await runCanonicalStagesThrough(pool, "T3");
        await pool.query("ALTER TABLE tinder_visible_chat_captures ADD COLUMN identity_revision INTEGER NOT NULL DEFAULT 1");
      },
      relations: ["tinder_visible_chat_captures", "tinder_reply_drafts", "tinder_reply_draft_audit"],
      inspect: inspectTinderDraftFoundationSchema,
      migrate: migrateTinderDraftFoundation,
      diagnostic: getTinderDraftFoundationMigrationFailureDiagnostic
    },
    {
      label: "T5",
      async prepare(pool) {
        await runCanonicalStagesThrough(pool, "T4");
        await pool.query("ALTER TABLE tinder_reply_drafts ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 1");
      },
      relations: ["tinder_reply_drafts", "tinder_reply_send_approvals", "tinder_reply_send_intents", "tinder_reply_send_audit"],
      inspect: inspectTinderManualSendFoundationSchema,
      migrate: migrateTinderManualSendFoundation,
      diagnostic: getTinderManualSendFoundationMigrationFailureDiagnostic
    },
    {
      label: "T6",
      async prepare(pool) {
        await runCanonicalStagesThrough(pool, "T4");
        await pool.query("CREATE TABLE tinder_inbound_work_items (work_item_id UUID PRIMARY KEY)");
      },
      relations: ["tinder_inbound_work_items", "tinder_inbound_work_events", "tinder_inbound_work_audit"],
      inspect: inspectTinderInboundQueueFoundationSchema,
      migrate: migrateTinderInboundQueueFoundation,
      diagnostic: getTinderInboundQueueFoundationMigrationFailureDiagnostic
    }
  ];

  for (const scenario of scenarios) {
    await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
      await scenario.prepare(pool);
      await assertPartialStateIsNotRepaired({ pool, ...scenario });
    }, { prefix: `marcel_${scenario.label.toLowerCase()}_partial` });
  }
});
