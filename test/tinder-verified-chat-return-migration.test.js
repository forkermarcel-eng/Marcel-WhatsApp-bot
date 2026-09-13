import assert from "node:assert/strict";
import test from "node:test";
import {
  createTinderVerifiedChatReturnMigrationRunner,
  getTinderVerifiedChatReturnMigrationFailureDiagnostic,
  validateTinderVerifiedChatReturnPreDdl,
  validateTinderVerifiedChatReturnMigrationSource
} from "../device-bridge/tinder-verified-chat-return-migration.js";
import { readFileSync } from "node:fs";

function fixture({ postcheckDrift = false } = {}) {
  let state = "UPGRADE_REQUIRED";
  const calls = [];
  const client = {
    async query(sql) {
      const text = String(sql);
      calls.push(text);
      if (text.includes("ALTER TABLE device_bridge_commands DROP CONSTRAINT device_bridge_commands_command_type_check_v8")) {
        state = postcheckDrift ? "INVALID" : "CANONICAL";
      }
      if (text === "COMMIT" || text === "ROLLBACK" || text.startsWith("BEGIN") || text.startsWith("SET LOCAL")
          || text.startsWith("LOCK TABLE") || text.includes("pg_try_advisory_xact_lock")) {
        return { rows: text.includes("pg_try_advisory_xact_lock") ? [{ acquired: true }] : [] };
      }
      return { rows: [] };
    },
    release() { calls.push("RELEASE"); }
  };
  const preflight = async () => ({ foundation: { state }, mutate: state === "UPGRADE_REQUIRED" });
  const inspectSchema = async () => ({ state });
  const assertSchemaReady = async () => {
    if (state !== "CANONICAL") throw new Error("V9 schema is not ready.");
  };
  return {
    calls,
    pool: { async connect() { return client; } },
    runner: createTinderVerifiedChatReturnMigrationRunner({
      migrationSql: "ALTER TABLE device_bridge_commands DROP CONSTRAINT device_bridge_commands_command_type_check_v8;",
      validateSource() {}, preflight, inspectSchema, assertSchemaReady
    })
  };
}

test("V9 fixed migration source validates exactly and rejects altered source", () => {
  const source = readFileSync(new URL("../migrations/20260913_tinder_verified_chat_return_permit_v9.sql", import.meta.url), "utf8");
  assert.deepEqual(validateTinderVerifiedChatReturnMigrationSource(source), { valid: true });
  assert.throws(() => validateTinderVerifiedChatReturnMigrationSource(`${source}\n-- changed`));
});

test("V9 apply runs one locked transaction, canonical postcheck, then COMMIT", async () => {
  const value = fixture();
  const result = await value.runner.migrate(value.pool);
  assert.equal(result.migrated, true);
  assert.equal(value.calls.filter(call => call.startsWith("BEGIN")).length, 1);
  assert.equal(value.calls.filter(call => call === "COMMIT").length, 1);
  assert.equal(value.calls.filter(call => call === "ROLLBACK").length, 0);
  assert.equal(value.calls.filter(call => call.includes("DROP CONSTRAINT device_bridge_commands_command_type_check_v8")).length, 1);
});

test("V9 postcheck drift rolls back and does not retry", async () => {
  const value = fixture({ postcheckDrift: true });
  let failure;
  await assert.rejects(() => value.runner.migrate(value.pool), error => { failure = error; return true; });
  assert.deepEqual(getTinderVerifiedChatReturnMigrationFailureDiagnostic(failure), {
    stage: "POSTCHECK", code: "DATABASE_OPERATION_FAILED", transaction: "STARTED",
    rollback: "COMPLETED", ddl_started: true,
    reason: "TINDER_VERIFIED_CHAT_RETURN_POSTCHECK_SCHEMA_INVALID"
  });
  assert.equal(value.calls.filter(call => call === "COMMIT").length, 0);
  assert.equal(value.calls.filter(call => call === "ROLLBACK").length, 1);
});

test("V9 exported pre-DDL validation is DB-enforced read-only repeatable-read and never executes DDL", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      const text = String(sql);
      calls.push(text);
      if (text.startsWith("SELECT")) {
        if (text.includes("tinder_unbound_inbox_conversation_sweeps")) return { rows: [{ active: false }] };
        return { rows: [] };
      }
      return { rows: [] };
    },
    release() { calls.push("RELEASE"); }
  };
  const pool = { async connect() { return client; } };
  await assert.rejects(
    () => validateTinderVerifiedChatReturnPreDdl(pool),
    /Tinder verified chat return schema is incompatible/
  );
  assert.equal(calls[0], "BEGIN");
  assert.equal(calls[1], "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  assert.equal(calls.at(-2), "ROLLBACK");
  assert.equal(calls.at(-1), "RELEASE");
  assert.equal(calls.includes("COMMIT"), false);
  assert.equal(calls.some(call => /LOCK TABLE|pg_try_advisory_xact_lock|DROP CONSTRAINT/i.test(call)), false);
});

test("V9 fixed scope guard permits terminal child expiry after a parent expires, while postcheck keeps liveness paths fail closed", () => {
  const migrationSource = readFileSync(
    new URL("../migrations/20260913_tinder_verified_chat_return_permit_v9.sql", import.meta.url),
    "utf8"
  );
  const guardStart = migrationSource.indexOf("CREATE FUNCTION tinder_verified_chat_return_resume_scope_guard()");
  const guardEnd = migrationSource.indexOf("$$;", guardStart);
  assert.ok(guardStart >= 0 && guardEnd > guardStart);
  const guard = migrationSource.slice(guardStart, guardEnd);

  // The durable V2 relation is checked when V9 scope is created or changed.
  // A later state-only ISSUED/STAGED -> EXPIRED transition deliberately does
  // not require an already-expired parent to stay DISPATCHED.
  assert.match(guard, /IF TG_OP = 'INSERT'\s+OR NEW\.resume_command_id IS DISTINCT FROM OLD\.resume_command_id/s);
  assert.match(guard, /resume\.permit_contract_version=2\s+AND resume\.permit_state='DISPATCHED'/s);
  assert.doesNotMatch(guard, /resume\.expires_at/);

  const serviceSource = readFileSync(
    new URL("../services/tinder-verified-chat-return.js", import.meta.url),
    "utf8"
  );
  const receiptRevalidation = serviceSource.slice(
    serviceSource.indexOf("async revalidateVerifiedChatReturnPermitForUpdate"),
    serviceSource.indexOf("async markVerifiedChatReturnReturned")
  );
  assert.match(receiptRevalidation, /resume\.permit_state='DISPATCHED' AND resume\.expires_at>\$3/);

  const heartbeatSource = readFileSync(
    new URL("../device-bridge/heartbeat.js", import.meta.url),
    "utf8"
  );
  const deliveryRevalidation = heartbeatSource.slice(
    heartbeatSource.indexOf("const verifiedChatReturnDeliveryPredicate"),
    heartbeatSource.indexOf("const candidateCommands")
  );
  assert.match(deliveryRevalidation, /resume_permit\.permit_state='DISPATCHED'/);
  assert.match(deliveryRevalidation, /resume_permit\.expires_at>\$2/);
});
