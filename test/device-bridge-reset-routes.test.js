import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parseAndValidateResetHeartbeat } from "../device-bridge/reset-heartbeat.js";
import {
  RETAINED_COMMANDS,
  normalizeRetainedAck,
  processResetCommandAckTransaction
} from "../device-bridge/reset-command-ack.js";
import { registerDeviceBridgeResetRoutes } from "../device-bridge/reset-block-routes.js";
import { createResetAdminCommandHandler } from "../device-bridge/reset-admin.js";
import {
  RESET_FOUNDATION,
  initializeResetDeviceBridgeDatabase,
  verifyResetDeviceBridgeSchema
} from "../device-bridge/reset-initialization.js";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const STAMP = "2026-09-23T10:00:00.000Z";

function resetSchemaPool({ missing = null } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("to_regclass")) {
        const table = String(params[0]).replace("public.", "");
        return { rows: [{ relation_name: table === missing ? null : table }] };
      }
      if (sql.includes("information_schema.columns")) {
        const [table, requested] = params;
        const present = table === missing ? [] : requested;
        return { rows: present.map((column_name) => ({ column_name })) };
      }
      throw new Error("Unexpected reset schema query");
    },
    release() { this.released = true; }
  };
  return { pool: { async connect() { return client; } }, client, calls };
}

function hasMutation(calls) {
  return calls.some(({ sql }) => /\b(ALTER|CREATE|DELETE|DROP|INSERT|UPDATE|LOCK|BEGIN|COMMIT|ROLLBACK)\b/i.test(sql));
}

function heartbeatRequest(body) {
  return {
    body: Buffer.from(JSON.stringify(body), "utf8"),
    get(name) { return name === "x-marcel-timestamp" ? STAMP : undefined; }
  };
}

test("reset schema readiness checks only generic tables and columns, read-only", async () => {
  const fake = resetSchemaPool();
  const result = await verifyResetDeviceBridgeSchema(fake.pool);

  assert.deepEqual(result, { ready: true });
  assert.equal(fake.client.released, true);
  assert.equal(hasMutation(fake.calls), false);
  assert.equal(fake.calls.some(({ sql }) => /tinder|permit|capture|attestation|receipt/i.test(sql)), false);
  assert.equal(Object.keys(RESET_FOUNDATION).length, 7);
});

test("reset initialization fails closed without a legacy schema check or mutation", async () => {
  const fake = resetSchemaPool({ missing: "device_bridge_commands" });
  let marked = false;
  const logs = [];
  const ready = await initializeResetDeviceBridgeDatabase(fake.pool, {
    markReady: () => { marked = true; },
    logger: { log: (message) => logs.push(["log", message]), error: (message) => logs.push(["error", message]) }
  });

  assert.equal(ready, false);
  assert.equal(marked, false);
  assert.equal(hasMutation(fake.calls), false);
  assert.deepEqual(logs, [["error", "Generic Device Bridge schema readiness check failed."]]);
});

test("legacy heartbeat fields are accepted then excluded from the reset projection", () => {
  const heartbeat = parseAndValidateResetHeartbeat(heartbeatRequest({
    protocol_version: 1,
    sequence: 7,
    sent_at: STAMP,
    app: { version_name: "1.2.3", version_code: 12 },
    device: {
      installation_id: DEVICE_ID,
      manufacturer: "ZTE",
      model: "Z2466",
      android_api: 35,
      abis: ["arm64-v8a"]
    },
    bridge: { service_state: "RUNNING", started_at: null, last_successful_heartbeat_at: null },
    capabilities: ["COMMAND_PING_V1", "COMMAND_INJECTED_V1", "TINDER_VISIBLE_CHAT_READ_V1"],
    tinder_state: "CONNECTED",
    automation_state: "RUNNING",
    tinder_legacy_diagnostic: { ignored: true }
  }));

  assert.equal(Object.hasOwn(heartbeat, "tinder_state"), false);
  assert.deepEqual(heartbeat.capabilities, ["COMMAND_PING_V1"]);
});

