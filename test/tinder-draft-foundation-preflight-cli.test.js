import assert from "node:assert/strict";
import test from "node:test";
import {
  runTinderDraftFoundationPreflightCli
} from "../scripts/preflight-tinder-draft-foundation.js";

function logger() {
  const entries = [];
  return { entries, log(value) { entries.push(String(value)); }, error(value) { entries.push(String(value)); } };
}

function createPoolTrace({ onPreflight } = {}) {
  const records = [];
  let released = false;
  let ended = false;
  const client = {
    async query(sql) {
      records.push(String(sql));
      return { rows: [] };
    },
    release() { released = true; }
  };
  return {
    records,
    get released() { return released; },
    get ended() { return ended; },
    async createPool() {
      return {
        async connect() { return client; },
        async end() { ended = true; }
      };
    },
    async preflight(value) {
      await onPreflight?.(value);
      return { draft: { state: "ABSENT" }, mutate: true };
    }
  };
}

test("T4 operational preflight uses one read-only transaction, rolls back, and never calls DDL or locks", async () => {
  const trace = createPoolTrace();
  const output = logger();
  const result = await runTinderDraftFoundationPreflightCli({
    environment: { DATABASE_URL: "postgres://private-not-logged" },
    createPool: trace.createPool,
    preflight: trace.preflight,
    logger: output
  });

  assert.deepEqual(result, {
    ok: true,
    reason: "ELIGIBLE_FOR_MIGRATION",
    draft_state: "ABSENT",
    migration_required: true,
    transaction: "READ_ONLY_REPEATABLE_READ",
    rollback: "COMPLETED"
  });
  assert.deepEqual(trace.records, [
    "BEGIN",
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    "ROLLBACK"
  ]);
  assert.equal(trace.released, true);
  assert.equal(trace.ended, true);
  assert.equal(output.entries.join("\n").includes("private-not-logged"), false);
  assert.equal(output.entries.join("\n").includes("DATABASE_URL="), false);
});

test("T4 operational preflight fails bounded on drift and leaks no database detail", async () => {
  const trace = createPoolTrace();
  const output = logger();
  const rawDetail = "catalog detail must not leak";
  const result = await runTinderDraftFoundationPreflightCli({
    environment: { DATABASE_URL: "postgres://private-not-logged" },
    createPool: trace.createPool,
    preflight: async () => { throw new Error(rawDetail); },
    logger: output
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "PREFLIGHT_FAILED",
    draft_state: "UNRESOLVED",
    migration_required: "UNRESOLVED",
    transaction: "READ_ONLY_REPEATABLE_READ",
    rollback: "COMPLETED"
  });
  assert.deepEqual(trace.records, [
    "BEGIN",
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    "ROLLBACK"
  ]);
  assert.equal(output.entries.join("\n").includes(rawDetail), false);
});

test("T4 operational preflight reports canonical state without requesting an apply", async () => {
  const trace = createPoolTrace();
  const result = await runTinderDraftFoundationPreflightCli({
    environment: { DATABASE_URL: "postgres://private-not-logged" },
    createPool: trace.createPool,
    preflight: async () => ({ draft: { state: "CANONICAL" }, mutate: false }),
    logger: logger()
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "ALREADY_CANONICAL");
  assert.equal(result.migration_required, false);
});

test("T4 operational preflight maps schema drift and T3 dependency failures to bounded reason codes", async () => {
  for (const [message, expected] of [
    ["T4 Tinder draft foundation schema is incompatible.", "T4_DRAFT_FOUNDATION_SCHEMA_INCOMPATIBLE"],
    ["T3 identity foundation schema is not ready.", "T3_IDENTITY_NOT_READY"]
  ]) {
    const trace = createPoolTrace();
    const result = await runTinderDraftFoundationPreflightCli({
      environment: { DATABASE_URL: "postgres://private-not-logged" },
      createPool: trace.createPool,
      preflight: async () => { throw new Error(message); },
      logger: logger()
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, expected);
    assert.equal(result.rollback, "COMPLETED");
  }
});

test("T4 operational preflight refuses missing database configuration before creating a pool", async () => {
  let pools = 0;
  const result = await runTinderDraftFoundationPreflightCli({
    environment: {},
    createPool: async () => { pools += 1; },
    logger: logger()
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "DATABASE_URL_REQUIRED");
  assert.equal(pools, 0);
});

test("T4 operational preflight blocks non-SELECT validation before it reaches the database", async () => {
  const trace = createPoolTrace();
  const result = await runTinderDraftFoundationPreflightCli({
    environment: { DATABASE_URL: "postgres://private-not-logged" },
    createPool: trace.createPool,
    preflight: async client => client.query("ALTER TABLE forbidden ADD COLUMN value text"),
    logger: logger()
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PREFLIGHT_GUARD_BLOCKED");
  assert.deepEqual(trace.records, [
    "BEGIN",
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    "ROLLBACK"
  ]);
});
