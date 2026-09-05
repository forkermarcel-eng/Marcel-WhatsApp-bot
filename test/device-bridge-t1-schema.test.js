import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  T1_COMMAND_TYPE_CHECK_EXPRESSION,
  T1_COMMAND_TYPE_CONSTRAINT_NAME,
  T1_TINDER_STATE_CHECK_EXPRESSION,
  T1_TINDER_STATE_CONSTRAINT_NAME,
  inspectDeviceBridgeT1Schema
} from "../device-bridge/t1-schema.js";
import {
  migrateDeviceBridgeSchema,
  T1_MIGRATION_IDLE_TRANSACTION_TIMEOUT,
  T1_MIGRATION_LOCK_TIMEOUT,
  T1_MIGRATION_STATEMENT_TIMEOUT
} from "../device-bridge/database.js";
import {
  FOUNDATION_COLUMN_CONTRACT,
  FOUNDATION_CONSTRAINT_CONTRACT,
  FOUNDATION_INDEX_CONTRACT,
  preflightDeviceBridgeFoundationForT1
} from "../device-bridge/schema-readiness.js";
import { withDeviceBridgeReadOnlyTransaction } from "../device-bridge/read-only-transaction.js";

const REQUIRED_TABLES = Object.freeze(Object.keys(FOUNDATION_COLUMN_CONTRACT));
const LEGACY_TINDER = ["DISCONNECTED", "CONNECTED", "AUTH_REQUIRED", "REVIEW_REQUIRED", "UNKNOWN"];
const FINAL_TINDER = ["DISCONNECTED", "CONNECTING", "CONNECTED", "AUTH_REQUIRED", "REVIEW_REQUIRED", "UNKNOWN"];
const LEGACY_COMMANDS = ["PING", "REQUEST_STATUS", "STOP_BRIDGE"];
const FINAL_COMMANDS = ["PING", "REQUEST_STATUS", "STOP_BRIDGE", "CONNECT_TINDER", "DISCONNECT_TINDER"];
const ACK_STATUS = ["RECEIVED", "SUCCEEDED", "FAILED", "REJECTED", "EXPIRED"];
const CANONICAL_ACK_ACCEPTANCE = Object.freeze({
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

function checkDefinition(expression) {
  return `CHECK (${expression})`;
}

function enumExpression(column, values) {
  return `${column} IN (${values.map(value => `'${value}'`).join(", ")})`;
}

function semanticMatrix(overrides = {}) {
  return ACK_STATUS.flatMap((status, statusIndex) => CANONICAL_ACK_ACCEPTANCE[status].map((canonical_accepts, combinationIndex) => ({
    case_id: statusIndex * 4 + combinationIndex + 1,
    production_accepts: (overrides[status] || CANONICAL_ACK_ACCEPTANCE[status])[combinationIndex],
    canonical_accepts
  })));
}

function ackSemanticMatrixFor(mode) {
  if (mode === "UNSAFE") return semanticMatrix({ RECEIVED: [true, true, true, true] });
  if (mode === "WRONG") return semanticMatrix({ SUCCEEDED: [false, false, false, false] });
  if (mode === "WEAKER") return semanticMatrix({ RECEIVED: [true, false, true, false] });
  if (mode === "STRONGER") return semanticMatrix({ SUCCEEDED: [true, false, false, false] });
  if (mode === "PARTIAL") return semanticMatrix({ FAILED: [false, false, false, false] });
  if (mode === "DRIFT") return semanticMatrix({ EXPIRED: [false, true, false, false] });
  return semanticMatrix();
}

function ackConstraints({ mode = "FINAL", extra = false } = {}) {
  if (mode === "MISSING") return [];
  const payload = `
    (status = 'RECEIVED' AND result IS NULL AND error IS NULL)
    OR (status = 'SUCCEEDED' AND error IS NULL)
    OR (status = 'FAILED' AND result IS NULL AND error IS NOT NULL)
    OR (status = 'REJECTED' AND result IS NULL)
    OR (status = 'EXPIRED' AND result IS NULL AND error IS NULL)
  `;
  const rows = [
    {
      conname: "device_bridge_command_acks_status_check",
      convalidated: true,
      constraint_definition: checkDefinition(enumExpression("status", ACK_STATUS)),
      column_names: ["status"]
    },
    {
      conname: "device_bridge_command_acks_result_check",
      convalidated: true,
      constraint_definition: checkDefinition("result IS NULL OR jsonb_typeof(result) = 'object'"),
      column_names: ["result"]
    },
    {
      conname: "device_bridge_command_acks_error_check",
      convalidated: true,
      constraint_definition: checkDefinition("error IS NULL OR jsonb_typeof(error) = 'object'"),
      column_names: ["error"]
    },
    {
      conname: "device_bridge_command_acks_body_sha256_check",
      convalidated: true,
      constraint_definition: checkDefinition("body_sha256 ~ '^[0-9a-f]{64}$'"),
      column_names: ["body_sha256"]
    },
    {
      conname: "device_bridge_command_acks_payload_check_v1",
      convalidated: mode !== "UNVALIDATED",
      constraint_definition: checkDefinition(mode === "WRONG" ? "status = 'RECEIVED'" : mode === "UNSAFE" ? `(${payload}) OR TRUE` : mode === "FINAL" || mode === "UNVALIDATED" ? payload : NONCANONICAL_EQUIVALENT_ACK_PAYLOAD),
      column_names: ["error", "result", "status"]
    }
  ];
  if (extra) rows.push({
    conname: "unexpected_ack_occurred_at_check",
    convalidated: true,
    constraint_definition: checkDefinition("occurred_at IS NOT NULL"),
    column_names: ["occurred_at"]
  });
  return rows.map(row => ({ condeferrable: false, condeferred: false, ...row }));
}

function t1Constraint({ kind, mode }) {
  const tinder = kind === "tinder";
  const column = tinder ? "tinder_state" : "command_type";
  const finalName = tinder ? T1_TINDER_STATE_CONSTRAINT_NAME : T1_COMMAND_TYPE_CONSTRAINT_NAME;
  const legacyName = tinder ? "device_bridge_devices_tinder_state_check" : "device_bridge_commands_command_type_check";
  const finalValues = tinder ? FINAL_TINDER : FINAL_COMMANDS;
  const legacyValues = tinder ? LEGACY_TINDER : LEGACY_COMMANDS;
  const finalExpression = tinder ? T1_TINDER_STATE_CHECK_EXPRESSION : T1_COMMAND_TYPE_CHECK_EXPRESSION;
  const isFinal = mode === "FINAL";
  const base = isFinal ? finalExpression : enumExpression(column, legacyValues);
  return {
    conname: mode === "WRONG" ? finalName : isFinal ? finalName : legacyName,
    convalidated: mode !== "UNVALIDATED",
    condeferrable: false,
    condeferred: false,
    constraint_definition: checkDefinition(mode === "WRONG" ? enumExpression(column, ["UNKNOWN"]) : mode === "UNSAFE" ? `(${base}) OR TRUE` : base),
    column_names: [column]
  };
}

function foundationColumns({ fault = null } = {}) {
  const rows = Object.entries(FOUNDATION_COLUMN_CONTRACT).flatMap(([table, columns]) =>
    Object.entries(columns).map(([column, contract]) => ({
      table_name: table,
      column_name: column,
      data_type: fault === "char" && table === "device_bridge_command_acks" && column === "body_sha256" ? "character(32)" : contract.dataType,
      not_null: fault === "nullable" && table === "device_bridge_devices" && column === "display_name" ? false : contract.notNull,
      column_default: fault === "default" && table === "device_bridge_commands" && column === "protocol_version" ? "2" : contract.defaultExpression,
      identity_kind: contract.identityKind,
      generated_kind: contract.generatedKind
    }))
  );
  if (fault === "partial") rows.splice(rows.findIndex(row => row.table_name === "device_bridge_keys" && row.column_name === "algorithm"), 1);
  if (fault === "extra_column") rows.push({
    table_name: "device_bridge_devices", column_name: "unexpected_column", data_type: "text", not_null: false,
    column_default: "", identity_kind: "", generated_kind: ""
  });
  return rows;
}

function foundationConstraints(state, { fault = null, postgresCatalogChars = false } = {}) {
  const rows = FOUNDATION_CONSTRAINT_CONTRACT.map(contract => ({
    table_name: contract.table,
    contype: contract.type,
    convalidated: true,
    condeferrable: false,
    condeferred: false,
    // PostgreSQL exposes the three FK-only catalog chars as spaces on
    // non-FK constraints. This guards the real catalog shape, not just
    // simplified test fixtures.
    confdeltype: postgresCatalogChars && contract.type !== "f" ? " " : contract.deleteAction || "",
    confupdtype: postgresCatalogChars && contract.type !== "f" ? " " : contract.updateAction || "",
    confmatchtype: postgresCatalogChars && contract.type !== "f" ? " " : contract.matchType || "",
    constraint_definition: contract.type === "c" ? checkDefinition(contract.sources[0]) : contract.source,
    reference_table: contract.referenceTable || "",
    column_names: contract.type === "c" ? [] : contract.columns,
    reference_column_names: contract.referenceColumns || []
  }));
  rows.push({
    table_name: "device_bridge_devices", contype: "c", convalidated: true, condeferrable: false, condeferred: false,
    confdeltype: "", confupdtype: "", confmatchtype: "", reference_table: "", reference_column_names: [],
    ...t1Constraint({ kind: "tinder", mode: state.tinder })
  });
  rows.push({
    table_name: "device_bridge_commands", contype: "c", convalidated: true, condeferrable: false, condeferred: false,
    confdeltype: "", confupdtype: "", confmatchtype: "", reference_table: "", reference_column_names: [],
    ...t1Constraint({ kind: "command", mode: state.command })
  });
  for (const ack of ackConstraints({ mode: state.ack, extra: state.extraAck })) {
    rows.push({
      table_name: "device_bridge_command_acks", contype: "c", condeferrable: false, condeferred: false,
      confdeltype: "", confupdtype: "", confmatchtype: "", reference_table: "", reference_column_names: [], ...ack
    });
  }
  if (fault === "missing_constraint") rows.splice(rows.findIndex(row => row.table_name === "device_bridge_keys" && row.contype === "f"), 1);
  if (fault === "extra_constraint") rows.push({
    table_name: "device_bridge_devices", contype: "c", convalidated: true, condeferrable: false, condeferred: false,
    confdeltype: "", confupdtype: "", confmatchtype: "", reference_table: "", reference_column_names: [],
    conname: "unexpected_foundation_check", constraint_definition: checkDefinition("TRUE"), column_names: []
  });
  return rows;
}

function foundationIndexes({ fault = null } = {}) {
  const rows = FOUNDATION_INDEX_CONTRACT.map(contract => ({
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
  if (fault === "missing_index") rows.pop();
  if (fault === "extra_index") rows.push({
    table_name: "device_bridge_devices", index_name: "unexpected_foundation_idx", indisunique: false,
    indisvalid: true, indisready: true, access_method: "btree", key_expressions: ["display_name"], key_options: [0], predicate: ""
  });
  return rows;
}

function migrationClient({
  foundation = "READY",
  foundationFault = null,
  tinder = "LEGACY",
  command = "LEGACY",
  ack = "FINAL",
  extraAck = false,
  incompatibleTinder = false,
  incompatibleCommand = false,
  incompatibleAck = false,
  wrongAckTypes = false,
  postgresCatalogChars = false,
  failOnSecondT1Ddl = false,
  failPostcheck = false,
  lockTimeout = false,
  advisoryLockAvailable = true,
  schemaDriftAfterLocks = false,
  dataDriftAfterLocks = false,
  failCommit = false,
  failRollback = false
} = {}) {
  const calls = [];
  const present = new Set(foundation === "EMPTY" ? [] : REQUIRED_TABLES);
  if (foundation === "MISSING") present.delete("device_bridge_audit_events");
  const state = {
    tinder,
    command,
    ack,
    extraAck,
    incompatibleTinder,
    incompatibleCommand,
    incompatibleAck,
    committed: false,
    rolledBack: false,
    rollbackCount: 0,
    lockCount: 0,
    snapshot: null
  };
  function snapshotState() {
    return {
      tinder: state.tinder,
      command: state.command,
      incompatibleTinder: state.incompatibleTinder,
      incompatibleCommand: state.incompatibleCommand,
      incompatibleAck: state.incompatibleAck
    };
  }
  function restoreSnapshot() {
    if (!state.snapshot) return;
    Object.assign(state, state.snapshot);
    state.snapshot = null;
  }
  const client = {
    calls,
    state,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN") {
        state.snapshot = snapshotState();
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
        state.rollbackCount += 1;
        if (failRollback) throw new Error("injected ROLLBACK failure");
        restoreSnapshot();
        return { rows: [] };
      }
      if (sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY" || sql.startsWith("SET LOCAL ")) return { rows: [] };
      if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: advisoryLockAvailable }] };
      if (sql.includes("to_regclass")) return { rows: [{ relation_name: present.has(params[0]) ? params[0] : null }] };
      if (sql.includes("FROM pg_class c") && sql.includes("c.relkind")) {
        return { rows: REQUIRED_TABLES.map(table => ({ table_name: table, relkind: foundationFault === "relation" && table === "device_bridge_keys" ? "v" : "r" })) };
      }
      if (sql.includes("format_type(a.atttypid")) return { rows: foundationColumns({ fault: foundation === "PARTIAL" ? "partial" : foundationFault }) };
      if (sql.includes("FROM pg_constraint c") && sql.includes("rel.relname")) return { rows: foundationConstraints(state, { fault: foundationFault, postgresCatalogChars }) };
      if (sql.includes("FROM pg_index i")) return { rows: foundationIndexes({ fault: foundationFault }) };
      if (sql.includes("information_schema.columns") && sql.includes("table_name = 'device_bridge_command_acks'")) {
        return {
          rows: Object.entries({ status: "text", result: "jsonb", error: "jsonb" }).map(([column_name, udt_name]) => ({
            column_name,
            udt_name: wrongAckTypes && column_name === "result" ? "text" : udt_name
          }))
        };
      }
      if (sql.includes("LIMIT 2") && sql.includes("pg_depend")) {
        return { rows: ack === "UNRESOLVED" ? [] : [{ constraint_oid: "4242", evaluator_safe: true }] };
      }
      if (sql.includes("FROM XMLTABLE") && sql.includes("query_to_xml")) {
        if (ack === "EVALUATION_ERROR") throw new Error("injected semantic evaluator error");
        return { rows: ack === "INCOMPLETE" ? semanticMatrix().slice(0, -1) : ackSemanticMatrixFor(ack) };
      }
      if (sql.includes("FROM pg_constraint") && sql.includes("device_bridge_devices")) return { rows: [t1Constraint({ kind: "tinder", mode: state.tinder })] };
      if (sql.includes("FROM pg_constraint") && sql.includes("device_bridge_commands")) return { rows: [t1Constraint({ kind: "command", mode: state.command })] };
      if (sql.includes("FROM pg_constraint") && sql.includes("device_bridge_command_acks")) return { rows: ackConstraints({ mode: state.ack, extra: state.extraAck }) };
      if (sql.includes("FROM device_bridge_devices") && sql.includes("IS NOT TRUE")) return { rows: [{ incompatible: state.incompatibleTinder }] };
      if (sql.includes("FROM device_bridge_commands") && sql.includes("IS NOT TRUE")) return { rows: [{ incompatible: state.incompatibleCommand }] };
      if (sql.includes("FROM device_bridge_command_acks") && sql.includes("IS NOT TRUE")) return { rows: [{ incompatible: state.incompatibleAck }] };
      if (sql.startsWith("LOCK TABLE")) {
        state.lockCount += 1;
        if (lockTimeout) {
          const error = new Error("injected lock timeout");
          error.code = "55P03";
          throw error;
        }
        if (state.lockCount === REQUIRED_TABLES.length) {
          if (schemaDriftAfterLocks) state.command = "UNSAFE";
          if (dataDriftAfterLocks) state.incompatibleCommand = true;
        }
        return { rows: [] };
      }
      if (sql.includes("ALTER TABLE") && sql.includes("ADD CONSTRAINT") && sql.includes(T1_TINDER_STATE_CONSTRAINT_NAME)) {
        state.tinder = "FINAL";
        return { rows: [] };
      }
      if (sql.includes("ALTER TABLE") && sql.includes("ADD CONSTRAINT") && sql.includes(T1_COMMAND_TYPE_CONSTRAINT_NAME)) {
        if (failOnSecondT1Ddl) throw new Error("injected T1 DDL failure");
        state.command = "FINAL";
        if (failPostcheck) state.tinder = "UNSAFE";
        return { rows: [] };
      }
      if (sql.includes("ALTER TABLE") && sql.includes("DROP CONSTRAINT")) return { rows: [] };
      throw new Error(`Unexpected query in migration test: ${sql}`);
    },
    release(error) { state.released = true; state.releaseError = error || null; }
  };
  return { client, pool: { async connect() { return client; } } };
}

function ddlCalls(calls) {
  return calls.filter(call => /\b(CREATE|ALTER|DROP)\b/i.test(call.sql));
}

test("runtime T1 inspection accepts only exact final definitions without mutation", async () => {
  const fake = migrationClient({ tinder: "FINAL", command: "FINAL" });
  const inspection = await inspectDeviceBridgeT1Schema(fake.client);
  assert.equal(inspection.ready, true);
  assert.equal(fake.client.calls.some(call => /\b(LOCK|ALTER|CREATE|DROP|UPDATE)\b/i.test(call.sql)), false);
});

test("semantic T1 check changes stop before any DDL", async () => {
  for (const options of [{ tinder: "UNSAFE" }, { command: "UNSAFE" }, { command: "UNVALIDATED" }]) {
    const fake = migrationClient(options);
    await assert.rejects(() => migrateDeviceBridgeSchema(fake.pool), /compatibility check failed/);
    assert.equal(ddlCalls(fake.client.calls).length, 0);
    assert.equal(fake.client.state.rolledBack, true);
  }
});

test("empty, missing, and present-but-partial foundations stop before any DDL", async () => {
  for (const foundation of ["EMPTY", "MISSING", "PARTIAL"]) {
    const fake = migrationClient({ foundation });
    await assert.rejects(() => migrateDeviceBridgeSchema(fake.pool), foundation === "PARTIAL" ? /foundation compatibility check failed/ : /complete existing foundation/);
    assert.equal(ddlCalls(fake.client.calls).length, 0);
    assert.equal(fake.client.state.rolledBack, true);
  }
});

test("noncanonical Foundation relation, column, constraint, or index stops before any DDL", async () => {
  for (const foundationFault of ["relation", "nullable", "default", "char", "extra_column", "missing_constraint", "extra_constraint", "missing_index", "extra_index"]) {
    const fake = migrationClient({ foundationFault });
    await assert.rejects(() => migrateDeviceBridgeSchema(fake.pool), /foundation compatibility check failed/);
    assert.equal(ddlCalls(fake.client.calls).length, 0);
  }
});

test("Foundation preflight accepts PostgreSQL catalog sentinel chars and DESC NULLS FIRST index flags", async () => {
  const descendingIndexes = FOUNDATION_INDEX_CONTRACT
    .filter(contract => contract.keys.at(-1) === "accepted_at" || contract.keys.at(-1) === "created_at")
    .map(contract => contract.options);
  assert.deepEqual(descendingIndexes, [[0, 3], [0, 3], [0, 3]]);
  const fake = migrationClient({ postgresCatalogChars: true });
  assert.deepEqual(await migrateDeviceBridgeSchema(fake.pool), { migrated: true });
  assert.equal(ddlCalls(fake.client.calls).length, 4);
  const readiness = fs.readFileSync(new URL("../device-bridge/schema-readiness.js", import.meta.url), "utf8");
  assert.match(readiness, /indoption::int2\[\]\)\[key_number\.position - 1\]/);
});

