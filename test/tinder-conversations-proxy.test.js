import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import handler from "../api/tinder/captures.js";

const CAPTURE_ID = "6c7308cf-5d40-423d-913b-c4424f0e4ee0";
const PASSWORD = "test-dashboard-password";

function validCookie() {
  const token = "test-session";
  const signature = crypto.createHmac("sha256", PASSWORD).update(token).digest("hex");
  return `marcel_dashboard_session=${token}.${signature}`;
}

function request({ method = "GET", authenticated = true, query = { view: "confirmed-conversations" } } = {}) {
  return {
    method,
    headers: { cookie: authenticated ? validCookie() : "" },
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

function backendResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, async text() { return JSON.stringify(body); } };
}

function listItem(overrides = {}) {
  return {
    capture_id: CAPTURE_ID,
    visible_name: "Sandry",
    captured_at: "2026-09-07T12:30:00.000Z",
    ...overrides
  };
}

function detail(overrides = {}) {
  return {
    ...listItem(),
    messages: [{ direction: "INCOMING", text: "Hallo" }],
    ...overrides
  };
}

function visibleChatSync(overrides = {}) {
  return {
    received_at: "2026-09-07T12:35:00.000Z",
    layout_schema_version: "tinder-zte-visible-chat-scroll-v1",
    segment_count: 2,
    overlap_count: 2,
    messages: [{ direction: "INCOMING", text: "Synchronisierte Nachricht" }],
    ...overrides
  };
}

async function withEnvironment(run) {
  const originalFetch = globalThis.fetch;
  const originalPassword = process.env.DASHBOARD_PASSWORD;
  const originalUrl = process.env.RAILWAY_BACKEND_URL;
  const originalSecret = process.env.DASHBOARD_API_SECRET;
  process.env.DASHBOARD_PASSWORD = PASSWORD;
  process.env.RAILWAY_BACKEND_URL = "https://shared-backend.example";
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

test("conversation proxy rejects unauthenticated, unsupported POST, or ambiguous request before fetch", async () => withEnvironment(async () => {
  globalThis.fetch = async () => { throw new Error("fetch must not run"); };

  const unauthenticated = responseRecorder();
  await handler(request({ authenticated: false }), unauthenticated);
  assert.equal(unauthenticated.statusCode, 401);

  const nonGet = responseRecorder();
  await handler(request({ method: "POST" }), nonGet);
  // The consolidated captures function legitimately also serves bounded
  // operations. A list selector itself remains GET-only and is rejected.
  assert.equal(nonGet.statusCode, 400);

  for (const query of [
    {},
    { view: "anything" },
    { captureId: CAPTURE_ID, view: "confirmed-conversations" },
    { captureId: "not-a-capture" },
    { captureId: CAPTURE_ID, view: "wrong" },
    { captureId: CAPTURE_ID, extra: "blocked" }
  ]) {
    const invalid = responseRecorder();
    await handler(request({ query }), invalid);
    assert.equal(invalid.statusCode, 400);
  }
}));

test("visible-chat sync forwards only the selected opaque capture with an enforced empty body", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({
      ok: true,
      sync: { command_type: "SYNC_TINDER_VISIBLE_CHAT", status: "QUEUED" }
    }, { status: 202 });
  };
  const res = responseRecorder();
  await handler(request({
    method: "POST",
    query: { captureId: CAPTURE_ID, operation: "visible-chat-sync" }
  }), res);

  assert.equal(res.statusCode, 202);
  assert.equal(call.url, `https://shared-backend.example/dashboard-api/tinder/captures/${CAPTURE_ID}/visible-chat-sync`);
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  assert.equal(call.options.headers["Content-Type"], "application/json");
  assert.equal(call.options.body, "{}");
  assert.deepEqual(res.body, {
    ok: true,
    sync: { command_type: "SYNC_TINDER_VISIBLE_CHAT", status: "QUEUED" }
  });
  const rendered = JSON.stringify(res.body);
  for (const forbidden of [CAPTURE_ID, "server-only-secret", "device_id", "source_capture_id", "command_id", "permit"]) {
    assert.equal(rendered.includes(forbidden), false);
  }
}));

