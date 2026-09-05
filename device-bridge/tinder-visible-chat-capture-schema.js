import { preflightDeviceBridgeAckSchemaForT1Migration } from "./ack-schema.js";
import { canonicalCheckDefinition, canonicalSchemaDefinition } from "./schema-contract.js";
import { preflightDeviceBridgeFoundationForT1 } from "./schema-readiness.js";
import { assertDeviceBridgeT1SchemaReady } from "./t1-schema.js";

/* ==================================================
T2 — EXPLICIT VISIBLE-CHAT CAPTURE TABLE CONTRACT
================================================== */

export const TINDER_VISIBLE_CHAT_CAPTURE_TABLE = "tinder_visible_chat_captures";

const COLUMN_CONTRACT = Object.freeze({
  capture_id: immutableColumn("uuid", true),
  device_id: immutableColumn("uuid", true),
  capture_schema_version: immutableColumn("text", true),
  source_platform: immutableColumn("text", true, "'tinder'"),
  source_package: immutableColumn("text", true),
  capture_safety_status: immutableColumn("text", true),
  runtime_thread_fingerprint: immutableColumn("character(64)", true),
  capture_fingerprint: immutableColumn("character(64)", true),
  capture_revision: immutableColumn("integer", true),
  visible_thread_metadata: immutableColumn("jsonb", true),
  visible_messages: immutableColumn("jsonb", true),
  mapping_status: immutableColumn("text", true, "'NEEDS_HUMAN_MAPPING'"),
  human_review_status: immutableColumn("text", true, "'PENDING'"),
  resolved_contact_id: immutableColumn("integer", false),
  mapping_reviewed_by: immutableColumn("text", false),
  mapping_reviewed_at: immutableColumn("timestamp with time zone", false),
  provenance: immutableColumn("jsonb", true, "'{}'"),
  captured_at: immutableColumn("timestamp with time zone", true),
  received_at: immutableColumn("timestamp with time zone", true),
  created_at: immutableColumn("timestamp with time zone", true, "now()"),
  updated_at: immutableColumn("timestamp with time zone", true, "now()")
});

function immutableColumn(dataType, notNull, defaultExpression = "") {
  return Object.freeze({ dataType, notNull, defaultExpression, identityKind: "", generatedKind: "" });
}

function immutableRecord(value) {
  return Object.freeze(value);
}

function check(...definitions) {
  return immutableRecord({ type: "c", columns: [], definitions: definitions.map(canonicalCheckDefinition) });
}

function key(type, columns, definition, extra = {}) {
  return immutableRecord({
    type,
    columns,
    definition: canonicalSchemaDefinition(definition),
    referenceTable: extra.referenceTable || "",
    referenceColumns: extra.referenceColumns || [],
    deleteAction: extra.deleteAction || "",
    updateAction: extra.updateAction || "",
    matchType: extra.matchType || (type === "f" ? "s" : "")
  });
}

const CONSTRAINT_CONTRACT = Object.freeze([
  key("p", ["capture_id"], "PRIMARY KEY (capture_id)"),
  key("u", ["device_id", "runtime_thread_fingerprint", "capture_revision"], "UNIQUE (device_id, runtime_thread_fingerprint, capture_revision)"),
  key("u", ["device_id", "runtime_thread_fingerprint", "capture_fingerprint"], "UNIQUE (device_id, runtime_thread_fingerprint, capture_fingerprint)"),
  key("f", ["device_id"], "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a"
  }),
  key("f", ["resolved_contact_id"], "FOREIGN KEY (resolved_contact_id) REFERENCES contacts(id) ON DELETE RESTRICT", {
    referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "r", updateAction: "a"
  }),
  // PostgreSQL may deparse BETWEEN as its equivalent >= / <= conjunction.
  // Both forms express the one fixed capture-schema-version contract.
  check(
    "char_length(capture_schema_version) BETWEEN 1 AND 80",
    "char_length(capture_schema_version) >= 1 AND char_length(capture_schema_version) <= 80"
  ),
  check("source_platform = 'tinder'"),
  check("source_package = 'com.tinder'"),
  check("capture_safety_status = 'SAFE'"),
  check("runtime_thread_fingerprint ~ '^[0-9a-f]{64}$'"),
  check("capture_fingerprint ~ '^[0-9a-f]{64}$'"),
  check("capture_revision > 0"),
  check("jsonb_typeof(visible_thread_metadata) = 'object'"),
  check("jsonb_typeof(visible_messages) = 'array'"),
  check("mapping_status IN ('NEEDS_HUMAN_MAPPING', 'RESOLVED', 'CONFLICT')"),
  check("human_review_status IN ('PENDING', 'CONFIRMED', 'REJECTED')"),
  check("jsonb_typeof(provenance) = 'object'"),
  check("(mapping_status = 'RESOLVED') = (resolved_contact_id IS NOT NULL)")
]);

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function safeCanonicalCheck(value) {
  try {
    return canonicalCheckDefinition(value);
  } catch {
    return null;
  }
}

