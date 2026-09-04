import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  T1_COMMAND_TYPE_CONSTRAINT_NAME,
  T1_TINDER_STATE_CONSTRAINT_NAME,
  ensureDeviceBridgeT1Schema
} from "../device-bridge/t1-schema.js";

function schemaClient({
  tinderConstraint = T1_TINDER_STATE_CONSTRAINT_NAME,
  commandConstraint = T1_COMMAND_TYPE_CONSTRAINT_NAME,
  tinderValidated = true,
  commandValidated = true,
  incompatibleTinder = false,
  incompatibleCommand = false
} = {}) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (sql.includes("FROM pg_constraint") && sql.includes("device_bridge_devices")) {
        return { rows: [{ conname: tinderConstraint, convalidated: tinderValidated, column_names: ["tinder_state"] }] };
      }
      if (sql.includes("FROM pg_constraint") && sql.includes("device_bridge_commands")) {
        return { rows: [{ conname: commandConstraint, convalidated: commandValidated, column_names: ["command_type"] }] };
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

test("fresh Device Bridge DDL declares the named T1 constraints and initializer", () => {
  const ddl = fs.readFileSync(new URL("../device-bridge/database.js", import.meta.url), "utf8");
  const schema = fs.readFileSync(new URL("../device-bridge/t1-schema.js", import.meta.url), "utf8");
  assert.match(ddl, /CONSTRAINT \$\{T1_TINDER_STATE_CONSTRAINT_NAME\}/);
  assert.match(ddl, /CONSTRAINT \$\{T1_COMMAND_TYPE_CONSTRAINT_NAME\}/);
  assert.match(ddl, /ensureDeviceBridgeT1Schema\(client\)/);
  assert.match(schema, /'CONNECTING'/);
  assert.match(schema, /'CONNECT_TINDER'/);
  assert.match(schema, /'DISCONNECT_TINDER'/);
});

test("T1 schema migration is idempotent for the final validated constraints", async () => {
  const client = schemaClient();
  assert.deepEqual(await ensureDeviceBridgeT1Schema(client), { migrated: false });
  assert.deepEqual(await ensureDeviceBridgeT1Schema(client), { migrated: false });
  assert.equal(client.calls.some(sql => sql.includes("ALTER TABLE")), false);
});

test("compatible legacy constraints are renamed only after compatibility checks", async () => {
  const client = schemaClient({
    tinderConstraint: "device_bridge_devices_tinder_state_check",
    commandConstraint: "device_bridge_commands_command_type_check"
  });
  assert.deepEqual(await ensureDeviceBridgeT1Schema(client), { migrated: true });
  const firstCompatibility = client.calls.findIndex(sql => sql.includes("AS incompatible"));
  const firstMutation = client.calls.findIndex(sql => sql.includes("ALTER TABLE"));
  assert.ok(firstCompatibility > -1 && firstMutation > firstCompatibility);
  assert.equal(client.calls.some(sql => sql.includes(`DROP CONSTRAINT \"device_bridge_devices_tinder_state_check\"`)), true);
  assert.equal(client.calls.some(sql => sql.includes(`ADD CONSTRAINT ${T1_TINDER_STATE_CONSTRAINT_NAME}`)), true);
  assert.equal(client.calls.some(sql => sql.includes(`DROP CONSTRAINT \"device_bridge_commands_command_type_check\"`)), true);
  assert.equal(client.calls.some(sql => sql.includes(`ADD CONSTRAINT ${T1_COMMAND_TYPE_CONSTRAINT_NAME}`)), true);
});

test("incompatible, missing, ambiguous or unvalidated T1 schema fails closed", async () => {
  const incompatible = schemaClient({ commandConstraint: "legacy_command_type_check", incompatibleCommand: true });
  await assert.rejects(() => ensureDeviceBridgeT1Schema(incompatible), /incompatible with the T1 extension/);
  assert.equal(incompatible.calls.some(sql => sql.includes("ALTER TABLE device_bridge_commands")), false);

  for (const rows of [[], [
    { conname: "one", convalidated: true, column_names: ["tinder_state"] },
    { conname: "two", convalidated: true, column_names: ["tinder_state"] }
  ]]) {
    const client = {
      async query(sql) {
        if (sql.includes("FROM pg_constraint") && sql.includes("device_bridge_devices")) return { rows };
        return { rows: [] };
      }
    };
    await assert.rejects(() => ensureDeviceBridgeT1Schema(client), /schema compatibility check failed/);
  }
  await assert.rejects(
    () => ensureDeviceBridgeT1Schema(schemaClient({ tinderValidated: false })),
    /schema compatibility check failed/
  );
});
