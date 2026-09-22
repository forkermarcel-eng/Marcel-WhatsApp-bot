import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PRODUCT_CONVERSATION_MIGRATION_SOURCE_SHA256,
  assertTinderProductConversationMigrationSource,
  createTinderProductConversationMigrationRunner,
  getTinderProductConversationMigrationFailureDiagnostic,
  validateTinderProductConversationMigrationSource
} from "../device-bridge/tinder-product-conversation-migration.js";
import {
  hasCanonicalTinderProductConversationIndexes,
  TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE,
  TINDER_PRODUCT_CONVERSATION_INDEX_CONTRACT
} from "../device-bridge/tinder-product-conversation-schema.js";
import { runTinderProductConversationMigrationCli } from "../scripts/migrate-tinder-product-conversations.js";
import { runTinderProductConversationPreflightCli } from "../scripts/preflight-tinder-product-conversations.js";

const source = readFileSync(
  new URL("../migrations/20260922_tinder_product_conversations.sql", import.meta.url),
  "utf8"
);

function logger() {
  const lines = [];
  return { lines, log(value) { lines.push(String(value)); }, error(value) { lines.push(String(value)); } };
}

function canonicalIndexRows() {
  return TINDER_PRODUCT_CONVERSATION_INDEX_CONTRACT.map(index => ({
    index_name: index.name,
    table_name: index.table,
    access_method: index.accessMethod,
    indisvalid: true,
    indisready: true,
    indisunique: index.unique,
    column_names: index.columns,
    descending: index.descending,
    predicate: index.predicate
  }));
}

test("product-conversation SQL accepts only the reviewed source after platform newline normalization", () => {
  assert.deepEqual(validateTinderProductConversationMigrationSource(source), { valid: true });
  assert.match(PRODUCT_CONVERSATION_MIGRATION_SOURCE_SHA256, /^[a-f0-9]{64}$/);
  assert.match(source, /CREATE UNIQUE INDEX idx_tinder_visible_chat_captures_capture_device/);
  assert.match(source, /FOREIGN KEY \(conversation_id, device_id\)\s+REFERENCES tinder_thread_conversations\(conversation_id, device_id\)/);
  assert.match(source, /FOREIGN KEY \(capture_id, device_id\)\s+REFERENCES tinder_visible_chat_captures\(capture_id, device_id\)/);

  const unixCheckout = source.replace(/\r\n?/g, "\n").trim();
  const windowsCheckout = `\r\n\r\n${unixCheckout.replace(/\n/g, "\r\n")}\r\n`;
  assert.deepEqual(validateTinderProductConversationMigrationSource(windowsCheckout), { valid: true });
  assert.throws(() => assertTinderProductConversationMigrationSource(
    source.replace("CREATE INDEX idx_tinder_thread_conversations_device_hint", "CREATE UNIQUE INDEX idx_tinder_thread_conversations_device_hint")
  ));
});

test("strict product index postcheck rejects an expected index on the wrong relation or access method", () => {
  const canonical = canonicalIndexRows();
  assert.equal(hasCanonicalTinderProductConversationIndexes(canonical), true);

  const wrongRelation = canonical.map(row => ({ ...row }));
  wrongRelation[0].table_name = "contacts";
  assert.equal(hasCanonicalTinderProductConversationIndexes(wrongRelation), false);

  const wrongMethod = canonical.map(row => ({ ...row }));
  wrongMethod[2].access_method = "hash";
  assert.equal(hasCanonicalTinderProductConversationIndexes(wrongMethod), false);
});

test("product-conversation preflight and apply CLI remain explicit and inert without their required authority", async () => {
  const output = logger();
  let pools = 0;
  const createPool = async () => { pools += 1; throw new Error("must not construct a pool"); };

  const preflight = await runTinderProductConversationPreflightCli({
    environment: {}, createPool, logger: output
  });
  assert.equal(preflight.ok, false);
  assert.equal(preflight.reason, "DATABASE_URL_REQUIRED");

  const apply = await runTinderProductConversationMigrationCli({
    argv: [], environment: { DATABASE_URL: "postgres://unused" }, createPool, logger: output
  });
  assert.equal(apply, false);
  assert.equal(pools, 0);
  assert.match(output.lines.join("\n"), /APPLY_REQUIRED/);
});

