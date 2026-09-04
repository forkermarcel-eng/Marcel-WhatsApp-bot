import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createAdminT1ReadOnlyPreflightHandler } from "../device-bridge/admin.js";
import { registerDeviceBridgeBlock3Routes } from "../device-bridge/block3-routes.js";
import {
  READ_ONLY_GUARD_CODE,
  runDeviceBridgeT1ReadOnlyPreflight
} from "../device-bridge/t1-readonly-preflight.js";

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

function readOnlyPool() {
  const calls = [];
  const state = { released: false };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
    release() { state.released = true; }
  };
  return { pool: { async connect() { return client; } }, calls, state };
}

function successfulDependencies(overrides = {}) {
  return {
    inspectFoundation: async client => {
      await client.query("SELECT foundation_presence");
      return { ready: true, missing: [] };
    },
    preflightFoundation: async client => {
      await client.query("SELECT foundation_contract");
      return { ready: true };
    },
    preflightAck: async client => {
      await client.query("SELECT ack_contract");
      return { ready: true };
    },
    inspectT1: async client => {
      await client.query("SELECT t1_constraints");
      return {
        constraints: [
          { specification: { column: "tinder_state" }, state: "LEGACY" },
          { specification: { column: "command_type" }, state: "LEGACY" }
        ]
      };
    },
    preflightT1: async client => {
      await client.query("SELECT t1_rows");
      return { steps: [] };
    },
    ...overrides
  };
}

function assertReadOnlyTransaction(fake) {
  assert.equal(fake.calls[0]?.sql, "BEGIN");
  assert.equal(fake.calls[1]?.sql, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  assert.equal(fake.calls.at(-1)?.sql, "ROLLBACK");
  assert.equal(fake.calls.slice(2, -1).every(call => /^\s*SELECT\b/i.test(call.sql)), true);
  assert.equal(fake.calls.some(call => /\b(COMMIT|LOCK|CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(call.sql)), false);
  assert.equal(fake.state.released, true);
}

test("read-only preflight reuses the fixed Foundation, ACK and T1 stages in one rolled-back transaction", async () => {
  const fake = readOnlyPool();
  const result = await runDeviceBridgeT1ReadOnlyPreflight(fake.pool, successfulDependencies());
  assert.deepEqual(result, {
    foundation: { present: true, compatible: true },
    ack: { present: true, compatible: true },
    t1: {
      legacy_tinder_state_constraint: "LEGACY",
      legacy_command_type_constraint: "LEGACY",
      incompatible_rows: false,
      preflight_pass: true
    },
    preflight_pass: true,
    reason_code: null
  });
  assertReadOnlyTransaction(fake);
});

test("the read-only query guard prevents a preflight dependency from issuing a write or schema statement", async () => {
  const fake = readOnlyPool();
  const result = await runDeviceBridgeT1ReadOnlyPreflight(fake.pool, successfulDependencies({
    preflightFoundation: async client => client.query("ALTER TABLE device_bridge_devices ADD COLUMN forbidden text")
  }));
  assert.equal(result.preflight_pass, false);
  assert.equal(result.reason_code, "PREFLIGHT_GUARD_BLOCKED");
  assert.equal(READ_ONLY_GUARD_CODE, "READ_ONLY_QUERY_REJECTED");
  assertReadOnlyTransaction(fake);
});

test("empty Foundation stops without writes and marks a missing ACK table when applicable", async () => {
  const fake = readOnlyPool();
  const result = await runDeviceBridgeT1ReadOnlyPreflight(fake.pool, successfulDependencies({
    inspectFoundation: async client => {
      await client.query("SELECT foundation_presence");
      return { ready: false, missing: ["device_bridge_command_acks"] };
    },
    preflightFoundation: async () => {
      throw new Error("Device Bridge T1 migration requires a complete existing foundation.");
    }
  }));
  assert.equal(result.reason_code, "FOUNDATION_MISSING");
  assert.deepEqual(result.foundation, { present: false, compatible: false });
  assert.deepEqual(result.ack, { present: false, compatible: false });
  assertReadOnlyTransaction(fake);
});

test("partial and structurally incompatible Foundations stop without writes", async () => {
  for (const label of ["partial", "incompatible"]) {
    const fake = readOnlyPool();
    const result = await runDeviceBridgeT1ReadOnlyPreflight(fake.pool, successfulDependencies({
      preflightFoundation: async () => {
        throw new Error("Device Bridge T1 foundation compatibility check failed.");
      }
    }));
    assert.equal(result.reason_code, "FOUNDATION_INCOMPATIBLE", label);
    assert.deepEqual(result.foundation, { present: true, compatible: false }, label);
    assertReadOnlyTransaction(fake);
  }
});

test("missing or incompatible ACK state stops without writes", async () => {
  for (const message of [
    "Device Bridge ACK schema compatibility check failed.",
    "Device Bridge ACK data is incompatible with Protocol V1."
  ]) {
    const fake = readOnlyPool();
    const result = await runDeviceBridgeT1ReadOnlyPreflight(fake.pool, successfulDependencies({
      preflightAck: async () => { throw new Error(message); }
    }));
    assert.equal(result.ack.present, true);
    assert.equal(result.ack.compatible, false);
    assert.equal(result.reason_code, message.includes("data") ? "ACK_ROWS_INCOMPATIBLE" : "ACK_INCOMPATIBLE");
    assertReadOnlyTransaction(fake);
  }
});

test("unexpected T1 constraints and incompatible current rows are reported without writes", async () => {
  const badConstraint = readOnlyPool();
  const constraintResult = await runDeviceBridgeT1ReadOnlyPreflight(badConstraint.pool, successfulDependencies({
    inspectT1: async client => {
      await client.query("SELECT t1_constraints");
      return {
        constraints: [
          { specification: { column: "tinder_state" }, state: "INVALID" },
          { specification: { column: "command_type" }, state: "LEGACY" }
        ]
      };
    },
    preflightT1: async () => { throw new Error("Device Bridge T1 schema compatibility check failed."); }
  }));
  assert.equal(constraintResult.reason_code, "T1_CONSTRAINT_INCOMPATIBLE");
  assert.equal(constraintResult.t1.legacy_tinder_state_constraint, "INVALID");
  assertReadOnlyTransaction(badConstraint);

  const badRows = readOnlyPool();
  const rowResult = await runDeviceBridgeT1ReadOnlyPreflight(badRows.pool, successfulDependencies({
    preflightT1: async () => { throw new Error("Device Bridge data is incompatible with the T1 extension."); }
  }));
  assert.equal(rowResult.reason_code, "T1_ROWS_INCOMPATIBLE");
  assert.equal(rowResult.t1.incompatible_rows, true);
  assertReadOnlyTransaction(badRows);
});

test("failure results never disclose raw database errors or connection strings", async () => {
  const fake = readOnlyPool();
  const secret = "postgres://private-user:private-password@private-host/private-db";
  const result = await runDeviceBridgeT1ReadOnlyPreflight(fake.pool, successfulDependencies({
    preflightFoundation: async () => { throw new Error(secret); }
  }));
  assert.equal(result.reason_code, "PREFLIGHT_UNAVAILABLE");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assertReadOnlyTransaction(fake);
});

test("diagnostic route keeps dashboard authentication and is intentionally callable before runtime readiness", async () => {
  const routes = new Map();
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); }
  };
  let connects = 0;
  const pool = { async connect() { connects += 1; throw new Error("unreachable"); } };
  registerDeviceBridgeBlock3Routes({
    app,
    pool,
    dashboardApiReady: () => true,
    dashboardApiAuthorized: () => false,
    requireDeviceBridgeReady: () => false
  });
  const route = routes.get("GET /dashboard-api/device-bridge/t1-schema-preflight");
  assert.equal(typeof route, "function");
  const unauthorized = responseRecorder();
  await route({ query: {} }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(connects, 0);

  registerDeviceBridgeBlock3Routes({
    app,
    pool,
    dashboardApiReady: () => true,
    dashboardApiAuthorized: () => true,
    requireDeviceBridgeReady: () => false
  });
  const beforeReady = responseRecorder();
  await routes.get("GET /dashboard-api/device-bridge/t1-schema-preflight")({ query: {} }, beforeReady);
  assert.equal(connects, 1);
  assert.equal(beforeReady.statusCode, 503);
  assert.equal(beforeReady.body.reason_code, "PREFLIGHT_UNAVAILABLE");
});