function safeCanonicalDefinition(value) {
  try {
    return canonicalSchemaDefinition(value);
  } catch {
    return null;
  }
}

function normalizedCatalogAction(value) {
  return String(value || "").trim();
}

function constraintMatches(row, specification) {
  // PostgreSQL records every referenced column in conkey for a CHECK. Those
  // implementation details are not part of a CHECK's semantic contract;
  // unlike keys/FKs, compare them only for non-CHECK constraints.
  if (row.contype !== specification.type ||
      (specification.type !== "c" && !sameArray(row.column_names, specification.columns))) return false;
  if (row.convalidated !== true || row.condeferrable !== false || row.condeferred !== false) return false;
  if (specification.type === "c") return specification.definitions.includes(safeCanonicalCheck(row.constraint_definition));
  return safeCanonicalDefinition(row.constraint_definition) === specification.definition
    // pg's LEFT JOIN yields null for PK/UNIQUE rows; the contract's empty
    // reference value represents that same non-FK state.
    && String(row.reference_table || "") === specification.referenceTable
    && sameArray(row.reference_column_names, specification.referenceColumns)
    && normalizedCatalogAction(row.confdeltype) === specification.deleteAction
    && normalizedCatalogAction(row.confupdtype) === specification.updateAction
    && normalizedCatalogAction(row.confmatchtype) === specification.matchType;
}

async function inspectCaptureTablePresence(client) {
  const result = await client.query("SELECT to_regclass($1) AS relation_name", [TINDER_VISIBLE_CHAT_CAPTURE_TABLE]);
  return result.rows[0]?.relation_name ? "PRESENT" : "ABSENT";
}

async function readCaptureRelation(client) {
  return client.query(`
    SELECT c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = $1
  `, [TINDER_VISIBLE_CHAT_CAPTURE_TABLE]);
}

async function readCaptureColumns(client) {
  return client.query(`
    SELECT a.attname AS column_name,
      format_type(a.atttypid, a.atttypmod) AS data_type,
      a.attnotnull AS not_null,
      COALESCE(pg_get_expr(d.adbin, d.adrelid, true), '') AS column_default,
      a.attidentity AS identity_kind,
      a.attgenerated AS generated_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = current_schema()
      AND c.relname = $1
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attnum
  `, [TINDER_VISIBLE_CHAT_CAPTURE_TABLE]);
}

async function readCaptureConstraints(client) {
  return client.query(`
    SELECT c.contype, c.convalidated, c.condeferrable, c.condeferred,
      c.confdeltype, c.confupdtype, c.confmatchtype,
      pg_get_constraintdef(c.oid, true) AS constraint_definition,
      ref.relname AS reference_table,
      ARRAY(
        SELECT a.attname::text
        FROM unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum
        ORDER BY key.ordinality
      ) AS column_names,
      ARRAY(
        SELECT a.attname::text
        FROM unnest(c.confkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = key.attnum
        ORDER BY key.ordinality
      ) AS reference_column_names
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    LEFT JOIN pg_class ref ON ref.oid = c.confrelid
    WHERE n.nspname = current_schema()
      AND rel.relname = $1
      AND c.contype IN ('p', 'u', 'f', 'c')
  `, [TINDER_VISIBLE_CHAT_CAPTURE_TABLE]);
}

