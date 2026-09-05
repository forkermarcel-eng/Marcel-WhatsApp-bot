import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  ACK_REQUIRED_CHECKS,
  FINAL_ACK_CHECK_EXPRESSION,
  FINAL_ACK_CONSTRAINT_NAME
} from "../device-bridge/ack-schema.js";
import {
  getDeviceBridgeAckCanonicalizationFailureDiagnostic,
  migrateDeviceBridgeAckCanonicalization
} from "../device-bridge/ack-canonicalization.js";
import {
  FOUNDATION_COLUMN_CONTRACT,
  FOUNDATION_CONSTRAINT_CONTRACT,
  FOUNDATION_INDEX_CONTRACT
} from "../device-bridge/schema-readiness.js";
import { runDeviceBridgeAckCanonicalizationCli } from "../scripts/migrate-device-bridge-ack-canonicalization.js";

const REQUIRED_TABLES = Object.freeze(Object.keys(FOUNDATION_COLUMN_CONTRACT));
const STATUS_ORDER = Object.freeze(["RECEIVED", "SUCCEEDED", "FAILED", "REJECTED", "EXPIRED"]);
const CANONICAL_ACCEPTANCE = Object.freeze({
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

function checkDefinition(expression) {
  return `CHECK (${expression})`;
}

function semanticMatrix(overrides = {}) {
  return STATUS_ORDER.flatMap((status, statusIndex) => CANONICAL_ACCEPTANCE[status].map((canonical_accepts, combinationIndex) => ({
    case_id: statusIndex * 4 + combinationIndex + 1,
    production_accepts: (overrides[status] || CANONICAL_ACCEPTANCE[status])[combinationIndex],
    canonical_accepts
  })));
}

function ackChecks(mode) {
  const payload = mode === "CANONICAL"
    ? FINAL_ACK_CHECK_EXPRESSION
    : mode === "WRONG"
      ? "status = 'RECEIVED'"
      : NONCANONICAL_EQUIVALENT_PAYLOAD;
  return ACK_REQUIRED_CHECKS.map(specification => ({
    conname: specification.name || `generated_${specification.id.toLowerCase()}`,
    convalidated: true,
    condeferrable: false,
    condeferred: false,
    constraint_definition: checkDefinition(specification.id === "ACK_PAYLOAD_V1" ? payload : specification.expression),
    column_names: specification.columns
  }));
}

function foundationColumns() {
  return Object.entries(FOUNDATION_COLUMN_CONTRACT).flatMap(([table, columns]) =>
    Object.entries(columns).map(([column, contract]) => ({
      table_name: table,
      column_name: column,
      data_type: contract.dataType,
      not_null: contract.notNull,
      column_default: contract.defaultExpression,
      identity_kind: contract.identityKind,
      generated_kind: contract.generatedKind
    }))
  );
}

function foundationConstraints() {
  return FOUNDATION_CONSTRAINT_CONTRACT.map(contract => ({
    table_name: contract.table,
    contype: contract.type,
    convalidated: true,
    condeferrable: false,
    condeferred: false,
    confdeltype: contract.deleteAction || "",
    confupdtype: contract.updateAction || "",
    confmatchtype: contract.matchType || "",
    constraint_definition: contract.type === "c" ? checkDefinition(contract.sources[0]) : contract.source,
    reference_table: contract.referenceTable || "",
    column_names: contract.type === "c" ? [] : contract.columns,
    reference_column_names: contract.referenceColumns || []
  }));
}

function foundationIndexes() {
  return FOUNDATION_INDEX_CONTRACT.map(contract => ({
    table_name: contract.table,
    index_name: contract.name,
    indisunique: contract.unique,
    indisvalid: true,
    indisready: true,
    access_method: "btree",
    key_expressions: contract.keys,
    key_options: contract.options,
    predicate: contract.predicate
  }));
}

function matrixFor(mode) {
  if (mode === "WRONG") return semanticMatrix({ RECEIVED: [true, false, true, false] });
  if (mode === "WEAKER") return semanticMatrix({ RECEIVED: [true, false, true, false] });
  if (mode === "STRONGER") return semanticMatrix({ SUCCEEDED: [true, false, false, false] });
  if (mode === "DRIFT") return semanticMatrix({ EXPIRED: [false, true, false, false] });
  if (mode === "PARTIAL") return semanticMatrix({ FAILED: [false, false, false, false] });
  return semanticMatrix();
}

function migrationPool({
  mode = "NONCANONICAL",
  incompatibleRows = false,
  advisoryLockAvailable = true,
  driftAfterLock = false,
  failPostcheck = false,
  failSecondDdl = false,
  failCommit = false,
  failRollback = false
} = {}) {
  const calls = [];
  const state = {
    mode,
    incompatibleRows,
    lockCount: 0,
    committed: false,
    rolledBack: false,
    released: false,
    snapshot: null
  };
  const snapshot = () => ({ mode: state.mode, incompatibleRows: state.incompatibleRows });
  const restore = () => {
    if (!state.snapshot) return;
    Object.assign(state, state.snapshot);
    state.snapshot = null;
  };
  const client = {
    calls,
    state,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN") {
        state.snapshot = snapshot();
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        if (failCommit) throw new Error("injected COMMIT failure");
        state.committed = true;
        state.snapshot = null;
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        state.rolledBack = true;
        if (failRollback) throw new Error("injected ROLLBACK failure");
        restore();
        return { rows: [] };
      }
      if (sql.startsWith("SET LOCAL ")) return { rows: [] };
      if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: advisoryLockAvailable }] };
      if (sql.includes("to_regclass")) return { rows: [{ relation_name: params[0] }] };
      if (sql.includes("FROM pg_class c") && sql.includes("c.relkind")) {
        return { rows: REQUIRED_TABLES.map(table_name => ({ table_name, relkind: "r" })) };
      }
      if (sql.includes("format_type(a.atttypid")) return { rows: foundationColumns() };
      if (sql.includes("FROM pg_constraint c") && sql.includes("rel.relname")) return { rows: foundationConstraints() };
      if (sql.includes("FROM pg_index i")) return { rows: foundationIndexes() };
      if (sql.includes("information_schema.columns")) {
        return { rows: [
          { column_name: "status", udt_name: "text" },
          { column_name: "result", udt_name: "jsonb" },
          { column_name: "error", udt_name: "jsonb" }
        ] };
      }
      if (sql.includes("LIMIT 2") && sql.includes("pg_depend")) {
        return { rows: state.mode === "UNRESOLVED" ? [] : [{ constraint_oid: "4242", evaluator_safe: true }] };
      }
      if (sql.includes("FROM XMLTABLE") && sql.includes("query_to_xml")) {
        if (state.mode === "EVALUATION_ERROR") throw new Error("injected evaluator failure");
        return { rows: state.mode === "INCOMPLETE" ? semanticMatrix().slice(0, -1) : matrixFor(state.mode) };
      }
      if (sql.includes("c.conrelid = 'device_bridge_command_acks'::regclass")) {
        return { rows: ackChecks(state.mode) };
      }
      if (sql.includes("FROM device_bridge_command_acks") && sql.includes("AS incompatible")) {
        return { rows: [{ incompatible: state.incompatibleRows }] };
      }
      if (sql.startsWith("LOCK TABLE device_bridge_command_acks")) {
        state.lockCount += 1;
        if (driftAfterLock) state.mode = "WRONG";
        return { rows: [] };
      }
      if (sql.includes("DROP CONSTRAINT")) return { rows: [] };
      if (sql.includes(`ADD CONSTRAINT ${FINAL_ACK_CONSTRAINT_NAME}`)) {
        if (failSecondDdl) throw new Error("injected ACK DDL failure");
        state.mode = failPostcheck ? "WRONG" : "CANONICAL";
        return { rows: [] };
      }
      throw new Error(`Unexpected ACK canonicalization query: ${sql}`);
    },
    release(error) {
      state.released = true;
      state.releaseError = error || null;
    }
  };
  return { client, pool: { async connect() { return client; } } };
}

