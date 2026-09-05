import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createAdminT1ReadOnlyPreflightHandler } from "../device-bridge/admin.js";
import { registerDeviceBridgeBlock3Routes } from "../device-bridge/block3-routes.js";
import { ACK_REQUIRED_CHECKS } from "../device-bridge/ack-schema.js";
import { withDeviceBridgeReadOnlyTransaction } from "../device-bridge/read-only-transaction.js";
import {
  READ_ONLY_GUARD_CODE,
  runDeviceBridgeT1ReadOnlyPreflight
} from "../device-bridge/t1-readonly-preflight.js";

const ACK_STATUSES = ["RECEIVED", "SUCCEEDED", "FAILED", "REJECTED", "EXPIRED"];
const ACK_ACCEPTANCE = Object.freeze({
  RECEIVED: [true, false, false, false],
  SUCCEEDED: [true, false, true, false],
  FAILED: [false, true, false, false],
  REJECTED: [true, true, false, false],
  EXPIRED: [true, false, false, false]
});
const NONCANONICAL_EQUIVALENT_ACK_PAYLOAD = `
  (status = 'EXPIRED' AND result IS NULL AND error IS NULL)
  OR (status = 'REJECTED' AND result IS NULL)
  OR (status = 'FAILED' AND result IS NULL AND error IS NOT NULL)
  OR (status = 'SUCCEEDED' AND error IS NULL)
  OR (status = 'RECEIVED' AND result IS NULL AND error IS NULL)
`;

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

function readOnlyPool({ respond } = {}) {
  const calls = [];
  const state = { released: false };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      const response = respond ? await respond(sql, params) : undefined;
      return response === undefined ? { rows: [] } : response;
    },
    release() { state.released = true; }
  };
  return { pool: { async connect() { return client; } }, calls, state };
}

function semanticMatrix() {
  return ACK_STATUSES.flatMap((status, statusIndex) => ACK_ACCEPTANCE[status].map((canonical_accepts, combinationIndex) => ({
    case_id: statusIndex * 4 + combinationIndex + 1,
    production_accepts: canonical_accepts,
    canonical_accepts
  })));
}

function semanticallyEquivalentAckChecks() {
  return ACK_REQUIRED_CHECKS.map(specification => ({
    conname: specification.name || `generated_${specification.id.toLowerCase()}`,
    convalidated: true,
    condeferrable: false,
    condeferred: false,
    constraint_definition: `CHECK (${specification.id === "ACK_PAYLOAD_V1"
      ? NONCANONICAL_EQUIVALENT_ACK_PAYLOAD : specification.expression})`,
    column_names: specification.columns
  }));
}

