import assert from "node:assert/strict";
import test from "node:test";
import { migrateDeviceBridgeAckCanonicalization } from "../device-bridge/ack-canonicalization.js";
import { migrateDeviceBridgeSchema } from "../device-bridge/database.js";
import { verifyDeviceBridgeSchema } from "../device-bridge/schema-readiness.js";
import {
  getTinderIdentityFoundationMigrationFailureDiagnostic,
  migrateTinderIdentityFoundation
} from "../device-bridge/tinder-identity-foundation-migration.js";
import { migrateTinderVisibleChatCaptureSchema } from "../device-bridge/tinder-visible-chat-capture-migration.js";
import {
  createDeviceBridgeLegacyRealPostgresFixture,
  withDisposableDeviceBridgeRealPostgresDatabase
} from "./helpers/device-bridge-real-postgres-fixture.js";

const DEVICE_ID = "78bd81f3-f02c-4381-85f8-7cab9b50afef";
const INSTALLATION_ID = "e63cb3cb-d70a-4c8e-8823-09d36f45f4fd";

function tracePool(pool) {
  const records = [];
  return {
    records,
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, values) {
          records.push({ sql: String(sql), values: values || [] });
          return client.query(sql, values);
        },
        release(error) { return client.release(error); }
      };
    }
  };
}

async function prepareT3Prerequisites(pool) {
  await createDeviceBridgeLegacyRealPostgresFixture(pool);
  await pool.query("CREATE TABLE contacts (id INTEGER PRIMARY KEY, whatsapp_jid TEXT UNIQUE NOT NULL)");
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
  await pool.query(
    "INSERT INTO device_bridge_devices (device_id, installation_id, display_name) VALUES ($1, $2, $3)",
    [DEVICE_ID, INSTALLATION_ID, "Local T3 lock regression device"]
  );
  assert.deepEqual(await migrateDeviceBridgeAckCanonicalization(pool), { migrated: true });
  assert.deepEqual(await migrateDeviceBridgeSchema(pool), { migrated: true });
  assert.deepEqual(await verifyDeviceBridgeSchema(pool), { ready: true });
  assert.equal((await migrateTinderVisibleChatCaptureSchema(pool)).migrated, true);
}

test("real loopback PostgreSQL blocks T3 before DDL while a concurrent writer holds ROW EXCLUSIVE", { timeout: 20_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareT3Prerequisites(pool);
    const holder = await pool.connect();
    const traced = tracePool(pool);
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE contacts IN ROW EXCLUSIVE MODE");
      const startedAt = Date.now();
      const error = await migrateTinderIdentityFoundation(traced).catch(value => value);
      const elapsedMilliseconds = Date.now() - startedAt;

      assert.deepEqual(getTinderIdentityFoundationMigrationFailureDiagnostic(error), {
        stage: "TABLE_LOCK_ACQUISITION",
        code: "LOCK_TIMEOUT",
        transaction: "STARTED",
        rollback: "COMPLETED",
        ddl_started: false
      });
      assert.equal(elapsedMilliseconds >= 4_000, true);
      assert.equal(traced.records.some(record => record.sql === "LOCK TABLE contacts IN SHARE MODE"), true);
      assert.equal(traced.records.some(record => /ALTER TABLE contacts\s+ALTER COLUMN whatsapp_jid/i.test(record.sql)), false);
      assert.equal(traced.records.some(record => /CREATE TABLE IF NOT EXISTS tinder_identity_mapping_audit/i.test(record.sql)), false);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
    const audit = await pool.query("SELECT to_regclass($1) AS relation_name", ["tinder_identity_mapping_audit"]);
    assert.equal(audit.rows[0]?.relation_name || null, null);
  }, { prefix: "marcel_t3_lock_timeout" });
});
