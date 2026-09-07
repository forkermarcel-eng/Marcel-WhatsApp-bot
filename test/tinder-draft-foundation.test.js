import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { T1_DEVICE_CAPABILITIES } from "../device-bridge/protocol-v1.js";
import {
  TINDER_DRAFT_STALE_REASON,
  TINDER_DRAFT_STATUS,
  TinderDraftEligibilityError,
  createPgTinderDraftRepository,
  createTinderDraftFoundationService,
  normalizeStaleRequest
} from "../services/tinder-draft-foundation.js";

const CAPTURE_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const DRAFT_ID = "6c7308cf-5d40-423d-913b-c4424f0e4ee0";
const THREAD_A = "a".repeat(64);
const THREAD_B = "b".repeat(64);

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function readyCapture(overrides = {}) {
  return {
    capture_id: CAPTURE_ID,
    device_id: DEVICE_ID,
    capture_safety_status: "SAFE",
    mapping_status: "RESOLVED",
    human_review_status: "CONFIRMED",
    resolved_contact_id: 7,
    runtime_thread_fingerprint: THREAD_A,
    capture_revision: 2,
    latest_capture_revision: 2,
    identity_revision: 4,
    visible_messages: [
      { visible_order: 1, direction: "INCOMING", text: "Hola Marcel" },
      { visible_order: 2, direction: "OUTGOING", text: "Hola Sandry" },
      { visible_order: 3, direction: "INCOMING", text: "¿Cómo estás?" }
    ],
    device_enrollment_state: "ACTIVE",
    bridge_service_state: "RUNNING",
    tinder_state: "CONNECTED",
    automation_state: "STOPPED",
    device_capabilities: [...T1_DEVICE_CAPABILITIES],
    human_takeover_active: false,
    handoff_active: false,
    ...overrides
  };
}

function centralContact(overrides = {}) {
  return {
    id: 7,
    canonical_name: "Sandry",
    display_name: "Sandry",
    primary_language: "es",
    country: "ES",
    memory_identity_key: "contact_7",
    whatsapp_jid: "must-not-reach-t4@example.invalid",
    ...overrides
  };
}

function fixtureRepository({
  capture = readyCapture(),
  captureForUpdate = capture,
  drafts = []
} = {}) {
  const state = {
    capture: copy(capture),
    captureForUpdate: copy(captureForUpdate),
    drafts: copy(drafts),
    staleRequests: [],
    insertCalls: []
  };
  const currentDraft = (captureId, captureRevision, identityRevision) => state.drafts
    .filter((draft) =>
      String(draft.captureId ?? draft.capture_id) === captureId &&
      Number(draft.captureRevision ?? draft.capture_revision) === captureRevision &&
      Number(draft.identityRevision ?? draft.identity_revision) === identityRevision &&
      [
        TINDER_DRAFT_STATUS.DRAFT,
        TINDER_DRAFT_STATUS.APPROVED,
        TINDER_DRAFT_STATUS.REJECTED
      ].includes(String(draft.status).toUpperCase())
    )
    .sort((left, right) => {
      const leftPriority = String(left.status).toUpperCase() === TINDER_DRAFT_STATUS.DRAFT ? 0 : 1;
      const rightPriority = String(right.status).toUpperCase() === TINDER_DRAFT_STATUS.DRAFT ? 0 : 1;
      return leftPriority - rightPriority;
    })[0];
  const repository = {
    state,
    async getCapture(captureId) {
      return captureId === CAPTURE_ID ? copy(state.capture) : null;
    },
    async findCurrentDraft(captureId, captureRevision, identityRevision) {
      const draft = currentDraft(captureId, captureRevision, identityRevision);
      return draft ? copy(draft) : null;
    },
    async withTransaction(work) {
      return work(repository);
    },
    async getCaptureForUpdate(_transaction, captureId) {
      return captureId === CAPTURE_ID ? copy(state.captureForUpdate) : null;
    },
    async findCurrentDraftForUpdate(_transaction, captureId, captureRevision, identityRevision) {
      const draft = currentDraft(captureId, captureRevision, identityRevision);
      return draft ? copy(draft) : null;
    },
    async insertDraft(_transaction, record) {
      state.insertCalls.push(copy(record));
      state.drafts.push(copy(record));
      return copy(record);
    },
    async markDraftsStale(_transaction, request) {
      state.staleRequests.push(copy(request));
      let staleCount = 0;
      for (const draft of state.drafts) {
        if (draft.status !== TINDER_DRAFT_STATUS.DRAFT) continue;
        if (request.captureId && draft.captureId !== request.captureId) continue;
        if (request.contactId !== null && draft.contactId !== request.contactId) continue;
        if (request.reason === TINDER_DRAFT_STALE_REASON.THREAD_CHANGED) {
          if (draft.runtimeThreadFingerprint === request.runtimeThreadFingerprint) continue;
        } else if (request.runtimeThreadFingerprint && draft.runtimeThreadFingerprint !== request.runtimeThreadFingerprint) {
          continue;
        }
        if (request.newerCaptureRevision !== null && draft.captureRevision >= request.newerCaptureRevision) continue;
        draft.status = TINDER_DRAFT_STATUS.STALE;
        draft.staleReason = request.reason;
        staleCount += 1;
      }
      return staleCount;
    }
  };
  return repository;
}

