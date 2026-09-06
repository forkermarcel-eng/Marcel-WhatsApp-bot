import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertTinderDraftFoundationBaseSchemaReady,
  inspectTinderDraftFoundationSchema,
  TINDER_DRAFT_FOUNDATION_CONSTRAINT_CONTRACT,
  TINDER_DRAFT_FOUNDATION_STATE
} from "../device-bridge/tinder-draft-foundation-schema.js";
import {
  assertTinderDraftFoundationMigrationSource
} from "../device-bridge/tinder-draft-foundation-migration.js";

const CAPTURE_COLUMNS = [
  ["identity_revision", "integer", true, "1"],
  ["human_takeover_active", "boolean", true, "false"],
  ["handoff_active", "boolean", true, "false"]
];

const DRAFT_COLUMNS = [
  ["draft_id", "uuid", true], ["channel", "text", true, "('tinder'::text)"], ["status", "text", true, "'DRAFT'::text"],
  ["contact_id", "integer", true], ["capture_id", "uuid", true],
  ["runtime_thread_fingerprint", "character(64)", true], ["capture_revision", "integer", true],
  ["identity_revision", "integer", true], ["original_draft", "text", true],
  ["control_draft_de", "text", false], ["source_language", "text", false],
  ["model_version", "text", true], ["stale_reason", "text", false],
  ["created_at", "timestamp with time zone", true], ["updated_at", "timestamp with time zone", true]
];

const AUDIT_COLUMNS = [
  ["draft_audit_id", "bigint", true, "nextval('tinder_reply_draft_audit_draft_audit_id_seq'::regclass)"], ["draft_id", "uuid", true], ["capture_id", "uuid", true],
  ["action", "text", true], ["actor", "text", true], ["source", "text", true, "'tinder_draft_foundation'::text"],
  ["previous_status", "text", false], ["new_status", "text", true], ["reason", "text", false],
  ["details", "jsonb", true, "('{}'::jsonb)"], ["created_at", "timestamp with time zone", true, "CURRENT_TIMESTAMP"]
];

function schemaColumns(relation, contract) {
  return contract.map(([column_name, data_type, not_null, column_default = ""]) => ({
    relation_name: relation,
    column_name,
    data_type,
    not_null,
    column_default
  }));
}

function canonicalIndexes() {
  return [
    ["idx_tinder_reply_drafts_contact_status_time", false, ["contact_id", "status", "created_at"], [false, false, true]],
    ["idx_tinder_reply_drafts_thread_revision", false, ["runtime_thread_fingerprint", "capture_revision"], [false, true]],
    ["idx_tinder_reply_draft_audit_draft_time", false, ["draft_id", "created_at"], [false, true]]
  ].map(([index_name, indisunique, column_names, descending]) => ({
    index_name, indisunique, indisvalid: true, indisready: true, column_names, descending, predicate: ""
  }));
}

function canonicalTrigger() {
  return [{
    relation_name: "tinder_visible_chat_captures",
    trigger_name: "t4_tinder_capture_identity_revision",
    function_name: "t4_bump_tinder_capture_identity_revision",
    function_schema: "public",
    trigger_definition: "CREATE TRIGGER t4_tinder_capture_identity_revision BEFORE UPDATE OF mapping_status, human_review_status, resolved_contact_id ON public.tinder_visible_chat_captures FOR EACH ROW EXECUTE FUNCTION t4_bump_tinder_capture_identity_revision()",
    function_definition: "CREATE OR REPLACE FUNCTION t4_bump_tinder_capture_identity_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.mapping_status IS DISTINCT FROM NEW.mapping_status OR OLD.human_review_status IS DISTINCT FROM NEW.human_review_status OR OLD.resolved_contact_id IS DISTINCT FROM NEW.resolved_contact_id THEN NEW.identity_revision := OLD.identity_revision + 1; END IF; RETURN NEW; END; $$"
  }];
}

