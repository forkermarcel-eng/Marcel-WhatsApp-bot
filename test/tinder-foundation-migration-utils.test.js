import assert from "node:assert/strict";
import test from "node:test";
import {
  assertFixedTinderFoundationMigrationSource,
  createExplicitTinderFoundationMigrationRunner,
  getTinderFoundationMigrationFailureDiagnostic,
  splitFixedSqlStatements
} from "../device-bridge/tinder-foundation-migration-utils.js";

const FIXED_SOURCE = `
  -- a semicolon in this comment ; is not a statement
  DO $$ BEGIN RAISE NOTICE 'literal ; remains inside the fixed body'; END $$;
  ALTER TABLE contacts ALTER COLUMN whatsapp_jid DROP NOT NULL;
`;

function fixturePool({ onDdl = () => {} } = {}) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT" || sql.startsWith("SET LOCAL ")) return { rows: [] };
      if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ acquired: true }] };
      if (sql.startsWith("LOCK TABLE")) return { rows: [] };
      if (sql === FIXED_SOURCE) {
        onDdl();
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {}
  };
  return { calls, pool: { async connect() { return client; } } };
}

function createRunner({ preflight, postcheck }) {
  return createExplicitTinderFoundationMigrationRunner({
    label: "Fixture",
    migrationSql: FIXED_SOURCE,
    validateSource: (source) => assertFixedTinderFoundationMigrationSource(source, {
      label: "Fixture",
      expectedStatementHeads: ["DO", "ALTER TABLE contacts ALTER COLUMN whatsapp_jid DROP NOT NULL"]
    }),
    preflight,
    postcheck,
    lockRelations: () => ["contacts"],
    advisoryLock: { namespace: 7421, key: 99 }
  });
}

test("fixed Tinder foundation source parser preserves dollar-quoted bodies and ignores comment semicolons", () => {
  assert.equal(splitFixedSqlStatements(FIXED_SOURCE, { label: "Fixture" }).length, 2);
  assert.doesNotThrow(() => assertFixedTinderFoundationMigrationSource(FIXED_SOURCE, {
    label: "Fixture",
    expectedStatementHeads: ["DO", "ALTER TABLE contacts ALTER COLUMN whatsapp_jid DROP NOT NULL"]
  }));
  for (const unsafe of [
    "BEGIN; ALTER TABLE contacts ALTER COLUMN whatsapp_jid DROP NOT NULL;",
    "ALTER TABLE contacts ALTER COLUMN whatsapp_jid DROP NOT NULL",
    "ALTER TABLE contacts ALTER COLUMN whatsapp_jid DROP NOT NULL; /* unterminated",
    "ALTER TABLE contacts ALTER COLUMN whatsapp_jid DROP NOT NULL; ALTER TABLE contact_identifiers ADD COLUMN x text;"
  ]) {
    assert.throws(() => assertFixedTinderFoundationMigrationSource(unsafe, {
      label: "Fixture",
      expectedStatementHeads: ["ALTER TABLE contacts ALTER COLUMN whatsapp_jid DROP NOT NULL"]
    }));
  }
});

test("rollback-only pre-DDL validation never executes fixed DDL", async () => {
  let ddlExecuted = false;
  const preflight = async () => ({ mutate: true });
  const runner = createRunner({ preflight, postcheck: preflight });
  const fixture = fixturePool({ onDdl: () => { ddlExecuted = true; } });
  const result = await runner.validatePreDdl(fixture.pool);
  assert.equal(result.migrated, false);
  assert.equal(ddlExecuted, false);
  assert.equal(fixture.calls.some(call => call.sql === FIXED_SOURCE), false);
  assert.equal(fixture.calls.some(call => call.sql === "LOCK TABLE contacts IN SHARE MODE"), true);
  assert.equal(fixture.calls.some(call => call.sql.includes("ACCESS SHARE MODE")), false);
  assert.equal(fixture.calls.some(call => call.sql === "ROLLBACK"), true);
  assert.equal(fixture.calls.some(call => call.sql === "COMMIT"), false);
});

test("explicit apply performs fixed DDL only after two successful preflights and commits only after postcheck", async () => {
  let preflightCalls = 0;
  let ddlExecuted = false;
  const runner = createRunner({
    preflight: async () => ({ mutate: preflightCalls++ < 2 }),
    postcheck: async () => ({ mutate: false })
  });
  const fixture = fixturePool({ onDdl: () => { ddlExecuted = true; } });
  const result = await runner.migrate(fixture.pool);
  assert.equal(result.migrated, true);
  assert.equal(ddlExecuted, true);
  assert.equal(fixture.calls.some(call => call.sql === "COMMIT"), true);
  assert.equal(fixture.calls.some(call => call.sql === "ROLLBACK"), false);
});

test("a blocked global preflight rolls back before any DDL and exposes bounded state", async () => {
  const runner = createRunner({
    preflight: async () => { throw new Error("blocked"); },
    postcheck: async () => ({ mutate: false })
  });
  const fixture = fixturePool();
  const error = await runner.migrate(fixture.pool).catch(value => value);
  assert.deepEqual(getTinderFoundationMigrationFailureDiagnostic(error), {
    stage: "GLOBAL_PREFLIGHT",
    code: "DATABASE_OPERATION_FAILED",
    transaction: "STARTED",
    rollback: "COMPLETED",
    ddl_started: false
  });
  assert.equal(fixture.calls.some(call => call.sql === FIXED_SOURCE), false);
  assert.equal(fixture.calls.some(call => call.sql === "ROLLBACK"), true);
});
