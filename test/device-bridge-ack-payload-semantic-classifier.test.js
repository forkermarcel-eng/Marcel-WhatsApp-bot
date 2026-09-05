import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createAdminAckPayloadSemanticClassifierHandler } from "../device-bridge/admin.js";
import { registerDeviceBridgeBlock3Routes } from "../device-bridge/block3-routes.js";
import { runDeviceBridgeAckPayloadSemanticClassifier } from "../device-bridge/ack-payload-semantic-classifier.js";

const STATUSES = ["RECEIVED", "SUCCEEDED", "FAILED", "REJECTED", "EXPIRED"];
const CANONICAL_ACCEPTANCE = Object.freeze({
  RECEIVED: [true, false, false, false],
  SUCCEEDED: [true, false, true, false],
  FAILED: [false, true, false, false],
  REJECTED: [true, true, false, false],
  EXPIRED: [true, false, false, false]
});

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

function semanticMatrix(overrides = {}) {
  return STATUSES.flatMap((status, statusIndex) => CANONICAL_ACCEPTANCE[status].map((canonical_accepts, combinationIndex) => ({
    case_id: statusIndex * 4 + combinationIndex + 1,
    production_accepts: (overrides[status] || CANONICAL_ACCEPTANCE[status])[combinationIndex],
    canonical_accepts
  })));
}

