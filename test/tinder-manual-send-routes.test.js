import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertExactAction,
  createTinderDashboardApproveHandler,
  createTinderDashboardCancelHandler,
  createTinderDashboardDispatchHandler,
  createTinderDashboardRejectHandler,
  registerTinderManualSendRoutes
} from "../device-bridge/tinder-manual-send-routes.js";

const DRAFT_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const APPROVAL_ID = "4d0b6b43-6a5a-4a06-a2d6-d5f2b60b4a2d";
const INTENT_ID = "f3dd4498-1c29-48d2-b953-6c8668dc8fcf";
const COMMAND_ID = "9b2cfc26-586d-4ca8-8b99-b4833d70f7fa";

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

function safeApproval(overrides = {}) {
  return {
    approvalId: APPROVAL_ID,
    draftId: DRAFT_ID,
    draftRevision: 1,
    state: "ACTIVE",
    approvedAt: "2026-09-05T19:00:00.000Z",
    idempotent: false,
    runtimeThreadFingerprint: "private-thread-value",
    ...overrides
  };
}

function safeIntent(overrides = {}) {
  return {
    intentId: INTENT_ID,
    commandId: COMMAND_ID,
    approvalId: APPROVAL_ID,
    draftId: DRAFT_ID,
    draftRevision: 1,
    state: "PENDING_T5_WRITER",
    receivedAt: null,
    completedAt: null,
    resultCode: null,
    idempotent: false,
    payload: { approved_text: "private text" },
    ...overrides
  };
}

test("T5 routes pass only a path Draft ID plus fixed server actor into the domain service", async () => {
  const received = [];
  const approve = createTinderDashboardApproveHandler({
    async approveDraft(input) { received.push(["approve", input]); return safeApproval(); }
  });
  const dispatch = createTinderDashboardDispatchHandler({
    async reserveApprovedSend(input) { received.push(["dispatch", input]); return safeIntent(); }
  });
  const reject = createTinderDashboardRejectHandler({
    async rejectDraft(input) { received.push(["reject", input]); return { draftId: DRAFT_ID, draftRevision: 1, state: "REJECTED", idempotent: false }; }
  });
  const cancel = createTinderDashboardCancelHandler({
    async cancelApprovedSend(input) { received.push(["cancel", input]); return safeIntent({ state: "CANCELLED", completedAt: "2026-09-05T19:01:00.000Z" }); }
  });
  const request = { params: { draftId: DRAFT_ID } };
  const cases = [
    [approve, { action: "APPROVE" }, 201],
    [dispatch, { action: "DISPATCH" }, 202],
    [reject, { action: "REJECT" }, 200],
    [cancel, { action: "CANCEL" }, 200]
  ];
  for (const [handler, body, expected] of cases) {
    const res = responseRecorder();
    await handler({ ...request, body }, res);
    assert.equal(res.statusCode, expected);
    assert.equal(JSON.stringify(res.body).includes("private-thread-value"), false);
    assert.equal(JSON.stringify(res.body).includes("private text"), false);
  }
  assert.deepEqual(received, [
    ["approve", { draftId: DRAFT_ID, actor: "marcel_dashboard" }],
    ["dispatch", { draftId: DRAFT_ID, actor: "marcel_dashboard" }],
    ["reject", { draftId: DRAFT_ID, actor: "marcel_dashboard" }],
    ["cancel", { draftId: DRAFT_ID, actor: "marcel_dashboard" }]
  ]);
});

test("T5 routes reject browser-owned text, hashes, contacts, device IDs, payloads, or generic actions before service calls", async () => {
  let calls = 0;
  const handler = createTinderDashboardApproveHandler({
    async approveDraft() { calls += 1; return safeApproval(); }
  });
  for (const body of [
    undefined,
    {},
    { action: "APPROVE", original_draft: "unsafe" },
    { action: "APPROVE", contact_id: 7 },
    { action: "APPROVE", device_id: COMMAND_ID },
    { action: "APPROVE", thread_ref: "unsafe" },
    { action: "APPROVE", payload: {} },
    { action: "DISPATCH" },
    []
  ]) {
    const res = responseRecorder();
    await handler({ params: { draftId: DRAFT_ID }, body }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "INVALID_TINDER_SEND_REQUEST");
  }
  assert.equal(calls, 0);
  assert.doesNotThrow(() => assertExactAction({ action: "APPROVE" }, "APPROVE"));
});

