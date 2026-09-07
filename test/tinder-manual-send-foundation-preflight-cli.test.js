import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  runTinderManualSendFoundationPreflightCli
} from "../scripts/preflight-tinder-manual-send-foundation.js";

function logger() {
  const entries = [];
  return { entries, log(value) { entries.push(String(value)); }, error(value) { entries.push(String(value)); } };
}

function createPoolTrace() {
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
    }
  };
}

const environment = { DATABASE_URL: "postgres://private-not-logged" };

test("T5 operational preflight uses one read-only transaction, rolls back, and never calls DDL or locks", async () => {
  const trace = createPoolTrace();
  const output = logger();
  const result = await runTinderManualSendFoundationPreflightCli({
    environment,
    createPool: trace.createPool,
    preflight: async () => ({ manualSend: { state: "ABSENT" }, mutate: true }),
    logger: output
  });
  assert.deepEqual(result, {
    ok: true,
    reason: "ELIGIBLE_FOR_MIGRATION",
    manual_send_state: "ABSENT",
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

test("T5 operational preflight reports canonical state without requesting an apply", async () => {
  const trace = createPoolTrace();
  const result = await runTinderManualSendFoundationPreflightCli({
    environment,
    createPool: trace.createPool,
    preflight: async () => ({ manualSend: { state: "CANONICAL" }, mutate: false }),
    logger: logger()
  });
  assert.deepEqual(result, {
    ok: true,
    reason: "ALREADY_CANONICAL",
    manual_send_state: "CANONICAL",
    migration_required: false,
    transaction: "READ_ONLY_REPEATABLE_READ",
    rollback: "COMPLETED"
  });
});

test("T5 operational preflight maps drift and dependency failures to bounded reason codes without leaking database detail", async () => {
  for (const [message, expected] of [
    ["T5 Tinder manual-send foundation schema is incompatible.", "T5_MANUAL_SEND_FOUNDATION_SCHEMA_INCOMPATIBLE"],
    ["T4 Tinder draft foundation base schema is not ready.", "T4_DRAFT_BASE_NOT_READY"],
    ["T3 identity foundation schema is not ready.", "T3_IDENTITY_NOT_READY"]
  ]) {
    const trace = createPoolTrace();
    const output = logger();
    const result = await runTinderManualSendFoundationPreflightCli({
      environment,
      createPool: trace.createPool,
      preflight: async () => { throw new Error(message); },
      logger: output
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, expected);
    assert.equal(result.rollback, "COMPLETED");
    assert.equal(output.entries.join("\n").includes(message), false);
  }
});

test("T5 operational preflight fails closed if validation attempts a non-SELECT query", async () => {
  const trace = createPoolTrace();
  const result = await runTinderManualSendFoundationPreflightCli({
    environment,
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

test("T5 operational preflight refuses absent database configuration before creating a pool", async () => {
  let pools = 0;
  const result = await runTinderManualSendFoundationPreflightCli({
    environment: {},
    createPool: async () => { pools += 1; },
    logger: logger()
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "DATABASE_URL_REQUIRED");
  assert.equal(pools, 0);
});

test("T5 operational preflight reports a bounded cleanup failure", async () => {
  const trace = createPoolTrace();
  const result = await runTinderManualSendFoundationPreflightCli({
    environment,
    createPool: async () => ({
      async connect() {
        return {
          async query() { return { rows: [] }; },
          release() {}
        };
      },
      async end() { throw new Error("private cleanup error"); }
    }),
    preflight: async () => ({ manualSend: { state: "ABSENT" }, mutate: true }),
    logger: logger()
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "CLEANUP_FAILED");
  assert.equal(trace.ended, false);
});

test("T5 operational preflight remains explicit-only and cannot invoke the migration or startup paths", () => {
  const script = readFileSync(
    new URL("../scripts/preflight-tinder-manual-send-foundation.js", import.meta.url),
    "utf8"
  );
  const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const initialization = readFileSync(new URL("../device-bridge/initialization.js", import.meta.url), "utf8");
  const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  assert.match(script, /preflightTinderManualSendFoundationMigration/);
  assert.match(script, /withDeviceBridgeReadOnlyTransaction/);
  assert.doesNotMatch(script, /migrateTinderManualSendFoundation/);
  assert.doesNotMatch(script, /CREATE\s+TABLE|ALTER\s+TABLE|INSERT\s+INTO|UPDATE\s+|DELETE\s+FROM/i);
  assert.doesNotMatch(index, /preflight-tinder-manual-send-foundation/);
  assert.doesNotMatch(initialization, /preflight-tinder-manual-send-foundation/);
  assert.match(packageJson, /"preflight:tinder-manual-send-foundation"/);
});
