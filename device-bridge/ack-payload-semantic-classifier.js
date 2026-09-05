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
export const ACK_PAYLOAD_DIAGNOSTIC_STAGES = Object.freeze([
  "CONSTRAINT_DISCOVERY",
  "CONSTRAINT_IDENTITY",
  "SAFE_EVALUATOR_PREPARATION",
  "SYNTHETIC_EVALUATION",
  "CANDIDATE_RESULT_MAPPING",
  "STATUS_CLASSIFICATION",
  "OVERALL_CLASSIFICATION"
]);
export const ACK_PAYLOAD_DIAGNOSTIC_REASON_CODES = Object.freeze([
  "CONSTRAINT_DISCOVERY_INVALID",
  "CONSTRAINT_NOT_FOUND",
  "MULTIPLE_CANDIDATES",
  "CONSTRAINT_IDENTITY_INVALID",
  "EVALUATOR_UNSAFE",
  "CANONICAL_TARGET_INVARIANT_INVALID",
  "EVALUATION_ERROR",
  "CANDIDATE_MATRIX_NOT_ARRAY",
  "CANDIDATE_MATRIX_OVERSIZED",
  "CANDIDATE_MATRIX_INCOMPLETE",
  "CANDIDATE_RESULT_INVALID",
  "STATUS_RESULT_AMBIGUOUS",
  "OVERALL_RESULT_INVALID",
  "UNKNOWN_SAFE_FAILURE"
]);
const DIAGNOSTIC_STAGES = new Set(ACK_PAYLOAD_DIAGNOSTIC_STAGES);
const DIAGNOSTIC_REASON_CODES = new Set(ACK_PAYLOAD_DIAGNOSTIC_REASON_CODES);
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
        $2::text
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

function canonicalStatusList(statuses) {
  const selected = new Set(Array.isArray(statuses) || statuses instanceof Set ? statuses : []);
  return SUPPORTED_STATUSES.filter(status => selected.has(status));
}

function safeCandidateCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= EXPECTED_CASES.length ? value : null;
}

function unresolvedDiagnostic({
  stage,
  reasonCode,
  affectedStatuses = SUPPORTED_STATUSES,
  attempted = 0,
  completed = 0
} = {}) {
  const statuses = canonicalStatusList(affectedStatuses);
  return {
    stage: DIAGNOSTIC_STAGES.has(stage) ? stage : "STATUS_CLASSIFICATION",
    reason_code: DIAGNOSTIC_REASON_CODES.has(reasonCode) ? reasonCode : "UNKNOWN_SAFE_FAILURE",
    scope: statuses.length === SUPPORTED_STATUSES.length ? "SHARED" : "STATUS_SPECIFIC",
    affected_statuses: statuses,
    candidate_evaluations: {
      attempted: safeCandidateCount(attempted),
      completed: safeCandidateCount(completed)
    }
  };
}

function unresolvedClassification() {
  return {
    status_rules: Object.fromEntries(SUPPORTED_STATUSES.map(status => [status, "UNRESOLVED"])),
    overall_classification: "UNRESOLVED",
    production_can_accept_rows_canonical_rejects: "UNRESOLVED",
    canonical_can_accept_rows_production_rejects: "UNRESOLVED"
  };
}

function normalizedUnresolvedDiagnostic(diagnostic) {
  return unresolvedDiagnostic({
    stage: diagnostic?.stage,
    reasonCode: diagnostic?.reasonCode || diagnostic?.reason_code,
    affectedStatuses: diagnostic?.affectedStatuses || diagnostic?.affected_statuses,
    attempted: diagnostic?.attempted ?? diagnostic?.candidate_evaluations?.attempted,
    completed: diagnostic?.completed ?? diagnostic?.candidate_evaluations?.completed
  });
}

