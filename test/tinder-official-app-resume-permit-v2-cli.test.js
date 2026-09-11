import assert from "node:assert/strict";
import test from "node:test";
import {
  runTinderOfficialAppResumePermitV2MigrationCli
} from "../scripts/migrate-tinder-official-app-resume-permit-v2.js";
import {
  runTinderOfficialAppResumePermitV2PreflightCli
} from "../scripts/preflight-tinder-official-app-resume-permit-v2.js";

function logger() {
  return {
    lines: [],
    log(value) { this.lines.push(String(value)); },
    error(value) { this.lines.push(String(value)); }
  };
}

test("V2 explicit migration CLI refuses missing --apply or DATABASE_URL before a pool exists", async () => {
  let pools = 0;
  const log = logger();
  assert.equal(await runTinderOfficialAppResumePermitV2MigrationCli({
    argv: [], environment: {}, logger: log,
    async createPool() { pools += 1; throw new Error("must not connect"); }
  }), false);
  assert.equal(await runTinderOfficialAppResumePermitV2MigrationCli({
    argv: ["--apply"], environment: {}, logger: log,
    async createPool() { pools += 1; throw new Error("must not connect"); }
  }), false);
  assert.equal(pools, 0);
  assert.equal(log.lines.join("\n").includes("DATABASE_URL="), false);
});

test("V2 operational preflight uses its injected read-only transaction and returns only bounded upgrade state", async () => {
  let closed = false;
  const log = logger();
  const result = await runTinderOfficialAppResumePermitV2PreflightCli({
    environment: { DATABASE_URL: "test-database-url" },
    logger: log,
    async createPool() { return { async end() { closed = true; } }; },
    async readOnlyTransaction(_pool, work) {
      return work({ readonly: true });
    },
    async preflight(client) {
      assert.equal(client.readonly, true);
      return { foundation: { state: "UPGRADE_REQUIRED" }, mutate: true };
    }
  });
  assert.deepEqual(result, {
    ok: true,
    reason: "ELIGIBLE_FOR_MIGRATION",
    foundation_state: "UPGRADE_REQUIRED",
    migration_required: true,
    transaction: "READ_ONLY_REPEATABLE_READ",
    rollback: "COMPLETED",
    stage: "VALIDATION_UNCLASSIFIED"
  });
  assert.equal(closed, true);
  assert.equal(log.lines.join("\n").includes("test-database-url"), false);
});

test("V2 operational preflight reports an active legacy permit with a bounded reason", async () => {
  const log = logger();
  const result = await runTinderOfficialAppResumePermitV2PreflightCli({
    environment: { DATABASE_URL: "test-database-url" },
    logger: log,
    async createPool() { return { async end() {} }; },
    async readOnlyTransaction(_pool, work) { return work({ readonly: true }); },
    async preflight() {
      const error = new Error("active legacy permit blocks upgrade");
      error.code = "TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_ACTIVE_LEGACY_PERMIT";
      throw error;
    }
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "OFFICIAL_APP_RESUME_PERMIT_V2_ACTIVE_LEGACY_PERMIT",
    foundation_state: "UNRESOLVED",
    migration_required: "UNRESOLVED",
    transaction: "READ_ONLY_REPEATABLE_READ",
    rollback: "COMPLETED",
    stage: "ACTIVE_LEGACY_PERMIT_CHECK"
  });
  assert.match(log.lines.join("\n"), /OFFICIAL_APP_RESUME_PERMIT_V2_ACTIVE_LEGACY_PERMIT/);
  assert.equal(log.lines.join("\n").includes("test-database-url"), false);
});

test("V2 operational preflight validates its fixed SQL before any pool and reports bounded validation stages", async () => {
  let pools = 0;
  const log = logger();
  const sourceInvalid = await runTinderOfficialAppResumePermitV2PreflightCli({
    environment: { DATABASE_URL: "test-database-url" },
    logger: log,
    readMigrationSource: () => "not reviewed SQL",
    validateMigrationSource() { throw new Error("fixed source mismatch"); },
    async createPool() { pools += 1; throw new Error("must not connect"); }
  });
  assert.deepEqual(sourceInvalid, {
    ok: false,
    reason: "MIGRATION_SOURCE_INVALID",
    foundation_state: "UNRESOLVED",
    migration_required: "UNRESOLVED",
    transaction: "NOT_STARTED",
    rollback: "NOT_ATTEMPTED",
    stage: "SOURCE_VALIDATION"
  });
  assert.equal(pools, 0);

  const prerequisite = await runTinderOfficialAppResumePermitV2PreflightCli({
    environment: { DATABASE_URL: "test-database-url" },
    logger: log,
    readMigrationSource: () => "reviewed SQL",
    validateMigrationSource() {},
    async createPool() { return { async end() {} }; },
    async readOnlyTransaction(_pool, work) { return work({ readonly: true }); },
    async preflight() {
      const error = new Error("prerequisite inspection failed");
      error.code = "TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_PREREQUISITE_INSPECTION_FAILED";
      throw error;
    }
  });
  assert.deepEqual(prerequisite, {
    ok: false,
    reason: "OFFICIAL_APP_RESUME_PERMIT_V2_PREREQUISITE_INSPECTION_FAILED",
    foundation_state: "UNRESOLVED",
    migration_required: "UNRESOLVED",
    transaction: "READ_ONLY_REPEATABLE_READ",
    rollback: "COMPLETED",
    stage: "PREREQUISITE_INSPECTION"
  });
  assert.equal(log.lines.join("\n").includes("test-database-url"), false);
});

test("V2 migration CLI reports only a bounded committed result when its fixed runner succeeds", async () => {
  let closed = false;
  const log = logger();
  const result = await runTinderOfficialAppResumePermitV2MigrationCli({
    argv: ["--apply"],
    environment: { DATABASE_URL: "test-database-url" },
    logger: log,
    async createPool() { return { async end() { closed = true; } }; },
    async migrate() { return { migrated: true }; }
  });
  assert.equal(result, true);
  assert.equal(closed, true);
  const output = log.lines.join("\n");
  assert.match(output, /COMMIT_CONFIRMED/);
  assert.match(output, /MIGRATION_APPLIED/);
  assert.equal(output.includes("test-database-url"), false);
});
