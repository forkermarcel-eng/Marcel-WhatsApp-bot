/* ==================================================
TINDER FOUNDATIONS — EXPLICIT MIGRATION SAFETY UTILS
================================================== */

export const TINDER_FOUNDATION_MIGRATION_LOCK_TIMEOUT = "5s";
export const TINDER_FOUNDATION_MIGRATION_STATEMENT_TIMEOUT = "30s";
export const TINDER_FOUNDATION_MIGRATION_IDLE_TRANSACTION_TIMEOUT = "60s";
export const TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES = Object.freeze([
  "MIGRATION_SOURCE_VALIDATION",
  "DATABASE_CONNECTION",
  "TRANSACTION_BEGIN",
  "TRANSACTION_SETTINGS",
  "ADVISORY_LOCK",
  "GLOBAL_PREFLIGHT",
  "TABLE_LOCK_ACQUISITION",
  "LOCKED_PREFLIGHT",
  "DDL_EXECUTION",
  "POSTCHECK",
  "COMMIT",
  "ROLLBACK",
  "CLEANUP",
  "UNKNOWN"
]);

const DIAGNOSTICS = new WeakMap();
const DIAGNOSTIC_REASON = Symbol("tinderFoundationMigrationDiagnosticReason");
const STAGES = new Set(TINDER_FOUNDATION_MIGRATION_DIAGNOSTIC_STAGES);
const SQL_BOUNDARIES = new Set(["(", "[", "{", ",", "=", "<", ">", "+", "-", "*", "/", "%", "|", "&", "^", "~", "!", "?", ":"]);
const SQL_WHITESPACE = new Set([" ", "\t", "\r", "\n", "\f"]);
const DIAGNOSTIC_REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,95}$/;

function sourceError(label) {
  return new Error(`${label} migration source is invalid.`);
}

function hasSafeDollarQuoteBoundary(text, index) {
  const previous = text[index - 1];
  return !previous || SQL_WHITESPACE.has(previous) || SQL_BOUNDARIES.has(previous);
}

function dollarQuoteDelimiter(text, index) {
  if (text[index] !== "$" || !hasSafeDollarQuoteBoundary(text, index)) return null;
  const closing = text.indexOf("$", index + 1);
  if (closing === -1) return null;
  const tag = text.slice(index + 1, closing);
  if (tag !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tag)) return null;
  return text.slice(index, closing + 1);
}

function normalizeHead(statement) {
  return statement.replace(/\s+/g, " ").trim().toUpperCase();
}

/**
 * Splits a fixed local SQL source on executable top-level semicolons only.
 * Quoted text, dollar-quoted PL/pgSQL and nested comments are retained as
 * part of their owning statement. Unterminated lexical constructs fail closed.
 */
export function splitFixedSqlStatements(source, { label = "Tinder foundation" } = {}) {
  const text = String(source || "");
  const statements = [];
  let buffer = "";
  let terminated = true;

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index];
    const pair = text.slice(index, index + 2);

    if (pair === "--") {
      const newline = text.slice(index + 2).search(/[\r\n]/);
      if (newline === -1) {
        buffer += " ";
        break;
      }
      buffer += "\n";
      index += newline + 2;
      continue;
    }

    if (pair === "/*") {
      let depth = 1;
      let cursor = index + 2;
      for (; cursor < text.length; cursor += 1) {
        const nested = text.slice(cursor, cursor + 2);
        if (nested === "/*") {
          depth += 1;
          cursor += 1;
          continue;
        }
        if (nested === "*/") {
          depth -= 1;
          cursor += 1;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) throw sourceError(label);
      buffer += " ";
      index = cursor;
      continue;
    }

    if (current === "'" || current === '"') {
      const quote = current;
      buffer += current;
      let cursor = index + 1;
      for (; cursor < text.length; cursor += 1) {
        buffer += text[cursor];
        if (text[cursor] !== quote) continue;
        if (text[cursor + 1] === quote) {
          buffer += text[cursor + 1];
          cursor += 1;
          continue;
        }
        break;
      }
      if (cursor >= text.length) throw sourceError(label);
      index = cursor;
      terminated = false;
      continue;
    }

    if (current === "$") {
      const delimiter = dollarQuoteDelimiter(text, index);
      if (delimiter) {
        const closing = text.indexOf(delimiter, index + delimiter.length);
        if (closing === -1) throw sourceError(label);
        buffer += text.slice(index, closing + delimiter.length);
        index = closing + delimiter.length - 1;
        terminated = false;
        continue;
      }
    }

    if (current === ";") {
      const statement = buffer.trim();
      if (!statement) throw sourceError(label);
      statements.push(statement);
      buffer = "";
      terminated = true;
      continue;
    }

    if (!SQL_WHITESPACE.has(current)) terminated = false;
    buffer += current;
  }

  if (buffer.trim() || !terminated || statements.length === 0) throw sourceError(label);
  return Object.freeze(statements);
}

