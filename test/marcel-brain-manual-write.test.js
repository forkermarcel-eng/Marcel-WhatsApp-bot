import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import factsHandler from "../api/dashboard/marcel-brain/facts.js";
import liveStateHandler from "../api/dashboard/marcel-brain/live-state.js";

const backend = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const brainPage = readFileSync(new URL("../Brain/index.html", import.meta.url), "utf8");
const PASSWORD = "brain-test-password";

function cookie() {
  const token = "brain-session";
  const signature = crypto.createHmac("sha256", PASSWORD).update(token).digest("hex");
  return `marcel_dashboard_session=${token}.${signature}`;
}

function responseRecorder() {
  return {
    statusCode: null, body: null, headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

async function environment(run) {
  const old = {
    fetch: globalThis.fetch,
    password: process.env.DASHBOARD_PASSWORD,
    url: process.env.RAILWAY_BACKEND_URL,
    secret: process.env.DASHBOARD_API_SECRET
  };
  process.env.DASHBOARD_PASSWORD = PASSWORD;
  process.env.RAILWAY_BACKEND_URL = "https://brain-backend.example";
  process.env.DASHBOARD_API_SECRET = "backend-secret";
  try { await run(); } finally {
    globalThis.fetch = old.fetch;
    for (const [key, value] of [["DASHBOARD_PASSWORD", old.password], ["RAILWAY_BACKEND_URL", old.url], ["DASHBOARD_API_SECRET", old.secret]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("fact create proxy requires dashboard authentication", async () => environment(async () => {
  globalThis.fetch = async () => { throw Error("must not fetch"); };
  const res = responseRecorder();
  await factsHandler({ method: "POST", headers: { cookie: "" }, query: {}, body: {} }, res);
  assert.equal(res.statusCode, 401);
}));

test("fact create proxy forwards only to the fact-create backend route", async () => environment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return { ok: true, status: 201, async text() { return '{"ok":true,"created":true}'; } };
  };
  const body = { category: "identity", key: "favorite_color", value: "green", importance: 2, use_in_reply: true };
  const res = responseRecorder();
  await factsHandler({ method: "POST", headers: { cookie: cookie() }, query: {}, body }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(call.url, "https://brain-backend.example/dashboard-api/marcel-brain/facts");
  assert.deepEqual(JSON.parse(call.options.body), body);
  assert.equal(call.options.headers.Authorization, "Bearer backend-secret");
}));

test("fact update proxy requires and encodes a positive id", async () => environment(async () => {
  let url;
  globalThis.fetch = async (target) => {
    url = target;
    return { ok: true, status: 200, async text() { return '{"ok":true}'; } };
  };
  const res = responseRecorder();
  await factsHandler({ method: "PATCH", headers: { cookie: cookie() }, query: { id: "17" }, body: {} }, res);
  assert.equal(url, "https://brain-backend.example/dashboard-api/marcel-brain/facts/17");
  const invalid = responseRecorder();
  await factsHandler({ method: "PATCH", headers: { cookie: cookie() }, query: { id: "bad" }, body: {} }, invalid);
  assert.equal(invalid.statusCode, 400);
}));

test("fact proxy preserves controlled 409 conflict payload", async () => environment(async () => {
  globalThis.fetch = async () => ({
    ok: false, status: 409,
    async text() { return '{"ok":false,"conflict":true,"error":"Konflikt","existing":{"id":1}}'; }
  });
  const res = responseRecorder();
  await factsHandler({ method: "POST", headers: { cookie: cookie() }, query: {}, body: {} }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.conflict, true);
}));

test("live-state proxy accepts PATCH only and requires auth", async () => environment(async () => {
  globalThis.fetch = async () => { throw Error("must not fetch"); };
  const unauthenticated = responseRecorder();
  await liveStateHandler({ method: "PATCH", headers: { cookie: "" }, body: {} }, unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);
  const wrongMethod = responseRecorder();
  await liveStateHandler({ method: "POST", headers: { cookie: cookie() }, body: {} }, wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
}));

test("live-state proxy targets only the dedicated backend route", async () => environment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return { ok: true, status: 200, async text() { return '{"ok":true}'; } };
  };
  const res = responseRecorder();
  await liveStateHandler({ method: "PATCH", headers: { cookie: cookie() }, body: { current_city: "Berlin" } }, res);
  assert.equal(call.url, "https://brain-backend.example/dashboard-api/marcel-brain/live-state");
  assert.deepEqual(JSON.parse(call.options.body), { current_city: "Berlin" });
}));

test("database initialization adds only the dedicated live-state audit table", () => {
  assert.match(backend, /CREATE TABLE IF NOT EXISTS marcel_live_state_audit/);
  assert.match(backend, /changed_fields JSONB NOT NULL/);
  assert.match(backend, /old_values JSONB NOT NULL/);
  assert.match(backend, /new_values JSONB NOT NULL/);
});

test("fact create enforces human authority and server-owned metadata", () => {
  assert.match(backend, /source_type[\s\S]*'manual_dashboard'[\s\S]*human_verified[\s\S]*TRUE/);
  assert.match(backend, /human_review_action[\s\S]*'confirmed'/);
  assert.match(backend, /human_reviewed_at[\s\S]*NOW\(\)/);
  assert.match(backend, /status[\s\S]*'active'/);
});

test("fact create protects against mass assignment", () => {
  assert.match(backend, /assertOnlyBodyFields\(req\.body, new Set\(\[[\s\S]*"valid_until", "notes"/);
  for (const forbidden of ["source_type", "human_verified", "human_review_action", "status", "id", "created_at", "updated_at"]) {
    assert.doesNotMatch(backend.match(/app\.post\("\/dashboard-api\/marcel-brain\/facts"[\s\S]*?app\.patch/)[0], new RegExp(`"${forbidden}"`));
  }
});

test("fact inputs have category key value importance date and size validation", () => {
  assert.match(backend, /MARCEL_MANUAL_FACT_CATEGORIES\.has/);
  assert.match(backend, /\^\[a-z\]\[a-z0-9_\]/);
  assert.match(backend, /encoded\.length > 16000/);
  assert.match(backend, /importance < 1 \|\| importance > 5/);
  assert.match(backend, /gültiger zukünftiger Zeitpunkt/);
});

test("same normalized fact value is idempotent and another value conflicts", () => {
  assert.match(backend, /normalizedJsonText\(existing\.memory_value\) === normalizedJsonText\(fact\.value\)/);
  assert.match(backend, /idempotent: true/);
  assert.match(backend, /res\.status\(409\)\.json\(\{[\s\S]*conflict: true/);
});

test("fact update uses row locking version check and explicit confirmation", () => {
  assert.match(backend, /app\.patch\("\/dashboard-api\/marcel-brain\/facts\/:id"/);
  assert.match(backend, /explicitConflictConfirmation !== true/);
  assert.match(backend, /new Date\(current\.updated_at\)\.toISOString\(\) !== expected\.toISOString\(\)/);
  assert.match(backend, /FROM marcel_memory WHERE id = \$1 FOR UPDATE/);
});

test("fact create and update write audit rows", () => {
  assert.match(backend, /VALUES \(\$1,\$2,'create'/);
  assert.match(backend, /VALUES \(\$1,\$2,'update'/);
  assert.match(backend, /reviewed_by[\s\S]*'marcel_dashboard'/);
});

test("live state has a fixed allowlist, validation, row lock and atomic audit", () => {
  assert.match(backend, /const MARCEL_LIVE_STATE_FIELDS = Object\.freeze/);
  assert.match(backend, /assertOnlyBodyFields\(req\.body, new Set\(Object\.keys\(MARCEL_LIVE_STATE_FIELDS\)\)\)/);
  assert.match(backend, /SELECT \* FROM marcel_live_state WHERE id=1 FOR UPDATE/);
  assert.match(backend, /INSERT INTO marcel_live_state_audit/);
  assert.match(backend, /await client\.query\("COMMIT"\)/);
  assert.match(backend, /await client\.query\("ROLLBACK"\)/);
});

test("reply core continues to read active allowed non-expired Marcel facts", () => {
  assert.match(backend, /async function getMarcelMemory/);
  assert.match(backend, /WHERE status =[\s\S]*'active'[\s\S]*allowed_for_bot =[\s\S]*TRUE[\s\S]*valid_until IS NULL/);
  assert.match(backend, /getMarcelMemory\(\)/);
});

test("existing review routes and all three actions remain present", () => {
  assert.match(backend, /app\.post\([\s\S]*"\/dashboard-api\/marcel-brain"/);
  for (const action of ["confirm", "reject", "correct"]) assert.match(backend, new RegExp(`"${action}"`));
});

test("Brain UI separates fact and state writes and performs explicit 409 update", () => {
  assert.match(brainPage, /Dauerhafter Fakt/);
  assert.match(brainPage, /Aktueller Zustand/);
  assert.match(brainPage, /\/api\/dashboard\/marcel-brain\/facts/);
  assert.match(brainPage, /\/api\/dashboard\/marcel-brain\/live-state/);
  assert.match(brainPage, /explicitConflictConfirmation:true/);
  assert.match(brainPage, /existing\.updatedAt/);
  assert.match(brainPage, /await load\(\)/);
});
