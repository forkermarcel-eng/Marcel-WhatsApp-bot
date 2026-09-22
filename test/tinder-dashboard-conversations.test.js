import assert from "node:assert/strict";
import test from "node:test";
import {
  createTinderDashboardLatestConfirmedConversationListHandler,
  createTinderDashboardLatestConfirmedConversationReadHandler,
  createTinderDashboardReadableConversationListHandler,
  createTinderDashboardReadableConversationReadHandler,
  registerTinderCaptureRoutes
} from "../device-bridge/tinder-capture-routes.js";

const CAPTURE_ID = "6c7308cf-5d40-423d-913b-c4424f0e4ee0";
const CONVERSATION_ID = "8e44b221-8e1a-4f18-832d-28e211d26d1c";
const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";

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
    headers: {},
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
    setHeader(name, value) { this.headers[name] = value; }
  };
}

function readableConversation(overrides = {}) {
  return {
    conversation_handle: CONVERSATION_ID,
    visible_name: "Nicht zugeordnet",
    observed_at: "2026-09-22T12:30:00.000Z",
    identity_state: "UNASSIGNED",
    identity_review: "PENDING",
    history_scope: "AGGREGATED_PARTIAL",
    messages: [{ direction: "INCOMING", text: "Hallo" }],
    ...overrides
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

test("device-scoped readable Conversation routes surface unassigned durable threads without mapping controls", async () => {
  let listDeviceId = null;
  let detailInput = null;
  const listHandler = createTinderDashboardReadableConversationListHandler({}, {
    createRepository() { return {}; },
    createService() {
      return {
        async listReadableConversations(deviceId) {
          listDeviceId = deviceId;
          const { messages, ...item } = readableConversation();
          return [item];
        }
      };
    }
  });
  const listResponse = responseRecorder();
  await listHandler({ params: { deviceId: DEVICE_ID } }, listResponse);
  assert.equal(listResponse.statusCode, 200);
  assert.equal(listDeviceId, DEVICE_ID);
  assert.deepEqual(listResponse.body, {
    ok: true,
    conversations: [{
      conversation_handle: CONVERSATION_ID,
      visible_name: "Nicht zugeordnet",
      observed_at: "2026-09-22T12:30:00.000Z",
      identity_state: "UNASSIGNED",
      identity_review: "PENDING",
      history_scope: "AGGREGATED_PARTIAL"
    }]
  });
  assert.equal(listResponse.headers["Cache-Control"], "no-store, max-age=0");
  assert.equal(JSON.stringify(listResponse.body).includes("Hallo"), false);

  const detailHandler = createTinderDashboardReadableConversationReadHandler({}, {
    createRepository() { return {}; },
    createService() {
      return {
        async getReadableConversation(deviceId, conversationHandle) {
          detailInput = { deviceId, conversationHandle };
          return readableConversation();
        }
      };
    }
  });
  const detailResponse = responseRecorder();
  await detailHandler({ params: { deviceId: DEVICE_ID, conversationHandle: CONVERSATION_ID } }, detailResponse);
  assert.equal(detailResponse.statusCode, 200);
  assert.deepEqual(detailInput, { deviceId: DEVICE_ID, conversationHandle: CONVERSATION_ID });
  assert.deepEqual(detailResponse.body.conversation, readableConversation());
  assert.equal(detailResponse.headers["Cache-Control"], "no-store, max-age=0");
});

test("readable Conversation routes fail closed for bad device scope and leaked capture fields", async () => {
  const { messages, ...leakedItem } = readableConversation();
  const handler = createTinderDashboardReadableConversationListHandler({}, {
    createRepository() { return {}; },
    createService() {
      return {
        async listReadableConversations() {
          return [{ ...leakedItem, capture_id: "must-not-leak" }];
        }
      };
    }
  });
  const malformed = responseRecorder();
  const originalError = console.error;
  console.error = () => {};
  try {
    await handler({ params: { deviceId: DEVICE_ID } }, malformed);
  } finally {
    console.error = originalError;
  }
  assert.equal(malformed.statusCode, 500);
  assert.equal(JSON.stringify(malformed.body).includes("must-not-leak"), false);

  const invalid = responseRecorder();
  await handler({ params: { deviceId: "not-a-device" } }, invalid);
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.body.code, "INVALID_DEVICE_ID");
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
  const readableListIndex = registrations.findIndex(({ method, path }) =>
    method === "GET" && path === "/dashboard-api/tinder/devices/:deviceId/read-conversations"
  );
  const readableDetailIndex = registrations.findIndex(({ method, path }) =>
    method === "GET" && path === "/dashboard-api/tinder/devices/:deviceId/read-conversations/:conversationHandle"
  );
  assert.ok(listIndex >= 0);
  assert.ok(detailIndex > listIndex);
  assert.ok(readableListIndex >= 0);
  assert.ok(readableDetailIndex > readableListIndex);

  for (const route of [
    registrations[listIndex], registrations[detailIndex],
    registrations[readableListIndex], registrations[readableDetailIndex]
  ]) {
    const res = responseRecorder();
    await route.handler({ params: { captureId: CAPTURE_ID, deviceId: DEVICE_ID, conversationHandle: CAPTURE_ID } }, res);
    assert.equal(res.statusCode, 401);
  }
  assert.equal(readinessCalled, false);
});
