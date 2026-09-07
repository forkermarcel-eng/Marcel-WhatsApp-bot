import assert from "node:assert/strict";
import test from "node:test";
import {
  runContactConversationBindingFoundationMigrationCli
} from "../scripts/migrate-contact-conversation-binding-foundation.js";

function logger() {
  const entries = [];
  return { entries, log(value) { entries.push(String(value)); }, error(value) { entries.push(String(value)); } };
}

test("binding migration CLI requires explicit apply and database configuration before a pool exists", async () => {
  let pools = 0;
  const output = logger();
  assert.equal(await runContactConversationBindingFoundationMigrationCli({
    argv: [], environment: {}, createPool: async () => { pools += 1; }, logger: output
  }), false);
  assert.equal(await runContactConversationBindingFoundationMigrationCli({
    argv: ["--apply"], environment: {}, createPool: async () => { pools += 1; }, logger: output
  }), false);
  assert.equal(pools, 0);
  assert.equal(output.entries.join("\n").includes("DATABASE_URL="), false);
});

test("binding migration CLI emits bounded failure only and always closes its pool", async () => {
  const output = logger();
  let ended = false;
  const rawDetail = "postgres private detail must not leak";
  const failure = new Error(rawDetail);
  const result = await runContactConversationBindingFoundationMigrationCli({
    argv: ["--apply"], environment: { DATABASE_URL: "postgres://private-not-logged" },
    createPool: async () => ({ async end() { ended = true; } }),
    migrate: async () => { throw failure; },
    getFailureDiagnostic: error => error === failure ? {
      stage: "POSTCHECK", code: "DATABASE_OPERATION_FAILED", transaction: "STARTED",
      rollback: "COMPLETED", ddl_started: true,
      reason: "CONVERSATION_BINDING_POSTCHECK_SCHEMA_INVALID"
    } : null,
    logger: output
  });
  assert.equal(result, false);
  assert.equal(ended, true);
  assert.match(output.entries.join("\n"), /stage=POSTCHECK/);
  assert.match(output.entries.join("\n"), /reason=CONVERSATION_BINDING_POSTCHECK_SCHEMA_INVALID/);
  assert.equal(output.entries.join("\n").includes(rawDetail), false);
  assert.equal(output.entries.join("\n").includes("private-not-logged"), false);
});
