import {
  ACK_REQUIRED_CHECKS,
  FINAL_ACK_CHECK_EXPRESSION
} from "./ack-schema.js";
import {
  READ_ONLY_GUARD_CODE,
  withDeviceBridgeReadOnlyTransaction
} from "./read-only-transaction.js";

/* ==================================================
DEVICE BRIDGE — BOUNDED ACK PAYLOAD SEMANTIC CLASSIFIER
================================================== */

const SUPPORTED_STATUSES = Object.freeze([
  "RECEIVED",
  "SUCCEEDED",
  "FAILED",
  "REJECTED",
  "EXPIRED"
]);
const PAYLOAD_COLUMNS = Object.freeze(
  [...(ACK_REQUIRED_CHECKS.find(specification => specification.id === "ACK_PAYLOAD_V1")?.columns || [])]
);
const RESULT_ERROR_COMBINATIONS = Object.freeze([
  Object.freeze({ result_kind: "NULL", error_kind: "NULL" }),
  Object.freeze({ result_kind: "NULL", error_kind: "OBJECT" }),
  Object.freeze({ result_kind: "OBJECT", error_kind: "NULL" }),
  Object.freeze({ result_kind: "OBJECT", error_kind: "OBJECT" })
]);
const STATUS_CLASSIFICATIONS = new Set([
  "MATCH",
  "PRODUCTION_STRONGER",
  "PRODUCTION_WEAKER",
  "PRODUCTION_DIFFERENT",
  "UNRESOLVED"
]);
const OVERALL_CLASSIFICATIONS = new Set([
  "SEMANTICALLY_EQUIVALENT",
  "PRODUCTION_LEGACY_WEAKER",
  "PRODUCTION_LEGACY_STRONGER",
  "PRODUCTION_PARTIAL_RULE",
  "PRODUCTION_DRIFT",
  "UNRESOLVED"
]);
const EXPECTED_CASES = Object.freeze(
  SUPPORTED_STATUSES.flatMap((status, statusIndex) => RESULT_ERROR_COMBINATIONS.map((combination, combinationIndex) => Object.freeze({
    case_id: statusIndex * RESULT_ERROR_COMBINATIONS.length + combinationIndex + 1,
    status,
    ...combination
  })))
);

/*
 * The only catalog target is a validated, nondeferrable ACK CHECK on the
 * fixed payload columns. Function and non-immutable pg_catalog operator
 * dependencies fail closed before any expression is evaluated dynamically.
 * This keeps the bounded matrix limited to null/object payload semantics.
 */
const FIND_PAYLOAD_CONSTRAINT_QUERY = `
  SELECT c.oid::text AS constraint_oid,
    (
      NOT EXISTS (
        SELECT 1
        FROM pg_depend dependency
        WHERE dependency.classid = 'pg_constraint'::regclass
          AND dependency.objid = c.oid
          AND dependency.refclassid = 'pg_proc'::regclass
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_depend dependency
        JOIN pg_operator operator_definition ON operator_definition.oid = dependency.refobjid
        JOIN pg_proc operator_procedure ON operator_procedure.oid = operator_definition.oprcode
        JOIN pg_namespace operator_namespace ON operator_namespace.oid = operator_definition.oprnamespace
        WHERE dependency.classid = 'pg_constraint'::regclass
          AND dependency.objid = c.oid
          AND dependency.refclassid = 'pg_operator'::regclass
          AND (operator_namespace.nspname <> 'pg_catalog' OR operator_procedure.provolatile <> 'i')
      )
    ) AS evaluator_safe
  FROM pg_constraint c
  WHERE c.conrelid = 'device_bridge_command_acks'::regclass
    AND c.contype = 'c'
    AND c.convalidated = true
    AND c.condeferrable = false
    AND c.condeferred = false
    AND ARRAY(
      SELECT attribute.attname::text
      FROM unnest(c.conkey) AS key(attnum)
      JOIN pg_attribute attribute
        ON attribute.attrelid = c.conrelid AND attribute.attnum = key.attnum
      ORDER BY attribute.attname
    ) = ARRAY['error', 'result', 'status']::text[]
    AND octet_length(pg_get_expr(c.conbin, c.conrelid, true)) BETWEEN 1 AND 4096
  ORDER BY c.oid ASC
  LIMIT 2
`;

/*
 * query_to_xml keeps pg_get_expr() and the generated SELECT inside
 * PostgreSQL. XMLTABLE returns only fixed case IDs and boolean outcomes to
 * this process; neither a definition nor the synthetic values reach HTTP.
 */
