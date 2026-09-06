import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import handler from "../api/tinder/captures.js";

const CAPTURE_ID = "6c7308cf-5d40-423d-913b-c4424f0e4ee0";
const DEVICE_ID = "36761d7f-2ac3-4da9-9ad4-7fd381665f1e";
const PASSWORD = "test-dashboard-password";

function safeCapture(overrides = {}) {
  return {
    capture_id: CAPTURE_ID,
    device_id: DEVICE_ID,
    capture_revision: 1,
    mapping_status: "NEEDS_HUMAN_MAPPING",
    human_review_status: "PENDING",
    visible_name: "Visible profile name",
    source_package: "com.tinder",
    captured_at: "2026-09-04T14:00:00.000Z",
    received_at: "2026-09-04T14:00:01.000Z",
    ...overrides
  };
}

function validCookie() {
  const token = "test-session";
  const signature = crypto.createHmac("sha256", PASSWORD).update(token).digest("hex");
  return `marcel_dashboard_session=${token}.${signature}`;
}

function request({ method = "GET", authenticated = true, captureId = CAPTURE_ID, body, query } = {}) {
  return {
    method,
    headers: { cookie: authenticated ? validCookie() : "" },
    query: query === undefined ? { captureId } : query,
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

function backendResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, async text() { return JSON.stringify(body); } };
}

async function withEnvironment(run) {
  const originalFetch = globalThis.fetch;
  const originalPassword = process.env.DASHBOARD_PASSWORD;
  const originalUrl = process.env.RAILWAY_BACKEND_URL;
  const originalSecret = process.env.DASHBOARD_API_SECRET;
  const originalLegacyUrl = process.env.TINDER_RAILWAY_BACKEND_URL;
  process.env.DASHBOARD_PASSWORD = PASSWORD;
  process.env.RAILWAY_BACKEND_URL = "https://shared-backend.example";
  process.env.DASHBOARD_API_SECRET = "server-only-secret";
  process.env.TINDER_RAILWAY_BACKEND_URL = "https://legacy-worker.example";
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
    if (originalLegacyUrl === undefined) delete process.env.TINDER_RAILWAY_BACKEND_URL;
    else process.env.TINDER_RAILWAY_BACKEND_URL = originalLegacyUrl;
  }
}

test("capture proxy rejects unauthenticated or malformed requests before fetch", async () => withEnvironment(async () => {
  globalThis.fetch = async () => { throw new Error("fetch must not run"); };
  const unauthenticated = responseRecorder();
  await handler(request({ authenticated: false }), unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);

  const unauthenticatedBinding = responseRecorder();
  await handler(request({
    method: "POST",
    authenticated: false,
    body: { action: "BIND_EXISTING", contact_id: 7, confirmed: true }
  }), unauthenticatedBinding);
  assert.equal(unauthenticatedBinding.statusCode, 401);

  const malformedQuery = responseRecorder();
  await handler(request({ query: { captureId: "bad" } }), malformedQuery);
  assert.equal(malformedQuery.statusCode, 400);

  const invalidPending = responseRecorder();
  await handler(request({ query: { view: "anything" } }), invalidPending);
  assert.equal(invalidPending.statusCode, 400);

  const ambiguousPending = responseRecorder();
  await handler(request({ query: { view: "pending", captureId: CAPTURE_ID } }), ambiguousPending);
  assert.equal(ambiguousPending.statusCode, 400);

  const injectedMapping = responseRecorder();
  await handler(request({
    method: "POST",
    body: { action: "MAP_EXISTING", contact_id: 7, tinder_identifier: "id", confirmed: true, actor: "client" }
  }), injectedMapping);
  assert.equal(injectedMapping.statusCode, 400);

  for (const body of [
    { action: "BIND_EXISTING", contact_id: 7, confirmed: true, tinder_identifier: "must-not-pass" },
    { action: "BIND_EXISTING", contact_id: 7, confirmed: true, thread_fingerprint: "a".repeat(64) },
    { action: "BIND_CREATE", new_contact_name: "M Tinder Test", confirmed: true, token: "b".repeat(64) },
    { action: "BIND_CREATE", new_contact_name: "M Tinder Test", confirmed: false }
  ]) {
    const invalidBinding = responseRecorder();
    await handler(request({ method: "POST", body }), invalidBinding);
    assert.equal(invalidBinding.statusCode, 400);
  }
}));

test("capture GET uses only the shared backend route and server-only authorization", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({
      ok: true,
      capture: safeCapture()
    });
  };
  const res = responseRecorder();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(call.url, `https://shared-backend.example/dashboard-api/tinder/captures/${CAPTURE_ID}`);
  assert.equal(call.options.method, "GET");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  assert.equal(call.url.includes("legacy-worker"), false);
  assert.equal(JSON.stringify(res.body).includes("server-only-secret"), false);
}));

