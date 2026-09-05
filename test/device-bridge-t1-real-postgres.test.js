import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { URL } from "node:url";
import { Pool } from "pg";
import {
  getDeviceBridgeT1MigrationFailureDiagnostic,
  validateDeviceBridgeT1PreDdl
} from "../device-bridge/database.js";
import { runDeviceBridgeAckPayloadSemanticClassifierWithClient } from "../device-bridge/ack-payload-semantic-classifier.js";
import { preflightDeviceBridgeAckSchemaForT1Migration } from "../device-bridge/ack-schema.js";
import { preflightDeviceBridgeFoundationForT1, REQUIRED_TABLES } from "../device-bridge/schema-readiness.js";
import { preflightDeviceBridgeT1SchemaMigration } from "../device-bridge/t1-schema.js";
import { createDeviceBridgeLegacyRealPostgresFixture } from "./helpers/device-bridge-real-postgres-fixture.js";

const LOCAL_TEST_URL_ENV = "DEVICE_BRIDGE_REAL_PG_TEST_URL";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

function localTestDatabaseUrl() {
  const value = process.env[LOCAL_TEST_URL_ENV];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${LOCAL_TEST_URL_ENV} must name an explicitly configured loopback PostgreSQL database.`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${LOCAL_TEST_URL_ENV} must be a valid loopback PostgreSQL URL.`);
  }
  if (!/^postgres(?:ql)?:$/i.test(url.protocol) || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`${LOCAL_TEST_URL_ENV} must target only loopback PostgreSQL; Production URLs are refused.`);
  }
  return url;
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function disposableDatabaseName() {
  return `marcel_t1_preddl_${randomUUID().replaceAll("-", "")}`;
}

function sqlContains(sql, fragment) {
  return String(sql).includes(fragment);
}

function hasT1Ddl(records) {
  return records.some(record => /\b(?:ALTER|CREATE|DROP|TRUNCATE)\b/i.test(record.sql));
}

function makeTracePool(pool, { beforeQuery } = {}) {
  const records = [];
  const state = { connections: 0, releases: 0 };
  return {
    records,
    state,
    async connect() {
      state.connections += 1;
      const rawClient = await pool.connect();
      return {
        async query(sql, params) {
          const record = { sql: String(sql), params: params || [], rowCount: null };
          records.push(record);
          await beforeQuery?.({ sql: record.sql, params: record.params, rawClient, records });
          const result = await rawClient.query(sql, params);
          record.rowCount = Array.isArray(result?.rows) ? result.rows.length : null;
          return result;
        },
        release(error) {
          state.releases += 1;
          return rawClient.release(error);
        }
      };
    }
  };
}

function countSql(records, predicate) {
  return records.filter(record => predicate(record.sql)).length;
}

function lockNames(records) {
  return records
    .filter(record => /^LOCK TABLE\s+/i.test(record.sql.trim()))
    .map(record => record.sql.match(/^LOCK TABLE\s+([a-z_]+)/i)?.[1]);
}

function assertNoT1Ddl(records) {
  assert.equal(hasT1Ddl(records), false, "the local pre-DDL validation must not issue T1 DDL");
  assert.equal(records.some(record => /\b(?:INSERT|UPDATE|DELETE)\b/i.test(record.sql)), false);
}

async function readGrantedLockCount(pool, predicateSql, params = []) {
  const result = await pool.query(`
    SELECT count(*)::integer AS lock_count
    FROM pg_locks
    WHERE granted = true
      AND (${predicateSql})
  `, params);
  return result.rows[0]?.lock_count;
}

