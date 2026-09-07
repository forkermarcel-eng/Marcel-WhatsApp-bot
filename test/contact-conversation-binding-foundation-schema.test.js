import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CONTACT_CONVERSATION_BINDING_CONSTRAINT_CONTRACT,
  CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE,
  inspectContactConversationBindingFoundationSchema
} from "../device-bridge/contact-conversation-binding-foundation-schema.js";
import {
  assertContactConversationBindingFoundationMigrationSource
} from "../device-bridge/contact-conversation-binding-foundation-migration.js";

const BINDING = [
  ["binding_id", "uuid", true], ["channel", "text", true], ["reference_kind", "text", true],
  ["reference_hash", "character(64)", true], ["device_id", "uuid", false], ["contact_id", "integer", true],
  ["source_capture_id", "uuid", false], ["binding_state", "text", true], ["binding_revision", "integer", true],
  ["human_verified", "boolean", true], ["verification_source", "text", true], ["verified_by", "text", true],
  ["verified_at", "timestamp with time zone", true], ["revoked_by", "text", false], ["revoked_at", "timestamp with time zone", false],
  ["revocation_reason", "text", false], ["created_at", "timestamp with time zone", true], ["updated_at", "timestamp with time zone", true]
];
const AUDIT = [
  ["audit_id", "bigint", true], ["binding_id", "uuid", true], ["capture_id", "uuid", false], ["action", "text", true],
  ["actor", "text", true], ["source", "text", true], ["old_contact_id", "integer", false], ["new_contact_id", "integer", false],
  ["old_binding_revision", "integer", false], ["new_binding_revision", "integer", false], ["reason_code", "text", false],
  ["details", "jsonb", true], ["created_at", "timestamp with time zone", true]
];

const BINDING_DEFAULTS = {
  binding_state: "'CONFIRMED'::text", binding_revision: "1", human_verified: "true",
  verification_source: "'manual_dashboard'::text", verified_at: "CURRENT_TIMESTAMP",
  created_at: "now()", updated_at: "CURRENT_TIMESTAMP"
};
const AUDIT_DEFAULTS = {
  audit_id: "nextval('contact_conversation_binding_audit_audit_id_seq'::regclass)",
  source: "'manual_dashboard'::text", details: "('{}'::jsonb)", created_at: "now()"
};

function columns(relation, contract, defaults = {}) {
  return contract.map(([column_name, data_type, not_null]) => ({
    relation_name: relation, column_name, data_type, not_null,
    column_default: defaults[column_name] || ""
  }));
}

function indexes() {
  return [
    ["idx_contact_conversation_binding_active_device_ref", true, ["channel", "reference_kind", "device_id", "reference_hash"], [false, false, false, false], "binding_state = 'CONFIRMED' AND device_id IS NOT NULL"],
    ["idx_contact_conversation_binding_active_unscoped_ref", true, ["channel", "reference_kind", "reference_hash"], [false, false, false], "binding_state = 'CONFIRMED' AND device_id IS NULL"],
    ["idx_contact_conversation_binding_contact_state", false, ["contact_id", "binding_state", "updated_at"], [false, false, true], ""],
    ["idx_contact_conversation_binding_source_capture", false, ["source_capture_id"], [false], "source_capture_id IS NOT NULL"],
    ["idx_contact_conversation_binding_audit_binding_time", false, ["binding_id", "created_at"], [false, true], ""],
    ["idx_contact_conversation_binding_audit_capture_time", false, ["capture_id", "created_at"], [false, true], "capture_id IS NOT NULL"]
  ].map(([index_name, indisunique, column_names, descending, predicate]) => ({
    index_name, indisunique, indisvalid: true, indisready: true, column_names, descending, predicate
  }));
}

function constraints() {
  return CONTACT_CONVERSATION_BINDING_CONSTRAINT_CONTRACT.map(spec => ({
    table_name: spec.table,
    contype: spec.type,
    convalidated: true,
    condeferrable: false,
    condeferred: false,
    confdeltype: spec.deleteAction || " ",
    confupdtype: spec.updateAction || " ",
    confmatchtype: spec.matchType || " ",
    reference_table: spec.referenceTable || null,
    reference_column_names: spec.referenceColumns || [],
    column_names: spec.type === "c" ? [] : spec.columns,
    constraint_definition: spec.type === "c" ? `CHECK (${spec.sources[0]})` : spec.definition
  }));
}

function fixtureClient({ canonical = false, partial = false } = {}) {
  const relations = canonical ? [
    { relation_name: "contact_conversation_bindings", relkind: "r" },
    { relation_name: "contact_conversation_binding_audit", relkind: "r" }
  ] : [];
  const actualColumns = canonical ? [
    ...columns("contact_conversation_bindings", BINDING, BINDING_DEFAULTS),
    ...columns("contact_conversation_binding_audit", AUDIT, AUDIT_DEFAULTS)
  ] : [];
  if (partial) actualColumns.push(...columns("contact_conversation_bindings", [BINDING[0]]));
  const actualIndexes = canonical ? indexes() : [];
  const actualConstraints = canonical ? constraints() : [];
  return {
    async query(sql) {
      if (sql.includes("FROM pg_constraint c")) return { rows: actualConstraints };
      if (sql.includes("FROM pg_index")) return { rows: actualIndexes };
      if (sql.includes("JOIN pg_attribute")) return { rows: actualColumns };
      if (sql.includes("FROM pg_class c") && sql.includes("c.relname = ANY($1)")) return { rows: relations };
      throw new Error(`Unexpected catalog query: ${sql}`);
    }
  };
}

