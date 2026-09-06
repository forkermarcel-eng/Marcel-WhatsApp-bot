import {
  assertTinderVisibleChatCaptureBaseSchemaReady,
  preflightTinderVisibleChatCaptureMigration
} from "./tinder-visible-chat-capture-schema.js";
import {
  matchesTinderFoundationDefault,
  hasExpectedTinderFoundationConstraints,
  readTinderFoundationConstraints,
  TINDER_FOUNDATION_DEFAULT,
  tinderFoundationCheck,
  tinderFoundationKey
} from "./tinder-foundation-constraint-contract.js";
import { canonicalSchemaPredicate } from "./schema-contract.js";

/* ==================================================
T3 — ADDITIVE IDENTITY FOUNDATION SCHEMA CONTRACT
================================================== */

export const TINDER_IDENTITY_FOUNDATION_STATE = Object.freeze({
  ABSENT: "ABSENT",
  CANONICAL: "CANONICAL",
  INVALID: "INVALID"
});

const REQUIRED_CONTACT_COLUMNS = Object.freeze({
  id: Object.freeze({ dataType: "integer", nullable: false }),
  whatsapp_jid: Object.freeze({ dataType: "text", nullable: null })
});

const REQUIRED_IDENTIFIER_COLUMNS = Object.freeze({
  id: Object.freeze({ dataType: "bigint", nullable: false }),
  contact_id: Object.freeze({ dataType: "integer", nullable: false }),
  identifier_type: Object.freeze({ dataType: "text", nullable: false }),
  identifier_value: Object.freeze({ dataType: "text", nullable: false }),
  normalized_value: Object.freeze({ dataType: "text", nullable: false }),
  source_platform: Object.freeze({ dataType: "text", nullable: null }),
  is_primary: Object.freeze({ dataType: "boolean", nullable: null }),
  human_verified: Object.freeze({ dataType: "boolean", nullable: null }),
  created_at: Object.freeze({ dataType: "timestamp with time zone", nullable: null }),
  updated_at: Object.freeze({ dataType: "timestamp with time zone", nullable: null })
});

