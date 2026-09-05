import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  assertTinderVisibleChatCaptureMigrationSource,
  getTinderVisibleChatCaptureMigrationFailureDiagnostic,
  migrateTinderVisibleChatCaptureSchema,
  T2_CAPTURE_MIGRATION_DIAGNOSTIC_STAGES,
  validateTinderVisibleChatCaptureMigrationSource,
  validateTinderVisibleChatCapturePreDdl
} from "../device-bridge/tinder-visible-chat-capture-migration.js";
import {
  assertTinderVisibleChatCaptureSchemaReady,
  inspectTinderVisibleChatCaptureSchema,
  TINDER_VISIBLE_CHAT_CAPTURE_COLUMN_CONTRACT,
  TINDER_VISIBLE_CHAT_CAPTURE_CONSTRAINT_CONTRACT
} from "../device-bridge/tinder-visible-chat-capture-schema.js";
import { canonicalCheckDefinition } from "../device-bridge/schema-contract.js";

const migrationSql = fs.readFileSync(
  new URL("../migrations/20260905_t2_visible_chat_capture.sql", import.meta.url),
  "utf8"
);

function preflightFailurePool() {
  const calls = [];
  const state = { released: false };
  const client = {
    calls,
    state,
    async query(sql) {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL ")) return { rows: [] };
      if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: true }] };
      if (sql.includes("to_regclass")) throw new Error("injected preflight blocker");
      throw new Error(`Unexpected query: ${sql}`);
    },
    release(error) {
      state.released = true;
      state.releaseError = error || null;
    }
  };
  return { client, pool: { async connect() { return client; } } };
}

function ddlCalls(calls) {
  return calls.filter(sql => /\b(?:CREATE|ALTER|DROP|TRUNCATE|INSERT|UPDATE|DELETE)\b/i.test(sql));
}