function fixtureService({
  repository = fixtureRepository(),
  contact = centralContact(),
  language = "de",
  draft = "Das klingt schön.",
  getContactById = async () => copy(contact)
} = {}) {
  const state = {
    getContactIds: [],
    profileIds: [],
    memoryItemIds: [],
    memoryEventIds: [],
    marcelMemoryCalls: 0,
    liveStateCalls: 0,
    buildContexts: [],
    languageCalls: [],
    sharedReplyCalls: []
  };
  const service = createTinderDraftFoundationService({
    repository,
    async getContactById(contactId) {
      state.getContactIds.push(contactId);
      return getContactById(contactId);
    },
    async getContactMemoryProfile(contactId) {
      state.profileIds.push(contactId);
      return { profile_summary: { likes: "Kaffee" } };
    },
    async getRelevantMemoryItems(contactId) {
      state.memoryItemIds.push(contactId);
      return [{ id: 1, memory_key: "language", memory_value: "Spanish" }];
    },
    async getRelevantMemoryEvents(contactId) {
      state.memoryEventIds.push(contactId);
      return [{ id: 2, event_type: "meeting" }];
    },
    async getMarcelMemory() {
      state.marcelMemoryCalls += 1;
      return [{ memory_key: "children", memory_value: 2 }];
    },
    async getMarcelLiveState() {
      state.liveStateCalls += 1;
      return { mood: "calm" };
    },
    async buildMemoryContext(input) {
      state.buildContexts.push(copy(input));
      return "existing central memory context";
    },
    async resolveReplyLanguage(contactInput, jid, incomingText) {
      state.languageCalls.push({ contact: copy(contactInput), jid, incomingText });
      return language;
    },
    async generateSharedReply(input) {
      state.sharedReplyCalls.push(copy(input));
      return draft;
    },
    createDraftId: () => DRAFT_ID,
    now: () => new Date("2026-09-04T19:00:00.000Z"),
    modelVersion: "shared-reply-core-v1"
  });
  return { service, state, repository };
}