test("capture GET passes only a bounded conversation-binding status and strips backend raw capture fields", async () => withEnvironment(async () => {
  globalThis.fetch = async () => backendResponse({
    ok: true,
    capture: safeCapture({
      conversation_binding_status: "ELIGIBLE_FOR_HUMAN_BINDING",
      visible_messages: [{ text: "private visible Tinder message" }],
      runtime_thread_fingerprint: "private-thread-fingerprint",
      capture_fingerprint: "private-capture-fingerprint",
      visible_thread_metadata: {
        threadBindingEvidence: {
          kind: "tinder_accessibility_header_unique_id_hmac_v1",
          role: "HEADER_TITLE",
          status: "OBSERVED_UNVERIFIED",
          token: "a".repeat(64)
        }
      },
      provenance: { source: "should-not-reach-browser" }
    })
  });
  const res = responseRecorder();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.capture, safeCapture({
    conversation_binding_status: "ELIGIBLE_FOR_HUMAN_BINDING"
  }));
  assert.equal(JSON.stringify(res.body).includes("private visible Tinder message"), false);
  assert.equal(JSON.stringify(res.body).includes("private-thread-fingerprint"), false);
  assert.equal(JSON.stringify(res.body).includes("private-capture-fingerprint"), false);
  assert.equal(JSON.stringify(res.body).includes("a".repeat(64)), false);
}));

test("pending capture GET uses the bounded shared-backend reader and strips every raw capture field", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({
      ok: true,
      captures: [safeCapture({
        visible_messages: [{ text: "private visible Tinder message" }],
        runtime_thread_fingerprint: "private-thread-fingerprint",
        capture_fingerprint: "private-capture-fingerprint",
        visible_thread_metadata: {
          threadBindingEvidence: {
            kind: "tinder_accessibility_header_unique_id_hmac_v1",
            role: "HEADER_TITLE",
            status: "OBSERVED_UNVERIFIED",
            token: "b".repeat(64)
          }
        },
        provenance: { source: "should-not-reach-browser" }
      })]
    });
  };
  const res = responseRecorder();
  await handler(request({ query: { view: "pending" } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(call.url, "https://shared-backend.example/dashboard-api/tinder/captures/pending");
  assert.equal(call.options.method, "GET");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  assert.deepEqual(res.body.captures, [safeCapture()]);
  assert.equal(JSON.stringify(res.body).includes("private visible Tinder message"), false);
  assert.equal(JSON.stringify(res.body).includes("private-thread-fingerprint"), false);
  assert.equal(JSON.stringify(res.body).includes("private-capture-fingerprint"), false);
  assert.equal(JSON.stringify(res.body).includes("b".repeat(64)), false);
}));

