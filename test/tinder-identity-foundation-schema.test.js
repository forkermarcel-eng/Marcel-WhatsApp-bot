import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectTinderIdentityFoundationSchema,
  TINDER_IDENTITY_FOUNDATION_CONSTRAINT_CONTRACT,
  TINDER_IDENTITY_FOUNDATION_STATE
} from "../device-bridge/tinder-identity-foundation-schema.js";
import {
  TINDER_VISIBLE_CHAT_CAPTURE_COLUMN_CONTRACT,
  TINDER_VISIBLE_CHAT_CAPTURE_CONSTRAINT_CONTRACT
} from "../device-bridge/tinder-visible-chat-capture-schema.js";

function t2CatalogColumns() {
  return Object.entries(TINDER_VISIBLE_CHAT_CAPTURE_COLUMN_CONTRACT).map(([column_name, contract]) => ({
    column_name,
    data_type: contract.dataType,
    not_null: contract.notNull,
    column_default: contract.defaultExpression,
    identity_kind: "",
    generated_kind: ""
  }));
}

function t2CatalogConstraints() {
  return TINDER_VISIBLE_CHAT_CAPTURE_CONSTRAINT_CONTRACT.map(specification => ({
    contype: specification.type,
    convalidated: true,
    condeferrable: false,
    condeferred: false,
    confdeltype: specification.deleteAction || " ",
    confupdtype: specification.updateAction || " ",
    confmatchtype: specification.matchType || " ",
    reference_table: specification.referenceTable || null,
    reference_column_names: specification.referenceColumns || [],
    column_names: specification.type === "c" ? [] : specification.columns,
    constraint_definition: specification.type === "c"
      ? `CHECK (${specification.definitions[0]})`
      : specification.definition
  }));
}

function baseColumns({ canonical = false, partial = false } = {}) {
  const columns = [
    ["contacts", "id", "integer", "NO"],
    ["contacts", "whatsapp_jid", "text", canonical ? "YES" : "NO"],
    ["contact_identifiers", "id", "bigint", "NO"],
    ["contact_identifiers", "contact_id", "integer", "NO"],
    ["contact_identifiers", "identifier_type", "text", "NO"],
    ["contact_identifiers", "identifier_value", "text", "NO"],
    ["contact_identifiers", "normalized_value", "text", "NO"],
    ["contact_identifiers", "source_platform", "text", "YES"],
    ["contact_identifiers", "is_primary", "boolean", "YES"],
    ["contact_identifiers", "human_verified", "boolean", "YES"],
    ["contact_identifiers", "created_at", "timestamp with time zone", "YES"],
    ["contact_identifiers", "updated_at", "timestamp with time zone", "YES"]
  ];
  if (canonical || partial) columns.push(["contact_identifiers", "verification_source", "text", "YES"]);
  if (canonical) {
    columns.push(["contact_identifiers", "verified_by", "text", "YES"]);
    columns.push(["contact_identifiers", "verified_at", "timestamp with time zone", "YES"]);
    for (const [name, type, nullable] of [
      ["mapping_audit_id", "bigint", "NO"], ["capture_id", "uuid", "NO"], ["action", "text", "NO"],
      ["actor", "text", "NO"], ["source", "text", "NO"], ["request_reference", "text", "YES"],
      ["old_mapping_status", "text", "YES"], ["new_mapping_status", "text", "YES"],
      ["old_contact_id", "integer", "YES"], ["new_contact_id", "integer", "YES"],
      ["identifier_id", "bigint", "YES"], ["details", "jsonb", "NO"], ["created_at", "timestamp with time zone", "NO"]
    ]) columns.push(["tinder_identity_mapping_audit", name, type, nullable]);
  }
  const defaults = {
    "tinder_identity_mapping_audit.mapping_audit_id": "nextval('tinder_identity_mapping_audit_mapping_audit_id_seq'::regclass)",
    "tinder_identity_mapping_audit.source": "('manual_dashboard'::text)",
    "tinder_identity_mapping_audit.details": "'{}'::jsonb",
    // CURRENT_TIMESTAMP is semantically the canonical NOW() default.
    "tinder_identity_mapping_audit.created_at": "CURRENT_TIMESTAMP"
  };
  return columns.map(([table_name, column_name, data_type, is_nullable]) => ({
    table_name,
    column_name,
    data_type,
    is_nullable,
    column_default: defaults[`${table_name}.${column_name}`] || ""
  }));
}

