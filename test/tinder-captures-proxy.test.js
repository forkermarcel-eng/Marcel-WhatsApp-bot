import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import handler from "../api/tinder/captures.js";

const CAPTURE_ID = "6c7308cf-5d40-423d-913b-c4424f0e4ee0";
const DEVICE_ID = "36761d7f-2ac3-4da9-9ad4-7fd381665f1e";
const BINDING_ID = "832d0663-8bb1-4947-ae8a-14a6d9de8924";
const DRAFT_ID = "4d0b6b43-6a5a-4a06-a2d6-d5f2b60b4a2d";
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

function safeDraftReview(overrides = {}) {
  return {
    draftId: DRAFT_ID,
    captureId: CAPTURE_ID,
    draftRevision: 1,
    captureRevision: 1,
    identityRevision: 1,
    status: "DRAFT",
    approvalState: null,
    intentState: null,
    originalDraft: "Hallo, schön von dir zu hören.",
    controlDraftDe: "Hallo, schön von dir zu hören.",
    sourceLanguage: "de",
    modelVersion: "shared-reply-core-v1",
    createdAt: "2026-09-07T13:00:00.000Z",
    ...overrides
  };
}

function safeOpenDraftReview(overrides = {}) {
  return {
    captureId: CAPTURE_ID,
    visibleName: "M Tinder Test",
    status: "DRAFT",
    originalDraft: "private draft must not reach selector",
    contactId: 7,
    deviceId: DEVICE_ID,
    runtimeThreadFingerprint: "private-thread-fingerprint",
    captureFingerprint: "private-capture-fingerprint",
    ...overrides
  };
}

function safeDraftEligibleCapture(overrides = {}) {
  return {
    capture_id: CAPTURE_ID,
    visible_name: "M Tinder Test",
    visible_messages: [{ text: "private visible Tinder message" }],
    device_id: DEVICE_ID,
    contact_id: 7,
    runtime_thread_fingerprint: "private-thread-fingerprint",
    capture_fingerprint: "private-capture-fingerprint",
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

  for (const { query, body } of [
    {
      query: { captureId: CAPTURE_ID, operation: "human-arm" },
      body: { action: "BIND_EXISTING", contact_id: 7, confirmed: true, thread_fingerprint: "a".repeat(64) }
    },
    {
      query: { captureId: CAPTURE_ID, operation: "human-arm" },
      body: { action: "BIND_CREATE", new_contact_name: "", confirmed: true }
    },
    {
      query: { bindingId: DEVICE_ID, operation: "human-rearm" },
      body: { confirmed: true, command_id: CAPTURE_ID }
    },
    {
      query: { bindingId: BINDING_ID, operation: "human-armed-visible-chat-sync" },
      body: { confirmed: true, capture_id: CAPTURE_ID }
    },
    {
      query: { bindingId: BINDING_ID, captureId: CAPTURE_ID, operation: "human-armed-visible-chat-sync" },
      body: { confirmed: true }
    },
    {
      query: { captureId: CAPTURE_ID, operation: "unknown" },
      body: { action: "BIND_EXISTING", contact_id: 7, confirmed: true }
    },
    {
      query: { captureId: CAPTURE_ID, operation: "draft" },
      body: { extra_context: "must-not-pass" }
    },
    {
      query: { captureId: CAPTURE_ID, operation: "draft-approve" },
      body: { action: "APPROVE" }
    },
    {
      query: { captureId: CAPTURE_ID, operation: "draft-reject", draftId: DRAFT_ID },
      body: {}
    },
    {
      query: { captureId: CAPTURE_ID, operation: "draft-cancel" },
      body: { draft_id: DRAFT_ID }
    }
  ]) {
    const invalidHumanArm = responseRecorder();
    await handler(request({ method: "POST", query, body }), invalidHumanArm);
    assert.equal(invalidHumanArm.statusCode, 400);
  }
}));