test("T5 routes reject invalid Draft IDs and preserve controlled missing-foundation 503", async () => {
  let calls = 0;
  const invalid = createTinderDashboardDispatchHandler({
    async reserveApprovedSend() { calls += 1; return safeIntent(); }
  });
  const invalidRes = responseRecorder();
  await invalid({ params: { draftId: "latest" }, body: { action: "DISPATCH" } }, invalidRes);
  assert.equal(invalidRes.statusCode, 400);
  assert.equal(calls, 0);

  const unavailable = createTinderDashboardApproveHandler({
    async approveDraft() {
      const error = new Error("relation tinder_reply_send_approvals does not exist");
      error.code = "42P01";
      throw error;
    }
  });
  const unavailableRes = responseRecorder();
  await unavailable({ params: { draftId: DRAFT_ID }, body: { action: "APPROVE" } }, unavailableRes);
  assert.equal(unavailableRes.statusCode, 503);
  assert.deepEqual(unavailableRes.body, {
    ok: false,
    code: "TINDER_SEND_FOUNDATION_NOT_READY",
    error: "Tinder Send Foundation ist noch nicht migriert."
  });
});

test("T5 route registration puts dashboard authentication and existing readiness guards before every action", async () => {
  const routes = [];
  const service = {
    async approveDraft() { throw new Error("must not run"); },
    async reserveApprovedSend() { throw new Error("must not run"); },
    async rejectDraft() { throw new Error("must not run"); },
    async cancelApprovedSend() { throw new Error("must not run"); }
  };
  registerTinderManualSendRoutes({
    app: { post(path, handler) { routes.push({ path, handler }); } },
    dashboardApiReady: () => true,
    dashboardApiAuthorized: () => false,
    requireDeviceBridgeReady: () => true,
    service
  });
  assert.deepEqual(routes.map(route => route.path), [
    "/dashboard-api/tinder/drafts/:draftId/approval",
    "/dashboard-api/tinder/drafts/:draftId/dispatch",
    "/dashboard-api/tinder/drafts/:draftId/reject",
    "/dashboard-api/tinder/drafts/:draftId/cancel"
  ]);
  const unauthorized = responseRecorder();
  await routes[0].handler({ params: { draftId: DRAFT_ID }, body: { action: "APPROVE" } }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);

  const blockedRoutes = [];
  registerTinderManualSendRoutes({
    app: { post(path, handler) { blockedRoutes.push({ path, handler }); } },
    dashboardApiReady: () => true,
    dashboardApiAuthorized: () => true,
    requireDeviceBridgeReady: (res) => {
      res.status(503).json({ ok: false, code: "BACKEND_NOT_READY" });
      return false;
    },
    service
  });
  const notReady = responseRecorder();
  await blockedRoutes[1].handler({ params: { draftId: DRAFT_ID }, body: { action: "DISPATCH" } }, notReady);
  assert.equal(notReady.statusCode, 503);
});

test("T5 route/index wiring stays modular, dashboard-only, and has no live Tinder/device command path", () => {
  const routes = readFileSync(new URL("../device-bridge/tinder-manual-send-routes.js", import.meta.url), "utf8");
  const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(routes, /\/dashboard-api\/tinder\/drafts\/:draftId\/approval/);
  assert.match(routes, /\/dashboard-api\/tinder\/drafts\/:draftId\/dispatch/);
  assert.doesNotMatch(routes, /device-bridge\/v1\/devices/);
  assert.doesNotMatch(routes, /createAdminCommandHandler|TINDER_RAILWAY_BACKEND_URL|playwright|chromium|accessibility|swipe|private API|token|login/i);
  assert.match(index, /import \{ registerTinderManualSendRoutes \} from "\.\/device-bridge\/tinder-manual-send-routes\.js"/);
  assert.match(index, /createPgTinderManualSendRepository/);
  assert.match(index, /createTinderManualSendService/);
  const wiringStart = index.indexOf("const tinderManualSendService = createTinderManualSendService({");
  const wiringEnd = index.indexOf("DASHBOARD KONTAKT-STAMMDATEN", wiringStart);
  assert.ok(wiringStart >= 0 && wiringEnd > wiringStart);
  const wiring = index.slice(wiringStart, wiringEnd);
  assert.match(wiring, /registerTinderManualSendRoutes/);
  assert.doesNotMatch(wiring, /pool\.query|device-bridge\/v1|fetch\(|playwright|chromium|accessibility|whatsapp_jid/i);
});
