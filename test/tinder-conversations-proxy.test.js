import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import handler from "../api/tinder/captures.js";

const PASSWORD = "test-dashboard-password";

function request(query) {
  const token = "test-session";
  const signature = crypto.createHmac("sha256", PASSWORD).update(token).digest("hex");
  return {
    method: "GET",
    headers: { cookie: `marcel_dashboard_session=${token}.${signature}` },
    query
  };
}

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    setHeader() {},
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

test("retired capture-oriented Conversation routes do not reach the backend", async () => {
  const originalFetch = globalThis.fetch;
  const originalPassword = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_PASSWORD = PASSWORD;
  globalThis.fetch = async () => { throw new Error("retired route must not fetch"); };
  try {
    for (const query of [
      { view: "confirmed-conversations" },
      { captureId: "6c7308cf-5d40-423d-913b-c4424f0e4ee0", view: "confirmed-conversation" }
    ]) {
      const response = responseRecorder();
      await handler(request(query), response);
      assert.equal(response.statusCode, 410);
      assert.equal(response.body.ok, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPassword === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = originalPassword;
  }
});
