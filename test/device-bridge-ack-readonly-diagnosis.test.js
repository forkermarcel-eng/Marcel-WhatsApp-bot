import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  ACK_REQUIRED_CHECKS,
  FINAL_ACK_CONSTRAINT_NAME
} from "../device-bridge/ack-schema.js";
import {
  runDeviceBridgeAckReadOnlyDiagnosis
} from "../device-bridge/ack-readonly-diagnosis.js";
import { createAdminAckFoundationDiagnosisHandler } from "../device-bridge/admin.js";
import { registerDeviceBridgeBlock3Routes } from "../device-bridge/block3-routes.js";
import {
  FOUNDATION_COLUMN_CONTRACT,
  FOUNDATION_CONSTRAINT_CONTRACT,
  FOUNDATION_INDEX_CONTRACT
} from "../device-bridge/schema-readiness.js";

const ACK_TABLE = "device_bridge_command_acks";
const ACK_COLUMNS = FOUNDATION_COLUMN_CONTRACT[ACK_TABLE];
const ACK_KEYS = FOUNDATION_CONSTRAINT_CONTRACT.filter(contract => contract.table === ACK_TABLE && contract.type !== "c");
const ACK_INDEXES = FOUNDATION_INDEX_CONTRACT.filter(contract => contract.table === ACK_TABLE);

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

function checkDefinition(expression) {
  return `CHECK (${expression})`;
}

function canonicalAckChecks({ payloadName = FINAL_ACK_CONSTRAINT_NAME, missingRule = null, extra = false, wrongRule = null, unvalidatedRule = null } = {}) {
  const rows = ACK_REQUIRED_CHECKS
    .filter(specification => specification.id !== missingRule)
    .map(specification => ({
      conname: specification.name ? payloadName : `generated_${specification.id.toLowerCase()}`,
      convalidated: specification.id !== unvalidatedRule,
      condeferrable: false,
      condeferred: false,
      constraint_definition: checkDefinition(
        specification.id === wrongRule ? "status = 'RECEIVED'" : specification.expression
      ),
      column_names: specification.columns
    }));
  if (extra) rows.push({
    conname: "unexpected_ack_check",
    convalidated: true,
    condeferrable: false,
    condeferred: false,
    constraint_definition: checkDefinition("occurred_at IS NOT NULL"),
    column_names: ["occurred_at"]
  });
  return rows;
}

function ackColumns({ fault = null } = {}) {
  const rows = Object.entries(ACK_COLUMNS).map(([column_name, contract]) => ({
    column_name,
    data_type: fault === "wrong-result-type" && column_name === "result" ? "text" : contract.dataType,
    not_null: fault === "wrong-nullability" && column_name === "status" ? false : contract.notNull,
    column_default: fault === "wrong-default" && column_name === "accepted_at" ? "clock_timestamp()" : contract.defaultExpression,
    identity_kind: contract.identityKind,
    generated_kind: contract.generatedKind
  }));
  if (fault === "missing-body-sha") return rows.filter(row => row.column_name !== "body_sha256");
  if (fault === "extra") rows.push({
    column_name: "unexpected_ack_extension",
    data_type: "text",
    not_null: false,
    column_default: "",
    identity_kind: "",
    generated_kind: ""
  });
  return rows;
}

function ackKeys({ fault = null } = {}) {
  const rows = ACK_KEYS.map(contract => ({
    contype: contract.type,
    convalidated: true,
    condeferrable: false,
    condeferred: false,
    confdeltype: contract.deleteAction || "",
    confupdtype: contract.updateAction || "",
    confmatchtype: contract.matchType || "",
    reference_table: contract.referenceTable || "",
    column_names: contract.columns,
    reference_column_names: contract.referenceColumns || []
  }));
  if (fault === "wrong-composite-fk") {
    const target = rows.find(row => row.contype === "f" && row.column_names.length === 2);
    target.confdeltype = "c";
  }
  if (fault === "missing-unique") return rows.filter(row => row.contype !== "u");
  return rows;
}

