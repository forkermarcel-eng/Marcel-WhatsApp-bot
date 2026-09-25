import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  PG_BOSS_CONSTRUCTION_BODY_SHA256,
  PG_BOSS_CONSTRUCTION_PLAN_SHA256,
  PG_BOSS_SCHEMA_VERSION,
  getPgBossConstructionBody,
  getPgBossMigrationDiagnostic,
  inspectPgBossSchema,
  migratePgBossSchema,
  preflightPgBossSchema
} from "../tinder-mirror/pg-boss-migration.js";
import {
  PG_BOSS_RUNTIME_OPTIONS,
  TINDER_DISCOVERY_JOB_OPTIONS,
  TINDER_DISCOVERY_QUEUE
} from "../tinder-mirror/pg-boss-discovery.js";
import { runPgBossMigrationCli } from "../scripts/pgboss-migration.js";

function absentInspection() {
  return Object.freeze({
    state: "ABSENT",
    queue_count: 0,
    lifecycle_counts: Object.freeze({ jobs: 0, warnings: 0, queue_stats: 0 })
  });
}

function canonicalInspection({ jobs = 0, warnings = 0, queueStats = 0 } = {}) {
  return Object.freeze({
    state: "CANONICAL",
    queue_count: 1,
    lifecycle_counts: Object.freeze({ jobs, warnings, queue_stats: queueStats })
  });
}

function createPgBossMigrationPool({ failDdl = false, failCommit = false } = {}) {
  let installed = false;
  let queueCreated = false;
  let connectCount = 0;
  const calls = [];
  const releases = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      const statement = sql.trim();
      if (/^CREATE SCHEMA IF NOT EXISTS pgboss;/.test(statement)) {
        if (failDdl) throw new Error("simulated ddl failure");
        installed = true;
        return { rows: [] };
      }
      if (/^SELECT pg_try_advisory_xact_lock\(\$1,\$2\)/.test(statement)
        || /^SELECT pg_try_advisory_xact_lock\(\('x'/.test(statement)) {
        return { rows: [{ locked: true }] };
      }
      if (/^SELECT pgboss\.create_queue/.test(statement)) {
        queueCreated = true;
        return { rows: [] };
      }
      if (statement === "COMMIT") {
        if (failCommit) throw new Error("simulated commit transport failure");
        return { rows: [] };
      }
      if (/^(BEGIN|BEGIN READ ONLY|ROLLBACK|SET LOCAL)/.test(statement)) return { rows: [] };
      throw new Error(`Unexpected query: ${statement.slice(0, 96)}`);
    },
    release(error) { releases.push(error); }
  };
  const inspect = async () => (installed && queueCreated ? canonicalInspection() : absentInspection());
  return {
    pool: {
      async connect() {
        connectCount += 1;
        return client;
      }
    },
    calls,
    client,
    inspect,
    releases,
    get connectCount() { return connectCount; }
  };
}

function canonicalQueue() {
  return {
    name: TINDER_DISCOVERY_QUEUE,
    policy: "standard",
    retryLimit: TINDER_DISCOVERY_JOB_OPTIONS.retryLimit,
    expireInSeconds: TINDER_DISCOVERY_JOB_OPTIONS.expireInSeconds,
    retentionSeconds: TINDER_DISCOVERY_JOB_OPTIONS.retentionSeconds,
    deleteAfterSeconds: TINDER_DISCOVERY_JOB_OPTIONS.deleteAfterSeconds,
    partition: false,
    notify: false,
    heartbeatSeconds: null
  };
}

function createCatalogClient() {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/current_setting\('server_version_num'\)/.test(sql)) {
        return { rows: [{ server_version_num: 180006, has_gen_random_uuid: true, has_sha224: true, can_create_schema: true }] };
      }
      if (/FROM pg_namespace/.test(sql)) return { rows: [{ exists: true }] };
      if (/SELECT version FROM pgboss\.version/.test(sql)) return { rows: [{ version: PG_BOSS_SCHEMA_VERSION }] };
      if (/queue_count/.test(sql) && /job_dependency_count/.test(sql)) {
        return {
          rows: [{
            queue_count: 1,
            schedule_count: 0,
            subscription_count: 0,
            bam_count: 0,
            job_count: 7,
            warning_count: 3,
            queue_stats_count: 2,
            job_dependency_count: 0
          }]
        };
      }
      throw new Error(`Unexpected catalog query: ${sql.slice(0, 96)}`);
    }
  };
}

test("frozen pg-boss v42 construction body is exact, additive, and isolated from application tables", () => {
  const body = getPgBossConstructionBody();
  assert.equal(
    crypto.createHash("sha256").update(body).digest("hex"),
    PG_BOSS_CONSTRUCTION_BODY_SHA256
  );
  assert.match(body, /^CREATE SCHEMA IF NOT EXISTS pgboss;/);
  assert.match(body, /CREATE TYPE pgboss\.job_state/);
  assert.match(body, /INSERT INTO pgboss\.version\(version\) VALUES \('42'\)/);
  assert.doesNotMatch(body, /\b(?:tinder_|device_bridge_|contacts?\b|whatsapp|memory|brain|shared_media)\b/iu);
  assert.doesNotMatch(body, /CREATE EXTENSION|CREATE INDEX CONCURRENTLY/iu);
  assert.equal(PG_BOSS_CONSTRUCTION_PLAN_SHA256.length, 64);
});