test("T5 durable draft-review GET uses the shared backend and redacts all non-review fields", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({
      ok: true,
      review: safeDraftReview({
        contactId: 7,
        deviceId: DEVICE_ID,
        runtimeThreadFingerprint: "private-thread-fingerprint",
        captureFingerprint: "private-capture-fingerprint",
        approvalId: "0a3699ca-2b77-48bf-8563-2022f8a3e2a5",
        intentId: "832d0663-8bb1-4947-ae8a-14a6d9de8924",
        payload: { approved_text: "must not reach dashboard" }
      })
    });
  };
  const res = responseRecorder();
  await handler(request({ query: { captureId: CAPTURE_ID, view: "draft-review" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(call.url, `https://shared-backend.example/dashboard-api/tinder/captures/${CAPTURE_ID}/draft-review`);
  assert.equal(call.options.method, "GET");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  assert.deepEqual(res.body, {
    ok: true,
    review: {
      draft_id: DRAFT_ID,
      capture_id: CAPTURE_ID,
      draft_revision: 1,
      capture_revision: 1,
      identity_revision: 1,
      status: "DRAFT",
      approval_state: null,
      intent_state: null,
      original_draft: "Hallo, schön von dir zu hören.",
      control_draft_de: "Hallo, schön von dir zu hören.",
      source_language: "de",
      model_version: "shared-reply-core-v1",
      created_at: "2026-09-07T13:00:00.000Z"
    }
  });
  assert.equal(JSON.stringify(res.body).includes("private-thread-fingerprint"), false);
  assert.equal(JSON.stringify(res.body).includes("private-capture-fingerprint"), false);
  assert.equal(JSON.stringify(res.body).includes("must not reach dashboard"), false);
  assert.equal(JSON.stringify(res.body).includes("0a3699ca-2b77-48bf-8563-2022f8a3e2a5"), false);
}));

test("T5 review actions derive the draft server-side and forward only fixed human decisions", async () => withEnvironment(async () => {
  const cases = [
    ["draft-approve", "APPROVE", "approval", { state: "ACTIVE", idempotent: false }],
    ["draft-reject", "REJECT", "reject", { state: "REJECTED", idempotent: false }],
    ["draft-cancel", "CANCEL", "cancel", { state: "CANCELLED", idempotent: false }]
  ];
  for (const [operation, action, endpoint, result] of cases) {
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      if (options.method === "GET") return backendResponse({ ok: true, review: safeDraftReview() });
      return backendResponse({
        ok: true,
        [action === "APPROVE" ? "approval" : action === "REJECT" ? "draft" : "result"]: {
          draftId: DRAFT_ID,
          draftRevision: 1,
          ...result,
          approvalId: "0a3699ca-2b77-48bf-8563-2022f8a3e2a5",
          intentId: "832d0663-8bb1-4947-ae8a-14a6d9de8924",
          commandId: "8a74bf1a-1ca4-43e6-b0fa-52667778f21c",
          payload: { approved_text: "must not reach dashboard" }
        }
      }, { status: action === "APPROVE" ? 201 : 200 });
    };
    const res = responseRecorder();
    await handler(request({ method: "POST", query: { captureId: CAPTURE_ID, operation }, body: {} }), res);
    assert.equal(res.statusCode, 200, action);
    assert.equal(calls.length, 2, action);
    assert.equal(calls[0].url, `https://shared-backend.example/dashboard-api/tinder/captures/${CAPTURE_ID}/draft-review`, action);
    assert.equal(calls[1].url, `https://shared-backend.example/dashboard-api/tinder/drafts/${DRAFT_ID}/${endpoint}`, action);
    assert.deepEqual(JSON.parse(calls[1].options.body), { action }, action);
    assert.deepEqual(res.body, { ok: true, result }, action);
    assert.equal(JSON.stringify(res.body).includes("must not reach dashboard"), false, action);
    assert.equal(JSON.stringify(res.body).includes("0a3699ca-2b77-48bf-8563-2022f8a3e2a5"), false, action);
  }
}));

