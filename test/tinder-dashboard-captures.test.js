import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMappingBody,
  createTinderDashboardCaptureReadHandler,
  createTinderDashboardMappingHandler
} from "../device-bridge/tinder-capture-routes.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const CAPTURE_ID = "6c7308cf-5d40-423d-913b-c4424f0e4ee0";

function capture() {
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
    received_at: "2026-09-04T18:01:00.000Z"
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