const EVALUATE_PAYLOAD_MATRIX_QUERY = `
  SELECT observed.case_id, observed.production_accepts, observed.canonical_accepts
  FROM XMLTABLE(
    '/table/row'
    PASSING query_to_xml(
      format(
        $matrix$
          SELECT device_bridge_command_acks.case_id,
            ((%s) IS NOT FALSE) AS production_accepts,
            ((%s) IS NOT FALSE) AS canonical_accepts
          FROM (
            VALUES
              (1, 'RECEIVED'::text, NULL::jsonb, NULL::jsonb),
              (2, 'RECEIVED'::text, NULL::jsonb, '{}'::jsonb),
              (3, 'RECEIVED'::text, '{}'::jsonb, NULL::jsonb),
              (4, 'RECEIVED'::text, '{}'::jsonb, '{}'::jsonb),
              (5, 'SUCCEEDED'::text, NULL::jsonb, NULL::jsonb),
              (6, 'SUCCEEDED'::text, NULL::jsonb, '{}'::jsonb),
              (7, 'SUCCEEDED'::text, '{}'::jsonb, NULL::jsonb),
              (8, 'SUCCEEDED'::text, '{}'::jsonb, '{}'::jsonb),
              (9, 'FAILED'::text, NULL::jsonb, NULL::jsonb),
              (10, 'FAILED'::text, NULL::jsonb, '{}'::jsonb),
              (11, 'FAILED'::text, '{}'::jsonb, NULL::jsonb),
              (12, 'FAILED'::text, '{}'::jsonb, '{}'::jsonb),
              (13, 'REJECTED'::text, NULL::jsonb, NULL::jsonb),
              (14, 'REJECTED'::text, NULL::jsonb, '{}'::jsonb),
              (15, 'REJECTED'::text, '{}'::jsonb, NULL::jsonb),
              (16, 'REJECTED'::text, '{}'::jsonb, '{}'::jsonb),
              (17, 'EXPIRED'::text, NULL::jsonb, NULL::jsonb),
              (18, 'EXPIRED'::text, NULL::jsonb, '{}'::jsonb),
              (19, 'EXPIRED'::text, '{}'::jsonb, NULL::jsonb),
              (20, 'EXPIRED'::text, '{}'::jsonb, '{}'::jsonb)
          ) AS device_bridge_command_acks(case_id, status, result, error)
          ORDER BY device_bridge_command_acks.case_id
        $matrix$,
        (
          SELECT pg_get_expr(c.conbin, c.conrelid, true)
          FROM pg_constraint c
          WHERE c.oid = $1::oid
        ),
        $2
      ),
      false,
      false,
      ''
    )
    COLUMNS
      case_id integer PATH 'case_id',
      production_accepts boolean PATH 'production_accepts',
      canonical_accepts boolean PATH 'canonical_accepts'
  ) AS observed
  ORDER BY observed.case_id
`;

function unresolvedClassification() {
  return {
    status_rules: Object.fromEntries(SUPPORTED_STATUSES.map(status => [status, "UNRESOLVED"])),
    overall_classification: "UNRESOLVED",
    production_can_accept_rows_canonical_rejects: "UNRESOLVED",
    canonical_can_accept_rows_production_rejects: "UNRESOLVED"
  };
}

function unresolvedResult() {
  return {
    ok: true,
    classification: unresolvedClassification(),
    reason_code: "SEMANTIC_CLASSIFICATION_UNRESOLVED"
  };
}

function unavailableResult(error) {
  return {
    ok: false,
    reason_code: error?.code === READ_ONLY_GUARD_CODE
      ? "SEMANTIC_CLASSIFIER_GUARD_BLOCKED"
      : "SEMANTIC_CLASSIFIER_UNAVAILABLE"
  };
}

function isExpectedTarget(target) {
  return target
    && typeof target.constraint_oid === "string"
    && /^\d+$/.test(target.constraint_oid)
    && target.evaluator_safe === true
    && PAYLOAD_COLUMNS.join(",") === "error,result,status";
}

async function findAckPayloadConstraint(client) {
  return client.query(FIND_PAYLOAD_CONSTRAINT_QUERY);
}

async function evaluateAckPayloadMatrix(client, constraintOid) {
  return client.query(EVALUATE_PAYLOAD_MATRIX_QUERY, [constraintOid, FINAL_ACK_CHECK_EXPRESSION]);
}

function parseMatrix(rows) {
  if (!Array.isArray(rows) || rows.length !== EXPECTED_CASES.length) return null;
  const byCaseId = new Map();

  for (const row of rows) {
    const caseId = Number(row?.case_id);
    if (!Number.isSafeInteger(caseId) || byCaseId.has(caseId)) return null;
    if (typeof row?.production_accepts !== "boolean" || typeof row?.canonical_accepts !== "boolean") return null;
    byCaseId.set(caseId, {
      production_accepts: row.production_accepts,
      canonical_accepts: row.canonical_accepts
    });
  }

  const matrix = [];
  for (const expected of EXPECTED_CASES) {
    const outcome = byCaseId.get(expected.case_id);
    if (!outcome) return null;
    matrix.push({ ...expected, ...outcome });
  }
  return matrix;
}