test("an eligible resolved central identity creates exactly one Tinder DRAFT through the existing shared core", async () => {
  const { service, state, repository } = fixtureService();
  const result = await service.createDraft({ captureId: CAPTURE_ID });

  assert.deepEqual(result, {
    draftId: DRAFT_ID,
    channel: "tinder",
    status: "DRAFT",
    contactId: 7,
    captureId: CAPTURE_ID,
    runtimeThreadFingerprint: THREAD_A,
    captureRevision: 2,
    identityRevision: 4,
    originalDraft: "Das klingt schön.",
    controlDraftDe: "Das klingt schön.",
    sourceLanguage: "de",
    modelVersion: "shared-reply-core-v1",
    createdAt: "2026-09-04T19:00:00.000Z"
  });
  assert.deepEqual(state.profileIds, [7]);
  assert.deepEqual(state.memoryItemIds, [7]);
  assert.deepEqual(state.memoryEventIds, [7]);
  assert.equal(state.marcelMemoryCalls, 1);
  assert.equal(state.liveStateCalls, 1);
  assert.equal(state.sharedReplyCalls.length, 1);
  assert.equal(state.sharedReplyCalls[0].channelLabel, "Tinder");
  assert.equal(state.sharedReplyCalls[0].incomingText, "¿Cómo estás?");
  assert.equal(
    state.sharedReplyCalls[0].conversation,
    "Andere Person: Hola Marcel\nMarcel: Hola Sandry"
  );
  assert.equal(state.sharedReplyCalls[0].conversation.includes(state.sharedReplyCalls[0].incomingText), false);
  assert.equal(state.sharedReplyCalls[0].memoryContext, "existing central memory context");
  assert.equal(state.languageCalls[0].jid, null);
  assert.equal(Object.hasOwn(state.buildContexts[0].contact, "whatsapp_jid"), false);
  assert.equal(Object.hasOwn(state.languageCalls[0].contact, "whatsapp_jid"), false);
  assert.equal(repository.state.insertCalls.length, 1);
  assert.equal(repository.state.insertCalls[0].status, "DRAFT");
  assert.equal(repository.state.staleRequests[0].reason, "NEWER_CAPTURE_REVISION");
  assert.equal(repository.state.staleRequests[0].newerCaptureRevision, 2);
});

test("T4 excludes only the terminal row from history even when a real earlier message has identical text", async () => {
  const repeatedText = "Das ist dieselbe sichtbare Formulierung.";
  const repository = fixtureRepository({
    capture: readyCapture({
      visible_messages: [
        { visible_order: 1, direction: "INCOMING", text: repeatedText },
        { visible_order: 2, direction: "OUTGOING", text: "Verstanden." },
        { visible_order: 3, direction: "INCOMING", text: repeatedText }
      ]
    })
  });
  const { service, state } = fixtureService({ repository });

  await service.createDraft({ captureId: CAPTURE_ID });

  assert.equal(state.sharedReplyCalls.length, 1);
  assert.equal(state.sharedReplyCalls[0].incomingText, repeatedText);
  assert.equal(
    state.sharedReplyCalls[0].conversation,
    `Andere Person: ${repeatedText}\nMarcel: Verstanden.`
  );
  assert.equal(
    state.sharedReplyCalls[0].conversation.split(repeatedText).length - 1,
    1,
    "the genuine earlier row remains while the terminal row is excluded by position"
  );
  assert.deepEqual(
    Object.keys(state.sharedReplyCalls[0]).sort(),
    ["channelLabel", "conversation", "incomingText", "memoryContext", "resolvedLanguage"],
    "capture, permit, identity, and diagnostic metadata never reach the shared core"
  );
});

test("a current capture and revision return the existing DRAFT without a second shared-core call", async () => {
  const { service, state, repository } = fixtureService();
  const first = await service.createDraft({ captureId: CAPTURE_ID });
  const repeated = await service.createDraft({ captureId: CAPTURE_ID });

  assert.deepEqual(repeated, first);
  assert.equal(state.sharedReplyCalls.length, 1);
  assert.equal(repository.state.insertCalls.length, 1);
  assert.equal(repository.state.staleRequests.length, 1);
});

test("a terminal human decision blocks a second draft for the unchanged capture snapshot before shared-core generation", async () => {
  for (const status of [TINDER_DRAFT_STATUS.APPROVED, TINDER_DRAFT_STATUS.REJECTED]) {
    const repository = fixtureRepository({
      drafts: [{
        draftId: DRAFT_ID,
        contactId: 7,
        captureId: CAPTURE_ID,
        runtimeThreadFingerprint: THREAD_A,
        captureRevision: 2,
        identityRevision: 4,
        status
      }]
    });
    const { service, state } = fixtureService({ repository });

    await assert.rejects(
      () => service.createDraft({ captureId: CAPTURE_ID }),
      (error) => error instanceof TinderDraftEligibilityError && error.code === "DRAFT_ALREADY_FINALIZED",
      status
    );
    assert.equal(state.sharedReplyCalls.length, 0, status);
    assert.equal(repository.state.insertCalls.length, 0, status);
    assert.equal(repository.state.staleRequests.length, 0, status);
  }
});

