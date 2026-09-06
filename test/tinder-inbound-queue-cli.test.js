import assert from "node:assert/strict";
import test from "node:test";
import {
  runTinderInboundQueueFoundationMigrationCli
} from "../scripts/migrate-tinder-inbound-queue-foundation.js";

function logger() {
  const entries = [];
  return {
    entries,
    log(value) { entries.push(String(value)); },
    error(value) { entries.push(String(value)); }
  };
}

test("the explicit T6 CLI refuses to connect or run DDL without --apply", async () => {
  const output = logger();
  let poolCreated = false;
  const result = await runTinderInboundQueueFoundationMigrationCli({
    argv: [],
    environment: { DATABASE_URL: "postgres://not-used" },
    createPool: async () => { poolCreated = true; throw new Error("must not connect"); },
    logger: output
  });
  assert.equal(result, false);
  assert.equal(poolCreated, false);
  assert.match(output.entries.join("\n"), /APPLY_REQUIRED/);
  assert.doesNotMatch(output.entries.join("\n"), /postgres:\/\//i);
});

test("the explicit T6 CLI requires DATABASE_URL before creating a pool", async () => {
  const output = logger();
  let poolCreated = false;
  const result = await runTinderInboundQueueFoundationMigrationCli({
    argv: ["--apply"],
    environment: {},
    createPool: async () => { poolCreated = true; throw new Error("must not connect"); },
    logger: output
  });
  assert.equal(result, false);
  assert.equal(poolCreated, false);
  assert.match(output.entries.join("\n"), /DATABASE_URL_REQUIRED/);
});

test("the explicit T6 CLI reports only bounded success and closes its pool", async () => {
  const output = logger();
  let poolEnded = false;
  const pool = { async end() { poolEnded = true; } };
  const result = await runTinderInboundQueueFoundationMigrationCli({
    argv: ["--apply"],
    environment: { DATABASE_URL: "postgres://test.example/not-logged" },
    createPool: async options => {
      assert.equal(options.connectionString, "postgres://test.example/not-logged");
      return pool;
    },
    migrate: async value => {
      assert.equal(value, pool);
      return { migrated: true };
    },
    logger: output
  });
  assert.equal(result, true);
  assert.equal(poolEnded, true);
  assert.match(output.entries.join("\n"), /MIGRATION_APPLIED/);
  assert.doesNotMatch(output.entries.join("\n"), /test\.example|not-logged/i);
});

test("the explicit T6 CLI turns runner failures into a bounded fail-closed result", async () => {
  const output = logger();
  let poolEnded = false;
  const pool = { async end() { poolEnded = true; } };
  const failure = new Error("untrusted low-level details");
  const result = await runTinderInboundQueueFoundationMigrationCli({
    argv: ["--apply"],
    environment: { DATABASE_URL: "postgres://test.example/not-logged" },
    createPool: async () => pool,
    migrate: async () => { throw failure; },
    logger: output
  });
  assert.equal(result, false);
  assert.equal(poolEnded, true);
  assert.match(output.entries.join("\n"), /DATABASE_OPERATION_FAILED/);
  assert.doesNotMatch(output.entries.join("\n"), /untrusted low-level details/);
});
