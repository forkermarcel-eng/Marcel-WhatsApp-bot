import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { migrateDeviceBridgeAckCanonicalization } from "../device-bridge/ack-canonicalization.js";
import { migrateDeviceBridgeSchema } from "../device-bridge/database.js";
import { verifyDeviceBridgeSchema } from "../device-bridge/schema-readiness.js";
import {
  assertTinderVisibleChatCaptureSchemaReady,
  preflightTinderVisibleChatCaptureMigration,
  TINDER_VISIBLE_CHAT_CAPTURE_CONSTRAINT_CONTRACT
} from "../device-bridge/tinder-visible-chat-capture-schema.js";
import {
  getTinderVisibleChatCaptureMigrationFailureDiagnostic,
  migrateTinderVisibleChatCaptureSchema
} from "../device-bridge/tinder-visible-chat-capture-migration.js";
import {
  createPgTinderCaptureRepository,
  createTinderCaptureStore
} from "../services/tinder-capture-store.js";
import {
  createDeviceBridgeLegacyRealPostgresFixture,
  createT2ContactsRealPostgresFixture,
  withDisposableDeviceBridgeRealPostgresDatabase
} from "./helpers/device-bridge-real-postgres-fixture.js";

const DEVICE_ID = "ab3b8b72-f975-4920-b9d4-258c3662399f";
const INSTALLATION_ID = "b4d05d04-2330-4c08-874f-9f7de87592e8";
const FIXED_RECEIVED_AT = new Date("2026-09-06T10:00:00.000Z");

function sha256(character) {
  return character.repeat(64);
}

function captureFixture({
  captureFingerprint = sha256("a"),
  threadFingerprint = sha256("b"),
  visibleName = "Lokaler T2-Testthread"
} = {}) {
  return {
    safetyStatus: "SAFE",
    captureMetadata: {
      schemaVersion: "tinder-visible-chat-v1",
      sourcePackage: "com.tinder",
      capturedAt: "2026-09-06T09:59:00.000Z",
      visibleNodeCount: 4,
      captureFingerprint
    },
    visibleThreadMetadata: {
      visibleName,
      threadFingerprint,
      headerClassName: "android.widget.TextView"
    },
    visibleMessages: [
      {
        visibleOrder: 1,
        text: "Lokale Testnachricht",
        direction: "INCOMING",
        sourceClassName: "android.widget.TextView"
      }
    ]
  };
}

function makeTracePool(pool, { afterQuery } = {}) {
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
          await afterQuery?.({ sql: record.sql, params: record.params, rawClient, result, records });
          return result;
        },
        release(error) {
          return rawClient.release(error);
        }
      };
    }
  };
}

