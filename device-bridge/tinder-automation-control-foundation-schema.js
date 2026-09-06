import {
  assertTinderDraftFoundationBaseSchemaReady
} from "./tinder-draft-foundation-schema.js";
import {
  hasExpectedTinderFoundationConstraints,
  readTinderFoundationConstraints,
  tinderFoundationCheck,
  tinderFoundationKey
} from "./tinder-foundation-constraint-contract.js";
import { canonicalSchemaPredicate, compactSchemaSql } from "./schema-contract.js";

/* ==================================================
T7 — PERSISTENT AUTOMATION-CONTROL FOUNDATION SCHEMA

This module recognizes only a reviewed durable control/audit schema. It has
no control route, writer, timer, worker, command, capture, draft, or send
side effect. Missing or mixed state is deliberately invalid rather than
silently repaired.
================================================== */

export const TINDER_AUTOMATION_CONTROL_FOUNDATION_STATE = Object.freeze({
  ABSENT: "ABSENT",
  CANONICAL: "CANONICAL",
  INVALID: "INVALID"
});

const GLOBAL_STATES = Object.freeze(["STOPPED", "RUNNING", "PAUSED", "BLOCKED"]);
const CONTACT_STATES = Object.freeze(["DISABLED", "ENABLED", "PAUSED", "BLOCKED"]);
const OPERATION_STATES = Object.freeze(["ACTIVE", "REST_PHASE"]);

const GLOBAL_COLUMNS = Object.freeze({
  control_id: ["smallint", true],
  state: ["text", true, "'STOPPED'"],
  operation_state: ["text", true, "'ACTIVE'"],
  explicit_approval: ["boolean", true, "false"],
  policy_revision: ["text", false],
  control_revision: ["integer", true, "1"],
  updated_by: ["text", true, "'t7_foundation_migration'"],
  created_at: ["timestamp with time zone", true, "now()"],
  updated_at: ["timestamp with time zone", true, "now()"]
});

const CONTACT_COLUMNS = Object.freeze({
  contact_id: ["integer", true],
  state: ["text", true, "'DISABLED'"],
  control_revision: ["integer", true, "1"],
  updated_by: ["text", true, "'t7_foundation_migration'"],
  created_at: ["timestamp with time zone", true, "now()"],
  updated_at: ["timestamp with time zone", true, "now()"]
});

const AUDIT_COLUMNS = Object.freeze({
  audit_id: ["bigint", true],
  control_scope: ["text", true],
  contact_id: ["integer", false],
  action: ["text", true],
  actor: ["text", true],
  source: ["text", true],
  reason_code: ["text", false],
  details: ["jsonb", true, "'{}'::jsonb"],
  created_at: ["timestamp with time zone", true, "now()"]
});

const TARGET_RELATIONS = Object.freeze([
  "tinder_automation_global_control",
  "tinder_automation_contact_controls",
  "tinder_automation_control_audit"
]);

const TARGET_INDEX_NAMES = Object.freeze([
  "idx_tinder_automation_contact_controls_state",
  "idx_tinder_automation_control_audit_scope_time",
  "idx_tinder_automation_control_audit_contact_time"
]);

