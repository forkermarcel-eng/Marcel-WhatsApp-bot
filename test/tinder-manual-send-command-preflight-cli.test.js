import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  runTinderManualSendCommandPreflightCli
} from "../scripts/preflight-tinder-manual-send-command.js";

const environment = { DATABASE_URL: "postgres://private-not-logged" };

function logger() {
  const entries = [];
  return { entries, log(value) { entries.push(String(value)); }, error(value) { entries.push(String(value)); } };
}

function poolTrace() {
  const records = [];
  let released = false;
  let ended = false;
  const client = {
    async query(sql) { records.push(String(sql)); return { rows: [] }; },
    release() { released = true; }
  };
  return {
    records,
    get released() { return released; },
    get ended() { return ended; },
    async createPool() { return { async connect() { return client; }, async end() { ended = true; } }; }
  };
}

test("T5 command operational preflight is repeatable-read/read-only, rolls back, and cannot run DDL", async () => {
  const trace = poolTrace();
  const output = logger();
  const result = await runTinderManualSendCommandPreflightCli({
    environment,
    createPool: trace.createPool,
    preflight: async () => ({ command: { state: "LEGACY" }, mutate: true }),
    logger: output
  });
  assert.deepEqual(result, {
    ok: true,
    reason: "ELIGIBLE_FOR_MIGRATION",
    command_state: "LEGACY",
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
});

test("T5 command operational preflight reports canonical state and drift without leaking database details", async () => {
  const canonical = await runTinderManualSendCommandPreflightCli({
    environment,
    createPool: poolTrace().createPool,
    preflight: async () => ({ command: { state: "CANONICAL" }, mutate: false }),
    logger: logger()
  });
  assert.equal(canonical.reason, "ALREADY_CANONICAL");
  assert.equal(canonical.migration_required, false);

  const output = logger();
  const drift = await runTinderManualSendCommandPreflightCli({
    environment,
    createPool: poolTrace().createPool,
    preflight: async () => { throw new Error("T5 Tinder manual-send command schema is incompatible."); },
    logger: output
  });
  assert.equal(drift.ok, false);
  assert.equal(drift.reason, "T5_MANUAL_SEND_COMMAND_SCHEMA_INCOMPATIBLE");
  assert.equal(output.entries.join("\n").includes("incompatible."), false);
});

test("T5 command operational preflight rejects attempted DDL and has no migration/startup caller", async () => {
  const trace = poolTrace();
  const result = await runTinderManualSendCommandPreflightCli({
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

  const script = readFileSync(new URL("../scripts/preflight-tinder-manual-send-command.js", import.meta.url), "utf8");
  const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(script, /preflightTinderManualSendCommandMigration/);
  assert.match(script, /withDeviceBridgeReadOnlyTransaction/);
  assert.doesNotMatch(script, /migrateTinderManualSendCommand/);
  assert.doesNotMatch(index, /preflight-tinder-manual-send-command/);
});

test("T5 command preflight requires DATABASE_URL before creating a pool", async () => {
  let pools = 0;
  const result = await runTinderManualSendCommandPreflightCli({
    environment: {}, createPool: async () => { pools += 1; }, logger: logger()
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "DATABASE_URL_REQUIRED");
  assert.equal(pools, 0);
});
