import crypto from "node:crypto";
import { getConstructionPlans, PgBoss } from "pg-boss";
import {
  PG_BOSS_SCHEMA,
  PG_BOSS_RUNTIME_OPTIONS,
  TINDER_DISCOVERY_JOB_OPTIONS,
  TINDER_DISCOVERY_QUEUE,
  createPgBossTransactionDb
} from "./pg-boss-discovery.js";

/*
 * This is the one explicit, additive schema initialization for pg-boss 12.34.
 * Normal Railway producers and Windows workers use migrate:false/createSchema:
 * false and can never run this code implicitly.
 */
export const PG_BOSS_VERSION = "12.34.0";
export const PG_BOSS_SCHEMA_VERSION = 42;
export const PG_BOSS_CONSTRUCTION_PLAN_SHA256 = "41e301cd5c0f1affab999a9d58797b156f67631a9fafa70b8c1ac1364a4281d4";
export const PG_BOSS_CONSTRUCTION_BODY_SHA256 = "6922edf008356724a743f093e52ce420d3611a30754b6f2663c3b5ea97e61cf1";

export const PG_BOSS_DISCOVERY_QUEUE_OPTIONS = Object.freeze({
  policy: "standard",
  retryLimit: TINDER_DISCOVERY_JOB_OPTIONS.retryLimit,
  expireInSeconds: TINDER_DISCOVERY_JOB_OPTIONS.expireInSeconds,
  retentionSeconds: TINDER_DISCOVERY_JOB_OPTIONS.retentionSeconds,
  deleteAfterSeconds: TINDER_DISCOVERY_JOB_OPTIONS.deleteAfterSeconds,
  partition: false,
  notify: false
});

export const PG_BOSS_MIGRATION_STAGES = Object.freeze([
  "DATABASE_CONNECTION",
  "TRANSACTION_BEGIN",
  "TRANSACTION_SETTINGS",
  "PROJECT_ADVISORY_LOCK",
  "PGBOSS_ADVISORY_LOCK",
  "PREFLIGHT",
  "LOCKED_PREFLIGHT",
  "DDL_EXECUTION",
  "POSTCHECK",
  "COMMIT",
  "RE_PREFLIGHT",
  "ROLLBACK",
  "CLEANUP",
  "UNKNOWN"
]);

const PROJECT_LOCK_NAMESPACE = 7421;
const PROJECT_LOCK_KEY = 88;
const FAILURE_DIAGNOSTICS = new WeakMap();
const FORBIDDEN_APPLICATION_REFERENCES = /\b(?:tinder_|device_bridge_|contacts?\b|whatsapp|memory|brain|shared_media)\b/iu;

export class PgBossMigrationError extends Error {
  constructor(code, message, reason = null) {
    super(message);
    this.name = "PgBossMigrationError";
    this.code = code;
    this.reason = reason;
  }
}