const T7_AUTOMATION_CONTROL_CONSTRAINT_CONTRACT = Object.freeze([
  tinderFoundationKey("tinder_automation_global_control", "p", ["control_id"], "PRIMARY KEY (control_id)"),
  tinderFoundationCheck("tinder_automation_global_control", "control_id = 1"),
  tinderFoundationCheck("tinder_automation_global_control", "state IN ('STOPPED', 'RUNNING', 'PAUSED', 'BLOCKED')"),
  tinderFoundationCheck("tinder_automation_global_control", "operation_state IN ('ACTIVE', 'REST_PHASE')"),
  tinderFoundationCheck("tinder_automation_global_control", "policy_revision IS NULL OR char_length(policy_revision) BETWEEN 1 AND 120", "policy_revision IS NULL OR (char_length(policy_revision) >= 1 AND char_length(policy_revision) <= 120)"),
  tinderFoundationCheck("tinder_automation_global_control", "control_revision > 0"),
  tinderFoundationCheck("tinder_automation_global_control", "char_length(updated_by) BETWEEN 1 AND 80", "char_length(updated_by) >= 1 AND char_length(updated_by) <= 80"),
  tinderFoundationCheck("tinder_automation_global_control", "state <> 'RUNNING' OR (explicit_approval = TRUE AND policy_revision IS NOT NULL)"),

  tinderFoundationKey("tinder_automation_contact_controls", "p", ["contact_id"], "PRIMARY KEY (contact_id)"),
  tinderFoundationKey("tinder_automation_contact_controls", "f", ["contact_id"], "FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT", {
    referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationCheck("tinder_automation_contact_controls", "state IN ('DISABLED', 'ENABLED', 'PAUSED', 'BLOCKED')"),
  tinderFoundationCheck("tinder_automation_contact_controls", "control_revision > 0"),
  tinderFoundationCheck("tinder_automation_contact_controls", "char_length(updated_by) BETWEEN 1 AND 80", "char_length(updated_by) >= 1 AND char_length(updated_by) <= 80"),

  tinderFoundationKey("tinder_automation_control_audit", "p", ["audit_id"], "PRIMARY KEY (audit_id)"),
  tinderFoundationKey("tinder_automation_control_audit", "f", ["contact_id"], "FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT", {
    referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationCheck("tinder_automation_control_audit", "control_scope IN ('GLOBAL', 'CONTACT')"),
  tinderFoundationCheck("tinder_automation_control_audit", "action IN ('GLOBAL_DEFAULT_INITIALIZED', 'GLOBAL_CONTROL_UPDATED', 'CONTACT_CONTROL_CREATED', 'CONTACT_CONTROL_UPDATED')"),
  tinderFoundationCheck("tinder_automation_control_audit", "char_length(actor) BETWEEN 1 AND 80", "char_length(actor) >= 1 AND char_length(actor) <= 80"),
  tinderFoundationCheck("tinder_automation_control_audit", "char_length(source) BETWEEN 1 AND 80", "char_length(source) >= 1 AND char_length(source) <= 80"),
  tinderFoundationCheck("tinder_automation_control_audit", "char_length(COALESCE(reason_code, '')) <= 120"),
  tinderFoundationCheck("tinder_automation_control_audit", "jsonb_typeof(details) = 'object'"),
  tinderFoundationCheck("tinder_automation_control_audit", "(control_scope = 'GLOBAL') = (contact_id IS NULL)")
]);

function compact(value) {
  return compactSchemaSql(value);
}

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function relationKind(rows, relation) {
  const matches = rows.filter(row => row.relation_name === relation);
  return matches.length === 1 ? matches[0]?.relkind : null;
}

function mapColumns(rows, relation) {
  return new Map(rows.filter(row => row.relation_name === relation).map(row => [row.column_name, {
    dataType: row.data_type,
    notNull: row.not_null === true,
    defaultExpression: compact(row.column_default)
  }]));
}

function exactColumns(actual, contract) {
  if (actual.size !== Object.keys(contract).length) return false;
  return Object.entries(contract).every(([name, [dataType, notNull, defaultExpression]]) => {
    const column = actual.get(name);
    return Boolean(column)
      && column.dataType === dataType
      && column.notNull === notNull
      && (defaultExpression === undefined || column.defaultExpression === compact(defaultExpression));
  });
}

function indexesByName(rows) {
  return new Map(rows.map(row => [row.index_name, row]));
}

function indexMatches(row, { unique, columns, descending, predicate = "" }) {
  return Boolean(row)
    && row.indisvalid === true
    && row.indisready === true
    && row.indisunique === unique
    && sameArray(row.column_names, columns)
    && sameArray(row.descending, descending)
    && canonicalSchemaPredicate(row.predicate) === canonicalSchemaPredicate(predicate);
}

function indexesCanonical(rows) {
  const indexes = indexesByName(rows);
  return indexMatches(indexes.get("idx_tinder_automation_contact_controls_state"), {
    unique: false, columns: ["state", "updated_at"], descending: [false, true]
  }) && indexMatches(indexes.get("idx_tinder_automation_control_audit_scope_time"), {
    unique: false, columns: ["control_scope", "created_at"], descending: [false, true]
  }) && indexMatches(indexes.get("idx_tinder_automation_control_audit_contact_time"), {
    unique: false, columns: ["contact_id", "created_at"], descending: [false, true], predicate: "contact_id IS NOT NULL"
  });
}

function indexesAbsent(rows) {
  const indexes = indexesByName(rows);
  return TARGET_INDEX_NAMES.every(name => !indexes.has(name));
}

function validText(value, maximum = 120) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= maximum;
}

function singletonGlobalControlCanonical(rows) {
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  const row = rows[0] || {};
  const state = String(row.state || "").trim().toUpperCase();
  const operationState = String(row.operation_state || "").trim().toUpperCase();
  const policyRevision = row.policy_revision;
  if (Number(row.control_id) !== 1
      || !GLOBAL_STATES.includes(state)
      || !OPERATION_STATES.includes(operationState)
      || typeof row.explicit_approval !== "boolean"
      || !(policyRevision === null || validText(policyRevision))) {
    return false;
  }
  return state !== "RUNNING" || (row.explicit_approval === true && validText(policyRevision));
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

async function readConstraints(client) {
  return readTinderFoundationConstraints(client, TARGET_RELATIONS);
}

async function readGlobalControlRows(client) {
  return client.query(`
    SELECT control_id, state, operation_state, explicit_approval, policy_revision
      FROM tinder_automation_global_control
     ORDER BY control_id ASC
  `);
}

/** Read-only recognition; it never creates, changes, or activates control. */
export async function inspectTinderAutomationControlFoundationSchema(client, {
  assertDraftReady = assertTinderDraftFoundationBaseSchemaReady
} = {}) {
  await assertDraftReady(client);
  const relations = await readRelations(client);
  const columns = await readColumns(client);
  const indexes = await readIndexes(client);
  const constraints = await readConstraints(client);
  const global = mapColumns(columns.rows, "tinder_automation_global_control");
  const contact = mapColumns(columns.rows, "tinder_automation_contact_controls");
  const audit = mapColumns(columns.rows, "tinder_automation_control_audit");
  const globalPresent = relationKind(relations.rows, "tinder_automation_global_control") === "r";
  const globalCanonical = globalPresent && exactColumns(global, GLOBAL_COLUMNS);
  const contactCanonical = relationKind(relations.rows, "tinder_automation_contact_controls") === "r"
    && exactColumns(contact, CONTACT_COLUMNS);
  const auditCanonical = relationKind(relations.rows, "tinder_automation_control_audit") === "r"
    && exactColumns(audit, AUDIT_COLUMNS);
  const constraintsCanonical = hasExpectedTinderFoundationConstraints(
    constraints.rows,
    T7_AUTOMATION_CONTROL_CONSTRAINT_CONTRACT,
    { exactTables: TARGET_RELATIONS }
  );
  const absent = !globalPresent && global.size === 0
    && relationKind(relations.rows, "tinder_automation_contact_controls") === null && contact.size === 0
    && relationKind(relations.rows, "tinder_automation_control_audit") === null && audit.size === 0
    && indexesAbsent(indexes.rows);

  if (globalCanonical && contactCanonical && auditCanonical && constraintsCanonical && indexesCanonical(indexes.rows)) {
    const globalRows = await readGlobalControlRows(client);
    return singletonGlobalControlCanonical(globalRows.rows)
      ? { state: TINDER_AUTOMATION_CONTROL_FOUNDATION_STATE.CANONICAL }
      : { state: TINDER_AUTOMATION_CONTROL_FOUNDATION_STATE.INVALID };
  }
  if (absent) return { state: TINDER_AUTOMATION_CONTROL_FOUNDATION_STATE.ABSENT };
  return { state: TINDER_AUTOMATION_CONTROL_FOUNDATION_STATE.INVALID };
}

export async function preflightTinderAutomationControlFoundationMigration(client) {
  const automationControl = await inspectTinderAutomationControlFoundationSchema(client);
  if (automationControl.state === TINDER_AUTOMATION_CONTROL_FOUNDATION_STATE.INVALID) {
    throw new Error("T7 Tinder automation-control foundation schema is incompatible.");
  }
  return {
    automationControl,
    mutate: automationControl.state === TINDER_AUTOMATION_CONTROL_FOUNDATION_STATE.ABSENT
  };
}

export async function assertTinderAutomationControlFoundationSchemaReady(client) {
  const inspection = await inspectTinderAutomationControlFoundationSchema(client);
  if (inspection.state !== TINDER_AUTOMATION_CONTROL_FOUNDATION_STATE.CANONICAL) {
    throw new Error("T7 Tinder automation-control foundation schema is not ready.");
  }
  return inspection;
}

export {
  T7_AUTOMATION_CONTROL_CONSTRAINT_CONTRACT as TINDER_AUTOMATION_CONTROL_FOUNDATION_CONSTRAINT_CONTRACT
};
