import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  ACK_REQUIRED_CHECKS,
  FINAL_ACK_CHECK_EXPRESSION,
  FINAL_ACK_CONSTRAINT_NAME,
  hasExpectedAckCheckDefinition,
  inspectDeviceBridgeAckSchema,
  preflightDeviceBridgeAckSchemaForCanonicalization,
  preflightDeviceBridgeAckSchemaForProtectedT1Preflight,
  preflightDeviceBridgeAckSchemaForT1,
  preflightDeviceBridgeAckSchemaForT1Migration
} from "../device-bridge/ack-schema.js";
import { createAdminDeviceRevokeHandler } from "../device-bridge/admin.js";
import { withDeviceBridgeReadOnlyTransaction } from "../device-bridge/read-only-transaction.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const NOW = new Date("2026-09-01T12:34:56.000Z");
const ACK_COLUMNS = ["error", "result", "status"];
const ACK_STATUSES = ["RECEIVED", "SUCCEEDED", "FAILED", "REJECTED", "EXPIRED"];
const CANONICAL_ACK_ACCEPTANCE = Object.freeze({
  RECEIVED: [true, false, false, false],
  SUCCEEDED: [true, false, true, false],
  FAILED: [false, true, false, false],
  REJECTED: [true, true, false, false],
  EXPIRED: [true, false, false, false]
});
const NONCANONICAL_EQUIVALENT_PAYLOAD = `
  (status = 'EXPIRED' AND result IS NULL AND error IS NULL)
  OR (status = 'REJECTED' AND result IS NULL)
  OR (status = 'FAILED' AND result IS NULL AND error IS NOT NULL)
  OR (status = 'SUCCEEDED' AND error IS NULL)
  OR (status = 'RECEIVED' AND result IS NULL AND error IS NULL)
`;

function checkDefinition(column, values) {
  return `CHECK (${column} IN (${values.map(value => `'${value}'`).join(", ")}))`;
}

function semanticMatrix(overrides = {}) {
  return ACK_STATUSES.flatMap((status, statusIndex) => CANONICAL_ACK_ACCEPTANCE[status].map((canonical_accepts, combinationIndex) => ({
    case_id: statusIndex * 4 + combinationIndex + 1,
    production_accepts: (overrides[status] || CANONICAL_ACK_ACCEPTANCE[status])[combinationIndex],
    canonical_accepts
  })));
}

function completeAckChecks({ payloadDefinition = FINAL_ACK_CHECK_EXPRESSION, mismatchRule = null } = {}) {
  return ACK_REQUIRED_CHECKS.map(specification => ({
    conname: specification.name || `generated_${specification.id.toLowerCase()}`,
    convalidated: true,
    condeferrable: false,
    condeferred: false,
    constraint_definition: `CHECK (${specification.id === "ACK_PAYLOAD_V1"
      ? payloadDefinition
      : specification.id === mismatchRule ? "status = 'RECEIVED'" : specification.expression})`,
    column_names: specification.columns
  }));
}

function semanticAckReadinessClient({
  checks = completeAckChecks(),
  targets = [{ constraint_oid: "4242", evaluator_safe: true }],
  matrix = semanticMatrix(),
  matrixError = false,
  columnTypes = { status: "text", result: "jsonb", error: "jsonb" }
} = {}) {
  const calls = [];
  const state = { released: false };
  return {
    calls,
    state,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY" || sql === "ROLLBACK") {
        return { rows: [] };
      }
      if (sql.includes("LIMIT 2") && sql.includes("FROM pg_constraint c")) return { rows: targets };
      if (sql.includes("c.conrelid = 'device_bridge_command_acks'::regclass")) return { rows: checks };
      if (sql.includes("information_schema.columns")) {
        return { rows: Object.entries(columnTypes).map(([column_name, udt_name]) => ({ column_name, udt_name })) };
      }
      if (sql.includes("FROM XMLTABLE") && sql.includes("query_to_xml")) {
        if (matrixError) throw new Error("bounded evaluator unavailable");
        return { rows: matrix };
      }
      if (sql.includes("FROM device_bridge_command_acks") && sql.includes("AS incompatible")) {
        return { rows: [{ incompatible: false }] };
      }
      throw new Error(`Unexpected ACK readiness query: ${sql}`);
    },
    release() { state.released = true; }
  };
}

