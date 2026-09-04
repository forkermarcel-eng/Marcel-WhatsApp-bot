import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  T1_COMMAND_TYPE_CONSTRAINT_NAME,
  T1_TINDER_STATE_CONSTRAINT_NAME,
  inspectDeviceBridgeT1Schema,
  migrateDeviceBridgeT1Schema
} from "../device-bridge/t1-schema.js";
import { migrateDeviceBridgeSchema } from "../device-bridge/database.js";

function schemaClient({
  tinderConstraint = T1_TINDER_STATE_CONSTRAINT_NAME,
  commandConstraint = T1_COMMAND_TYPE_CONSTRAINT_NAME,
  tinderValidated = true,
  commandValidated = true,
  incompatibleTinder = false,
  incompatibleCommand = false
} = {}) {
  const calls = [];
  const state = {
    tinderConstraint,
    commandConstraint,
    tinderValidated,
    commandValidated
  };
  return {
    calls,
    state,
    async query(sql) {
      calls.push(sql);
      if (sql.includes("ADD CONSTRAINT") && sql.includes(T1_TINDER_STATE_CONSTRAINT_NAME)) {
        state.tinderConstraint = T1_TINDER_STATE_CONSTRAINT_NAME;
        state.tinderValidated = true;
      }
      if (sql.includes("ADD CONSTRAINT") && sql.includes(T1_COMMAND_TYPE_CONSTRAINT_NAME)) {
        state.commandConstraint = T1_COMMAND_TYPE_CONSTRAINT_NAME;
        state.commandValidated = true;
      }
      if (sql.includes("FROM pg_constraint") && sql.includes("device_bridge_devices")) {
        return { rows: [{
          conname: state.tinderConstraint,
          convalidated: state.tinderValidated,
          column_names: ["tinder_state"]
        }] };
      }
      if (sql.includes("FROM pg_constraint") && sql.includes("device_bridge_commands")) {
        return { rows: [{
          conname: state.commandConstraint,
          convalidated: state.commandValidated,
          column_names: ["command_type"]
        }] };
      }
      if (sql.includes("FROM device_bridge_devices") && sql.includes("AS incompatible")) {
        return { rows: [{ incompatible: incompatibleTinder }] };
      }
      if (sql.includes("FROM device_bridge_commands") && sql.includes("AS incompatible")) {
        return { rows: [{ incompatible: incompatibleCommand }] };
      }
      return { rows: [] };
    }
  };
}

test("runtime T1 inspection is read-only for final compatible constraints", async () => {
  const client = schemaClient();
  assert.deepEqual(await inspectDeviceBridgeT1Schema(client), {
    ready: true,
    constraints: [
      {
        specification: {
          table: "device_bridge_devices",
          column: "tinder_state",
          name: T1_TINDER_STATE_CONSTRAINT_NAME,
          expression: "\n  tinder_state IN ('DISCONNECTED', 'CONNECTING', 'CONNECTED', 'AUTH_REQUIRED', 'REVIEW_REQUIRED', 'UNKNOWN')\n"
        },
        state: "FINAL",
        constraintName: T1_TINDER_STATE_CONSTRAINT_NAME
      },
      {
        specification: {
          table: "device_bridge_commands",
          column: "command_type",
          name: T1_COMMAND_TYPE_CONSTRAINT_NAME,
          expression: "\n  command_type IN ('PING', 'REQUEST_STATUS', 'STOP_BRIDGE', 'CONNECT_TINDER', 'DISCONNECT_TINDER')\n"
        },
        state: "FINAL",
        constraintName: T1_COMMAND_TYPE_CONSTRAINT_NAME
      }
    ]
  });
  assert.equal(client.calls.some(sql => /\b(LOCK|ALTER|CREATE|DROP|UPDATE)\b/i.test(sql)), false);
});

test("runtime T1 inspection reports a migration-required schema without mutation", async () => {
  const client = schemaClient({ tinderConstraint: "device_bridge_devices_tinder_state_check" });
  const inspection = await inspectDeviceBridgeT1Schema(client);
  assert.equal(inspection.ready, false);
  assert.equal(inspection.constraints[0].state, "LEGACY");
  assert.equal(client.calls.some(sql => /\b(LOCK|ALTER|CREATE|DROP|UPDATE)\b/i.test(sql)), false);
});

