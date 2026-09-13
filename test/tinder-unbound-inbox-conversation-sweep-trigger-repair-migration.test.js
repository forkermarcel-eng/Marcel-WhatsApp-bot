import assert from "node:assert/strict";
import test from "node:test";
import {
  createTinderUnboundInboxConversationSweepTriggerRepairMigrationRunner,
  getTinderUnboundInboxConversationSweepTriggerRepairMigrationFailureDiagnostic
} from "../device-bridge/tinder-unbound-inbox-conversation-sweep-trigger-repair-migration.js";

function runnerFixture({ postcheckDrift = false } = {}) {
  let state = "TRIGGER_REPAIR_REQUIRED";
  const calls = [];
  const client = {
    async query(sql) {
      const text = String(sql);
      calls.push(text);
      if (text.includes("CREATE OR REPLACE FUNCTION tinder_unbound_inbox_sweep_immutable_terminal_guard")) {
        state = postcheckDrift ? "INVALID" : "CANONICAL";
      }
      if (text === "COMMIT" || text === "ROLLBACK" || text.startsWith("BEGIN") || text.startsWith("SET LOCAL") ||
          text.startsWith("LOCK TABLE") || text.includes("pg_try_advisory_xact_lock")) {
        return { rows: text.includes("pg_try_advisory_xact_lock") ? [{ acquired: true }] : [] };
      }
      return { rows: [] };
    },
    release() { calls.push("RELEASE"); }
  };
  const pool = { async connect() { return client; } };
  const preflight = async () => ({
    foundation: { state },
    mutate: state === "TRIGGER_REPAIR_REQUIRED"
  });
  const inspectSchema = async () => ({ state });
  const assertSchemaReady = async () => {
    if (state !== "CANONICAL") throw new Error("V8 trigger repair schema is not ready.");
  };
  return {
    calls,
    pool,
    runner: createTinderUnboundInboxConversationSweepTriggerRepairMigrationRunner({
      migrationSql: "CREATE OR REPLACE FUNCTION tinder_unbound_inbox_sweep_immutable_terminal_guard() RETURNS trigger LANGUAGE plpgsql AS $guard$ BEGIN RETURN NEW; END; $guard$;",
      validateSource() {},
      preflight,
      inspectSchema,
      assertSchemaReady
    })
  };
}

test("V8 immutable trigger repair runs locked preflight, exactly one fixed function replacement, postcheck, and COMMIT", async () => {
  const fixture = runnerFixture();
  const result = await fixture.runner.migrate(fixture.pool);
  assert.equal(result.migrated, true);
  assert.equal(result.preflight.mutate, true);
  assert.equal(fixture.calls.filter(call => call.startsWith("BEGIN")).length, 1);
  assert.equal(fixture.calls.filter(call => call === "COMMIT").length, 1);
  assert.equal(fixture.calls.filter(call => call === "ROLLBACK").length, 0);
  assert.equal(fixture.calls.filter(call => call.includes("CREATE OR REPLACE FUNCTION tinder_unbound_inbox_sweep_immutable_terminal_guard")).length, 1);
  assert.equal(fixture.calls.some(call => /\b(?:ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+|INSERT\s+|UPDATE\s+|DELETE\s+)\b/i.test(call)), false);
});

test("V8 immutable trigger repair rolls back after postcheck drift and never retries", async () => {
  const fixture = runnerFixture({ postcheckDrift: true });
  let failure;
  await assert.rejects(
    () => fixture.runner.migrate(fixture.pool),
    error => { failure = error; return true; }
  );
  assert.deepEqual(getTinderUnboundInboxConversationSweepTriggerRepairMigrationFailureDiagnostic(failure), {
    stage: "POSTCHECK",
    code: "DATABASE_OPERATION_FAILED",
    transaction: "STARTED",
    rollback: "COMPLETED",
    ddl_started: true,
    reason: "TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRIGGER_REPAIR_POSTCHECK_SCHEMA_INVALID"
  });
  assert.equal(fixture.calls.filter(call => call === "COMMIT").length, 0);
  assert.equal(fixture.calls.filter(call => call === "ROLLBACK").length, 1);
  assert.equal(fixture.calls.filter(call => call.includes("CREATE OR REPLACE FUNCTION tinder_unbound_inbox_sweep_immutable_terminal_guard")).length, 1);
});

test("V8 immutable trigger repair pre-DDL path always rolls back and cannot execute the function replacement", async () => {
  const fixture = runnerFixture();
  const result = await fixture.runner.validatePreDdl(fixture.pool);
  assert.equal(result.migrated, false);
  assert.equal(fixture.calls.filter(call => call === "ROLLBACK").length, 1);
  assert.equal(fixture.calls.filter(call => call === "COMMIT").length, 0);
  assert.equal(fixture.calls.some(call => call.includes("CREATE OR REPLACE FUNCTION tinder_unbound_inbox_sweep_immutable_terminal_guard")), false);
});