function fail(code, message, reason = null) {
  throw new PgBossMigrationError(code, message, reason);
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function constructionPlan() {
  const plan = getConstructionPlans(PG_BOSS_SCHEMA, { createSchema: true });
  if (typeof plan !== "string" || hash(plan) !== PG_BOSS_CONSTRUCTION_PLAN_SHA256) {
    fail("PGBOSS_PLAN_SOURCE_INVALID", "Installed pg-boss construction plan does not match 12.34.0", "PGBOSS_PLAN_HASH_MISMATCH");
  }
  const firstStatement = "CREATE SCHEMA IF NOT EXISTS pgboss;";
  const start = plan.indexOf(firstStatement);
  const end = plan.lastIndexOf("COMMIT;");
  if (start < 0 || end < start) {
    fail("PGBOSS_PLAN_SOURCE_INVALID", "pg-boss construction plan wrapper is not recognized", "PGBOSS_PLAN_WRAPPER_INVALID");
  }
  const body = plan.slice(start, end).trimEnd();
  if (hash(body) !== PG_BOSS_CONSTRUCTION_BODY_SHA256
    || FORBIDDEN_APPLICATION_REFERENCES.test(body)) {
    fail("PGBOSS_PLAN_SOURCE_INVALID", "pg-boss construction body failed its scope check", "PGBOSS_PLAN_BODY_INVALID");
  }
  return body;
}

export function getPgBossConstructionBody() {
  return constructionPlan();
}

function numberFromRow(row, field) {
  const value = Number(row?.[field]);
  return Number.isFinite(value) ? value : NaN;
}

function stateFromInspection(inspection) {
  if (!inspection.schema_exists && !inspection.version_table_exists) return "ABSENT";
  if (!inspection.schema_exists || !inspection.version_table_exists) return "DRIFT";
  if (inspection.version_rows.length !== 1 || Number(inspection.version_rows[0]?.version) !== PG_BOSS_SCHEMA_VERSION) {
    return "DRIFT";
  }
  if (Number(inspection.schema_version) !== PG_BOSS_SCHEMA_VERSION
    || inspection.schema_drift_ok !== true
    || inspection.extra_index_count !== 0) {
    return "DRIFT";
  }
  // `job`, `warning`, and `queue_stats` are normal pg-boss lifecycle data.
  // They must not turn a previously successful isolated installation into a
  // false schema-drift result after the first retained job or maintenance
  // pass. Schedules, subscriptions, BAM work and dependencies are not part
  // of this one-queue transport and remain a strict drift signal.
  if (inspection.non_lifecycle_counts.some((value) => value !== 0)) return "DRIFT";
  if (Number(inspection.queue_count) !== 1) return "DRIFT";
  if (!queueConfigurationIsCanonical(inspection.discovery_queue)) {
    return "DRIFT";
  }
  return "CANONICAL";
}

function queueConfigurationIsCanonical(queue) {
  return Boolean(queue)
    && queue.name === TINDER_DISCOVERY_QUEUE
    && queue.policy === PG_BOSS_DISCOVERY_QUEUE_OPTIONS.policy
    && numberFromRow(queue, "retryLimit") === 0
    && numberFromRow(queue, "expireInSeconds") === TINDER_DISCOVERY_JOB_OPTIONS.expireInSeconds
    && numberFromRow(queue, "retentionSeconds") === TINDER_DISCOVERY_JOB_OPTIONS.retentionSeconds
    && numberFromRow(queue, "deleteAfterSeconds") === TINDER_DISCOVERY_JOB_OPTIONS.deleteAfterSeconds
    && queue.partition === false
    && queue.notify === false
    && queue.heartbeatSeconds === null;
}

/*
 * pg-boss exposes its own public catalog validator. It is the same manifest
 * check used by its official doctor command, covering tables, columns,
 * defaults, constraints, enum labels, indexes and function bodies. We use it
 * read-only against the caller-owned transaction client and never call start,
 * so it cannot migrate, supervise, schedule, poll, or listen.
 */
export function createPgBossCatalogInspector(client, PgBossConstructor = PgBoss) {
  if (typeof PgBossConstructor !== "function") throw new TypeError("PgBoss constructor is required");
  return new PgBossConstructor({
    db: createPgBossTransactionDb(client),
    ...PG_BOSS_RUNTIME_OPTIONS
  });
}

async function inspectPrerequisites(client) {
  const result = await client.query(
    `SELECT current_setting('server_version_num')::int AS server_version_num,
            to_regprocedure('gen_random_uuid()') IS NOT NULL AS has_gen_random_uuid,
            to_regprocedure('sha224(bytea)') IS NOT NULL AS has_sha224,
            has_database_privilege(current_database(), 'CREATE') AS can_create_schema`
  );
  const row = result.rows[0] || {};
  const valid = Number(row.server_version_num) >= 130000
    && row.has_gen_random_uuid === true
    && row.has_sha224 === true;
  if (!valid) {
    fail("PGBOSS_PREREQUISITE_INVALID", "PostgreSQL 13+ with gen_random_uuid() and sha224(bytea) is required", "PGBOSS_PREREQUISITE_MISSING");
  }
  return Object.freeze({
    server_version_num: Number(row.server_version_num),
    can_create_schema: row.can_create_schema === true
  });
}

export async function inspectPgBossSchema(client, { PgBossConstructor = PgBoss } = {}) {
  const prerequisites = await inspectPrerequisites(client);
  const namespace = await client.query("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname=$1) AS exists", [PG_BOSS_SCHEMA]);
  const inspector = createPgBossCatalogInspector(client, PgBossConstructor);
  const schemaExists = namespace.rows[0]?.exists === true;
  const versionTableExists = await inspector.isInstalled();
  const absentInspection = Object.freeze({
    prerequisites,
    schema_exists: false,
    version_table_exists: false,
    version_rows: [],
    schema_version: null,
    schema_drift_ok: false,
    extra_index_count: 0,
    non_lifecycle_counts: [],
    lifecycle_counts: Object.freeze({ jobs: 0, warnings: 0, queue_stats: 0 }),
    queue_count: 0,
    discovery_queue: null,
    state: "ABSENT"
  });
  if (!schemaExists && !versionTableExists) {
    if (!prerequisites.can_create_schema) {
      fail("PGBOSS_PREREQUISITE_INVALID", "Current PostgreSQL role cannot create the isolated pgboss schema", "PGBOSS_CREATE_SCHEMA_PRIVILEGE_MISSING");
    }
    return absentInspection;
  }
  if (!schemaExists || !versionTableExists) {
    return Object.freeze({ ...absentInspection, schema_exists: schemaExists, version_table_exists: versionTableExists, state: "DRIFT" });
  }

  const [version, schemaVersion, drift, counts, queue] = await Promise.all([
    client.query("SELECT version FROM pgboss.version ORDER BY version"),
    inspector.schemaVersion(),
    inspector.detectSchemaDrift(),
    client.query(
      `SELECT
        (SELECT COUNT(*) FROM pgboss.queue)::int AS queue_count,
        (SELECT COUNT(*) FROM pgboss.schedule)::int AS schedule_count,
        (SELECT COUNT(*) FROM pgboss.subscription)::int AS subscription_count,
        (SELECT COUNT(*) FROM pgboss.bam)::int AS bam_count,
        (SELECT COUNT(*) FROM pgboss.job)::int AS job_count,
        (SELECT COUNT(*) FROM pgboss.warning)::int AS warning_count,
        (SELECT COUNT(*) FROM pgboss.queue_stats)::int AS queue_stats_count,
        (SELECT COUNT(*) FROM pgboss.job_dependency)::int AS job_dependency_count`
    ),
    inspector.getQueue(TINDER_DISCOVERY_QUEUE)
  ]);
  const countRow = counts.rows[0] || {};
  const inspection = {
    prerequisites,
    schema_exists: true,
    version_table_exists: true,
    version_rows: version.rows,
    schema_version: schemaVersion,
    schema_drift_ok: drift?.ok === true,
    // `extraIndexes` are normally informational in pg-boss. This dedicated
    // schema has no independently managed indexes, so reject them as a local
    // isolation policy without treating normal job lifecycle rows as drift.
    extra_index_count: Array.isArray(drift?.extraIndexes) ? drift.extraIndexes.length : NaN,
    non_lifecycle_counts: [
      "schedule_count", "subscription_count", "bam_count", "job_dependency_count"
    ].map((field) => numberFromRow(countRow, field)),
    lifecycle_counts: Object.freeze({
      jobs: numberFromRow(countRow, "job_count"),
      warnings: numberFromRow(countRow, "warning_count"),
      queue_stats: numberFromRow(countRow, "queue_stats_count")
    }),
    queue_count: numberFromRow(countRow, "queue_count"),
    discovery_queue: queue || null
  };
  return Object.freeze({ ...inspection, state: stateFromInspection(inspection) });
}

function countsOf(inspection) {
  const values = inspection.lifecycle_counts || {};
  return Object.freeze({
    queue: Number(inspection.queue_count) || 0,
    jobs: values.jobs ?? 0,
    warnings: values.warnings ?? 0,
    queue_stats: values.queue_stats ?? 0
  });
}

function assertFreshLifecycle(inspection) {
  const counts = countsOf(inspection);
  if (counts.jobs !== 0 || counts.warnings !== 0 || counts.queue_stats !== 0) {
    fail(
      "PGBOSS_SCHEMA_INVALID",
      "The pg-boss initialization unexpectedly created lifecycle rows",
      "UNEXPECTED_LIFECYCLE_DATA"
    );
  }
}

export async function preflightPgBossSchema(pool, { inspect = inspectPgBossSchema } = {}) {
  if (typeof inspect !== "function") throw new TypeError("inspect must be a function");
  let client;
  let readOnlyTransactionOpen = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN READ ONLY");
    readOnlyTransactionOpen = true;
    const inspection = await inspect(client);
    await client.query("ROLLBACK");
    readOnlyTransactionOpen = false;
    if (inspection.state === "DRIFT") {
      fail("PGBOSS_SCHEMA_INVALID", "Existing pgboss schema is partial or does not match the required v42 installation", "PGBOSS_SCHEMA_DRIFT");
    }
    return Object.freeze({
      state: inspection.state === "ABSENT" ? "ELIGIBLE_FOR_MIGRATION" : "ALREADY_CANONICAL",
      counts: countsOf(inspection),
      inspection
    });
  } catch (error) {
    if (readOnlyTransactionOpen) await client?.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client?.release();
  }
}

