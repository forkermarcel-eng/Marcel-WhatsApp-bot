import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createTinderResumedForegroundChatReturnMigrationRunner,
  getTinderResumedForegroundChatReturnMigrationFailureDiagnostic,
  validateTinderResumedForegroundChatReturnMigrationSource,
  validateTinderResumedForegroundChatReturnPreDdl
} from "../device-bridge/tinder-resumed-foreground-chat-return-migration.js";

function fixture({ postcheckDrift = false, rejectAbsentV10TargetLocks = false } = {}) {
  let state = "UPGRADE_REQUIRED";
  const calls = [];
  const client = {
    async query(sql) {
      const text = String(sql);
      calls.push(text);
      if (text.includes("DROP CONSTRAINT device_bridge_commands_command_type_check_v9")) {
        state = postcheckDrift ? "INVALID" : "CANONICAL";
      }
      if (text.startsWith("LOCK TABLE") && rejectAbsentV10TargetLocks
          && /tinder_resumed_foreground_chat_return_(?:permits|audit)/i.test(text)) {
        const error = new Error("relation does not exist");
        error.code = "42P01";
        throw error;
      }
      if (text === "COMMIT" || text === "ROLLBACK" || text.startsWith("BEGIN")
          || text.startsWith("SET LOCAL") || text.startsWith("LOCK TABLE")
          || text.includes("pg_try_advisory_xact_lock")) {
        return { rows: text.includes("pg_try_advisory_xact_lock") ? [{ acquired: true }] : [] };
      }
      return { rows: [] };
    },
    release() { calls.push("RELEASE"); }
  };
  const preflight = async () => ({ foundation: { state }, mutate: state === "UPGRADE_REQUIRED" });
  const inspectSchema = async () => ({ state });
  const assertSchemaReady = async () => {
    if (state !== "CANONICAL") throw new Error("V10 schema is not ready.");
  };
  return {
    calls,
    pool: { async connect() { return client; } },
    runner: createTinderResumedForegroundChatReturnMigrationRunner({
      migrationSql: "ALTER TABLE device_bridge_commands DROP CONSTRAINT device_bridge_commands_command_type_check_v9;",
      validateSource() {}, preflight, inspectSchema, assertSchemaReady
    })
  };
}

test("V10 fixed migration source is exact and rejects any changed SQL", () => {
  const source = readFileSync(new URL(
    "../migrations/20260914_tinder_resumed_foreground_chat_return_permit_v10.sql", import.meta.url
  ), "utf8");
  assert.deepEqual(validateTinderResumedForegroundChatReturnMigrationSource(source), { valid: true });
  assert.throws(() => validateTinderResumedForegroundChatReturnMigrationSource(`${source}\n-- changed`));
});

test("V10 migration runs one locked transaction, strict postcheck, then commits", async () => {
  const value = fixture();
  const result = await value.runner.migrate(value.pool);
  assert.equal(result.migrated, true);
  assert.equal(value.calls.filter(call => call.startsWith("BEGIN")).length, 1);
  assert.equal(value.calls.filter(call => call === "COMMIT").length, 1);
  assert.equal(value.calls.filter(call => call === "ROLLBACK").length, 0);
  assert.equal(value.calls.filter(call => call.includes("DROP CONSTRAINT device_bridge_commands_command_type_check_v9")).length, 1);
});

test("V10 V9-to-V10 apply never locks either absent additive V10 relation before DDL", async () => {
  const value = fixture({ rejectAbsentV10TargetLocks: true });
  const result = await value.runner.migrate(value.pool);
  const locks = value.calls.filter(call => call.startsWith("LOCK TABLE"));
  assert.equal(result.migrated, true);
  assert.ok(locks.length > 0);
  assert.equal(locks.some(call => /tinder_resumed_foreground_chat_return_(?:permits|audit)/i.test(call)), false);
  assert.equal(value.calls.filter(call => call === "COMMIT").length, 1);
});

test("V10 strict postcheck drift rolls back and emits only its bounded reason", async () => {
  const value = fixture({ postcheckDrift: true });
  let failure;
  await assert.rejects(() => value.runner.migrate(value.pool), error => { failure = error; return true; });
  assert.deepEqual(getTinderResumedForegroundChatReturnMigrationFailureDiagnostic(failure), {
    stage: "POSTCHECK",
    code: "DATABASE_OPERATION_FAILED",
    transaction: "STARTED",
    rollback: "COMPLETED",
    ddl_started: true,
    reason: "TINDER_RESUMED_FOREGROUND_CHAT_RETURN_POSTCHECK_SCHEMA_INVALID"
  });
  assert.equal(value.calls.filter(call => call === "COMMIT").length, 0);
  assert.equal(value.calls.filter(call => call === "ROLLBACK").length, 1);
});

test("V10 exported pre-DDL validation is REPEATABLE READ READ ONLY and never locks or executes DDL", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      const text = String(sql);
      calls.push(text);
      if (text.startsWith("SELECT")) return { rows: [{ active: false }] };
      return { rows: [] };
    },
    release() { calls.push("RELEASE"); }
  };
  const pool = { async connect() { return client; } };
  await assert.rejects(
    () => validateTinderResumedForegroundChatReturnPreDdl(pool),
    /Tinder resumed foreground chat return schema is incompatible/
  );
  assert.equal(calls[0], "BEGIN");
  assert.equal(calls[1], "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  assert.equal(calls.at(-2), "ROLLBACK");
  assert.equal(calls.at(-1), "RELEASE");
  assert.equal(calls.includes("COMMIT"), false);
  assert.equal(calls.some(call => /LOCK TABLE|pg_try_advisory_xact_lock|DROP CONSTRAINT|CREATE TABLE/i.test(call)), false);
});

test("V10 scope contract checks live exact Resume provenance at creation and receipt revalidates expiry", () => {
  const migrationSource = readFileSync(new URL(
    "../migrations/20260914_tinder_resumed_foreground_chat_return_permit_v10.sql", import.meta.url
  ), "utf8");
  const scopeStart = migrationSource.indexOf("CREATE FUNCTION tinder_resumed_foreground_chat_return_resume_scope_guard()");
  const scopeEnd = migrationSource.indexOf("$$;", scopeStart);
  const scope = migrationSource.slice(scopeStart, scopeEnd);
  assert.match(scope, /resume\.permit_contract_version=2\s+AND resume\.permit_state='DISPATCHED'/s);
  assert.match(scope, /resume\.expires_at > NOW\(\)/);
  assert.match(scope, /resume_command\.terminal_status='SUCCEEDED'/);
  assert.match(scope, /resume_command\.payload='\{\}'::jsonb/);
  assert.doesNotMatch(scope, /source_capture_id|binding_id|binding_revision|thread|profile/i);

  const serviceSource = readFileSync(new URL(
    "../services/tinder-resumed-foreground-chat-return.js", import.meta.url
  ), "utf8");
  const revalidation = serviceSource.slice(
    serviceSource.indexOf("async revalidateResumedForegroundChatReturnPermitForUpdate"),
    serviceSource.indexOf("async markResumedForegroundChatReturnReturned")
  );
  assert.match(revalidation, /permit\.permit_state='STAGED' AND permit\.expires_at>\$3/);
  assert.match(revalidation, /resume\.permit_state='DISPATCHED' AND resume\.expires_at>\$3/);
  assert.doesNotMatch(revalidation, /source_capture_id|binding_id|binding_revision|thread|profile/i);
});
