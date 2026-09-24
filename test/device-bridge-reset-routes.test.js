import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { parseAndValidateResetHeartbeat } from "../device-bridge/reset-heartbeat.js";
import { RETAINED_COMMANDS } from "../device-bridge/reset-command-ack.js";
import { registerDeviceBridgeResetRoutes } from "../device-bridge/reset-block-routes.js";
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

function genericHeartbeatBody() {
  return {
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
    capabilities: ["COMMAND_PING_V1", "COMMAND_REQUEST_STATUS_V1"]
  };
}

test("reset schema readiness checks only generic tables and columns, read-only", async () => {
  const fake = resetSchemaPool();
  const result = await verifyResetDeviceBridgeSchema(fake.pool);

  assert.deepEqual(result, { ready: true });
  assert.equal(fake.client.released, true);
  assert.equal(hasMutation(fake.calls), false);
  assert.equal(Object.keys(RESET_FOUNDATION).length, 7);
});

test("reset initialization fails closed without a non-generic schema check or mutation", async () => {
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

test("generic heartbeat projection accepts only the baseline envelope", () => {
  const heartbeat = parseAndValidateResetHeartbeat(heartbeatRequest(genericHeartbeatBody()));

  assert.deepEqual(heartbeat.capabilities, ["COMMAND_PING_V1", "COMMAND_REQUEST_STATUS_V1"]);
  assert.throws(
    () => parseAndValidateResetHeartbeat(heartbeatRequest({ ...genericHeartbeatBody(), unexpected_field: true })),
    (error) => error?.code === "INVALID_BODY"
  );
});

test("generic command allowlist is fixed", () => {
  assert.deepEqual([...RETAINED_COMMANDS].sort(), ["PING", "REQUEST_STATUS", "STOP_BRIDGE"]);
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
});

test("active startup retains no retired product entrypoint and exposes only focused Tinder mirror operations", () => {
  const index = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

  assert.match(index, /initializeResetDeviceBridgeDatabase/);
  assert.match(index, /registerDeviceBridgeResetRoutes/);
  assert.deepEqual(Object.keys(packageJson.scripts).filter((name) => /tinder/i.test(name)), [
    "test:tinder-mirror",
    "test:tinder-last-message-order-migration",
    "preflight:tinder-conversation-mirror",
    "migrate:tinder-conversation-mirror",
    "preflight:tinder-block2-last-message-order",
    "migrate:tinder-block2-last-message-order"
  ]);
  assert.equal(packageJson.scripts["test:tinder-mirror"], "node --test test/tinder-conversation-mirror.test.js");
  assert.match(packageJson.scripts["preflight:tinder-conversation-mirror"], /--preflight/);
  assert.match(packageJson.scripts["migrate:tinder-conversation-mirror"], /--apply/);
  assert.match(packageJson.scripts["preflight:tinder-block2-last-message-order"], /--preflight/);
  assert.match(packageJson.scripts["migrate:tinder-block2-last-message-order"], /--apply/);
});
