import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import handler from "../api/tinder/device-status.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const COMMAND_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const PASSWORD = "test-dashboard-password";

function validCookie() {
  const token = "test-session";
  const signature = crypto.createHmac("sha256", PASSWORD).update(token).digest("hex");
  return `marcel_dashboard_session=${token}.${signature}`;
}

function request({ method = "GET", authenticated = true, deviceId = DEVICE_ID, commandId = COMMAND_ID } = {}) {
  return {
    method,
    headers: { cookie: authenticated ? validCookie() : "" },
    query: { deviceId, commandId }
  };
}

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

function backendResponse({ ok = true, status = 200 } = {}) {
  const body = ok
    ? {
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        command: {
          protocol_version: 1,
          command_id: COMMAND_ID,
          device_id: DEVICE_ID,
          type: "PING",
          status: "RECEIVED",
          terminal_status: null,
          issued_at: "2026-09-02T12:00:00.000Z",
          delivered_at: null,
          acknowledged_at: "2026-09-02T12:00:03.000Z",
          occurred_at: "2026-09-02T12:00:02.000Z",
          terminal_at: null,
          result: null,
          error: null
        }
      }
    : {
        ok: false,
        error: { code: "COMMAND_NOT_FOUND", message: "Command was not found", retryable: false }
      };
  return { ok, status, async text() { return JSON.stringify(body); } };
}

async function withEnvironment(run) {
  const originalFetch = globalThis.fetch;
  const originalPassword = process.env.DASHBOARD_PASSWORD;
  const originalUrl = process.env.RAILWAY_BACKEND_URL;
  const originalSecret = process.env.DASHBOARD_API_SECRET;
  process.env.DASHBOARD_PASSWORD = PASSWORD;
  process.env.RAILWAY_BACKEND_URL = "https://backend.example";
  process.env.DASHBOARD_API_SECRET = "server-only-secret";
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPassword === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = originalPassword;
    if (originalUrl === undefined) delete process.env.RAILWAY_BACKEND_URL;
    else process.env.RAILWAY_BACKEND_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.DASHBOARD_API_SECRET;
    else process.env.DASHBOARD_API_SECRET = originalSecret;
  }
}

test("unauthenticated status request is rejected", async () => withEnvironment(async () => {
  globalThis.fetch = async () => { throw new Error("fetch must not run"); };
  const res = responseRecorder();
  await handler(request({ authenticated: false }), res);
  assert.equal(res.statusCode, 401);
}));

test("valid GET calls the exact backend command-status endpoint", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse();
  };
  const res = responseRecorder();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.command.status, "RECEIVED");
  assert.equal(call.url, `https://backend.example/dashboard-api/device-bridge/devices/${DEVICE_ID}/commands/${COMMAND_ID}`);
  assert.equal(call.options.method, "GET");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
}));

test("GET without command identifiers preserves the device-list proxy", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, server_time: "2026-09-02T12:00:04.000Z", devices: [] });
      }
    };
  };
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.devices, []);
  assert.equal(call.url, "https://backend.example/dashboard-api/device-bridge/devices");
  assert.equal(call.options.method, "GET");
}));

test("invalid device and command identifiers are rejected before backend access", async () => withEnvironment(async () => {
  globalThis.fetch = async () => { throw new Error("fetch must not run"); };
  for (const options of [{ deviceId: "invalid" }, { commandId: "invalid" }]) {
    const res = responseRecorder();
    await handler(request(options), res);
    assert.equal(res.statusCode, 400);
  }
}));

test("backend 404 is forwarded in a controlled safe shape", async () => withEnvironment(async () => {
  globalThis.fetch = async () => backendResponse({ ok: false, status: 404 });
  const res = responseRecorder();
  await handler(request(), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, {
    ok: false,
    error: "Command was not found",
    code: "COMMAND_NOT_FOUND"
  });
}));

test("backend and network errors are controlled", async () => withEnvironment(async () => {
  globalThis.fetch = async () => backendResponse({ ok: false, status: 500 });
  const backendRes = responseRecorder();
  await handler(request(), backendRes);
  assert.equal(backendRes.statusCode, 502);

  globalThis.fetch = async () => { throw new Error("private network detail"); };
  const originalError = console.error;
  console.error = () => {};
  try {
    const networkRes = responseRecorder();
    await handler(request(), networkRes);
    assert.equal(networkRes.statusCode, 502);
    assert.equal(networkRes.body.error, "Backend ist momentan nicht erreichbar.");
  } finally {
    console.error = originalError;
  }
}));

test("unsupported method is rejected", async () => withEnvironment(async () => {
  globalThis.fetch = async () => { throw new Error("fetch must not run"); };
  const res = responseRecorder();
  await handler(request({ method: "PUT" }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET, POST");
}));