test("a terminal human decision made while the core is generating prevents persistence for that snapshot", async () => {
  const repository = fixtureRepository();
  repository.findCurrentDraft = async () => null;
  repository.findCurrentDraftForUpdate = async () => ({ status: TINDER_DRAFT_STATUS.APPROVED });
  const { service, state } = fixtureService({ repository });

  await assert.rejects(
    () => service.createDraft({ captureId: CAPTURE_ID }),
    (error) => error instanceof TinderDraftEligibilityError && error.code === "DRAFT_ALREADY_FINALIZED"
  );
  assert.equal(state.sharedReplyCalls.length, 1);
  assert.equal(repository.state.insertCalls.length, 0);
  assert.equal(repository.state.staleRequests.length, 0);
});

test("a PostgreSQL-shaped current DRAFT retains its thread fingerprint when reused", async () => {
  const repository = fixtureRepository({
    drafts: [{
      draft_id: DRAFT_ID,
      contact_id: 7,
      capture_id: CAPTURE_ID,
      runtime_thread_fingerprint: THREAD_A,
      capture_revision: 2,
      identity_revision: 4,
      status: "DRAFT",
      original_draft: "Bereits gespeicherter Entwurf.",
      control_draft_de: "Bereits gespeicherter Entwurf.",
      source_language: "de",
      model_version: "shared-reply-core-v1",
      created_at: "2026-09-04T19:00:00.000Z"
    }]
  });
  const { service, state } = fixtureService({ repository });

  const result = await service.createDraft({ captureId: CAPTURE_ID });

  assert.equal(result.runtimeThreadFingerprint, THREAD_A);
  assert.equal(result.originalDraft, "Bereits gespeicherter Entwurf.");
  assert.equal(state.sharedReplyCalls.length, 0);
  assert.equal(repository.state.insertCalls.length, 0);
});

test("a DRAFT discovered after the capture lock prevents concurrent duplicate persistence", async () => {
  const { service, state, repository } = fixtureService();
  const concurrent = {
    draftId: DRAFT_ID,
    contactId: 7,
    captureId: CAPTURE_ID,
    runtimeThreadFingerprint: THREAD_A,
    captureRevision: 2,
    identityRevision: 4,
    status: "DRAFT",
    originalDraft: "Bereits vorhandener Entwurf.",
    controlDraftDe: "Bereits vorhandener Entwurf.",
    sourceLanguage: "de",
    modelVersion: "shared-reply-core-v1",
    createdAt: "2026-09-04T19:00:00.000Z"
  };
  repository.findCurrentDraft = async () => null;
  repository.findCurrentDraftForUpdate = async () => copy(concurrent);

  const result = await service.createDraft({ captureId: CAPTURE_ID });

  assert.equal(result.draftId, DRAFT_ID);
  assert.equal(result.originalDraft, "Bereits vorhandener Entwurf.");
  assert.equal(state.sharedReplyCalls.length, 1);
  assert.equal(repository.state.insertCalls.length, 0);
  assert.equal(repository.state.staleRequests.length, 0);
});

test("the German control draft is null without a German source language and no translation call is added", async () => {
  const { service, state } = fixtureService({ language: "es", draft: "Estoy bien, gracias." });
  const result = await service.createDraft({ captureId: CAPTURE_ID });

  assert.equal(result.sourceLanguage, "es");
  assert.equal(result.controlDraftDe, null);
  assert.equal(state.sharedReplyCalls.length, 1);
});

