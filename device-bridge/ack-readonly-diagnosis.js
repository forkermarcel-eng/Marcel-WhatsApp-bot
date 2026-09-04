import {
  ACK_FOUNDATION_TABLE,
  ACK_REQUIRED_CHECKS,
  ACK_REQUIRED_COLUMN_TYPES,
  hasExpectedAckCheckDefinition,
  readDeviceBridgeAckCheckConstraints
} from "./ack-schema.js";
import {
  FOUNDATION_COLUMN_CONTRACT,
  FOUNDATION_CONSTRAINT_CONTRACT,
  FOUNDATION_INDEX_CONTRACT
} from "./schema-readiness.js";
import { canonicalCheckDefinition, canonicalSchemaDefinition } from "./schema-contract.js";
import {
  READ_ONLY_GUARD_CODE,
  withDeviceBridgeReadOnlyTransaction
} from "./read-only-transaction.js";

/* ==================================================
DEVICE BRIDGE — BOUNDED ACK FOUNDATION DIAGNOSIS
================================================== */

const ACK_COLUMN_CONTRACT = FOUNDATION_COLUMN_CONTRACT[ACK_FOUNDATION_TABLE];
const ACK_KEY_CONTRACT = FOUNDATION_CONSTRAINT_CONTRACT.filter(contract =>
  contract.table === ACK_FOUNDATION_TABLE && contract.type !== "c"
);
const ACK_INDEX_CONTRACT = FOUNDATION_INDEX_CONTRACT.filter(contract => contract.table === ACK_FOUNDATION_TABLE);
const ACK_ROW_SAFE_COLUMNS = [...Object.keys(ACK_REQUIRED_COLUMN_TYPES), "body_sha256"];
const MAX_OBSERVED_ACK_CHECKS = 8;
const ACK_ROW_COMPATIBILITY_EXPRESSION = ACK_REQUIRED_CHECKS
  .map(specification => `(${specification.expression})`)
  .join("\n      AND ");

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

function normalizedCatalogCode(value) {
  return String(value || "").trim();
}

function normalizedSmallIntArray(value) {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === "string") return value.replace(/[{}]/g, "").split(",").filter(Boolean).map(Number);
  return [];
}

function relationObjectType(row) {
  if (!row) return "MISSING";
  return row.relkind === "r" ? "TABLE" : "NON_TABLE";
}

function columnStatus(row, contract) {
  if (!row) return "MISSING";
  if (row.data_type !== contract.dataType) return "TYPE_MISMATCH";
  if (row.not_null !== contract.notNull) return "NULLABILITY_MISMATCH";
  if ((row.identity_kind || "") !== contract.identityKind) return "IDENTITY_MISMATCH";
  if ((row.generated_kind || "") !== contract.generatedKind) return "GENERATED_MISMATCH";
  if (safeCanonicalDefinition(row.column_default || "") !== safeCanonicalDefinition(contract.defaultExpression)) {
    return "DEFAULT_MISMATCH";
  }
  return "MATCH";
}

function keyMatches(row, contract) {
  return row.contype === contract.type
    && row.convalidated === true
    && row.condeferrable === false
    && row.condeferred === false
    && sameArray(row.column_names, contract.columns)
    && String(row.reference_table || "") === String(contract.referenceTable || "")
    && sameArray(row.reference_column_names, contract.referenceColumns || [])
    && normalizedCatalogCode(row.confdeltype) === String(contract.deleteAction || "")
    && normalizedCatalogCode(row.confupdtype) === String(contract.updateAction || "")
    && normalizedCatalogCode(row.confmatchtype) === String(contract.matchType || "");
}

function keyRule(contract) {
  if (contract.type === "p") return "ACK_PRIMARY_KEY";
  if (contract.type === "u") return "ACK_UNIQUE_COMMAND_STATUS";
  return contract.columns.length === 1 ? "ACK_FOREIGN_KEY_DEVICE" : "ACK_FOREIGN_KEY_COMMAND_DEVICE";
}

function actionName(value) {
  return ({ a: "NO_ACTION", r: "RESTRICT", c: "CASCADE", n: "SET_NULL", d: "SET_DEFAULT" })[value] || "OTHER";
}

