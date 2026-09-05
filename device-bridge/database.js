import { preflightDeviceBridgeAckSchemaForT1Migration } from "./ack-schema.js";
import {
  postcheckDeviceBridgeT1SchemaMigration,
  preflightDeviceBridgeT1SchemaMigration
} from "./t1-schema.js";
import { preflightDeviceBridgeFoundationForT1, REQUIRED_TABLES } from "./schema-readiness.js";

export const T1_MIGRATION_LOCK_TIMEOUT = "5s";
export const T1_MIGRATION_STATEMENT_TIMEOUT = "30s";
export const T1_MIGRATION_IDLE_TRANSACTION_TIMEOUT = "60s";
const T1_MIGRATION_ADVISORY_LOCK_NAMESPACE = 7421;
const T1_MIGRATION_ADVISORY_LOCK_KEY = 1;

/* ==================================================
DEVICE BRIDGE T1 — EXPLICIT T1-ONLY MIGRATION
================================================== */

async function preflightDeviceBridgeT1Release(client) {
  await preflightDeviceBridgeFoundationForT1(client);
  await preflightDeviceBridgeAckSchemaForT1Migration(client);
  const t1 = await preflightDeviceBridgeT1SchemaMigration(client);
  return { t1 };
}

async function postcheckDeviceBridgeT1Release(client) {
  await preflightDeviceBridgeFoundationForT1(client);
  await preflightDeviceBridgeAckSchemaForT1Migration(client);
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
 * These settings are transaction-local, so the explicit migration cannot
 * alter shared Railway/PostgreSQL defaults. The advisory lock rejects a
 * concurrent runner instead of waiting ambiguously or retrying automatically.
 */
async function configureT1MigrationTransaction(client) {
  await client.query(`SET LOCAL lock_timeout = '${T1_MIGRATION_LOCK_TIMEOUT}'`);
  await client.query(`SET LOCAL statement_timeout = '${T1_MIGRATION_STATEMENT_TIMEOUT}'`);
  await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${T1_MIGRATION_IDLE_TRANSACTION_TIMEOUT}'`);
  const advisory = await client.query(
    `SELECT pg_try_advisory_xact_lock(${T1_MIGRATION_ADVISORY_LOCK_NAMESPACE}, ${T1_MIGRATION_ADVISORY_LOCK_KEY}) AS acquired`
  );
  if (advisory.rows[0]?.acquired !== true) {
    throw new Error("Device Bridge T1 migration is already running.");
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
  let client;
  let transactionStarted = false;
  let commitAttempted = false;
  let committed = false;
  let discardClient = false;
  let releaseError;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;
    await configureT1MigrationTransaction(client);
    await preflightDeviceBridgeT1Release(client);
    await lockVerifiedDeviceBridgeFoundation(client);
    const lockedPreflight = await preflightDeviceBridgeT1Release(client);
    const result = await applyVerifiedT1SchemaPlan(client, lockedPreflight.t1);
    await postcheckDeviceBridgeT1Release(client);
    commitAttempted = true;
    await client.query("COMMIT");
    committed = true;
    return result;
  } catch (error) {
    releaseError = error;
    if (transactionStarted && !commitAttempted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discardClient = true;
      }
    } else {
      // A failed BEGIN/COMMIT has an unknown connection/transaction outcome;
      // discard the client and require a separate operator decision, never a
      // blind retry in this invocation.
      discardClient = true;
    }
    throw error;
  } finally {
    client?.release(discardClient ? releaseError : undefined);
  }
}