test("T5 proxy has no browser dispatch operation or device command surface", () => {
  const source = readFileSync(new URL("../api/tinder/captures.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /action:\s*["']DISPATCH["']|\/dispatch|device-bridge\/v1|SEND_TINDER_DRAFT|playwright|chromium|accessibility/i);
});

test("T4 draft POST forwards only an empty browser body and returns a bounded draft", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({
      ok: true,
      draft: {
        draft_id: "4d0b6b43-6a5a-4a06-a2d6-d5f2b60b4a2d",
        capture_id: CAPTURE_ID,
        contact_id: 7,
        capture_revision: 1,
        identity_revision: 1,
        status: "DRAFT",
        original_draft: "Hallo, schön von dir zu hören.",
        control_draft_de: "Hallo, schön von dir zu hören.",
        source_language: "de",
        model_version: "shared-reply-core-v1",
        created_at: "2026-09-07T13:00:00.000Z",
        visible_messages: [{ text: "private visible Tinder message" }],
        runtime_thread_fingerprint: "private-thread-fingerprint",
        capture_fingerprint: "private-capture-fingerprint"
      }
    }, { status: 201 });
  };

  const res = responseRecorder();
  await handler(request({
    method: "POST",
    query: { captureId: CAPTURE_ID, operation: "draft" },
    body: {}
  }), res);

  assert.equal(res.statusCode, 201);
  assert.equal(call.url, `https://shared-backend.example/dashboard-api/tinder/captures/${CAPTURE_ID}/drafts`);
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  assert.deepEqual(JSON.parse(call.options.body), {});
  assert.deepEqual(res.body, {
    ok: true,
    draft: {
      draft_id: "4d0b6b43-6a5a-4a06-a2d6-d5f2b60b4a2d",
      capture_id: CAPTURE_ID,
      capture_revision: 1,
      identity_revision: 1,
      status: "DRAFT",
      original_draft: "Hallo, schön von dir zu hören.",
      control_draft_de: "Hallo, schön von dir zu hören.",
      source_language: "de",
      model_version: "shared-reply-core-v1",
      created_at: "2026-09-07T13:00:00.000Z"
    }
  });
  assert.equal(JSON.stringify(res.body).includes("contact_id"), false);
  assert.equal(JSON.stringify(res.body).includes("private visible Tinder message"), false);
  assert.equal(JSON.stringify(res.body).includes("private-thread-fingerprint"), false);
  assert.equal(JSON.stringify(res.body).includes("private-capture-fingerprint"), false);
}));

