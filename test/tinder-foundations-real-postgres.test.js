import assert from "node:assert/strict";
import test from "node:test";
import { migrateDeviceBridgeAckCanonicalization } from "../device-bridge/ack-canonicalization.js";
import { migrateDeviceBridgeSchema } from "../device-bridge/database.js";
import { verifyDeviceBridgeSchema } from "../device-bridge/schema-readiness.js";
import {
  migrateTinderIdentityFoundation
} from "../device-bridge/tinder-identity-foundation-migration.js";
import {
  assertTinderIdentityFoundationSchemaReady,
  preflightTinderIdentityFoundationMigration
} from "../device-bridge/tinder-identity-foundation-schema.js";
import {
  migrateTinderDraftFoundation
} from "../device-bridge/tinder-draft-foundation-migration.js";
import {
  assertTinderDraftFoundationSchemaReady,
  preflightTinderDraftFoundationMigration
} from "../device-bridge/tinder-draft-foundation-schema.js";
import {
  migrateTinderManualSendFoundation
} from "../device-bridge/tinder-manual-send-foundation-migration.js";
import {
  assertTinderManualSendFoundationSchemaReady,
  preflightTinderManualSendFoundationMigration
} from "../device-bridge/tinder-manual-send-foundation-schema.js";
import {
  migrateTinderInboundQueueFoundation
} from "../device-bridge/tinder-inbound-queue-foundation-migration.js";
import {
  assertTinderInboundQueueFoundationSchemaReady,
  preflightTinderInboundQueueFoundationMigration
} from "../device-bridge/tinder-inbound-queue-foundation-schema.js";
import {
  createDeviceBridgeLegacyRealPostgresFixture,
  withDisposableDeviceBridgeRealPostgresDatabase
} from "./helpers/device-bridge-real-postgres-fixture.js";

const DEVICE_ID = "69227f75-e8a9-4d38-90e1-f3ebefa7d391";
const INSTALLATION_ID = "52643021-0d6a-4a3d-a6c3-5d668dfdd32b";

async function withClient(pool, callback) {
  const client = await pool.connect();
  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

async function withRollbackPreflight(pool, preflight) {
  return withClient(pool, async client => {
    await client.query("BEGIN");
    try {
      const result = await preflight(client);
      await client.query("ROLLBACK");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  });
}

/** The smallest actual contact foundation required by T3's documented contract. */
async function createT3ContactFixture(pool) {
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

async function prepareT3Dependencies(pool) {
  await createDeviceBridgeLegacyRealPostgresFixture(pool);
  await createT3ContactFixture(pool);
  await pool.query(
    "INSERT INTO device_bridge_devices (device_id, installation_id, display_name) VALUES ($1, $2, $3)",
    [DEVICE_ID, INSTALLATION_ID, "Local real-PostgreSQL Tinder foundation device"]
  );
  assert.deepEqual(await migrateDeviceBridgeAckCanonicalization(pool), { migrated: true });
  assert.deepEqual(await migrateDeviceBridgeSchema(pool), { migrated: true });
  assert.deepEqual(await verifyDeviceBridgeSchema(pool), { ready: true });
}

test("real loopback PostgreSQL applies and recognizes the exact T3 through T6 foundation chain", { timeout: 45_000 }, async () => {
  await withDisposableDeviceBridgeRealPostgresDatabase(async pool => {
    await prepareT3Dependencies(pool);

    // T3 requires the canonical signed-capture table, which is intentionally
    // created by its own explicit predecessor rather than a fixture shortcut.
    const { migrateTinderVisibleChatCaptureSchema } = await import("../device-bridge/tinder-visible-chat-capture-migration.js");
    assert.equal((await migrateTinderVisibleChatCaptureSchema(pool)).migrated, true);

    assert.deepEqual(await withRollbackPreflight(pool, preflightTinderIdentityFoundationMigration), {
      identity: { state: "ABSENT" }, mutate: true
    });
    assert.equal((await migrateTinderIdentityFoundation(pool)).migrated, true);
    await withClient(pool, assertTinderIdentityFoundationSchemaReady);
    assert.deepEqual(await withRollbackPreflight(pool, preflightTinderIdentityFoundationMigration), {
      identity: { state: "CANONICAL" }, mutate: false
    });

    assert.deepEqual(await withRollbackPreflight(pool, preflightTinderDraftFoundationMigration), {
      draft: { state: "ABSENT" }, mutate: true
    });
    assert.equal((await migrateTinderDraftFoundation(pool)).migrated, true);
    await withClient(pool, assertTinderDraftFoundationSchemaReady);
    assert.deepEqual(await withRollbackPreflight(pool, preflightTinderDraftFoundationMigration), {
      draft: { state: "CANONICAL" }, mutate: false
    });

    assert.deepEqual(await withRollbackPreflight(pool, preflightTinderManualSendFoundationMigration), {
      manualSend: { state: "ABSENT" }, mutate: true
    });
    assert.equal((await migrateTinderManualSendFoundation(pool)).migrated, true);
    await withClient(pool, assertTinderManualSendFoundationSchemaReady);
    assert.deepEqual(await withRollbackPreflight(pool, preflightTinderManualSendFoundationMigration), {
      manualSend: { state: "CANONICAL" }, mutate: false
    });

    assert.deepEqual(await withRollbackPreflight(pool, preflightTinderInboundQueueFoundationMigration), {
      inboundQueue: { state: "ABSENT" }, mutate: true
    });
    assert.equal((await migrateTinderInboundQueueFoundation(pool)).migrated, true);
    await withClient(pool, assertTinderInboundQueueFoundationSchemaReady);
    assert.deepEqual(await withRollbackPreflight(pool, preflightTinderInboundQueueFoundationMigration), {
      inboundQueue: { state: "CANONICAL" }, mutate: false
    });
  }, { prefix: "marcel_t3_t6_foundations" });
});
