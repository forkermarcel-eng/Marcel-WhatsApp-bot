import assert from "node:assert/strict";
import test from "node:test";
import { createAdminCommandStatusHandler } from "../device-bridge/admin.js";
import { registerDeviceBridgeBlock3Routes } from "../device-bridge/block3-routes.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const OTHER_DEVICE_ID = "d2675347-0888-4548-9feb-ae4d71a972cf";
const COMMAND_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const NOW = "2026-09-02T12:00:00.000Z";

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

function commandRow(overrides = {}) {
  return {
    command_id: COMMAND_ID,
    device_id: DEVICE_ID,
    protocol_version: 1,
    command_type: "PING",
    issued_at: NOW,
    delivered_at: null,
    terminal_status: null,
    terminal_at: null,
    ...overrides
  };
}

function acknowledgementRow(status, overrides = {}) {
  return {
    status,
    occurred_at: "2026-09-02T12:00:02.000Z",
    accepted_at: "2026-09-02T12:00:03.000Z",
    result: status === "SUCCEEDED" ? { pong: true } : null,
    error: status === "FAILED" ? { code: "COMMAND_EXECUTION_FAILED", message: "Execution failed" } : null,
    ...overrides
  };
}

function readPool({ deviceExists = true, command = commandRow(), acknowledgement = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("FROM device_bridge_devices")) {
        return { rows: deviceExists ? [{ device_id: DEVICE_ID }] : [] };
      }
      if (sql.includes("FROM device_bridge_commands")) {
        const belongsToDevice = command && command.device_id === params[0] && command.command_id === params[1];
        return { rows: belongsToDevice ? [command] : [] };
      }
      if (sql.includes("FROM device_bridge_command_acks")) {
        return { rows: acknowledgement ? [acknowledgement] : [] };
      }
      throw new Error("Unexpected query");
    }
  };
}

async function readStatus(pool, params = { deviceId: DEVICE_ID, commandId: COMMAND_ID }) {
  const res = responseRecorder();
  await createAdminCommandStatusHandler(pool)({ params }, res);
  return res;
}

test("authenticated admin route returns the owned command without mutation", async () => {
  const routes = new Map();
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); }
  };
  const pool = readPool({ acknowledgement: acknowledgementRow("SUCCEEDED") });
  registerDeviceBridgeBlock3Routes({
    app,
    pool,
    dashboardApiReady: () => true,
    dashboardApiAuthorized: () => true,
    requireDeviceBridgeReady: () => true
  });
  const handler = routes.get("GET /dashboard-api/device-bridge/devices/:deviceId/commands/:commandId");
  assert.equal(typeof handler, "function");
  const res = responseRecorder();
  await handler({ params: { deviceId: DEVICE_ID, commandId: COMMAND_ID } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.command.command_id, COMMAND_ID);
  assert.equal(res.body.command.device_id, DEVICE_ID);
  assert.equal(res.body.command.status, "SUCCEEDED");
  assert.equal(res.body.command.created_at, NOW);
  assert.equal(pool.calls.every(call => /^\s*SELECT\b/i.test(call.sql)), true);
});

test("admin route rejects missing dashboard authorization before database access", async () => {
  const routes = new Map();
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); }
  };
  const pool = readPool();
  registerDeviceBridgeBlock3Routes({
    app,
    pool,
    dashboardApiReady: () => true,
    dashboardApiAuthorized: () => false,
    requireDeviceBridgeReady: () => true
  });
  const res = responseRecorder();
  await routes.get("GET /dashboard-api/device-bridge/devices/:deviceId/commands/:commandId")(
    { params: { deviceId: DEVICE_ID, commandId: COMMAND_ID } },
    res
  );
  assert.equal(res.statusCode, 401);
  assert.equal(pool.calls.length, 0);
});

test("command belonging to another device is hidden as not found", async () => {
  const pool = readPool({ command: commandRow({ device_id: OTHER_DEVICE_ID }) });
  const res = await readStatus(pool);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error.code, "COMMAND_NOT_FOUND");
  assert.equal(pool.calls.some(call => call.sql.includes("device_id=$1 AND command_id=$2")), true);
});

test("unknown device and unknown command return distinct controlled 404 errors", async () => {
  const missingDevice = await readStatus(readPool({ deviceExists: false }));
  assert.equal(missingDevice.statusCode, 404);
  assert.equal(missingDevice.body.error.code, "DEVICE_NOT_FOUND");

  const missingCommand = await readStatus(readPool({ command: null }));
  assert.equal(missingCommand.statusCode, 404);
  assert.equal(missingCommand.body.error.code, "COMMAND_NOT_FOUND");
});

test("invalid device or command identifiers are rejected without database access", async () => {
  for (const params of [
    { deviceId: "invalid", commandId: COMMAND_ID },
    { deviceId: DEVICE_ID, commandId: "invalid" }
  ]) {
    const pool = readPool();
    const res = await readStatus(pool, params);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, "INVALID_IDENTIFIER");
    assert.equal(pool.calls.length, 0);
  }
});

test("NONE and every stored ACK status retain the existing semantics", async () => {
  const none = await readStatus(readPool());
  assert.equal(none.body.command.status, "NONE");
  assert.equal(none.body.command.acknowledged_at, null);

  for (const status of ["RECEIVED", "SUCCEEDED", "FAILED", "REJECTED", "EXPIRED"]) {
    const terminal = ["SUCCEEDED", "FAILED", "REJECTED", "EXPIRED"].includes(status);
    const ack = acknowledgementRow(
      status,
      status === "REJECTED"
        ? { error: { code: "COMMAND_REJECTED", message: "Command was rejected" } }
        : {}
    );
    const command = commandRow({
      terminal_status: terminal ? status : null,
      terminal_at: terminal ? "2026-09-02T12:00:03.000Z" : null
    });
    const res = await readStatus(readPool({ command, acknowledgement: ack }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.command.status, status);
    assert.equal(res.body.command.terminal_status, terminal ? status : null);
    assert.equal(res.body.command.acknowledged_at, "2026-09-02T12:00:03.000Z");
    if (status === "SUCCEEDED") assert.deepEqual(res.body.command.result, { pong: true });
    if (status === "FAILED") assert.equal(res.body.command.error.code, "COMMAND_EXECUTION_FAILED");
  }
});
