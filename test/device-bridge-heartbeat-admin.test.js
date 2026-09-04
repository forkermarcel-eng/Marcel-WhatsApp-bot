import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  T0_DEVICE_CAPABILITIES,
  T1_DEVICE_CAPABILITIES,
  canonicalRequest,
  sha256Hex
} from "../device-bridge/protocol-v1.js";
import {
  createHeartbeatHandler,
  deriveDeviceStatus,
  parseAndValidateHeartbeat,
  processHeartbeatTransaction
} from "../device-bridge/heartbeat.js";
import {
  COMMAND_EXPIRY_MS,
  canonicalCommand,
  createAdminCommandHandler,
  createAdminDeviceListHandler,
  createAdminDeviceStatusHandler
} from "../device-bridge/admin.js";

const NOW = new Date("2026-09-01T12:34:56.000Z");
const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const KEY_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const REQUEST_ID = "d2675347-0888-4548-9feb-ae4d71a972cf";
const INSTALLATION_ID = "c7cb0b92-ad3c-4ec6-88dc-d149ef536c3d";
const CAPABILITIES = T0_DEVICE_CAPABILITIES;

function heartbeatPayload(overrides = {}) {
  return {
    protocol_version: 1,
    sequence: 1,
    sent_at: NOW.toISOString(),
    app: { version_name: "1.0", version_code: 1 },
    device: { installation_id: INSTALLATION_ID, manufacturer: "ZTE", model: "ZTE Blade A35e", android_api: 35, abis: ["arm64-v8a"] },
    bridge: { service_state: "RUNNING", started_at: "2026-09-01T12:30:00.000Z", last_successful_heartbeat_at: null },
    capabilities: CAPABILITIES,
    tinder_state: "UNKNOWN",
    automation_state: "STOPPED",
    ...overrides
  };
}

function heartbeatRequest(payload = heartbeatPayload(), { requestId = REQUEST_ID, keys, now = NOW } = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const hash = sha256Hex(body);
  const path = `/device-bridge/v1/devices/${DEVICE_ID}/heartbeat`;
  const pair = keys || crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const canonical = canonicalRequest({ protocolVersion: 1, method: "POST", path, timestamp: now.toISOString(), requestId, contentSha256: hash });
  const headers = {
    "x-marcel-protocol-version": "1", "x-marcel-device-id": DEVICE_ID,
    "x-marcel-key-id": KEY_ID, "x-marcel-timestamp": now.toISOString(),
    "x-marcel-request-id": requestId, "x-marcel-content-sha256": hash,
    "x-marcel-signature": crypto.sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64url")
  };
  return {
    req: { method: "POST", originalUrl: path, body, params: { deviceId: DEVICE_ID }, get: name => headers[name.toLowerCase()] },
    keys: pair,
    hash,
    headers
  };
}

function responseRecorder() {
  return { statusCode: null, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}

function commandRow(type, issuedAt, id, overrides = {}) {
  return {
    command_id: id,
    protocol_version: 1,
    command_type: type,
    issued_at: issuedAt,
    expires_at: new Date(issuedAt.valueOf() + 300_000),
    configuration_revision: 1,
    payload: type === "STOP_BRIDGE" ? { reason: "ADMIN_REQUEST" } : {},
    ...overrides
  };
}

function heartbeatPool({ request, sequence = null, bodyHash = null, acceptedAt = null, commands = [], failUpdate = false, nonceReplay = false } = {}) {
  const calls = [];
  const state = { updates: 0, audits: 0, commits: 0, rollbacks: 0, nonceInserts: 0 };
  const authRow = {
    device_id: DEVICE_ID, key_id: KEY_ID, enrollment_state: "ACTIVE",
    device_revoked_at: null, key_revoked_at: null,
    public_key_spki_der: request?.keys.publicKey.export({ type: "spki", format: "der" })
  };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "COMMIT") { state.commits += 1; return { rows: [] }; }
      if (sql === "ROLLBACK") { state.rollbacks += 1; return { rows: [] }; }
      if (sql.includes("FOR UPDATE") && sql.includes("device_bridge_devices")) return { rows: [{
        device_id: DEVICE_ID, installation_id: INSTALLATION_ID, enrollment_state: "ACTIVE", revoked_at: null,
        key_id: KEY_ID, key_revoked_at: null,
        last_heartbeat_sequence: sequence, last_heartbeat_body_sha256: bodyHash,
        last_accepted_heartbeat_at: acceptedAt
      }] };
      if (sql.includes("INSERT INTO device_bridge_request_nonces")) {
        if (nonceReplay) { const error = new Error("duplicate"); error.code = "23505"; throw error; }
        state.nonceInserts += 1; return { rowCount: 1, rows: [] };
      }
      if (sql.includes("UPDATE device_bridge_devices")) {
        if (failUpdate) throw new Error("simulated update failure");
        state.updates += 1; return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO device_bridge_audit_events")) { state.audits += 1; return { rowCount: 1, rows: [] }; }
      if (sql.includes("FROM device_bridge_commands")) {
        const deliversT1 = sql.includes("CONNECT_TINDER") && sql.includes("DISCONNECT_TINDER");
        return {
          rows: commands.filter(command =>
            deliversT1 || !["CONNECT_TINDER", "DISCONNECT_TINDER"].includes(command.command_type)
          )
        };
      }
      return { rows: [] };
    },
    release() { state.released = true; }
  };
  return {
    pool: {
      async query(sql) { if (sql.includes("LEFT JOIN device_bridge_keys")) return { rows: [authRow] }; return { rows: [] }; },
      async connect() { return client; }
    },
    calls,
    state
  };
}

