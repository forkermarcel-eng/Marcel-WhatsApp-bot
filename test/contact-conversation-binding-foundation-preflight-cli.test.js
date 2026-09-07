import assert from "node:assert/strict";
import test from "node:test";
import {
  runContactConversationBindingFoundationPreflightCli
} from "../scripts/preflight-contact-conversation-binding-foundation.js";

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
      return { binding: { state: "ABSENT" }, mutate: true };
    }
  };
}

test("binding operational preflight uses one explicit read-only transaction, rolls back, and never calls DDL or locks", async () => {
  const trace = createPoolTrace();
  const output = logger();
  const result = await runContactConversationBindingFoundationPreflightCli({
    environment: { DATABASE_URL: "postgres://private-not-logged" },
    createPool: trace.createPool,
    preflight: trace.preflight,
    logger: output
  });
  assert.deepEqual(result, {
    ok: true,
    reason: "ELIGIBLE_FOR_MIGRATION",
    binding_state: "ABSENT",
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

test("binding operational preflight fails bounded on validation drift, still rolls back, and leaks no error detail", async () => {
  const trace = createPoolTrace();
  const output = logger();
  const rawDetail = "catalog detail must not leak";
  const result = await runContactConversationBindingFoundationPreflightCli({
    environment: { DATABASE_URL: "postgres://private-not-logged" },
    createPool: trace.createPool,
    preflight: async () => { throw new Error(rawDetail); },
    logger: output
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "PREFLIGHT_FAILED",
    binding_state: "UNRESOLVED",
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

test("binding operational preflight reports a canonical binding foundation without requesting another migration", async () => {
  const trace = createPoolTrace();
  const result = await runContactConversationBindingFoundationPreflightCli({
    environment: { DATABASE_URL: "postgres://private-not-logged" },
    createPool: trace.createPool,
    preflight: async () => ({ binding: { state: "CANONICAL" }, mutate: false }),
    logger: logger()
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "ALREADY_CANONICAL");
  assert.equal(result.migration_required, false);
});

test("binding operational preflight refuses absent database configuration before creating a pool", async () => {
  let pools = 0;
  const output = logger();
  const result = await runContactConversationBindingFoundationPreflightCli({
    environment: {},
    createPool: async () => { pools += 1; },
    logger: output
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "DATABASE_URL_REQUIRED");
  assert.equal(pools, 0);
});

test("binding operational preflight blocks a non-SELECT validation query before it reaches the database", async () => {
  const trace = createPoolTrace();
  const output = logger();
  const result = await runContactConversationBindingFoundationPreflightCli({
    environment: { DATABASE_URL: "postgres://private-not-logged" },
    createPool: trace.createPool,
    preflight: async client => client.query("ALTER TABLE forbidden ADD COLUMN value text"),
    logger: output
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "PREFLIGHT_GUARD_BLOCKED");
  assert.deepEqual(trace.records, [
    "BEGIN",
    "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    "ROLLBACK"
  ]);
});