test("visible-chat sync rejects injected browser input and fails closed on nonbounded backend results", async () => withEnvironment(async () => {
  globalThis.fetch = async () => { throw new Error("fetch must not run"); };
  for (const body of [
    { deviceId: "f0c2de30-3d80-477a-a7e8-143f35b13959" },
    { sourceCaptureId: CAPTURE_ID },
    { contactId: 7 },
    { threadFingerprint: "a".repeat(64) }
  ]) {
    const invalid = responseRecorder();
    await handler({
      ...request({ method: "POST", query: { captureId: CAPTURE_ID, operation: "visible-chat-sync" } }),
      body
    }, invalid);
    assert.equal(invalid.statusCode, 400);
  }

  globalThis.fetch = async () => backendResponse({
    ok: true,
    sync: {
      command_type: "SYNC_TINDER_VISIBLE_CHAT",
      status: "QUEUED",
      command_id: "d565e8a7-ef60-42d0-b19d-26e7904390fa"
    }
  }, { status: 202 });
  const malformed = responseRecorder();
  await handler(request({
    method: "POST",
    query: { captureId: CAPTURE_ID, operation: "visible-chat-sync" }
  }), malformed);
  assert.equal(malformed.statusCode, 502);
  assert.equal(JSON.stringify(malformed.body).includes("d565e8a7"), false);

  globalThis.fetch = async () => backendResponse({
    ok: false,
    conflict: true,
    sync: {
      command_type: "SYNC_TINDER_VISIBLE_CHAT",
      status: "PERMIT_CONFLICT",
      reason_code: "OFFICIAL_APP_RESUME_PERMIT_ACTIVE"
    },
    error: "private database detail"
  }, { ok: false, status: 409 });
  const boundedConflict = responseRecorder();
  await handler(request({
    method: "POST",
    query: { captureId: CAPTURE_ID, operation: "visible-chat-sync" }
  }), boundedConflict);
  assert.equal(boundedConflict.statusCode, 409);
  assert.deepEqual(boundedConflict.body, {
    ok: false,
    conflict: true,
    sync: {
      command_type: "SYNC_TINDER_VISIBLE_CHAT",
      status: "PERMIT_CONFLICT",
      reason_code: "OFFICIAL_APP_RESUME_PERMIT_ACTIVE"
    },
    error: "Sichtbare Chat-Synchronisierung ist derzeit nicht verfügbar."
  });

  globalThis.fetch = async () => backendResponse({
    ok: false,
    conflict: true,
    sync: {
      command_type: "SYNC_TINDER_VISIBLE_CHAT",
      status: "PERMIT_NOT_AVAILABLE",
      reason_code: "SOURCE_CAPTURE_NOT_CONFIRMED",
      device_id: "private-device"
    },
    error: "private database detail"
  }, { ok: false, status: 409 });
  const conflict = responseRecorder();
  await handler(request({
    method: "POST",
    query: { captureId: CAPTURE_ID, operation: "visible-chat-sync" }
  }), conflict);
  assert.equal(conflict.statusCode, 502);
  assert.equal(JSON.stringify(conflict.body).includes("private-device"), false);
  assert.equal(JSON.stringify(conflict.body).includes("private database detail"), false);
}));

test("official-app resume forwards only the selected opaque capture and an exact empty body", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({
      ok: true,
      resume: { command_type: "RESUME_OFFICIAL_TINDER_APP", status: "QUEUED" }
    }, { status: 202 });
  };
  const res = responseRecorder();
  await handler(request({
    method: "POST",
    query: { captureId: CAPTURE_ID, operation: "resume-official-app" }
  }), res);

  assert.equal(res.statusCode, 202);
  assert.equal(call.url, `https://shared-backend.example/dashboard-api/tinder/captures/${CAPTURE_ID}/resume-official-app`);
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  assert.equal(call.options.headers["Content-Type"], "application/json");
  assert.equal(call.options.body, "{}");
  assert.deepEqual(res.body, {
    ok: true,
    resume: { command_type: "RESUME_OFFICIAL_TINDER_APP", status: "QUEUED" }
  });
  const rendered = JSON.stringify(res.body);
  for (const forbidden of [CAPTURE_ID, "server-only-secret", "device_id", "source_capture_id", "command_id", "permit", "package", "component", "uri"]) {
    assert.equal(rendered.includes(forbidden), false);
  }
}));