test("valid signed heartbeat reaches handler and returns Protocol V1 response", async () => {
  const current = new Date();
  const payload = heartbeatPayload({ sent_at: current.toISOString() });
  const request = heartbeatRequest(payload, { now: current });
  const fake = heartbeatPool({ request });
  const res = responseRecorder();
  await createHeartbeatHandler(fake.pool)(request.req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.protocol_version, 1);
  assert.equal(fake.state.commits, 1);
});

test("heartbeat validation preserves T0 and accepts only the exact T1 state profile", () => {
  assert.doesNotThrow(() => parseAndValidateHeartbeat(heartbeatRequest().req));
  for (const tinderState of ["DISCONNECTED", "CONNECTING", "CONNECTED", "AUTH_REQUIRED", "REVIEW_REQUIRED", "UNKNOWN"]) {
    assert.doesNotThrow(() => parseAndValidateHeartbeat(heartbeatRequest(heartbeatPayload({
      capabilities: T1_DEVICE_CAPABILITIES,
      tinder_state: tinderState
    })).req));
  }
  for (const payload of [
    heartbeatPayload({ tinder_state: "CONNECTED" }),
    heartbeatPayload({ capabilities: T1_DEVICE_CAPABILITIES, tinder_state: "NOT_A_STATE" }),
    heartbeatPayload({ automation_state: "RUNNING" }),
    heartbeatPayload({ capabilities: [...CAPABILITIES].reverse() }),
    heartbeatPayload({ capabilities: [...T1_DEVICE_CAPABILITIES, "TINDER_VISIBLE_CHAT_READ_V1"] })
  ]) assert.throws(() => parseAndValidateHeartbeat(heartbeatRequest(payload).req), error => error.code === "INVALID_DEVICE_STATE");
});

test("T1 heartbeat persists the local Tinder state without deriving it from online state", async () => {
  const payload = heartbeatPayload({ capabilities: T1_DEVICE_CAPABILITIES, tinder_state: "CONNECTED" });
  const request = heartbeatRequest(payload);
  const fake = heartbeatPool({ request });
  await processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash }, payload, NOW);
  const update = fake.calls.find(call => call.sql.includes("UPDATE device_bridge_devices"));
  assert.equal(update.params[9], "CONNECTED");
  assert.equal(update.params[10], 1);
});

test("heartbeat sequence 1 and higher sequence update exactly once", async () => {
  for (const [previous, next] of [[null, 1], [1, 2]]) {
    const request = heartbeatRequest(heartbeatPayload({ sequence: next }));
    const fake = heartbeatPool({ request, sequence: previous });
    const response = await processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash }, heartbeatPayload({ sequence: next }), NOW);
    assert.equal(response.accepted_at, NOW.toISOString());
    assert.equal(fake.state.updates, 1);
    assert.equal(fake.state.audits, 1);
  }
});