test("T4 draft proxy reports an unmigrated foundation without backend detail", async () => withEnvironment(async () => {
  globalThis.fetch = async () => backendResponse({
    ok: false,
    code: "TINDER_DRAFT_FOUNDATION_NOT_READY",
    error: "private database detail"
  }, { ok: false, status: 503 });
  const res = responseRecorder();
  await handler(request({
    method: "POST",
    query: { captureId: CAPTURE_ID, operation: "draft" },
    body: {}
  }), res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    ok: false,
    code: "TINDER_DRAFT_FOUNDATION_NOT_READY",
    error: "Tinder-Draft Foundation ist noch nicht bereit."
  });
  assert.equal(JSON.stringify(res.body).includes("private database detail"), false);
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

test("draft-eligible capture selector forwards only a bounded existing-detail discovery projection", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({ ok: true, captures: [safeDraftEligibleCapture()] });
  };
  const res = responseRecorder();
  await handler(request({ query: { view: "draft-eligible" } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(call.url, "https://shared-backend.example/dashboard-api/tinder/captures/draft-eligible");
  assert.equal(call.options.method, "GET");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  assert.deepEqual(res.body, {
    ok: true,
    captures: [{ capture_id: CAPTURE_ID, visible_name: "M Tinder Test" }]
  });
  assert.equal(JSON.stringify(res.body).includes("private visible Tinder message"), false);
  assert.equal(JSON.stringify(res.body).includes("private-thread-fingerprint"), false);
  assert.equal(JSON.stringify(res.body).includes("private-capture-fingerprint"), false);
  assert.equal(JSON.stringify(res.body).includes(String(DEVICE_ID)), false);
  assert.equal(JSON.stringify(res.body).includes("contact_id"), false);
}));

test("draft-eligible capture selector fails closed before browser display on malformed backend context", async () => withEnvironment(async () => {
  globalThis.fetch = async () => backendResponse({
    ok: true,
    captures: [safeDraftEligibleCapture({ visible_name: "" })]
  });
  const res = responseRecorder();
  await handler(request({ query: { view: "draft-eligible" } }), res);
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /bereite Tinder-Captures vom Backend/i);
}));

test("open T4 review selector forwards a bounded reader and strips draft content and technical fields", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({ ok: true, reviews: [safeOpenDraftReview()] });
  };
  const res = responseRecorder();
  await handler(request({ query: { view: "open-draft-reviews" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(call.url, "https://shared-backend.example/dashboard-api/tinder/drafts/open-reviews");
  assert.equal(call.options.method, "GET");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  assert.deepEqual(res.body, {
    ok: true,
    reviews: [{
      capture_id: CAPTURE_ID,
      visible_name: "M Tinder Test",
      status: "DRAFT"
    }]
  });
  assert.equal(JSON.stringify(res.body).includes("private draft must not reach selector"), false);
  assert.equal(JSON.stringify(res.body).includes("private-thread-fingerprint"), false);
  assert.equal(JSON.stringify(res.body).includes("private-capture-fingerprint"), false);
  assert.equal(JSON.stringify(res.body).includes(String(DEVICE_ID)), false);
  assert.equal(JSON.stringify(res.body).includes("contact_id"), false);
}));

test("open T4 review selector rejects an ineligible or malformed backend review before browser display", async () => withEnvironment(async () => {
  globalThis.fetch = async () => backendResponse({
    ok: true,
    reviews: [safeOpenDraftReview({ status: "REJECTED" })]
  });
  const res = responseRecorder();
  await handler(request({ query: { view: "open-draft-reviews" } }), res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, "Ungültige offene Tinder-Draft-Prüfungen vom Backend.");
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

test("human-armed binding POST forwards only the exact explicit fallback contract and redacts all handles", async () => withEnvironment(async () => {
  let call;
  const body = { action: "BIND_CREATE", new_contact_name: "M Tinder Test", confirmed: true };
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({
      ok: true,
      result: {
        status: "ARMED",
        bindingId: "832d0663-8bb1-4947-ae8a-14a6d9de8924",
        contactId: 7,
        commandId: "0a3699ca-2b77-48bf-8563-2022f8a3e2a5",
        referenceHash: "c".repeat(64)
      }
    });
  };
  const res = responseRecorder();
  await handler(request({
    method: "POST",
    query: { captureId: CAPTURE_ID, operation: "human-arm" },
    body
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(call.url, `https://shared-backend.example/dashboard-api/tinder/captures/${CAPTURE_ID}/human-armed-binding`);
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  assert.deepEqual(JSON.parse(call.options.body), body);
  assert.deepEqual(res.body, { ok: true, result: { status: "ARMED" } });
  assert.equal(JSON.stringify(res.body).includes("bindingId"), false);
  assert.equal(JSON.stringify(res.body).includes("contactId"), false);
  assert.equal(JSON.stringify(res.body).includes("commandId"), false);
  assert.equal(JSON.stringify(res.body).includes("c".repeat(64)), false);
}));

test("human-armed rearm POST uses only an opaque JS handle and explicit confirmation", async () => withEnvironment(async () => {
  const bindingId = "832d0663-8bb1-4947-ae8a-14a6d9de8924";
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({
      ok: true,
      result: {
        status: "ARMED",
        commandId: "0a3699ca-2b77-48bf-8563-2022f8a3e2a5"
      }
    });
  };
  const res = responseRecorder();
  await handler(request({
    method: "POST",
    query: { bindingId, operation: "human-rearm" },
    body: { confirmed: true }
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(call.url, `https://shared-backend.example/dashboard-api/tinder/human-armed-conversation-bindings/${bindingId}/rearm`);
  assert.deepEqual(JSON.parse(call.options.body), { confirmed: true });
  assert.deepEqual(res.body, { ok: true, result: { status: "ARMED" } });
  assert.equal(JSON.stringify(res.body).includes("commandId"), false);
}));

test("human-armed current-chat sync forwards only the opaque binding handle and explicit current-view confirmation", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({
      ok: true,
      sync: {
        command_type: "SYNC_TINDER_VISIBLE_CHAT",
        status: "QUEUED",
        command_id: "0a3699ca-2b77-48bf-8563-2022f8a3e2a5",
        device_id: DEVICE_ID,
        source_capture_id: CAPTURE_ID,
        contact_id: 7,
        fingerprint: "a".repeat(64)
      }
    }, { status: 202 });
  };
  const res = responseRecorder();
  await handler(request({
    method: "POST",
    query: { bindingId: BINDING_ID, operation: "human-armed-visible-chat-sync" },
    body: { confirmed: true }
  }), res);

  assert.equal(res.statusCode, 502);
  // A backend result with technical handles is deliberately rejected rather
  // than partially accepted, so the browser never gets a hidden source.
  assert.equal(JSON.stringify(res.body).includes("0a3699ca"), false);
  assert.equal(JSON.stringify(res.body).includes(DEVICE_ID), false);
  assert.equal(JSON.stringify(res.body).includes(CAPTURE_ID), false);

  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({
      ok: true,
      sync: { command_type: "SYNC_TINDER_VISIBLE_CHAT", status: "QUEUED" }
    }, { status: 202 });
  };
  const success = responseRecorder();
  await handler(request({
    method: "POST",
    query: { bindingId: BINDING_ID, operation: "human-armed-visible-chat-sync" },
    body: { confirmed: true }
  }), success);

  assert.equal(success.statusCode, 202);
  assert.equal(call.url, `https://shared-backend.example/dashboard-api/tinder/human-armed-conversation-bindings/${BINDING_ID}/visible-chat-sync`);
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  assert.deepEqual(JSON.parse(call.options.body), { confirmed: true });
  assert.deepEqual(success.body, {
    ok: true,
    sync: { command_type: "SYNC_TINDER_VISIBLE_CHAT", status: "QUEUED" }
  });
  const rendered = JSON.stringify(success.body);
  for (const forbidden of [BINDING_ID, CAPTURE_ID, DEVICE_ID, "command_id", "source_capture_id", "contact_id", "fingerprint"]) {
    assert.equal(rendered.includes(forbidden), false);
  }
}));

test("human-armed current-chat sync rejects injected browser data and redacts bounded backend conflicts", async () => withEnvironment(async () => {
  globalThis.fetch = async () => { throw new Error("fetch must not run"); };
  for (const body of [
    {},
    { confirmed: false },
    { confirmed: true, capture_id: CAPTURE_ID },
    { confirmed: true, device_id: DEVICE_ID },
    { confirmed: true, contact_id: 7 },
    { confirmed: true, visible_name: "M" },
    { confirmed: true, thread_fingerprint: "a".repeat(64) },
    { confirmed: true, messages: ["private"] }
  ]) {
    const invalid = responseRecorder();
    await handler(request({
      method: "POST",
      query: { bindingId: BINDING_ID, operation: "human-armed-visible-chat-sync" },
      body
    }), invalid);
    assert.equal(invalid.statusCode, 400);
  }

  globalThis.fetch = async () => backendResponse({
    ok: false,
    conflict: true,
    sync: {
      command_type: "SYNC_TINDER_VISIBLE_CHAT",
      status: "PERMIT_NOT_AVAILABLE",
      reason_code: "HUMAN_ARMED_BINDING_NOT_CONFIRMED"
    }
  }, { ok: false, status: 409 });
  const boundedConflict = responseRecorder();
  await handler(request({
    method: "POST",
    query: { bindingId: BINDING_ID, operation: "human-armed-visible-chat-sync" },
    body: { confirmed: true }
  }), boundedConflict);
  assert.equal(boundedConflict.statusCode, 409);
  assert.deepEqual(boundedConflict.body, {
    ok: false,
    conflict: true,
    sync: {
      command_type: "SYNC_TINDER_VISIBLE_CHAT",
      status: "PERMIT_NOT_AVAILABLE",
      reason_code: "HUMAN_ARMED_BINDING_NOT_CONFIRMED"
    },
    error: "Human-bestätigte aktuelle Chat-Synchronisierung ist derzeit nicht verfügbar."
  });

  globalThis.fetch = async () => backendResponse({
    ok: false,
    conflict: true,
    sync: {
      command_type: "SYNC_TINDER_VISIBLE_CHAT",
      status: "PERMIT_NOT_AVAILABLE",
      reason_code: "HUMAN_ARMED_BINDING_NOT_CONFIRMED",
      source_capture_id: CAPTURE_ID,
      device_id: DEVICE_ID,
      contact_id: 7
    },
    error: "private database detail"
  }, { ok: false, status: 409 });
  const conflict = responseRecorder();
  await handler(request({
    method: "POST",
    query: { bindingId: BINDING_ID, operation: "human-armed-visible-chat-sync" },
    body: { confirmed: true }
  }), conflict);
  assert.equal(conflict.statusCode, 502);
  const rendered = JSON.stringify(conflict.body);
  for (const forbidden of [CAPTURE_ID, DEVICE_ID, "private database detail", "source_capture_id", "contact_id"]) {
    assert.equal(rendered.includes(forbidden), false);
  }
}));

test("local conversation bootstrap forwards the exact confirmation and keeps CHAT_VERIFIED gating bounded", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({
      ok: false,
      conflict: true,
      attestation: {
        command_type: "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION",
        status: "PERMIT_NOT_AVAILABLE",
        reason_code: "CHAT_VERIFICATION_REQUIRED"
      },
      binding_id: BINDING_ID,
      device_id: DEVICE_ID,
      visible_name: "must-not-reach-browser"
    }, { ok: false, status: 409 });
  };
  const res = responseRecorder();
  await handler(request({
    method: "POST",
    query: { bindingId: BINDING_ID, operation: "human-armed-local-conversation-attestation" },
    body: { confirmed: true }
  }), res);

  assert.equal(res.statusCode, 409);
  assert.equal(call.url, `https://shared-backend.example/dashboard-api/tinder/human-armed-conversation-bindings/${BINDING_ID}/local-conversation-attestation`);
  assert.deepEqual(JSON.parse(call.options.body), { confirmed: true });
  assert.deepEqual(res.body, {
    ok: false,
    conflict: true,
    attestation: {
      command_type: "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION",
      status: "PERMIT_NOT_AVAILABLE",
      reason_code: "CHAT_VERIFICATION_REQUIRED"
    },
    error: "Lokale Conversation-Bestätigung ist derzeit nicht verfügbar."
  });
  const rendered = JSON.stringify(res.body);
  for (const forbidden of [BINDING_ID, DEVICE_ID, "visible_name", "must-not-reach-browser"]) {
    assert.equal(rendered.includes(forbidden), false);
  }
}));

test("V8 unbound Inbox sweep proxy exposes bounded status only and has no browser start operation", async () => withEnvironment(async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return backendResponse({
      ok: true,
      unbound_inbox_sweep: { status: "ACTIVE" }
    });
  };
  const status = responseRecorder();
  await handler(request({
    query: { deviceId: DEVICE_ID, view: "unbound-inbox-conversation-sweep-status" }
  }), status);
  assert.equal(status.statusCode, 200);
  assert.equal(calls[0].url,
    `https://shared-backend.example/dashboard-api/tinder/devices/${DEVICE_ID}/unbound-inbox-conversation-sweeps/status`);
  assert.deepEqual(status.body, { ok: true, unbound_inbox_sweep: { status: "ACTIVE" } });

  globalThis.fetch = async () => { throw new Error("fetch must not run"); };
  const manualStart = responseRecorder();
  await handler(request({
    method: "POST",
    query: { deviceId: DEVICE_ID, operation: "unbound-inbox-conversation-sweep" },
    body: {}
  }), manualStart);
  assert.equal(manualStart.statusCode, 400);
}));

