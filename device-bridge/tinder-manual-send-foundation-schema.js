import {
  assertTinderDraftFoundationBaseSchemaReady
} from "./tinder-draft-foundation-schema.js";
import {
  canonicalTinderFoundationDefault,
  hasExpectedTinderFoundationConstraints,
  matchesTinderFoundationDefault,
  readTinderFoundationConstraints,
  TINDER_FOUNDATION_DEFAULT,
  tinderFoundationCheck,
  tinderFoundationKey
} from "./tinder-foundation-constraint-contract.js";
import { canonicalSchemaPredicate } from "./schema-contract.js";

/* ==================================================
T5 — SEALED MANUAL-SEND FOUNDATION SCHEMA CONTRACT

The T5 tables are a sealed approval/intent outbox only.  They are not active
Device-Bridge commands and this inspector has no dispatch, writer, or route
side effect.
================================================== */

export const TINDER_MANUAL_SEND_FOUNDATION_STATE = Object.freeze({
  ABSENT: "ABSENT",
  CANONICAL: "CANONICAL",
  INVALID: "INVALID"
});

const DRAFT_REVISION = Object.freeze({
  draft_revision: Object.freeze({ dataType: "integer", notNull: true, defaultExpression: "1" })
});

const APPROVAL_COLUMNS = Object.freeze({
  approval_id: ["uuid", true], draft_id: ["uuid", true], draft_revision: ["integer", true],
  contact_id: ["integer", true], capture_id: ["uuid", true], capture_fingerprint: ["character(64)", true],
  thread_ref_kind: ["text", true], runtime_thread_fingerprint: ["character(64)", true],
  capture_revision: ["integer", true], identity_revision: ["integer", true],
  approved_text_sha256: ["character(64)", true], approval_binding_sha256: ["character(64)", true],
  approved_by: ["text", true], approved_at: ["timestamp with time zone", true], state: ["text", true],
  invalidated_reason: ["text", false], invalidated_at: ["timestamp with time zone", false],
  created_at: ["timestamp with time zone", true]
});

const INTENT_COLUMNS = Object.freeze({
  intent_id: ["uuid", true], approval_id: ["uuid", true], draft_id: ["uuid", true],
  draft_revision: ["integer", true], contact_id: ["integer", true], capture_id: ["uuid", true],
  capture_fingerprint: ["character(64)", true], thread_ref_kind: ["text", true],
  runtime_thread_fingerprint: ["character(64)", true], identity_revision: ["integer", true],
  command_id: ["uuid", true], command_type: ["text", true], protocol_version: ["integer", true],
  approved_text_sha256: ["character(64)", true], approval_binding_sha256: ["character(64)", true],
  delivery_policy_revision: ["text", true], not_before: ["timestamp with time zone", true],
  expires_at: ["timestamp with time zone", true], typing_duration_ms: ["integer", true],
  state: ["text", true], received_at: ["timestamp with time zone", false],
  completed_at: ["timestamp with time zone", false], result_code: ["text", false],
  created_at: ["timestamp with time zone", true], updated_at: ["timestamp with time zone", true]
});

const AUDIT_COLUMNS = Object.freeze({
  send_audit_id: ["bigint", true], action: ["text", true], actor: ["text", true], source: ["text", true],
  draft_id: ["uuid", true], approval_id: ["uuid", false], intent_id: ["uuid", false],
  reason_code: ["text", false], details: ["jsonb", true], created_at: ["timestamp with time zone", true]
});

const APPROVAL_DEFAULTS = Object.freeze({
  state: "'ACTIVE'",
  created_at: TINDER_FOUNDATION_DEFAULT.NOW
});

const INTENT_DEFAULTS = Object.freeze({
  state: "'PENDING_T5_WRITER'"
});

const AUDIT_DEFAULTS = Object.freeze({
  send_audit_id: TINDER_FOUNDATION_DEFAULT.BIGSERIAL,
  source: "'tinder_manual_send'",
  details: TINDER_FOUNDATION_DEFAULT.EMPTY_JSON_OBJECT,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW
});