async function assertContactsReferenceCompatible(client) {
  const result = await client.query(`
    SELECT c.relkind, format_type(a.atttypid, a.atttypmod) AS data_type, a.attnotnull AS not_null
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = current_schema()
      AND c.relname = 'contacts'
      AND a.attname = 'id'
      AND a.attnum > 0
      AND NOT a.attisdropped
  `);
  const row = result.rows[0];
  if (!row || row.relkind !== "r" || row.data_type !== "integer" || row.not_null !== true) {
    throw new Error("Tinder visible-chat capture migration requires compatible contacts(id).");
  }
}

function hasExactColumns(rows) {
  const actual = new Map(rows.map(row => [row.column_name, row]));
  return actual.size === Object.keys(COLUMN_CONTRACT).length
    && Object.entries(COLUMN_CONTRACT).every(([column, contract]) => {
      const row = actual.get(column);
      return row
        && row.data_type === contract.dataType
        && row.not_null === contract.notNull
        && normalizedCatalogAction(row.identity_kind) === contract.identityKind
        && normalizedCatalogAction(row.generated_kind) === contract.generatedKind
        && safeCanonicalDefinition(row.column_default || "") === safeCanonicalDefinition(contract.defaultExpression);
    });
}

function hasExactConstraints(rows) {
  if (rows.length !== CONSTRAINT_CONTRACT.length) return false;
  const remaining = [...rows];
  for (const specification of CONSTRAINT_CONTRACT) {
    const matches = remaining.filter(row => constraintMatches(row, specification));
    if (matches.length !== 1) return false;
    remaining.splice(remaining.indexOf(matches[0]), 1);
  }
  return remaining.length === 0;
}

/** Read-only table state inspection. It never creates or repairs the table. */
export async function inspectTinderVisibleChatCaptureSchema(client) {
  if (await inspectCaptureTablePresence(client) === "ABSENT") return { state: "ABSENT" };
  // A pg Client owns one wire-protocol query stream. Keep the catalog reads
  // sequential rather than issuing concurrent query calls on that client.
  const relation = await readCaptureRelation(client);
  const columns = await readCaptureColumns(client);
  const constraints = await readCaptureConstraints(client);
  const canonical = relation.rows.length === 1
    && relation.rows[0]?.relkind === "r"
    && hasExactColumns(columns.rows)
    && hasExactConstraints(constraints.rows);
  return { state: canonical ? "CANONICAL" : "INVALID" };
}

/**
 * Full T2 migration preflight. Foundation and T1 contracts must already be
 * canonical; ACK uses the existing explicit-runner semantic-equivalence
 * check. An absent capture table is the only mutable state; a partial or
 * unknown table never receives DDL from this runner.
 */
export async function preflightTinderVisibleChatCaptureMigration(client) {
  await preflightDeviceBridgeFoundationForT1(client);
  // This explicit DDL runner uses the same bounded semantic-equivalence-safe
  // ACK check as the existing T1 runner. Runtime startup remains strict.
  await preflightDeviceBridgeAckSchemaForT1Migration(client);
  await assertDeviceBridgeT1SchemaReady(client);
  await assertContactsReferenceCompatible(client);
  const capture = await inspectTinderVisibleChatCaptureSchema(client);
  if (capture.state === "INVALID") {
    throw new Error("Tinder visible-chat capture schema is incompatible.");
  }
  return { capture, mutate: capture.state === "ABSENT" };
}

export async function assertTinderVisibleChatCaptureSchemaReady(client) {
  const inspection = await inspectTinderVisibleChatCaptureSchema(client);
  if (inspection.state !== "CANONICAL") {
    throw new Error("Tinder visible-chat capture schema is not ready.");
  }
  return inspection;
}

export { COLUMN_CONTRACT as TINDER_VISIBLE_CHAT_CAPTURE_COLUMN_CONTRACT, CONSTRAINT_CONTRACT as TINDER_VISIBLE_CHAT_CAPTURE_CONSTRAINT_CONTRACT };
