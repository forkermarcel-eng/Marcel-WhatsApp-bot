import assert from "node:assert/strict";
import test from "node:test";
import {
  runTinderLocalConversationAttestationMigrationCli
} from "../scripts/migrate-tinder-local-conversation-attestation.js";
import {
  runTinderLocalConversationAttestationPreflightCli
} from "../scripts/preflight-tinder-local-conversation-attestation.js";

function logger() {
  return {
    lines: [],
    log(value) { this.lines.push(String(value)); },
    error(value) { this.lines.push(String(value)); }
  };
}

test("attestation migration CLI refuses missing --apply or DATABASE_URL before opening a pool", async () => {
  let pools = 0;
  const log = logger();
  assert.equal(await runTinderLocalConversationAttestationMigrationCli({
    argv: [], environment: {}, logger: log,
    async createPool() { pools += 1; throw new Error("must not connect"); }
  }), false);
  assert.equal(await runTinderLocalConversationAttestationMigrationCli({
    argv: ["--apply"], environment: {}, logger: log,
    async createPool() { pools += 1; throw new Error("must not connect"); }
  }), false);
  assert.equal(pools, 0);
  assert.equal(log.lines.join("\n").includes("DATABASE_URL="), false);
});

test("attestation preflight is injected repeatable-read-only and returns only bounded upgrade facts", async () => {
  let closed = false;
  const log = logger();
  const result = await runTinderLocalConversationAttestationPreflightCli({
    environment: { DATABASE_URL: "test-database-url" },
    logger: log,
    async createPool() { return { async end() { closed = true; } }; },
    async readOnlyTransaction(_pool, work) { return work({ readonly: true }); },
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

test("attestation preflight blocks active V1 permits with bounded output and no connection detail", async () => {
  const log = logger();
  const result = await runTinderLocalConversationAttestationPreflightCli({
    environment: { DATABASE_URL: "test-database-url" },
    logger: log,
    async createPool() { return { async end() {} }; },
    async readOnlyTransaction(_pool, work) { return work({ readonly: true }); },
    async preflight() {
      const error = new Error("fixture active legacy permit");
      error.code = "TINDER_LOCAL_CONVERSATION_ATTESTATION_ACTIVE_V1_PERMIT";
      throw error;
    }
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "LOCAL_CONVERSATION_ATTESTATION_ACTIVE_V1_PERMIT",
    foundation_state: "UNRESOLVED",
    migration_required: "UNRESOLVED",
    transaction: "READ_ONLY_REPEATABLE_READ",
    rollback: "COMPLETED",
    stage: "ACTIVE_V1_PERMIT_CHECK"
  });
  assert.equal(log.lines.join("\n").includes("test-database-url"), false);
});

test("attestation preflight validates fixed SQL before a pool and keeps catalog failures bounded", async () => {
  let pools = 0;
  const log = logger();
  const invalidSource = await runTinderLocalConversationAttestationPreflightCli({
    environment: { DATABASE_URL: "test-database-url" },
    logger: log,
    readMigrationSource: () => "not reviewed SQL",
    validateMigrationSource() { throw new Error("fixed source mismatch"); },
    async createPool() { pools += 1; throw new Error("must not connect"); }
  });
  assert.equal(invalidSource.reason, "MIGRATION_SOURCE_INVALID");
  assert.equal(invalidSource.stage, "SOURCE_VALIDATION");
  assert.equal(pools, 0);

  const prerequisite = await runTinderLocalConversationAttestationPreflightCli({
    environment: { DATABASE_URL: "test-database-url" },
    logger: log,
    readMigrationSource: () => "reviewed SQL",
    validateMigrationSource() {},
    async createPool() { return { async end() {} }; },
    async readOnlyTransaction(_pool, work) { return work({ readonly: true }); },
    async preflight() {
      const error = new Error("fixture catalog failure");
      error.code = "TINDER_LOCAL_CONVERSATION_ATTESTATION_PREREQUISITE_INSPECTION_FAILED";
      throw error;
    }
  });
  assert.deepEqual(prerequisite, {
    ok: false,
    reason: "LOCAL_CONVERSATION_ATTESTATION_PREREQUISITE_INSPECTION_FAILED",
    foundation_state: "UNRESOLVED",
    migration_required: "UNRESOLVED",
    transaction: "READ_ONLY_REPEATABLE_READ",
    rollback: "COMPLETED",
    stage: "PREREQUISITE_INSPECTION"
  });
  assert.equal(log.lines.join("\n").includes("test-database-url"), false);
});

test("attestation migration CLI reports a bounded committed result only after its runner returns", async () => {
  let closed = false;
  const log = logger();
  const result = await runTinderLocalConversationAttestationMigrationCli({
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