async function withClient(pool, callback) {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

async function seedDevice(pool) {
  await pool.query(
    "INSERT INTO device_bridge_devices (device_id, installation_id, display_name) VALUES ($1, $2, $3)",
    [DEVICE_ID, INSTALLATION_ID, "Local real-PostgreSQL T2 test device"]
  );
}

async function prepareCanonicalT2Dependencies(pool) {
  await createDeviceBridgeLegacyRealPostgresFixture(pool);
  await createT2ContactsRealPostgresFixture(pool);
  await seedDevice(pool);
  assert.deepEqual(await migrateDeviceBridgeAckCanonicalization(pool), { migrated: true });
  assert.deepEqual(await migrateDeviceBridgeSchema(pool), { migrated: true });
  assert.deepEqual(await verifyDeviceBridgeSchema(pool), { ready: true });
}

async function captureTablePresent(pool) {
  const result = await pool.query("SELECT to_regclass($1) AS relation_name", ["tinder_visible_chat_captures"]);
  return Boolean(result.rows[0]?.relation_name);
}

async function t2Preflight(pool) {
  return withClient(pool, async client => {
    await client.query("BEGIN");
    try {
      const result = await preflightTinderVisibleChatCaptureMigration(client);
      await client.query("ROLLBACK");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

test("real loopback PostgreSQL completes Foundation -> ACK canonicalization -> final T1 -> T2 capture migration", { timeout: 30_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareCanonicalT2Dependencies(pool);

    assert.deepEqual(await t2Preflight(pool), {
      capture: { state: "ABSENT" },
      mutate: true
    });
    assert.equal(await captureTablePresent(pool), false);

    assert.deepEqual(await migrateTinderVisibleChatCaptureSchema(pool), { migrated: true });
    assert.equal(await captureTablePresent(pool), true);
    await withClient(pool, client => assertTinderVisibleChatCaptureSchemaReady(client));
    assert.deepEqual(await t2Preflight(pool), {
      capture: { state: "CANONICAL" },
      mutate: false
    });
    assert.deepEqual(await verifyDeviceBridgeSchema(pool), { ready: true });

    const contract = await pool.query(`
      SELECT count(*)::integer AS constraint_count,
        count(*) FILTER (WHERE contype IN ('p', 'u'))::integer AS backing_index_count
      FROM pg_constraint
      WHERE conrelid = 'tinder_visible_chat_captures'::regclass
    `);
    assert.equal(contract.rows[0]?.constraint_count, TINDER_VISIBLE_CHAT_CAPTURE_CONSTRAINT_CONTRACT.length);
    assert.equal(contract.rows[0]?.backing_index_count, 3);

    assert.deepEqual(await migrateTinderVisibleChatCaptureSchema(pool), { migrated: false });
    assert.deepEqual(await verifyDeviceBridgeSchema(pool), { ready: true });
  }, { prefix: "marcel_t2_cross_stage" });
});

test("real loopback PostgreSQL rejects a partial T2 capture table without repair or capture DDL", { timeout: 30_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareCanonicalT2Dependencies(pool);
    await pool.query("CREATE TABLE tinder_visible_chat_captures (capture_id UUID PRIMARY KEY)");

    const trace = makeTracePool(pool);
    const error = await migrateTinderVisibleChatCaptureSchema(trace).catch(value => value);
    assert.match(error?.message || "", /capture schema is incompatible/i);
    assert.deepEqual(getTinderVisibleChatCaptureMigrationFailureDiagnostic(error), {
      stage: "GLOBAL_PREFLIGHT",
      code: "DATABASE_OPERATION_FAILED",
      transaction: "STARTED",
      rollback: "COMPLETED",
      ddl_started: false
    });
    assert.equal(trace.records.some(record => /CREATE TABLE tinder_visible_chat_captures/i.test(record.sql)), false);
    assert.equal(trace.records.some(record => /^ALTER\s+TABLE/i.test(record.sql.trim())), false);
    assert.equal(await captureTablePresent(pool), true);
  }, { prefix: "marcel_t2_partial" });
});

test("real loopback PostgreSQL rolls back the T2 table creation when a post-DDL failure is injected", { timeout: 30_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareCanonicalT2Dependencies(pool);
    let injected = false;
    const trace = makeTracePool(pool, {
      afterQuery: async ({ sql }) => {
        if (!injected && /^CREATE\s+TABLE\s+tinder_visible_chat_captures/i.test(sql.trim())) {
          injected = true;
          throw new Error("injected T2 post-DDL failure");
        }
      }
    });

    const error = await migrateTinderVisibleChatCaptureSchema(trace).catch(value => value);
    assert.equal(injected, true);
    assert.match(error?.message || "", /injected T2 post-DDL failure/);
    assert.deepEqual(getTinderVisibleChatCaptureMigrationFailureDiagnostic(error), {
      stage: "DDL_EXECUTION",
      code: "DATABASE_OPERATION_FAILED",
      transaction: "STARTED",
      rollback: "COMPLETED",
      ddl_started: true
    });
    assert.equal(trace.records.some(record => record.sql.trim() === "ROLLBACK"), true);
    assert.equal(trace.records.some(record => record.sql.trim() === "COMMIT"), false);
    assert.equal(await captureTablePresent(pool), false);
  }, { prefix: "marcel_t2_rollback" });
});

