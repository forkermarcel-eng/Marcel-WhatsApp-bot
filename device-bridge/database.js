import { preflightDeviceBridgeAckSchemaForT1 } from "./ack-schema.js";
import {
  postcheckDeviceBridgeT1SchemaMigration,
  preflightDeviceBridgeT1SchemaMigration
} from "./t1-schema.js";
import { preflightDeviceBridgeFoundationForT1, REQUIRED_TABLES } from "./schema-readiness.js";

/* ==================================================
DEVICE BRIDGE T1 — EXPLICIT T1-ONLY MIGRATION
================================================== */

async function preflightDeviceBridgeT1Release(client) {
  await preflightDeviceBridgeFoundationForT1(client);
  await preflightDeviceBridgeAckSchemaForT1(client);
  const t1 = await preflightDeviceBridgeT1SchemaMigration(client);
  return { t1 };
}

async function postcheckDeviceBridgeT1Release(client) {
  await preflightDeviceBridgeFoundationForT1(client);
  await preflightDeviceBridgeAckSchemaForT1(client);
  await postcheckDeviceBridgeT1SchemaMigration(client);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

/**
 * Locks every verified foundation relation after the first read-only pass,
 * then the same full preflight is repeated under those locks. Locks are not
 * DDL; they eliminate a schema TOCTOU window before the two allowed ALTERs.
 */
async function lockVerifiedDeviceBridgeFoundation(client) {
  for (const table of REQUIRED_TABLES) {
    await client.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
  }
}

/**
 * The only mutating statements reachable from the explicit T1 runner:
 * - device_bridge_devices: legacy tinder_state CHECK -> _v1 (CONNECTING)
 * - device_bridge_commands: legacy command_type CHECK -> _v1 (CONNECT/DISCONNECT)
 * Both require ACCESS EXCLUSIVE because PostgreSQL replaces a table CHECK.
 */
async function applyVerifiedT1SchemaPlan(client, preflight) {
  for (const step of preflight.steps) {
    if (!step.mutate) continue;
    await client.query(
      `ALTER TABLE ${step.specification.table} DROP CONSTRAINT ${quoteIdentifier(step.constraintName)}`
    );
    await client.query(`
      ALTER TABLE ${step.specification.table}
      ADD CONSTRAINT ${step.specification.name}
      CHECK (${step.specification.expression})
    `);
  }
  return { migrated: preflight.steps.some(step => step.mutate) };
}

/**
 * The explicit CLI target. It never bootstraps or repairs the Device Bridge
 * foundation or ACK schema. Before the first ALTER it performs a complete
 * read-only preflight, locks the already-verified foundation, then repeats
 * the same read-only preflight under those locks before the two T1 checks.
 */
export async function migrateDeviceBridgeSchema(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await preflightDeviceBridgeT1Release(client);
    await lockVerifiedDeviceBridgeFoundation(client);
    const lockedPreflight = await preflightDeviceBridgeT1Release(client);
    const result = await applyVerifiedT1SchemaPlan(client, lockedPreflight.t1);
    await postcheckDeviceBridgeT1Release(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