test("T4 only drafts from a terminal INCOMING message and blocks terminal OUTGOING or UNKNOWN before shared reply", async () => {
  const eligible = fixtureService();
  await eligible.service.createDraft({ captureId: CAPTURE_ID });
  assert.equal(eligible.state.sharedReplyCalls.length, 1);
  assert.equal(eligible.repository.state.insertCalls.length, 1);

  for (const direction of ["OUTGOING", "UNKNOWN"]) {
    const repository = fixtureRepository({
      capture: readyCapture({
        visible_messages: [
          { visible_order: 1, direction: "INCOMING", text: "Hallo Marcel" },
          { visible_order: 2, direction, text: "Terminal row" }
        ]
      })
    });
    const { service, state } = fixtureService({ repository });
    await assert.rejects(
      () => service.createDraft({ captureId: CAPTURE_ID }),
      (error) => error instanceof TinderDraftEligibilityError && error.code === "TERMINAL_MESSAGE_NOT_INCOMING"
    );
    assert.equal(state.sharedReplyCalls.length, 0, direction);
    assert.equal(repository.state.insertCalls.length, 0, direction);
  }
});

test("every unsafe capture, mapping, gate, takeover, or context blocker prevents a shared-core invocation", async () => {
  const cases = [
    ["CAPTURE_NOT_SAFE", { capture_safety_status: "UNSAFE" }],
    ["IDENTITY_NOT_RESOLVED", { mapping_status: "NEEDS_HUMAN_MAPPING" }],
    ["IDENTITY_NOT_RESOLVED", { mapping_status: "CONFLICT" }],
    ["IDENTITY_NOT_RESOLVED", { human_review_status: "PENDING" }],
    ["IDENTITY_NOT_RESOLVED", { resolved_contact_id: null }],
    ["CAPTURE_REVISION_STALE", { latest_capture_revision: 3 }],
    ["DEVICE_ENROLLMENT_INACTIVE", { device_enrollment_state: "PENDING" }],
    ["DEVICE_CAPABILITY_UNSUPPORTED", { device_capabilities: [] }],
    ["BRIDGE_NOT_RUNNING", { bridge_service_state: "STOPPED" }],
    ["TINDER_GATE_NOT_CONNECTED", { tinder_state: "DISCONNECTED" }],
    ["AUTOMATION_NOT_STOPPED", { automation_state: "RUNNING" }],
    ["HUMAN_TAKEOVER_ACTIVE", { human_takeover_active: true }],
    ["HANDOFF_ACTIVE", { handoff_active: true }],
    ["TERMINAL_MESSAGE_NOT_INCOMING", {
      visible_messages: [{ visible_order: 1, direction: "OUTGOING", text: "Only outgoing" }]
    }]
  ];

  for (const [expectedCode, overrides] of cases) {
    const repository = fixtureRepository({ capture: readyCapture(overrides) });
    const { service, state } = fixtureService({ repository });
    await assert.rejects(
      () => service.createDraft({ captureId: CAPTURE_ID }),
      (error) => error instanceof TinderDraftEligibilityError && error.code === expectedCode
    );
    assert.equal(state.sharedReplyCalls.length, 0, expectedCode);
    assert.equal(repository.state.insertCalls.length, 0, expectedCode);
  }
});

test("the T4 capability gate reuses the exact canonical T1 profile and rejects malformed or expanded profiles", async () => {
  for (const capabilities of [
    ["TINDER_MANUAL_GATE_V1"],
    [...T1_DEVICE_CAPABILITIES, "UNKNOWN_FUTURE_CAPABILITY"],
    "not-json"
  ]) {
    const repository = fixtureRepository({
      capture: readyCapture({ device_capabilities: capabilities })
    });
    const { service, state } = fixtureService({ repository });
    await assert.rejects(
      () => service.createDraft({ captureId: CAPTURE_ID }),
      (error) => error instanceof TinderDraftEligibilityError && error.code === "DEVICE_CAPABILITY_UNSUPPORTED"
    );
    assert.equal(state.sharedReplyCalls.length, 0);
  }
});

