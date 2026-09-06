import {
  assertTinderIdentityFoundationSchemaReady
} from "./tinder-identity-foundation-schema.js";
import {
  canonicalTinderFoundationDefault,
  hasExpectedTinderFoundationConstraints,
  matchesTinderFoundationDefault,
  readTinderFoundationConstraints,
  TINDER_FOUNDATION_DEFAULT,
  tinderFoundationCheck,
  tinderFoundationKey
} from "./tinder-foundation-constraint-contract.js";
import { compactSchemaSql } from "./schema-contract.js";

/* ==================================================
T4 — ADDITIVE DRAFT FOUNDATION SCHEMA CONTRACT

The T2 capture table is owned by the signed capture ingress and T3 owns
identity mapping.  This module merely recognizes the exact additive T4
post-state.  It never creates, alters, repairs, or exposes database rows.
================================================== */

export const TINDER_DRAFT_FOUNDATION_STATE = Object.freeze({
  ABSENT: "ABSENT",
  CANONICAL: "CANONICAL",
  INVALID: "INVALID"
});

const CAPTURE_T4_COLUMNS = Object.freeze({
  identity_revision: Object.freeze({ dataType: "integer", notNull: true, defaultExpression: "1" }),
  human_takeover_active: Object.freeze({ dataType: "boolean", notNull: true, defaultExpression: "false" }),
  handoff_active: Object.freeze({ dataType: "boolean", notNull: true, defaultExpression: "false" })
});

