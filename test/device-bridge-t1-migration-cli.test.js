import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runDeviceBridgeT1MigrationCli } from "../scripts/migrate-device-bridge-t1.js";

function loggerRecorder() {
  const entries = [];
  return {
    entries,
    logger: {
      log(message) { entries.push({ level: "log", message }); },
      error(message) { entries.push({ level: "error", message }); }
    }
  };
}

test("explicit migration CLI refuses missing --apply without creating a pool", async () => {
  const logs = loggerRecorder();
  let poolCreated = false;
  const result = await runDeviceBridgeT1MigrationCli({
    argv: [],
    environment: { DATABASE_URL: "postgres://unused" },
    createPool: () => { poolCreated = true; },
    logger: logs.logger
  });
  assert.equal(result, false);
  assert.equal(poolCreated, false);
  assert.deepEqual(logs.entries, [
    { level: "error", message: "Refusing Device Bridge T1 schema migration without --apply." },
    {
      level: "error",
      message: "Device Bridge T1 migration diagnostic: stage=CLI_ARGUMENT_VALIDATION code=APPLY_REQUIRED transaction=NOT_STARTED rollback=NOT_ATTEMPTED ddl_started=false"
    }
  ]);
});

test("explicit migration CLI requires DATABASE_URL without revealing it", async () => {
  const logs = loggerRecorder();
  const result = await runDeviceBridgeT1MigrationCli({ argv: ["--apply"], environment: {}, logger: logs.logger });
  assert.equal(result, false);
  assert.equal(JSON.stringify(logs.entries).includes("DATABASE_URL="), false);
  assert.equal(JSON.stringify(logs.entries).includes("postgres"), false);
  assert.deepEqual(logs.entries, [
    { level: "error", message: "Device Bridge T1 schema migration requires DATABASE_URL." },
    {
      level: "error",
      message: "Device Bridge T1 migration diagnostic: stage=ENVIRONMENT_VALIDATION code=DATABASE_URL_REQUIRED transaction=NOT_STARTED rollback=NOT_ATTEMPTED ddl_started=false"
    }
  ]);
});

test("explicit migration CLI calls only the injected migration and closes its pool", async () => {
  const logs = loggerRecorder();
  const pool = { ended: false, async end() { this.ended = true; } };
  let migratedPool = null;
  const result = await runDeviceBridgeT1MigrationCli({
    argv: ["--apply"],
    environment: { DATABASE_URL: "postgres://not-a-production-test" },
    createPool: () => pool,
    migrate: async value => { migratedPool = value; return { migrated: false }; },
    logger: logs.logger
  });
  assert.equal(result, true);
  assert.equal(migratedPool, pool);
  assert.equal(pool.ended, true);
  assert.deepEqual(logs.entries, [
    { level: "log", message: "Device Bridge T1 schema already compatible." },
    {
      level: "log",
      message: "Device Bridge T1 migration diagnostic: stage=COMMIT_CONFIRMED code=ALREADY_COMPATIBLE transaction=COMMITTED rollback=NOT_ATTEMPTED ddl_started=false"
    }
  ]);
});

test("explicit migration CLI reports a confirmed successful commit only after closing its pool", async () => {
  const logs = loggerRecorder();
  const pool = { ended: false, async end() { this.ended = true; } };
  const result = await runDeviceBridgeT1MigrationCli({
    argv: ["--apply"],
    environment: { DATABASE_URL: "postgres://not-a-production-test" },
    createPool: () => pool,
    migrate: async () => ({ migrated: true }),
    logger: logs.logger
  });
  assert.equal(result, true);
  assert.equal(pool.ended, true);
  assert.deepEqual(logs.entries, [
    { level: "log", message: "Device Bridge T1 schema migration completed." },
    {
      level: "log",
      message: "Device Bridge T1 migration diagnostic: stage=COMMIT_CONFIRMED code=MIGRATION_APPLIED transaction=COMMITTED rollback=NOT_ATTEMPTED ddl_started=true"
    }
  ]);
});

test("explicit migration CLI reports bounded diagnostics without database details", async () => {
  const raw = "database error includes TEST-SENSITIVE-MARKER-47d5";
  const cases = [
    {
      name: "pool creation",
      createPool: () => { throw new Error(raw); },
      expected: "stage=DATABASE_CONNECTION code=DATABASE_CONNECTION_FAILED transaction=NOT_STARTED rollback=NOT_ATTEMPTED ddl_started=false"
    },
    {
      name: "migration",
      createPool: () => ({ async end() {} }),
      migrate: async () => { throw new Error(raw); },
      expected: "stage=UNKNOWN code=DATABASE_OPERATION_FAILED transaction=UNRESOLVED rollback=UNRESOLVED ddl_started=UNRESOLVED"
    },
    {
      name: "pool cleanup",
      createPool: () => ({ async end() { throw new Error(raw); } }),
      migrate: async () => ({ migrated: true }),
      expected: "stage=CLEANUP code=CLEANUP_FAILED transaction=COMMITTED rollback=NOT_ATTEMPTED ddl_started=true"
    }
  ];
  for (const item of cases) {
    const logs = loggerRecorder();
    const result = await runDeviceBridgeT1MigrationCli({
      argv: ["--apply"],
      environment: { DATABASE_URL: "postgres://not-a-production-test" },
      createPool: item.createPool,
      migrate: item.migrate,
      logger: logs.logger
    });
    assert.equal(result, false, item.name);
    assert.deepEqual(logs.entries, [
      { level: "error", message: "Device Bridge T1 schema migration failed." },
      { level: "error", message: `Device Bridge T1 migration diagnostic: ${item.expected}` }
    ], item.name);
    assert.equal(JSON.stringify(logs.entries).includes("TEST-SENSITIVE-MARKER-47d5"), false, item.name);
  }
});

test("runtime and Vercel functions do not import the explicit migration CLI", () => {
  const index = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const apiFiles = fs.readdirSync(new URL("../api", import.meta.url), { recursive: true })
    .filter(file => typeof file === "string" && file.endsWith(".js"));
  assert.doesNotMatch(index, /migrate-device-bridge-t1/);
  assert.equal(apiFiles.includes("migrate-device-bridge-t1.js"), false);
});