test("official-app resume rejects browser targeting input and fails closed on malformed or leaking results", async () => withEnvironment(async () => {
  globalThis.fetch = async () => { throw new Error("fetch must not run"); };
  for (const body of [
    { device_id: "f0c2de30-3d80-477a-a7e8-143f35b13959" },
    { source_capture_id: CAPTURE_ID },
    { command_id: "d565e8a7-ef60-42d0-b19d-26e7904390fa" },
    { package: "com.tinder" },
    { component: "com.tinder/.Fake" },
    { uri: "tinder://anything" },
    { thread_fingerprint: "a".repeat(64) }
  ]) {
    const invalid = responseRecorder();
    await handler({
      ...request({ method: "POST", query: { captureId: CAPTURE_ID, operation: "resume-official-app" } }),
      body
    }, invalid);
    assert.equal(invalid.statusCode, 400);
  }

  globalThis.fetch = async () => backendResponse({
    ok: true,
    resume: {
      command_type: "RESUME_OFFICIAL_TINDER_APP",
      status: "QUEUED",
      command_id: "d565e8a7-ef60-42d0-b19d-26e7904390fa"
    }
  }, { status: 202 });
  const malformed = responseRecorder();
  await handler(request({
    method: "POST",
    query: { captureId: CAPTURE_ID, operation: "resume-official-app" }
  }), malformed);
  assert.equal(malformed.statusCode, 502);
  assert.equal(JSON.stringify(malformed.body).includes("d565e8a7"), false);

  globalThis.fetch = async () => backendResponse({
    ok: false,
    conflict: true,
    resume: {
      command_type: "RESUME_OFFICIAL_TINDER_APP",
      status: "PERMIT_NOT_AVAILABLE",
      reason_code: "SOURCE_CAPTURE_NOT_CONFIRMED"
    },
    error: "private database detail"
  }, { ok: false, status: 409 });
  const conflict = responseRecorder();
  await handler(request({
    method: "POST",
    query: { captureId: CAPTURE_ID, operation: "resume-official-app" }
  }), conflict);
  assert.equal(conflict.statusCode, 409);
  assert.deepEqual(conflict.body.resume, {
    command_type: "RESUME_OFFICIAL_TINDER_APP",
    status: "PERMIT_NOT_AVAILABLE",
    reason_code: "SOURCE_CAPTURE_NOT_CONFIRMED"
  });
  assert.equal(JSON.stringify(conflict.body).includes("private database detail"), false);
}));

test("conversation list proxy forwards the bounded list route and exposes only metadata", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({ ok: true, conversations: [listItem()] });
  };
  const res = responseRecorder();
  await handler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(call.url, "https://shared-backend.example/dashboard-api/tinder/conversations/latest-confirmed");
  assert.equal(call.options.method, "GET");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  assert.equal(call.options.cache, "no-store");
  assert.deepEqual(res.body, { ok: true, conversations: [listItem()] });
  assert.equal(JSON.stringify(res.body).includes("server-only-secret"), false);
  assert.equal(JSON.stringify(res.body).includes("Hallo"), false);
  assert.equal(res.headers["Cache-Control"], "no-store, max-age=0");
}));

test("conversation detail proxy forwards a selected opaque handle and returns direction/text only", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse({ ok: true, conversation: detail() });
  };
  const res = responseRecorder();
  await handler(request({ query: { captureId: CAPTURE_ID, view: "confirmed-conversation" } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(call.url, `https://shared-backend.example/dashboard-api/tinder/conversations/${CAPTURE_ID}`);
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
  assert.deepEqual(res.body, { ok: true, conversation: detail() });
  assert.deepEqual(Object.keys(res.body.conversation.messages[0]).sort(), ["direction", "text"]);
  assert.equal(JSON.stringify(res.body).includes("device_id"), false);
  assert.equal(JSON.stringify(res.body).includes("thread_fingerprint"), false);
  assert.equal(JSON.stringify(res.body).includes("capture_fingerprint"), false);
}));