test("V8 pending transcript projection remains device-scoped, bounded, and strips all correlation fields at the Vercel boundary", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({
      ok: true,
      transcripts: [{
        received_at: "2026-09-12T12:00:00.000Z",
        mapping_status: "NEEDS_HUMAN_MAPPING",
        human_review_status: "PENDING",
        messages: [
          { direction: "INBOUND", text: "bounded pending text" },
          { direction: "OUTBOUND", text: "bounded reply text" }
        ]
      }]
    });
  };
  const res = responseRecorder();
  await handler(request({
    query: { deviceId: DEVICE_ID, view: "unbound-inbox-conversation-sweep-transcripts" }
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(call.url,
    `https://shared-backend.example/dashboard-api/tinder/devices/${DEVICE_ID}/unbound-inbox-conversation-sweeps/transcripts`);
  assert.equal(call.options.method, "GET");
  assert.equal(Object.hasOwn(call.options, "body"), false);
  assert.deepEqual(res.body, {
    ok: true,
    transcripts: [{
      received_at: "2026-09-12T12:00:00.000Z",
      mapping_status: "NEEDS_HUMAN_MAPPING",
      human_review_status: "PENDING",
      messages: [
        { direction: "INBOUND", text: "bounded pending text" },
        { direction: "OUTBOUND", text: "bounded reply text" }
      ]
    }]
  });

  globalThis.fetch = async () => backendResponse({
    ok: true,
    transcripts: [{
      received_at: "2026-09-12T12:00:00.000Z",
      mapping_status: "NEEDS_HUMAN_MAPPING",
      human_review_status: "PENDING",
      messages: [{ direction: "INBOUND", text: "bounded pending text" }],
      transcript_id: "a565e8a7-ef60-42d0-b19d-26e7904390fa"
    }]
  });
  const injected = responseRecorder();
  await handler(request({
    query: { deviceId: DEVICE_ID, view: "unbound-inbox-conversation-sweep-transcripts" }
  }), injected);
  assert.equal(injected.statusCode, 502);
  assert.equal(JSON.stringify(injected.body).includes("a565e8a7-ef60-42d0-b19d-26e7904390fa"), false);
}));

