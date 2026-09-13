import assert from "node:assert/strict";
import test from "node:test";
import {
  runTinderUnboundInboxConversationSweepTriggerRepairMigrationCli
} from "../scripts/migrate-tinder-unbound-inbox-conversation-sweep-trigger-repair.js";
import {
  runTinderUnboundInboxConversationSweepTriggerRepairPreflightCli
} from "../scripts/preflight-tinder-unbound-inbox-conversation-sweep-trigger-repair.js";

function logger() {
  return {
    lines: [],
    log(value) { this.lines.push(String(value)); },
    error(value) { this.lines.push(String(value)); }
  };
}

test("V8 trigger repair migration CLI is inert without --apply or DATABASE_URL before any pool can exist", async () => {
  let pools = 0;
  const log = logger();
  assert.equal(await runTinderUnboundInboxConversationSweepTriggerRepairMigrationCli({
    argv: [], environment: {}, logger: log,
    async createPool() { pools += 1; throw new Error("must not connect"); }
  }), false);
  assert.equal(await runTinderUnboundInboxConversationSweepTriggerRepairMigrationCli({
    argv: ["--apply"], environment: {}, logger: log,
    async createPool() { pools += 1; throw new Error("must not connect"); }
  }), false);
  assert.equal(pools, 0);
  assert.equal(log.lines.join("\n").includes("DATABASE_URL="), false);
});

test("V8 trigger repair preflight uses only its injected read-only transaction and emits a bounded repair state", async () => {
  let closed = false;
  const log = logger();
  const result = await runTinderUnboundInboxConversationSweepTriggerRepairPreflightCli({
    environment: { DATABASE_URL: "postgres://test-only-not-logged" },
    logger: log,
    async createPool() { return { async end() { closed = true; } }; },
    async readOnlyTransaction(_pool, work) { return work({ readonly: true }); },
    async preflight(client) {
      assert.equal(client.readonly, true);
      return { foundation: { state: "TRIGGER_REPAIR_REQUIRED" }, mutate: true };
    }
  });
  assert.deepEqual(result, {
    ok: true,
    reason: "ELIGIBLE_FOR_MIGRATION",
    foundation_state: "TRIGGER_REPAIR_REQUIRED",
    migration_required: true,
    transaction: "READ_ONLY_REPEATABLE_READ",
    rollback: "COMPLETED",
    stage: "RESULT_VALIDATION"
  });
  assert.equal(closed, true);
  assert.equal(log.lines.join("\n").includes("test-only-not-logged"), false);
});

test("V8 trigger repair preflight validates fixed SQL before a pool and never exposes its supplied database configuration", async () => {
  let pools = 0;
  const log = logger();
  const result = await runTinderUnboundInboxConversationSweepTriggerRepairPreflightCli({
    environment: { DATABASE_URL: "postgres://test-only-not-logged" },
    logger: log,
    readMigrationSource: () => "unreviewed SQL",
    validateMigrationSource() { throw new Error("fixed source mismatch"); },
    async createPool() { pools += 1; throw new Error("must not connect"); }
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "MIGRATION_SOURCE_INVALID",
    foundation_state: "UNRESOLVED",
    migration_required: "UNRESOLVED",
    transaction: "NOT_STARTED",
    rollback: "NOT_ATTEMPTED",
    stage: "SOURCE_VALIDATION"
  });
  assert.equal(pools, 0);
  assert.equal(log.lines.join("\n").includes("test-only-not-logged"), false);
});

test("V8 trigger repair migration CLI reports success only as a bounded COMMIT_CONFIRMED result", async () => {
  let closed = false;
  const log = logger();
  const result = await runTinderUnboundInboxConversationSweepTriggerRepairMigrationCli({
    argv: ["--apply"],
    environment: { DATABASE_URL: "postgres://test-only-not-logged" },
    logger: log,
    async createPool() { return { async end() { closed = true; } }; },
    async migrate() { return { migrated: true }; }
  });
  assert.equal(result, true);
  assert.equal(closed, true);
  const output = log.lines.join("\n");
  assert.match(output, /COMMIT_CONFIRMED/);
  assert.match(output, /MIGRATION_APPLIED/);
  assert.equal(output.includes("test-only-not-logged"), false);
});
