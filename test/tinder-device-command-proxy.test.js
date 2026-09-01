import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import handler from "../api/tinder/device-command.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const COMMAND_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const PASSWORD = "test-dashboard-password";

function validCookie() {
  const token = "test-session";
  const signature = crypto.createHmac("sha256", PASSWORD).update(token).digest("hex");
  return `marcel_dashboard_session=${token}.${signature}`;
}

function request(body, authenticated = true) {
  return {
    method: "POST",
    headers: { cookie: authenticated ? validCookie() : "" },
    body
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

function backendResponse(type, { ok = true, status = 201 } = {}) {
  const body = ok
    ? {
        ok: true,
        command: {
          command_id: COMMAND_ID,
          type,
          issued_at: "2026-09-02T12:00:00.000Z",
          expires_at: "2026-09-02T12:05:00.000Z",
          configuration_revision: 1,
          payload: {}
        }
      }
    : {
        ok: false,
        error: { code: "DEVICE_NOT_FOUND", message: "Device was not found", retryable: false }
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

test("unauthenticated command request is rejected", async () => withEnvironment(async () => {
  globalThis.fetch = async () => { throw new Error("fetch must not run"); };
  const res = responseRecorder();
  await handler(request({ device_id: DEVICE_ID, type: "PING" }, false), res);
  assert.equal(res.statusCode, 401);
}));

for (const type of ["PING", "REQUEST_STATUS"]) {
  test(`${type} is allowed and forwarded as the exact backend contract`, async () => withEnvironment(async () => {
    let call;
    globalThis.fetch = async (url, options) => {
      call = { url, options };
      return backendResponse(type);
    };
    const res = responseRecorder();
    await handler(request({ device_id: DEVICE_ID, type }), res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.command.type, type);
    assert.equal(res.body.command.command_id, COMMAND_ID);
    assert.equal(call.url, `https://backend.example/dashboard-api/device-bridge/devices/${DEVICE_ID}/commands`);
    assert.deepEqual(JSON.parse(call.options.body), { type });
    assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  }));
}

for (const type of ["STOP_BRIDGE", "UNKNOWN_COMMAND"]) {
  test(`${type} is blocked by the web proxy`, async () => withEnvironment(async () => {
    globalThis.fetch = async () => { throw new Error("fetch must not run"); };
    const res = responseRecorder();
    await handler(request({ device_id: DEVICE_ID, type }), res);
    assert.equal(res.statusCode, 400);
  }));
}

test("invalid device identifier is rejected before backend access", async () => withEnvironment(async () => {
  globalThis.fetch = async () => { throw new Error("fetch must not run"); };
  const res = responseRecorder();
  await handler(request({ device_id: "not-a-device-id", type: "PING" }), res);
  assert.equal(res.statusCode, 400);
}));

test("backend error is returned in a controlled safe shape", async () => withEnvironment(async () => {
  globalThis.fetch = async () => backendResponse("PING", { ok: false, status: 404 });
  const res = responseRecorder();
  await handler(request({ device_id: DEVICE_ID, type: "PING" }), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, {
    ok: false,
    error: "Device was not found",
    code: "DEVICE_NOT_FOUND"
  });
  assert.equal(JSON.stringify(res.body).includes("server-only-secret"), false);
}));

test("unreachable backend is handled without retry", async () => withEnvironment(async () => {
  globalThis.fetch = async () => { throw new Error("network details must not leak"); };
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = responseRecorder();
    await handler(request({ device_id: DEVICE_ID, type: "REQUEST_STATUS" }), res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.error, "Backend ist momentan nicht erreichbar.");
  } finally {
    console.error = originalError;
  }
}));