function ackIndexes({ fault = null } = {}) {
  const rows = ACK_INDEXES.map(contract => ({
    index_name: contract.name,
    indisunique: contract.unique,
    indisvalid: true,
    indisready: true,
    access_method: "btree",
    key_expressions: contract.keys,
    key_options: contract.options,
    predicate: contract.predicate
  }));
  if (fault === "missing") return [];
  if (fault === "wrong") rows[0].key_options = [0, 0];
  if (fault === "extra") rows.push({
    index_name: "unexpected_ack_index",
    indisunique: false,
    indisvalid: true,
    indisready: true,
    access_method: "btree",
    key_expressions: ["status"],
    key_options: [0],
    predicate: ""
  });
  return rows;
}

function diagnosisPool({
  relation = "table",
  columnFault = null,
  keyFault = null,
  indexFault = null,
  checks = canonicalAckChecks(),
  incompatibleCount = 0,
  failQuery = false,
  failRollback = false
} = {}) {
  const calls = [];
  const state = { released: false };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN" || sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY") {
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        if (failRollback) throw new Error("rollback unavailable");
        return { rows: [] };
      }
      if (failQuery) throw new Error("postgres://private-user:private-password@private-host/private-db");
      if (sql.includes("FROM pg_class c") && sql.includes("c.relkind")) {
        return { rows: relation === "missing" ? [] : [{ relkind: relation === "table" ? "r" : "v" }] };
      }
      if (sql.includes("JOIN pg_attribute a") && sql.includes("format_type")) {
        return { rows: ackColumns({ fault: columnFault }) };
      }
      if (sql.includes("c.contype IN ('p', 'u', 'f')")) return { rows: ackKeys({ fault: keyFault }) };
      if (sql.includes("FROM pg_index i")) return { rows: ackIndexes({ fault: indexFault }) };
      if (sql.includes("c.conrelid = 'device_bridge_command_acks'::regclass")) return { rows: checks };
      if (sql.includes("COUNT(*)::int AS incompatible_count")) return { rows: [{ incompatible_count: incompatibleCount }] };
      throw new Error(`Unexpected diagnosis query: ${sql}`);
    },
    release() { state.released = true; }
  };
  return { pool: { async connect() { return client; } }, calls, state };
}