const DRAFT_COLUMNS = Object.freeze({
  draft_id: Object.freeze({ dataType: "uuid", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  channel: Object.freeze({ dataType: "text", notNull: true, defaultExpression: "'tinder'" }),
  status: Object.freeze({ dataType: "text", notNull: true, defaultExpression: "'DRAFT'" }),
  contact_id: Object.freeze({ dataType: "integer", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  capture_id: Object.freeze({ dataType: "uuid", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  runtime_thread_fingerprint: Object.freeze({ dataType: "character(64)", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  capture_revision: Object.freeze({ dataType: "integer", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  identity_revision: Object.freeze({ dataType: "integer", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  original_draft: Object.freeze({ dataType: "text", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  control_draft_de: Object.freeze({ dataType: "text", notNull: false, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  source_language: Object.freeze({ dataType: "text", notNull: false, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  model_version: Object.freeze({ dataType: "text", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  stale_reason: Object.freeze({ dataType: "text", notNull: false, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  created_at: Object.freeze({ dataType: "timestamp with time zone", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  updated_at: Object.freeze({ dataType: "timestamp with time zone", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE })
});

const AUDIT_COLUMNS = Object.freeze({
  draft_audit_id: Object.freeze({ dataType: "bigint", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.BIGSERIAL }),
  draft_id: Object.freeze({ dataType: "uuid", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  capture_id: Object.freeze({ dataType: "uuid", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  action: Object.freeze({ dataType: "text", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  actor: Object.freeze({ dataType: "text", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  source: Object.freeze({ dataType: "text", notNull: true, defaultExpression: "'tinder_draft_foundation'" }),
  previous_status: Object.freeze({ dataType: "text", notNull: false, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  new_status: Object.freeze({ dataType: "text", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  reason: Object.freeze({ dataType: "text", notNull: false, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  details: Object.freeze({ dataType: "jsonb", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.EMPTY_JSON_OBJECT }),
  created_at: Object.freeze({ dataType: "timestamp with time zone", notNull: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NOW })
});

const TARGET_INDEX_NAMES = Object.freeze([
  "idx_tinder_reply_drafts_contact_status_time",
  "idx_tinder_reply_drafts_thread_revision",
  "idx_tinder_reply_draft_audit_draft_time"
]);

const TARGET_RELATIONS = Object.freeze([
  "tinder_visible_chat_captures",
  "tinder_reply_drafts",
  "tinder_reply_draft_audit"
]);

const T4_DRAFT_CONSTRAINT_CONTRACT = Object.freeze([
  // Existing T2 owns the capture table; T4 adds only this one constraint.
  tinderFoundationCheck("tinder_visible_chat_captures", "identity_revision > 0"),

  tinderFoundationKey("tinder_reply_drafts", "p", ["draft_id"], "PRIMARY KEY (draft_id)"),
  tinderFoundationKey("tinder_reply_drafts", "f", ["contact_id"], "FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT", {
    referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey("tinder_reply_drafts", "f", ["capture_id"], "FOREIGN KEY (capture_id) REFERENCES tinder_visible_chat_captures(capture_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_visible_chat_captures", referenceColumns: ["capture_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationCheck("tinder_reply_drafts", "channel = 'tinder'"),
  tinderFoundationCheck("tinder_reply_drafts", "status IN ('DRAFT', 'APPROVED', 'REJECTED', 'STALE')"),
  tinderFoundationCheck("tinder_reply_drafts", "runtime_thread_fingerprint ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck("tinder_reply_drafts", "capture_revision > 0"),
  tinderFoundationCheck("tinder_reply_drafts", "identity_revision > 0"),
  tinderFoundationCheck("tinder_reply_drafts", "char_length(original_draft) BETWEEN 1 AND 8000", "char_length(original_draft) >= 1 AND char_length(original_draft) <= 8000"),
  tinderFoundationCheck("tinder_reply_drafts", "control_draft_de IS NULL OR char_length(control_draft_de) BETWEEN 1 AND 8000", "control_draft_de IS NULL OR (char_length(control_draft_de) >= 1 AND char_length(control_draft_de) <= 8000)"),
  tinderFoundationCheck("tinder_reply_drafts", "source_language IS NULL OR char_length(source_language) BETWEEN 1 AND 32", "source_language IS NULL OR (char_length(source_language) >= 1 AND char_length(source_language) <= 32)"),
  tinderFoundationCheck("tinder_reply_drafts", "char_length(model_version) BETWEEN 1 AND 160", "char_length(model_version) >= 1 AND char_length(model_version) <= 160"),
  tinderFoundationCheck("tinder_reply_drafts", "stale_reason IS NULL OR stale_reason IN ('NEWER_CAPTURE_REVISION', 'THREAD_CHANGED', 'IDENTITY_MAPPING_CHANGED', 'HUMAN_TAKEOVER', 'HANDOFF', 'GATE_CLOSED')"),
  tinderFoundationCheck("tinder_reply_drafts", "(status = 'STALE') = (stale_reason IS NOT NULL)"),
  // PostgreSQL may deparse IN and LIKE in this fixed expression as
  // = ANY (ARRAY[...]) and ~~ respectively. Both forms preserve the exact
  // reviewed language gate; no general operator equivalence is inferred.
  tinderFoundationCheck(
    "tinder_reply_drafts",
    "control_draft_de IS NULL OR COALESCE(lower(source_language) IN ('de', 'deutsch', 'german') OR lower(source_language) LIKE 'de-%', FALSE)",
    "control_draft_de IS NULL OR COALESCE((lower(source_language) = ANY (ARRAY['de', 'deutsch', 'german'])) OR lower(source_language) ~~ 'de-%', FALSE)"
  ),

  tinderFoundationKey("tinder_reply_draft_audit", "p", ["draft_audit_id"], "PRIMARY KEY (draft_audit_id)"),
  tinderFoundationKey("tinder_reply_draft_audit", "f", ["draft_id"], "FOREIGN KEY (draft_id) REFERENCES tinder_reply_drafts(draft_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_reply_drafts", referenceColumns: ["draft_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey("tinder_reply_draft_audit", "f", ["capture_id"], "FOREIGN KEY (capture_id) REFERENCES tinder_visible_chat_captures(capture_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_visible_chat_captures", referenceColumns: ["capture_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationCheck("tinder_reply_draft_audit", "action IN ('DRAFT_CREATED', 'DRAFT_STALE')"),
  tinderFoundationCheck("tinder_reply_draft_audit", "source = 'tinder_draft_foundation'"),
  tinderFoundationCheck("tinder_reply_draft_audit", "jsonb_typeof(details) = 'object'"),
  tinderFoundationCheck("tinder_reply_draft_audit", "new_status IN ('DRAFT', 'STALE')"),
  tinderFoundationCheck("tinder_reply_draft_audit", "(action = 'DRAFT_CREATED') = (new_status = 'DRAFT')"),
  tinderFoundationCheck("tinder_reply_draft_audit", "(action = 'DRAFT_STALE') = (new_status = 'STALE')")
]);

function compact(value) {
  return compactSchemaSql(value);
}

function sameArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function columnMap(rows, relation) {
  return new Map(rows
    .filter(row => row.relation_name === relation)
    .map(row => [row.column_name, {
      dataType: row.data_type,
      notNull: row.not_null === true,
      defaultExpression: canonicalTinderFoundationDefault(row.column_default)
    }]));
}

function exactColumns(actual, contract, { exact = true } = {}) {
  if (exact && actual.size !== Object.keys(contract).length) return false;
  return Object.entries(contract).every(([name, expected]) => {
    const column = actual.get(name);
    return Boolean(column)
      && column.dataType === expected.dataType
      && column.notNull === expected.notNull
      && (expected.defaultExpression === undefined
        || matchesTinderFoundationDefault(column.defaultExpression, expected.defaultExpression));
  });
}

function columnsAbsent(actual, contract) {
  return Object.keys(contract).every(name => !actual.has(name));
}

function relationKind(rows, relation) {
  const matches = rows.filter(row => row.relation_name === relation);
  return matches.length === 1 ? matches[0]?.relkind : null;
}

function indexMap(rows) {
  return new Map(rows.map(row => [row.index_name, row]));
}

function indexMatches(row, { unique, columns, descending, predicate = "" }) {
  return Boolean(row)
    && row.indisvalid === true
    && row.indisready === true
    && row.indisunique === unique
    && sameArray(row.column_names, columns)
    && sameArray(row.descending, descending)
    && compact(row.predicate) === compact(predicate);
}

function indexesCanonical(rows) {
  const indexes = indexMap(rows);
  return indexMatches(indexes.get("idx_tinder_reply_drafts_contact_status_time"), {
    unique: false,
    columns: ["contact_id", "status", "created_at"],
    descending: [false, false, true]
  }) && indexMatches(indexes.get("idx_tinder_reply_drafts_thread_revision"), {
    unique: false,
    columns: ["runtime_thread_fingerprint", "capture_revision"],
    descending: [false, true]
  }) && indexMatches(indexes.get("idx_tinder_reply_draft_audit_draft_time"), {
    unique: false,
    columns: ["draft_id", "created_at"],
    descending: [false, true]
  });
}

function indexesAbsent(rows) {
  const indexes = indexMap(rows);
  return TARGET_INDEX_NAMES.every(name => !indexes.has(name));
}

function triggerCanonical(rows) {
  if (rows.length !== 1) return false;
  const trigger = rows[0];
  if (trigger.trigger_name !== "t4_tinder_capture_identity_revision"
      || trigger.relation_name !== "tinder_visible_chat_captures"
      || trigger.function_name !== "t4_bump_tinder_capture_identity_revision"
      || trigger.function_schema !== "public") return false;
  const definition = compact(trigger.trigger_definition);
  const functionDefinition = compact(trigger.function_definition);
  // pg_get_triggerdef(..., true) may omit the current-schema qualification
  // from the relation. The catalog relation/function fields above bind both
  // objects exactly, so compare the invariant trigger timing, update set and
  // execution clause rather than an optional presentation-only prefix.
  return definition.includes("beforeupdateofmapping_status,human_review_status,resolved_contact_idon")
    && definition.includes("foreachrowexecutefunctiont4_bump_tinder_capture_identity_revision")
    && functionDefinition.includes("new.identity_revision:=old.identity_revision+1")
    && functionDefinition.includes("old.mapping_statusisdistinctfromnew.mapping_status")
    && functionDefinition.includes("old.human_review_statusisdistinctfromnew.human_review_status")
    && functionDefinition.includes("old.resolved_contact_idisdistinctfromnew.resolved_contact_id");
}

function identityFunctionCanonical(rows) {
  if (rows.length !== 1) return false;
  const procedure = rows[0];
  if (procedure.function_name !== "t4_bump_tinder_capture_identity_revision"
      || procedure.argument_signature !== ""
      || procedure.return_type !== "trigger") return false;
  const definition = compact(procedure.function_definition);
  return definition.includes("returnstrigger")
    && definition.includes("languageplpgsql")
    && definition.includes("new.identity_revision:=old.identity_revision+1")
    && definition.includes("old.mapping_statusisdistinctfromnew.mapping_status")
    && definition.includes("old.human_review_statusisdistinctfromnew.human_review_status")
    && definition.includes("old.resolved_contact_idisdistinctfromnew.resolved_contact_id")
    && definition.includes("returnnew");
}

async function readRelations(client) {
  return client.query(`
    SELECT c.relname AS relation_name, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname = ANY($1)
  `, [TARGET_RELATIONS]);
}

async function readColumns(client) {
  return client.query(`
    SELECT c.relname AS relation_name,
           a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null,
           COALESCE(pg_get_expr(d.adbin, d.adrelid, true), '') AS column_default
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = current_schema()
       AND c.relname = ANY($1)
       AND a.attnum > 0
       AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum
  `, [TARGET_RELATIONS]);
}

async function readIndexes(client) {
  return client.query(`
    SELECT idx.relname AS index_name,
           i.indisunique,
           i.indisvalid,
           i.indisready,
           ARRAY(
             SELECT attribute.attname::text
               FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
               JOIN pg_attribute attribute
                 ON attribute.attrelid = i.indrelid
                AND attribute.attnum = key.attnum
              ORDER BY key.ordinality
           ) AS column_names,
           ARRAY(
             SELECT (option & 1) = 1
               FROM unnest(i.indoption) WITH ORDINALITY AS option_value(option, ordinality)
              ORDER BY ordinality
           ) AS descending,
           COALESCE(pg_get_expr(i.indpred, i.indrelid, true), '') AS predicate
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = idx.relnamespace
     WHERE n.nspname = current_schema()
       AND idx.relname = ANY($1)
  `, [TARGET_INDEX_NAMES]);
}

async function readIdentityTrigger(client) {
  return client.query(`
    SELECT trigger_rel.relname AS relation_name,
           trigger_def.tgname AS trigger_name,
           procedure.proname AS function_name,
           procedure_namespace.nspname AS function_schema,
           pg_get_triggerdef(trigger_def.oid, true) AS trigger_definition,
           pg_get_functiondef(procedure.oid) AS function_definition
      FROM pg_trigger trigger_def
      JOIN pg_class trigger_rel ON trigger_rel.oid = trigger_def.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = trigger_rel.relnamespace
      JOIN pg_proc procedure ON procedure.oid = trigger_def.tgfoid
      JOIN pg_namespace procedure_namespace ON procedure_namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = current_schema()
       AND trigger_def.tgname = 't4_tinder_capture_identity_revision'
       AND NOT trigger_def.tgisinternal
  `);
}

async function readIdentityFunction(client) {
  return client.query(`
    SELECT procedure.proname AS function_name,
           pg_get_function_identity_arguments(procedure.oid) AS argument_signature,
           format_type(procedure.prorettype, NULL) AS return_type,
           pg_get_functiondef(procedure.oid) AS function_definition
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
     WHERE namespace.nspname = current_schema()
       AND procedure.proname = 't4_bump_tinder_capture_identity_revision'
  `);
}

async function readT4Constraints(client) {
  return readTinderFoundationConstraints(client, TARGET_RELATIONS);
}

async function readTinderDraftFoundationCatalog(client, assertIdentityReady) {
  await assertIdentityReady(client);
  const relations = await readRelations(client);
  const columns = await readColumns(client);
  const indexes = await readIndexes(client);
  const trigger = await readIdentityTrigger(client);
  const identityFunction = await readIdentityFunction(client);
  const constraints = await readT4Constraints(client);
  return {
    relations: relations.rows,
    captureColumns: columnMap(columns.rows, "tinder_visible_chat_captures"),
    drafts: columnMap(columns.rows, "tinder_reply_drafts"),
    audit: columnMap(columns.rows, "tinder_reply_draft_audit"),
    indexes: indexes.rows,
    trigger: trigger.rows,
    identityFunction: identityFunction.rows,
    constraints: constraints.rows
  };
}

function hasTinderDraftFoundationBase(catalog, { exact = true } = {}) {
  const captureCanonical = exactColumns(catalog.captureColumns, CAPTURE_T4_COLUMNS, { exact: false });
  const draftsCanonical = relationKind(catalog.relations, "tinder_reply_drafts") === "r"
    && exactColumns(catalog.drafts, DRAFT_COLUMNS, { exact });
  const auditCanonical = relationKind(catalog.relations, "tinder_reply_draft_audit") === "r"
    && exactColumns(catalog.audit, AUDIT_COLUMNS, { exact });
  const constraintsCanonical = hasExpectedTinderFoundationConstraints(
    catalog.constraints,
    T4_DRAFT_CONSTRAINT_CONTRACT,
    { exactTables: exact ? ["tinder_reply_drafts", "tinder_reply_draft_audit"] : [] }
  );
  return captureCanonical && draftsCanonical && auditCanonical && constraintsCanonical
    && indexesCanonical(catalog.indexes) && triggerCanonical(catalog.trigger)
    && identityFunctionCanonical(catalog.identityFunction);
}

/**
 * Read-only T4 state inspection.  The explicit runner treats only an entirely
 * absent T4 shape as mutable; any mixed or altered post-state fails closed.
 */
export async function inspectTinderDraftFoundationSchema(client, {
  assertIdentityReady = assertTinderIdentityFoundationSchemaReady
} = {}) {
  const catalog = await readTinderDraftFoundationCatalog(client, assertIdentityReady);
  const captureAbsent = columnsAbsent(catalog.captureColumns, CAPTURE_T4_COLUMNS);
  const draftsAbsent = relationKind(catalog.relations, "tinder_reply_drafts") === null && catalog.drafts.size === 0;
  const auditAbsent = relationKind(catalog.relations, "tinder_reply_draft_audit") === null && catalog.audit.size === 0;
  const triggerPresent = catalog.trigger.length > 0;
  const functionPresent = catalog.identityFunction.length > 0;

  if (hasTinderDraftFoundationBase(catalog)) {
    return { state: TINDER_DRAFT_FOUNDATION_STATE.CANONICAL };
  }
  if (captureAbsent && draftsAbsent && auditAbsent && indexesAbsent(catalog.indexes) && !triggerPresent && !functionPresent) {
    return { state: TINDER_DRAFT_FOUNDATION_STATE.ABSENT };
  }
  return { state: TINDER_DRAFT_FOUNDATION_STATE.INVALID };
}

export async function preflightTinderDraftFoundationMigration(client) {
  const draft = await inspectTinderDraftFoundationSchema(client);
  if (draft.state === TINDER_DRAFT_FOUNDATION_STATE.INVALID) {
    throw new Error("T4 Tinder draft foundation schema is incompatible.");
  }
  return { draft, mutate: draft.state === TINDER_DRAFT_FOUNDATION_STATE.ABSENT };
}

export async function assertTinderDraftFoundationSchemaReady(client) {
  const inspection = await inspectTinderDraftFoundationSchema(client);
  if (inspection.state !== TINDER_DRAFT_FOUNDATION_STATE.CANONICAL) {
    throw new Error("T4 Tinder draft foundation schema is not ready.");
  }
  return inspection;
}

/**
 * Readiness for later additive foundations. It requires every T4-owned
 * column, constraint, index, trigger and function exactly, but allows
 * downstream-owned additive fields such as T5's draft_revision. The explicit
 * T4 migration preflight remains exact through inspectTinderDraftFoundationSchema.
 */
export async function assertTinderDraftFoundationBaseSchemaReady(client, {
  assertIdentityReady = assertTinderIdentityFoundationSchemaReady
} = {}) {
  const catalog = await readTinderDraftFoundationCatalog(client, assertIdentityReady);
  if (!hasTinderDraftFoundationBase(catalog, { exact: false })) {
    throw new Error("T4 Tinder draft foundation base schema is not ready.");
  }
  return { state: "BASE_COMPATIBLE" };
}

export { T4_DRAFT_CONSTRAINT_CONTRACT as TINDER_DRAFT_FOUNDATION_CONSTRAINT_CONTRACT };
