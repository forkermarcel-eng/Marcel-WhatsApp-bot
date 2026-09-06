import { canonicalCheckDefinition, canonicalSchemaDefinition } from "./schema-contract.js";

/* ==================================================
TINDER FOUNDATIONS — READ-ONLY CONSTRAINT CONTRACTS

Shared catalog comparison for the explicit T3–T6 migration preflights.
It only recognizes already-existing schema.  No SQL from a caller reaches
this module and it contains no DDL, transaction, route, or runtime behavior.
================================================== */

function immutable(value) {
  return Object.freeze(value);
}

/**
 * The foundation migrations use a deliberately small set of PostgreSQL
 * defaults.  Catalog output may add casts, qualification or harmless outer
 * parentheses, so compare their stable semantic form rather than an exact
 * pg_get_expr rendering.  This is catalog-only recognition; it never accepts
 * caller-provided SQL and it does not execute any schema operation.
 */
export const TINDER_FOUNDATION_DEFAULT = Object.freeze({
  NONE: "",
  BIGSERIAL: Object.freeze({ kind: "BIGSERIAL" }),
  NOW: "now()",
  EMPTY_JSON_OBJECT: "'{}'"
});

function unwrapOuterParentheses(value) {
  let result = value;
  while (result.startsWith("(") && result.endsWith(")")) {
    let depth = 0;
    let wrapsWholeExpression = true;
    for (let index = 0; index < result.length; index += 1) {
      const character = result[index];
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (depth === 0 && index < result.length - 1) {
        wrapsWholeExpression = false;
        break;
      }
    }
    if (!wrapsWholeExpression || depth !== 0) break;
    result = result.slice(1, -1);
  }
  return result;
}

export function canonicalTinderFoundationDefault(value) {
  const compact = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\bpg_catalog\./g, "")
    .replace(/\bcurrent_timestamp(?:\(\d+\))?\b/g, "now()")
    .replace(/::(?:[a-z_][a-z0-9_]*)(?:\[\])?/g, "")
    .replace(/\s+/g, "");
  return unwrapOuterParentheses(compact);
}

export function matchesTinderFoundationDefault(actual, expected) {
  const normalizedActual = canonicalTinderFoundationDefault(actual);
  if (expected?.kind === "BIGSERIAL") {
    // BIGSERIAL names its backing sequence from the relation/column.  The
    // sequence's namespace rendering varies by PostgreSQL version, while the
    // contract-relevant behaviour is a server-owned nextval default.
    return /^nextval\('[^']+'\)$/.test(normalizedActual);
  }
  return normalizedActual === canonicalTinderFoundationDefault(expected);
}

export function tinderFoundationCheck(table, ...definitions) {
  return immutable({
    table,
    type: "c",
    columns: [],
    sources: definitions,
    definitions: definitions.map(canonicalCheckDefinition)
  });
}

export function tinderFoundationKey(table, type, columns, definition, extra = {}) {
  return immutable({
    table,
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

function sameArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
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

function constraintMatches(row, contract) {
  if (row.table_name !== contract.table
      || row.contype !== contract.type
      || row.convalidated !== true
      || row.condeferrable !== false
      || row.condeferred !== false) {
    return false;
  }
  if (contract.type === "c") {
    return contract.definitions.includes(safeCanonicalCheck(row.constraint_definition));
  }
  return sameArray(row.column_names, contract.columns)
    && safeCanonicalDefinition(row.constraint_definition) === contract.definition
    && String(row.reference_table || "") === contract.referenceTable
    && sameArray(row.reference_column_names, contract.referenceColumns)
    && normalizedCatalogAction(row.confdeltype) === contract.deleteAction
    && normalizedCatalogAction(row.confupdtype) === contract.updateAction
    && normalizedCatalogAction(row.confmatchtype) === contract.matchType;
}

/**
 * Read only catalog query for the given fixed local relation names.  The
 * result contains enough metadata to distinguish a missing, weakened,
 * deferrable, or wrong-target PK/UNIQUE/FK/CHECK from the reviewed contract.
 */
export async function readTinderFoundationConstraints(client, relations) {
  return client.query(`
    SELECT rel.relname AS table_name,
           c.contype,
           c.convalidated,
           c.condeferrable,
           c.condeferred,
           c.confdeltype,
           c.confupdtype,
           c.confmatchtype,
           pg_get_constraintdef(c.oid, true) AS constraint_definition,
           ref.relname AS reference_table,
           ARRAY(
             SELECT attribute.attname::text
               FROM unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality)
               JOIN pg_attribute attribute
                 ON attribute.attrelid = c.conrelid
                AND attribute.attnum = key.attnum
              ORDER BY key.ordinality
           ) AS column_names,
           ARRAY(
             SELECT attribute.attname::text
               FROM unnest(c.confkey) WITH ORDINALITY AS key(attnum, ordinality)
               JOIN pg_attribute attribute
                 ON attribute.attrelid = c.confrelid
                AND attribute.attnum = key.attnum
              ORDER BY key.ordinality
           ) AS reference_column_names
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_namespace namespace ON namespace.oid = rel.relnamespace
      LEFT JOIN pg_class ref ON ref.oid = c.confrelid
     WHERE namespace.nspname = current_schema()
       AND rel.relname = ANY($1)
       AND c.contype IN ('p', 'u', 'f', 'c')
  `, [relations]);
}

/**
 * Requires every reviewed contract item.  Fresh T3–T6 tables must contain no
 * additional or substituted constraints; prerequisite tables are already
 * validated by their earlier schema inspector and may retain their contract.
 */
export function hasExpectedTinderFoundationConstraints(rows, contract, {
  exactTables = []
} = {}) {
  if (!Array.isArray(rows) || !Array.isArray(contract)) return false;
  const remaining = [...rows];
  for (const expected of contract) {
    const matches = remaining.filter(row => constraintMatches(row, expected));
    if (matches.length !== 1) return false;
    remaining.splice(remaining.indexOf(matches[0]), 1);
  }
  const exact = new Set(exactTables);
  return remaining.every(row => !exact.has(row.table_name));
}
