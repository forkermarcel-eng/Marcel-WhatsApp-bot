import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import handler from "../api/tinder/device-status.js";

const PASSWORD = "test-dashboard-password";

function authenticatedRequest({ method = "GET", query = {} } = {}) {
  const token = "test-session";
  const signature = crypto.createHmac("sha256", PASSWORD).update(token).digest("hex");
  return { method, headers: { cookie: `marcel_dashboard_session=${token}.${signature}` }, query };
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

test("device status endpoint cannot issue prototype Tinder commands", async () => {
  const originalFetch = globalThis.fetch;
  const originalPassword = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_PASSWORD = PASSWORD;
  globalThis.fetch = async () => { throw new Error("command must not be forwarded"); };
  try {
    const post = responseRecorder();
    await handler(authenticatedRequest({ method: "POST" }), post);
    assert.equal(post.statusCode, 405);
    assert.equal(post.headers.Allow, "GET");

    const query = responseRecorder();
    await handler(authenticatedRequest({ query: { deviceId: "e880455d-325c-4f35-9914-823dcb0e0d18" } }), query);
    assert.equal(query.statusCode, 410);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPassword === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = originalPassword;
  }
});