function canonicalIndexes() {
  return [
    ["idx_contact_identifiers_tinder_confirmed_unique", true, ["identifier_type", "normalized_value"], [false, false], "(identifier_type = 'tinder_profile'::text) AND (human_verified = true)"],
    ["idx_tinder_visible_chat_captures_mapping_time", false, ["mapping_status", "received_at"], [false, true], ""],
    ["idx_tinder_visible_chat_captures_contact_time", false, ["resolved_contact_id", "received_at"], [false, true], "resolved_contact_id IS NOT NULL"],
    ["idx_tinder_identity_mapping_audit_capture_time", false, ["capture_id", "created_at"], [false, true], ""]
  ].map(([index_name, indisunique, column_names, descending, predicate]) => ({
    index_name, indisunique, indisvalid: true, indisready: true, column_names, descending, predicate
  }));
}

function catalogConstraints(contract) {
  return contract.map(specification => ({
    table_name: specification.table,
    contype: specification.type,
    convalidated: true,
    condeferrable: false,
    condeferred: false,
    confdeltype: specification.deleteAction || " ",
    confupdtype: specification.updateAction || " ",
    confmatchtype: specification.matchType || " ",
    reference_table: specification.referenceTable || null,
    reference_column_names: specification.referenceColumns || [],
    column_names: specification.type === "c" ? [] : specification.columns,
    constraint_definition: specification.type === "c"
      ? `CHECK (${specification.sources[0]})`
      : specification.definition
  }));
}

function fixtureClient(options = {}) {
  return {
    async query(sql) {
      if (sql.includes("to_regclass")) return { rows: [{ relation_name: "tinder_visible_chat_captures" }] };
      if (sql.includes("SELECT c.relkind") && sql.includes("c.relname = $1")) return { rows: [{ relkind: "r" }] };
      if (sql.includes("SELECT a.attname AS column_name")) return { rows: t2CatalogColumns() };
      if (sql.includes("rel.relname = ANY($1)")) {
        return { rows: options.canonical ? catalogConstraints(TINDER_IDENTITY_FOUNDATION_CONSTRAINT_CONTRACT) : [] };
      }
      if (sql.includes("FROM pg_constraint c")) return { rows: t2CatalogConstraints() };
      if (sql.includes("FROM information_schema.columns")) return { rows: baseColumns(options) };
      if (sql.includes("c.relname = 'tinder_identity_mapping_audit'")) {
        return { rows: options.canonical ? [{ relkind: "r" }] : [] };
      }
      if (sql.includes("FROM pg_index i")) return { rows: options.canonical ? canonicalIndexes() : [] };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

test("T3 schema inspection recognizes the untouched T2-compatible prerequisite state", async () => {
  assert.deepEqual(
    await inspectTinderIdentityFoundationSchema(fixtureClient()),
    { state: TINDER_IDENTITY_FOUNDATION_STATE.ABSENT }
  );
});

test("T3 schema inspection requires every additive postcondition before declaring canonical", async () => {
  assert.deepEqual(
    await inspectTinderIdentityFoundationSchema(fixtureClient({ canonical: true })),
    { state: TINDER_IDENTITY_FOUNDATION_STATE.CANONICAL }
  );
  assert.deepEqual(
    await inspectTinderIdentityFoundationSchema(fixtureClient({ partial: true })),
    { state: TINDER_IDENTITY_FOUNDATION_STATE.INVALID }
  );
});

test("T3 rejects an audit table whose visible columns omit a required FK/CHECK contract", async () => {
  const client = fixtureClient({ canonical: true });
  const original = client.query.bind(client);
  client.query = async sql => {
    const result = await original(sql);
    if (sql.includes("rel.relname = ANY($1)")) {
      return { rows: result.rows.filter(row => !(row.table_name === "tinder_identity_mapping_audit" && row.contype === "f" && row.column_names[0] === "capture_id")) };
    }
    return result;
  };
  assert.deepEqual(
    await inspectTinderIdentityFoundationSchema(client),
    { state: TINDER_IDENTITY_FOUNDATION_STATE.INVALID }
  );
});

test("T3 rejects a column-complete audit table when a contract-relevant default drifts", async () => {
  const drifts = [
    ["details", "'[]'::jsonb"],
    ["created_at", "clock_timestamp()"],
    ["mapping_audit_id", ""],
    ["source", "'automatic'::text"]
  ];
  for (const [column, columnDefault] of drifts) {
    const client = fixtureClient({ canonical: true });
    const original = client.query.bind(client);
    client.query = async sql => {
      const result = await original(sql);
      if (sql.includes("FROM information_schema.columns")) {
        return {
          rows: result.rows.map(row => row.table_name === "tinder_identity_mapping_audit" && row.column_name === column
            ? { ...row, column_default: columnDefault }
            : row)
        };
      }
      return result;
    };
    assert.deepEqual(
      await inspectTinderIdentityFoundationSchema(client),
      { state: TINDER_IDENTITY_FOUNDATION_STATE.INVALID }
    );
  }
});