const T3_IDENTIFIER_PROVENANCE_COLUMNS = Object.freeze({
  verification_source: Object.freeze({ dataType: "text", nullable: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  verified_by: Object.freeze({ dataType: "text", nullable: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  verified_at: Object.freeze({ dataType: "timestamp with time zone", nullable: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE })
});

const AUDIT_COLUMNS = Object.freeze({
  mapping_audit_id: Object.freeze({ dataType: "bigint", nullable: false, defaultExpression: TINDER_FOUNDATION_DEFAULT.BIGSERIAL }),
  capture_id: Object.freeze({ dataType: "uuid", nullable: false, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  action: Object.freeze({ dataType: "text", nullable: false, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  actor: Object.freeze({ dataType: "text", nullable: false, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  source: Object.freeze({ dataType: "text", nullable: false, defaultExpression: "'manual_dashboard'" }),
  request_reference: Object.freeze({ dataType: "text", nullable: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  old_mapping_status: Object.freeze({ dataType: "text", nullable: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  new_mapping_status: Object.freeze({ dataType: "text", nullable: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  old_contact_id: Object.freeze({ dataType: "integer", nullable: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  new_contact_id: Object.freeze({ dataType: "integer", nullable: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  identifier_id: Object.freeze({ dataType: "bigint", nullable: true, defaultExpression: TINDER_FOUNDATION_DEFAULT.NONE }),
  details: Object.freeze({ dataType: "jsonb", nullable: false, defaultExpression: TINDER_FOUNDATION_DEFAULT.EMPTY_JSON_OBJECT }),
  created_at: Object.freeze({ dataType: "timestamp with time zone", nullable: false, defaultExpression: TINDER_FOUNDATION_DEFAULT.NOW })
});

const TARGET_INDEX_NAMES = Object.freeze([
  "idx_contact_identifiers_tinder_confirmed_unique",
  "idx_tinder_visible_chat_captures_mapping_time",
  "idx_tinder_visible_chat_captures_contact_time",
  "idx_tinder_identity_mapping_audit_capture_time"
]);

const T3_AUDIT_CONSTRAINT_CONTRACT = Object.freeze([
  tinderFoundationKey("tinder_identity_mapping_audit", "p", ["mapping_audit_id"], "PRIMARY KEY (mapping_audit_id)"),
  tinderFoundationKey("tinder_identity_mapping_audit", "f", ["capture_id"], "FOREIGN KEY (capture_id) REFERENCES tinder_visible_chat_captures(capture_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_visible_chat_captures", referenceColumns: ["capture_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey("tinder_identity_mapping_audit", "f", ["old_contact_id"], "FOREIGN KEY (old_contact_id) REFERENCES contacts(id) ON DELETE SET NULL", {
    referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "n", updateAction: "a"
  }),
  tinderFoundationKey("tinder_identity_mapping_audit", "f", ["new_contact_id"], "FOREIGN KEY (new_contact_id) REFERENCES contacts(id) ON DELETE SET NULL", {
    referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "n", updateAction: "a"
  }),
  tinderFoundationKey("tinder_identity_mapping_audit", "f", ["identifier_id"], "FOREIGN KEY (identifier_id) REFERENCES contact_identifiers(id) ON DELETE SET NULL", {
    referenceTable: "contact_identifiers", referenceColumns: ["id"], deleteAction: "n", updateAction: "a"
  }),
  tinderFoundationCheck("tinder_identity_mapping_audit", "action IN ('MAP_EXISTING', 'CREATE_NEW', 'CONFLICT_BLOCKED')"),
  tinderFoundationCheck("tinder_identity_mapping_audit", "source = 'manual_dashboard'"),
  tinderFoundationCheck("tinder_identity_mapping_audit", "jsonb_typeof(details) = 'object'")
]);

function columnMap(rows, tableName) {
  return new Map(rows
    .filter(row => row.table_name === tableName)
    .map(row => [row.column_name, {
      dataType: row.data_type,
      nullable: row.is_nullable === "YES",
      defaultExpression: row.column_default
    }]));
}

function columnContractMatches(actual, contract) {
  return Boolean(actual)
    && actual.dataType === contract.dataType
    && (contract.nullable === null || actual.nullable === contract.nullable)
    && (contract.defaultExpression === undefined
      || matchesTinderFoundationDefault(actual.defaultExpression, contract.defaultExpression));
}

function hasColumns(actual, contract, { exact = false } = {}) {
  return (!exact || actual.size === Object.keys(contract).length)
    && Object.entries(contract).every(([name, requirement]) =>
      columnContractMatches(actual.get(name), requirement));
}

function allColumnsAbsent(actual, contract) {
  return Object.keys(contract).every(name => !actual.has(name));
}

function exactArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function indexMap(rows) {
  return new Map(rows.map(row => [row.index_name, row]));
}

function exactIndex(row, { unique, columns, descending, predicate }) {
  return Boolean(row)
    && row.indisvalid === true
    && row.indisready === true
    && row.indisunique === unique
    && exactArray(row.column_names, columns)
    && exactArray(row.descending, descending)
    && canonicalSchemaPredicate(row.predicate) === canonicalSchemaPredicate(predicate);
}

function indexesAreCanonical(rows) {
  const indexes = indexMap(rows);
  return exactIndex(indexes.get("idx_contact_identifiers_tinder_confirmed_unique"), {
    unique: true,
    columns: ["identifier_type", "normalized_value"],
    descending: [false, false],
    predicate: "identifier_type = 'tinder_profile' AND human_verified = TRUE"
  }) && exactIndex(indexes.get("idx_tinder_visible_chat_captures_mapping_time"), {
    unique: false,
    columns: ["mapping_status", "received_at"],
    descending: [false, true],
    predicate: ""
  }) && exactIndex(indexes.get("idx_tinder_visible_chat_captures_contact_time"), {
    unique: false,
    columns: ["resolved_contact_id", "received_at"],
    descending: [false, true],
    predicate: "resolved_contact_idisnotnull"
  }) && exactIndex(indexes.get("idx_tinder_identity_mapping_audit_capture_time"), {
    unique: false,
    columns: ["capture_id", "created_at"],
    descending: [false, true],
    predicate: ""
  });
}

function noTargetIndexes(rows) {
  const indexes = indexMap(rows);
  return TARGET_INDEX_NAMES.every(name => !indexes.has(name));
}

async function readColumns(client) {
  return client.query(`
    SELECT table_name, column_name, data_type, is_nullable,
           COALESCE(column_default, '') AS column_default
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = ANY($1)
  `, [["contacts", "contact_identifiers", "tinder_identity_mapping_audit"]]);
}

async function readAuditRelation(client) {
  return client.query(`
    SELECT c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname = 'tinder_identity_mapping_audit'
  `);
}

async function readTargetIndexes(client) {
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

async function readAuditConstraints(client) {
  return readTinderFoundationConstraints(client, ["tinder_identity_mapping_audit"]);
}

async function assertNoDuplicateConfirmedTinderIdentifiers(client) {
  const result = await client.query(`
    SELECT 1
      FROM contact_identifiers
     WHERE identifier_type = 'tinder_profile'
       AND human_verified = TRUE
     GROUP BY normalized_value
    HAVING COUNT(DISTINCT contact_id) > 1
     LIMIT 1
  `);
  if (result.rows.length) {
    throw new Error("T3 migration blocked: duplicate confirmed tinder_profile identifiers require human resolution.");
  }
}

/** Read-only structural inspection. It never creates, alters or repairs T3. */
export async function inspectTinderIdentityFoundationSchema(client) {
  await assertTinderVisibleChatCaptureBaseSchemaReady(client);
  // A pg Client owns one query stream. Keep catalog reads sequential so this
  // exact preflight is valid both for mocked tests and the real locked client.
  const columnsResult = await readColumns(client);
  const auditRelationResult = await readAuditRelation(client);
  const indexesResult = await readTargetIndexes(client);
  const auditConstraintsResult = await readAuditConstraints(client);
  const contacts = columnMap(columnsResult.rows, "contacts");
  const identifiers = columnMap(columnsResult.rows, "contact_identifiers");
  const audit = columnMap(columnsResult.rows, "tinder_identity_mapping_audit");

  if (!hasColumns(contacts, REQUIRED_CONTACT_COLUMNS)
      || !hasColumns(identifiers, REQUIRED_IDENTIFIER_COLUMNS)) {
    return { state: TINDER_IDENTITY_FOUNDATION_STATE.INVALID };
  }

  const auditAbsent = auditRelationResult.rows.length === 0;
  const auditCanonical = auditRelationResult.rows.length === 1
    && auditRelationResult.rows[0]?.relkind === "r"
    && hasColumns(audit, AUDIT_COLUMNS, { exact: true });
  const contactsCanonical = contacts.get("whatsapp_jid")?.nullable === true;
  const contactsUnmigrated = contacts.get("whatsapp_jid")?.nullable === false;
  const provenanceCanonical = hasColumns(identifiers, T3_IDENTIFIER_PROVENANCE_COLUMNS);
  const provenanceAbsent = allColumnsAbsent(identifiers, T3_IDENTIFIER_PROVENANCE_COLUMNS);
  const indexesCanonical = indexesAreCanonical(indexesResult.rows);
  const indexesAbsent = noTargetIndexes(indexesResult.rows);
  const auditConstraintsCanonical = hasExpectedTinderFoundationConstraints(
    auditConstraintsResult.rows,
    T3_AUDIT_CONSTRAINT_CONTRACT,
    { exactTables: ["tinder_identity_mapping_audit"] }
  );

  if (contactsCanonical && provenanceCanonical && auditCanonical && auditConstraintsCanonical && indexesCanonical) {
    return { state: TINDER_IDENTITY_FOUNDATION_STATE.CANONICAL };
  }
  if (contactsUnmigrated && provenanceAbsent && auditAbsent && indexesAbsent) {
    return { state: TINDER_IDENTITY_FOUNDATION_STATE.ABSENT };
  }
  return { state: TINDER_IDENTITY_FOUNDATION_STATE.INVALID };
}

/**
 * Full explicit T3 preflight. T1/ACK/T2 must be green first; T3 accepts only
 * an untouched prerequisite shape or its complete canonical post-state.
 */
export async function preflightTinderIdentityFoundationMigration(client) {
  const t2 = await preflightTinderVisibleChatCaptureMigration(client);
  if (t2.capture.state !== "CANONICAL") {
    throw new Error("T3 migration requires the canonical T2 visible-chat capture foundation.");
  }
  const identity = await inspectTinderIdentityFoundationSchema(client);
  if (identity.state === TINDER_IDENTITY_FOUNDATION_STATE.INVALID) {
    throw new Error("T3 identity foundation schema is incompatible.");
  }
  if (identity.state === TINDER_IDENTITY_FOUNDATION_STATE.ABSENT) {
    await assertNoDuplicateConfirmedTinderIdentifiers(client);
  }
  return { identity, mutate: identity.state === TINDER_IDENTITY_FOUNDATION_STATE.ABSENT };
}

export async function assertTinderIdentityFoundationSchemaReady(client) {
  const inspection = await inspectTinderIdentityFoundationSchema(client);
  if (inspection.state !== TINDER_IDENTITY_FOUNDATION_STATE.CANONICAL) {
    throw new Error("T3 identity foundation schema is not ready.");
  }
  return inspection;
}

export { T3_AUDIT_CONSTRAINT_CONTRACT as TINDER_IDENTITY_FOUNDATION_CONSTRAINT_CONTRACT };