test("same sequence and same hash is idempotent with new request id", async () => {
  const retryId = "4dbf2bd9-3d7c-4925-89de-fc0dc62a2fe1";
  const request = heartbeatRequest(heartbeatPayload({ sequence: 4 }), { requestId: retryId });
  const originalAcceptedAt = new Date(NOW.valueOf() - 5000);
  const fake = heartbeatPool({ request, sequence: 4, bodyHash: request.hash, acceptedAt: originalAcceptedAt });
  const response = await processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: retryId, contentSha256: request.hash }, heartbeatPayload({ sequence: 4 }), NOW);
  assert.equal(response.accepted_at, originalAcceptedAt.toISOString());
  assert.equal(response.server_time, NOW.toISOString());
  assert.equal(fake.state.updates, 0);
  assert.equal(fake.state.audits, 0);
  assert.equal(fake.state.nonceInserts, 1);
});

test("same sequence with another hash and smaller sequence conflict", async () => {
  for (const [sequence, hash] of [[4, "b".repeat(64)], [3, "a".repeat(64)]]) {
    const request = heartbeatRequest(heartbeatPayload({ sequence }));
    const fake = heartbeatPool({ request, sequence: 4, bodyHash: hash, acceptedAt: NOW });
    await assert.rejects(() => processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash }, heartbeatPayload({ sequence }), NOW), error => error.code === "HEARTBEAT_SEQUENCE_CONFLICT");
    assert.equal(fake.state.rollbacks, 1);
  }
});

test("same request id replay rolls back before heartbeat update", async () => {
  const request = heartbeatRequest();
  const fake = heartbeatPool({ request, nonceReplay: true });
  await assert.rejects(() => processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash }, heartbeatPayload(), NOW), error => error.code === "REQUEST_REPLAYED");
  assert.equal(fake.state.updates, 0);
  assert.equal(fake.state.rollbacks, 1);
});

test("database failure rolls nonce and heartbeat back together logically", async () => {
  const request = heartbeatRequest();
  const fake = heartbeatPool({ request, failUpdate: true });
  await assert.rejects(() => processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash }, heartbeatPayload(), NOW));
  assert.equal(fake.state.nonceInserts, 1);
  assert.equal(fake.state.commits, 0);
  assert.equal(fake.state.rollbacks, 1);
});

test("ONLINE/OFFLINE derives only from server accepted time", () => {
  assert.equal(deriveDeviceStatus(null, NOW), "OFFLINE");
  assert.equal(deriveDeviceStatus(new Date(NOW.valueOf() - 90_000), NOW), "ONLINE");
  assert.equal(deriveDeviceStatus(new Date(NOW.valueOf() - 90_001), NOW), "OFFLINE");
  const payload = heartbeatPayload({ sent_at: "2020-01-01T00:00:00.000Z" });
  assert.equal(payload.sent_at.includes("2020"), true);
  assert.equal(deriveDeviceStatus(new Date(NOW.valueOf() - 1000), NOW), "ONLINE");
});

test("heartbeat response has fixed configuration and ACTIVE directive", async () => {
  const request = heartbeatRequest();
  const fake = heartbeatPool({ request });
  const response = await processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash }, heartbeatPayload(), NOW);
  assert.deepEqual(response.configuration, { heartbeat_interval_seconds: 30, offline_after_seconds: 90, signature_window_seconds: 300, configuration_revision: 1 });
  assert.equal(response.device_directive, "CONTINUE");
  assert.equal(response.server_time, NOW.toISOString());
});

test("command delivery is device-scoped, ordered, bounded and non-terminalizing", async () => {
  const first = commandRow("PING", new Date(NOW.valueOf() - 2000), "11111111-1111-4111-8111-111111111111");
  const second = commandRow("STOP_BRIDGE", new Date(NOW.valueOf() - 1000), "22222222-2222-4222-8222-222222222222");
  const request = heartbeatRequest();
  const fake = heartbeatPool({ request, commands: [first, second] });
  const response = await processHeartbeatTransaction(fake.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: request.hash }, heartbeatPayload(), NOW);
  assert.deepEqual(response.commands.map(command => command.command_id), [first.command_id, second.command_id]);
  assert.deepEqual(response.commands[1].payload, { reason: "ADMIN_REQUEST" });
  const query = fake.calls.find(call => call.sql.includes("FROM device_bridge_commands"));
  assert.equal(query.params[0], DEVICE_ID);
  assert.equal(query.params[2], 50);
  assert.match(query.sql, /expires_at>\$2/);
  assert.match(query.sql, /ORDER BY issued_at ASC, command_id ASC/);
  assert.equal(fake.calls.some(call => /UPDATE device_bridge_commands/.test(call.sql)), false);
});