function semanticAckResponder(checks = semanticallyEquivalentAckChecks()) {
  return sql => {
    if (sql.includes("LIMIT 2") && sql.includes("FROM pg_constraint c")) {
      return { rows: [{ constraint_oid: "4242", evaluator_safe: true }] };
    }
    if (sql.includes("c.conrelid = 'device_bridge_command_acks'::regclass")) return { rows: checks };
    if (sql.includes("information_schema.columns")) {
      return { rows: [
        { column_name: "status", udt_name: "text" },
        { column_name: "result", udt_name: "jsonb" },
        { column_name: "error", udt_name: "jsonb" }
      ] };
    }
    if (sql.includes("FROM XMLTABLE") && sql.includes("query_to_xml")) return { rows: semanticMatrix() };
    if (sql.includes("FROM device_bridge_command_acks") && sql.includes("AS incompatible")) {
      return { rows: [{ incompatible: false }] };
    }
    return undefined;
  };
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

async function runGuardedQuery(sql) {
  const fake = readOnlyPool();
  await withDeviceBridgeReadOnlyTransaction(fake.pool, client => client.query(sql));
  return fake;
}

async function assertGuardRejects(sql) {
  const fake = readOnlyPool();
  await assert.rejects(
    () => withDeviceBridgeReadOnlyTransaction(fake.pool, client => client.query(sql)),
    error => error?.code === READ_ONLY_GUARD_CODE
  );
  assert.equal(fake.calls.slice(2, -1).some(call => call.sql === sql), false, sql);
  assertReadOnlyTransaction(fake);
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

test("the shared read-only guard accepts bounded comment and literal semicolons without rewriting SQL", async () => {
  const safeQueries = [
    "SELECT 1",
    "SELECT 1\n-- comment ; only\n",
    "SELECT 1 -- comment ; only",
    "SELECT /* comment ; only */ 1",
    "SELECT /* outer ; /* nested ; */ still comment */ 1",
    "SELECT 'literal ; only'::text",
    "SELECT 'doubled '' quote ; only'::text",
    "SELECT $$dollar literal ; only$$::text",
    "SELECT $payload$dollar literal ; only$payload$::text",
    "SELECT \"identifier ; only\""
  ];

  for (const sql of safeQueries) {
    const fake = await runGuardedQuery(sql);
    assert.equal(fake.calls[2]?.sql, sql);
    assertReadOnlyTransaction(fake);
  }
});

test("the shared read-only guard rejects real separators, non-SELECT SQL, and malformed lexical input", async () => {
  const rejectedQueries = [
    "SELECT 1;",
    "SELECT 1; SELECT 2",
    "SELECT 1 -- comment ; only\n; SELECT 2",
    "SELECT 1;\nUPDATE device_bridge_devices SET display_name = 'forbidden'",
    "INSERT INTO device_bridge_devices (display_name) VALUES ('forbidden')",
    "UPDATE device_bridge_devices SET display_name = 'forbidden'",
    "DELETE FROM device_bridge_devices",
    "ALTER TABLE device_bridge_devices ADD COLUMN forbidden text",
    "CREATE TABLE forbidden (id text)",
    "DROP TABLE device_bridge_devices",
    "TRUNCATE device_bridge_devices",
    "GRANT SELECT ON device_bridge_devices TO public",
    "REVOKE SELECT ON device_bridge_devices FROM public",
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "COPY device_bridge_devices TO STDOUT",
    "CALL forbidden()",
    "DO $$BEGIN END$$",
    "SELECT /* unterminated",
    "SELECT /* outer /* nested */",
    "SELECT 'unterminated",
    "SELECT \"unterminated",
    "SELECT $$unterminated",
    "SELECT $payload$unterminated",
    "SELECT ä$payload$literal ; only$payload$"
  ];

  for (const sql of rejectedQueries) await assertGuardRejects(sql);
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

test("a semantically equivalent ACK payload reaches T1 checks without nested transactions or an automatic full pass", async () => {
  const fake = readOnlyPool({ respond: semanticAckResponder() });
  const result = await runDeviceBridgeT1ReadOnlyPreflight(fake.pool, successfulDependencies({
    preflightAck: undefined,
    preflightT1: async client => {
      await client.query("SELECT t1_constraint_failure");
      throw new Error("Device Bridge T1 schema compatibility check failed.");
    }
  }));

  assert.deepEqual(result.foundation, { present: true, compatible: true });
  assert.deepEqual(result.ack, { present: true, compatible: true });
  assert.equal(result.reason_code, "T1_CONSTRAINT_INCOMPATIBLE");
  assert.equal(result.preflight_pass, false);
  assert.equal(fake.calls.filter(call => call.sql === "BEGIN").length, 1);
  assert.equal(fake.calls.some(call => call.sql.includes("FROM XMLTABLE")), true);
  const readOnlySet = fake.calls.findIndex(call => call.sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  const matrix = fake.calls.findIndex(call => call.sql.includes("FROM XMLTABLE"));
  const t1Failure = fake.calls.findIndex(call => call.sql === "SELECT t1_constraint_failure");
  const rollback = fake.calls.findIndex(call => call.sql === "ROLLBACK");
  assert.ok(readOnlySet > -1 && readOnlySet < matrix && matrix < t1Failure && t1Failure < rollback);
  assertReadOnlyTransaction(fake);
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
  assert.match(source, /preflightDeviceBridgeAckSchemaForProtectedT1Preflight/);
  assert.doesNotMatch(source, /preflightDeviceBridgeAckSchemaForT1\s*[,}]/);
  assert.match(source, /preflightDeviceBridgeT1SchemaMigration/);
  assert.doesNotMatch(source, /\.\/database\.js/);
  assert.doesNotMatch(source, /\b(COMMIT|LOCK|CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/);
});
