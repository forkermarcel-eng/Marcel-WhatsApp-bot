import assert from "node:assert/strict";
import test from "node:test";
import { runTinderIdentityFoundationMigrationCli } from "../scripts/migrate-tinder-identity-foundation.js";

function logger() {
  const entries = [];
  return {
    entries,
    log(value) { entries.push(String(value)); },
    error(value) { entries.push(String(value)); }
  };
}

test("the explicit T3 CLI exposes an allowlisted postcheck reason without low-level error content", async () => {
  const output = logger();
  const rawMarker = "untrusted-postgres-detail-must-not-leak";
  const failure = new Error(rawMarker);
  const pool = { async end() {} };
  const result = await runTinderIdentityFoundationMigrationCli({
    argv: ["--apply"],
    environment: { DATABASE_URL: "postgres://not-a-production-test" },
    createPool: async () => pool,
    migrate: async () => { throw failure; },
    getFailureDiagnostic: error => error === failure ? {
      stage: "POSTCHECK",
      code: "DATABASE_OPERATION_FAILED",
      transaction: "STARTED",
      rollback: "COMPLETED",
      ddl_started: true,
      reason: "T3_POSTCHECK_IDENTITY_SCHEMA_INVALID"
    } : null,
    logger: output
  });
  assert.equal(result, false);
  assert.match(output.entries.join("\n"), /reason=T3_POSTCHECK_IDENTITY_SCHEMA_INVALID/);
  assert.equal(output.entries.join("\n").includes(rawMarker), false);
  assert.equal(output.entries.join("\n").includes("not-a-production-test"), false);
});

test("the explicit T3 CLI drops an unrecognized postcheck reason", async () => {
  const output = logger();
  const failure = new Error("low-level error");
  const result = await runTinderIdentityFoundationMigrationCli({
    argv: ["--apply"],
    environment: { DATABASE_URL: "postgres://not-a-production-test" },
    createPool: async () => ({ async end() {} }),
    migrate: async () => { throw failure; },
    getFailureDiagnostic: () => ({
      stage: "POSTCHECK",
      code: "DATABASE_OPERATION_FAILED",
      transaction: "STARTED",
      rollback: "COMPLETED",
      ddl_started: true,
      reason: "UNTRUSTED_POSTCHECK_REASON"
    }),
    logger: output
  });
  assert.equal(result, false);
  assert.doesNotMatch(output.entries.join("\n"), /reason=/);
});
