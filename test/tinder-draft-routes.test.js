import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertEmptyDraftRequestBody,
  createTinderDashboardDraftHandler,
  registerTinderDraftRoutes
} from "../device-bridge/tinder-draft-routes.js";

const CAPTURE_ID = "6c7308cf-5d40-423d-913b-c4424f0e4ee0";

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

test("T4 draft route sends only the path capture id into the draft service", async () => {
  let received;
  const handler = createTinderDashboardDraftHandler({
    async createDraft(input) {
      received = input;
      return {
        draftId: "4d0b6b43-6a5a-4a06-a2d6-d5f2b60b4a2d",
        captureId: input.captureId,
        status: "DRAFT",
        contactId: 7,
        runtimeThreadFingerprint: "a".repeat(64),
        captureRevision: 3,
        identityRevision: 2,
        originalDraft: "Hallo, schön von dir zu hören.",
        controlDraftDe: "Hallo, schön von dir zu hören.",
        sourceLanguage: "de",
        modelVersion: "shared-reply-core-v1",
        createdAt: "2026-09-04T18:02:00.000Z",
        visibleMessages: [{ text: "raw private capture text" }]
      };
    }
  });
  const res = responseRecorder();
  await handler({ params: { captureId: CAPTURE_ID } }, res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(received, { captureId: CAPTURE_ID });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.draft.capture_id, CAPTURE_ID);
  assert.equal(res.body.draft.original_draft, "Hallo, schön von dir zu hören.");
  assert.equal(Object.hasOwn(res.body.draft, "runtime_thread_fingerprint"), false);
  assert.equal(JSON.stringify(res.body).includes("raw private capture text"), false);
});

test("T4 draft route rejects all browser-owned draft context", async () => {
  let calls = 0;
  const handler = createTinderDashboardDraftHandler({
    async createDraft() { calls += 1; return {}; }
  });

  for (const body of [
    { contact_id: 7 },
    { incoming_text: "fake" },
    { mapping_status: "RESOLVED" },
    { tinder_state: "CONNECTED" },
    { extra_instructions: "override" },
    []
  ]) {
    const res = responseRecorder();
    await handler({ params: { captureId: CAPTURE_ID }, body }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, "INVALID_TINDER_DRAFT_REQUEST");
  }
  assert.equal(calls, 0);
  assert.doesNotThrow(() => assertEmptyDraftRequestBody(undefined));
  assert.doesNotThrow(() => assertEmptyDraftRequestBody({}));
});

test("T4 draft route rejects an invalid capture id before draft creation", async () => {
  let calls = 0;
  const handler = createTinderDashboardDraftHandler({
    async createDraft() { calls += 1; return {}; }
  });
  const res = responseRecorder();
  await handler({ params: { captureId: "latest" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "INVALID_CAPTURE_ID");
  assert.equal(calls, 0);
});

test("T4 draft route fails closed with controlled 503 while T3 or T4 schema is absent", async () => {
  const handler = createTinderDashboardDraftHandler({
    async createDraft() {
      const error = new Error("relation tinder_reply_drafts does not exist");
      error.code = "42P01";
      throw error;
    }
  });
  const res = responseRecorder();
  await handler({ params: { captureId: CAPTURE_ID } }, res);

  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, {
    ok: false,
    code: "TINDER_DRAFT_FOUNDATION_NOT_READY",
    error: "Tinder Draft Foundation ist noch nicht migriert."
  });
});

test("T4 draft route retains an explicit fail-closed eligibility outcome", async () => {
  const handler = createTinderDashboardDraftHandler({
    async createDraft() {
      const error = new Error("Tinder Gate ist nicht verbunden.");
      error.code = "TINDER_GATE_NOT_CONNECTED";
      error.statusCode = 409;
      throw error;
    }
  });
  const res = responseRecorder();
  await handler({ params: { captureId: CAPTURE_ID } }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, "TINDER_GATE_NOT_CONNECTED");
  assert.equal(res.body.ok, false);
});

test("T4 route registration keeps dashboard authorization and device-bridge readiness ahead of draft creation", async () => {
  let route;
  const app = { post(path, handler) { route = { path, handler }; } };
  let created = 0;
  registerTinderDraftRoutes({
    app,
    dashboardApiReady: () => true,
    dashboardApiAuthorized: () => false,
    requireDeviceBridgeReady: () => true,
    draftService: { async createDraft() { created += 1; return {}; } }
  });
  assert.equal(route.path, "/dashboard-api/tinder/captures/:captureId/drafts");
  const unauthorized = responseRecorder();
  await route.handler({ params: { captureId: CAPTURE_ID } }, unauthorized);
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(created, 0);

  let notReadyRoute;
  registerTinderDraftRoutes({
    app: { post(path, handler) { notReadyRoute = { path, handler }; } },
    dashboardApiReady: () => true,
    dashboardApiAuthorized: () => true,
    requireDeviceBridgeReady: (res) => {
      res.status(503).json({ ok: false, code: "BACKEND_NOT_READY" });
      return false;
    },
    draftService: { async createDraft() { created += 1; return {}; } }
  });
  const notReady = responseRecorder();
  await notReadyRoute.handler({ params: { captureId: CAPTURE_ID } }, notReady);
  assert.equal(notReady.statusCode, 503);
  assert.equal(created, 0);
});

test("T4 route module remains dashboard-only and does not introduce Tinder live access", () => {
  const source = readFileSync(new URL("../device-bridge/tinder-draft-routes.js", import.meta.url), "utf8");
  assert.match(source, /\/dashboard-api\/tinder\/captures\/:captureId\/drafts/);
  assert.doesNotMatch(source, /device-bridge\/v1\/devices/);
  assert.doesNotMatch(source, /TINDER_RAILWAY_BACKEND_URL/);
  assert.doesNotMatch(source, /playwright|chromium|accessibility|swipe|sendMessage/i);
});

test("index.js keeps T4 as service injection and route registration only", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.match(source, /import \{ registerTinderDraftRoutes \} from "\.\/device-bridge\/tinder-draft-routes\.js"/);
  assert.match(source, /import \{[\s\S]*createPgTinderDraftRepository,[\s\S]*createTinderDraftFoundationService[\s\S]*\} from "\.\/services\/tinder-draft-foundation\.js"/);

  const wiringStart = source.indexOf("const tinderDraftService = createTinderDraftFoundationService({");
  const wiringEnd = source.indexOf("DASHBOARD KONTAKT-STAMMDATEN", wiringStart);
  assert.ok(wiringStart >= 0);
  assert.ok(wiringEnd > wiringStart);
  const wiring = source.slice(wiringStart, wiringEnd);
  for (const helper of [
    "getContactById",
    "getContactMemoryProfile",
    "getRelevantMemoryItems",
    "getRelevantMemoryEvents",
    "getMarcelMemory",
    "getMarcelLiveState",
    "buildMemoryContext",
    "resolveReplyLanguage",
    "generateSharedReply"
  ]) {
    assert.match(wiring, new RegExp(`\\b${helper}\\b`));
  }
  assert.match(wiring, /registerTinderDraftRoutes/);
  assert.doesNotMatch(wiring, /pool\.query|openai\.responses|whatsapp_jid|TINDER_RAILWAY_BACKEND_URL|playwright|chromium/i);
});