async function verifyFixtureWithCurrentPreflights(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    assert.deepEqual(await preflightDeviceBridgeFoundationForT1(client), { ready: true });
    assert.deepEqual(await preflightDeviceBridgeAckSchemaForT1Migration(client), { ready: true });
    const classification = await runDeviceBridgeAckPayloadSemanticClassifierWithClient(client);
    assert.equal(classification.ok, true);
    assert.equal(classification.reason_code, "SEMANTIC_CLASSIFICATION_COMPLETE");
    assert.equal(classification.classification.overall_classification, "SEMANTICALLY_EQUIVALENT");
    assert.equal(classification.classification.production_can_accept_rows_canonical_rejects, false);
    assert.equal(classification.classification.canonical_can_accept_rows_production_rejects, false);
    const t1Preflight = await preflightDeviceBridgeT1SchemaMigration(client);
    assert.deepEqual(t1Preflight.steps.map(step => ({ mutate: step.mutate, state: step.state })), [
      { mutate: true, state: "LEGACY" },
      { mutate: true, state: "LEGACY" }
    ]);
    await client.query("ROLLBACK");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the local fixture/preflight failure as the useful error.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function withDisposableLocalDatabase(callback) {
  const configuredUrl = localTestDatabaseUrl();
  const databaseName = disposableDatabaseName();
  const adminUrl = new URL(configuredUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(configuredUrl);
  testUrl.pathname = `/${databaseName}`;
  const adminPool = new Pool({ connectionString: adminUrl.toString(), max: 2 });
  let testPool;
  try {
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    testPool = new Pool({ connectionString: testUrl.toString(), max: 4 });
    return await callback(testPool);
  } finally {
    await testPool?.end();
    await adminPool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await adminPool.end();
  }
}

test("real loopback PostgreSQL validates the full T1 pre-DDL path, timeout, and recovery", { timeout: 30_000 }, async () => {
  await withDisposableLocalDatabase(async pool => {
    await createDeviceBridgeLegacyRealPostgresFixture(pool);
    await verifyFixtureWithCurrentPreflights(pool);

    const normal = makeTracePool(pool);
    assert.deepEqual(await validateDeviceBridgeT1PreDdl(normal), { validated: true });
    assert.equal(countSql(normal.records, sql => sql.trim() === "BEGIN"), 1);
    assert.equal(countSql(normal.records, sql => sql.trim() === "ROLLBACK"), 1);
    assert.equal(countSql(normal.records, sql => sql.trim() === "COMMIT"), 0);
    assert.equal(normal.records.some(record => sqlContains(record.sql, "SET LOCAL lock_timeout = '5s'")), true);
    assert.equal(normal.records.some(record => sqlContains(record.sql, "SET LOCAL statement_timeout = '30s'")), true);
    assert.equal(normal.records.some(record => sqlContains(record.sql, "SET LOCAL idle_in_transaction_session_timeout = '60s'")), true);
    assert.equal(normal.records.some(record => sqlContains(record.sql, "pg_try_advisory_xact_lock(7421, 1)")), true);
    assert.deepEqual(lockNames(normal.records), REQUIRED_TABLES);
    const semanticRows = normal.records.filter(record => sqlContains(record.sql, "FROM XMLTABLE"));
    assert.equal(semanticRows.length, 2);
    assert.deepEqual(semanticRows.map(record => record.rowCount), [20, 20]);
    const finalLockIndex = normal.records.findLastIndex(record => /^LOCK TABLE\s+/i.test(record.sql.trim()));
    assert.equal(normal.records.slice(finalLockIndex + 1).some(record => sqlContains(record.sql, "FROM pg_class c")), true);
    assert.equal(normal.state.releases, 1);
    assert.equal(normal.state.connections, 1);
    assertNoT1Ddl(normal.records);

    const holder = await pool.connect();
    const timed = makeTracePool(pool);
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE device_bridge_devices IN ROW EXCLUSIVE MODE");
      const startedAt = Date.now();
      let timeoutError;
      try {
        await validateDeviceBridgeT1PreDdl(timed);
      } catch (error) {
        timeoutError = error;
      }
      const elapsedMilliseconds = Date.now() - startedAt;
      assert.ok(timeoutError, "the conflicting ACCESS EXCLUSIVE lock must time out");
      assert.equal(timeoutError.code, "55P03");
      assert.deepEqual(getDeviceBridgeT1MigrationFailureDiagnostic(timeoutError), {
        stage: "TABLE_LOCK_ACQUISITION",
        code: "LOCK_TIMEOUT",
        transaction: "STARTED",
        rollback: "COMPLETED",
        ddl_started: false
      });
      assert.ok(elapsedMilliseconds >= 4_000 && elapsedMilliseconds < 12_000, `expected a bounded ~5s lock timeout, got ${elapsedMilliseconds}ms`);
      assert.equal(countSql(timed.records, sql => sql.trim() === "BEGIN"), 1);
      assert.equal(countSql(timed.records, sql => sql.trim() === "ROLLBACK"), 1);
      assert.deepEqual(lockNames(timed.records), [REQUIRED_TABLES[0]]);
      assert.equal(timed.state.releases, 1);
      assert.equal(timed.state.connections, 1);
      assertNoT1Ddl(timed.records);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    assert.equal(await readGrantedLockCount(pool, "locktype = 'relation' AND relation = 'device_bridge_devices'::regclass"), 0);

    let injected = false;
    const recovery = makeTracePool(pool, {
      beforeQuery: async ({ sql, rawClient }) => {
        if (!injected && sqlContains(sql, "WHERE c.conrelid = 'device_bridge_command_acks'::regclass")) {
          injected = true;
          await rawClient.query("SELECT 1 / 0");
        }
      }
    });
    let recoveryError;
    try {
      await validateDeviceBridgeT1PreDdl(recovery);
    } catch (error) {
      recoveryError = error;
    }
    assert.equal(injected, true);
    assert.ok(recoveryError, "the injected real PostgreSQL statement failure must reach the runner");
    assert.equal(recoveryError.code, "22012");
    assert.deepEqual(getDeviceBridgeT1MigrationFailureDiagnostic(recoveryError), {
      stage: "GLOBAL_PREFLIGHT",
      code: "DATABASE_OPERATION_FAILED",
      transaction: "STARTED",
      rollback: "COMPLETED",
      ddl_started: false
    });
    assert.equal(countSql(recovery.records, sql => sql.trim() === "BEGIN"), 1);
    assert.equal(countSql(recovery.records, sql => sql.trim() === "ROLLBACK"), 1);
    assert.equal(recovery.state.releases, 1);
    assert.equal(recovery.state.connections, 1);
    assertNoT1Ddl(recovery.records);
    assert.equal(await readGrantedLockCount(pool, "locktype = 'advisory' AND classid = 7421 AND objid = 1"), 0);
    const healthy = await pool.query("SELECT 1 AS healthy");
    assert.equal(healthy.rows[0]?.healthy, 1);
  });
});