function classifyStatus(rows) {
  if (rows.length !== RESULT_ERROR_COMBINATIONS.length) return "UNRESOLVED";
  let productionExtra = false;
  let canonicalExtra = false;
  for (const row of rows) {
    if (row.production_accepts && !row.canonical_accepts) productionExtra = true;
    if (row.canonical_accepts && !row.production_accepts) canonicalExtra = true;
  }
  if (!productionExtra && !canonicalExtra) return "MATCH";
  if (productionExtra && !canonicalExtra) return "PRODUCTION_WEAKER";
  if (!productionExtra && canonicalExtra) return "PRODUCTION_STRONGER";
  return "PRODUCTION_DIFFERENT";
}

function hasMissingSupportedRule(rowsByStatus) {
  return SUPPORTED_STATUSES.some(status => {
    const rows = rowsByStatus.get(status) || [];
    return rows.some(row => row.canonical_accepts) && rows.every(row => !row.production_accepts);
  });
}

function overallClassification(statusRules, rowsByStatus) {
  const values = Object.values(statusRules);
  if (values.some(value => value === "UNRESOLVED")) return "UNRESOLVED";
  const hasWeaker = values.includes("PRODUCTION_WEAKER");
  const hasStronger = values.includes("PRODUCTION_STRONGER");
  const hasDifferent = values.includes("PRODUCTION_DIFFERENT");
  if (!hasWeaker && !hasStronger && !hasDifferent) return "SEMANTICALLY_EQUIVALENT";
  if (!hasWeaker && !hasDifferent && hasMissingSupportedRule(rowsByStatus)) return "PRODUCTION_PARTIAL_RULE";
  if (!hasStronger && !hasDifferent) return "PRODUCTION_LEGACY_WEAKER";
  if (!hasWeaker && !hasDifferent) return "PRODUCTION_LEGACY_STRONGER";
  return "PRODUCTION_DRIFT";
}

function classifyMatrix(matrix) {
  const rowsByStatus = new Map(SUPPORTED_STATUSES.map(status => [status, []]));
  for (const row of matrix) rowsByStatus.get(row.status)?.push(row);

  const statusRules = Object.fromEntries(SUPPORTED_STATUSES.map(status => [
    status,
    classifyStatus(rowsByStatus.get(status) || [])
  ]));
  if (Object.values(statusRules).some(value => !STATUS_CLASSIFICATIONS.has(value))) return unresolvedClassification();

  const productionCanAcceptRowsCanonicalRejects = matrix.some(row => row.production_accepts && !row.canonical_accepts);
  const canonicalCanAcceptRowsProductionRejects = matrix.some(row => row.canonical_accepts && !row.production_accepts);
  const overall = overallClassification(statusRules, rowsByStatus);
  if (!OVERALL_CLASSIFICATIONS.has(overall)) return unresolvedClassification();
  return {
    status_rules: statusRules,
    overall_classification: overall,
    production_can_accept_rows_canonical_rejects: productionCanAcceptRowsCanonicalRejects,
    canonical_can_accept_rows_production_rejects: canonicalCanAcceptRowsProductionRejects
  };
}

/**
 * Classifies only the one bounded ACK payload CHECK. Test dependencies are
 * private seams; request handlers cannot provide SQL, target names, or data.
 */
export async function runDeviceBridgeAckPayloadSemanticClassifier(pool, dependencies = {}) {
  const findConstraint = dependencies.findConstraint || findAckPayloadConstraint;
  const evaluateMatrix = dependencies.evaluateMatrix || evaluateAckPayloadMatrix;

  try {
    return await withDeviceBridgeReadOnlyTransaction(pool, async client => {
      const targets = await findConstraint(client);
      if (!Array.isArray(targets?.rows) || targets.rows.length !== 1 || !isExpectedTarget(targets.rows[0])) {
        return unresolvedResult();
      }

      let evaluated;
      try {
        evaluated = await evaluateMatrix(client, targets.rows[0].constraint_oid);
      } catch (error) {
        if (error?.code === READ_ONLY_GUARD_CODE) throw error;
        return unresolvedResult();
      }
      const matrix = parseMatrix(evaluated?.rows);
      if (!matrix) return unresolvedResult();

      const classification = classifyMatrix(matrix);
      return {
        ok: true,
        classification,
        reason_code: classification.overall_classification === "UNRESOLVED"
          ? "SEMANTIC_CLASSIFICATION_UNRESOLVED"
          : "SEMANTIC_CLASSIFICATION_COMPLETE"
      };
    });
  } catch (error) {
    return unavailableResult(error);
  }
}