test("pending capture GET rejects a non-pending backend record before it reaches the browser", async () => withEnvironment(async () => {
  globalThis.fetch = async () => backendResponse({
    ok: true,
    captures: [safeCapture({ mapping_status: "RESOLVED", human_review_status: "CONFIRMED" })]
  });
  const res = responseRecorder();
  await handler(request({ query: { view: "pending" } }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "Ungültige Capture-Antwort vom Backend.");
}));

test("capture mapping POST forwards the exact human-confirmation contract to the shared backend", async () => withEnvironment(async () => {
  let call;
  const body = {
    action: "MAP_EXISTING",
    contact_id: 7,
    tinder_identifier: "stable-match-42",
    confirmed: true
  };
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({
      ok: true,
      result: {
        status: "RESOLVED",
        contactId: 7,
        idempotent: false,
        identifierId: 99,
        actor: "backend-regression-field"
      }
    });
  };
  const res = responseRecorder();
  await handler(request({ method: "POST", body }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(call.url, `https://shared-backend.example/dashboard-api/tinder/captures/${CAPTURE_ID}/mapping`);
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  assert.deepEqual(JSON.parse(call.options.body), body);
  assert.deepEqual(res.body.result, { status: "RESOLVED", contactId: 7, idempotent: false });
  assert.equal(JSON.stringify(res.body).includes("identifierId"), false);
  assert.equal(JSON.stringify(res.body).includes("backend-regression-field"), false);
}));

test("conversation-binding POST forwards only the exact minimal binding contract to the existing backend sibling route", async () => withEnvironment(async () => {
  let call;
  const body = {
    action: "BIND_CREATE",
    new_contact_name: "M Tinder Test",
    confirmed: true
  };
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({
      ok: true,
      result: {
        status: "CONFIRMED",
        contactId: 7,
        idempotent: false,
        bindingId: 91,
        referenceHash: "c".repeat(64),
        actor: "backend-regression-field"
      }
    });
  };
  const res = responseRecorder();
  await handler(request({ method: "POST", body }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(call.url, `https://shared-backend.example/dashboard-api/tinder/captures/${CAPTURE_ID}/conversation-binding`);
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  assert.equal(call.options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(call.options.body), body);
  assert.deepEqual(res.body.result, { status: "CONFIRMED", contactId: 7, idempotent: false });
  assert.equal(JSON.stringify(res.body).includes("bindingId"), false);
  assert.equal(JSON.stringify(res.body).includes("referenceHash"), false);
  assert.equal(JSON.stringify(res.body).includes("c".repeat(64)), false);
  assert.equal(JSON.stringify(res.body).includes("backend-regression-field"), false);
}));

test("capture proxy preserves a controlled conflict and never leaks backend details", async () => withEnvironment(async () => {
  globalThis.fetch = async () => backendResponse({
    ok: false,
    conflict: true,
    result: {
      status: "CONFLICT",
      conflictCode: "TINDER_IDENTIFIER_OWNED_BY_ANOTHER_CONTACT",
      preservedContactId: 7,
      visible_messages: [{ text: "private error message" }],
      provenance: { source: "private error provenance" }
    },
    code: "BACKEND_INTERNAL_DETAIL",
    error: "private backend error detail"
  }, { ok: false, status: 409 });
  const res = responseRecorder();
  await handler(request({
    method: "POST",
    body: { action: "CREATE_NEW", new_contact_name: "Sandry", tinder_identifier: "stable-match-42", confirmed: true }
  }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.conflict, true);
  assert.equal(res.body.result.status, "CONFLICT");
  assert.deepEqual(res.body.result, {
    status: "CONFLICT",
    conflictCode: "TINDER_IDENTIFIER_OWNED_BY_ANOTHER_CONTACT",
    preservedContactId: 7
  });
  assert.equal(JSON.stringify(res.body).includes("server-only-secret"), false);
  assert.equal(JSON.stringify(res.body).includes("private error message"), false);
  assert.equal(JSON.stringify(res.body).includes("private error provenance"), false);
  assert.equal(JSON.stringify(res.body).includes("private backend error detail"), false);
  assert.equal(JSON.stringify(res.body).includes("BACKEND_INTERNAL_DETAIL"), false);
}));

test("conversation-binding conflict stays bounded and cannot disclose its opaque candidate", async () => withEnvironment(async () => {
  globalThis.fetch = async () => backendResponse({
    ok: false,
    conflict: true,
    result: {
      status: "CONFLICT",
      referenceHash: "d".repeat(64),
      preservedContactId: 9,
      privateReason: "must not reach the browser"
    },
    code: "BACKEND_INTERNAL_DETAIL",
    error: "private backend error detail"
  }, { ok: false, status: 409 });
  const res = responseRecorder();
  await handler(request({
    method: "POST",
    body: { action: "BIND_EXISTING", contact_id: 7, confirmed: true }
  }), res);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, {
    ok: false,
    conflict: true,
    result: { status: "CONFLICT" },
    error: "Conversation-Binding konnte nicht gespeichert werden."
  });
  assert.equal(JSON.stringify(res.body).includes("referenceHash"), false);
  assert.equal(JSON.stringify(res.body).includes("d".repeat(64)), false);
  assert.equal(JSON.stringify(res.body).includes("preservedContactId"), false);
  assert.equal(JSON.stringify(res.body).includes("private backend error detail"), false);
}));

test("capture proxy controls malformed backend and network failures", async () => withEnvironment(async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, async text() { return "not-json"; } });
  const malformed = responseRecorder();
  await handler(request(), malformed);
  assert.equal(malformed.statusCode, 502);
  assert.equal(malformed.body.error, "Ungültige Antwort vom Backend.");

  globalThis.fetch = async () => { throw new Error("private network detail"); };
  const originalError = console.error;
  console.error = () => {};
  try {
    const unreachable = responseRecorder();
    await handler(request(), unreachable);
    assert.equal(unreachable.statusCode, 502);
    assert.equal(unreachable.body.error, "Backend ist momentan nicht erreichbar.");
  } finally {
    console.error = originalError;
  }
}));

test("capture proxy never targets the frozen legacy worker", () => {
  const source = readFileSync(new URL("../api/tinder/captures.js", import.meta.url), "utf8");
  assert.match(source, /RAILWAY_BACKEND_URL/);
  assert.doesNotMatch(source, /TINDER_RAILWAY_BACKEND_URL/);
  assert.doesNotMatch(source, /\/api\/tinder\/(?:control|read|status)/);
});