function ddlCalls(calls) {
  return calls.filter(call => /\b(?:ALTER|CREATE|DROP|TRUNCATE)\b/i.test(call.sql));
}

test("equivalent same-name ACK payload canonicalizes under one bounded transaction", async () => {
  const fake = migrationPool();
  assert.deepEqual(await migrateDeviceBridgeAckCanonicalization(fake.pool), { migrated: true });
  assert.equal(fake.client.state.mode, "CANONICAL");
  assert.equal(fake.client.state.committed, true);
  assert.equal(fake.client.state.rolledBack, false);
  assert.equal(fake.client.state.released, true);
  assert.equal(fake.client.calls.filter(call => call.sql.includes("FROM XMLTABLE")).length, 2);
  assert.equal(fake.client.calls.filter(call => call.sql.startsWith("LOCK TABLE device_bridge_command_acks")).length, 1);
  assert.equal(ddlCalls(fake.client.calls).length, 2);
  assert.equal(ddlCalls(fake.client.calls).every(call => call.sql.includes("device_bridge_command_acks")), true);
  assert.equal(fake.client.calls.some(call => call.sql.includes("ALTER TABLE device_bridge_devices") || call.sql.includes("ALTER TABLE device_bridge_commands")), false);
});

test("canonical ACK is a safe no-op and a second invocation remains a no-op", async () => {
  const fake = migrationPool({ mode: "CANONICAL" });
  assert.deepEqual(await migrateDeviceBridgeAckCanonicalization(fake.pool), { migrated: false });
  assert.deepEqual(await migrateDeviceBridgeAckCanonicalization(fake.pool), { migrated: false });
  assert.equal(ddlCalls(fake.client.calls).length, 0);
  assert.equal(fake.client.state.committed, true);
});