test("a capture or central contact changing during generation never persists a draft", async () => {
  const changed = readyCapture({ capture_revision: 3, latest_capture_revision: 3 });
  const repository = fixtureRepository({ capture: readyCapture(), captureForUpdate: changed });
  const { service, state } = fixtureService({ repository });

  await assert.rejects(
    () => service.createDraft({ captureId: CAPTURE_ID }),
    (error) => error instanceof TinderDraftEligibilityError && error.code === "CAPTURE_CHANGED_DURING_DRAFT"
  );
  assert.equal(state.sharedReplyCalls.length, 1);
  assert.equal(repository.state.insertCalls.length, 0);
});

test("explicit stale requests only transition DRAFT rows for newer revisions, thread changes, and identity changes", async () => {
  const repository = fixtureRepository({
    drafts: [
      { draftId: DRAFT_ID, captureId: CAPTURE_ID, contactId: 7, runtimeThreadFingerprint: THREAD_A, captureRevision: 1, status: "DRAFT" },
      { draftId: "c1d476e1-a5ec-4d65-b0db-c8b029e36cc5", captureId: CAPTURE_ID, contactId: 7, runtimeThreadFingerprint: THREAD_A, captureRevision: 2, status: "APPROVED" },
      { draftId: "f3dd4498-1c29-48d2-b953-6c8668dc8fcf", captureId: "9b2cfc26-586d-4ca8-8b99-b4833d70f7fa", contactId: 7, runtimeThreadFingerprint: THREAD_A, captureRevision: 2, status: "DRAFT" },
      { draftId: "8e451fcf-397c-4c9b-8f44-b262f4e1ea1f", captureId: "8beaeb66-2d4c-43c1-8d86-80ef46445e77", contactId: 7, runtimeThreadFingerprint: THREAD_B, captureRevision: 1, status: "DRAFT" }
    ]
  });
  const { service } = fixtureService({ repository });

  const newer = await service.markDraftsStale({
    reason: "NEWER_CAPTURE_REVISION",
    contactId: 7,
    runtimeThreadFingerprint: THREAD_A,
    newerCaptureRevision: 2
  });
  assert.deepEqual(newer, { reason: "NEWER_CAPTURE_REVISION", staleCount: 1 });
  assert.equal(repository.state.drafts[0].status, "STALE");
  assert.equal(repository.state.drafts[1].status, "APPROVED");
  assert.equal(repository.state.drafts[2].status, "DRAFT");

  const threadChanged = await service.markDraftsStale({
    reason: "THREAD_CHANGED",
    contactId: 7,
    runtimeThreadFingerprint: THREAD_B
  });
  assert.deepEqual(threadChanged, { reason: "THREAD_CHANGED", staleCount: 1 });
  assert.equal(repository.state.drafts[2].status, "STALE");
  assert.equal(repository.state.drafts[3].status, "DRAFT");

  const identityChanged = await service.markDraftsStale({
    reason: "IDENTITY_MAPPING_CHANGED",
    captureId: "8beaeb66-2d4c-43c1-8d86-80ef46445e77"
  });
  assert.deepEqual(identityChanged, { reason: "IDENTITY_MAPPING_CHANGED", staleCount: 1 });
  assert.equal(repository.state.drafts[3].status, "STALE");
  assert.throws(
    () => normalizeStaleRequest({ reason: "GATE_CLOSED" }),
    (error) => error instanceof TinderDraftEligibilityError && error.code === "STALE_TARGET_REQUIRED"
  );
});

test("the PostgreSQL stale query has distinct typed placeholders for equality and thread-change filters", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      return { rows: [{ stale_count: 1 }] };
    },
    release() {}
  };
  const repository = createPgTinderDraftRepository({
    async query() { return { rows: [] }; },
    async connect() { return client; }
  });

  const result = await repository.markDraftsStale(client, {
    reason: "THREAD_CHANGED",
    actor: "system",
    captureId: null,
    contactId: 7,
    runtimeThreadFingerprint: THREAD_B,
    newerCaptureRevision: null,
    deviceId: null
  });
  assert.equal(result, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].values.length, 9);
  assert.equal(calls[0].values[5], THREAD_B);
  assert.match(calls[0].sql, /\$6::char\(64\) IS NULL OR draft\.runtime_thread_fingerprint <> \$6::char\(64\)/);
  assert.doesNotMatch(calls[0].sql, /\$6::boolean/);
  assert.match(calls[0].sql, /stale_reason = \$7/);
  assert.match(calls[0].sql, /'DRAFT_STALE', \$8/);
  assert.match(calls[0].sql, /\$9::jsonb/);
});

