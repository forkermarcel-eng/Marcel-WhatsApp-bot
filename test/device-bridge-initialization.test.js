import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { initializeDeviceBridgeDatabase } from "../device-bridge/initialization.js";
import { verifyDeviceBridgeSchema } from "../device-bridge/schema-readiness.js";
import {
  T1_COMMAND_TYPE_CONSTRAINT_NAME,
  T1_TINDER_STATE_CONSTRAINT_NAME
} from "../device-bridge/t1-schema.js";
import { FINAL_ACK_CONSTRAINT_NAME } from "../device-bridge/ack-schema.js";

const REQUIRED_TABLES = new Set([
  "device_bridge_devices",
  "device_bridge_keys",
  "device_bridge_enrollment_codes",
  "device_bridge_commands",
  "device_bridge_command_acks",
  "device_bridge_request_nonces",
  "device_bridge_audit_events"
]);
const FINAL_TINDER_STATES = ["DISCONNECTED", "CONNECTING", "CONNECTED", "AUTH_REQUIRED", "REVIEW_REQUIRED", "UNKNOWN"];
const FINAL_COMMAND_TYPES = ["PING", "REQUEST_STATUS", "STOP_BRIDGE", "CONNECT_TINDER", "DISCONNECT_TINDER"];

function checkDefinition(column, values) {
  return `CHECK (${column} IN (${values.map(value => `'${value}'`).join(", ")}))`;
}

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

function schemaPool({ t1Constraint = T1_TINDER_STATE_CONSTRAINT_NAME } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("to_regclass")) {
        return { rows: [{ relation_name: REQUIRED_TABLES.has(params[0]) ? params[0] : null }] };
      }
      if (sql.includes("device_bridge_devices")) {
        return { rows: [{
          conname: t1Constraint,
          convalidated: true,
          condeferrable: false,
          condeferred: false,
          constraint_definition: checkDefinition("tinder_state", FINAL_TINDER_STATES),
          column_names: ["tinder_state"]
        }] };
      }
      if (sql.includes("device_bridge_commands")) {
        return { rows: [{
          conname: T1_COMMAND_TYPE_CONSTRAINT_NAME,
          convalidated: true,
          condeferrable: false,
          condeferred: false,
          constraint_definition: checkDefinition("command_type", FINAL_COMMAND_TYPES),
          column_names: ["command_type"]
        }] };
      }
      if (sql.includes("device_bridge_command_acks")) {
        return { rows: [{
          conname: FINAL_ACK_CONSTRAINT_NAME,
          convalidated: true,
          condeferrable: false,
          condeferred: false,
          constraint_definition: "CHECK ((status = 'RECEIVED' AND result IS NULL AND error IS NULL) OR (status = 'SUCCEEDED' AND error IS NULL) OR (status = 'FAILED' AND result IS NULL AND error IS NOT NULL) OR (status = 'REJECTED' AND result IS NULL) OR (status = 'EXPIRED' AND result IS NULL AND error IS NULL))",
          column_names: ["error", "result", "status"]
        }] };
      }
      throw new Error("Unexpected runtime schema query");
    },
    release() { this.released = true; }
  };
  return { pool: { async connect() { return client; } }, calls, client };
}

function hasMutation(calls) {
  return calls.some(call => /\b(ALTER|CREATE|DELETE|DROP|INSERT|UPDATE|LOCK|BEGIN|COMMIT|ROLLBACK)\b/i.test(call.sql));
}

test("normal startup runs only the read-only schema verifier before readiness", async () => {
  const fake = schemaPool();
  const events = [];
  const logs = loggerRecorder();
  const ready = await initializeDeviceBridgeDatabase(fake.pool, {
    verifySchema: verifyDeviceBridgeSchema,
    markReady: () => { events.push("ready"); },
    logger: logs.logger
  });

  assert.equal(ready, true);
  assert.deepEqual(events, ["ready"]);
  assert.equal(hasMutation(fake.calls), false);
  assert.equal(fake.client.released, true);
  assert.deepEqual(logs.entries, [{
    level: "log",
    message: "Device Bridge Protocol V1 schema readiness verified."
  }]);
});

test("normal startup with missing T1 schema never mutates and remains not ready", async () => {
  const fake = schemaPool({ t1Constraint: "device_bridge_devices_tinder_state_check" });
  const logs = loggerRecorder();
  let readinessCalls = 0;
  const ready = await initializeDeviceBridgeDatabase(fake.pool, {
    verifySchema: verifyDeviceBridgeSchema,
    markReady: () => { readinessCalls += 1; },
    logger: logs.logger
  });

  assert.equal(ready, false);
  assert.equal(readinessCalls, 0);
  assert.equal(hasMutation(fake.calls), false);
  assert.deepEqual(logs.entries, [{
    level: "error",
    message: "Device Bridge Protocol V1 schema readiness check failed."
  }]);
});

test("schema check failure remains not ready and logs no error details", async () => {
  let readinessCalls = 0;
  const logs = loggerRecorder();
  const ready = await initializeDeviceBridgeDatabase({}, {
    verifySchema: async () => { throw new Error("secret database detail"); },
    markReady: () => { readinessCalls += 1; },
    logger: logs.logger
  });

  assert.equal(ready, false);
  assert.equal(readinessCalls, 0);
  assert.deepEqual(logs.entries, [{
    level: "error",
    message: "Device Bridge Protocol V1 schema readiness check failed."
  }]);
  assert.equal(JSON.stringify(logs.entries).includes("secret database detail"), false);
});

test("Device Bridge readiness failure does not prevent following platform initialization", async () => {
  const events = [];
  await initializeDeviceBridgeDatabase({}, {
    verifySchema: async () => { events.push("device-readiness"); throw new Error("failed"); },
    markReady: () => { events.push("ready"); },
    logger: loggerRecorder().logger
  });
  events.push("platform-ddl");
  assert.deepEqual(events, ["device-readiness", "platform-ddl"]);
});

test("index keeps platform initialization and startWhatsApp semantics outside Device Bridge isolation", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const deviceInit = source.indexOf("await initializeDeviceBridgeDatabase(pool)");
  const platformInit = source.indexOf("CREATE TABLE IF NOT EXISTS contacts", deviceInit);
  const listenerInit = source.indexOf("await initDatabase()", platformInit);
  const listenerCatch = source.indexOf("PostgreSQL Initialisierung fehlgeschlagen:", listenerInit);
  const whatsappStart = source.indexOf("startWhatsApp()", listenerCatch);

  assert.ok(deviceInit > -1);
  assert.ok(platformInit > deviceInit);
  assert.ok(listenerInit > platformInit);
  assert.ok(listenerCatch > listenerInit);
  assert.ok(whatsappStart > listenerCatch);
});

test("failed Device Bridge readiness leaves signed routes not ready", async () => {
  const readiness = await import(`../device-bridge/readiness.js?isolation=${Date.now()}`);
  await initializeDeviceBridgeDatabase({}, {
    verifySchema: async () => { throw new Error("failed"); },
    markReady: readiness.markDeviceBridgeReady,
    logger: loggerRecorder().logger
  });

  const response = {
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
  const allowed = readiness.requireDeviceBridgeReady(response);

  assert.equal(allowed, false);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error.code, "BACKEND_NOT_READY");
});