const TARGET_RELATIONS = Object.freeze([
  "tinder_reply_drafts",
  "tinder_reply_send_approvals",
  "tinder_reply_send_intents",
  "tinder_reply_send_audit"
]);
const TARGET_INDEX_NAMES = Object.freeze([
  "idx_tinder_reply_send_approvals_active_draft",
  "idx_tinder_reply_send_intents_pending",
  "idx_tinder_reply_send_audit_draft_time"
]);

const T5_MANUAL_SEND_CONSTRAINT_CONTRACT = Object.freeze([
  // Existing T4 owns the draft table; T5 adds only the revision guard.
  tinderFoundationCheck("tinder_reply_drafts", "draft_revision > 0"),

  tinderFoundationKey("tinder_reply_send_approvals", "p", ["approval_id"], "PRIMARY KEY (approval_id)"),
  tinderFoundationKey("tinder_reply_send_approvals", "u", ["draft_id", "draft_revision"], "UNIQUE (draft_id, draft_revision)"),
  tinderFoundationKey("tinder_reply_send_approvals", "f", ["draft_id"], "FOREIGN KEY (draft_id) REFERENCES tinder_reply_drafts(draft_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_reply_drafts", referenceColumns: ["draft_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey("tinder_reply_send_approvals", "f", ["contact_id"], "FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT", {
    referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey("tinder_reply_send_approvals", "f", ["capture_id"], "FOREIGN KEY (capture_id) REFERENCES tinder_visible_chat_captures(capture_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_visible_chat_captures", referenceColumns: ["capture_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationCheck("tinder_reply_send_approvals", "draft_revision > 0"),
  tinderFoundationCheck("tinder_reply_send_approvals", "capture_fingerprint ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck("tinder_reply_send_approvals", "thread_ref_kind = 'runtime_thread_fingerprint_v1'"),
  tinderFoundationCheck("tinder_reply_send_approvals", "runtime_thread_fingerprint ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck("tinder_reply_send_approvals", "capture_revision > 0"),
  tinderFoundationCheck("tinder_reply_send_approvals", "identity_revision > 0"),
  tinderFoundationCheck("tinder_reply_send_approvals", "approved_text_sha256 ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck("tinder_reply_send_approvals", "approval_binding_sha256 ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck("tinder_reply_send_approvals", "char_length(approved_by) BETWEEN 1 AND 80", "char_length(approved_by) >= 1 AND char_length(approved_by) <= 80"),
  tinderFoundationCheck("tinder_reply_send_approvals", "state IN ('ACTIVE', 'INVALIDATED', 'CANCELLED')"),
  tinderFoundationCheck("tinder_reply_send_approvals", "(state = 'ACTIVE' AND invalidated_reason IS NULL AND invalidated_at IS NULL) OR (state IN ('INVALIDATED', 'CANCELLED') AND invalidated_reason IS NOT NULL AND invalidated_at IS NOT NULL)"),

  tinderFoundationKey("tinder_reply_send_intents", "p", ["intent_id"], "PRIMARY KEY (intent_id)"),
  tinderFoundationKey("tinder_reply_send_intents", "u", ["approval_id"], "UNIQUE (approval_id)"),
  tinderFoundationKey("tinder_reply_send_intents", "u", ["command_id"], "UNIQUE (command_id)"),
  tinderFoundationKey("tinder_reply_send_intents", "f", ["approval_id"], "FOREIGN KEY (approval_id) REFERENCES tinder_reply_send_approvals(approval_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_reply_send_approvals", referenceColumns: ["approval_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey("tinder_reply_send_intents", "f", ["draft_id"], "FOREIGN KEY (draft_id) REFERENCES tinder_reply_drafts(draft_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_reply_drafts", referenceColumns: ["draft_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey("tinder_reply_send_intents", "f", ["contact_id"], "FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT", {
    referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey("tinder_reply_send_intents", "f", ["capture_id"], "FOREIGN KEY (capture_id) REFERENCES tinder_visible_chat_captures(capture_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_visible_chat_captures", referenceColumns: ["capture_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationCheck("tinder_reply_send_intents", "draft_revision > 0"),
  tinderFoundationCheck("tinder_reply_send_intents", "capture_fingerprint ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck("tinder_reply_send_intents", "thread_ref_kind = 'runtime_thread_fingerprint_v1'"),
  tinderFoundationCheck("tinder_reply_send_intents", "runtime_thread_fingerprint ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck("tinder_reply_send_intents", "identity_revision > 0"),
  tinderFoundationCheck("tinder_reply_send_intents", "command_type = 'SEND_TINDER_DRAFT'"),
  tinderFoundationCheck("tinder_reply_send_intents", "protocol_version = 1"),
  tinderFoundationCheck("tinder_reply_send_intents", "approved_text_sha256 ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck("tinder_reply_send_intents", "approval_binding_sha256 ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck("tinder_reply_send_intents", "char_length(delivery_policy_revision) BETWEEN 1 AND 120", "char_length(delivery_policy_revision) >= 1 AND char_length(delivery_policy_revision) <= 120"),
  tinderFoundationCheck("tinder_reply_send_intents", "typing_duration_ms BETWEEN 0 AND 900000", "typing_duration_ms >= 0 AND typing_duration_ms <= 900000"),
  tinderFoundationCheck("tinder_reply_send_intents", "state IN ('PENDING_T5_WRITER', 'DISPATCHING', 'SENT', 'FAILED', 'STALE', 'CANCELLED', 'SEND_RESULT_UNKNOWN')"),
  tinderFoundationCheck("tinder_reply_send_intents", "expires_at > not_before"),
  tinderFoundationCheck("tinder_reply_send_intents", "char_length(COALESCE(result_code, '')) <= 120"),
  tinderFoundationCheck("tinder_reply_send_intents", "(state IN ('PENDING_T5_WRITER', 'DISPATCHING') AND completed_at IS NULL) OR (state IN ('SENT', 'FAILED', 'STALE', 'CANCELLED', 'SEND_RESULT_UNKNOWN') AND completed_at IS NOT NULL)"),

  tinderFoundationKey("tinder_reply_send_audit", "p", ["send_audit_id"], "PRIMARY KEY (send_audit_id)"),
  tinderFoundationKey("tinder_reply_send_audit", "f", ["draft_id"], "FOREIGN KEY (draft_id) REFERENCES tinder_reply_drafts(draft_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_reply_drafts", referenceColumns: ["draft_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey("tinder_reply_send_audit", "f", ["approval_id"], "FOREIGN KEY (approval_id) REFERENCES tinder_reply_send_approvals(approval_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_reply_send_approvals", referenceColumns: ["approval_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey("tinder_reply_send_audit", "f", ["intent_id"], "FOREIGN KEY (intent_id) REFERENCES tinder_reply_send_intents(intent_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_reply_send_intents", referenceColumns: ["intent_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationCheck("tinder_reply_send_audit", "action IN ('APPROVAL_CREATED', 'APPROVAL_INVALIDATED', 'APPROVAL_CANCELLED', 'DRAFT_REJECTED', 'SEND_INTENT_RESERVED', 'SEND_RECEIVED', 'SEND_SUCCEEDED', 'SEND_FAILED', 'SEND_CANCELLED', 'SEND_RESULT_UNKNOWN')"),
  tinderFoundationCheck("tinder_reply_send_audit", "char_length(actor) BETWEEN 1 AND 80", "char_length(actor) >= 1 AND char_length(actor) <= 80"),
  tinderFoundationCheck("tinder_reply_send_audit", "source = 'tinder_manual_send'"),
  tinderFoundationCheck("tinder_reply_send_audit", "jsonb_typeof(details) = 'object'"),
  tinderFoundationCheck("tinder_reply_send_audit", "char_length(COALESCE(reason_code, '')) <= 120")
]);

function mapColumns(rows, relation) {
  return new Map(rows.filter(row => row.relation_name === relation).map(row => [row.column_name, {
    dataType: row.data_type,
    notNull: row.not_null === true,
    defaultExpression: canonicalTinderFoundationDefault(row.column_default)
  }]));
}

function relationKind(rows, relation) {
  const values = rows.filter(row => row.relation_name === relation);
  return values.length === 1 ? values[0]?.relkind : null;
}

function exactColumns(actual, contract, defaults = {}) {
  if (actual.size !== Object.keys(contract).length) return false;
  return Object.entries(contract).every(([name, [dataType, notNull]]) => {
    const column = actual.get(name);
    return column?.dataType === dataType
      && column?.notNull === notNull
      && matchesTinderFoundationDefault(
        column.defaultExpression,
        defaults[name] ?? TINDER_FOUNDATION_DEFAULT.NONE
      );
  });
}

function exactDraftRevision(actual) {
  const column = actual.get("draft_revision");
  return Boolean(column)
    && column.dataType === DRAFT_REVISION.draft_revision.dataType
    && column.notNull === true
    && matchesTinderFoundationDefault(column.defaultExpression, DRAFT_REVISION.draft_revision.defaultExpression);
}

function revisionAbsent(actual) {
  return !actual.has("draft_revision");
}

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function indexMap(rows) {
  return new Map(rows.map(row => [row.index_name, row]));
}

function indexMatches(row, { unique, columns, descending, predicate }) {
  return Boolean(row)
    && row.indisvalid === true
    && row.indisready === true
    && row.indisunique === unique
    && sameArray(row.column_names, columns)
    && sameArray(row.descending, descending)
    && canonicalSchemaPredicate(row.predicate) === canonicalSchemaPredicate(predicate);
}

function indexesCanonical(rows) {
  const indexes = indexMap(rows);
  return indexMatches(indexes.get("idx_tinder_reply_send_approvals_active_draft"), {
    unique: false, columns: ["draft_id", "draft_revision"], descending: [false, false], predicate: "state = 'ACTIVE'"
  }) && indexMatches(indexes.get("idx_tinder_reply_send_intents_pending"), {
    unique: false, columns: ["state", "not_before", "expires_at"], descending: [false, false, false],
    predicate: "state IN ('PENDING_T5_WRITER', 'DISPATCHING')"
  }) && indexMatches(indexes.get("idx_tinder_reply_send_audit_draft_time"), {
    unique: false, columns: ["draft_id", "created_at"], descending: [false, true], predicate: ""
  });
}

function indexesAbsent(rows) {
  const indexes = indexMap(rows);
  return TARGET_INDEX_NAMES.every(name => !indexes.has(name));
}

async function readRelations(client) {
  return client.query(`
    SELECT c.relname AS relation_name, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = ANY($1)
  `, [TARGET_RELATIONS]);
}

async function readColumns(client) {
  return client.query(`
    SELECT c.relname AS relation_name, a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null,
           COALESCE(pg_get_expr(d.adbin, d.adrelid, true), '') AS column_default
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = current_schema() AND c.relname = ANY($1)
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum
  `, [TARGET_RELATIONS]);
}

async function readIndexes(client) {
  return client.query(`
    SELECT idx.relname AS index_name, i.indisunique, i.indisvalid, i.indisready,
           ARRAY(
             SELECT attribute.attname::text
               FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
               JOIN pg_attribute attribute ON attribute.attrelid = i.indrelid AND attribute.attnum = key.attnum
              ORDER BY key.ordinality
           ) AS column_names,
           ARRAY(
             SELECT (option & 1) = 1
               FROM unnest(i.indoption) WITH ORDINALITY AS option_value(option, ordinality)
              ORDER BY ordinality
           ) AS descending,
           COALESCE(pg_get_expr(i.indpred, i.indrelid, true), '') AS predicate
      FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = idx.relnamespace
     WHERE n.nspname = current_schema() AND idx.relname = ANY($1)
  `, [TARGET_INDEX_NAMES]);
}

async function readT5Constraints(client) {
  return readTinderFoundationConstraints(client, TARGET_RELATIONS);
}

/** Read-only T5 state inspection; mixed pre-existing state never receives DDL. */
export async function inspectTinderManualSendFoundationSchema(client, {
  assertDraftReady = assertTinderDraftFoundationBaseSchemaReady
} = {}) {
  await assertDraftReady(client);
  const relations = await readRelations(client);
  const columns = await readColumns(client);
  const indexes = await readIndexes(client);
  const constraints = await readT5Constraints(client);
  const drafts = mapColumns(columns.rows, "tinder_reply_drafts");
  const approvals = mapColumns(columns.rows, "tinder_reply_send_approvals");
  const intents = mapColumns(columns.rows, "tinder_reply_send_intents");
  const audit = mapColumns(columns.rows, "tinder_reply_send_audit");

  const approvalsCanonical = relationKind(relations.rows, "tinder_reply_send_approvals") === "r" && exactColumns(approvals, APPROVAL_COLUMNS, APPROVAL_DEFAULTS);
  const intentsCanonical = relationKind(relations.rows, "tinder_reply_send_intents") === "r" && exactColumns(intents, INTENT_COLUMNS, INTENT_DEFAULTS);
  const auditCanonical = relationKind(relations.rows, "tinder_reply_send_audit") === "r" && exactColumns(audit, AUDIT_COLUMNS, AUDIT_DEFAULTS);
  const tablesAbsent = relationKind(relations.rows, "tinder_reply_send_approvals") === null && approvals.size === 0
    && relationKind(relations.rows, "tinder_reply_send_intents") === null && intents.size === 0
    && relationKind(relations.rows, "tinder_reply_send_audit") === null && audit.size === 0;
  const constraintsCanonical = hasExpectedTinderFoundationConstraints(
    constraints.rows,
    T5_MANUAL_SEND_CONSTRAINT_CONTRACT,
    { exactTables: ["tinder_reply_send_approvals", "tinder_reply_send_intents", "tinder_reply_send_audit"] }
  );

  if (exactDraftRevision(drafts) && approvalsCanonical && intentsCanonical && auditCanonical
      && constraintsCanonical && indexesCanonical(indexes.rows)) {
    return { state: TINDER_MANUAL_SEND_FOUNDATION_STATE.CANONICAL };
  }
  if (revisionAbsent(drafts) && tablesAbsent && indexesAbsent(indexes.rows)) {
    return { state: TINDER_MANUAL_SEND_FOUNDATION_STATE.ABSENT };
  }
  return { state: TINDER_MANUAL_SEND_FOUNDATION_STATE.INVALID };
}

export async function preflightTinderManualSendFoundationMigration(client) {
  const manualSend = await inspectTinderManualSendFoundationSchema(client);
  if (manualSend.state === TINDER_MANUAL_SEND_FOUNDATION_STATE.INVALID) {
    throw new Error("T5 Tinder manual-send foundation schema is incompatible.");
  }
  return { manualSend, mutate: manualSend.state === TINDER_MANUAL_SEND_FOUNDATION_STATE.ABSENT };
}

export async function assertTinderManualSendFoundationSchemaReady(client) {
  const inspection = await inspectTinderManualSendFoundationSchema(client);
  if (inspection.state !== TINDER_MANUAL_SEND_FOUNDATION_STATE.CANONICAL) {
    throw new Error("T5 Tinder manual-send foundation schema is not ready.");
  }
  return inspection;
}

export { T5_MANUAL_SEND_CONSTRAINT_CONTRACT as TINDER_MANUAL_SEND_FOUNDATION_CONSTRAINT_CONTRACT };
