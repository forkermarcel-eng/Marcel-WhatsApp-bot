import assert from "node:assert/strict";
import test from "node:test";
import { runTinderVisibleChatSyncMigrationCli } from "../scripts/migrate-tinder-visible-chat-sync.js";
import { runTinderVisibleChatSyncPreflightCli } from "../scripts/preflight-tinder-visible-chat-sync.js";

function logger() {
  return { lines: [], log(value) { this.lines.push(String(value)); }, error(value) { this.lines.push(String(value)); } };
}

test("V4 explicit migration CLI refuses no-apply and missing database configuration before a pool exists", async () => {
  let pools = 0;
  const log = logger();
  assert.equal(await runTinderVisibleChatSyncMigrationCli({
    argv: [], environment: {}, logger: log,
    async createPool() { pools += 1; throw new Error("must not connect"); }
  }), false);
  assert.equal(await runTinderVisibleChatSyncMigrationCli({
    argv: ["--apply"], environment: {}, logger: log,
    async createPool() { pools += 1; throw new Error("must not connect"); }
  }), false);
  assert.equal(pools, 0);
  assert.equal(log.lines.join("\n").includes("DATABASE_URL="), false);
});

test("V4 operational preflight uses only an injected read-only transaction and returns bounded readiness", async () => {
  let closed = false;
  let preflightCalls = 0;
  const log = logger();
  const result = await runTinderVisibleChatSyncPreflightCli({
    environment: { DATABASE_URL: "test-database-url" },
    logger: log,
    async createPool() { return { async end() { closed = true; } }; },
    async readOnlyTransaction(_pool, work) {
      return work({ readonly: true });
    },
    async preflight(client) {
      preflightCalls += 1;
      assert.equal(client.readonly, true);
      return { foundation: { state: "ABSENT" }, mutate: true };
    }
  });
  assert.deepEqual(result, {
    ok: true,
    reason: "ELIGIBLE_FOR_MIGRATION",
    foundation_state: "ABSENT",
    migration_required: true,
    transaction: "READ_ONLY_REPEATABLE_READ",
    rollback: "COMPLETED"
  });
  assert.equal(preflightCalls, 1);
  assert.equal(closed, true);
  assert.equal(log.lines.join("\n").includes("test-database-url"), false);
});