function diagnosticFor(error, values) {
  const commitUnresolved = values.commit_attempted && !values.commit_confirmed;
  FAILURE_DIAGNOSTICS.set(error, Object.freeze({
    stage: values.stage,
    code: commitUnresolved
      ? "COMMIT_OUTCOME_UNRESOLVED"
      : error instanceof PgBossMigrationError ? error.code : "DATABASE_OPERATION_FAILED",
    transaction: values.commit_confirmed
      ? "COMMITTED"
      : commitUnresolved
        ? "COMMIT_OUTCOME_UNRESOLVED"
        : values.transaction,
    rollback: values.rollback,
    ddl_started: values.ddl_started,
    reason: error instanceof PgBossMigrationError ? error.reason : null
  }));
}

export function getPgBossMigrationDiagnostic(error) {
  return FAILURE_DIAGNOSTICS.get(error) || null;
}

export async function migratePgBossSchema(pool, { inspect = inspectPgBossSchema } = {}) {
  if (typeof inspect !== "function") throw new TypeError("inspect must be a function");
  let client;
  const state = {
    transactionStarted: false,
    commitAttempted: false,
    commitConfirmed: false,
    rollbackAttempted: false,
    rollbackCompleted: false,
    ddlStarted: false
  };
  let releaseError;
  let discardClient = false;
  let stage = "DATABASE_CONNECTION";
  try {
    // Validate the frozen, package-pinned source before any database change.
    const body = constructionPlan();
    client = await pool.connect();
    stage = "TRANSACTION_BEGIN";
    await client.query("BEGIN");
    state.transactionStarted = true;
    stage = "TRANSACTION_SETTINGS";
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '60s'");
    stage = "PROJECT_ADVISORY_LOCK";
    const projectLock = await client.query("SELECT pg_try_advisory_xact_lock($1,$2) AS locked", [PROJECT_LOCK_NAMESPACE, PROJECT_LOCK_KEY]);
    if (projectLock.rows[0]?.locked !== true) {
      fail("PGBOSS_ADVISORY_LOCK_UNAVAILABLE", "Project migration advisory lock is unavailable", "PROJECT_ADVISORY_LOCK_UNAVAILABLE");
    }
    stage = "PGBOSS_ADVISORY_LOCK";
    const pgbossLock = await client.query(
      "SELECT pg_try_advisory_xact_lock(('x' || encode(sha224((current_database() || '.pgboss.pgboss')::bytea), 'hex'))::bit(64)::bigint) AS locked"
    );
    if (pgbossLock.rows[0]?.locked !== true) {
      fail("PGBOSS_ADVISORY_LOCK_UNAVAILABLE", "pg-boss schema advisory lock is unavailable", "PGBOSS_ADVISORY_LOCK_UNAVAILABLE");
    }
    stage = "PREFLIGHT";
    const before = await inspect(client);
    if (before.state === "DRIFT") {
      fail("PGBOSS_SCHEMA_INVALID", "Existing pgboss schema is partial or does not match the required v42 installation", "PGBOSS_SCHEMA_DRIFT");
    }
    stage = "LOCKED_PREFLIGHT";
    const lockedBefore = await inspect(client);
    if (lockedBefore.state !== before.state) {
      fail("PGBOSS_SCHEMA_INVALID", "pg-boss schema changed during locked preflight", "PGBOSS_PREFLIGHT_DRIFT");
    }
    if (lockedBefore.state === "ABSENT") {
      stage = "DDL_EXECUTION";
      state.ddlStarted = true;
      await client.query(body);
      await client.query(
        "SELECT pgboss.create_queue($1, $2::jsonb)",
        [TINDER_DISCOVERY_QUEUE, JSON.stringify(PG_BOSS_DISCOVERY_QUEUE_OPTIONS)]
      );
    }
    stage = "POSTCHECK";
    const postcheck = await inspect(client);
    if (postcheck.state !== "CANONICAL") {
      fail("PGBOSS_SCHEMA_INVALID", "pg-boss v42 postcheck failed", "PGBOSS_POSTCHECK_SCHEMA_INVALID");
    }
    if (lockedBefore.state === "ABSENT") assertFreshLifecycle(postcheck);
    stage = "COMMIT";
    state.commitAttempted = true;
    await client.query("COMMIT");
    state.commitConfirmed = true;
    // Reuse the now-committed client. Opening a second pool connection before
    // releasing this one deadlocks when the caller intentionally uses max:1.
    stage = "RE_PREFLIGHT";
    await client.query("BEGIN READ ONLY");
    let reInspection;
    try {
      reInspection = await inspect(client);
    } finally {
      await client.query("ROLLBACK");
    }
    if (reInspection.state !== "CANONICAL") {
      fail("PGBOSS_SCHEMA_INVALID", "pg-boss re-preflight did not confirm canonical v42", "PGBOSS_REPREFLIGHT_INVALID");
    }
    const rePreflight = Object.freeze({
      state: "ALREADY_CANONICAL",
      counts: countsOf(reInspection),
      inspection: reInspection
    });
    return Object.freeze({
      migrated: lockedBefore.state === "ABSENT",
      postcheck: Object.freeze({ counts: countsOf(postcheck) }),
      re_preflight: rePreflight
    });
  } catch (error) {
    releaseError = error;
    if (state.transactionStarted && !state.commitAttempted) {
      state.rollbackAttempted = true;
      try {
        await client?.query("ROLLBACK");
        state.rollbackCompleted = true;
      } catch {
        discardClient = true;
      }
    } else {
      // Once COMMIT was attempted, PostgreSQL's outcome cannot safely be
      // inferred by this process. Never issue a compensating ROLLBACK.
      discardClient = true;
    }
    diagnosticFor(error, {
      stage,
      transaction: state.transactionStarted ? "STARTED" : "NOT_STARTED",
      rollback: state.rollbackAttempted ? (state.rollbackCompleted ? "COMPLETED" : "FAILED") : "NOT_ATTEMPTED",
      ddl_started: state.ddlStarted,
      commit_attempted: state.commitAttempted,
      commit_confirmed: state.commitConfirmed
    });
    throw error;
  } finally {
    client?.release(discardClient ? releaseError : undefined);
  }
}