/**
 * Validates a fixed reviewed migration source before any database connection.
 * The source accepts only its expected ordered statement shapes and never owns
 * transaction control; the runner below exclusively owns BEGIN/COMMIT/ROLLBACK.
 */
export function assertFixedTinderFoundationMigrationSource(source, {
  label,
  expectedStatementHeads
} = {}) {
  if (!label || !Array.isArray(expectedStatementHeads) || expectedStatementHeads.length === 0) {
    throw new TypeError("A fixed Tinder foundation migration contract is required.");
  }
  const statements = splitFixedSqlStatements(source, { label });
  if (statements.length !== expectedStatementHeads.length) throw sourceError(label);
  statements.forEach((statement, index) => {
    const actual = normalizeHead(statement);
    const expected = normalizeHead(expectedStatementHeads[index]);
    if (!actual.startsWith(expected) || /^(?:BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END)\b/.test(actual)) {
      throw sourceError(label);
    }
  });
  return statements;
}

function boundedStage(value) {
  return STAGES.has(value) ? value : "UNKNOWN";
}

function boundedDiagnosticReason(stage, error, allowedReasons) {
  if (stage !== "POSTCHECK") return undefined;
  const reason = error?.[DIAGNOSTIC_REASON];
  return allowedReasons.has(reason) ? reason : undefined;
}

function fixedDiagnosticReasons(values) {
  if (values === undefined) return new Set();
  if (!Array.isArray(values) || values.some(value => !DIAGNOSTIC_REASON_PATTERN.test(value))) {
    throw new TypeError("Tinder foundation diagnostic reasons must be fixed bounded codes.");
  }
  return new Set(values);
}

/**
 * Creates a fixed, non-sensitive marker for an expected migration failure
 * class. The runner exposes it only when the caller has declared the same
 * code in its source-owned allowlist and only at the POSTCHECK boundary.
 */