test("the PostgreSQL current-snapshot lookup is scoped to the capture and both revisions, with a locked recheck", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      return { rows: [] };
    },
    release() {}
  };
  const repository = createPgTinderDraftRepository({
    async query(sql, values = []) {
      calls.push({ sql, values });
      return { rows: [] };
    },
    async connect() { return client; }
  });

  await repository.findCurrentDraft(CAPTURE_ID, 2, 4);
  await repository.findCurrentDraftForUpdate(client, CAPTURE_ID, 2, 4);

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call.values, [CAPTURE_ID, 2, 4]);
    assert.match(call.sql, /WHERE capture_id = \$1/);
    assert.match(call.sql, /runtime_thread_fingerprint/);
    assert.match(call.sql, /capture_revision = \$2/);
    assert.match(call.sql, /identity_revision = \$3/);
    assert.match(call.sql, /status IN \('DRAFT', 'APPROVED', 'REJECTED'\)/);
    assert.match(call.sql, /CASE status WHEN 'DRAFT' THEN 0 ELSE 1 END/);
  }
  assert.doesNotMatch(calls[0].sql, /FOR UPDATE/);
  assert.match(calls[1].sql, /FOR UPDATE\s*$/);
});

test("the standalone T4 migration binds revisions, draft status, audit, and no runtime initializer", () => {
  const migration = readFileSync(
    new URL("../migrations/20260904_tinder_draft_foundation.sql", import.meta.url),
    "utf8"
  );
  assert.match(migration, /PREPARATION ONLY/);
  assert.doesNotMatch(migration, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/im);
  assert.match(migration, /identity_revision INTEGER NOT NULL DEFAULT 1/i);
  assert.match(migration, /human_takeover_active BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(migration, /handoff_active BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(migration, /CREATE TRIGGER t4_tinder_capture_identity_revision/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tinder_reply_drafts/i);
  assert.match(migration, /status IN \('DRAFT', 'APPROVED', 'REJECTED', 'STALE'\)/i);
  assert.match(migration, /capture_revision INTEGER NOT NULL/i);
  assert.match(migration, /identity_revision INTEGER NOT NULL/i);
  assert.match(migration, /control_draft_de TEXT/i);
  assert.match(migration, /control_draft_de IS NULL\s+OR COALESCE\(/i);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tinder_reply_draft_audit/i);
  assert.match(migration, /DRAFT_CREATED/, "audit records draft creation");
  assert.match(migration, /DRAFT_STALE/, "audit records stale transitions");
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+messages/i);
  assert.doesNotMatch(migration, /@memory\.local/i);

  const runtimeSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.doesNotMatch(runtimeSource, /20260904_tinder_draft_foundation\.sql/);
  assert.doesNotMatch(runtimeSource, /tinder_reply_drafts[\s\S]{0,120}CREATE TABLE/i);
});

test("the T4 core is channel-neutral and never imports a second reply engine or conversation history", () => {
  const source = readFileSync(
    new URL("../services/tinder-draft-foundation.js", import.meta.url),
    "utf8"
  );
  assert.match(source, /generateSharedReply/);
  assert.match(source, /isTinderManualGateCapable/);
  assert.match(source, /channelLabel: "Tinder"/);
  assert.match(source, /resolveReplyLanguage\(initial\.contact, null, incoming\.text\)/);
  assert.doesNotMatch(source, /generateAIReply/);
  assert.doesNotMatch(source, /getConversationHistory/);
  assert.doesNotMatch(source, /whatsapp_jid/);
  assert.doesNotMatch(source, /INSERT\s+INTO\s+messages/i);
  assert.doesNotMatch(source, /sendMessage|sendTinder|accessibility|swipe|private API|token|login/i);
  assert.doesNotMatch(source, /device-bridge\/v1\/devices/);
});