function canonicalFunction() {
  return [{
    function_name: "t4_bump_tinder_capture_identity_revision",
    argument_signature: "",
    return_type: "trigger",
    function_definition: canonicalTrigger()[0].function_definition
  }];
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

function fixtureClient({
  canonical = false,
  partial = false,
  additiveT5DraftRevision = false,
  incompatibleBaseColumn = false
} = {}) {
  const relations = [{ relation_name: "tinder_visible_chat_captures", relkind: "r" }];
  const columns = [];
  let indexes = [];
  let trigger = [];
  let identityFunction = [];
  let constraints = [];
  if (canonical) {
    relations.push({ relation_name: "tinder_reply_drafts", relkind: "r" });
    relations.push({ relation_name: "tinder_reply_draft_audit", relkind: "r" });
    columns.push(...schemaColumns("tinder_visible_chat_captures", CAPTURE_COLUMNS));
    columns.push(...schemaColumns("tinder_reply_drafts", DRAFT_COLUMNS));
    columns.push(...schemaColumns("tinder_reply_draft_audit", AUDIT_COLUMNS));
    indexes = canonicalIndexes();
    trigger = canonicalTrigger();
    identityFunction = canonicalFunction();
    constraints = catalogConstraints(TINDER_DRAFT_FOUNDATION_CONSTRAINT_CONTRACT);
  }
  if (additiveT5DraftRevision) {
    columns.push(...schemaColumns("tinder_reply_drafts", [["draft_revision", "integer", true, "1"]]));
    constraints.push({
      table_name: "tinder_reply_drafts",
      contype: "c",
      convalidated: true,
      condeferrable: false,
      condeferred: false,
      confdeltype: " ",
      confupdtype: " ",
      confmatchtype: " ",
      reference_table: null,
      reference_column_names: [],
      column_names: ["draft_revision"],
      constraint_definition: "CHECK (draft_revision > 0)"
    });
  }
  if (incompatibleBaseColumn) {
    columns.find(row => row.relation_name === "tinder_reply_drafts" && row.column_name === "status")
      .column_default = "'APPROVED'";
  }
  if (partial) {
    columns.push(...schemaColumns("tinder_visible_chat_captures", [CAPTURE_COLUMNS[0]]));
  }
  return {
    async query(sql) {
      if (sql.includes("FROM pg_constraint c")) return { rows: constraints };
      if (sql.includes("FROM pg_index")) return { rows: indexes };
      if (sql.includes("FROM pg_trigger")) return { rows: trigger };
      if (sql.includes("FROM pg_proc procedure")) return { rows: identityFunction };
      if (sql.includes("JOIN pg_attribute")) return { rows: columns };
      if (sql.includes("FROM pg_class c") && sql.includes("c.relname = ANY($1)")) return { rows: relations };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

const identityReady = async () => ({ state: "CANONICAL" });

test("T4 schema inspection accepts only a wholly absent or wholly canonical additive state", async () => {
  assert.deepEqual(
    await inspectTinderDraftFoundationSchema(fixtureClient(), { assertIdentityReady: identityReady }),
    { state: TINDER_DRAFT_FOUNDATION_STATE.ABSENT }
  );
  assert.deepEqual(
    await inspectTinderDraftFoundationSchema(fixtureClient({ canonical: true }), { assertIdentityReady: identityReady }),
    { state: TINDER_DRAFT_FOUNDATION_STATE.CANONICAL }
  );
  assert.deepEqual(
    await inspectTinderDraftFoundationSchema(fixtureClient({ partial: true }), { assertIdentityReady: identityReady }),
    { state: TINDER_DRAFT_FOUNDATION_STATE.INVALID }
  );
});

test("later foundations accept the reviewed T5 draft extension without weakening the strict T4 migration contract", async () => {
  const t5Extended = fixtureClient({ canonical: true, additiveT5DraftRevision: true });
  assert.deepEqual(
    await inspectTinderDraftFoundationSchema(t5Extended, { assertIdentityReady: identityReady }),
    { state: TINDER_DRAFT_FOUNDATION_STATE.INVALID }
  );
  assert.deepEqual(
    await assertTinderDraftFoundationBaseSchemaReady(t5Extended, { assertIdentityReady: identityReady }),
    { state: "BASE_COMPATIBLE" }
  );

  const incompatibleBase = fixtureClient({
    canonical: true,
    additiveT5DraftRevision: true,
    incompatibleBaseColumn: true
  });
  await assert.rejects(
    () => assertTinderDraftFoundationBaseSchemaReady(incompatibleBase, { assertIdentityReady: identityReady }),
    /base schema is not ready/
  );
});

test("T4 accepts PostgreSQL's equivalent current-schema-elided trigger deparse without weakening trigger structure", async () => {
  const client = fixtureClient({ canonical: true });
  const original = client.query.bind(client);
  client.query = async sql => {
    const result = await original(sql);
    if (sql.includes("FROM pg_trigger")) {
      return {
        rows: result.rows.map(row => ({
          ...row,
          trigger_definition: row.trigger_definition.replace("ON public.tinder_visible_chat_captures", "ON tinder_visible_chat_captures")
        }))
      };
    }
    return result;
  };
  assert.deepEqual(
    await inspectTinderDraftFoundationSchema(client, { assertIdentityReady: identityReady }),
    { state: TINDER_DRAFT_FOUNDATION_STATE.CANONICAL }
  );

  const wrongUpdateSet = fixtureClient({ canonical: true });
  const wrongOriginal = wrongUpdateSet.query.bind(wrongUpdateSet);
  wrongUpdateSet.query = async sql => {
    const result = await wrongOriginal(sql);
    if (sql.includes("FROM pg_trigger")) {
      return {
        rows: result.rows.map(row => ({
          ...row,
          trigger_definition: row.trigger_definition.replace("human_review_status", "unexpected_column")
        }))
      };
    }
    return result;
  };
  assert.deepEqual(
    await inspectTinderDraftFoundationSchema(wrongUpdateSet, { assertIdentityReady: identityReady }),
    { state: TINDER_DRAFT_FOUNDATION_STATE.INVALID }
  );
});

test("T4 accepts only the fixed PostgreSQL deparse equivalence for its German control-draft gate", async () => {
  const postgresqlDeparse = "CHECK (control_draft_de IS NULL OR COALESCE((lower(source_language) = ANY (ARRAY['de'::text, 'deutsch'::text, 'german'::text])) OR lower(source_language) ~~ 'de-%'::text, false))";
  const client = fixtureClient({ canonical: true });
  const original = client.query.bind(client);
  client.query = async sql => {
    const result = await original(sql);
    if (sql.includes("FROM pg_constraint c")) {
      return {
        rows: result.rows.map(row => row.table_name === "tinder_reply_drafts"
          && row.contype === "c"
          && row.constraint_definition.includes("COALESCE")
          ? { ...row, constraint_definition: postgresqlDeparse }
          : row)
      };
    }
    return result;
  };
  assert.deepEqual(
    await inspectTinderDraftFoundationSchema(client, { assertIdentityReady: identityReady }),
    { state: TINDER_DRAFT_FOUNDATION_STATE.CANONICAL }
  );

  const changedLanguageSet = fixtureClient({ canonical: true });
  const changedOriginal = changedLanguageSet.query.bind(changedLanguageSet);
  changedLanguageSet.query = async sql => {
    const result = await changedOriginal(sql);
    if (sql.includes("FROM pg_constraint c")) {
      return {
        rows: result.rows.map(row => row.table_name === "tinder_reply_drafts"
          && row.contype === "c"
          && row.constraint_definition.includes("COALESCE")
          ? { ...row, constraint_definition: postgresqlDeparse.replace("'german'", "'french'") }
          : row)
      };
    }
    return result;
  };
  assert.deepEqual(
    await inspectTinderDraftFoundationSchema(changedLanguageSet, { assertIdentityReady: identityReady }),
    { state: TINDER_DRAFT_FOUNDATION_STATE.INVALID }
  );
});

test("T4 treats a retained migration-named function without its reviewed trigger as incompatible", async () => {
  const client = fixtureClient();
  const original = client.query.bind(client);
  client.query = async sql => {
    if (sql.includes("FROM pg_proc procedure")) return { rows: canonicalFunction() };
    return original(sql);
  };
  assert.deepEqual(
    await inspectTinderDraftFoundationSchema(client, { assertIdentityReady: identityReady }),
    { state: TINDER_DRAFT_FOUNDATION_STATE.INVALID }
  );
});

test("T4 rejects a post-state with all expected columns but a missing identity-revision CHECK", async () => {
  const client = fixtureClient({ canonical: true });
  const original = client.query.bind(client);
  client.query = async sql => {
    const result = await original(sql);
    if (sql.includes("FROM pg_constraint c")) {
      return { rows: result.rows.filter(row => !(row.table_name === "tinder_visible_chat_captures" && row.contype === "c")) };
    }
    return result;
  };
  assert.deepEqual(
    await inspectTinderDraftFoundationSchema(client, { assertIdentityReady: identityReady }),
    { state: TINDER_DRAFT_FOUNDATION_STATE.INVALID }
  );
});

test("T4 rejects canonical-looking tables when default state or audit metadata semantics drift", async () => {
  const drifts = [
    ["tinder_reply_drafts", "status", "'APPROVED'::text"],
    ["tinder_visible_chat_captures", "human_takeover_active", "true"],
    ["tinder_visible_chat_captures", "identity_revision", "2"]
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
      await inspectTinderDraftFoundationSchema(client, { assertIdentityReady: identityReady }),
      { state: TINDER_DRAFT_FOUNDATION_STATE.INVALID }
    );
  }
});

test("T4 source is fixed, transaction-owned by the runner, and rejects added transaction control", () => {
  const source = readFileSync(new URL("../migrations/20260904_tinder_draft_foundation.sql", import.meta.url), "utf8");
  assert.doesNotThrow(() => assertTinderDraftFoundationMigrationSource(source));
  assert.throws(() => assertTinderDraftFoundationMigrationSource(`${source}\nCOMMIT;`));
});
