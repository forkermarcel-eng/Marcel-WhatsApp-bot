import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import controlHandler from "../api/tinder/control.js";
import readHandler from "../api/tinder/read.js";
import statusHandler from "../api/tinder/status.js";

const DASHBOARD_PASSWORD = "test-dashboard-password";
const LEGACY_DISABLED_RESPONSE = Object.freeze({
  ok: false,
  code: "LEGACY_TINDER_WEBWORKER_DISABLED",
  error: "Der Legacy-Tinder-Webworker ist deaktiviert."
});

const routes = Object.freeze([
  {
    name: "status",
    method: "GET",
    handler: statusHandler,
    source: readFileSync(new URL("../api/tinder/status.js", import.meta.url), "utf8")
  },
  {
    name: "control",
    method: "POST",
    handler: controlHandler,
    source: readFileSync(new URL("../api/tinder/control.js", import.meta.url), "utf8")
  },
  {
    name: "read",
    method: "GET",
    handler: readHandler,
    source: readFileSync(new URL("../api/tinder/read.js", import.meta.url), "utf8")
  }
]);

function validCookie() {
  const token = "test-session";
  const signature = crypto.createHmac("sha256", DASHBOARD_PASSWORD).update(token).digest("hex");
  return `marcel_dashboard_session=${token}.${signature}`;
}

function request({ method, authenticated = true } = {}) {
  return {
    method,
    headers: { cookie: authenticated ? validCookie() : "" }
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

async function withDashboardPassword(run) {
  const original = process.env.DASHBOARD_PASSWORD;
  process.env.DASHBOARD_PASSWORD = DASHBOARD_PASSWORD;
  try {
    await run();
  } finally {
    if (original === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = original;
  }
}

test("quarantined legacy worker routes retain method and dashboard-auth gates", async () => withDashboardPassword(async () => {
  for (const route of routes) {
    const wrongMethod = route.method === "GET" ? "POST" : "GET";
    const wrongMethodResponse = responseRecorder();
    await route.handler(request({ method: wrongMethod }), wrongMethodResponse);
    assert.equal(wrongMethodResponse.statusCode, 405, route.name);
    assert.equal(wrongMethodResponse.headers.Allow, route.method, route.name);

    const unauthenticatedResponse = responseRecorder();
    await route.handler(request({ method: route.method, authenticated: false }), unauthenticatedResponse);
    assert.equal(unauthenticatedResponse.statusCode, 401, route.name);
    assert.deepEqual(unauthenticatedResponse.body, { ok: false, error: "Nicht angemeldet." }, route.name);
  }
}));

test("valid dashboard auth receives only the bounded legacy-worker-disabled response without a worker request", async () => withDashboardPassword(async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("legacy worker fetch must not run"); };
  try {
    for (const route of routes) {
      const response = responseRecorder();
      await route.handler(request({ method: route.method }), response);
      assert.equal(response.statusCode, 410, route.name);
      assert.equal(response.headers["Cache-Control"], "no-store, max-age=0", route.name);
      assert.deepEqual(response.body, LEGACY_DISABLED_RESPONSE, route.name);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}));

test("legacy worker compatibility routes contain no worker configuration, fetch, or external target", () => {
  for (const route of routes) {
    assert.match(route.source, /LEGACY_TINDER_WEBWORKER_DISABLED/, route.name);
    assert.doesNotMatch(route.source, /TINDER_RAILWAY_BACKEND_URL|TINDER_API_SECRET|\bfetch\s*\(/, route.name);
    assert.doesNotMatch(route.source, /\b(?:https?|wss?):\/\//i, route.name);
  }
});

test("Tinder UI contains no legacy status, control, read, or connect surface", () => {
  const page = readFileSync(new URL("../Tinder/index.html", import.meta.url), "utf8");

  assert.doesNotMatch(page, /\/api\/tinder\/(?:status|control|read)\b/i);
  assert.doesNotMatch(page, /\brunControl\s*\(/);
  assert.doesNotMatch(page, /id="(?:connectButton|disconnectButton|automationStartButton|automationStopButton|manualLoginButton)"/);
  assert.doesNotMatch(page, /(?:vnc\.html|marcel-tinder-bot-production)/i);
  assert.match(page, /id="connectAndroidTinder"/);
  assert.match(page, /id="disconnectAndroidTinder"/);
});