test("non-equivalence, unresolved/incomplete evaluation, and incompatible rows fail closed before ACK DDL", async () => {
  for (const options of [
    { mode: "WEAKER" }, { mode: "STRONGER" }, { mode: "DRIFT" }, { mode: "PARTIAL" },
    { mode: "UNRESOLVED" }, { mode: "INCOMPLETE" }, { mode: "EVALUATION_ERROR" }, { incompatibleRows: true }
  ]) {
    const fake = migrationPool(options);
    await assert.rejects(() => migrateDeviceBridgeAckCanonicalization(fake.pool));
    assert.equal(ddlCalls(fake.client.calls).length, 0);
    assert.equal(fake.client.state.rolledBack, true);
    assert.equal(fake.client.state.committed, false);
  }
});

test("locked schema drift and postcheck/DDL failure roll back to the original noncanonical state", async () => {
  for (const options of [{ driftAfterLock: true }, { failPostcheck: true }, { failSecondDdl: true }]) {
    const fake = migrationPool(options);
    await assert.rejects(() => migrateDeviceBridgeAckCanonicalization(fake.pool));
    assert.equal(fake.client.state.mode, "NONCANONICAL");
    assert.equal(fake.client.state.rolledBack, true);
    assert.equal(fake.client.state.committed, false);
  }
});

test("advisory contention and a failed commit remain bounded and never retry", async () => {
  const locked = migrationPool({ advisoryLockAvailable: false });
  let lockError;
  try {
    await migrateDeviceBridgeAckCanonicalization(locked.pool);
  } catch (caught) {
    lockError = caught;
  }
  assert.deepEqual(getDeviceBridgeAckCanonicalizationFailureDiagnostic(lockError), {
    stage: "ADVISORY_LOCK",
    code: "ADVISORY_LOCK_UNAVAILABLE",
    transaction: "STARTED",
    rollback: "COMPLETED",
    ddl_started: false
  });
  assert.equal(locked.client.calls.filter(call => call.sql.includes("pg_try_advisory_xact_lock")).length, 1);
  assert.equal(ddlCalls(locked.client.calls).length, 0);
  assert.equal(locked.client.state.rolledBack, true);

  const commit = migrationPool({ failCommit: true });
  let error;
  try {
    await migrateDeviceBridgeAckCanonicalization(commit.pool);
  } catch (caught) {
    error = caught;
  }
  assert.deepEqual(getDeviceBridgeAckCanonicalizationFailureDiagnostic(error), {
    stage: "COMMIT",
    code: "COMMIT_OUTCOME_UNRESOLVED",
    transaction: "COMMIT_OUTCOME_UNKNOWN",
    rollback: "NOT_ATTEMPTED",
    ddl_started: true
  });
  assert.equal(commit.client.calls.filter(call => call.sql === "COMMIT").length, 1);
  assert.equal(commit.client.calls.filter(call => call.sql === "BEGIN").length, 1);
  assert.equal(commit.client.calls.some(call => call.sql === "ROLLBACK"), false);
});

test("ACK canonicalization CLI is explicit and does not reveal DATABASE_URL", async () => {
  const entries = [];
  const logger = {
    log(message) { entries.push({ level: "log", message }); },
    error(message) { entries.push({ level: "error", message }); }
  };
  let created = false;
  assert.equal(await runDeviceBridgeAckCanonicalizationCli({
    argv: [],
    environment: { DATABASE_URL: "postgres://private-value" },
    createPool() { created = true; },
    logger
  }), false);
  assert.equal(created, false);
  assert.equal(JSON.stringify(entries).includes("private-value"), false);

  entries.length = 0;
  assert.equal(await runDeviceBridgeAckCanonicalizationCli({
    argv: ["--apply"],
    environment: {},
    logger
  }), false);
  assert.equal(JSON.stringify(entries).includes("DATABASE_URL="), false);
});

test("startup, read-only preflight, and T1 runner cannot import the ACK mutation authority", () => {
  const sources = [
    "../index.js",
    "../device-bridge/initialization.js",
    "../device-bridge/t1-readonly-preflight.js",
    "../device-bridge/database.js"
  ].map(relative => fs.readFileSync(new URL(relative, import.meta.url), "utf8"));
  for (const source of sources) {
    assert.doesNotMatch(source, /ack-canonicalization/);
    assert.doesNotMatch(source, /migrate-device-bridge-ack-canonicalization/);
  }
});
