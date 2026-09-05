import assert from "node:assert/strict";
import test from "node:test";
import { runTinderVisibleChatCaptureMigrationCli } from "../scripts/migrate-tinder-visible-chat-capture.js";

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

test("T2 migration CLI refuses execution without explicit --apply before pool creation", async () => {
  const logs = loggerRecorder();
  let poolCreated = false;
  const result = await runTinderVisibleChatCaptureMigrationCli({
    argv: [],
    environment: { DATABASE_URL: "postgres://unused" },
    createPool: () => { poolCreated = true; },
    logger: logs.logger
  });
  assert.equal(result, false);
  assert.equal(poolCreated, false);
  assert.deepEqual(logs.entries, [
    { level: "error", message: "Refusing T2 visible-chat migration without --apply." },
    { level: "error", message: "T2 visible-chat migration diagnostic: stage=CLI_ARGUMENT_VALIDATION code=APPLY_REQUIRED transaction=NOT_STARTED rollback=NOT_ATTEMPTED ddl_started=false" }
  ]);
});

test("T2 migration CLI refuses a missing database configuration without exposing it", async () => {
  const logs = loggerRecorder();
  const result = await runTinderVisibleChatCaptureMigrationCli({
    argv: ["--apply"],
    environment: {},
    logger: logs.logger
  });
  assert.equal(result, false);
  assert.equal(JSON.stringify(logs.entries).includes("postgres"), false);
  assert.deepEqual(logs.entries, [
    { level: "error", message: "T2 visible-chat migration requires DATABASE_URL." },
    { level: "error", message: "T2 visible-chat migration diagnostic: stage=ENVIRONMENT_VALIDATION code=DATABASE_URL_REQUIRED transaction=NOT_STARTED rollback=NOT_ATTEMPTED ddl_started=false" }
  ]);
});

test("T2 migration CLI invokes only its injected explicit runner and closes the pool", async () => {
  const logs = loggerRecorder();
  const pool = { ended: false, async end() { this.ended = true; } };
  let migrationPool = null;
  const result = await runTinderVisibleChatCaptureMigrationCli({
    argv: ["--apply"],
    environment: { DATABASE_URL: "postgres://not-a-production-test" },
    createPool: async () => pool,
    migrate: async value => { migrationPool = value; return { migrated: false }; },
    logger: logs.logger
  });
  assert.equal(result, true);
  assert.equal(migrationPool, pool);
  assert.equal(pool.ended, true);
  assert.deepEqual(logs.entries, [
    { level: "log", message: "T2 visible-chat capture schema already canonical." },
    { level: "log", message: "T2 visible-chat migration diagnostic: stage=COMMIT_CONFIRMED code=ALREADY_CANONICAL transaction=COMMITTED rollback=NOT_ATTEMPTED ddl_started=false" }
  ]);
});

test("T2 CLI bounds a source-validation failure without leaking raw text", async () => {
  const logs = loggerRecorder();
  const marker = "TEST-SENSITIVE-MARKER-47d5";
  const pool = { async end() {} };
  const result = await runTinderVisibleChatCaptureMigrationCli({
    argv: ["--apply"],
    environment: { DATABASE_URL: "postgres://not-a-production-test" },
    createPool: async () => pool,
    migrate: async () => {
      const error = new Error(marker);
      error.code = "unsafe-unbounded-code";
      throw error;
    },
    logger: logs.logger
  });
  assert.equal(result, false);
  assert.equal(JSON.stringify(logs.entries).includes(marker), false);
  assert.deepEqual(logs.entries, [
    { level: "error", message: "T2 visible-chat migration failed." },
    { level: "error", message: "T2 visible-chat migration diagnostic: stage=UNKNOWN code=DATABASE_OPERATION_FAILED transaction=UNRESOLVED rollback=UNRESOLVED ddl_started=UNRESOLVED" }
  ]);
});
