import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectTinderAutomationControlFoundationSchema,
  TINDER_AUTOMATION_CONTROL_FOUNDATION_CONSTRAINT_CONTRACT,
  TINDER_AUTOMATION_CONTROL_FOUNDATION_STATE
} from "../device-bridge/tinder-automation-control-foundation-schema.js";

const GLOBAL_COLUMNS = [
  ["control_id", "smallint", true, ""],
  ["state", "text", true, "'STOPPED'::text"],
  ["operation_state", "text", true, "'ACTIVE'::text"],
  ["explicit_approval", "boolean", true, "false"],
  ["policy_revision", "text", false, ""],
  ["control_revision", "integer", true, "1"],
  ["updated_by", "text", true, "'t7_foundation_migration'::text"],
  ["created_at", "timestamp with time zone", true, "now()"],
  ["updated_at", "timestamp with time zone", true, "now()"]
];

const CONTACT_COLUMNS = [
  ["contact_id", "integer", true, ""],
  ["state", "text", true, "'DISABLED'::text"],
  ["control_revision", "integer", true, "1"],
  ["updated_by", "text", true, "'t7_foundation_migration'::text"],
  ["created_at", "timestamp with time zone", true, "now()"],
  ["updated_at", "timestamp with time zone", true, "now()"]
];

const AUDIT_COLUMNS = [
  ["audit_id", "bigint", true, "nextval('tinder_automation_control_audit_audit_id_seq'::regclass)"],
  ["control_scope", "text", true, ""],
  ["contact_id", "integer", false, ""],
  ["action", "text", true, ""],
  ["actor", "text", true, ""],
  ["source", "text", true, ""],
  ["reason_code", "text", false, ""],
  ["details", "jsonb", true, "'{}'::jsonb"],
  ["created_at", "timestamp with time zone", true, "now()"]
];

function rowsForColumns(relation, fields) {
  return fields.map(([column_name, data_type, not_null, column_default]) => ({
    relation_name: relation, column_name, data_type, not_null, column_default
  }));
}

function catalogConstraints() {
  return TINDER_AUTOMATION_CONTROL_FOUNDATION_CONSTRAINT_CONTRACT.map(specification => ({
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

function canonicalIndexes() {
  return [
    ["idx_tinder_automation_contact_controls_state", false, ["state", "updated_at"], [false, true], ""],
    ["idx_tinder_automation_control_audit_scope_time", false, ["control_scope", "created_at"], [false, true], ""],
    ["idx_tinder_automation_control_audit_contact_time", false, ["contact_id", "created_at"], [false, true], "contact_id IS NOT NULL"]
  ].map(([index_name, indisunique, column_names, descending, predicate]) => ({
    index_name, indisunique, indisvalid: true, indisready: true, column_names, descending, predicate
  }));
}

function fixtureClient({ canonical = false, partial = false, globalRows } = {}) {
  const relations = [];
  const columns = [];
  let indexes = [];
  let constraints = [];
  if (canonical) {
    relations.push(
      { relation_name: "tinder_automation_global_control", relkind: "r" },
      { relation_name: "tinder_automation_contact_controls", relkind: "r" },
      { relation_name: "tinder_automation_control_audit", relkind: "r" }
    );
    columns.push(...rowsForColumns("tinder_automation_global_control", GLOBAL_COLUMNS));
    columns.push(...rowsForColumns("tinder_automation_contact_controls", CONTACT_COLUMNS));
    columns.push(...rowsForColumns("tinder_automation_control_audit", AUDIT_COLUMNS));
    indexes = canonicalIndexes();
    constraints = catalogConstraints();
  }
  if (partial) {
    relations.push({ relation_name: "tinder_automation_global_control", relkind: "r" });
    columns.push(...rowsForColumns("tinder_automation_global_control", [GLOBAL_COLUMNS[0]]));
  }
  const rows = globalRows || [{
    control_id: 1,
    state: "STOPPED",
    operation_state: "ACTIVE",
    explicit_approval: false,
    policy_revision: null
  }];
  return {
    async query(sql) {
      if (sql.includes("FROM tinder_automation_global_control")) return { rows };
      if (sql.includes("FROM pg_constraint c")) return { rows: constraints };
      if (sql.includes("FROM pg_index")) return { rows: indexes };
      if (sql.includes("JOIN pg_attribute")) return { rows: columns };
      if (sql.includes("FROM pg_class c") && sql.includes("c.relname = ANY($1)")) return { rows: relations };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

const draftReady = async () => ({ state: "CANONICAL" });

test("T7 control schema recognizes only an absent or complete canonical durable control foundation", async () => {
  assert.deepEqual(
    await inspectTinderAutomationControlFoundationSchema(fixtureClient(), { assertDraftReady: draftReady }),
    { state: TINDER_AUTOMATION_CONTROL_FOUNDATION_STATE.ABSENT }
  );
  assert.deepEqual(
    await inspectTinderAutomationControlFoundationSchema(fixtureClient({ canonical: true }), { assertDraftReady: draftReady }),
    { state: TINDER_AUTOMATION_CONTROL_FOUNDATION_STATE.CANONICAL }
  );
  assert.deepEqual(
    await inspectTinderAutomationControlFoundationSchema(fixtureClient({ partial: true }), { assertDraftReady: draftReady }),
    { state: TINDER_AUTOMATION_CONTROL_FOUNDATION_STATE.INVALID }
  );
});

test("T7 rejects a structurally complete foundation with no valid singleton global control", async () => {
  assert.deepEqual(
    await inspectTinderAutomationControlFoundationSchema(fixtureClient({ canonical: true, globalRows: [] }), { assertDraftReady: draftReady }),
    { state: TINDER_AUTOMATION_CONTROL_FOUNDATION_STATE.INVALID }
  );
  assert.deepEqual(
    await inspectTinderAutomationControlFoundationSchema(fixtureClient({
      canonical: true,
      globalRows: [{
        control_id: 1,
        state: "RUNNING",
        operation_state: "ACTIVE",
        explicit_approval: false,
        policy_revision: null
      }]
    }), { assertDraftReady: draftReady }),
    { state: TINDER_AUTOMATION_CONTROL_FOUNDATION_STATE.INVALID }
  );
});
