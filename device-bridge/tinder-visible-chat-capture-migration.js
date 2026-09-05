import { readFileSync } from "node:fs";
import { REQUIRED_TABLES } from "./schema-readiness.js";
import {
  preflightTinderVisibleChatCaptureMigration,
  TINDER_VISIBLE_CHAT_CAPTURE_TABLE
} from "./tinder-visible-chat-capture-schema.js";

/* ==================================================
T2 — EXPLICIT VISIBLE-CHAT CAPTURE TABLE MIGRATION
================================================== */

export const T2_CAPTURE_MIGRATION_LOCK_TIMEOUT = "5s";
export const T2_CAPTURE_MIGRATION_STATEMENT_TIMEOUT = "30s";
export const T2_CAPTURE_MIGRATION_IDLE_TRANSACTION_TIMEOUT = "60s";
export const T2_CAPTURE_MIGRATION_DIAGNOSTIC_STAGES = Object.freeze([
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

const ADVISORY_LOCK_NAMESPACE = 7421;
const ADVISORY_LOCK_KEY = 1;
const STAGES = new Set(T2_CAPTURE_MIGRATION_DIAGNOSTIC_STAGES);
const FAILURE_DIAGNOSTICS = new WeakMap();
const CAPTURE_MIGRATION_SQL = readFileSync(
  new URL("../migrations/20260905_t2_visible_chat_capture.sql", import.meta.url),
  "utf8"
);

function stripSqlComments(source) {
  let output = "";
  let quote = "";
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      output += current;
      if (current === quote) {
        if (next === quote) {
          output += next;
          index += 1;
        } else {
          quote = "";
        }
      }
      continue;
    }
    if (current === "'" || current === '"') {
      quote = current;
      output += current;
      continue;
    }
    if (current === "-" && next === "-") {
      const newline = source.indexOf("\n", index + 2);
      if (newline < 0) break;
      output += "\n";
      index = newline;
      continue;
    }
    if (current === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) throw new Error("Tinder visible-chat capture migration source is invalid.");
      output += " ";
      index = end + 1;
      continue;
    }
    output += current;
  }
  if (quote) throw new Error("Tinder visible-chat capture migration source is invalid.");
  return output;
}

/**
 * Static, fail-closed guard for the single known T2 DDL statement. It rejects
 * any second statement or non-table DDL before a database client is opened.
 */
