import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  migrateDeviceBridgeAckSchema,
  FINAL_ACK_CONSTRAINT_NAME
} from "../device-bridge/ack-schema.js";
import { createAdminDeviceRevokeHandler } from "../device-bridge/admin.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const NOW = new Date("2026-09-01T12:34:56.000Z");
const OLD_CONSTRAINT = "device_bridge_command_acks_check3";
const ACK_COLUMNS = ["error", "result", "status"];

function checkDefinition(column, values) {
  return `CHECK (${column} IN (${values.map(value => `'${value}'`).join(", ")}))`;
}

function ackRows({ constraint, validated }) {
  return [{
    conname: constraint,
    convalidated: validated,
    condeferrable: false,
    condeferred: false,
    constraint_definition: constraint === FINAL_ACK_CONSTRAINT_NAME
      ? "CHECK ((status = 'RECEIVED' AND result IS NULL AND error IS NULL) OR (status = 'SUCCEEDED' AND error IS NULL) OR (status = 'FAILED' AND result IS NULL AND error IS NOT NULL) OR (status = 'REJECTED' AND result IS NULL) OR (status = 'EXPIRED' AND result IS NULL AND error IS NULL))"
      : "CHECK ((status = 'RECEIVED' AND result IS NULL AND error IS NULL))",
    column_names: ACK_COLUMNS
  }];
}

function schemaClient({ constraint = FINAL_ACK_CONSTRAINT_NAME, validated = true, incompatible = false } = {}) {
  const calls = [];
  const state = { constraint, validated };
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (sql.includes(`ADD CONSTRAINT ${FINAL_ACK_CONSTRAINT_NAME}`)) {
        state.constraint = FINAL_ACK_CONSTRAINT_NAME;
        state.validated = true;
      }
      if (sql.includes("FROM pg_constraint")) return { rows: ackRows(state) };
      if (sql.includes("AS incompatible")) return { rows: [{ incompatible }] };
      return { rows: [] };
    }
  };
}

test("standalone ACK migration keeps the named final ACK constraint", () => {
  const source = fs.readFileSync(new URL("../device-bridge/ack-schema.js", import.meta.url), "utf8");
  assert.match(source, /ADD CONSTRAINT \$\{FINAL_ACK_CONSTRAINT_NAME\}/);
});

test("T1-only runner never imports or calls ACK mutation", () => {
  const ddl = fs.readFileSync(new URL("../device-bridge/database.js", import.meta.url), "utf8");
  assert.match(ddl, /preflightDeviceBridgeAckSchemaForT1/);
  assert.doesNotMatch(ddl, /migrateDeviceBridgeAckSchema|ALTER TABLE device_bridge_command_acks|CREATE TABLE/);
});

test("existing old schema without ACK rows is migrated by constraint identity, not name", async () => {
  const client = schemaClient({ constraint: OLD_CONSTRAINT, incompatible: false });
  const result = await migrateDeviceBridgeAckSchema(client);
  assert.deepEqual(result, { migrated: true });
  assert.equal(client.calls.some(sql => sql.includes(`DROP CONSTRAINT \"${OLD_CONSTRAINT}\"`)), true);
  assert.equal(client.calls.some(sql => sql.includes(`ADD CONSTRAINT ${FINAL_ACK_CONSTRAINT_NAME}`)), true);
});

test("existing old schema with compatible ACK rows is migrated", async () => {
  const client = schemaClient({ constraint: "arbitrary_generated_name", incompatible: false });
  await migrateDeviceBridgeAckSchema(client);
  const compatibility = client.calls.findIndex(sql => sql.includes("AS incompatible"));
  const mutation = client.calls.findIndex(sql => sql.includes("ALTER TABLE"));
  assert.ok(compatibility > -1 && mutation > compatibility);
});

test("already final schema is unchanged and repeated initialization is idempotent", async () => {
  const client = schemaClient();
  assert.deepEqual(await migrateDeviceBridgeAckSchema(client), { migrated: false });
  assert.deepEqual(await migrateDeviceBridgeAckSchema(client), { migrated: false });
  assert.equal(client.calls.some(sql => sql.includes("ALTER TABLE")), false);
  assert.equal(client.calls.some(sql => sql.includes("AS incompatible")), false);
});

test("incompatible existing ACK data refuses every schema mutation", async () => {
  const client = schemaClient({ constraint: OLD_CONSTRAINT, incompatible: true });
  await assert.rejects(() => migrateDeviceBridgeAckSchema(client), /incompatible with Protocol V1/);
  assert.equal(client.calls.some(sql => sql.includes("ALTER TABLE")), false);
});