test("explicit T1 migration completes full compatibility preflight before its first ALTER", async () => {
  const client = schemaClient({
    tinderConstraint: "device_bridge_devices_tinder_state_check",
    commandConstraint: "device_bridge_commands_command_type_check"
  });
  assert.deepEqual(await migrateDeviceBridgeT1Schema(client), { migrated: true });
  const firstAlter = client.calls.findIndex(sql => sql.includes("ALTER TABLE"));
  const compatibilityChecks = client.calls
    .map((sql, index) => ({ sql, index }))
    .filter(call => call.sql.includes("AS incompatible"));
  assert.equal(compatibilityChecks.length, 2);
  assert.equal(compatibilityChecks.every(call => call.index < firstAlter), true);
  assert.equal(client.calls.indexOf("LOCK TABLE device_bridge_devices IN ACCESS EXCLUSIVE MODE") < client.calls.indexOf("LOCK TABLE device_bridge_commands IN ACCESS EXCLUSIVE MODE"), true);
  assert.equal((await inspectDeviceBridgeT1Schema(client)).ready, true);
});

test("incompatible T1 rows stop before every ALTER", async () => {
  const client = schemaClient({
    tinderConstraint: "device_bridge_devices_tinder_state_check",
    commandConstraint: "device_bridge_commands_command_type_check",
    incompatibleCommand: true
  });
  await assert.rejects(() => migrateDeviceBridgeT1Schema(client), /incompatible with the T1 extension/);
  assert.equal(client.calls.some(sql => sql.includes("ALTER TABLE")), false);
});

test("explicit full migration rejects incompatible T1 rows before schema DDL", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT") return { rows: [] };
      if (sql.includes("to_regclass")) return { rows: [{ relation_name: params[0] }] };
      if (sql.includes("FROM pg_constraint") && sql.includes("device_bridge_devices")) {
        return { rows: [{
          conname: "device_bridge_devices_tinder_state_check",
          convalidated: true,
          column_names: ["tinder_state"]
        }] };
      }
      if (sql.includes("FROM pg_constraint") && sql.includes("device_bridge_commands")) {
        return { rows: [{
          conname: "device_bridge_commands_command_type_check",
          convalidated: true,
          column_names: ["command_type"]
        }] };
      }
      if (sql.includes("AS incompatible")) return { rows: [{ incompatible: true }] };
      return { rows: [] };
    },
    release() {}
  };
  await assert.rejects(
    () => migrateDeviceBridgeSchema({ async connect() { return client; } }),
    /incompatible with the T1 extension/
  );
  assert.equal(calls.some(call => /\b(CREATE|ALTER|DROP)\b/i.test(call.sql)), false);
  assert.equal(calls.some(call => call.sql === "ROLLBACK"), true);
});

test("explicit T1 migration postchecks and is idempotent once final", async () => {
  const client = schemaClient();
  assert.deepEqual(await migrateDeviceBridgeT1Schema(client), { migrated: false });
  assert.deepEqual(await migrateDeviceBridgeT1Schema(client), { migrated: false });
  assert.equal(client.calls.some(sql => sql.includes("ALTER TABLE")), false);
});

test("missing, ambiguous, or unvalidated T1 schema fails closed before mutation", async () => {
  for (const rows of [[], [
    { conname: "one", convalidated: true, column_names: ["tinder_state"] },
    { conname: "two", convalidated: true, column_names: ["tinder_state"] }
  ]]) {
    const client = {
      calls: [],
      async query(sql) {
        this.calls.push(sql);
        if (sql.includes("FROM pg_constraint") && sql.includes("device_bridge_devices")) return { rows };
        return { rows: [] };
      }
    };
    await assert.rejects(() => migrateDeviceBridgeT1Schema(client), /compatibility check failed/);
    assert.equal(client.calls.some(sql => sql.includes("ALTER TABLE")), false);
  }
  await assert.rejects(
    () => migrateDeviceBridgeT1Schema(schemaClient({ tinderValidated: false })),
    /compatibility check failed/
  );
});

test("runtime startup imports only the read-only schema verifier", () => {
  const initialization = fs.readFileSync(new URL("../device-bridge/initialization.js", import.meta.url), "utf8");
  const readiness = fs.readFileSync(new URL("../device-bridge/schema-readiness.js", import.meta.url), "utf8");
  assert.match(initialization, /verifyDeviceBridgeSchema/);
  assert.doesNotMatch(initialization, /migrateDeviceBridgeSchema/);
  assert.doesNotMatch(readiness, /\b(LOCK|ALTER|CREATE|DROP|UPDATE)\b/i);
});
