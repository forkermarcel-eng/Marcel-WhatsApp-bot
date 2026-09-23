import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import handler, { sanitizePublicDeviceStatus } from "../api/tinder/device-status.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const PASSWORD = "test-dashboard-password";

function device(overrides = {}) {
  return {
    device_id: DEVICE_ID,
    display_name: "ZTE Android Bridge",
    enrollment_state: "ACTIVE",
    device_status: "ONLINE",
    enrolled_at: "2026-09-02T12:00:00.000Z",
    last_heartbeat_accepted_at: "2026-09-02T12:00:03.000Z",
    app_version: "1.0",
    app_build: 1,
    bridge_service_state: "RUNNING",
    tinder_state: "CONNECTED",
    configuration_revision: 1,
    ...overrides
  };
}

function request(authenticated = true) {
  const token = "test-session";
  const signature = crypto.createHmac("sha256", PASSWORD).update(token).digest("hex");
  return { method: "GET", headers: { cookie: authenticated ? `marcel_dashboard_session=${token}.${signature}` : "" }, query: {} };
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

test("device status proxy retains only generic device and bridge fields", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return { ok: true, status: 200, async text() {
      return JSON.stringify({
        ok: true,
        devices: [device({
          tinder_manual_gate_capable: true,
          inbox_navigation: { stage: "BLOCKED" },
          official_resume_handoff: { stage: "BLOCKED" }
        })]
      });
    } };
  };
  const response = responseRecorder();
  await handler(request(), response);
  assert.equal(response.statusCode, 200);
  assert.equal(call.url, "https://backend.example/dashboard-api/device-bridge/devices");
  assert.equal(call.options.method, "GET");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  assert.deepEqual(Object.keys(response.body.devices[0]).sort(), [
    "app_build", "app_version", "bridge_service_state", "configuration_revision", "device_id",
    "device_status", "display_name", "enrolled_at", "enrollment_state", "last_heartbeat_accepted_at"
  ]);
  assert.equal(JSON.stringify(response.body).includes("inbox_navigation"), false);
  assert.equal(JSON.stringify(response.body).includes("manual_gate"), false);
}));

test("device status normalizer refuses malformed device identity and boundedly normalizes status", () => {
  assert.equal(sanitizePublicDeviceStatus(device({ device_id: "bad" })), null);
  assert.equal(sanitizePublicDeviceStatus(device({ display_name: "" })), null);
  assert.equal(sanitizePublicDeviceStatus(device({ bridge_service_state: "private detail\n" }))?.bridge_service_state, "UNKNOWN");
});