const identityReady = async () => ({ state: "CANONICAL" });

test("conversation-binding foundation recognizes only complete canonical or untouched state", async () => {
  assert.deepEqual(
    await inspectContactConversationBindingFoundationSchema(fixtureClient(), { assertIdentityReady: identityReady }),
    { state: CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE.ABSENT }
  );
  assert.deepEqual(
    await inspectContactConversationBindingFoundationSchema(fixtureClient({ canonical: true }), { assertIdentityReady: identityReady }),
    { state: CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE.CANONICAL }
  );
  assert.deepEqual(
    await inspectContactConversationBindingFoundationSchema(fixtureClient({ partial: true }), { assertIdentityReady: identityReady }),
    { state: CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE.INVALID }
  );
});

test("conversation-binding contract rejects weakened active-owner uniqueness and opaque-audit protections", async () => {
  const client = fixtureClient({ canonical: true });
  const original = client.query.bind(client);
  client.query = async sql => {
    const result = await original(sql);
    if (sql.includes("FROM pg_index")) {
      return { rows: result.rows.filter(row => row.index_name !== "idx_contact_conversation_binding_active_device_ref") };
    }
    return result;
  };
  assert.deepEqual(
    await inspectContactConversationBindingFoundationSchema(client, { assertIdentityReady: identityReady }),
    { state: CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE.INVALID }
  );

  const auditLeak = fixtureClient({ canonical: true });
  const originalAudit = auditLeak.query.bind(auditLeak);
  auditLeak.query = async sql => {
    const result = await originalAudit(sql);
    if (sql.includes("FROM pg_constraint c")) {
      return { rows: result.rows.filter(row => !String(row.constraint_definition).includes("reference_hash")) };
    }
    return result;
  };
  assert.deepEqual(
    await inspectContactConversationBindingFoundationSchema(auditLeak, { assertIdentityReady: identityReady }),
    { state: CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE.INVALID }
  );
});

test("conversation-binding accepts PostgreSQL's fixed unary-NOT audit-check deparse only", async () => {
  const postgresqlDeparse = "CHECK (NOT details ?| ARRAY['reference_hash'::text, 'reference_token'::text, 'raw_unique_id'::text, 'visible_name'::text, 'message_text'::text, 'capture_fingerprint'::text, 'runtime_thread_fingerprint'::text])";
  const client = fixtureClient({ canonical: true });
  const original = client.query.bind(client);
  client.query = async sql => {
    const result = await original(sql);
    if (sql.includes("FROM pg_constraint c")) {
      return {
        rows: result.rows.map(row => row.table_name === "contact_conversation_binding_audit"
          && row.contype === "c"
          && row.constraint_definition.includes("reference_hash")
          ? { ...row, constraint_definition: postgresqlDeparse }
          : row)
      };
    }
    return result;
  };
  assert.deepEqual(
    await inspectContactConversationBindingFoundationSchema(client, { assertIdentityReady: identityReady }),
    { state: CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE.CANONICAL }
  );

  const weakened = fixtureClient({ canonical: true });
  const originalWeakened = weakened.query.bind(weakened);
  weakened.query = async sql => {
    const result = await originalWeakened(sql);
    if (sql.includes("FROM pg_constraint c")) {
      return {
        rows: result.rows.map(row => row.table_name === "contact_conversation_binding_audit"
          && row.contype === "c"
          && row.constraint_definition.includes("reference_hash")
          ? { ...row, constraint_definition: postgresqlDeparse.replace("'visible_name'", "'unreviewed_key'") }
          : row)
      };
    }
    return result;
  };
  assert.deepEqual(
    await inspectContactConversationBindingFoundationSchema(weakened, { assertIdentityReady: identityReady }),
    { state: CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE.INVALID }
  );
});

test("fixed source is explicit-only, channel-neutral and rejects appended DDL", () => {
  const source = readFileSync(
    new URL("../migrations/20260907_contact_conversation_binding_foundation.sql", import.meta.url),
    "utf8"
  );
  assert.doesNotThrow(() => assertContactConversationBindingFoundationMigrationSource(source));
  assert.throws(() => assertContactConversationBindingFoundationMigrationSource(
    `${source}\nCREATE TABLE unreviewed_binding_leak (id integer);`
  ));
  assert.match(source, /channel IN \('tinder', 'whatsapp'\)/);
  assert.match(source, /tinder_accessibility_header_unique_id_hmac_v1/);
  assert.match(source, /whatsapp_conversation_ref_hmac_v1/);
  assert.match(source, /raw_unique_id/);
  assert.doesNotMatch(source, /INSERT\s+INTO\s+messages/i);
  assert.doesNotMatch(source, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
});