function semanticPool({
  targets = [{ constraint_oid: "4242", evaluator_safe: true }],
  matrix = semanticMatrix(),
  matrixError = false,
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
      if (sql.includes("LIMIT 2") && sql.includes("FROM pg_constraint c")) return { rows: targets };
      if (sql.includes("FROM XMLTABLE") && sql.includes("query_to_xml")) {
        if (matrixError) throw new Error("XML support unavailable");
        return { rows: matrix };
      }
      throw new Error(`Unexpected semantic classifier query: ${sql}`);
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
  assert.equal(fake.calls.slice(2, -1).every(call => !call.sql.includes(";")), true);
  assert.equal(fake.calls.some(call => /\b(COMMIT|LOCK|CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(call.sql)), false);
  assert.equal(fake.state.released, true);
}

function classification(result) {
  assert.equal(result.ok, true);
  return result.classification;
}

test("canonical-equivalent ACK payload matrix is classified in one read-only rolled-back transaction", async () => {
  const fake = semanticPool();
  const result = await runDeviceBridgeAckPayloadSemanticClassifier(fake.pool);
  const observed = classification(result);
  assert.deepEqual(observed.status_rules, {
    RECEIVED: "MATCH",
    SUCCEEDED: "MATCH",
    FAILED: "MATCH",
    REJECTED: "MATCH",
    EXPIRED: "MATCH"
  });
  assert.equal(observed.overall_classification, "SEMANTICALLY_EQUIVALENT");
  assert.equal(observed.production_can_accept_rows_canonical_rejects, false);
  assert.equal(observed.canonical_can_accept_rows_production_rejects, false);
  assert.equal(result.reason_code, "SEMANTIC_CLASSIFICATION_COMPLETE");
  assert.match(fake.calls[2].sql, /ARRAY\['error', 'result', 'status'\]::text\[\]/);
  assert.match(fake.calls[3].sql, /query_to_xml/);
  assert.match(fake.calls[3].sql, /XMLTABLE/);
  assert.deepEqual(fake.calls[3].params.slice(0, 1), ["4242"]);
  assertReadOnlyTransaction(fake);
});

test("weaker RECEIVED and missing FAILED error requirements are detected", async () => {
  const received = semanticPool({ matrix: semanticMatrix({ RECEIVED: [true, false, true, false] }) });
  const receivedResult = classification(await runDeviceBridgeAckPayloadSemanticClassifier(received.pool));
  assert.equal(receivedResult.status_rules.RECEIVED, "PRODUCTION_WEAKER");
  assert.equal(receivedResult.overall_classification, "PRODUCTION_LEGACY_WEAKER");
  assert.equal(receivedResult.production_can_accept_rows_canonical_rejects, true);
  assert.equal(receivedResult.canonical_can_accept_rows_production_rejects, false);
  assertReadOnlyTransaction(received);

  const failed = semanticPool({ matrix: semanticMatrix({ FAILED: [true, true, false, false] }) });
  const failedResult = classification(await runDeviceBridgeAckPayloadSemanticClassifier(failed.pool));
  assert.equal(failedResult.status_rules.FAILED, "PRODUCTION_WEAKER");
  assert.equal(failedResult.overall_classification, "PRODUCTION_LEGACY_WEAKER");
  assert.equal(failedResult.production_can_accept_rows_canonical_rejects, true);
  assert.equal(failedResult.canonical_can_accept_rows_production_rejects, false);
  assertReadOnlyTransaction(failed);
});

test("stronger SUCCEEDED and incorrect REJECTED behavior are detected", async () => {
  const succeeded = semanticPool({ matrix: semanticMatrix({ SUCCEEDED: [true, false, false, false] }) });
  const succeededResult = classification(await runDeviceBridgeAckPayloadSemanticClassifier(succeeded.pool));
  assert.equal(succeededResult.status_rules.SUCCEEDED, "PRODUCTION_STRONGER");
  assert.equal(succeededResult.overall_classification, "PRODUCTION_LEGACY_STRONGER");
  assert.equal(succeededResult.production_can_accept_rows_canonical_rejects, false);
  assert.equal(succeededResult.canonical_can_accept_rows_production_rejects, true);
  assertReadOnlyTransaction(succeeded);

  const rejected = semanticPool({ matrix: semanticMatrix({ REJECTED: [true, false, false, false] }) });
  const rejectedResult = classification(await runDeviceBridgeAckPayloadSemanticClassifier(rejected.pool));
  assert.equal(rejectedResult.status_rules.REJECTED, "PRODUCTION_STRONGER");
  assert.equal(rejectedResult.overall_classification, "PRODUCTION_LEGACY_STRONGER");
  assert.equal(rejectedResult.canonical_can_accept_rows_production_rejects, true);
  assertReadOnlyTransaction(rejected);
});

test("incorrect EXPIRED behavior and mixed drift are classified without guessing", async () => {
  const expired = semanticPool({ matrix: semanticMatrix({ EXPIRED: [false, true, false, false] }) });
  const expiredResult = classification(await runDeviceBridgeAckPayloadSemanticClassifier(expired.pool));
  assert.equal(expiredResult.status_rules.EXPIRED, "PRODUCTION_DIFFERENT");
  assert.equal(expiredResult.overall_classification, "PRODUCTION_DRIFT");
  assert.equal(expiredResult.production_can_accept_rows_canonical_rejects, true);
  assert.equal(expiredResult.canonical_can_accept_rows_production_rejects, true);
  assertReadOnlyTransaction(expired);

  const mixed = semanticPool({ matrix: semanticMatrix({
    RECEIVED: [true, false, true, false],
    SUCCEEDED: [true, false, false, false]
  }) });
  const mixedResult = classification(await runDeviceBridgeAckPayloadSemanticClassifier(mixed.pool));
  assert.equal(mixedResult.status_rules.RECEIVED, "PRODUCTION_WEAKER");
  assert.equal(mixedResult.status_rules.SUCCEEDED, "PRODUCTION_STRONGER");
  assert.equal(mixedResult.overall_classification, "PRODUCTION_DRIFT");
  assert.equal(mixedResult.production_can_accept_rows_canonical_rejects, true);
  assert.equal(mixedResult.canonical_can_accept_rows_production_rejects, true);
  assertReadOnlyTransaction(mixed);
});

test("a completely missing supported branch is bounded as a partial rule", async () => {
  const fake = semanticPool({ matrix: semanticMatrix({ FAILED: [false, false, false, false] }) });
  const result = classification(await runDeviceBridgeAckPayloadSemanticClassifier(fake.pool));
  assert.equal(result.status_rules.FAILED, "PRODUCTION_STRONGER");
  assert.equal(result.overall_classification, "PRODUCTION_PARTIAL_RULE");
  assert.equal(result.production_can_accept_rows_canonical_rejects, false);
  assert.equal(result.canonical_can_accept_rows_production_rejects, true);
  assertReadOnlyTransaction(fake);
});

test("ambiguous, unsafe, malformed, and unparseable production states remain unresolved", async () => {
  const scenarios = [
    semanticPool({ targets: [] }),
    semanticPool({ targets: [{ constraint_oid: "1", evaluator_safe: true }, { constraint_oid: "2", evaluator_safe: true }] }),
    semanticPool({ targets: [{ constraint_oid: "1", evaluator_safe: false }] }),
    semanticPool({ matrix: semanticMatrix().slice(0, -1) }),
    semanticPool({ matrixError: true })
  ];
  for (const fake of scenarios) {
    const result = classification(await runDeviceBridgeAckPayloadSemanticClassifier(fake.pool));
    assert.equal(result.overall_classification, "UNRESOLVED");
    assert.deepEqual(Object.values(result.status_rules), ["UNRESOLVED", "UNRESOLVED", "UNRESOLVED", "UNRESOLVED", "UNRESOLVED"]);
    assert.equal(result.production_can_accept_rows_canonical_rejects, "UNRESOLVED");
    assert.equal(result.canonical_can_accept_rows_production_rejects, "UNRESOLVED");
    assertReadOnlyTransaction(fake);
  }
});

test("read-only guard blocks injected schema and row mutation dependencies", async () => {
  for (const forbidden of [
    "ALTER TABLE device_bridge_command_acks ADD COLUMN forbidden text",
    "INSERT INTO device_bridge_command_acks (status) VALUES ('RECEIVED')"
  ]) {
    const fake = semanticPool();
    const result = await runDeviceBridgeAckPayloadSemanticClassifier(fake.pool, {
      findConstraint: async client => client.query(forbidden)
    });
    assert.deepEqual(result, { ok: false, reason_code: "SEMANTIC_CLASSIFIER_GUARD_BLOCKED" });
    assert.equal(fake.calls.some(call => call.sql.includes("forbidden")), false);
    assertReadOnlyTransaction(fake);
  }
});

test("rollback failure prevents a successful semantic classification response", async () => {
  const fake = semanticPool({ failRollback: true });
  const result = await runDeviceBridgeAckPayloadSemanticClassifier(fake.pool);
  assert.deepEqual(result, { ok: false, reason_code: "SEMANTIC_CLASSIFIER_UNAVAILABLE" });
  assert.equal(fake.calls.at(-1)?.sql, "ROLLBACK");
  assert.equal(fake.state.released, true);
});

test("semantic classifier route retains dashboard auth and runs before device-bridge readiness", async () => {
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
  const route = routes.get("GET /dashboard-api/device-bridge/ack-payload-semantics");
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
  await routes.get("GET /dashboard-api/device-bridge/ack-payload-semantics")({ query: {} }, beforeReady);
  assert.equal(connects, 1);
  assert.equal(beforeReady.statusCode, 503);
});

test("handler rejects all caller input and serializes only bounded classifications", async () => {
  let invoked = false;
  const handler = createAdminAckPayloadSemanticClassifierHandler({}, {
    runClassifier: async () => {
      invoked = true;
      return {
        ok: true,
        reason_code: "SEMANTIC_CLASSIFICATION_COMPLETE",
        classification: {
          status_rules: Object.fromEntries(STATUSES.map(status => [status, "MATCH"])),
          overall_classification: "SEMANTICALLY_EQUIVALENT",
          production_can_accept_rows_canonical_rejects: false,
          canonical_can_accept_rows_production_rejects: false,
          raw_constraint_definition: "CHECK (private_secret IS NOT NULL)",
          matrix: [{ raw_ack_row: true }],
          database_url: "postgres://private-user:private-password@private-host/private-db",
          unrelated_schema: "private_schema"
        }
      };
    }
  });
  for (const req of [
    { query: { sql: "SELECT 1" } },
    { query: { constraint: "any_constraint" } },
    { query: "sql=SELECT+1" },
    { query: {}, body: { include_rows: true } }
  ]) {
    const rejected = responseRecorder();
    await handler(req, rejected);
    assert.equal(rejected.statusCode, 400);
    assert.equal(invoked, false);
  }

  const accepted = responseRecorder();
  await handler({ query: {} }, accepted);
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.headers["Cache-Control"], "no-store, max-age=0");
  assert.deepEqual(Object.keys(accepted.body.classification).sort(), [
    "canonical_can_accept_rows_production_rejects",
    "overall_classification",
    "production_can_accept_rows_canonical_rejects",
    "status_rules"
  ]);
  const serialized = JSON.stringify(accepted.body);
  assert.equal(serialized.includes("private_secret"), false);
  assert.equal(serialized.includes("postgres://"), false);
  assert.equal(serialized.includes("raw_ack_row"), false);
  assert.equal(serialized.includes("private_schema"), false);
});

test("classifier has no migration authority, no caller request seam, and reuses canonical source semantics", () => {
  const source = fs.readFileSync(new URL("../device-bridge/ack-payload-semantic-classifier.js", import.meta.url), "utf8");
  assert.match(source, /FINAL_ACK_CHECK_EXPRESSION/);
  assert.match(source, /withDeviceBridgeReadOnlyTransaction/);
  assert.match(source, /query_to_xml/);
  assert.match(source, /XMLTABLE/);
  assert.doesNotMatch(source, /\.\/database\.js/);
  assert.doesNotMatch(source, /req\./);
  assert.doesNotMatch(source, /\b(COMMIT|LOCK|CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/);
});