function unresolvedResult(diagnostic) {
  return {
    ok: true,
    classification: unresolvedClassification(),
    reason_code: "SEMANTIC_CLASSIFICATION_UNRESOLVED",
    diagnostic: normalizedUnresolvedDiagnostic(diagnostic)
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

function targetDiagnostic(targets) {
  if (!Array.isArray(targets?.rows)) {
    return unresolvedDiagnostic({
      stage: "CONSTRAINT_DISCOVERY",
      reasonCode: "CONSTRAINT_DISCOVERY_INVALID"
    });
  }
  if (targets.rows.length === 0) {
    return unresolvedDiagnostic({
      stage: "CONSTRAINT_DISCOVERY",
      reasonCode: "CONSTRAINT_NOT_FOUND"
    });
  }
  if (targets.rows.length !== 1) {
    return unresolvedDiagnostic({
      stage: "CONSTRAINT_IDENTITY",
      reasonCode: "MULTIPLE_CANDIDATES"
    });
  }

  const target = targets.rows[0];
  if (!target || typeof target.constraint_oid !== "string" || !/^\d+$/.test(target.constraint_oid)) {
    return unresolvedDiagnostic({
      stage: "CONSTRAINT_IDENTITY",
      reasonCode: "CONSTRAINT_IDENTITY_INVALID"
    });
  }
  if (target.evaluator_safe !== true) {
    return unresolvedDiagnostic({
      stage: "SAFE_EVALUATOR_PREPARATION",
      reasonCode: "EVALUATOR_UNSAFE"
    });
  }
  if (PAYLOAD_COLUMNS.join(",") !== "error,result,status") {
    return unresolvedDiagnostic({
      stage: "SAFE_EVALUATOR_PREPARATION",
      reasonCode: "CANONICAL_TARGET_INVARIANT_INVALID"
    });
  }
  return null;
}

async function findAckPayloadConstraint(client) {
  return client.query(FIND_PAYLOAD_CONSTRAINT_QUERY);
}

async function evaluateAckPayloadMatrix(client, constraintOid) {
  return client.query(EVALUATE_PAYLOAD_MATRIX_QUERY, [constraintOid, FINAL_ACK_CHECK_EXPRESSION]);
}

function expectedStatusForCase(caseId) {
  return Number.isSafeInteger(caseId) && caseId >= 1 && caseId <= EXPECTED_CASES.length
    ? EXPECTED_CASES[caseId - 1].status
    : null;
}

function parseMatrix(rows) {
  if (!Array.isArray(rows)) {
    return {
      matrix: null,
      diagnostic: unresolvedDiagnostic({
        stage: "CANDIDATE_RESULT_MAPPING",
        reasonCode: "CANDIDATE_MATRIX_NOT_ARRAY",
        attempted: EXPECTED_CASES.length,
        completed: 0
      })
    };
  }
  if (rows.length > EXPECTED_CASES.length) {
    return {
      matrix: null,
      diagnostic: unresolvedDiagnostic({
        stage: "CANDIDATE_RESULT_MAPPING",
        reasonCode: "CANDIDATE_MATRIX_OVERSIZED",
        attempted: EXPECTED_CASES.length,
        completed: 0
      })
    };
  }

  const byCaseId = new Map();
  const invalidStatuses = new Set();
  let hasInvalidResult = false;

  for (const row of rows) {
    const caseId = Number(row?.case_id);
    const status = expectedStatusForCase(caseId);
    if (!status || byCaseId.has(caseId) || typeof row?.production_accepts !== "boolean" || typeof row?.canonical_accepts !== "boolean") {
      hasInvalidResult = true;
      if (status) invalidStatuses.add(status);
      continue;
    }
    byCaseId.set(caseId, {
      production_accepts: row.production_accepts,
      canonical_accepts: row.canonical_accepts
    });
  }

  if (hasInvalidResult) {
    return {
      matrix: null,
      diagnostic: unresolvedDiagnostic({
        stage: "CANDIDATE_RESULT_MAPPING",
        reasonCode: "CANDIDATE_RESULT_INVALID",
        affectedStatuses: invalidStatuses.size ? invalidStatuses : SUPPORTED_STATUSES,
        attempted: EXPECTED_CASES.length,
        completed: byCaseId.size
      })
    };
  }

  const matrix = [];
  const missingStatuses = new Set();
  for (const expected of EXPECTED_CASES) {
    const outcome = byCaseId.get(expected.case_id);
    if (!outcome) missingStatuses.add(expected.status);
    else matrix.push({ ...expected, ...outcome });
  }
  if (rows.length !== EXPECTED_CASES.length || missingStatuses.size) {
    return {
      matrix: null,
      diagnostic: unresolvedDiagnostic({
        stage: "CANDIDATE_RESULT_MAPPING",
        reasonCode: "CANDIDATE_MATRIX_INCOMPLETE",
        affectedStatuses: missingStatuses.size ? missingStatuses : SUPPORTED_STATUSES,
        attempted: EXPECTED_CASES.length,
        completed: byCaseId.size
      })
    };
  }

  return { matrix, diagnostic: null };
}

function classificationDiagnostic(classification) {
  const statusRules = classification?.status_rules;
  const unresolvedStatuses = SUPPORTED_STATUSES.filter(status =>
    !STATUS_CLASSIFICATIONS.has(statusRules?.[status]) || statusRules?.[status] === "UNRESOLVED"
  );
  if (unresolvedStatuses.length) {
    return unresolvedDiagnostic({
      stage: "STATUS_CLASSIFICATION",
      reasonCode: "STATUS_RESULT_AMBIGUOUS",
      affectedStatuses: unresolvedStatuses,
      attempted: EXPECTED_CASES.length,
      completed: EXPECTED_CASES.length
    });
  }
  if (
    !OVERALL_CLASSIFICATIONS.has(classification?.overall_classification)
    || classification.overall_classification === "UNRESOLVED"
    || typeof classification.production_can_accept_rows_canonical_rejects !== "boolean"
    || typeof classification.canonical_can_accept_rows_production_rejects !== "boolean"
  ) {
    return unresolvedDiagnostic({
      stage: "OVERALL_CLASSIFICATION",
      reasonCode: "OVERALL_RESULT_INVALID",
      attempted: EXPECTED_CASES.length,
      completed: EXPECTED_CASES.length
    });
  }
  return null;
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
 * Accepts only the complete, bounded result that proves the existing
 * ACK_PAYLOAD_V1 constraint has exactly the canonical semantics. Callers
 * cannot widen this predicate with a partial or unresolved classification.
 */
export function isCompleteAckPayloadSemanticEquivalence(result) {
  const classification = result?.classification;
  const statusRules = classification?.status_rules;
  return result?.ok === true
    && result?.reason_code === "SEMANTIC_CLASSIFICATION_COMPLETE"
    && !Object.hasOwn(result, "diagnostic")
    && statusRules
    && Object.keys(statusRules).length === SUPPORTED_STATUSES.length
    && SUPPORTED_STATUSES.every(status => statusRules[status] === "MATCH")
    && classification.overall_classification === "SEMANTICALLY_EQUIVALENT"
    && classification.production_can_accept_rows_canonical_rejects === false
    && classification.canonical_can_accept_rows_production_rejects === false;
}

/**
 * Client-scoped classifier core for callers which already own a protected
 * transaction. It deliberately does not begin, commit, or roll back.
 */
export async function runDeviceBridgeAckPayloadSemanticClassifierWithClient(client, dependencies = {}) {
  const findConstraint = dependencies.findConstraint || findAckPayloadConstraint;
  const evaluateMatrix = dependencies.evaluateMatrix || evaluateAckPayloadMatrix;
  const classify = dependencies.classifyMatrix || classifyMatrix;

  try {
    const targets = await findConstraint(client);
    const targetFailure = targetDiagnostic(targets);
    if (targetFailure) {
      return unresolvedResult(targetFailure);
    }

    let evaluated;
    try {
      evaluated = await evaluateMatrix(client, targets.rows[0].constraint_oid);
    } catch (error) {
      if (error?.code === READ_ONLY_GUARD_CODE) throw error;
      return unresolvedResult({
        stage: "SYNTHETIC_EVALUATION",
        reasonCode: "EVALUATION_ERROR",
        attempted: EXPECTED_CASES.length,
        completed: 0
      });
    }
    const parsed = parseMatrix(evaluated?.rows);
    if (!parsed.matrix) return unresolvedResult(parsed.diagnostic);

    const classification = await classify(parsed.matrix);
    const classificationFailure = classificationDiagnostic(classification);
    if (classificationFailure) return unresolvedResult(classificationFailure);
    return {
      ok: true,
      classification,
      reason_code: classification.overall_classification === "UNRESOLVED"
        ? "SEMANTIC_CLASSIFICATION_UNRESOLVED"
        : "SEMANTIC_CLASSIFICATION_COMPLETE"
    };
  } catch (error) {
    return unavailableResult(error);
  }
}

/**
 * Classifies only the one bounded ACK payload CHECK. Test dependencies are
 * private seams; request handlers cannot provide SQL, target names, or data.
 */
export async function runDeviceBridgeAckPayloadSemanticClassifier(pool, dependencies = {}) {
  try {
    return await withDeviceBridgeReadOnlyTransaction(pool, client =>
      runDeviceBridgeAckPayloadSemanticClassifierWithClient(client, dependencies)
    );
  } catch (error) {
    return unavailableResult(error);
  }
}