test("human-armed binding GET keeps the UUID as a bounded browser handle and strips raw server fields", async () => withEnvironment(async () => {
  const bindingId = "832d0663-8bb1-4947-ae8a-14a6d9de8924";
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({
      ok: true,
      bindings: [{
        binding_id: bindingId,
        contact_name: "M Tinder Test",
        local_conversation_attestation_status: "NOT_REQUESTED",
        reader_status: "NOT_REQUESTED"
      }]
    });
  };
  const res = responseRecorder();
  await handler(request({ query: { view: "human-armed-bindings" } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(call.url, "https://shared-backend.example/dashboard-api/tinder/human-armed-conversation-bindings");
  assert.equal(call.options.method, "GET");
  assert.deepEqual(res.body, {
    ok: true,
    bindings: [{
      binding_id: bindingId,
      contact_name: "M Tinder Test",
      local_conversation_attestation_status: "NOT_REQUESTED",
      reader_status: "NOT_REQUESTED"
    }]
  });
  assert.equal(JSON.stringify(res.body).includes("contact_id"), false);
  assert.equal(JSON.stringify(res.body).includes("device_id"), false);
  assert.equal(JSON.stringify(res.body).includes("reference_hash"), false);
  assert.equal(JSON.stringify(res.body).includes("permit_id"), false);
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
