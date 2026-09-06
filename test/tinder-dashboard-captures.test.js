import assert from "node:assert/strict";
import test from "node:test";
import {
  assertConversationBindingBody,
  assertMappingBody,
  createTinderDashboardCaptureReadHandler,
  createTinderDashboardConversationBindingHandler,
  createTinderDashboardPendingCaptureListHandler,
  createTinderDashboardMappingHandler,
  registerTinderCaptureRoutes
} from "../device-bridge/tinder-capture-routes.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const CAPTURE_ID = "6c7308cf-5d40-423d-913b-c4424f0e4ee0";

function capture(overrides = {}) {
  return {
    capture_id: CAPTURE_ID,
    device_id: DEVICE_ID,
    capture_revision: 3,
    mapping_status: "NEEDS_HUMAN_MAPPING",
    human_review_status: "PENDING",
    visible_thread_metadata: {
      visible_name: "Sandry",
      thread_fingerprint: "a".repeat(64)
    },
    visible_messages: [{ visible_order: 1, text: "private visible text", direction: "INCOMING" }],
    source_package: "com.tinder",
    captured_at: "2026-09-04T18:00:00.000Z",
    received_at: "2026-09-04T18:01:00.000Z",
    ...overrides
  };
}

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

test("dashboard capture read exposes only mapping context, not visible message text or fingerprint", async () => {
  const handler = createTinderDashboardCaptureReadHandler({}, {
    createRepository() { return {}; },
    createStore() { return { async getCapture() { return capture(); } }; }
  });
  const res = responseRecorder();
  await handler({ params: { captureId: CAPTURE_ID } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.capture.visible_name, "Sandry");
  assert.equal(JSON.stringify(res.body).includes("private visible text"), false);
  assert.equal(JSON.stringify(res.body).includes("thread_fingerprint"), false);
});

test("dashboard capture read exposes only bounded conversation-binding readiness", async () => {
  let readinessCaptureId = null;
  const handler = createTinderDashboardCaptureReadHandler({}, {
    createRepository() { return {}; },
    createStore() {
      return {
        async getCapture() {
          return capture({
            visible_thread_metadata: {
              visible_name: "Sandry",
              thread_fingerprint: "a".repeat(64),
              thread_binding_evidence: {
                kind: "tinder_accessibility_header_unique_id_hmac_v1",
                role: "HEADER_TITLE",
                status: "OBSERVED_UNVERIFIED",
                token: "b".repeat(64)
              }
            }
          });
        }
      };
    },
    createBindingRepository() { return {}; },
    createBindingService() {
      return {
        async getReadiness(captureId) {
          readinessCaptureId = captureId;
          return {
            status: "ELIGIBLE_FOR_HUMAN_BINDING",
            referenceHash: "b".repeat(64),
            privateReason: "must not reach the dashboard"
          };
        }
      };
    }
  });
  const res = responseRecorder();
  await handler({ params: { captureId: CAPTURE_ID } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(readinessCaptureId, CAPTURE_ID);
  assert.equal(res.body.capture.conversation_binding_status, "ELIGIBLE_FOR_HUMAN_BINDING");
  assert.equal(JSON.stringify(res.body).includes("thread_binding_evidence"), false);
  assert.equal(JSON.stringify(res.body).includes("referenceHash"), false);
  assert.equal(JSON.stringify(res.body).includes("b".repeat(64)), false);
  assert.equal(JSON.stringify(res.body).includes("must not reach the dashboard"), false);
});

test("dashboard capture read rejects malformed ids and is fail closed when T3 schema is absent", async () => {
  const invalidHandler = createTinderDashboardCaptureReadHandler({}, {
    createRepository() { return {}; },
    createStore() { return { async getCapture() { throw new Error("must not run"); } }; }
  });
  const invalid = responseRecorder();
  await invalidHandler({ params: { captureId: "not-a-capture" } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.code, "INVALID_CAPTURE_ID");

  const missingSchemaHandler = createTinderDashboardCaptureReadHandler({}, {
    createRepository() { return {}; },
    createStore() {
      return {
        async getCapture() {
          const error = new Error("missing table");
          error.code = "42P01";
          throw error;
        }
      };
    }
  });
  const missing = responseRecorder();
  await missingSchemaHandler({ params: { captureId: CAPTURE_ID } }, missing);
  assert.equal(missing.statusCode, 503);
  assert.equal(missing.body.code, "TINDER_IDENTITY_FOUNDATION_NOT_READY");
});

test("dashboard pending capture list exposes only redacted safe pending mapping context", async () => {
  const handler = createTinderDashboardPendingCaptureListHandler({}, {
    createRepository() { return {}; },
    createStore() {
      return {
        async listPendingHumanMappingCaptures() {
          return [capture()];
        }
      };
    }
  });
  const res = responseRecorder();
  await handler({}, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.captures.length, 1);
  assert.equal(res.body.captures[0].capture_id, CAPTURE_ID);
  assert.equal(JSON.stringify(res.body).includes("private visible text"), false);
  assert.equal(JSON.stringify(res.body).includes("thread_fingerprint"), false);
});

test("dashboard pending capture list is fail closed for T3 absence or non-pending rows", async () => {
  const missingSchemaHandler = createTinderDashboardPendingCaptureListHandler({}, {
    createRepository() { return {}; },
    createStore() {
      return {
        async listPendingHumanMappingCaptures() {
          const error = new Error("missing table");
          error.code = "42P01";
          throw error;
        }
      };
    }
  });
  const missing = responseRecorder();
  await missingSchemaHandler({}, missing);
  assert.equal(missing.statusCode, 503);
  assert.equal(missing.body.code, "TINDER_IDENTITY_FOUNDATION_NOT_READY");

  const nonPendingHandler = createTinderDashboardPendingCaptureListHandler({}, {
    createRepository() { return {}; },
    createStore() {
      return {
        async listPendingHumanMappingCaptures() {
          return [capture({ mapping_status: "RESOLVED", human_review_status: "CONFIRMED" })];
        }
      };
    }
  });
  const nonPending = responseRecorder();
  const originalError = console.error;
  console.error = () => {};
  try {
    await nonPendingHandler({}, nonPending);
  } finally {
    console.error = originalError;
  }
  assert.equal(nonPending.statusCode, 500);
  assert.equal(nonPending.body.code, "INVALID_PENDING_TINDER_CAPTURES");
  assert.equal(JSON.stringify(nonPending.body).includes("private visible text"), false);
});

test("dashboard pending capture list fails closed when a store violates the fixed result bound", async () => {
  const handler = createTinderDashboardPendingCaptureListHandler({}, {
    createRepository() { return {}; },
    createStore() {
      return {
        async listPendingHumanMappingCaptures() {
          return Array.from({ length: 26 }, capture);
        }
      };
    }
  });
  const res = responseRecorder();
  const originalError = console.error;
  console.error = () => {};
  try {
    await handler({}, res);
  } finally {
    console.error = originalError;
  }
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, "INVALID_PENDING_TINDER_CAPTURES");
});

test("pending route remains protected and is registered before the capture-id route", () => {
  const registrations = [];
  registerTinderCaptureRoutes({
    app: {
      get(path, handler) { registrations.push({ method: "GET", path, handler }); },
      post(path, handler) { registrations.push({ method: "POST", path, handler }); }
    },
    pool: { connect() {}, query() {} },
    dashboardApiReady() { return true; },
    dashboardApiAuthorized() { return true; },
    requireDeviceBridgeReady() { return true; }
  });
  const pendingIndex = registrations.findIndex(({ method, path }) =>
    method === "GET" && path === "/dashboard-api/tinder/captures/pending"
  );
  const captureIndex = registrations.findIndex(({ method, path }) =>
    method === "GET" && path === "/dashboard-api/tinder/captures/:captureId"
  );
  assert.ok(pendingIndex >= 0);
  assert.ok(captureIndex > pendingIndex);

  const bindingRoute = registrations.find(({ method, path }) =>
    method === "POST" && path === "/dashboard-api/tinder/captures/:captureId/conversation-binding"
  );
  assert.ok(bindingRoute);
});

test("conversation-binding route retains dashboard authorization before any service call", async () => {
  let deviceBridgeReadinessCalled = false;
  const registrations = [];
  registerTinderCaptureRoutes({
    app: {
      get(path, handler) { registrations.push({ method: "GET", path, handler }); },
      post(path, handler) { registrations.push({ method: "POST", path, handler }); }
    },
    pool: { connect() {}, query() {} },
    dashboardApiReady() { return true; },
    dashboardApiAuthorized() { return false; },
    requireDeviceBridgeReady() {
      deviceBridgeReadinessCalled = true;
      return true;
    }
  });
  const route = registrations.find(({ method, path }) =>
    method === "POST" && path === "/dashboard-api/tinder/captures/:captureId/conversation-binding"
  );
  const res = responseRecorder();
  await route.handler({ params: { captureId: CAPTURE_ID } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(deviceBridgeReadinessCalled, false);
});

test("mapping request permits only a deliberate action-specific human confirmation", () => {
  assert.deepEqual(assertMappingBody({
    action: "MAP_EXISTING",
    contact_id: 7,
    tinder_identifier: "stable-match-42",
    confirmed: true
  }), {
    action: "MAP_EXISTING",
    contactId: 7,
    tinderIdentifier: "stable-match-42",
    confirmed: true
  });
  assert.deepEqual(assertMappingBody({
    action: "CREATE_NEW",
    new_contact_name: "Sandry",
    tinder_identifier: "stable-match-42",
    confirmed: true
  }), {
    action: "CREATE_NEW",
    newContactName: "Sandry",
    tinderIdentifier: "stable-match-42",
    confirmed: true
  });

  for (const body of [
    { action: "MAP_EXISTING", contact_id: 7, tinder_identifier: "id", confirmed: false },
    { action: "MAP_EXISTING", contact_id: 7, tinder_identifier: "id", confirmed: true, actor: "client" },
    { action: "CREATE_NEW", new_contact_name: "Sandry", tinder_identifier: "id", confirmed: true, source: "client" },
    { action: "MAP_EXISTING", contact_id: 7, new_contact_name: "Sandry", tinder_identifier: "id", confirmed: true }
  ]) {
    assert.throws(() => assertMappingBody(body), /Mapping|Bestätigung/i);
  }
});

test("conversation-binding request permits only a minimal deliberate human confirmation", () => {
  assert.deepEqual(assertConversationBindingBody({
    action: "BIND_EXISTING",
    contact_id: 7,
    confirmed: true
  }), {
    action: "BIND_EXISTING",
    contactId: 7,
    confirmed: true
  });
  assert.deepEqual(assertConversationBindingBody({
    action: "BIND_CREATE",
    new_contact_name: "M Tinder Test",
    confirmed: true
  }), {
    action: "BIND_CREATE",
    newContactName: "M Tinder Test",
    confirmed: true
  });

  for (const body of [
    { action: "BIND_EXISTING", contact_id: 7, confirmed: false },
    { action: "BIND_EXISTING", contact_id: 7, confirmed: true, tinder_identifier: "must-not-pass" },
    { action: "BIND_EXISTING", contact_id: 7, confirmed: true, thread_fingerprint: "a".repeat(64) },
    { action: "BIND_CREATE", new_contact_name: "M Tinder Test", confirmed: true, token: "b".repeat(64) },
    { action: "BIND_CREATE", new_contact_name: "M Tinder Test", confirmed: true, actor: "client" },
    { action: "BIND_EXISTING", contact_id: 7, new_contact_name: "M Tinder Test", confirmed: true }
  ]) {
    assert.throws(() => assertConversationBindingBody(body), /Conversation|Bestätigung/i);
  }
});

test("mapping route supplies a server-owned actor and exposes conflict without an automatic overwrite", async () => {
  let received;
  const handler = createTinderDashboardMappingHandler({}, {
    createRepository() { return {}; },
    createService() {
      return {
        async confirmMapping(input) {
          received = input;
          return { status: "CONFLICT", conflictCode: "TINDER_IDENTIFIER_OWNED_BY_ANOTHER_CONTACT" };
        }
      };
    }
  });
  const res = responseRecorder();
  await handler({
    params: { captureId: CAPTURE_ID },
    body: { action: "MAP_EXISTING", contact_id: 7, tinder_identifier: "stable-match-42", confirmed: true }
  }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.conflict, true);
  assert.equal(res.body.result.status, "CONFLICT");
  assert.equal(received.actor, "marcel_dashboard");
  assert.equal(Object.hasOwn(received, "source"), false);
  assert.equal(Object.hasOwn(received, "review_status"), false);
});

test("mapping route returns only a human-confirmed resolution outcome", async () => {
  const handler = createTinderDashboardMappingHandler({}, {
    createRepository() { return {}; },
    createService() {
      return {
        async confirmMapping() {
          return { status: "RESOLVED", contactId: 7, identifierId: 9, idempotent: false };
        }
      };
    }
  });
  const res = responseRecorder();
  await handler({
    params: { captureId: CAPTURE_ID },
    body: { action: "MAP_EXISTING", contact_id: 7, tinder_identifier: "stable-match-42", confirmed: true }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.result, { status: "RESOLVED", contactId: 7, identifierId: 9, idempotent: false });
});

test("conversation-binding route loads the candidate server-side and returns only a confirmed binding", async () => {
  let received = null;
  const handler = createTinderDashboardConversationBindingHandler({}, {
    createRepository() { return {}; },
    createService() {
      return {
        async confirmBinding(input) {
          received = input;
          return {
            status: "CONFIRMED",
            contactId: 7,
            idempotent: false,
            bindingId: 41,
            referenceHash: "c".repeat(64),
            privateReason: "must not reach the dashboard"
          };
        }
      };
    }
  });
  const res = responseRecorder();
  await handler({
    params: { captureId: CAPTURE_ID },
    body: { action: "BIND_EXISTING", contact_id: 7, confirmed: true }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(received, {
    captureId: CAPTURE_ID,
    action: "BIND_EXISTING",
    contactId: 7,
    confirmed: true,
    actor: "marcel_dashboard"
  });
  assert.deepEqual(res.body.result, { status: "CONFIRMED", contactId: 7, idempotent: false });
  assert.equal(JSON.stringify(res.body).includes("bindingId"), false);
  assert.equal(JSON.stringify(res.body).includes("referenceHash"), false);
  assert.equal(JSON.stringify(res.body).includes("c".repeat(64)), false);
});

test("conversation-binding route exposes a bounded conflict without overwrite details", async () => {
  const handler = createTinderDashboardConversationBindingHandler({}, {
    createRepository() { return {}; },
    createService() {
      return {
        async confirmBinding() {
          return {
            status: "CONFLICT",
            preservedContactId: 9,
            referenceHash: "d".repeat(64)
          };
        }
      };
    }
  });
  const res = responseRecorder();
  await handler({
    params: { captureId: CAPTURE_ID },
    body: { action: "BIND_CREATE", new_contact_name: "M Tinder Test", confirmed: true }
  }, res);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { ok: false, conflict: true, result: { status: "CONFLICT" } });
  assert.equal(JSON.stringify(res.body).includes("preservedContactId"), false);
  assert.equal(JSON.stringify(res.body).includes("d".repeat(64)), false);
});
