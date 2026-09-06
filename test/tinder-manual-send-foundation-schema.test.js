import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  inspectTinderManualSendFoundationSchema,
  TINDER_MANUAL_SEND_FOUNDATION_CONSTRAINT_CONTRACT,
  TINDER_MANUAL_SEND_FOUNDATION_STATE
} from "../device-bridge/tinder-manual-send-foundation-schema.js";
import {
  assertTinderManualSendFoundationMigrationSource
} from "../device-bridge/tinder-manual-send-foundation-migration.js";

const APPROVALS = [
  ["approval_id", "uuid", true], ["draft_id", "uuid", true], ["draft_revision", "integer", true],
  ["contact_id", "integer", true], ["capture_id", "uuid", true], ["capture_fingerprint", "character(64)", true],
  ["thread_ref_kind", "text", true], ["runtime_thread_fingerprint", "character(64)", true],
  ["capture_revision", "integer", true], ["identity_revision", "integer", true],
  ["approved_text_sha256", "character(64)", true], ["approval_binding_sha256", "character(64)", true],
  ["approved_by", "text", true], ["approved_at", "timestamp with time zone", true], ["state", "text", true],
  ["invalidated_reason", "text", false], ["invalidated_at", "timestamp with time zone", false],
  ["created_at", "timestamp with time zone", true]
];
const INTENTS = [
  ["intent_id", "uuid", true], ["approval_id", "uuid", true], ["draft_id", "uuid", true], ["draft_revision", "integer", true],
  ["contact_id", "integer", true], ["capture_id", "uuid", true], ["capture_fingerprint", "character(64)", true],
  ["thread_ref_kind", "text", true], ["runtime_thread_fingerprint", "character(64)", true], ["identity_revision", "integer", true],
  ["command_id", "uuid", true], ["command_type", "text", true], ["protocol_version", "integer", true],
  ["approved_text_sha256", "character(64)", true], ["approval_binding_sha256", "character(64)", true],
  ["delivery_policy_revision", "text", true], ["not_before", "timestamp with time zone", true], ["expires_at", "timestamp with time zone", true],
  ["typing_duration_ms", "integer", true], ["state", "text", true], ["received_at", "timestamp with time zone", false],
  ["completed_at", "timestamp with time zone", false], ["result_code", "text", false],
  ["created_at", "timestamp with time zone", true], ["updated_at", "timestamp with time zone", true]
];
const AUDIT = [
  ["send_audit_id", "bigint", true], ["action", "text", true], ["actor", "text", true], ["source", "text", true],
  ["draft_id", "uuid", true], ["approval_id", "uuid", false], ["intent_id", "uuid", false],
  ["reason_code", "text", false], ["details", "jsonb", true], ["created_at", "timestamp with time zone", true]
];

const APPROVAL_DEFAULTS = {
  state: "'ACTIVE'::text",
  created_at: "CURRENT_TIMESTAMP"
};
const INTENT_DEFAULTS = {
  state: "('PENDING_T5_WRITER'::text)"
};
const AUDIT_DEFAULTS = {
  send_audit_id: "nextval('tinder_reply_send_audit_send_audit_id_seq'::regclass)",
  source: "'tinder_manual_send'::text",
  details: "('{}'::jsonb)",
  created_at: "now()"
};

function asRows(relation, fields, defaults = {}) {
  return fields.map(([column_name, data_type, not_null]) => ({
    relation_name: relation, column_name, data_type, not_null, column_default: defaults[column_name] || ""
  }));
}

