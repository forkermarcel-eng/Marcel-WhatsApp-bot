import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertTinderManualSendCommandSchemaReady,
  inspectTinderManualSendCommandSchema,
  preflightTinderManualSendCommandMigration,
  TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE
} from "../device-bridge/tinder-manual-send-command-schema.js";
import {
  T2_HUMAN_ARMED_COMMAND_TYPE_CONSTRAINT_NAME,
  T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CONSTRAINT_NAME
} from "../device-bridge/t1-schema.js";
import {
  assertTinderManualSendCommandMigrationSource
} from "../device-bridge/tinder-manual-send-command-migration.js";

function bridgeInspection(constraintName, ready = true) {
  return {
    ready,
    constraints: [{
      specification: { table: "device_bridge_commands", column: "command_type" },
      constraintName
    }]
  };
}

function client({ incompatible = false } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(String(sql));
      return { rows: [{ incompatible }] };
    }
  };
}

const foundationReady = async () => ({ state: "CANONICAL" });

test("T5 command schema recognizes only the exact T2 legacy or exact v3 canonical vocabulary", async () => {
  const legacy = await inspectTinderManualSendCommandSchema({}, {
    assertManualSendFoundationReady: foundationReady,
    inspectDeviceBridgeSchema: async () => bridgeInspection(T2_HUMAN_ARMED_COMMAND_TYPE_CONSTRAINT_NAME)
  });
  assert.equal(legacy.state, TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE.LEGACY);

  const canonical = await inspectTinderManualSendCommandSchema({}, {
    assertManualSendFoundationReady: foundationReady,
    inspectDeviceBridgeSchema: async () => bridgeInspection(T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CONSTRAINT_NAME)
  });
  assert.equal(canonical.state, TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE.CANONICAL);

  const drift = await inspectTinderManualSendCommandSchema({}, {
    assertManualSendFoundationReady: foundationReady,
    inspectDeviceBridgeSchema: async () => bridgeInspection("unexpected_check")
  });
  assert.equal(drift.state, TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE.INVALID);
});

test("T5 command preflight is read-only and blocks incompatible rows before any DDL", async () => {
  const safe = client();
  const checked = await preflightTinderManualSendCommandMigration(safe, {
    assertManualSendFoundationReady: foundationReady,
    inspectDeviceBridgeSchema: async () => bridgeInspection(T2_HUMAN_ARMED_COMMAND_TYPE_CONSTRAINT_NAME)
  });
  assert.equal(checked.mutate, true);
  assert.equal(checked.command.state, TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE.LEGACY);
  assert.equal(safe.queries.length, 1);
  assert.match(safe.queries[0], /SELECT EXISTS/i);
  assert.doesNotMatch(safe.queries[0], /(?:ALTER|CREATE|DROP|INSERT|UPDATE|DELETE)\s+/i);

  await assert.rejects(
    () => preflightTinderManualSendCommandMigration(client({ incompatible: true }), {
      assertManualSendFoundationReady: foundationReady,
      inspectDeviceBridgeSchema: async () => bridgeInspection(T2_HUMAN_ARMED_COMMAND_TYPE_CONSTRAINT_NAME)
    }),
    /incompatible/
  );
});

test("T5 command readiness rejects legacy and dependency drift fail closed", async () => {
  await assert.rejects(
    () => assertTinderManualSendCommandSchemaReady({}, {
      assertManualSendFoundationReady: foundationReady,
      inspectDeviceBridgeSchema: async () => bridgeInspection(T2_HUMAN_ARMED_COMMAND_TYPE_CONSTRAINT_NAME)
    }),
    /not ready/
  );
  await assert.rejects(
    () => inspectTinderManualSendCommandSchema({}, {
      assertManualSendFoundationReady: async () => { throw new Error("foundation drift"); },
      inspectDeviceBridgeSchema: async () => bridgeInspection(T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CONSTRAINT_NAME)
    }),
    /foundation drift/
  );
});

test("T5 command migration source contains exactly the authorized v2 to v3 constraint delta", () => {
  const source = readFileSync(
    new URL("../migrations/20260907_tinder_manual_send_command_protocol.sql", import.meta.url),
    "utf8"
  );
  assert.doesNotThrow(() => assertTinderManualSendCommandMigrationSource(source));
  assert.match(source, /DROP CONSTRAINT device_bridge_commands_command_type_check_v2/i);
  assert.match(source, /ADD CONSTRAINT device_bridge_commands_command_type_check_v3/i);
  assert.match(source, /SEND_TINDER_DRAFT/);
  assert.doesNotMatch(source, /\b(?:CREATE|INSERT|UPDATE|DELETE|REFERENCES|FOREIGN KEY)\b/i);
  assert.throws(() => assertTinderManualSendCommandMigrationSource(`${source}\nALTER TABLE contacts ADD COLUMN forbidden text;`));
});