test("conversation detail proxy permits a separately bounded V4 visible-chat transcript without technical fields", async () => withEnvironment(async () => {
  globalThis.fetch = async () => backendResponse({
    ok: true,
    conversation: detail({ visible_chat_sync: visibleChatSync() })
  });
  const res = responseRecorder();
  await handler(request({ query: { captureId: CAPTURE_ID, view: "confirmed-conversation" } }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.conversation.visible_chat_sync, visibleChatSync());
  const rendered = JSON.stringify(res.body);
  for (const forbidden of ["command_id", "source_capture_id", "device_id", "transcript_fingerprint", "permit"]) {
    assert.equal(rendered.includes(forbidden), false);
  }

  globalThis.fetch = async () => backendResponse({
    ok: true,
    conversation: detail({ visible_chat_sync: visibleChatSync({ command_id: "d565e8a7-ef60-42d0-b19d-26e7904390fa" }) })
  });
  const malformed = responseRecorder();
  await handler(request({ query: { captureId: CAPTURE_ID, view: "confirmed-conversation" } }), malformed);
  assert.equal(malformed.statusCode, 502);
  assert.equal(JSON.stringify(malformed.body).includes("d565e8a7"), false);
}));

test("conversation detail proxy permits only a bounded official-app resume observation", async () => withEnvironment(async () => {
  globalThis.fetch = async () => backendResponse({
    ok: true,
    conversation: detail({ official_app_resume: { status: "DISPATCHED" } })
  });
  const res = responseRecorder();
  await handler(request({ query: { captureId: CAPTURE_ID, view: "confirmed-conversation" } }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.conversation.official_app_resume, { status: "DISPATCHED" });
  const rendered = JSON.stringify(res.body.conversation.official_app_resume);
  for (const forbidden of ["command_id", "device_id", "source_capture_id", "expires_at", "ack", "permit"]) {
    assert.equal(rendered.includes(forbidden), false);
  }

  globalThis.fetch = async () => backendResponse({
    ok: true,
    conversation: detail({
      official_app_resume: { status: "DISPATCHED", command_id: "private-command" }
    })
  });
  const malformed = responseRecorder();
  await handler(request({ query: { captureId: CAPTURE_ID, view: "confirmed-conversation" } }), malformed);
  assert.equal(malformed.statusCode, 502);
  assert.equal(JSON.stringify(malformed.body).includes("private-command"), false);
}));

test("conversation proxy fails closed on extra technical fields and strips backend/network errors", async () => withEnvironment(async () => {
  globalThis.fetch = async () => backendResponse({
    ok: true,
    conversation: detail({ device_id: "private-device", runtime_thread_fingerprint: "private-thread" })
  });
  const malformed = responseRecorder();
  await handler(request({ query: { captureId: CAPTURE_ID, view: "confirmed-conversation" } }), malformed);
  assert.equal(malformed.statusCode, 502);
  assert.equal(JSON.stringify(malformed.body).includes("private-device"), false);
  assert.equal(JSON.stringify(malformed.body).includes("private-thread"), false);

  globalThis.fetch = async () => backendResponse({ ok: false, conversations: [listItem()] });
  const falseSuccess = responseRecorder();
  await handler(request(), falseSuccess);
  assert.equal(falseSuccess.statusCode, 502);
  assert.equal(JSON.stringify(falseSuccess.body).includes("Sandry"), false);

  globalThis.fetch = async () => backendResponse({
    ok: false,
    error: "private database detail",
    code: "PRIVATE_CODE",
    device_id: "private-device"
  }, { ok: false, status: 404 });
  const backendFailure = responseRecorder();
  await handler(request({ query: { captureId: CAPTURE_ID, view: "confirmed-conversation" } }), backendFailure);
  assert.equal(backendFailure.statusCode, 404);
  assert.equal(JSON.stringify(backendFailure.body).includes("private database detail"), false);
  assert.equal(JSON.stringify(backendFailure.body).includes("PRIVATE_CODE"), false);
  assert.equal(JSON.stringify(backendFailure.body).includes("private-device"), false);

  globalThis.fetch = async () => { throw new Error("private network detail"); };
  const networkFailure = responseRecorder();
  const originalError = console.error;
  console.error = () => {};
  try {
    await handler(request(), networkFailure);
  } finally {
    console.error = originalError;
  }
  assert.equal(networkFailure.statusCode, 502);
  assert.equal(JSON.stringify(networkFailure.body).includes("private network detail"), false);
}));