function assertNoAckMutation(calls) {
  assert.equal(calls.some(call => /\b(COMMIT|LOCK|CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(call.sql)), false);
}

async function runProtectedAckPreflight(options) {
  const client = semanticAckReadinessClient(options);
  const pool = { async connect() { return client; } };
  const result = await withDeviceBridgeReadOnlyTransaction(pool, current =>
    preflightDeviceBridgeAckSchemaForProtectedT1Preflight(current)
  );
  return { client, result };
}

function assertProtectedAckReadOnlyTransaction(client) {
  assert.equal(client.calls[0]?.sql, "BEGIN");
  assert.equal(client.calls[1]?.sql, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  assert.equal(client.calls.at(-1)?.sql, "ROLLBACK");
  assert.equal(client.calls.slice(2, -1).every(call => /^\s*SELECT\b/i.test(call.sql)), true);
  assert.equal(client.state.released, true);
}

test("only the explicit ACK canonicalization runner owns ACK payload DDL", () => {
  const runner = fs.readFileSync(new URL("../device-bridge/ack-canonicalization.js", import.meta.url), "utf8");
  const schema = fs.readFileSync(new URL("../device-bridge/ack-schema.js", import.meta.url), "utf8");
  assert.match(runner, /DROP CONSTRAINT \$\{quoteIdentifier\(payload\.constraintName\)\}/);
  assert.match(runner, /ADD CONSTRAINT \$\{FINAL_ACK_CONSTRAINT_NAME\}/);
  assert.doesNotMatch(schema, /ALTER TABLE device_bridge_command_acks/);
});

test("T1-only runner never imports or calls ACK mutation", () => {
  const ddl = fs.readFileSync(new URL("../device-bridge/database.js", import.meta.url), "utf8");
  assert.match(ddl, /preflightDeviceBridgeAckSchemaForT1Migration/);
  assert.doesNotMatch(ddl, /preflightDeviceBridgeAckSchemaForProtectedT1Preflight/);
  assert.doesNotMatch(ddl, /migrateDeviceBridgeAckSchema|ALTER TABLE device_bridge_command_acks|CREATE TABLE/);
});

test("semantic ACK fallback is limited to the protected preflight and explicit migration runner, never startup", () => {
  const protectedPreflight = fs.readFileSync(new URL("../device-bridge/t1-readonly-preflight.js", import.meta.url), "utf8");
  const startupReadiness = fs.readFileSync(new URL("../device-bridge/schema-readiness.js", import.meta.url), "utf8");
  const initialization = fs.readFileSync(new URL("../device-bridge/initialization.js", import.meta.url), "utf8");
  const migration = fs.readFileSync(new URL("../device-bridge/database.js", import.meta.url), "utf8");
  assert.match(protectedPreflight, /preflightDeviceBridgeAckSchemaForProtectedT1Preflight/);
  assert.match(migration, /preflightDeviceBridgeAckSchemaForT1Migration/);
  for (const source of [startupReadiness, initialization]) {
    assert.doesNotMatch(source, /preflightDeviceBridgeAckSchemaForProtectedT1Preflight/);
    assert.doesNotMatch(source, /preflightDeviceBridgeAckSchemaForT1Migration/);
    assert.doesNotMatch(source, /ack-payload-semantic-classifier/);
  }
});

test("canonical ACK payload passes readiness without invoking the semantic fallback", async () => {
  const preflightClient = semanticAckReadinessClient();
  assert.deepEqual(await preflightDeviceBridgeAckSchemaForT1(preflightClient), { ready: true });
  assert.equal(preflightClient.calls.some(call => call.sql.includes("FROM XMLTABLE")), false);
  assertNoAckMutation(preflightClient.calls);

  const runtimeClient = semanticAckReadinessClient();
  assert.deepEqual(await inspectDeviceBridgeAckSchema(runtimeClient), {
    ready: true,
    constraintName: FINAL_ACK_CONSTRAINT_NAME
  });
  assert.equal(runtimeClient.calls.some(call => call.sql.includes("FROM XMLTABLE")), false);
  assertNoAckMutation(runtimeClient.calls);
});

test("a healthy 20/20 semantically equivalent noncanonical ACK payload passes the protected and runner-owned payload fallback", async () => {
  const checks = completeAckChecks({ payloadDefinition: NONCANONICAL_EQUIVALENT_PAYLOAD });
  const payload = checks.find(row => row.conname === FINAL_ACK_CONSTRAINT_NAME);
  assert.equal(hasExpectedAckCheckDefinition(payload, ACK_REQUIRED_CHECKS.at(-1)), false);

  const strictClient = semanticAckReadinessClient({ checks });
  await assert.rejects(() => preflightDeviceBridgeAckSchemaForT1(strictClient), /ACK schema compatibility check failed/);
  assert.equal(strictClient.calls.some(call => call.sql.includes("LIMIT 2") || call.sql.includes("FROM XMLTABLE")), false);
  assertNoAckMutation(strictClient.calls);

  const migrationClient = semanticAckReadinessClient({ checks });
  assert.deepEqual(await preflightDeviceBridgeAckSchemaForT1Migration(migrationClient), { ready: true });
  assert.equal(migrationClient.calls.filter(call => call.sql.includes("FROM XMLTABLE")).length, 1);
  assertNoAckMutation(migrationClient.calls);

  const canonicalizationClient = semanticAckReadinessClient({ checks });
  const canonicalization = await preflightDeviceBridgeAckSchemaForCanonicalization(canonicalizationClient);
  assert.equal(canonicalization.payload.state, "NONCANONICAL");
  assert.equal(canonicalization.payload.constraintName, FINAL_ACK_CONSTRAINT_NAME);
  assert.equal(canonicalization.payload.semanticClassification?.classification?.overall_classification, "SEMANTICALLY_EQUIVALENT");
  assert.equal(canonicalizationClient.calls.filter(call => call.sql.includes("FROM XMLTABLE")).length, 1);
  assertNoAckMutation(canonicalizationClient.calls);

  const protectedPreflight = await runProtectedAckPreflight({ checks });
  assert.deepEqual(protectedPreflight.result, { ready: true });
  assert.equal(protectedPreflight.client.calls.filter(call => call.sql.includes("FROM XMLTABLE")).length, 1);
  assertNoAckMutation(protectedPreflight.client.calls);
  assertProtectedAckReadOnlyTransaction(protectedPreflight.client);

  const unprotectedClient = semanticAckReadinessClient({ checks });
  await assert.rejects(
    () => preflightDeviceBridgeAckSchemaForProtectedT1Preflight(unprotectedClient),
    /ACK schema compatibility check failed/
  );
  assert.equal(unprotectedClient.calls.some(call => call.sql.includes("LIMIT 2") || call.sql.includes("FROM XMLTABLE")), false);

  const runtimeClient = semanticAckReadinessClient({ checks });
  assert.deepEqual(await inspectDeviceBridgeAckSchema(runtimeClient), {
    ready: false,
    constraintName: null
  });
  assert.equal(runtimeClient.calls.some(call => call.sql.includes("LIMIT 2") || call.sql.includes("FROM XMLTABLE")), false);
  assertNoAckMutation(runtimeClient.calls);
});

test("ACK canonicalization preflight fails closed for non-equivalence, incompleteness, and data mismatch", async () => {
  const checks = completeAckChecks({ payloadDefinition: NONCANONICAL_EQUIVALENT_PAYLOAD });
  const scenarios = [
    { matrix: semanticMatrix({ RECEIVED: [true, false, true, false] }) },
    { matrix: semanticMatrix().slice(0, -1) },
    { matrixError: true }
  ];
  for (const scenario of scenarios) {
    const client = semanticAckReadinessClient({ checks, ...scenario });
    await assert.rejects(
      () => preflightDeviceBridgeAckSchemaForCanonicalization(client),
      /ACK schema compatibility check failed/
    );
    assertNoAckMutation(client.calls);
  }
  const incompatible = semanticAckReadinessClient({ checks });
  const originalQuery = incompatible.query.bind(incompatible);
  incompatible.query = async (sql, params) => sql.includes("AS incompatible")
    ? { rows: [{ incompatible: true }] }
    : originalQuery(sql, params);
  await assert.rejects(
    () => preflightDeviceBridgeAckSchemaForCanonicalization(incompatible),
    /ACK data is incompatible/
  );
  assertNoAckMutation(incompatible.calls);
});

test("noncanonical ACK payload outcomes fail closed unless every bounded semantic rule matches", async () => {
  const checks = completeAckChecks({ payloadDefinition: NONCANONICAL_EQUIVALENT_PAYLOAD });
  const scenarios = [
    { label: "weaker", matrix: semanticMatrix({ RECEIVED: [true, false, true, false] }) },
    { label: "stronger", matrix: semanticMatrix({ SUCCEEDED: [true, false, false, false] }) },
    { label: "partial", matrix: semanticMatrix({ FAILED: [false, false, false, false] }) },
    { label: "drift", matrix: semanticMatrix({ EXPIRED: [false, true, false, false] }) },
    { label: "unresolved", targets: [] },
    { label: "incomplete", matrix: semanticMatrix().slice(0, -1) },
    { label: "evaluation error", matrixError: true }
  ];

  for (const scenario of scenarios) {
    const client = semanticAckReadinessClient({ checks, ...scenario });
    const pool = { async connect() { return client; } };
    await assert.rejects(
      () => withDeviceBridgeReadOnlyTransaction(pool, current => preflightDeviceBridgeAckSchemaForProtectedT1Preflight(current)),
      /ACK schema compatibility check failed/,
      scenario.label
    );
    assertNoAckMutation(client.calls);
    assertProtectedAckReadOnlyTransaction(client);
  }
});

test("unrelated ACK checks and required ACK column types remain strict before semantic evaluation", async () => {
  const unrelatedMismatch = semanticAckReadinessClient({
    checks: completeAckChecks({ payloadDefinition: NONCANONICAL_EQUIVALENT_PAYLOAD, mismatchRule: "ACK_STATUS_VALUES" })
  });
  await assert.rejects(
    () => withDeviceBridgeReadOnlyTransaction({ async connect() { return unrelatedMismatch; } }, current =>
      preflightDeviceBridgeAckSchemaForProtectedT1Preflight(current)
    ),
    /ACK schema compatibility check failed/
  );
  assert.equal(unrelatedMismatch.calls.some(call => call.sql.includes("LIMIT 2") || call.sql.includes("FROM XMLTABLE")), false);
  assertNoAckMutation(unrelatedMismatch.calls);
  assertProtectedAckReadOnlyTransaction(unrelatedMismatch);

  const missingRequiredColumnType = semanticAckReadinessClient({
    checks: completeAckChecks({ payloadDefinition: NONCANONICAL_EQUIVALENT_PAYLOAD }),
    columnTypes: { status: "text", result: "jsonb" }
  });
  await assert.rejects(
    () => withDeviceBridgeReadOnlyTransaction({ async connect() { return missingRequiredColumnType; } }, current =>
      preflightDeviceBridgeAckSchemaForProtectedT1Preflight(current)
    ),
    /ACK schema compatibility check failed/
  );
  assert.equal(missingRequiredColumnType.calls.some(call => call.sql.includes("LIMIT 2") || call.sql.includes("FROM XMLTABLE")), false);
  assertNoAckMutation(missingRequiredColumnType.calls);
  assertProtectedAckReadOnlyTransaction(missingRequiredColumnType);
});

function responseRecorder() {
  return { statusCode: null, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}

function revokePool({ missing = false, alreadyRevoked = false, failAudit = false } = {}) {
  const calls = [];
  const state = { deviceUpdates: 0, keyUpdates: 0, audits: 0, commits: 0, rollbacks: 0 };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "COMMIT") { state.commits += 1; return { rows: [] }; }
      if (sql === "ROLLBACK") { state.rollbacks += 1; return { rows: [] }; }
      if (sql.includes("FROM device_bridge_devices")) return { rows: missing ? [] : [{
        device_id: DEVICE_ID,
        enrollment_state: alreadyRevoked ? "REVOKED" : "ACTIVE",
        revoked_at: alreadyRevoked ? NOW : null
      }] };
      if (sql.includes("SELECT key_id")) return { rows: [{ key_id: "a565e8a7-ef60-42d0-b19d-26e7904390fa" }] };
      if (sql.includes("UPDATE device_bridge_devices")) { state.deviceUpdates += 1; return { rowCount: 1, rows: [] }; }
      if (sql.includes("UPDATE device_bridge_keys")) { state.keyUpdates += 1; return { rowCount: 1, rows: [] }; }
      if (sql.includes("INSERT INTO device_bridge_audit_events")) {
        if (failAudit) throw new Error("audit failure");
        state.audits += 1; return { rowCount: 1, rows: [] };
      }
      return { rows: [] };
    },
    release() { state.released = true; }
  };
  return { pool: { async connect() { return client; } }, calls, state };
}