test("pg-boss's public catalog inspector is read-only and permits normal retained lifecycle rows", async () => {
  const catalog = createCatalogClient();
  let options;
  const calls = [];
  class FakePgBoss {
    constructor(value) { options = value; }
    async isInstalled() { calls.push("isInstalled"); return true; }
    async schemaVersion() { calls.push("schemaVersion"); return PG_BOSS_SCHEMA_VERSION; }
    async detectSchemaDrift() { calls.push("detectSchemaDrift"); return { ok: true, extraIndexes: [] }; }
    async getQueue(name) { calls.push(`getQueue:${name}`); return canonicalQueue(); }
  }

  const result = await inspectPgBossSchema(catalog, { PgBossConstructor: FakePgBoss });
  assert.equal(result.state, "CANONICAL");
  assert.deepEqual(result.lifecycle_counts, { jobs: 7, warnings: 3, queue_stats: 2 });
  assert.deepEqual(calls, [
    "isInstalled",
    "schemaVersion",
    "detectSchemaDrift",
    `getQueue:${TINDER_DISCOVERY_QUEUE}`
  ]);
  assert.equal(typeof options.db.executeSql, "function");
  assert.deepEqual(
    Object.fromEntries(Object.entries(options).filter(([key]) => key !== "db")),
    PG_BOSS_RUNTIME_OPTIONS
  );
  assert.ok(catalog.calls.every(({ sql }) => /^\s*SELECT\b/i.test(sql)));
});

test("preflight is read-only and reports only an absent pgboss schema as eligible", async () => {
  const fake = createPgBossMigrationPool();
  const result = await preflightPgBossSchema(fake.pool, { inspect: fake.inspect });
  assert.equal(result.state, "ELIGIBLE_FOR_MIGRATION");
  assert.deepEqual(fake.calls.map(({ sql }) => sql).filter((sql) => /^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())), [
    "BEGIN READ ONLY", "ROLLBACK"
  ]);
  assert.equal(fake.calls.some(({ sql }) => /^\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(sql)), false);
});

test("canonical preflight remains valid after normal pg-boss job lifecycle data exists", async () => {
  const fake = createPgBossMigrationPool();
  const result = await preflightPgBossSchema(fake.pool, {
    inspect: async () => canonicalInspection({ jobs: 3, warnings: 1, queueStats: 2 })
  });
  assert.equal(result.state, "ALREADY_CANONICAL");
  assert.deepEqual(result.counts, { queue: 1, jobs: 3, warnings: 1, queue_stats: 2 });
});

test("the migration CLI accepts exactly one explicit mode and never opens a pool for extra arguments", async () => {
  let poolCreated = false;
  const messages = [];
  const success = await runPgBossMigrationCli({
    argv: ["--preflight", "unexpected"],
    environment: { DATABASE_URL: "postgres://not-used" },
    createPool: async () => {
      poolCreated = true;
      throw new Error("must not connect");
    },
    logger: {
      log(message) { messages.push(message); },
      error(message) { messages.push(message); }
    }
  });
  assert.equal(success, false);
  assert.equal(poolCreated, false);
  assert.match(messages.join("\n"), /stage=CLI_ARGUMENT_VALIDATION code=APPLY_OR_PREFLIGHT_REQUIRED/);
});

test("apply performs additive v42 initialization under locks, postchecks, commits, and same-client re-preflights", async () => {
  const fake = createPgBossMigrationPool();
  const result = await migratePgBossSchema(fake.pool, { inspect: fake.inspect });
  assert.equal(result.migrated, true);
  assert.equal(result.postcheck.counts.jobs, 0);
  assert.equal(result.postcheck.counts.queue, 1);
  assert.equal(fake.connectCount, 1);
  const statements = fake.calls.map(({ sql }) => sql.trim());
  assert.ok(statements.includes("BEGIN"));
  assert.ok(statements.some((sql) => sql.startsWith("CREATE SCHEMA IF NOT EXISTS pgboss;")));
  assert.ok(statements.some((sql) => sql.startsWith("SELECT pgboss.create_queue")));
  assert.ok(statements.includes("COMMIT"));
  assert.equal(statements.includes("BEGIN READ ONLY"), true);
  assert.equal(statements.includes("ROLLBACK"), true); // read-only re-preflight ends with rollback
  const apply = statements.findIndex((sql) => sql.startsWith("CREATE SCHEMA IF NOT EXISTS pgboss;"));
  const commit = statements.findIndex((sql, index) => index > apply && sql === "COMMIT");
  assert.ok(apply > 0 && commit > apply);
});

test("DDL failure rolls back and reports a terminal migration diagnostic", async () => {
  const fake = createPgBossMigrationPool({ failDdl: true });
  let error;
  try {
    await migratePgBossSchema(fake.pool, { inspect: fake.inspect });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  const diagnostic = getPgBossMigrationDiagnostic(error);
  assert.equal(diagnostic.stage, "DDL_EXECUTION");
  assert.equal(diagnostic.rollback, "COMPLETED");
  assert.equal(diagnostic.ddl_started, true);
  assert.equal(fake.calls.some(({ sql }) => sql === "COMMIT"), false);
  assert.equal(fake.calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("a COMMIT transport failure is fail-closed without an unsafe rollback or retry", async () => {
  const fake = createPgBossMigrationPool({ failCommit: true });
  let error;
  try {
    await migratePgBossSchema(fake.pool, { inspect: fake.inspect });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  const diagnostic = getPgBossMigrationDiagnostic(error);
  assert.equal(diagnostic.stage, "COMMIT");
  assert.equal(diagnostic.code, "COMMIT_OUTCOME_UNRESOLVED");
  assert.equal(diagnostic.transaction, "COMMIT_OUTCOME_UNRESOLVED");
  assert.equal(diagnostic.rollback, "NOT_ATTEMPTED");
  assert.equal(fake.calls.some(({ sql }) => sql === "ROLLBACK"), false);
  assert.equal(fake.releases.length, 1);
  assert.equal(fake.releases[0], error);
});