function assertReadOnlyTransaction(fake) {
  assert.equal(fake.calls[0]?.sql, "BEGIN");
  assert.equal(fake.calls[1]?.sql, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  assert.equal(fake.calls.at(-1)?.sql, "ROLLBACK");
  assert.equal(fake.calls.slice(2, -1).every(call => /^\s*SELECT\b/i.test(call.sql)), true);
  assert.equal(fake.calls.some(call => /\b(COMMIT|LOCK|CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(call.sql)), false);
  assert.equal(fake.state.released, true);
}

test("canonical ACK Foundation returns a bounded compatible diagnosis in one read-only transaction", async () => {
  const fake = diagnosisPool();
  const result = await runDeviceBridgeAckReadOnlyDiagnosis(fake.pool);
  assert.equal(result.ok, true);
  assert.equal(result.reason_code, "ACK_DIAGNOSIS_COMPLETE");
  assert.equal(result.diagnosis.table.object_type, "TABLE");
  assert.equal(result.diagnosis.columns.columns.every(column => column.status === "MATCH"), true);
  assert.equal(result.diagnosis.relationships.relationships.every(item => item.status === "MATCH"), true);
  assert.equal(result.diagnosis.indexes.required.every(index => index.status === "MATCH"), true);
  assert.equal(result.diagnosis.checks.checks.every(check => check.status === "MATCH"), true);
  assert.equal(result.diagnosis.checks.observed.every(check => check.semantic_rule !== "NONCANONICAL"), true);
  assert.deepEqual(result.diagnosis.row_compatibility, { status: "COMPATIBLE", incompatible_count: 0 });
  assert.equal(result.diagnosis.classification, "CANONICAL");
  assert.equal(result.diagnosis.contract_compatible, true);
  assertReadOnlyTransaction(fake);
});

test("diagnosis refuses a non-SELECT dependency query and never leaks the internal error", async () => {
  const fake = diagnosisPool();
  const result = await runDeviceBridgeAckReadOnlyDiagnosis(fake.pool, {
    inspectShape: async client => {
      await client.query("ALTER TABLE device_bridge_command_acks ADD COLUMN forbidden text");
    }
  });
  assert.deepEqual(result, { ok: false, reason_code: "DIAGNOSIS_GUARD_BLOCKED" });
  assert.equal(JSON.stringify(result).includes("forbidden"), false);
  assertReadOnlyTransaction(fake);
});

test("diagnosis rejects multi-statement SELECT input before PostgreSQL sees it", async () => {
  const fake = diagnosisPool();
  const result = await runDeviceBridgeAckReadOnlyDiagnosis(fake.pool, {
    inspectShape: async client => {
      await client.query("SELECT 1; ALTER TABLE device_bridge_command_acks ADD COLUMN forbidden text");
    }
  });
  assert.deepEqual(result, { ok: false, reason_code: "DIAGNOSIS_GUARD_BLOCKED" });
  assert.equal(fake.calls.some(call => call.sql.includes("forbidden")), false);
  assertReadOnlyTransaction(fake);
});

test("catalog failures always roll back and never expose database URLs", async () => {
  const fake = diagnosisPool({ failQuery: true });
  const result = await runDeviceBridgeAckReadOnlyDiagnosis(fake.pool);
  assert.deepEqual(result, { ok: false, reason_code: "DIAGNOSIS_UNAVAILABLE" });
  assert.equal(JSON.stringify(result).includes("postgres://"), false);
  assertReadOnlyTransaction(fake);
});

test("rollback failure prevents a successful diagnosis response", async () => {
  const fake = diagnosisPool({ failRollback: true });
  const result = await runDeviceBridgeAckReadOnlyDiagnosis(fake.pool);
  assert.deepEqual(result, { ok: false, reason_code: "DIAGNOSIS_UNAVAILABLE" });
  assert.equal(fake.calls.at(-1)?.sql, "ROLLBACK");
  assert.equal(fake.state.released, true);
});

test("missing and non-table ACK objects are distinguished without broader catalog reads", async () => {
  const missing = diagnosisPool({ relation: "missing" });
  const missingResult = await runDeviceBridgeAckReadOnlyDiagnosis(missing.pool);
  assert.equal(missingResult.diagnosis.table.object_type, "MISSING");
  assert.equal(missingResult.diagnosis.classification, "MISSING_ACK_FOUNDATION");
  assert.equal(missing.calls.some(call => call.sql.includes("FROM pg_attribute")), false);
  assertReadOnlyTransaction(missing);

  const nonTable = diagnosisPool({ relation: "view" });
  const nonTableResult = await runDeviceBridgeAckReadOnlyDiagnosis(nonTable.pool);
  assert.equal(nonTableResult.diagnosis.table.object_type, "NON_TABLE");
  assert.equal(nonTableResult.diagnosis.classification, "ACK_OBJECT_TYPE_MISMATCH");
  assertReadOnlyTransaction(nonTable);
});

test("wrong ACK columns, relationships, and required index are individually identified", async () => {
  const fake = diagnosisPool({ columnFault: "wrong-result-type", keyFault: "wrong-composite-fk", indexFault: "wrong" });
  const result = await runDeviceBridgeAckReadOnlyDiagnosis(fake.pool);
  assert.equal(result.diagnosis.columns.columns.find(column => column.name === "result").status, "TYPE_MISMATCH");
  assert.equal(result.diagnosis.relationships.relationships.find(item => item.rule === "ACK_FOREIGN_KEY_COMMAND_DEVICE").status, "MISMATCH");
  assert.equal(result.diagnosis.relationships.relationships.find(item => item.rule === "ACK_FOREIGN_KEY_COMMAND_DEVICE").actual.delete_action, "CASCADE");
  assert.equal(result.diagnosis.indexes.required[0].status, "MISMATCH");
  assert.equal(result.diagnosis.indexes.required[0].actual.order_status, "MISMATCH");
  assert.equal(result.diagnosis.row_compatibility.status, "NOT_CHECKED");
  assert.equal(result.diagnosis.contract_compatible, false);
  assertReadOnlyTransaction(fake);
});

test("noncontractual ACK indexes are bounded and cannot be misreported as an ACK check failure", async () => {
  const fake = diagnosisPool({ indexFault: "extra" });
  const result = await runDeviceBridgeAckReadOnlyDiagnosis(fake.pool);
  assert.equal(result.diagnosis.indexes.unexpected_noncontractual_index_count, 1);
  assert.equal(result.diagnosis.indexes.unexpected_noncontractual_index_status, "PRESENT_OUTSIDE_CONTRACT");
  assert.equal(result.diagnosis.checks.compatible, true);
  assert.equal(result.diagnosis.contract_compatible, false);
  assert.equal(result.diagnosis.classification, "NONCONTRACTUAL_ACK_INDEX_PRESENT");
  assertReadOnlyTransaction(fake);
});

test("equivalent PostgreSQL status CHECK formatting is normalized while weakened checks remain incompatible", async () => {
  const equivalent = canonicalAckChecks();
  equivalent[0].constraint_definition = "CHECK (status = ANY (ARRAY['RECEIVED'::text, 'SUCCEEDED'::text, 'FAILED'::text, 'REJECTED'::text, 'EXPIRED'::text]))";
  const normalized = diagnosisPool({ checks: equivalent });
  const normalizedResult = await runDeviceBridgeAckReadOnlyDiagnosis(normalized.pool);
  assert.equal(normalizedResult.diagnosis.checks.checks.find(check => check.rule === "ACK_STATUS_VALUES").status, "MATCH");
  assert.equal(normalizedResult.diagnosis.comparator.normalizes_equivalent_pg_definitions, true);
  assertReadOnlyTransaction(normalized);

  const weakened = diagnosisPool({ checks: canonicalAckChecks({ wrongRule: "ACK_PAYLOAD_V1" }) });
  const weakenedResult = await runDeviceBridgeAckReadOnlyDiagnosis(weakened.pool);
  assert.equal(weakenedResult.diagnosis.checks.checks.find(check => check.rule === "ACK_PAYLOAD_V1").status, "DEFINITION_MISMATCH");
  assert.equal(weakenedResult.diagnosis.checks.observed.find(check => check.columns.join(",") === "error,result,status").semantic_rule, "NONCANONICAL");
  assert.equal(weakenedResult.diagnosis.comparator.false_positive_status, "UNRESOLVED_REQUIRES_SEMANTIC_REVIEW");
  assertReadOnlyTransaction(weakened);
});

test("legacy payload naming and partial ACK contracts are classified without raw definitions", async () => {
  const legacy = diagnosisPool({ checks: canonicalAckChecks({ payloadName: "device_bridge_command_acks_check3" }) });
  const legacyResult = await runDeviceBridgeAckReadOnlyDiagnosis(legacy.pool);
  const legacyPayload = legacyResult.diagnosis.checks.checks.find(check => check.rule === "ACK_PAYLOAD_V1");
  assert.equal(legacyPayload.status, "NAME_MISMATCH");
  assert.equal(legacyResult.diagnosis.classification, "KNOWN_LEGACY_PAYLOAD_CONSTRAINT");
  assert.equal(legacyResult.diagnosis.comparator.false_positive_status, "NOT_IDENTIFIED");
  assertReadOnlyTransaction(legacy);

  const partial = diagnosisPool({ checks: canonicalAckChecks({ missingRule: "ACK_ERROR_OBJECT" }) });
  const partialResult = await runDeviceBridgeAckReadOnlyDiagnosis(partial.pool);
  assert.equal(partialResult.diagnosis.checks.checks.find(check => check.rule === "ACK_ERROR_OBJECT").status, "MISSING");
  assert.equal(partialResult.diagnosis.classification, "PARTIAL_ACK_FOUNDATION");
  assertReadOnlyTransaction(partial);

  const legacyPlusIndexDifference = diagnosisPool({
    checks: canonicalAckChecks({ payloadName: "device_bridge_command_acks_check3" }),
    indexFault: "extra"
  });
  const combinedResult = await runDeviceBridgeAckReadOnlyDiagnosis(legacyPlusIndexDifference.pool);
  assert.equal(combinedResult.diagnosis.classification, "PARTIAL_ACK_FOUNDATION");
  assertReadOnlyTransaction(legacyPlusIndexDifference);
});

test("row compatibility is aggregate-only and checked only after a safely typed ACK shape", async () => {
  const fake = diagnosisPool({ incompatibleCount: 3 });
  const result = await runDeviceBridgeAckReadOnlyDiagnosis(fake.pool);
  assert.deepEqual(result.diagnosis.row_compatibility, { status: "INCOMPATIBLE", incompatible_count: 3 });
  assert.equal(Object.hasOwn(result.diagnosis.row_compatibility, "rows"), false);
  assert.equal(result.diagnosis.classification, "CANONICAL_SCHEMA_WITH_INCOMPATIBLE_ROWS");
  const rowQuery = fake.calls.find(call => call.sql.includes("COUNT(*)::int AS incompatible_count"));
  assert.match(rowQuery.sql, /jsonb_typeof\(result\)/);
  assert.match(rowQuery.sql, /jsonb_typeof\(error\)/);
  assert.match(rowQuery.sql, /body_sha256/);
  assertReadOnlyTransaction(fake);

  const unavailableCount = diagnosisPool({ incompatibleCount: "not-a-count" });
  const unavailableCountResult = await runDeviceBridgeAckReadOnlyDiagnosis(unavailableCount.pool);
  assert.equal(unavailableCountResult.diagnosis.row_compatibility.status, "NOT_CHECKED");
  assert.equal(unavailableCountResult.diagnosis.classification, "ACK_ROW_COMPATIBILITY_NOT_CHECKED");
  assertReadOnlyTransaction(unavailableCount);
});

test("ACK diagnosis route preserves dashboard auth, rejects all caller input, and remains callable before runtime readiness", async () => {
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
  const route = routes.get("GET /dashboard-api/device-bridge/ack-schema-diagnosis");
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
  await routes.get("GET /dashboard-api/device-bridge/ack-schema-diagnosis")({ query: {} }, beforeReady);
  assert.equal(beforeReady.statusCode, 503);
  assert.equal(connects, 1);
});

test("handler serializes an allowlisted bounded response and never accepts SQL-like input", async () => {
  let invoked = false;
  const handler = createAdminAckFoundationDiagnosisHandler({}, {
    runDiagnosis: async () => {
      invoked = true;
      return {
        ok: true,
        reason_code: "ACK_DIAGNOSIS_COMPLETE",
        diagnosis: {
          table: { exists: true, object_type: "TABLE" },
          columns: { columns: [], unexpected_column_count: 0 },
          relationships: { relationships: [], unexpected_constraint_count: 0 },
          indexes: { required: [], unexpected_noncontractual_index_count: 0, unexpected_noncontractual_index_status: "NONE" },
          checks: {
            checks: [],
            observed: [{ columns: ["status"], semantic_rule: "ACK_STATUS_VALUES", payload_name_status: "NOT_NAME_CONTRACTUAL", validation: "VALID", raw_definition: "CHECK (secret_column IS NOT NULL)" }],
            observed_truncated: false,
            actual_check_count: 5,
            unexpected_check_count: 0
          },
          row_compatibility: { status: "COMPATIBLE", incompatible_count: 0, rows: [{ private: true }] },
          classification: "CANONICAL",
          contract_compatible: true,
          comparator: { normalizes_equivalent_pg_definitions: true, false_positive_status: "NOT_IDENTIFIED", assessment: "SAFE" },
          database_url: "postgres://private-user:private-password@private-host/private-db",
          raw_constraint_definition: "CHECK (secret_column IS NOT NULL)"
        }
      };
    }
  });
  const rejected = responseRecorder();
  await handler({ query: { sql: "SELECT 1" } }, rejected);
  assert.equal(rejected.statusCode, 400);
  assert.equal(invoked, false);

  const malformedQuery = responseRecorder();
  await handler({ query: "sql=SELECT+1" }, malformedQuery);
  assert.equal(malformedQuery.statusCode, 400);
  assert.equal(invoked, false);

  const rejectedBody = responseRecorder();
  await handler({ query: {}, body: { include_rows: true } }, rejectedBody);
  assert.equal(rejectedBody.statusCode, 400);
  assert.equal(invoked, false);

  const accepted = responseRecorder();
  await handler({ query: {} }, accepted);
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.headers["Cache-Control"], "no-store, max-age=0");
  const serialized = JSON.stringify(accepted.body);
  assert.equal(serialized.includes("postgres://"), false);
  assert.equal(serialized.includes("secret_column"), false);
  assert.equal(serialized.includes("private"), false);
});

test("ACK diagnosis and shared transaction modules have no migration or mutation authority", () => {
  const diagnosis = fs.readFileSync(new URL("../device-bridge/ack-readonly-diagnosis.js", import.meta.url), "utf8");
  const transaction = fs.readFileSync(new URL("../device-bridge/read-only-transaction.js", import.meta.url), "utf8");
  assert.doesNotMatch(diagnosis, /\.\/database\.js/);
  assert.doesNotMatch(diagnosis, /\b(COMMIT|LOCK|CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/);
  assert.match(transaction, /SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY/);
  assert.doesNotMatch(transaction, /\b(COMMIT|LOCK|CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/);
});