test("admin revoke atomically revokes device and active keys with safe audit", async () => {
  const fake = revokePool();
  const res = responseRecorder();
  await createAdminDeviceRevokeHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enrollment_state, "REVOKED");
  assert.equal(fake.state.deviceUpdates, 1);
  assert.equal(fake.state.keyUpdates, 1);
  assert.equal(fake.state.audits, 1);
  assert.equal(fake.state.commits, 1);
  const audit = fake.calls.find(call => call.sql.includes("device_bridge_audit_events"));
  assert.deepEqual(JSON.parse(audit.params[1]), { reason: "ADMIN_REQUEST" });
  assert.equal(JSON.stringify(audit).match(/signature|public_key|token|cookie|credential/i), null);
});

test("admin revoke is idempotent without duplicate mutation or audit", async () => {
  const fake = revokePool({ alreadyRevoked: true });
  const res = responseRecorder();
  await createAdminDeviceRevokeHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(fake.state.deviceUpdates, 0);
  assert.equal(fake.state.keyUpdates, 0);
  assert.equal(fake.state.audits, 0);
  assert.equal(fake.state.commits, 1);
});

test("admin revoke validates identifier/body and reports missing device", async () => {
  for (const request of [
    { params: { deviceId: "invalid" }, body: {} },
    { params: { deviceId: DEVICE_ID }, body: { reason: "injected" } }
  ]) {
    const fake = revokePool();
    const res = responseRecorder();
    await createAdminDeviceRevokeHandler(fake.pool)(request, res);
    assert.equal(res.statusCode, 400);
    assert.equal(fake.calls.length, 0);
  }
  const missing = revokePool({ missing: true });
  const res = responseRecorder();
  await createAdminDeviceRevokeHandler(missing.pool)({ params: { deviceId: DEVICE_ID }, body: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(missing.state.rollbacks, 1);
});

test("admin revoke DB failure rolls device, keys and audit back", async () => {
  const fake = revokePool({ failAudit: true });
  const res = responseRecorder();
  const originalError = console.error;
  console.error = () => {};
  try {
    await createAdminDeviceRevokeHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body: {} }, res);
  } finally {
    console.error = originalError;
  }
  assert.equal(res.statusCode, 500);
  assert.equal(fake.state.deviceUpdates, 1);
  assert.equal(fake.state.keyUpdates, 1);
  assert.equal(fake.state.commits, 0);
  assert.equal(fake.state.rollbacks, 1);
});

test("admin revoke route reuses dashboard auth and Device Bridge readiness", () => {
  const routes = fs.readFileSync(new URL("../device-bridge/block3-routes.js", import.meta.url), "utf8");
  assert.match(routes, /app\.post\("\/dashboard-api\/device-bridge\/devices\/:deviceId\/revoke", admin\(revokeDevice\)\)/);
});