export function assertTinderVisibleChatCaptureMigrationSource(sql) {
  const normalized = stripSqlComments(String(sql || "")).trim();
  const firstSeparator = normalized.indexOf(";");
  if (firstSeparator < 0
    || firstSeparator !== normalized.lastIndexOf(";")
    || normalized.slice(firstSeparator + 1).trim()) {
    throw new Error("Tinder visible-chat capture migration source is invalid.");
  }
  const statement = normalized.slice(0, firstSeparator).trim();
  // `ON DELETE RESTRICT` is part of the required foreign-key contract, so
  // mutation keywords are guarded by the single-statement/create-table shape
  // above rather than rejected as bare words here.
  const disallowed = /\b(?:ALTER|DROP|TRUNCATE|BEGIN|COMMIT|ROLLBACK|GRANT|REVOKE|COPY|DO|CALL|EXECUTE|VACUUM|ANALYZE|SELECT)\b/i;
  if (!/^CREATE\s+TABLE\s+tinder_visible_chat_captures\s*\(/i.test(statement)
    || /\bIF\s+NOT\s+EXISTS\b/i.test(statement)
    || /\bCREATE\s+(?!TABLE\s+tinder_visible_chat_captures\b)/i.test(statement)
    || disallowed.test(statement)) {
    throw new Error("Tinder visible-chat capture migration source is invalid.");
  }
}

/**
 * Validates a candidate source without opening a pool. The attached bounded
 * diagnostic makes a malformed local migration file distinguishable from a
 * connection failure.
 */
export function validateTinderVisibleChatCaptureMigrationSource(sql) {
  try {
    assertTinderVisibleChatCaptureMigrationSource(sql);
    return { valid: true };
  } catch (error) {
    throw attachFailureDiagnostic(error, {
      stage: "MIGRATION_SOURCE_VALIDATION",
      transactionStarted: false,
      commitAttempted: false,
      commitConfirmed: false,
      rollbackAttempted: false,
      rollbackCompleted: false,
      ddlOperationsAttempted: 0
    });
  }
}

function boundedStage(stage) {
  return STAGES.has(stage) ? stage : "UNKNOWN";
}

function failureCode(stage, error) {
  if (stage === "MIGRATION_SOURCE_VALIDATION") return "MIGRATION_SOURCE_INVALID";
  if (stage === "ADVISORY_LOCK" && error?.code === "T2_CAPTURE_ADVISORY_LOCK_UNAVAILABLE") {
    return "ADVISORY_LOCK_UNAVAILABLE";
  }
  if (stage === "TABLE_LOCK_ACQUISITION" && error?.code === "55P03") return "LOCK_TIMEOUT";
  if (stage === "COMMIT") return "COMMIT_OUTCOME_UNRESOLVED";
  if (stage === "CLEANUP") return "CLEANUP_FAILED";
  return "DATABASE_OPERATION_FAILED";
}

function attachFailureDiagnostic(error, {
  stage,
  transactionStarted,
  commitAttempted,
  commitConfirmed,
  rollbackAttempted,
  rollbackCompleted,
  ddlOperationsAttempted
}) {
  const diagnostic = Object.freeze({
    stage: boundedStage(stage),
    code: failureCode(stage, error),
    transaction: commitConfirmed
      ? "COMMITTED"
      : commitAttempted
        ? "COMMIT_OUTCOME_UNKNOWN"
        : transactionStarted
          ? "STARTED"
          : stage === "TRANSACTION_BEGIN"
            ? "UNRESOLVED"
            : "NOT_STARTED",
    rollback: rollbackAttempted ? rollbackCompleted ? "COMPLETED" : "FAILED" : "NOT_ATTEMPTED",
    ddl_started: ddlOperationsAttempted > 0
  });
  if (error && (typeof error === "object" || typeof error === "function")) {
    FAILURE_DIAGNOSTICS.set(error, diagnostic);
  }
  return error;
}

export function getTinderVisibleChatCaptureMigrationFailureDiagnostic(error) {
  const diagnostic = error && typeof error === "object" ? FAILURE_DIAGNOSTICS.get(error) : null;
  return diagnostic ? { ...diagnostic } : null;
}

async function configureTransaction(client) {
  await client.query(`SET LOCAL lock_timeout = '${T2_CAPTURE_MIGRATION_LOCK_TIMEOUT}'`);
  await client.query(`SET LOCAL statement_timeout = '${T2_CAPTURE_MIGRATION_STATEMENT_TIMEOUT}'`);
  await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${T2_CAPTURE_MIGRATION_IDLE_TRANSACTION_TIMEOUT}'`);
}

async function acquireAdvisoryLock(client) {
  const result = await client.query(
    `SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_NAMESPACE}, ${ADVISORY_LOCK_KEY}) AS acquired`
  );
  if (result.rows[0]?.acquired !== true) {
    const error = new Error("Device Bridge schema migration is already running.");
    error.code = "T2_CAPTURE_ADVISORY_LOCK_UNAVAILABLE";
    throw error;
  }
}

async function lockVerifiedRelations(client, captureState) {
  for (const table of REQUIRED_TABLES) {
    await client.query(`LOCK TABLE ${table} IN ACCESS SHARE MODE`);
  }
  await client.query("LOCK TABLE contacts IN ACCESS SHARE MODE");
  if (captureState === "CANONICAL") {
    await client.query(`LOCK TABLE ${TINDER_VISIBLE_CHAT_CAPTURE_TABLE} IN ACCESS SHARE MODE`);
  }
}

async function runTinderVisibleChatCapturePreDdlPath(client, setStage = () => {}) {
  setStage("TRANSACTION_SETTINGS");
  await configureTransaction(client);
  setStage("ADVISORY_LOCK");
  await acquireAdvisoryLock(client);
  setStage("GLOBAL_PREFLIGHT");
  const preflight = await preflightTinderVisibleChatCaptureMigration(client);
  setStage("TABLE_LOCK_ACQUISITION");
  await lockVerifiedRelations(client, preflight.capture.state);
  setStage("LOCKED_PREFLIGHT");
  return preflightTinderVisibleChatCaptureMigration(client);
}

/**
 * Explicit local/integration validation seam. It executes the exact T2
 * pre-DDL path then always rolls back; it never creates the capture table.
 */
export async function validateTinderVisibleChatCapturePreDdl(pool) {
  let client;
  let transactionStarted = false;
  let discardClient = false;
  let releaseError;
  let stage = "MIGRATION_SOURCE_VALIDATION";
  let rollbackAttempted = false;
  let rollbackCompleted = false;
  try {
    validateTinderVisibleChatCaptureMigrationSource(CAPTURE_MIGRATION_SQL);
    stage = "DATABASE_CONNECTION";
    client = await pool.connect();
    stage = "TRANSACTION_BEGIN";
    await client.query("BEGIN");
    transactionStarted = true;
    await runTinderVisibleChatCapturePreDdlPath(client, nextStage => {
      stage = nextStage;
    });
    stage = "ROLLBACK";
    rollbackAttempted = true;
    await client.query("ROLLBACK");
    rollbackCompleted = true;
    return { validated: true };
  } catch (error) {
    releaseError = error;
    const failedStage = stage;
    if (transactionStarted && !rollbackAttempted) {
      rollbackAttempted = true;
      try {
        await client.query("ROLLBACK");
        rollbackCompleted = true;
      } catch {
        discardClient = true;
      }
    } else {
      discardClient = true;
    }
    throw attachFailureDiagnostic(error, {
      stage: failedStage,
      transactionStarted,
      commitAttempted: false,
      commitConfirmed: false,
      rollbackAttempted,
      rollbackCompleted,
      ddlOperationsAttempted: 0
    });
  } finally {
    try {
      client?.release(discardClient ? releaseError : undefined);
    } catch (error) {
      throw attachFailureDiagnostic(error, {
        stage: "CLEANUP",
        transactionStarted,
        commitAttempted: false,
        commitConfirmed: false,
        rollbackAttempted,
        rollbackCompleted,
        ddlOperationsAttempted: 0
      });
    }
  }
}

/**
 * The only DDL authority for the T2 capture table. It is un-routed and must
 * be invoked explicitly through the matching CLI with --apply.
 */
export async function migrateTinderVisibleChatCaptureSchema(pool) {
  let client;
  let transactionStarted = false;
  let commitAttempted = false;
  let commitConfirmed = false;
  let discardClient = false;
  let releaseError;
  let stage = "MIGRATION_SOURCE_VALIDATION";
  let rollbackAttempted = false;
  let rollbackCompleted = false;
  let ddlOperationsAttempted = 0;

  try {
    validateTinderVisibleChatCaptureMigrationSource(CAPTURE_MIGRATION_SQL);
    stage = "DATABASE_CONNECTION";
    client = await pool.connect();
    stage = "TRANSACTION_BEGIN";
    await client.query("BEGIN");
    transactionStarted = true;
    const lockedPreflight = await runTinderVisibleChatCapturePreDdlPath(client, nextStage => {
      stage = nextStage;
    });
    let migrated = false;
    if (lockedPreflight.mutate) {
      stage = "DDL_EXECUTION";
      ddlOperationsAttempted += 1;
      await client.query(CAPTURE_MIGRATION_SQL);
      migrated = true;
    }
    stage = "POSTCHECK";
    const postcheck = await preflightTinderVisibleChatCaptureMigration(client);
    if (postcheck.mutate) throw new Error("Tinder visible-chat capture schema postcheck failed.");
    stage = "COMMIT";
    commitAttempted = true;
    await client.query("COMMIT");
    commitConfirmed = true;
    return { migrated };
  } catch (error) {
    releaseError = error;
    const failedStage = stage;
    if (transactionStarted && !commitAttempted) {
      rollbackAttempted = true;
      try {
        await client.query("ROLLBACK");
        rollbackCompleted = true;
      } catch {
        discardClient = true;
      }
    } else {
      discardClient = true;
    }
    throw attachFailureDiagnostic(error, {
      stage: failedStage,
      transactionStarted,
      commitAttempted,
      commitConfirmed,
      rollbackAttempted,
      rollbackCompleted,
      ddlOperationsAttempted
    });
  } finally {
    try {
      client?.release(discardClient ? releaseError : undefined);
    } catch (error) {
      throw attachFailureDiagnostic(error, {
        stage: "CLEANUP",
        transactionStarted,
        commitAttempted,
        commitConfirmed,
        rollbackAttempted,
        rollbackCompleted,
        ddlOperationsAttempted
      });
    }
  }
}