test("generic status acknowledgement discards a legacy tinder field before persistence", () => {
  const normalized = normalizeRetainedAck({
    status: "SUCCEEDED",
    result: { bridge_service_state: "RUNNING", automation_state: "STOPPED", tinder_state: "CONNECTED" },
    error: null
  }, "REQUEST_STATUS");

  assert.deepEqual(normalized.result, { bridge_service_state: "RUNNING", automation_state: "STOPPED" });
  assert.deepEqual([...RETAINED_COMMANDS].sort(), ["PING", "REQUEST_STATUS", "STOP_BRIDGE"]);
});

test("retired Tinder command acknowledgement is rejected before nonce, ack, or device mutation", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM device_bridge_devices d")) {
        return { rows: [{
          device_id: DEVICE_ID,
          enrollment_state: "ACTIVE",
          revoked_at: null,
          configuration_revision: 1,
          key_id: "22222222-2222-4222-8222-222222222222",
          key_revoked_at: null
        }] };
      }
      if (sql.includes("FROM device_bridge_commands")) {
        return { rows: [{
          command_id: "33333333-3333-4333-8333-333333333333",
          device_id: DEVICE_ID,
          command_type: "CONNECT_TINDER",
          payload: {},
          configuration_revision: 1,
          expires_at: "2026-09-23T11:00:00.000Z",
          terminal_status: null
        }] };
      }
      throw new Error("Unexpected command acknowledgement query");
    },
    release() { this.released = true; }
  };
  const pool = { async connect() { return client; } };

  await assert.rejects(
    () => processResetCommandAckTransaction(pool, {
      deviceId: DEVICE_ID,
      keyId: "22222222-2222-4222-8222-222222222222",
      requestId: "44444444-4444-4444-8444-444444444444"
    }, {
      command_id: "33333333-3333-4333-8333-333333333333",
      status: "SUCCEEDED",
      occurred_at: STAMP,
      result: { tinder_state: "CONNECTED" },
      error: null
    }, new Date(STAMP)),
    (error) => error?.status === 410 && error?.code === "RETIRED_COMMAND"
  );

  assert.equal(calls.some((sql) => /INSERT INTO device_bridge_(request_nonces|command_acks)/.test(sql)), false);
  assert.equal(calls.some((sql) => /UPDATE device_bridge_devices/.test(sql)), false);
  assert.equal(client.released, true);
});

test("dashboard command creation retires a Tinder command before opening a database transaction", async () => {
  const handler = createResetAdminCommandHandler({
    async connect() { throw new Error("must not connect"); }
  });
  const response = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };

  await handler({ params: { deviceId: DEVICE_ID }, body: { type: "CONNECT_TINDER" } }, response);

  assert.equal(response.statusCode, 410);
  assert.equal(response.body.error.code, "RETIRED_COMMAND");
});

test("reset route registration retains only generic signed and admin bridge endpoints", () => {
  const routes = [];
  const app = {
    get(path) { routes.push(["GET", path]); },
    post(path) { routes.push(["POST", path]); }
  };
  registerDeviceBridgeResetRoutes({
    app,
    pool: {},
    dashboardApiReady: () => true,
    dashboardApiAuthorized: () => true,
    requireDeviceBridgeReady: () => true
  });

  assert.deepEqual(routes, [
    ["POST", "/device-bridge/v1/devices/:deviceId/heartbeat"],
    ["POST", "/device-bridge/v1/devices/:deviceId/commands/:commandId/ack"],
    ["GET", "/dashboard-api/device-bridge/devices"],
    ["GET", "/dashboard-api/device-bridge/devices/:deviceId/status"],
    ["GET", "/dashboard-api/device-bridge/devices/:deviceId/commands/:commandId"],
    ["POST", "/dashboard-api/device-bridge/devices/:deviceId/revoke"],
    ["POST", "/dashboard-api/device-bridge/devices/:deviceId/commands"]
  ]);
  assert.equal(routes.some(([, path]) => /tinder/i.test(path)), false);
});

test("active startup and package scripts contain no Tinder product entrypoint", () => {
  const index = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(index, /initializeResetDeviceBridgeDatabase/);
  assert.match(index, /registerDeviceBridgeResetRoutes/);
  assert.doesNotMatch(index, /registerTinder|tinder-visible-chat-capture-ingress|tinder-product-read-routes|tinder-passive-read-readiness/);
  assert.deepEqual(Object.keys(packageJson.scripts).filter((name) => /tinder/i.test(name)), []);
});
