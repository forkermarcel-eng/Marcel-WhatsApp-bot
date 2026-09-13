import assert from "node:assert/strict";
import test from "node:test";
import {
  runTinderVerifiedChatReturnPreflightCli
} from "../scripts/preflight-tinder-verified-chat-return.js";
import {
  runTinderVerifiedChatReturnMigrationCli
} from "../scripts/migrate-tinder-verified-chat-return.js";

function logger() {
  return { lines: [], log(value) { this.lines.push(String(value)); }, error(value) { this.lines.push(String(value)); } };
}

test("V9 preflight is inert and bounded without DATABASE_URL", async () => {
  const output = logger();
  const result = await runTinderVerifiedChatReturnPreflightCli({ environment: {}, logger: output });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "DATABASE_URL_REQUIRED");
  assert.equal(result.transaction, "NOT_STARTED");
  assert.equal(result.rollback, "NOT_ATTEMPTED");
});

test("V9 migration CLI requires explicit --apply before any pool construction", async () => {
  const output = logger();
  let called = false;
  const result = await runTinderVerifiedChatReturnMigrationCli({
    argv: [],
    environment: { DATABASE_URL: "postgres://unused" },
    createPool: async () => { called = true; throw new Error("must not run"); },
    logger: output
  });
  assert.equal(result, false);
  assert.equal(called, false);
  assert.match(output.lines.join("\n"), /APPLY_REQUIRED/);
});

test("V9 migration CLI does not construct a pool without DATABASE_URL", async () => {
  const output = logger();
  let called = false;
  const result = await runTinderVerifiedChatReturnMigrationCli({
    argv: ["--apply"],
    environment: {},
    createPool: async () => { called = true; throw new Error("must not run"); },
    logger: output
  });
  assert.equal(result, false);
  assert.equal(called, false);
  assert.match(output.lines.join("\n"), /DATABASE_URL_REQUIRED/);
});
