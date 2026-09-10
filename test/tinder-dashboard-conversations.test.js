import assert from "node:assert/strict";
import test from "node:test";
import {
  createTinderDashboardLatestConfirmedConversationListHandler,
  createTinderDashboardLatestConfirmedConversationReadHandler,
  registerTinderCaptureRoutes
} from "../device-bridge/tinder-capture-routes.js";

const CAPTURE_ID = "6c7308cf-5d40-423d-913b-c4424f0e4ee0";

function conversation(overrides = {}) {
  return {
    capture_id: CAPTURE_ID,
    visible_name: "Sandry",
    captured_at: "2026-09-07T12:30:00.000Z",
    messages: [{ direction: "INCOMING", text: "Hallo" }],
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

test("dashboard conversation list is a metadata-only bounded projection", async () => {
  const handler = createTinderDashboardLatestConfirmedConversationListHandler({}, {
    createRepository() { return {}; },
    createService() {
      return {
        async listLatestConfirmedConversations() {
          return [{
            capture_id: CAPTURE_ID,
            visible_name: "Sandry",
            captured_at: "2026-09-07T12:30:00.000Z"
          }];
        }
      };
    }
  });
  const res = responseRecorder();
  await handler({}, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ok: true,
    conversations: [{
      capture_id: CAPTURE_ID,
      visible_name: "Sandry",
      captured_at: "2026-09-07T12:30:00.000Z"
    }]
  });
  assert.equal(JSON.stringify(res.body).includes("Hallo"), false);
});

test("dashboard conversation detail permits only the selected product reader and returns no raw capture record", async () => {
  let receivedCaptureId = null;
  const handler = createTinderDashboardLatestConfirmedConversationReadHandler({}, {
    createRepository() { return {}; },
    createService() {
      return {
        async getLatestConfirmedConversation(captureId) {
          receivedCaptureId = captureId;
          return conversation();
        }
      };
    }
  });
  const res = responseRecorder();
  await handler({ params: { captureId: CAPTURE_ID } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(receivedCaptureId, CAPTURE_ID);
  assert.equal(res.body.conversation.messages[0].text, "Hallo");
  assert.deepEqual(Object.keys(res.body.conversation).sort(), ["capture_id", "captured_at", "messages", "visible_name"]);

  const malformedProjection = createTinderDashboardLatestConfirmedConversationReadHandler({}, {
    createRepository() { return {}; },
    createService() {
      return {
        async getLatestConfirmedConversation() {
          return conversation({ device_id: "must-not-be-returned" });
        }
      };
    }
  });
  const malformed = responseRecorder();
  const originalError = console.error;
  console.error = () => {};
  try {
    await malformedProjection({ params: { captureId: CAPTURE_ID } }, malformed);
  } finally {
    console.error = originalError;
  }
  assert.equal(malformed.statusCode, 500);
  assert.equal(JSON.stringify(malformed.body).includes("must-not-be-returned"), false);
});

test("dashboard conversation detail exposes only the bounded official-app resume status", async () => {
  const handler = createTinderDashboardLatestConfirmedConversationReadHandler({}, {
    createRepository() { return {}; },
    createService() {
      return {
        async getLatestConfirmedConversation() {
          return conversation({ official_app_resume: { status: "DISPATCHED" } });
        }
      };
    }
  });
  const res = responseRecorder();
  await handler({ params: { captureId: CAPTURE_ID } }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.conversation.official_app_resume, { status: "DISPATCHED" });
  const rendered = JSON.stringify(res.body.conversation.official_app_resume);
  for (const forbidden of ["command_id", "device_id", "source_capture_id", "expires_at", "ack", "permit"]) {
    assert.equal(rendered.includes(forbidden), false);
  }

  const malformedHandler = createTinderDashboardLatestConfirmedConversationReadHandler({}, {
    createRepository() { return {}; },
    createService() {
      return {
        async getLatestConfirmedConversation() {
          return conversation({
            official_app_resume: { status: "DISPATCHED", command_id: "private-command" }
          });
        }
      };
    }
  });
  const malformed = responseRecorder();
  const originalError = console.error;
  console.error = () => {};
  try {
    await malformedHandler({ params: { captureId: CAPTURE_ID } }, malformed);
  } finally {
    console.error = originalError;
  }
  assert.equal(malformed.statusCode, 500);
  assert.equal(JSON.stringify(malformed.body).includes("private-command"), false);
});

test("dashboard conversation reader fails closed for malformed ids, unavailable reader, and foundation absence", async () => {
  const unavailable = createTinderDashboardLatestConfirmedConversationReadHandler({}, {
    createRepository() { return {}; },
    createService() {
      return { async getLatestConfirmedConversation() { return null; } };
    }
  });
  const notFound = responseRecorder();
  await unavailable({ params: { captureId: CAPTURE_ID } }, notFound);
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.body.code, "TINDER_CONVERSATION_NOT_FOUND");

  const invalid = responseRecorder();
  await unavailable({ params: { captureId: "not-a-capture" } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.code, "INVALID_CAPTURE_ID");

  const missingFoundation = createTinderDashboardLatestConfirmedConversationListHandler({}, {
    createRepository() { return {}; },
    createService() {
      return {
        async listLatestConfirmedConversations() {
          const error = new Error("private relation name");
          error.code = "42P01";
          throw error;
        }
      };
    }
  });
  const missing = responseRecorder();
  await missingFoundation({}, missing);
  assert.equal(missing.statusCode, 503);
  assert.equal(missing.body.code, "TINDER_CONVERSATION_PRODUCT_READ_NOT_READY");
  assert.equal(JSON.stringify(missing.body).includes("private relation name"), false);
});

test("conversation routes are separately protected and list route precedes selected-detail route", async () => {
  const registrations = [];
  let readinessCalled = false;
  registerTinderCaptureRoutes({
    app: {
      get(path, handler) { registrations.push({ method: "GET", path, handler }); },
      post(path, handler) { registrations.push({ method: "POST", path, handler }); }
    },
    pool: { connect() {}, query() {} },
    dashboardApiReady() { return true; },
    dashboardApiAuthorized() { return false; },
    requireDeviceBridgeReady() {
      readinessCalled = true;
      return true;
    }
  });

  const listIndex = registrations.findIndex(({ method, path }) =>
    method === "GET" && path === "/dashboard-api/tinder/conversations/latest-confirmed"
  );
  const detailIndex = registrations.findIndex(({ method, path }) =>
    method === "GET" && path === "/dashboard-api/tinder/conversations/:captureId"
  );
  assert.ok(listIndex >= 0);
  assert.ok(detailIndex > listIndex);

  for (const route of [registrations[listIndex], registrations[detailIndex]]) {
    const res = responseRecorder();
    await route.handler({ params: { captureId: CAPTURE_ID } }, res);
    assert.equal(res.statusCode, 401);
  }
  assert.equal(readinessCalled, false);
});