test("the exact Foundation index SELECT with a comment semicolon is accepted by the protected read-only wrapper", async () => {
  const fake = migrationClient();
  assert.deepEqual(
    await withDeviceBridgeReadOnlyTransaction(fake.pool, client => preflightDeviceBridgeFoundationForT1(client)),
    { ready: true }
  );
  const indexQuery = fake.client.calls.find(call => call.sql.includes("FROM pg_index i"));
  assert.ok(indexQuery);
  assert.match(indexQuery.sql, /-- array cast; pg_get_indexdef above intentionally remains 1-based\./);
  assert.equal(fake.client.calls[0]?.sql, "BEGIN");
  assert.equal(fake.client.calls[1]?.sql, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  assert.equal(fake.client.calls.at(-1)?.sql, "ROLLBACK");
  assert.equal(fake.client.state.released, true);
  assert.equal(ddlCalls(fake.client.calls).length, 0);
});

test("missing, weakened, extra, unvalidated, or mistyped ACK state stops before any DDL", async () => {
  for (const options of [
    { ack: "MISSING" }, { ack: "WRONG" }, { ack: "UNSAFE" }, { ack: "UNVALIDATED" }, { extraAck: true }, { wrongAckTypes: true }
  ]) {
    const fake = migrationClient(options);
    await assert.rejects(() => migrateDeviceBridgeSchema(fake.pool), /ACK schema compatibility check failed/);
    assert.equal(ddlCalls(fake.client.calls).length, 0);
  }
});

test("canonical ACK uses the runner fast path without the semantic evaluator", async () => {
  const fake = migrationClient({ ack: "FINAL" });
  assert.deepEqual(await migrateDeviceBridgeSchema(fake.pool), { migrated: true });
  assert.equal(fake.client.calls.some(call => call.sql.includes("FROM XMLTABLE")), false);
  assert.equal(fake.client.calls.filter(call => call.sql === "BEGIN").length, 1);
  assert.equal(fake.client.calls.some(call => call.sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"), false);
});

test("known semantically equivalent noncanonical ACK passes every runner gate on its one transaction client", async () => {
  const fake = migrationClient({ ack: "EQUIVALENT" });
  assert.deepEqual(await migrateDeviceBridgeSchema(fake.pool), { migrated: true });
  const matrixCalls = fake.client.calls
    .map((call, index) => ({ call, index }))
    .filter(item => item.call.sql.includes("FROM XMLTABLE"));
  const lockCalls = fake.client.calls
    .map((call, index) => ({ call, index }))
    .filter(item => item.call.sql.startsWith("LOCK TABLE"));
  const ddl = ddlCalls(fake.client.calls);
  const firstDdl = fake.client.calls.indexOf(ddl[0]);
  const lastDdl = fake.client.calls.lastIndexOf(ddl.at(-1));
  assert.equal(matrixCalls.length, 3);
  assert.ok(matrixCalls[0].index < lockCalls[0].index);
  assert.ok(matrixCalls[1].index > lockCalls.at(-1).index && matrixCalls[1].index < firstDdl);
  assert.ok(matrixCalls[2].index > lastDdl && matrixCalls[2].index < fake.client.calls.findIndex(call => call.sql === "COMMIT"));
  assert.equal(fake.client.calls.filter(call => call.sql === "BEGIN").length, 1);
  assert.equal(fake.client.calls.some(call => call.sql === "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"), false);
  assert.equal(fake.client.state.committed, true);
});

test("noncanonical ACK that is weaker, stronger, partial, drifted, unresolved, incomplete, or errored stops before locks and DDL", async () => {
  for (const ack of ["WEAKER", "STRONGER", "PARTIAL", "DRIFT", "UNRESOLVED", "INCOMPLETE", "EVALUATION_ERROR"]) {
    const fake = migrationClient({ ack });
    await assert.rejects(() => migrateDeviceBridgeSchema(fake.pool), /ACK schema compatibility check failed/);
    assert.equal(fake.client.calls.some(call => call.sql.startsWith("LOCK TABLE")), false, ack);
    assert.equal(ddlCalls(fake.client.calls).length, 0, ack);
    assert.equal(fake.client.state.rolledBack, true, ack);
  }
});

test("incompatible and NULL-compatible T1 or ACK rows stop before any DDL", async () => {
  for (const options of [{ incompatibleTinder: true }, { incompatibleCommand: true }, { incompatibleAck: true }]) {
    const fake = migrationClient(options);
    await assert.rejects(() => migrateDeviceBridgeSchema(fake.pool), /incompatible/);
    assert.equal(ddlCalls(fake.client.calls).length, 0);
  }
  const source = fs.readFileSync(new URL("../device-bridge/t1-schema.js", import.meta.url), "utf8");
  const ack = fs.readFileSync(new URL("../device-bridge/ack-schema.js", import.meta.url), "utf8");
  assert.match(source, /\) IS NOT TRUE/);
  assert.match(ack, /\) IS NOT TRUE/);
});

test("transaction-local migration bounds and a concurrent-runner ambiguity fail closed without retry", async () => {
  const fake = migrationClient({ advisoryLockAvailable: false });
  await assert.rejects(() => migrateDeviceBridgeSchema(fake.pool), /already running/);
  assert.equal(fake.client.calls.some(call => call.sql === `SET LOCAL lock_timeout = '${T1_MIGRATION_LOCK_TIMEOUT}'`), true);
  assert.equal(fake.client.calls.some(call => call.sql === `SET LOCAL statement_timeout = '${T1_MIGRATION_STATEMENT_TIMEOUT}'`), true);
  assert.equal(fake.client.calls.some(call => call.sql === `SET LOCAL idle_in_transaction_session_timeout = '${T1_MIGRATION_IDLE_TRANSACTION_TIMEOUT}'`), true);
  assert.equal(fake.client.calls.filter(call => call.sql.includes("pg_try_advisory_xact_lock")).length, 1);
  assert.equal(fake.client.calls.some(call => call.sql.startsWith("LOCK TABLE")), false);
  assert.equal(ddlCalls(fake.client.calls).length, 0);
  assert.equal(fake.client.state.rolledBack, true);
  assert.equal(fake.client.state.released, true);
});

test("lock timeout aborts once, rolls back, and a separately initiated recovery run succeeds", async () => {
  const blocked = migrationClient({ lockTimeout: true });
  await assert.rejects(() => migrateDeviceBridgeSchema(blocked.pool), /lock timeout/);
  assert.equal(blocked.client.calls.filter(call => call.sql.startsWith("LOCK TABLE")).length, 1);
  assert.equal(ddlCalls(blocked.client.calls).length, 0);
  assert.equal(blocked.client.state.rolledBack, true);
  assert.equal(blocked.client.state.released, true);

  const recovery = migrationClient();
  assert.deepEqual(await migrateDeviceBridgeSchema(recovery.pool), { migrated: true });
  assert.equal(ddlCalls(recovery.client.calls).length, 4);
});

test("schema or data drift discovered only after the full lock set aborts before DDL", async () => {
  for (const options of [{ schemaDriftAfterLocks: true }, { dataDriftAfterLocks: true }]) {
    const fake = migrationClient(options);
    await assert.rejects(() => migrateDeviceBridgeSchema(fake.pool));
    assert.equal(fake.client.state.lockCount, REQUIRED_TABLES.length);
    assert.equal(ddlCalls(fake.client.calls).length, 0);
    assert.equal(fake.client.state.rolledBack, true);
  }
});

test("complete pre-T1 Foundation performs exactly four documented T1 ALTERs after the global preflight", async () => {
  const fake = migrationClient();
  assert.deepEqual(await migrateDeviceBridgeSchema(fake.pool), { migrated: true });
  const ddl = ddlCalls(fake.client.calls);
  assert.equal(ddl.length, 4);
  assert.equal(ddl.every(call => call.sql.includes("ALTER TABLE device_bridge_devices") || call.sql.includes("ALTER TABLE device_bridge_commands")), true);
  assert.equal(ddl.some(call => call.sql.includes("device_bridge_command_acks")), false);
  assert.equal(ddl.some(call => /\bCREATE\b/i.test(call.sql)), false);
  const firstDdl = fake.client.calls.indexOf(ddl[0]);
  const beforeDdl = fake.client.calls.slice(0, firstDdl);
  const locks = beforeDdl.filter(call => call.sql.startsWith("LOCK TABLE"));
  assert.equal(locks.length, REQUIRED_TABLES.length);
  assert.deepEqual(locks.map(call => call.sql.match(/^LOCK TABLE ([a-z_]+)/)?.[1]), REQUIRED_TABLES);
  assert.equal(beforeDdl.some(call => call.sql.includes("FROM pg_index i")), true);
  assert.equal(beforeDdl.some(call => call.sql.includes("device_bridge_command_acks") && call.sql.includes("IS NOT TRUE")), true);
  assert.equal(fake.client.state.committed, true);
});

test("successful migration runs a postcheck and a second final-state run is idempotent", async () => {
  const fake = migrationClient();
  await migrateDeviceBridgeSchema(fake.pool);
  const lastDdl = fake.client.calls.map((call, index) => ({ call, index })).filter(item => /\bALTER\b/i.test(item.call.sql)).at(-1).index;
  assert.equal(fake.client.calls.slice(lastDdl + 1).some(call => call.sql.includes("FROM pg_constraint c") && call.sql.includes("rel.relname")), true);
  const before = ddlCalls(fake.client.calls).length;
  assert.deepEqual(await migrateDeviceBridgeSchema(fake.pool), { migrated: false });
  assert.equal(ddlCalls(fake.client.calls).length, before);
});

test("already-T1 is a no-op and partial-T1 state fails closed", async () => {
  const final = migrationClient({ tinder: "FINAL", command: "FINAL" });
  assert.deepEqual(await migrateDeviceBridgeSchema(final.pool), { migrated: false });
  assert.equal(ddlCalls(final.client.calls).length, 0);

  for (const options of [{ tinder: "FINAL", command: "LEGACY" }, { tinder: "LEGACY", command: "FINAL" }]) {
    const partial = migrationClient(options);
    await assert.rejects(() => migrateDeviceBridgeSchema(partial.pool), /one unambiguous constraint state/);
    assert.equal(ddlCalls(partial.client.calls).length, 0);
    assert.equal(partial.client.state.rolledBack, true);
  }
});

test("postcheck failure and a failure during the second allowed ALTER both roll back", async () => {
  for (const options of [{ failPostcheck: true }, { failOnSecondT1Ddl: true }]) {
    const fake = migrationClient(options);
    await assert.rejects(() => migrateDeviceBridgeSchema(fake.pool));
    assert.equal(fake.client.state.committed, false);
    assert.equal(fake.client.state.rolledBack, true);
    assert.equal(fake.client.state.tinder, "LEGACY");
    assert.equal(fake.client.state.command, "LEGACY");
    assert.equal(fake.client.state.released, true);
  }
});

test("a failed COMMIT never triggers an automatic retry or an ambiguous rollback", async () => {
  const fake = migrationClient({ failCommit: true });
  await assert.rejects(() => migrateDeviceBridgeSchema(fake.pool), /COMMIT failure/);
  assert.equal(fake.client.calls.filter(call => call.sql === "COMMIT").length, 1);
  assert.equal(fake.client.calls.filter(call => call.sql === "BEGIN").length, 1);
  assert.equal(fake.client.state.rolledBack, false);
  assert.equal(fake.client.state.released, true);
  assert.ok(fake.client.state.releaseError instanceof Error);
});

test("a rollback failure preserves the primary abort and discards the client without retry", async () => {
  const fake = migrationClient({ lockTimeout: true, failRollback: true });
  await assert.rejects(() => migrateDeviceBridgeSchema(fake.pool), /lock timeout/);
  assert.equal(fake.client.calls.filter(call => call.sql === "ROLLBACK").length, 1);
  assert.equal(fake.client.calls.filter(call => call.sql === "BEGIN").length, 1);
  assert.equal(ddlCalls(fake.client.calls).length, 0);
  assert.equal(fake.client.state.released, true);
  assert.ok(fake.client.state.releaseError instanceof Error);
});

test("only the global explicit runner retains T1 DDL authority", () => {
  const t1 = fs.readFileSync(new URL("../device-bridge/t1-schema.js", import.meta.url), "utf8");
  const database = fs.readFileSync(new URL("../device-bridge/database.js", import.meta.url), "utf8");
  assert.doesNotMatch(t1, /ALTER TABLE|export async function migrateDeviceBridgeT1Schema|export async function apply/);
  assert.match(database, /preflightDeviceBridgeT1Release/);
  assert.match(database, /lockVerifiedDeviceBridgeFoundation/);
  assert.match(database, /applyVerifiedT1SchemaPlan/);
  assert.doesNotMatch(database, /CREATE TABLE|CREATE INDEX|migrateDeviceBridgeAckSchema|ALTER TABLE device_bridge_command_acks/);
});