function canonicalIndexes() {
  return [
    ["idx_tinder_reply_send_approvals_active_draft", ["draft_id", "draft_revision"], [false, false], "state = 'ACTIVE'"],
    ["idx_tinder_reply_send_intents_pending", ["state", "not_before", "expires_at"], [false, false, false], "state IN ('PENDING_T5_WRITER', 'DISPATCHING')"],
    ["idx_tinder_reply_send_audit_draft_time", ["draft_id", "created_at"], [false, true], ""]
  ].map(([index_name, column_names, descending, predicate]) => ({
    index_name, indisunique: false, indisvalid: true, indisready: true, column_names, descending, predicate
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

function fixtureClient({ canonical = false, partial = false } = {}) {
  const relations = [{ relation_name: "tinder_reply_drafts", relkind: "r" }];
  const columns = [];
  let indexes = [];
  let constraints = [];
  if (canonical) {
    relations.push({ relation_name: "tinder_reply_send_approvals", relkind: "r" });
    relations.push({ relation_name: "tinder_reply_send_intents", relkind: "r" });
    relations.push({ relation_name: "tinder_reply_send_audit", relkind: "r" });
    columns.push(...asRows("tinder_reply_drafts", [["draft_revision", "integer", true]], { draft_revision: "1" }));
    columns.push(...asRows("tinder_reply_send_approvals", APPROVALS, APPROVAL_DEFAULTS));
    columns.push(...asRows("tinder_reply_send_intents", INTENTS, INTENT_DEFAULTS));
    columns.push(...asRows("tinder_reply_send_audit", AUDIT, AUDIT_DEFAULTS));
    indexes = canonicalIndexes();
    constraints = catalogConstraints(TINDER_MANUAL_SEND_FOUNDATION_CONSTRAINT_CONTRACT);
  }
  if (partial) columns.push(...asRows("tinder_reply_drafts", [["draft_revision", "integer", true]], { draft_revision: "1" }));
  return {
    async query(sql) {
      if (sql.includes("FROM pg_constraint c")) return { rows: constraints };
      if (sql.includes("FROM pg_index")) return { rows: indexes };
      if (sql.includes("JOIN pg_attribute")) return { rows: columns };
      if (sql.includes("FROM pg_class c") && sql.includes("c.relname = ANY($1)")) return { rows: relations };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

const draftReady = async () => ({ state: "CANONICAL" });

test("T5 recognizes only a complete sealed outbox or an untouched T4 state", async () => {
  assert.deepEqual(
    await inspectTinderManualSendFoundationSchema(fixtureClient(), { assertDraftReady: draftReady }),
    { state: TINDER_MANUAL_SEND_FOUNDATION_STATE.ABSENT }
  );
  assert.deepEqual(
    await inspectTinderManualSendFoundationSchema(fixtureClient({ canonical: true }), { assertDraftReady: draftReady }),
    { state: TINDER_MANUAL_SEND_FOUNDATION_STATE.CANONICAL }
  );
  assert.deepEqual(
    await inspectTinderManualSendFoundationSchema(fixtureClient({ partial: true }), { assertDraftReady: draftReady }),
    { state: TINDER_MANUAL_SEND_FOUNDATION_STATE.INVALID }
  );
});

test("T5 rejects a column-complete outbox that lacks its sealed intent constraints", async () => {
  const client = fixtureClient({ canonical: true });
  const original = client.query.bind(client);
  client.query = async sql => {
    const result = await original(sql);
    if (sql.includes("FROM pg_constraint c")) {
      return { rows: result.rows.filter(row => !(row.table_name === "tinder_reply_send_intents" && row.contype === "u" && row.column_names[0] === "command_id")) };
    }
    return result;
  };
  assert.deepEqual(
    await inspectTinderManualSendFoundationSchema(client, { assertDraftReady: draftReady }),
    { state: TINDER_MANUAL_SEND_FOUNDATION_STATE.INVALID }
  );
});

test("T5 rejects canonical-looking sealed tables when default state or audit defaults drift", async () => {
  const drifts = [
    ["tinder_reply_send_intents", "state", "'DISPATCHING'::text"],
    ["tinder_reply_drafts", "draft_revision", "2"],
    ["tinder_reply_send_audit", "details", "'[]'::jsonb"]
  ];
  for (const [relation, column, columnDefault] of drifts) {
    const client = fixtureClient({ canonical: true });
    const original = client.query.bind(client);
    client.query = async sql => {
      const result = await original(sql);
      if (sql.includes("JOIN pg_attribute")) {
        return {
          rows: result.rows.map(row => row.relation_name === relation && row.column_name === column
            ? { ...row, column_default: columnDefault }
            : row)
        };
      }
      return result;
    };
    assert.deepEqual(
      await inspectTinderManualSendFoundationSchema(client, { assertDraftReady: draftReady }),
      { state: TINDER_MANUAL_SEND_FOUNDATION_STATE.INVALID }
    );
  }
});

test("T5 source remains fixed and transaction-free before its reviewed runner owns it", () => {
  const source = readFileSync(new URL("../migrations/20260905_tinder_manual_send_foundation.sql", import.meta.url), "utf8");
  assert.doesNotThrow(() => assertTinderManualSendFoundationMigrationSource(source));
  assert.throws(() => assertTinderManualSendFoundationMigrationSource(`${source}\nROLLBACK;`));
});