test("product migration CLI rejects extra arguments and never treats an arbitrary result as COMMIT_CONFIRMED", async () => {
  const output = logger();
  let pools = 0;
  const createPool = async () => {
    pools += 1;
    return { async end() {} };
  };
  const extraArgument = await runTinderProductConversationMigrationCli({
    argv: ["--apply", "--dry-run"],
    environment: { DATABASE_URL: "postgres://unused" },
    createPool,
    logger: output
  });
  assert.equal(extraArgument, false);
  assert.equal(pools, 0);

  const malformedResult = await runTinderProductConversationMigrationCli({
    argv: ["--apply"],
    environment: { DATABASE_URL: "postgres://unused" },
    createPool,
    migrate: async () => ({}),
    logger: output
  });
  assert.equal(malformedResult, false);
  assert.equal(pools, 1);
  const lines = output.lines.join("\n");
  assert.match(lines, /COMMIT_CONTRACT_INVALID/);
  assert.equal(lines.includes("COMMIT_CONFIRMED"), false);
});

test("product migration CLI emits COMMIT_CONFIRMED only for its explicit bounded result contract", async () => {
  const output = logger();
  let ended = false;
  const success = await runTinderProductConversationMigrationCli({
    argv: ["--apply"],
    environment: { DATABASE_URL: "postgres://unused" },
    createPool: async () => ({ async end() { ended = true; } }),
    migrate: async () => ({ commitConfirmed: true, migrated: true }),
    logger: output
  });
  assert.equal(success, true);
  assert.equal(ended, true);
  assert.match(output.lines.join("\n"), /COMMIT_CONFIRMED migrated=true/);
});

test("product migration CLI bounds an untrusted diagnostic provider", async () => {
  const marker = "UNBOUNDED-DIAGNOSTIC-MARKER";
  const output = logger();
  const result = await runTinderProductConversationMigrationCli({
    argv: ["--apply"],
    environment: { DATABASE_URL: "postgres://unused" },
    createPool: async () => ({ async end() {} }),
    migrate: async () => { throw new Error("test failure"); },
    getFailureDiagnostic: () => ({
      stage: marker,
      code: marker,
      transaction: marker,
      rollback: marker,
      ddl_started: marker,
      reason: marker
    }),
    logger: output
  });
  assert.equal(result, false);
  const lines = output.lines.join("\n");
  assert.equal(lines.includes(marker), false);
  assert.match(lines, /stage=UNKNOWN code=DATABASE_OPERATION_FAILED/);
});

const TEST_MIGRATION_SQL = "CREATE TABLE tinder_product_conversation_test_only (id integer)";
const ABSENT_PREFLIGHT = Object.freeze({
  foundation: Object.freeze({ state: TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE.ABSENT }),
  mutate: true
});
const CANONICAL_PREFLIGHT = Object.freeze({
  foundation: Object.freeze({ state: TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE.CANONICAL }),
  mutate: false
});

function runnerPool({ onLock } = {}) {
  const calls = [];
  const state = { released: false };
  const client = {
    async query(sql) {
      calls.push(String(sql));
      if (sql === "BEGIN ISOLATION LEVEL READ COMMITTED"
          || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL ")) {
        return { rows: [] };
      }
      if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: true }] };
      if (sql.startsWith("LOCK TABLE ")) return onLock ? onLock(sql) : { rows: [] };
      if (sql === TEST_MIGRATION_SQL) return { rows: [] };
      throw new Error(`Unexpected test migration query: ${sql}`);
    },
    release(error) {
      state.released = true;
      state.releaseError = error || null;
    }
  };
  return {
    calls,
    state,
    pool: { async connect() { return client; } }
  };
}