export function createTinderFoundationMigrationDiagnosticError(reason) {
  if (!DIAGNOSTIC_REASON_PATTERN.test(reason)) {
    throw new TypeError("Tinder foundation diagnostic reason must be a bounded code.");
  }
  const error = new Error("Tinder foundation migration postcheck reported a bounded incompatibility.");
  Object.defineProperty(error, DIAGNOSTIC_REASON, {
    value: reason,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return error;
}

function failureCode(stage, error) {
  if (stage === "MIGRATION_SOURCE_VALIDATION") return "MIGRATION_SOURCE_INVALID";
  if (stage === "ADVISORY_LOCK" && error?.code === "TINDER_FOUNDATION_ADVISORY_LOCK_UNAVAILABLE") return "ADVISORY_LOCK_UNAVAILABLE";
  if (stage === "TABLE_LOCK_ACQUISITION" && error?.code === "55P03") return "LOCK_TIMEOUT";
  if (stage === "COMMIT") return "COMMIT_OUTCOME_UNRESOLVED";
  if (stage === "CLEANUP") return "CLEANUP_FAILED";
  return "DATABASE_OPERATION_FAILED";
}

function attachDiagnostic(error, state, allowedReasons) {
  const reason = boundedDiagnosticReason(state.stage, error, allowedReasons);
  const diagnostic = Object.freeze({
    stage: boundedStage(state.stage),
    code: failureCode(state.stage, error),
    transaction: state.commitConfirmed
      ? "COMMITTED"
      : state.commitAttempted
        ? "COMMIT_OUTCOME_UNKNOWN"
        : state.transactionStarted
          ? "STARTED"
          : state.stage === "TRANSACTION_BEGIN"
            ? "UNRESOLVED"
            : "NOT_STARTED",
    rollback: state.rollbackAttempted ? state.rollbackCompleted ? "COMPLETED" : "FAILED" : "NOT_ATTEMPTED",
    ddl_started: state.ddlOperationsAttempted > 0,
    ...(reason ? { reason } : {})
  });
  if (error && (typeof error === "object" || typeof error === "function")) DIAGNOSTICS.set(error, diagnostic);
  return error;
}

export function getTinderFoundationMigrationFailureDiagnostic(error) {
  const diagnostic = error && typeof error === "object" ? DIAGNOSTICS.get(error) : null;
  return diagnostic ? { ...diagnostic } : null;
}

function assertSafeRelationName(value) {
  const table = String(value || "").trim();
  if (!/^[a-z][a-z0-9_]*$/.test(table)) throw new TypeError("Unsafe migration relation name.");
  return table;
}

async function configureTransaction(client) {
  await client.query(`SET LOCAL lock_timeout = '${TINDER_FOUNDATION_MIGRATION_LOCK_TIMEOUT}'`);
  await client.query(`SET LOCAL statement_timeout = '${TINDER_FOUNDATION_MIGRATION_STATEMENT_TIMEOUT}'`);
  await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${TINDER_FOUNDATION_MIGRATION_IDLE_TRANSACTION_TIMEOUT}'`);
}

async function acquireAdvisoryLock(client, { namespace, key }) {
  const result = await client.query(
    "SELECT pg_try_advisory_xact_lock($1, $2) AS acquired",
    [namespace, key]
  );
  if (result.rows[0]?.acquired !== true) {
    const error = new Error("A Tinder foundation migration is already running.");
    error.code = "TINDER_FOUNDATION_ADVISORY_LOCK_UNAVAILABLE";
    throw error;
  }
}

async function lockRelations(client, relations) {
  for (const relation of relations) {
    // SHARE is the narrowest PostgreSQL relation lock that blocks concurrent
    // ROW EXCLUSIVE writers and schema-changing SHARE UPDATE EXCLUSIVE / DDL
    // lockers, while still allowing ordinary readers.  The second preflight
    // therefore validates exactly the rows and catalog shape that the fixed
    // DDL will see, instead of leaving a data/schema TOCTOU window.
    await client.query(`LOCK TABLE ${assertSafeRelationName(relation)} IN SHARE MODE`);
  }
}

/**
 * Creates an explicit migration runner. The callback contracts are fixed by
 * source code; no route, startup path or caller supplied SQL reaches here.
 */
export function createExplicitTinderFoundationMigrationRunner({
  label,
  migrationSql,
  validateSource,
  preflight,
  postcheck,
  lockRelations: relationsForPreflight,
  advisoryLock = { namespace: 7421, key: 3 },
  diagnosticReasonCodes
} = {}) {
  if (!label || typeof migrationSql !== "string" || typeof validateSource !== "function"
      || typeof preflight !== "function" || typeof postcheck !== "function"
      || typeof relationsForPreflight !== "function") {
    throw new TypeError("A complete fixed Tinder foundation migration runner contract is required.");
  }
  const allowedDiagnosticReasons = fixedDiagnosticReasons(diagnosticReasonCodes);

  async function runPreDdlPath(client, setStage) {
    setStage("TRANSACTION_SETTINGS");
    await configureTransaction(client);
    setStage("ADVISORY_LOCK");
    await acquireAdvisoryLock(client, advisoryLock);
    setStage("GLOBAL_PREFLIGHT");
    const first = await preflight(client);
    setStage("TABLE_LOCK_ACQUISITION");
    await lockRelations(client, relationsForPreflight(first));
    setStage("LOCKED_PREFLIGHT");
    return preflight(client);
  }

  async function run(pool, { apply }) {
    let client;
    const state = {
      stage: "MIGRATION_SOURCE_VALIDATION",
      transactionStarted: false,
      commitAttempted: false,
      commitConfirmed: false,
      rollbackAttempted: false,
      rollbackCompleted: false,
      ddlOperationsAttempted: 0
    };
    let discardClient = false;
    let releaseError;
    try {
      validateSource(migrationSql);
      state.stage = "DATABASE_CONNECTION";
      client = await pool.connect();
      state.stage = "TRANSACTION_BEGIN";
      await client.query("BEGIN");
      state.transactionStarted = true;
      const lockedPreflight = await runPreDdlPath(client, nextStage => { state.stage = nextStage; });
      if (apply && lockedPreflight.mutate) {
        state.stage = "DDL_EXECUTION";
        state.ddlOperationsAttempted += 1;
        await client.query(migrationSql);
      }
      state.stage = "POSTCHECK";
      const checked = await postcheck(client, { applied: apply && lockedPreflight.mutate });
      if (apply && lockedPreflight.mutate && checked?.mutate !== false) {
        throw new Error(`${label} migration postcheck failed.`);
      }
      state.stage = apply ? "COMMIT" : "ROLLBACK";
      if (apply) {
        state.commitAttempted = true;
        await client.query("COMMIT");
        state.commitConfirmed = true;
      } else {
        state.rollbackAttempted = true;
        await client.query("ROLLBACK");
        state.rollbackCompleted = true;
      }
      return { migrated: Boolean(apply && lockedPreflight.mutate), preflight: lockedPreflight };
    } catch (error) {
      releaseError = error;
      const failedStage = state.stage;
      if (state.transactionStarted && !state.commitAttempted && !state.rollbackAttempted) {
        state.rollbackAttempted = true;
        try {
          await client.query("ROLLBACK");
          state.rollbackCompleted = true;
        } catch {
          discardClient = true;
        }
      } else if (!state.rollbackCompleted && !state.commitConfirmed) {
        discardClient = true;
      }
      state.stage = failedStage;
      throw attachDiagnostic(error, state, allowedDiagnosticReasons);
    } finally {
      try {
        client?.release(discardClient ? releaseError : undefined);
      } catch (error) {
        state.stage = "CLEANUP";
        throw attachDiagnostic(error, state, allowedDiagnosticReasons);
      }
    }
  }

  return Object.freeze({
    validatePreDdl: pool => run(pool, { apply: false }),
    migrate: pool => run(pool, { apply: true })
  });
}