test("real loopback PostgreSQL persists only pending human mappings and enforces thread-scoped capture deduplication", { timeout: 30_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareCanonicalT2Dependencies(pool);
    assert.deepEqual(await migrateTinderVisibleChatCaptureSchema(pool), { migrated: true });

    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const repository = createPgTinderCaptureRepository(pool);
    const store = createTinderCaptureStore(repository, {
      createCaptureId: () => ids.shift(),
      now: () => FIXED_RECEIVED_AT
    });
    const threadA = sha256("b");
    const threadB = sha256("c");
    const first = await store.storeSafeCapture({
      deviceId: DEVICE_ID,
      capture: captureFixture({ captureFingerprint: sha256("a"), threadFingerprint: threadA }),
      provenance: { source: "android_visible_chat", protocolVersion: 1 }
    });
    const duplicate = await store.storeSafeCapture({
      deviceId: DEVICE_ID,
      capture: captureFixture({ captureFingerprint: sha256("a"), threadFingerprint: threadA }),
      provenance: { source: "android_visible_chat", protocolVersion: 1 }
    });
    const nextRevision = await store.storeSafeCapture({
      deviceId: DEVICE_ID,
      capture: captureFixture({ captureFingerprint: sha256("d"), threadFingerprint: threadA }),
      provenance: { source: "android_visible_chat", protocolVersion: 1 }
    });
    const differentThread = await store.storeSafeCapture({
      deviceId: DEVICE_ID,
      capture: captureFixture({ captureFingerprint: sha256("a"), threadFingerprint: threadB }),
      provenance: { source: "android_visible_chat", protocolVersion: 1 }
    });

    assert.equal(duplicate.capture_id, first.capture_id);
    assert.equal(Number(first.capture_revision), 1);
    assert.equal(Number(nextRevision.capture_revision), 2);
    assert.equal(Number(differentThread.capture_revision), 1);
    for (const record of [first, nextRevision, differentThread]) {
      assert.equal(record.mapping_status, "NEEDS_HUMAN_MAPPING");
      assert.equal(record.human_review_status, "PENDING");
      assert.equal(record.resolved_contact_id, null);
    }

    await assert.rejects(
      () => repository.withTransaction(client => repository.insertCapture(client, {
        captureId: randomUUID(),
        deviceId: DEVICE_ID,
        schemaVersion: "tinder-visible-chat-v1",
        sourcePackage: "com.tinder",
        captureSafetyStatus: "SAFE",
        runtimeThreadFingerprint: threadA,
        captureFingerprint: sha256("a"),
        captureRevision: 99,
        visibleThreadMetadata: { visibleName: "Lokaler T2-Testthread", threadFingerprint: threadA },
        visibleMessages: [{ visibleOrder: 1, text: "Lokale Testnachricht", direction: "INCOMING" }],
        mappingStatus: "NEEDS_HUMAN_MAPPING",
        humanReviewStatus: "PENDING",
        resolvedContactId: null,
        provenance: { source: "android_visible_chat", protocolVersion: 1 },
        capturedAt: "2026-09-06T09:59:00.000Z",
        receivedAt: FIXED_RECEIVED_AT.toISOString()
      })),
      { code: "23505" }
    );

    const persisted = await pool.query(`
      SELECT count(*)::integer AS capture_count,
        count(*) FILTER (
          WHERE mapping_status = 'NEEDS_HUMAN_MAPPING'
            AND human_review_status = 'PENDING'
            AND resolved_contact_id IS NULL
        )::integer AS pending_human_mapping_count
      FROM tinder_visible_chat_captures
    `);
    assert.deepEqual(persisted.rows[0], {
      capture_count: 3,
      pending_human_mapping_count: 3
    });
  }, { prefix: "marcel_t2_capture_store" });
});