function keyObservation(row) {
  if (!row) return null;
  return {
    constraint_type: row.contype || null,
    columns: Array.isArray(row.column_names) ? row.column_names : [],
    reference_table: row.reference_table || null,
    reference_columns: Array.isArray(row.reference_column_names) ? row.reference_column_names : [],
    delete_action: row.contype === "f" ? actionName(row.confdeltype) : null,
    update_action: row.contype === "f" ? actionName(row.confupdtype) : null,
    match_type: row.contype === "f" ? (row.confmatchtype === "s" ? "SIMPLE" : "OTHER") : null,
    validation: checkAttributes(row)
  };
}

function indexMatches(row, contract) {
  return row.index_name === contract.name
    && row.indisunique === contract.unique
    && row.indisvalid === true
    && row.indisready === true
    && row.access_method === "btree"
    && sameArray(row.key_expressions?.map(safeCanonicalDefinition), contract.keys.map(safeCanonicalDefinition))
    && sameArray(normalizedSmallIntArray(row.key_options), contract.options)
    && safeCanonicalDefinition(row.predicate || "") === safeCanonicalDefinition(contract.predicate);
}

async function readAckRelation(client) {
  return client.query(`
    SELECT c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = $1
  `, [ACK_FOUNDATION_TABLE]);
}