test("handler accepts no input and serializes only the bounded result", async () => {
  let invoked = false;
  const handler = createAdminT1ReadOnlyPreflightHandler({}, {
    runPreflight: async () => {
      invoked = true;
      return {
        foundation: { present: true, compatible: true },
        ack: { present: true, compatible: true },
        t1: {
          legacy_tinder_state_constraint: "LEGACY",
          legacy_command_type_constraint: "LEGACY",
          incompatible_rows: false,
          preflight_pass: true
        },
        preflight_pass: true,
        reason_code: null,
        database_url: "must-not-serialize"
      };
    }
  });
  const rejected = responseRecorder();
  await handler({ query: { sql: "SELECT 1" } }, rejected);
  assert.equal(rejected.statusCode, 400);
  assert.equal(invoked, false);

  const accepted = responseRecorder();
  await handler({ query: {} }, accepted);
  assert.equal(accepted.statusCode, 200);
  assert.equal(JSON.stringify(accepted.body).includes("must-not-serialize"), false);
  assert.equal(accepted.headers["Cache-Control"], "no-store, max-age=0");
});

test("read-only preflight module has no migration dependency or mutation authority", () => {
  const source = fs.readFileSync(new URL("../device-bridge/t1-readonly-preflight.js", import.meta.url), "utf8");
  assert.match(source, /preflightDeviceBridgeFoundationForT1/);
  assert.match(source, /preflightDeviceBridgeAckSchemaForT1/);
  assert.match(source, /preflightDeviceBridgeT1SchemaMigration/);
  assert.doesNotMatch(source, /\.\/database\.js/);
  assert.doesNotMatch(source, /\b(COMMIT|LOCK|CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/);
});
