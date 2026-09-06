import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import legacyHandler, { LEGACY_ROUTES } from "../api/tinder/legacy.js";

const DASHBOARD_PASSWORD = "test-dashboard-password";
const LEGACY_DISABLED_RESPONSE = Object.freeze({
  ok: false,
  code: "LEGACY_TINDER_WEBWORKER_DISABLED",
  error: "Der Legacy-Tinder-Webworker ist deaktiviert."
});

const routes = Object.freeze(Object.entries(LEGACY_ROUTES).map(([name, method]) => ({ name, method })));
const legacySource = readFileSync(new URL("../api/tinder/legacy.js", import.meta.url), "utf8");
const vercelConfiguration = JSON.parse(
  readFileSync(new URL("../vercel.json", import.meta.url), "utf8")
);

function validCookie() {
  const token = "test-session";
  const signature = crypto.createHmac("sha256", DASHBOARD_PASSWORD).update(token).digest("hex");
  return `marcel_dashboard_session=${token}.${signature}`;
}

function request({ method, route, authenticated = true } = {}) {
  return {
    method,
    headers: { cookie: authenticated ? validCookie() : "" },
    query: route ? { legacyRoute: route } : {}
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
    await legacyHandler(request({ method: wrongMethod, route: route.name }), wrongMethodResponse);
    assert.equal(wrongMethodResponse.statusCode, 405, route.name);
    assert.equal(wrongMethodResponse.headers.Allow, route.method, route.name);

    const unauthenticatedResponse = responseRecorder();
    await legacyHandler(request({ method: route.method, route: route.name, authenticated: false }), unauthenticatedResponse);
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
      await legacyHandler(request({ method: route.method, route: route.name }), response);
      assert.equal(response.statusCode, 410, route.name);
      assert.equal(response.headers["Cache-Control"], "no-store, max-age=0", route.name);
      assert.deepEqual(response.body, LEGACY_DISABLED_RESPONSE, route.name);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
}));

test("legacy worker compatibility function contains no worker configuration, fetch, or external target", () => {
  assert.match(legacySource, /LEGACY_TINDER_WEBWORKER_DISABLED/);
  assert.doesNotMatch(legacySource, /TINDER_RAILWAY_BACKEND_URL|TINDER_API_SECRET|\bfetch\s*\(/);
  assert.doesNotMatch(legacySource, /\b(?:https?|wss?):\/\//i);
});

test("legacy public paths are bounded Vercel rewrites to the single quarantine function", () => {
  const rewrites = new Map(vercelConfiguration.rewrites.map(({ source, destination }) => [source, destination]));
  assert.equal(rewrites.get("/api/tinder/control"), "/api/tinder/legacy?legacyRoute=control");
  assert.equal(rewrites.get("/api/tinder/read"), "/api/tinder/legacy?legacyRoute=read");
  assert.equal(rewrites.get("/api/tinder/status"), "/api/tinder/legacy?legacyRoute=status");
});

test("direct unified legacy route fails closed without a bounded selector", async () => withDashboardPassword(async () => {
  const response = responseRecorder();
  await legacyHandler(request({ method: "GET" }), response);
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.body, { ok: false, error: "Nicht gefunden." });
}));

test("Tinder UI contains no legacy status, control, read, or connect surface", () => {
  const page = readFileSync(new URL("../Tinder/index.html", import.meta.url), "utf8");

  assert.doesNotMatch(page, /\/api\/tinder\/(?:status|control|read)\b/i);
  assert.doesNotMatch(page, /\brunControl\s*\(/);
  assert.doesNotMatch(page, /id="(?:connectButton|disconnectButton|automationStartButton|automationStopButton|manualLoginButton)"/);
  assert.doesNotMatch(page, /(?:vnc\.html|marcel-tinder-bot-production)/i);
  assert.match(page, /id="connectAndroidTinder"/);
  assert.match(page, /id="disconnectAndroidTinder"/);
});