async function readAckColumns(client) {
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
  `, [ACK_FOUNDATION_TABLE]);
}

async function readAckKeyConstraints(client) {
  return client.query(`
    SELECT c.contype, c.convalidated, c.condeferrable, c.condeferred,
      c.confdeltype, c.confupdtype, c.confmatchtype,
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
      AND c.contype IN ('p', 'u', 'f')
  `, [ACK_FOUNDATION_TABLE]);
}

async function readAckIndexes(client) {
  return client.query(`
    SELECT idx.relname AS index_name,
      i.indisunique, i.indisvalid, i.indisready, am.amname AS access_method,
      ARRAY(
        SELECT pg_get_indexdef(i.indexrelid, key_number.position, true)
        FROM generate_series(1, i.indnkeyatts) AS key_number(position)
        ORDER BY key_number.position
      ) AS key_expressions,
      ARRAY(
        SELECT ((i.indoption::int2[])[key_number.position - 1])::int
        FROM generate_series(1, i.indnkeyatts) AS key_number(position)
        ORDER BY key_number.position
      ) AS key_options,
      COALESCE(pg_get_expr(i.indpred, i.indrelid, true), '') AS predicate
    FROM pg_index i
    JOIN pg_class rel ON rel.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_am am ON am.oid = idx.relam
    LEFT JOIN pg_constraint backing ON backing.conindid = i.indexrelid
    WHERE n.nspname = current_schema()
      AND rel.relname = $1
      AND backing.oid IS NULL
  `, [ACK_FOUNDATION_TABLE]);
}

function summarizeColumns(rows) {
  const actual = new Map(rows.map(row => [row.column_name, row]));
  const columns = Object.entries(ACK_COLUMN_CONTRACT).map(([name, contract]) => {
    const row = actual.get(name);
    return {
      name,
      expected_data_type: contract.dataType,
      expected_not_null: contract.notNull,
      expected_default: contract.defaultExpression ? "REQUIRED" : "NONE",
      present: Boolean(row),
      data_type: row?.data_type || null,
      not_null: row ? Boolean(row.not_null) : null,
      default_status: row ? (
        safeCanonicalDefinition(row.column_default || "") === safeCanonicalDefinition(contract.defaultExpression)
          ? "MATCH" : "MISMATCH"
      ) : "NOT_CHECKED",
      status: columnStatus(row, contract)
    };
  });
  return {
    columns,
    unexpected_column_count: rows.filter(row => !Object.hasOwn(ACK_COLUMN_CONTRACT, row.column_name)).length,
    compatible: columns.every(column => column.status === "MATCH")
      && rows.length === Object.keys(ACK_COLUMN_CONTRACT).length
  };
}

function summarizeKeys(rows) {
  const exactRows = new Set();
  const relationships = ACK_KEY_CONTRACT.map(contract => {
    const candidates = rows.filter(row => row.contype === contract.type && sameArray(row.column_names, contract.columns));
    const exact = candidates.filter(row => keyMatches(row, contract));
    for (const row of exact) exactRows.add(row);
    const observed = candidates[0] || rows.find(row => row.contype === contract.type) || null;
    return {
      rule: keyRule(contract),
      columns: contract.columns,
      reference_table: contract.referenceTable || null,
      reference_columns: contract.referenceColumns.length ? contract.referenceColumns : null,
      delete_action: contract.deleteAction || null,
      update_action: contract.updateAction || null,
      status: exact.length === 1 && candidates.length === 1
        ? "MATCH"
        : exact.length > 1 ? "DUPLICATE"
          : candidates.length === 0 ? "MISSING" : "MISMATCH",
      actual: keyObservation(observed)
    };
  });
  return {
    relationships,
    unexpected_constraint_count: rows.filter(row => !exactRows.has(row)).length,
    compatible: relationships.every(relationship => relationship.status === "MATCH")
      && rows.length === ACK_KEY_CONTRACT.length
  };
}

function summarizeIndexes(rows) {
  const required = ACK_INDEX_CONTRACT.map(contract => {
    const candidates = rows.filter(row => row.index_name === contract.name);
    const exact = candidates.filter(row => indexMatches(row, contract));
    const observed = candidates[0] || null;
    return {
      name: contract.name,
      unique: contract.unique,
      keys: contract.keys,
      order_options: contract.options,
      predicate_required: contract.predicate ? "YES" : "NO",
      status: exact.length === 1 && candidates.length === 1
        ? "MATCH"
        : exact.length > 1 ? "DUPLICATE"
          : candidates.length === 0 ? "MISSING" : "MISMATCH",
      actual: observed ? {
        unique: observed.indisunique === true,
        valid: observed.indisvalid === true,
        ready: observed.indisready === true,
        access_method: observed.access_method || null,
        key_status: sameArray(observed.key_expressions?.map(safeCanonicalDefinition), contract.keys.map(safeCanonicalDefinition))
          ? "MATCH" : "MISMATCH",
        order_status: sameArray(normalizedSmallIntArray(observed.key_options), contract.options) ? "MATCH" : "MISMATCH",
        predicate_status: safeCanonicalDefinition(observed.predicate || "") === safeCanonicalDefinition(contract.predicate)
          ? "MATCH" : "MISMATCH"
      } : null
    };
  });
  const matched = new Set(rows.filter(row => ACK_INDEX_CONTRACT.some(contract => indexMatches(row, contract))));
  return {
    required,
    unexpected_noncontractual_index_count: rows.filter(row => !matched.has(row)).length,
    unexpected_noncontractual_index_status: rows.some(row => !matched.has(row))
      ? "PRESENT_OUTSIDE_CONTRACT" : "NONE",
    compatible: required.every(index => index.status === "MATCH") && rows.length === ACK_INDEX_CONTRACT.length
  };
}

export async function inspectDeviceBridgeAckFoundationShape(client) {
  const relation = await readAckRelation(client);
  const table = {
    exists: relation.rows.length === 1,
    object_type: relationObjectType(relation.rows[0])
  };
  if (table.object_type !== "TABLE") {
    return {
      table,
      columns: { columns: [], unexpected_column_count: 0, compatible: false },
      keys: { relationships: [], unexpected_constraint_count: 0, compatible: false },
      indexes: {
        required: [],
        unexpected_noncontractual_index_count: 0,
        unexpected_noncontractual_index_status: "NOT_CHECKED",
        compatible: false
      },
      base_contract_compatible: false
    };
  }

  const [columns, keys, indexes] = await Promise.all([
    readAckColumns(client),
    readAckKeyConstraints(client),
    readAckIndexes(client)
  ]);
  const columnSummary = summarizeColumns(columns.rows);
  const keySummary = summarizeKeys(keys.rows);
  const indexSummary = summarizeIndexes(indexes.rows);
  return {
    table,
    columns: columnSummary,
    keys: keySummary,
    indexes: indexSummary,
    base_contract_compatible: columnSummary.compatible && keySummary.compatible && indexSummary.compatible
  };
}

function sameColumns(row, specification) {
  return sameArray(row.column_names, specification.columns);
}

function hasSameCheckSemantics(row, specification) {
  return sameColumns(row, specification)
    && safeCanonicalCheck(row.constraint_definition) === safeCanonicalCheck(specification.expression);
}

function matchingAckCheckSpecification(row) {
  return ACK_REQUIRED_CHECKS.find(specification =>
    safeCanonicalCheck(row.constraint_definition) === safeCanonicalCheck(specification.expression)
  ) || null;
}

function checkAttributes(row) {
  if (row.convalidated !== true) return "UNVALIDATED";
  if (row.condeferrable === true || row.condeferred === true) return "DEFERRABLE";
  return "VALID";
}

function actualCheckRule(candidates) {
  for (const row of candidates) {
    const matching = matchingAckCheckSpecification(row);
    if (matching) return matching.id;
  }
  return candidates.length ? "NONCANONICAL" : "MISSING";
}

function observedAckCheck(row) {
  const matching = matchingAckCheckSpecification(row);
  return {
    columns: Array.isArray(row.column_names) ? row.column_names : [],
    semantic_rule: matching?.id || "NONCANONICAL",
    payload_name_status: matching?.name
      ? (row.conname === matching.name ? "MATCH" : "MISMATCH")
      : "NOT_NAME_CONTRACTUAL",
    validation: checkAttributes(row)
  };
}

export function inspectDeviceBridgeAckCheckContract(rows) {
  const exactRows = new Set();
  const checks = ACK_REQUIRED_CHECKS.map(specification => {
    const candidates = rows.filter(row => sameColumns(row, specification));
    const exact = candidates.filter(row => hasExpectedAckCheckDefinition(row, specification));
    const semantic = candidates.filter(row => hasSameCheckSemantics(row, specification));
    for (const row of exact) exactRows.add(row);

    let status;
    if (exact.length === 1 && candidates.length === 1) status = "MATCH";
    else if (exact.length > 1) status = "DUPLICATE";
    else if (!candidates.length) status = "MISSING";
    else if (semantic.length) {
      const candidate = semantic[0];
      status = specification.name && candidate.conname !== specification.name
        ? "NAME_MISMATCH"
        : checkAttributes(candidate);
    } else status = "DEFINITION_MISMATCH";

    return {
      rule: specification.id,
      expected_name: specification.name || null,
      status,
      actual_rule: actualCheckRule(candidates),
      validation: candidates[0] ? checkAttributes(candidates[0]) : "NOT_CHECKED"
    };
  });

  const unexpected = rows.filter(row => !exactRows.has(row));
  return {
    checks,
    observed: rows.slice(0, MAX_OBSERVED_ACK_CHECKS).map(observedAckCheck),
    observed_truncated: rows.length > MAX_OBSERVED_ACK_CHECKS,
    actual_check_count: rows.length,
    unexpected_check_count: unexpected.length,
    compatible: checks.every(check => check.status === "MATCH") && rows.length === ACK_REQUIRED_CHECKS.length
  };
}

function requiredAckColumnTypesMatch(shape) {
  const columns = new Map(shape.columns.columns.map(column => [column.name, column]));
  return Object.entries(ACK_REQUIRED_COLUMN_TYPES).every(([name, type]) => {
    const column = columns.get(name);
    return column?.present === true && column.data_type === type;
  });
}

function safelyTypedAckRows(shape) {
  const columns = new Map(shape.columns.columns.map(column => [column.name, column]));
  return ACK_ROW_SAFE_COLUMNS.every(name => columns.get(name)?.status === "MATCH");
}

async function inspectAckRows(client, shape) {
  if (shape.table.object_type !== "TABLE" || !safelyTypedAckRows(shape)) {
    return { status: "NOT_CHECKED", incompatible_count: null };
  }
  const compatibility = await client.query(`
    SELECT COUNT(*)::int AS incompatible_count
    FROM ${ACK_FOUNDATION_TABLE}
    WHERE (${ACK_ROW_COMPATIBILITY_EXPRESSION}) IS NOT TRUE
  `);
  const count = Number(compatibility.rows[0]?.incompatible_count);
  if (!Number.isSafeInteger(count) || count < 0) return { status: "NOT_CHECKED", incompatible_count: null };
  return { status: count === 0 ? "COMPATIBLE" : "INCOMPATIBLE", incompatible_count: count };
}

function knownLegacyPayloadConstraint(checks) {
  const payload = checks.checks.find(check => check.rule === "ACK_PAYLOAD_V1");
  return checks.actual_check_count === ACK_REQUIRED_CHECKS.length
    && checks.unexpected_check_count === 1
    && checks.checks.every(check => check.rule === "ACK_PAYLOAD_V1" || check.status === "MATCH")
    && payload?.status === "NAME_MISMATCH";
}

function classifyDiagnosis(shape, checks, rows) {
  if (shape.table.object_type === "MISSING") return "MISSING_ACK_FOUNDATION";
  if (shape.table.object_type !== "TABLE") return "ACK_OBJECT_TYPE_MISMATCH";
  if (!shape.base_contract_compatible || !requiredAckColumnTypesMatch(shape)) {
    const onlyNoncontractualIndexDifference = shape.columns.compatible
      && shape.keys.compatible
      && shape.indexes.required.every(index => index.status === "MATCH")
      && shape.indexes.unexpected_noncontractual_index_count > 0
      && checks.compatible;
    if (onlyNoncontractualIndexDifference) return "NONCONTRACTUAL_ACK_INDEX_PRESENT";
    const hasSomeCanonicalCheck = checks.checks.some(check => check.status === "MATCH" || check.status === "NAME_MISMATCH");
    return hasSomeCanonicalCheck ? "PARTIAL_ACK_FOUNDATION" : "STRUCTURALLY_DRIFTED";
  }
  if (knownLegacyPayloadConstraint(checks)) return "KNOWN_LEGACY_PAYLOAD_CONSTRAINT";
  if (!checks.compatible) {
    const hasSomeCanonicalCheck = checks.checks.some(check => check.status === "MATCH" || check.status === "NAME_MISMATCH");
    return hasSomeCanonicalCheck ? "PARTIAL_ACK_FOUNDATION" : "STRUCTURALLY_DRIFTED";
  }
  if (rows.status === "NOT_CHECKED") return "ACK_ROW_COMPATIBILITY_NOT_CHECKED";
  return rows.status === "INCOMPATIBLE" ? "CANONICAL_SCHEMA_WITH_INCOMPATIBLE_ROWS" : "CANONICAL";
}

function comparatorAssessment(checks) {
  const definitionMismatches = checks.checks.filter(check => check.status === "DEFINITION_MISMATCH");
  return {
    normalizes_equivalent_pg_definitions: true,
    false_positive_status: definitionMismatches.length
      ? "UNRESOLVED_REQUIRES_SEMANTIC_REVIEW"
      : "NOT_IDENTIFIED",
    assessment: definitionMismatches.length
      ? "SOURCE_COMPARATOR_REPORTS_DEFINITION_MISMATCH"
      : "NO_COMPARATOR_FALSE_POSITIVE_IDENTIFIED"
  };
}

function unavailable(reasonCode) {
  return { ok: false, reason_code: reasonCode };
}

/**
 * Runs a fixed, ACK-only catalog/data diagnosis. Test dependencies are an
 * internal seam; HTTP callers cannot provide SQL, object names, or options.
 */
export async function runDeviceBridgeAckReadOnlyDiagnosis(pool, dependencies = {}) {
  const inspectShape = dependencies.inspectShape || inspectDeviceBridgeAckFoundationShape;
  const readChecks = dependencies.readChecks || readDeviceBridgeAckCheckConstraints;
  const inspectChecks = dependencies.inspectChecks || inspectDeviceBridgeAckCheckContract;
  const inspectRows = dependencies.inspectRows || inspectAckRows;

  try {
    return await withDeviceBridgeReadOnlyTransaction(pool, async client => {
      const foundation = await inspectShape(client);
      const checks = foundation.table.object_type === "TABLE"
        ? inspectChecks((await readChecks(client)).rows)
        : {
          checks: [],
          observed: [],
          observed_truncated: false,
          actual_check_count: 0,
          unexpected_check_count: 0,
          compatible: false
        };
      const rows = foundation.table.object_type === "TABLE"
        ? await inspectRows(client, foundation)
        : { status: "NOT_CHECKED", incompatible_count: null };
      const classification = classifyDiagnosis(foundation, checks, rows);
      const contractCompatible = foundation.base_contract_compatible
        && checks.compatible
        && requiredAckColumnTypesMatch(foundation)
        && rows.status === "COMPATIBLE";
      return {
        ok: true,
        diagnosis: {
          table: foundation.table,
          columns: foundation.columns,
          relationships: foundation.keys,
          indexes: foundation.indexes,
          checks,
          row_compatibility: rows,
          classification,
          contract_compatible: contractCompatible,
          comparator: comparatorAssessment(checks)
        },
        reason_code: "ACK_DIAGNOSIS_COMPLETE"
      };
    });
  } catch (error) {
    return unavailable(error?.code === READ_ONLY_GUARD_CODE ? "DIAGNOSIS_GUARD_BLOCKED" : "DIAGNOSIS_UNAVAILABLE");
  }
}
