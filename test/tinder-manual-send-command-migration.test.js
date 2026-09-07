import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createTinderManualSendCommandMigrationRunner,
  getTinderManualSendCommandMigrationFailureDiagnostic
} from "../device-bridge/tinder-manual-send-command-migration.js";
import {
  TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE
} from "../device-bridge/tinder-manual-send-command-schema.js";

function runnerFixture({ postcheckDrift = false } = {}) {
  let mode = "LEGACY";
  const calls = [];
  const client = {
    async query(sql) {
      const text = String(sql);
      calls.push(text);
      if (text.includes("DROP CONSTRAINT device_bridge_commands_command_type_check_v2")) {
        mode = postcheckDrift ? "INVALID" : "CANONICAL";
      }
      if (text === "COMMIT" || text === "ROLLBACK" || text === "BEGIN" || text.startsWith("SET LOCAL") ||
          text.startsWith("LOCK TABLE") || text.includes("pg_try_advisory_xact_lock")) {
        return { rows: text.includes("pg_try_advisory_xact_lock") ? [{ acquired: true }] : [] };
      }
      return { rows: [] };
    },
    release() { calls.push("RELEASE"); }
  };
  const pool = { async connect() { return client; } };
  const preflight = async () => ({
    command: { state: mode },
    mutate: mode === "LEGACY"
  });
  const inspectSchema = async () => ({ state: mode });
  const assertSchemaReady = async () => {
    if (mode !== "CANONICAL") throw new Error("T5 Tinder manual-send command schema is not ready.");
  };
  return {
    calls,
    runner: createTinderManualSendCommandMigrationRunner({ preflight, inspectSchema, assertSchemaReady }),
    pool
  };
}

test("T5 command migration runs preflight, exactly the fixed two-ALTER source, postcheck and one COMMIT", async () => {
  const fixture = runnerFixture();
  const result = await fixture.runner.migrate(fixture.pool);
  assert.equal(result.migrated, true);
  assert.equal(result.preflight.mutate, true);
  assert.equal(fixture.calls.filter(call => call === "BEGIN").length, 1);
  assert.equal(fixture.calls.filter(call => call === "COMMIT").length, 1);
  assert.equal(fixture.calls.filter(call => call === "ROLLBACK").length, 0);
  assert.equal(fixture.calls.filter(call => call.includes("DROP CONSTRAINT device_bridge_commands_command_type_check_v2")).length, 1);
  assert.equal(fixture.calls.filter(call => call.includes("ADD CONSTRAINT device_bridge_commands_command_type_check_v3")).length, 1);
  assert.equal(fixture.calls.some(call => /(?:CREATE|INSERT|UPDATE|DELETE)\s+/i.test(call)), false);
});

test("T5 command migration rolls back after a postcheck drift and never retries", async () => {
  const fixture = runnerFixture({ postcheckDrift: true });
  let error;
  await assert.rejects(
    () => fixture.runner.migrate(fixture.pool),
    caught => { error = caught; return true; }
  );
  const diagnostic = getTinderManualSendCommandMigrationFailureDiagnostic(error);
  assert.deepEqual(diagnostic, {
    stage: "POSTCHECK",
    code: "DATABASE_OPERATION_FAILED",
    transaction: "STARTED",
    rollback: "COMPLETED",
    ddl_started: true,
    reason: "T5_MANUAL_SEND_COMMAND_POSTCHECK_SCHEMA_INVALID"
  });
  assert.equal(fixture.calls.filter(call => call === "BEGIN").length, 1);
  assert.equal(fixture.calls.filter(call => call === "ROLLBACK").length, 1);
  assert.equal(fixture.calls.filter(call => call === "COMMIT").length, 0);
  assert.equal(fixture.calls.filter(call => call.includes("DROP CONSTRAINT device_bridge_commands_command_type_check_v2")).length, 1);
});

test("T5 command pre-DDL path always rolls back and cannot execute the authorized ALTERs", async () => {
  const fixture = runnerFixture();
  const result = await fixture.runner.validatePreDdl(fixture.pool);
  assert.equal(result.migrated, false);
  assert.equal(fixture.calls.filter(call => call === "ROLLBACK").length, 1);
  assert.equal(fixture.calls.filter(call => call === "COMMIT").length, 0);
  assert.equal(fixture.calls.some(call => call.includes("DROP CONSTRAINT device_bridge_commands_command_type_check_v2")), false);
});

test("T5 signed command migration stays explicit-only and has no startup, route, generic admin or writer caller", () => {
  const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const initialization = readFileSync(new URL("../device-bridge/initialization.js", import.meta.url), "utf8");
  const admin = readFileSync(new URL("../device-bridge/admin.js", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../migrations/20260907_tinder_manual_send_command_protocol.sql", import.meta.url), "utf8");
  assert.doesNotMatch(index, /migrate-tinder-manual-send-command|preflight-tinder-manual-send-command/);
  assert.doesNotMatch(initialization, /migrate-tinder-manual-send-command|preflight-tinder-manual-send-command/);
  assert.doesNotMatch(admin, /SEND_TINDER_DRAFT/);
  assert.doesNotMatch(migration, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.match(migration, /SEND_TINDER_DRAFT/);
});