test("missing, ambiguous or unvalidated ACK constraint fails closed", async () => {
  for (const rows of [[], [
    ...ackRows({ constraint: OLD_CONSTRAINT, validated: true }),
    ...ackRows({ constraint: "another", validated: true })
  ]]) {
    const client = { async query(sql) { return sql.includes("FROM pg_constraint") ? { rows } : { rows: [] }; } };
    await assert.rejects(() => migrateDeviceBridgeAckSchema(client), /compatibility check failed/);
  }
  await assert.rejects(() => migrateDeviceBridgeAckSchema(schemaClient({ validated: false })), /compatibility check failed/);
});

function responseRecorder() {
  return { statusCode: null, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}

function revokePool({ missing = false, alreadyRevoked = false, failAudit = false } = {}) {
  const calls = [];
  const state = { deviceUpdates: 0, keyUpdates: 0, audits: 0, commits: 0, rollbacks: 0 };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "COMMIT") { state.commits += 1; return { rows: [] }; }
      if (sql === "ROLLBACK") { state.rollbacks += 1; return { rows: [] }; }
      if (sql.includes("FROM device_bridge_devices")) return { rows: missing ? [] : [{
        device_id: DEVICE_ID,
        enrollment_state: alreadyRevoked ? "REVOKED" : "ACTIVE",
        revoked_at: alreadyRevoked ? NOW : null
      }] };
      if (sql.includes("SELECT key_id")) return { rows: [{ key_id: "a565e8a7-ef60-42d0-b19d-26e7904390fa" }] };
      if (sql.includes("UPDATE device_bridge_devices")) { state.deviceUpdates += 1; return { rowCount: 1, rows: [] }; }
      if (sql.includes("UPDATE device_bridge_keys")) { state.keyUpdates += 1; return { rowCount: 1, rows: [] }; }
      if (sql.includes("INSERT INTO device_bridge_audit_events")) {
        if (failAudit) throw new Error("audit failure");
        state.audits += 1; return { rowCount: 1, rows: [] };
      }
      return { rows: [] };
    },
    release() { state.released = true; }
  };
  return { pool: { async connect() { return client; } }, calls, state };
}

test("admin revoke atomically revokes device and active keys with safe audit", async () => {
  const fake = revokePool();
  const res = responseRecorder();
  await createAdminDeviceRevokeHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.enrollment_state, "REVOKED");
  assert.equal(fake.state.deviceUpdates, 1);
  assert.equal(fake.state.keyUpdates, 1);
  assert.equal(fake.state.audits, 1);
  assert.equal(fake.state.commits, 1);
  const audit = fake.calls.find(call => call.sql.includes("device_bridge_audit_events"));
  assert.deepEqual(JSON.parse(audit.params[1]), { reason: "ADMIN_REQUEST" });
  assert.equal(JSON.stringify(audit).match(/signature|public_key|token|cookie|credential/i), null);
});

test("admin revoke is idempotent without duplicate mutation or audit", async () => {
  const fake = revokePool({ alreadyRevoked: true });
  const res = responseRecorder();
  await createAdminDeviceRevokeHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(fake.state.deviceUpdates, 0);
  assert.equal(fake.state.keyUpdates, 0);
  assert.equal(fake.state.audits, 0);
  assert.equal(fake.state.commits, 1);
});

test("admin revoke validates identifier/body and reports missing device", async () => {
  for (const request of [
    { params: { deviceId: "invalid" }, body: {} },
    { params: { deviceId: DEVICE_ID }, body: { reason: "injected" } }
  ]) {
    const fake = revokePool();
    const res = responseRecorder();
    await createAdminDeviceRevokeHandler(fake.pool)(request, res);
    assert.equal(res.statusCode, 400);
    assert.equal(fake.calls.length, 0);
  }
  const missing = revokePool({ missing: true });
  const res = responseRecorder();
  await createAdminDeviceRevokeHandler(missing.pool)({ params: { deviceId: DEVICE_ID }, body: {} }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(missing.state.rollbacks, 1);
});

test("admin revoke DB failure rolls device, keys and audit back", async () => {
  const fake = revokePool({ failAudit: true });
  const res = responseRecorder();
  const originalError = console.error;
  console.error = () => {};
  try {
    await createAdminDeviceRevokeHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body: {} }, res);
  } finally {
    console.error = originalError;
  }
  assert.equal(res.statusCode, 500);
  assert.equal(fake.state.deviceUpdates, 1);
  assert.equal(fake.state.keyUpdates, 1);
  assert.equal(fake.state.commits, 0);
  assert.equal(fake.state.rollbacks, 1);
});

test("admin revoke route reuses dashboard auth and Device Bridge readiness", () => {
  const routes = fs.readFileSync(new URL("../device-bridge/block3-routes.js", import.meta.url), "utf8");
  assert.match(routes, /app\.post\("\/dashboard-api\/device-bridge\/devices\/:deviceId\/revoke", admin\(revokeDevice\)\)/);
});
