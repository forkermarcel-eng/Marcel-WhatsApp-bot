import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import handler from "../api/tinder/captures.js";

const PASSWORD = "test-dashboard-password";

function request({ method = "GET", authenticated = true, query = {} } = {}) {
  const token = "test-session";
  const signature = crypto.createHmac("sha256", PASSWORD).update(token).digest("hex");
  return {
    method,
    headers: { cookie: authenticated ? `marcel_dashboard_session=${token}.${signature}` : "" },
    query
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

test("retired Tinder endpoint is authenticated but makes no backend request", async () => {
  const originalFetch = globalThis.fetch;
  const originalPassword = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_PASSWORD = PASSWORD;
  globalThis.fetch = async () => { throw new Error("retired endpoint must not fetch"); };
  try {
    const anonymous = responseRecorder();
    await handler(request({ authenticated: false }), anonymous);
    assert.equal(anonymous.statusCode, 401);

    for (const requestShape of [
      request(),
      request({ query: { view: "read-conversations" } }),
      request({ method: "POST", query: { operation: "anything" } })
    ]) {
      const response = responseRecorder();
      await handler(requestShape, response);
      assert.equal(response.statusCode, 410);
      assert.equal(response.body.ok, false);
      assert.equal(response.headers["Cache-Control"], "no-store, max-age=0");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPassword === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = originalPassword;
  }
});