function realPostgresCatalogShapeClient() {
  const columns = Object.entries(TINDER_VISIBLE_CHAT_CAPTURE_COLUMN_CONTRACT).map(([column_name, contract]) => ({
    column_name,
    data_type: contract.dataType,
    not_null: contract.notNull,
    column_default: contract.defaultExpression,
    identity_kind: "",
    generated_kind: ""
  }));
  const base = {
    convalidated: true,
    condeferrable: false,
    condeferred: false,
    confdeltype: " ",
    confupdtype: " ",
    confmatchtype: " ",
    reference_table: null,
    reference_column_names: []
  };
  const constraints = [
    { ...base, contype: "p", column_names: ["capture_id"], constraint_definition: "PRIMARY KEY (capture_id)" },
    { ...base, contype: "u", column_names: ["device_id", "runtime_thread_fingerprint", "capture_revision"], constraint_definition: "UNIQUE (device_id, runtime_thread_fingerprint, capture_revision)" },
    { ...base, contype: "u", column_names: ["device_id", "runtime_thread_fingerprint", "capture_fingerprint"], constraint_definition: "UNIQUE (device_id, runtime_thread_fingerprint, capture_fingerprint)" },
    {
      ...base,
      contype: "f",
      column_names: ["device_id"],
      reference_table: "device_bridge_devices",
      reference_column_names: ["device_id"],
      confdeltype: "r",
      confupdtype: "a",
      confmatchtype: "s",
      constraint_definition: "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT"
    },
    {
      ...base,
      contype: "f",
      column_names: ["resolved_contact_id"],
      reference_table: "contacts",
      reference_column_names: ["id"],
      confdeltype: "r",
      confupdtype: "a",
      confmatchtype: "s",
      constraint_definition: "FOREIGN KEY (resolved_contact_id) REFERENCES contacts(id) ON DELETE RESTRICT"
    },
    ...[
      ["capture_schema_version", "CHECK (char_length(capture_schema_version) >= 1 AND char_length(capture_schema_version) <= 80)"],
      ["source_platform", "CHECK (source_platform = 'tinder'::text)"],
      ["source_package", "CHECK (source_package = 'com.tinder'::text)"],
      ["capture_safety_status", "CHECK (capture_safety_status = 'SAFE'::text)"],
      ["runtime_thread_fingerprint", "CHECK (runtime_thread_fingerprint ~ '^[0-9a-f]{64}$'::text)"],
      ["capture_fingerprint", "CHECK (capture_fingerprint ~ '^[0-9a-f]{64}$'::text)"],
      ["capture_revision", "CHECK (capture_revision > 0)"],
      ["visible_thread_metadata", "CHECK (jsonb_typeof(visible_thread_metadata) = 'object'::text)"],
      ["visible_messages", "CHECK (jsonb_typeof(visible_messages) = 'array'::text)"],
      ["mapping_status", "CHECK (mapping_status = ANY (ARRAY['NEEDS_HUMAN_MAPPING'::text, 'RESOLVED'::text, 'CONFLICT'::text]))"],
      ["human_review_status", "CHECK (human_review_status = ANY (ARRAY['PENDING'::text, 'CONFIRMED'::text, 'REJECTED'::text]))"],
      ["provenance", "CHECK (jsonb_typeof(provenance) = 'object'::text)"],
      [["mapping_status", "resolved_contact_id"], "CHECK ((mapping_status = 'RESOLVED'::text) = (resolved_contact_id IS NOT NULL))"]
    ].map(([column_names, constraint_definition]) => ({
      ...base,
      contype: "c",
      column_names: Array.isArray(column_names) ? column_names : [column_names],
      constraint_definition
    }))
  ];
  return {
    async query(sql) {
      if (sql.includes("to_regclass")) return { rows: [{ relation_name: "tinder_visible_chat_captures" }] };
      if (sql.includes("SELECT c.relkind")) return { rows: [{ relkind: "r" }] };
      if (sql.includes("SELECT a.attname AS column_name")) return { rows: columns };
      if (sql.includes("FROM pg_constraint c")) return { rows: constraints };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

test("the static T2 guard accepts only the single plain CREATE TABLE source", () => {
  assert.doesNotThrow(() => assertTinderVisibleChatCaptureMigrationSource(migrationSql));
  for (const unsafeSource of [
    "CREATE TABLE tinder_visible_chat_captures (capture_id uuid); CREATE INDEX x ON tinder_visible_chat_captures (capture_id);",
    "CREATE TABLE tinder_visible_chat_captures (capture_id uuid); GRANT SELECT ON tinder_visible_chat_captures TO public;",
    "CREATE TABLE IF NOT EXISTS tinder_visible_chat_captures (capture_id uuid);",
    "CREATE TABLE tinder_visible_chat_captures (capture_id uuid); INSERT INTO contacts(id) VALUES (1);",
    "CREATE TABLE tinder_visible_chat_captures (capture_id uuid); /* unterminated"
  ]) {
    assert.throws(() => assertTinderVisibleChatCaptureMigrationSource(unsafeSource));
  }
});

test("a malformed migration source is classified before any database connection stage", () => {
  let error;
  try {
    validateTinderVisibleChatCaptureMigrationSource("CREATE TABLE tinder_visible_chat_captures (capture_id uuid); DROP TABLE contacts;");
    assert.fail("Expected source validation to reject multiple statements.");
  } catch (caught) {
    error = caught;
  }
  assert.deepEqual(getTinderVisibleChatCaptureMigrationFailureDiagnostic(error), {
    stage: "MIGRATION_SOURCE_VALIDATION",
    code: "MIGRATION_SOURCE_INVALID",
    transaction: "NOT_STARTED",
    rollback: "NOT_ATTEMPTED",
    ddl_started: false
  });
  assert.ok(T2_CAPTURE_MIGRATION_DIAGNOSTIC_STAGES.includes("MIGRATION_SOURCE_VALIDATION"));
});

test("capture schema inspection treats absent and partial tables as non-ready without repair", async () => {
  const absentCalls = [];
  const absent = {
    async query(sql) {
      absentCalls.push(sql);
      if (sql.includes("to_regclass")) return { rows: [{ relation_name: null }] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  assert.deepEqual(await inspectTinderVisibleChatCaptureSchema(absent), { state: "ABSENT" });
  await assert.rejects(() => assertTinderVisibleChatCaptureSchemaReady(absent), /not ready/);
  assert.equal(absentCalls.some(sql => /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(sql)), false);

  const partial = {
    async query(sql) {
      if (sql.includes("to_regclass")) return { rows: [{ relation_name: "tinder_visible_chat_captures" }] };
      if (sql.includes("SELECT c.relkind")) return { rows: [{ relkind: "r" }] };
      if (sql.includes("SELECT a.attname AS column_name")) return { rows: [] };
      if (sql.includes("FROM pg_constraint c")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  assert.deepEqual(await inspectTinderVisibleChatCaptureSchema(partial), { state: "INVALID" });
  await assert.rejects(() => assertTinderVisibleChatCaptureSchemaReady(partial), /not ready/);
});

test("capture schema accepts PostgreSQL's equivalent BETWEEN deparse", () => {
  const versionCheck = TINDER_VISIBLE_CHAT_CAPTURE_CONSTRAINT_CONTRACT.find((constraint) =>
    constraint.type === "c" && constraint.definitions.includes(
      canonicalCheckDefinition("char_length(capture_schema_version) BETWEEN 1 AND 80")
    )
  );
  assert.ok(versionCheck);
  assert.equal(
    versionCheck.definitions.includes(canonicalCheckDefinition(
      "(char_length(capture_schema_version) >= 1) AND (char_length(capture_schema_version) <= 80)"
    )),
    true
  );
});

test("capture schema accepts PostgreSQL CHECK conkeys and null non-FK reference metadata", async () => {
  assert.deepEqual(
    await inspectTinderVisibleChatCaptureSchema(realPostgresCatalogShapeClient()),
    { state: "CANONICAL" }
  );
});

test("T2 runner and rollback-only validation fail closed before capture DDL when global readiness blocks", async () => {
  for (const runner of [migrateTinderVisibleChatCaptureSchema, validateTinderVisibleChatCapturePreDdl]) {
    const fake = preflightFailurePool();
    await assert.rejects(() => runner(fake.pool), /injected preflight blocker/);
    assert.equal(fake.client.calls.includes("BEGIN"), true);
    assert.equal(fake.client.calls.includes("ROLLBACK"), true);
    assert.equal(ddlCalls(fake.client.calls).length, 0);
    assert.equal(fake.client.state.released, true);
    const error = await runner(fake.pool).catch(value => value);
    assert.deepEqual(getTinderVisibleChatCaptureMigrationFailureDiagnostic(error), {
      stage: "GLOBAL_PREFLIGHT",
      code: "DATABASE_OPERATION_FAILED",
      transaction: "STARTED",
      rollback: "COMPLETED",
      ddl_started: false
    });
  }
});

test("the migration remains explicit-only with no startup or public route path", () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const index = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const ingress = fs.readFileSync(new URL("../device-bridge/tinder-visible-chat-capture-ingress.js", import.meta.url), "utf8");
  const runner = fs.readFileSync(new URL("../device-bridge/tinder-visible-chat-capture-migration.js", import.meta.url), "utf8");
  const schema = fs.readFileSync(new URL("../device-bridge/tinder-visible-chat-capture-schema.js", import.meta.url), "utf8");
  const apiFiles = fs.readdirSync(new URL("../api", import.meta.url), { recursive: true })
    .filter(file => typeof file === "string" && file.endsWith(".js"));

  assert.equal(packageJson.scripts.start, "node index.js");
  assert.equal(packageJson.scripts["migrate:tinder-visible-chat-capture"], "node scripts/migrate-tinder-visible-chat-capture.js --apply");
  assert.equal(Object.hasOwn(packageJson.scripts, "prestart"), false);
  assert.equal(Object.hasOwn(packageJson.scripts, "poststart"), false);
  assert.equal(Object.hasOwn(packageJson.scripts, "predeploy"), false);
  assert.doesNotMatch(index, /tinder-visible-chat-capture-migration/);
  assert.doesNotMatch(ingress, /tinder-visible-chat-capture-migration/);
  assert.equal(apiFiles.includes("migrate-tinder-visible-chat-capture.js"), false);
  assert.doesNotMatch(runner, /process\.env\.DATABASE_URL|express\(|router\.|app\.(?:get|post|use)/);
  assert.match(runner, /validateTinderVisibleChatCaptureMigrationSource\(CAPTURE_MIGRATION_SQL\)[\s\S]*pool\.connect/);
  assert.match(runner, /export async function validateTinderVisibleChatCapturePreDdl/);
  assert.match(schema, /preflightDeviceBridgeAckSchemaForT1Migration/);
  assert.doesNotMatch(schema, /preflightDeviceBridgeAckSchemaForProtectedT1Preflight/);
});