test("T1 command delivery is capability-gated against the current heartbeat profile", async () => {
  const command = commandRow("CONNECT_TINDER", new Date(NOW.valueOf() - 1000), "33333333-3333-4333-8333-333333333333");
  const t0Request = heartbeatRequest();
  const t0 = heartbeatPool({ request: t0Request, commands: [command] });
  const t0Response = await processHeartbeatTransaction(t0.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: t0Request.hash }, heartbeatPayload(), NOW);
  const t0Query = t0.calls.find(call => call.sql.includes("FROM device_bridge_commands"));
  assert.doesNotMatch(t0Query.sql, /CONNECT_TINDER/);
  assert.deepEqual(t0Response.commands, []);

  const t1Payload = heartbeatPayload({ capabilities: T1_DEVICE_CAPABILITIES, tinder_state: "DISCONNECTED" });
  const t1Request = heartbeatRequest(t1Payload);
  const t1 = heartbeatPool({ request: t1Request, commands: [command] });
  const response = await processHeartbeatTransaction(t1.pool, { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: t1Request.hash }, t1Payload, NOW);
  const t1Query = t1.calls.find(call => call.sql.includes("FROM device_bridge_commands"));
  assert.match(t1Query.sql, /CONNECT_TINDER/);
  assert.equal(response.commands[0].type, "CONNECT_TINDER");
  assert.deepEqual(response.commands[0].payload, {});
});

function statusRow(lastAccepted = null, capabilities = CAPABILITIES, tinderState = "UNKNOWN") {
  return {
    device_id: DEVICE_ID, display_name: "ZTE Blade A35e", enrollment_state: "ACTIVE",
    created_at: NOW,
    last_accepted_heartbeat_at: lastAccepted, app_version_name: "1.0", app_version_code: "1",
    bridge_service_state: "RUNNING", tinder_state: tinderState, automation_state: "STOPPED", capabilities,
    configuration_revision: 1
  };
}

test("admin list and status expose separated states without sensitive key data", async () => {
  const pool = { async query(sql) { return { rows: [statusRow()] }; } };
  const listRes = responseRecorder();
  await createAdminDeviceListHandler(pool)({}, listRes);
  assert.equal(listRes.body.devices[0].device_status, "OFFLINE");
  assert.equal(listRes.body.devices[0].enrolled_at, NOW.toISOString());
  const statusRes = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, statusRes);
  assert.equal(statusRes.body.device.tinder_state, "UNKNOWN");
  assert.equal(statusRes.body.device.automation_state, "STOPPED");
  assert.equal(statusRes.body.device.tinder_manual_gate_capable, false);
  const serialized = JSON.stringify(statusRes.body);
  for (const field of ["public_key", "signature", "enrollment_code", "key_id"]) assert.equal(serialized.includes(field), false);
});

test("admin status exposes only the derived T1 capability flag", async () => {
  const pool = { async query() { return { rows: [statusRow(NOW, T1_DEVICE_CAPABILITIES, "CONNECTED")] }; } };
  const res = responseRecorder();
  await createAdminDeviceStatusHandler(pool)({ params: { deviceId: DEVICE_ID } }, res);
  assert.equal(res.body.device.tinder_manual_gate_capable, true);
  assert.equal(JSON.stringify(res.body).includes("TINDER_MANUAL_GATE_V1"), false);
});

function commandPool({
  active = true,
  failAudit = false,
  capabilities = CAPABILITIES,
  lastAcceptedHeartbeatAt = new Date(),
  bridgeServiceState = "RUNNING",
  tinderState = "DISCONNECTED"
} = {}) {
  const calls = [];
  const state = { commit: false, rollback: false };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "COMMIT") { state.commit = true; return { rows: [] }; }
      if (sql === "ROLLBACK") { state.rollback = true; return { rows: [] }; }
      if (sql.includes("FOR UPDATE")) return { rows: [{
        device_id: DEVICE_ID,
        enrollment_state: active ? "ACTIVE" : "REVOKED",
        revoked_at: active ? null : NOW,
        configuration_revision: 1,
        capabilities,
        last_accepted_heartbeat_at: lastAcceptedHeartbeatAt,
        bridge_service_state: bridgeServiceState,
        tinder_state: tinderState
      }] };
      if (sql.includes("COMMAND_CREATED") && failAudit) throw new Error("simulated audit failure");
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  return { pool: { async connect() { return client; } }, calls, state };
}