function fixedRunner({ preflight, inspectSchema, assertSchemaReady } = {}) {
  return createTinderProductConversationMigrationRunner({
    migrationSql: TEST_MIGRATION_SQL,
    validateSource(value) {
      assert.equal(value, TEST_MIGRATION_SQL);
      return { valid: true };
    },
    preflight,
    inspectSchema,
    assertSchemaReady
  });
}

test("ABSENT product schema locks only existing predecessors before fixed DDL and commits only after canonical postcheck", async () => {
  let preflightCalls = 0;
  const runner = fixedRunner({
    async preflight() {
      preflightCalls += 1;
      return preflightCalls < 3 ? ABSENT_PREFLIGHT : CANONICAL_PREFLIGHT;
    },
    async inspectSchema() {
      return { state: TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE.CANONICAL };
    },
    async assertSchemaReady() {
      return { state: TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE.CANONICAL };
    }
  });
  const fake = runnerPool();

  assert.deepEqual(await runner.migrate(fake.pool), { migrated: true, preflight: ABSENT_PREFLIGHT });
  const locks = fake.calls.filter(sql => sql.startsWith("LOCK TABLE "));
  assert.deepEqual(locks, [
    "LOCK TABLE device_bridge_devices IN SHARE MODE",
    "LOCK TABLE contacts IN SHARE MODE",
    "LOCK TABLE tinder_visible_chat_captures IN SHARE MODE"
  ]);
  assert.equal(locks.some(sql => /tinder_thread_conversation/.test(sql)), false);
  assert.equal(fake.calls.filter(sql => sql === TEST_MIGRATION_SQL).length, 1);
  assert.equal(fake.calls.at(-1), "COMMIT");
  assert.equal(fake.state.released, true);
});

test("product migration rolls back a postcheck schema mismatch with its bounded reason", async () => {
  const runner = fixedRunner({
    async preflight() { return ABSENT_PREFLIGHT; },
    async inspectSchema() { return { state: TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE.INVALID }; },
    async assertSchemaReady() { throw new Error("must not reach schema-ready assertion"); }
  });
  const fake = runnerPool();
  const error = await runner.migrate(fake.pool).catch(value => value);

  assert.deepEqual(getTinderProductConversationMigrationFailureDiagnostic(error), {
    stage: "POSTCHECK",
    code: "DATABASE_OPERATION_FAILED",
    transaction: "STARTED",
    rollback: "COMPLETED",
    ddl_started: true,
    reason: "TINDER_PRODUCT_CONVERSATION_POSTCHECK_SCHEMA_INVALID"
  });
  assert.equal(fake.calls.includes(TEST_MIGRATION_SQL), true);
  assert.equal(fake.calls.includes("ROLLBACK"), true);
  assert.equal(fake.calls.includes("COMMIT"), false);
  assert.equal(fake.state.released, true);
});

test("product migration rolls back before DDL when a predecessor table lock times out", async () => {
  const runner = fixedRunner({
    async preflight() { return ABSENT_PREFLIGHT; },
    async inspectSchema() { throw new Error("must not inspect schema after lock failure"); },
    async assertSchemaReady() { throw new Error("must not assert schema after lock failure"); }
  });
  const fake = runnerPool({
    onLock() {
      const error = new Error("test lock timeout");
      error.code = "55P03";
      throw error;
    }
  });
  const error = await runner.migrate(fake.pool).catch(value => value);

  assert.deepEqual(getTinderProductConversationMigrationFailureDiagnostic(error), {
    stage: "TABLE_LOCK_ACQUISITION",
    code: "LOCK_TIMEOUT",
    transaction: "STARTED",
    rollback: "COMPLETED",
    ddl_started: false
  });
  assert.equal(fake.calls.includes(TEST_MIGRATION_SQL), false);
  assert.equal(fake.calls.includes("ROLLBACK"), true);
  assert.equal(fake.calls.includes("COMMIT"), false);
  assert.equal(fake.state.released, true);
});