test("admin creates canonical PING, REQUEST_STATUS and STOP_BRIDGE commands", async () => {
  for (const type of ["PING", "REQUEST_STATUS", "STOP_BRIDGE"]) {
    const fake = commandPool();
    const res = responseRecorder();
    await createAdminCommandHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body: { type } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.command.type, type);
    assert.deepEqual(res.body.command.payload, type === "STOP_BRIDGE" ? { reason: "ADMIN_REQUEST" } : {});
    assert.equal(new Date(res.body.command.expires_at) - new Date(res.body.command.issued_at), COMMAND_EXPIRY_MS[type]);
    assert.equal(fake.state.commit, true);
  }
});

test("admin creates only canonical T1 manual-gate commands for a compatible running device", async () => {
  for (const type of ["CONNECT_TINDER", "DISCONNECT_TINDER"]) {
    const fake = commandPool({ capabilities: T1_DEVICE_CAPABILITIES, tinderState: "DISCONNECTED" });
    const res = responseRecorder();
    await createAdminCommandHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body: { type } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.command.type, type);
    assert.deepEqual(res.body.command.payload, {});
    assert.equal(new Date(res.body.command.expires_at) - new Date(res.body.command.issued_at), COMMAND_EXPIRY_MS[type]);
    assert.equal(fake.state.commit, true);
  }
});

test("admin fails T1 commands closed for capability, online, bridge and unsafe-connect gates", async () => {
  const cases = [
    [{ capabilities: CAPABILITIES }, "DEVICE_CAPABILITY_UNSUPPORTED"],
    [{ capabilities: T1_DEVICE_CAPABILITIES, lastAcceptedHeartbeatAt: new Date(Date.now() - 91_000) }, "DEVICE_OFFLINE"],
    [{ capabilities: T1_DEVICE_CAPABILITIES, bridgeServiceState: "STOPPED" }, "BRIDGE_NOT_RUNNING"],
    [{ capabilities: T1_DEVICE_CAPABILITIES, tinderState: "UNKNOWN" }, "TINDER_STATE_UNSAFE"]
  ];
  for (const [options, code] of cases) {
    const fake = commandPool(options);
    const res = responseRecorder();
    await createAdminCommandHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body: { type: "CONNECT_TINDER" } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error.code, code);
    assert.equal(fake.calls.some(call => call.sql.includes("INSERT INTO device_bridge_commands")), false);
  }

  const disconnect = commandPool({ capabilities: T1_DEVICE_CAPABILITIES, tinderState: "REVIEW_REQUIRED" });
  const res = responseRecorder();
  await createAdminCommandHandler(disconnect.pool)({ params: { deviceId: DEVICE_ID }, body: { type: "DISCONNECT_TINDER" } }, res);
  assert.equal(res.statusCode, 201);
});

test("admin cannot inject type, payload or expires_at", async () => {
  for (const body of [{ type: "UNKNOWN" }, { type: "PING", payload: { injected: true } }, { type: "PING", expires_at: NOW.toISOString() }]) {
    const fake = commandPool();
    const res = responseRecorder();
    await createAdminCommandHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(fake.calls.length, 0);
  }
  assert.throws(() => canonicalCommand("UNKNOWN"), error => error.code === "COMMAND_TYPE_UNSUPPORTED");
});

test("command insert and audit are atomic and audit contains no sensitive values", async () => {
  const fake = commandPool({ failAudit: true });
  const res = responseRecorder();
  const originalError = console.error;
  console.error = () => {};
  try {
    await createAdminCommandHandler(fake.pool)({ params: { deviceId: DEVICE_ID }, body: { type: "PING" } }, res);
  } finally {
    console.error = originalError;
  }
  assert.equal(res.statusCode, 500);
  assert.equal(fake.state.commit, false);
  assert.equal(fake.state.rollback, true);
  const audit = fake.calls.find(call => call.sql.includes("COMMAND_CREATED"));
  assert.equal(JSON.stringify(audit).match(/signature|public_key|enrollment_code|secret|cookie/i), null);
});

test("Block 3 admin routes reuse dashboard auth/readiness", () => {
  const source = fs.readFileSync(new URL("../device-bridge/block3-routes.js", import.meta.url), "utf8");
  assert.match(source, /dashboardApiReady\(res\)/);
  assert.match(source, /dashboardApiAuthorized\(req\)/);
  assert.match(source, /requireDeviceBridgeReady\(res\)/);
  assert.match(source, /devices\/:deviceId\/heartbeat/);
});
