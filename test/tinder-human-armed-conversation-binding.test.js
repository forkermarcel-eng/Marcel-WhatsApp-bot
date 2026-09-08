import assert from "node:assert/strict";
import test from "node:test";
import {
  HUMAN_ARMED_CONVERSATION_COMMAND_TYPE,
  HUMAN_ARMED_CONVERSATION_PERMIT_TTL_MS,
  HUMAN_ARMED_CONVERSATION_REASON,
  HUMAN_ARMED_CONVERSATION_REFERENCE_KIND,
  HUMAN_ARMED_CONVERSATION_STATUS,
  TinderHumanArmedConversationBindingError,
  createPgTinderHumanArmedConversationBindingRepository,
  createTinderHumanArmedConversationBindingService
} from "../services/tinder-human-armed-conversation-binding.js";
import { T2_DEVICE_CAPABILITIES } from "../device-bridge/protocol-v1.js";

const DEVICE_ID = "36761d7f-2ac3-4da9-9ad4-7fd381665f1e";
const OTHER_DEVICE_ID = "46761d7f-2ac3-4da9-9ad4-7fd381665f1e";
const CAPTURE_A = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const CAPTURE_B = "b565e8a7-ef60-42d0-b19d-26e7904390fa";
const BINDING_ID = "c565e8a7-ef60-42d0-b19d-26e7904390fa";
const PERMIT_ID = "d565e8a7-ef60-42d0-b19d-26e7904390fa";
const NOW = new Date("2026-09-07T12:00:00.000Z");

function capture(overrides = {}) {
  return {
    capture_id: CAPTURE_A,
    device_id: DEVICE_ID,
    capture_safety_status: "SAFE",
    mapping_status: "NEEDS_HUMAN_MAPPING",
    human_review_status: "PENDING",
    ...overrides
  };
}

function runtime(overrides = {}) {
  return {
    online: true,
    enrollment_state: "ACTIVE",
    bridge_service_state: "RUNNING",
    tinder_state: "CONNECTED",
    automation_state: "STOPPED",
    capabilities: T2_DEVICE_CAPABILITIES,
    ...overrides
  };
}

function binding(overrides = {}) {
  return {
    binding_id: BINDING_ID,
    channel: "tinder",
    reference_kind: HUMAN_ARMED_CONVERSATION_REFERENCE_KIND,
    device_id: DEVICE_ID,
    contact_id: 7,
    binding_state: "CONFIRMED",
    binding_revision: 1,
    human_verified: true,
    ...overrides
  };
}

function permit(overrides = {}) {
  return {
    command_id: PERMIT_ID,
    binding_id: BINDING_ID,
    device_id: DEVICE_ID,
    binding_revision: 1,
    permit_state: "ISSUED",
    expires_at: "2026-09-07T12:01:00.000Z",
    terminal_status: "SUCCEEDED",
    ack_status: "SUCCEEDED",
    ack_result: { conversation_binding_permit: "ARMED" },
    ...overrides
  };
}

function fixtureRepository({
  captures = [capture()],
  contacts = [7],
  runtimeByDevice = new Map([[DEVICE_ID, runtime()]]),
  bindings = [],
  permits = [],
  activeOfficialAppResume = false
} = {}) {
  const captureRows = new Map(captures.map(row => [row.capture_id, { ...row }]));
  const contactIds = new Set(contacts);
  const bindingRows = new Map(bindings.map(row => [row.binding_id, { ...row }]));
  const permitRows = new Map(permits.map(row => [row.command_id, { ...row }]));
  const state = {
    calls: [], audits: [], commands: [], createdContacts: [], permits: permitRows,
    bindings: bindingRows, transactionCalls: 0
  };
  return {
    state,
    async withTransaction(work) { state.transactionCalls += 1; return work({}); },
    async getCaptureForUpdate(_tx, captureId) { return captureRows.get(captureId) || null; },
    async getDeviceRuntimeForUpdate(_tx, deviceId) { return runtimeByDevice.get(deviceId) || null; },
    async getContactForUpdate(_tx, contactId) { return contactIds.has(contactId) ? { id: contactId } : null; },
    async createChannelContact(_tx, input) {
      state.createdContacts.push(input);
      const id = 101;
      contactIds.add(id);
      return { id };
    },
    async insertHumanArmedBinding(_tx, input) {
      state.calls.push({ type: "insert-binding", input });
      const row = {
        binding_id: input.bindingId,
        channel: input.channel,
        reference_kind: input.referenceKind,
        device_id: input.deviceId,
        contact_id: input.contactId,
        binding_state: input.bindingState,
        binding_revision: input.bindingRevision,
        human_verified: input.humanVerified
      };
      bindingRows.set(row.binding_id, row);
      return row;
    },
    async updateCaptureMapping(_tx, input) {
      state.calls.push({ type: "update-capture", input });
      const row = captureRows.get(input.captureId);
      if (row) Object.assign(row, {
        mapping_status: input.mappingStatus,
        human_review_status: input.humanReviewStatus,
        resolved_contact_id: input.resolvedContactId
      });
    },
    async createArmPermit(_tx, input) {
      state.calls.push({ type: "create-permit", input });
      permitRows.set(input.commandId, {
        command_id: input.commandId,
        binding_id: input.bindingId,
        device_id: input.deviceId,
        binding_revision: input.bindingRevision,
        permit_state: input.permitState,
        expires_at: input.expiresAt
      });
    },
    async queueArmCommand(_tx, input) {
      state.commands.push(input);
    },
    async getBindingForUpdate(_tx, bindingId) { return bindingRows.get(bindingId) || null; },
    async getArmPermitForUpdate(_tx, commandId) { return permitRows.get(commandId) || null; },
    async markArmPermitConsumed(_tx, input) {
      const row = permitRows.get(input.commandId);
      if (!row || row.permit_state !== "ISSUED") return false;
      row.permit_state = "CONSUMED";
      row.consumed_capture_id = input.captureId;
      row.consumed_at = input.consumedAt;
      return true;
    },
    async findActiveOfficialAppResumePermitForDevice(_tx, input) {
      state.calls.push({ type: "find-v5-resume", input });
      return activeOfficialAppResume;
    },
    async insertBindingAudit(_tx, audit) { state.audits.push(audit); }
  };
}

function service(repository, overrides = {}) {
  return createTinderHumanArmedConversationBindingService(repository, {
    createBindingId: () => BINDING_ID,
    createPermitId: () => PERMIT_ID,
    createReferenceHash: () => "e".repeat(64),
    createIdentityKey: () => "tinder_human_armed_contact",
    now: () => NOW,
    ...overrides
  });
}

function assertNoSensitiveValue(value) {
  const text = JSON.stringify(value);
  for (const sensitive of ["e".repeat(64), "M Tinder Test", "message text", "thread", "fingerprint", PERMIT_ID]) {
    assert.equal(text.includes(sensitive), false, `unexpected sensitive value: ${sensitive}`);
  }
}

test("initial human-confirmed existing-contact arm creates opaque binding, empty command and no profile identifier", async () => {
  const repository = fixtureRepository();
  const result = await service(repository).armInitialCapture({
    captureId: CAPTURE_A,
    action: "BIND_EXISTING",
    contactId: 7,
    confirmed: true
  });

  assert.deepEqual(result, { status: HUMAN_ARMED_CONVERSATION_STATUS.ARMED, bindingId: BINDING_ID, contactId: 7 });
  const inserted = repository.state.calls.find(call => call.type === "insert-binding").input;
  assert.deepEqual({
    bindingId: inserted.bindingId,
    channel: inserted.channel,
    referenceKind: inserted.referenceKind,
    deviceId: inserted.deviceId,
    contactId: inserted.contactId,
    sourceCaptureId: inserted.sourceCaptureId,
    bindingState: inserted.bindingState,
    bindingRevision: inserted.bindingRevision,
    humanVerified: inserted.humanVerified,
    verificationSource: inserted.verificationSource,
    verifiedBy: inserted.verifiedBy
  }, {
    bindingId: BINDING_ID,
    channel: "tinder",
    referenceKind: HUMAN_ARMED_CONVERSATION_REFERENCE_KIND,
    deviceId: DEVICE_ID,
    contactId: 7,
    sourceCaptureId: CAPTURE_A,
    bindingState: "CONFIRMED",
    bindingRevision: 1,
    humanVerified: true,
    verificationSource: "manual_dashboard",
    verifiedBy: "marcel_dashboard"
  });
  assert.match(inserted.referenceHash, /^[a-f0-9]{64}$/);
  const command = repository.state.commands[0];
  assert.deepEqual(command, {
    commandId: PERMIT_ID,
    deviceId: DEVICE_ID,
    commandType: HUMAN_ARMED_CONVERSATION_COMMAND_TYPE,
    payload: {},
    expiresAt: "2026-09-07T12:10:00.000Z"
  });
  assert.equal(Object.keys(command.payload).length, 0);
  assert.equal(repository.state.createdContacts.length, 0);
  assert.equal(repository.state.calls.some(call => JSON.stringify(call).includes("tinder_profile")), false);
  assertNoSensitiveValue({ result, audits: repository.state.audits });
});

test("initial arm can create a channel-native contact without accepting a platform identifier", async () => {
  const repository = fixtureRepository({ contacts: [] });
  const result = await service(repository).armInitialCapture({
    captureId: CAPTURE_A,
    action: "BIND_CREATE",
    newContactName: "M Tinder Test",
    confirmed: true
  });

  assert.deepEqual(result, { status: HUMAN_ARMED_CONVERSATION_STATUS.ARMED, bindingId: BINDING_ID, contactId: 101 });
  assert.deepEqual(repository.state.createdContacts, [{
    canonicalName: "M Tinder Test",
    memoryIdentityKey: "tinder_human_armed_contact",
    sourcePlatform: "tinder",
    currentPlatform: "tinder",
    identityLocked: true
  }]);
  assert.equal(repository.state.audits.some(audit => JSON.stringify(audit.details).includes("M Tinder Test")), false);
});

test("initial arm rejects client identity/reference injections before any repository write", async () => {
  const repository = fixtureRepository();
  await assert.rejects(
    () => service(repository).armInitialCapture({
      captureId: CAPTURE_A,
      action: "BIND_EXISTING",
      contactId: 7,
      confirmed: true,
      referenceHash: "e".repeat(64)
    }),
    error => error instanceof TinderHumanArmedConversationBindingError && error.code === "INVALID_INITIAL_ARM_REQUEST"
  );
  assert.equal(repository.state.calls.length, 0);
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.audits.length, 0);
});

test("initial arm remains fail-closed for unsafe/past/ungated captures without contact or command writes", async () => {
  const unsafeRepository = fixtureRepository({ captures: [capture({ capture_safety_status: "BLOCKED" })] });
  assert.deepEqual(await service(unsafeRepository).armInitialCapture({
    captureId: CAPTURE_A, action: "BIND_EXISTING", contactId: 7, confirmed: true
  }), {
    status: HUMAN_ARMED_CONVERSATION_STATUS.UNSAFE_CAPTURE,
    reasonCode: HUMAN_ARMED_CONVERSATION_REASON.CAPTURE_NOT_SAFE
  });
  assert.equal(unsafeRepository.state.commands.length, 0);

  const offlineRepository = fixtureRepository({ runtimeByDevice: new Map([[DEVICE_ID, runtime({ online: false })]]) });
  assert.deepEqual(await service(offlineRepository).armInitialCapture({
    captureId: CAPTURE_A, action: "BIND_EXISTING", contactId: 7, confirmed: true
  }), {
    status: HUMAN_ARMED_CONVERSATION_STATUS.DEVICE_NOT_READY,
    reasonCode: HUMAN_ARMED_CONVERSATION_REASON.DEVICE_OFFLINE
  });
  assert.equal(offlineRepository.state.calls.length, 0);
  assert.equal(offlineRepository.state.commands.length, 0);

  const connectedRepository = fixtureRepository({ runtimeByDevice: new Map([[DEVICE_ID, runtime({ tinder_state: "DISCONNECTED" })]]) });
  assert.deepEqual(await service(connectedRepository).armInitialCapture({
    captureId: CAPTURE_A, action: "BIND_EXISTING", contactId: 7, confirmed: true
  }), {
    status: HUMAN_ARMED_CONVERSATION_STATUS.DEVICE_NOT_READY,
    reasonCode: HUMAN_ARMED_CONVERSATION_REASON.TINDER_NOT_CONNECTED
  });
  assert.equal(connectedRepository.state.commands.length, 0);
});

test("rearm loads only a human-confirmed persisted binding and never accepts a client device or reference", async () => {
  const repository = fixtureRepository({ bindings: [binding()] });
  const result = await service(repository).rearmExistingBinding({ bindingId: BINDING_ID, confirmed: true });
  assert.deepEqual(result, { status: HUMAN_ARMED_CONVERSATION_STATUS.ARMED, bindingId: BINDING_ID, contactId: 7 });
  assert.deepEqual(repository.state.commands, [{
    commandId: PERMIT_ID,
    deviceId: DEVICE_ID,
    commandType: HUMAN_ARMED_CONVERSATION_COMMAND_TYPE,
    payload: {},
    expiresAt: "2026-09-07T12:10:00.000Z"
  }]);

  await assert.rejects(
    () => service(repository).rearmExistingBinding({ bindingId: BINDING_ID, deviceId: OTHER_DEVICE_ID, confirmed: true }),
    error => error instanceof TinderHumanArmedConversationBindingError && error.code === "INVALID_REARM_REQUEST"
  );
  assertNoSensitiveValue({ audits: repository.state.audits, result });
});

test("rearm blocks a revoked/non-human/WhatsApp binding and never queues a Tinder arm", async () => {
  for (const row of [
    binding({ binding_state: "REVOKED" }),
    binding({ human_verified: false }),
    binding({ channel: "whatsapp", reference_kind: "whatsapp_conversation_ref_hmac_v1" })
  ]) {
    const repository = fixtureRepository({ bindings: [row] });
    const result = await service(repository).rearmExistingBinding({ bindingId: BINDING_ID, confirmed: true });
    assert.equal(result.status, HUMAN_ARMED_CONVERSATION_STATUS.BINDING_NOT_READY);
    assert.equal(repository.state.commands.length, 0);
  }
});

test("V3 human-binding issuance refuses an active V4 visible-chat sync permit", async () => {
  const repository = fixtureRepository({ bindings: [binding()] });
  const calls = [];
  repository.findActiveVisibleChatSyncPermitForDevice = async (_transaction, input) => {
    calls.push(input);
    return true;
  };

  assert.deepEqual(await service(repository).rearmExistingBinding({
    bindingId: BINDING_ID,
    confirmed: true
  }), {
    status: HUMAN_ARMED_CONVERSATION_STATUS.CONFLICT,
    reasonCode: HUMAN_ARMED_CONVERSATION_REASON.VISIBLE_CHAT_SYNC_PERMIT_ACTIVE
  });
  assert.deepEqual(calls, [{
    deviceId: DEVICE_ID,
    now: NOW.toISOString()
  }]);
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.calls.some(call => call.type === "create-permit"), false);
});

test("an active V4 permit blocks an initial V3 arm before any binding-side write", async () => {
  const repository = fixtureRepository({ contacts: [] });
  const calls = [];
  repository.findActiveVisibleChatSyncPermitForDevice = async (_transaction, input) => {
    calls.push(input);
    return true;
  };

  assert.deepEqual(await service(repository).armInitialCapture({
    captureId: CAPTURE_A,
    action: "BIND_CREATE",
    newContactName: "M Tinder Test",
    confirmed: true
  }), {
    status: HUMAN_ARMED_CONVERSATION_STATUS.CONFLICT,
    reasonCode: HUMAN_ARMED_CONVERSATION_REASON.VISIBLE_CHAT_SYNC_PERMIT_ACTIVE
  });
  assert.deepEqual(calls, [{ deviceId: DEVICE_ID, now: NOW.toISOString() }]);
  assert.equal(repository.state.createdContacts.length, 0);
  assert.equal(repository.state.bindings.size, 0);
  assert.equal(repository.state.calls.length, 0);
  assert.equal(repository.state.audits.length, 0);
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.permits.size, 0);
});

test("an active ISSUED official-app resume permit blocks both V3 arm issuers before writes", async () => {
  const rearmRepository = fixtureRepository({ bindings: [binding()] });
  const rearmCalls = [];
  rearmRepository.findActiveOfficialAppResumePermitForDevice = async (_transaction, input) => {
    rearmCalls.push(input);
    return true;
  };

  assert.deepEqual(await service(rearmRepository).rearmExistingBinding({
    bindingId: BINDING_ID,
    confirmed: true
  }), {
    status: HUMAN_ARMED_CONVERSATION_STATUS.CONFLICT,
    reasonCode: HUMAN_ARMED_CONVERSATION_REASON.OFFICIAL_APP_RESUME_PERMIT_ACTIVE
  });
  assert.deepEqual(rearmCalls, [{ deviceId: DEVICE_ID, now: NOW.toISOString() }]);
  assert.equal(rearmRepository.state.commands.length, 0);
  assert.equal(rearmRepository.state.permits.size, 0);

  const initialRepository = fixtureRepository({ contacts: [] });
  initialRepository.findActiveOfficialAppResumePermitForDevice = async () => true;
  assert.deepEqual(await service(initialRepository).armInitialCapture({
    captureId: CAPTURE_A,
    action: "BIND_CREATE",
    newContactName: "M Tinder Test",
    confirmed: true
  }), {
    status: HUMAN_ARMED_CONVERSATION_STATUS.CONFLICT,
    reasonCode: HUMAN_ARMED_CONVERSATION_REASON.OFFICIAL_APP_RESUME_PERMIT_ACTIVE
  });
  assert.equal(initialRepository.state.createdContacts.length, 0);
  assert.equal(initialRepository.state.bindings.size, 0);
  assert.equal(initialRepository.state.commands.length, 0);
  assert.equal(initialRepository.state.permits.size, 0);
});

test("an indeterminate V5 resume-permit lookup fails closed before V3 writes", async () => {
  const repository = fixtureRepository({ bindings: [binding()] });
  repository.findActiveOfficialAppResumePermitForDevice = async () => undefined;

  await assert.rejects(
    () => service(repository).rearmExistingBinding({ bindingId: BINDING_ID, confirmed: true }),
    error => error instanceof TinderHumanArmedConversationBindingError
      && error.code === "INVALID_OFFICIAL_APP_RESUME_PERMIT"
  );
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.permits.size, 0);
});

test("V3 PostgreSQL resume conflict lookup recognizes only a live ISSUED permit", async () => {
  const calls = [];
  const repository = createPgTinderHumanArmedConversationBindingRepository({
    async connect() { throw new Error("not used by this focused repository query"); },
    async query() { throw new Error("not used by this focused repository query"); }
  });
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      if (sql.includes("to_regclass")) {
        return { rows: [{ relation_name: "tinder_official_app_resume_permits" }] };
      }
      return { rows: [{ active: true }] };
    }
  };

  assert.equal(await repository.findActiveOfficialAppResumePermitForDevice(client, {
    deviceId: DEVICE_ID,
    now: NOW.toISOString()
  }), true);
  assert.match(calls[0].sql, /to_regclass\('tinder_official_app_resume_permits'\)/i);
  assert.match(calls[1].sql, /permit_state='ISSUED'/i);
  assert.doesNotMatch(calls[1].sql, /DISPATCHED|STAGED|CONSUMED/i);
  assert.match(calls[1].sql, /expires_at>\$2/i);
  assert.deepEqual(calls[1].parameters, [DEVICE_ID, NOW.toISOString()]);
});

test("the fixed server-owned arm window covers the measured manual hand-off, consumes once, and expires at its exact boundary", async () => {
  let currentTime = NOW;
  const repository = fixtureRepository({ bindings: [binding()] });
  const bindingService = service(repository, { now: () => currentTime });

  await bindingService.rearmExistingBinding({ bindingId: BINDING_ID, confirmed: true });
  assert.equal(HUMAN_ARMED_CONVERSATION_PERMIT_TTL_MS, 10 * 60_000);
  assert.equal(repository.state.commands[0].expiresAt, "2026-09-07T12:10:00.000Z");
  assert.equal(repository.state.permits.get(PERMIT_ID).expires_at, "2026-09-07T12:10:00.000Z");

  // Model the measured 501-second dashboard-to-device/capture flow. The
  // command and permit remain exact, single-use server authority; only the
  // fixed expiry changed.
  Object.assign(repository.state.permits.get(PERMIT_ID), {
    terminal_status: "SUCCEEDED",
    ack_status: "SUCCEEDED",
    ack_result: { conversation_binding_permit: "ARMED" }
  });
  currentTime = new Date("2026-09-07T12:08:21.000Z");
  const duringManualFlow = await bindingService.authorizeIncomingCapturePermit({}, {
    commandId: PERMIT_ID,
    deviceId: DEVICE_ID,
    captureId: CAPTURE_B
  });
  assert.equal(duringManualFlow.status, HUMAN_ARMED_CONVERSATION_STATUS.AUTHORIZED);
  assert.deepEqual(await bindingService.consumeAuthorizedIncomingPermit({}, {
    authorization: duringManualFlow.authorization,
    captureId: CAPTURE_B
  }), {
    status: HUMAN_ARMED_CONVERSATION_STATUS.CONSUMED,
    contactId: 7,
    bindingId: BINDING_ID
  });
  assert.equal(repository.state.permits.get(PERMIT_ID).permit_state, "CONSUMED");
  assert.equal(repository.state.audits.some(audit => audit.action === "PERMIT_CONSUMED"), true);

  const expiredRepository = fixtureRepository({ bindings: [binding()] });
  const expiredService = service(expiredRepository, { now: () => currentTime });
  currentTime = NOW;
  await expiredService.rearmExistingBinding({ bindingId: BINDING_ID, confirmed: true });
  Object.assign(expiredRepository.state.permits.get(PERMIT_ID), {
    terminal_status: "SUCCEEDED",
    ack_status: "SUCCEEDED",
    ack_result: { conversation_binding_permit: "ARMED" }
  });
  currentTime = new Date("2026-09-07T12:10:00.000Z");
  assert.deepEqual(await expiredService.authorizeIncomingCapturePermit({}, {
    commandId: PERMIT_ID,
    deviceId: DEVICE_ID,
    captureId: CAPTURE_B
  }), {
    status: HUMAN_ARMED_CONVERSATION_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: HUMAN_ARMED_CONVERSATION_REASON.PERMIT_EXPIRED
  });
  assert.equal(expiredRepository.state.permits.get(PERMIT_ID).permit_state, "ISSUED");
  assert.equal(expiredRepository.state.audits.some(audit => audit.action === "PERMIT_CONSUMED"), false);
});

test("a valid issued permit is single-use, device-scoped and resolves only its SAFE pending capture", async () => {
  const repository = fixtureRepository({ bindings: [binding()], permits: [permit()] });
  const result = await service(repository).consumeArmPermit({
    commandId: PERMIT_ID,
    deviceId: DEVICE_ID,
    captureId: CAPTURE_A
  });
  assert.deepEqual(result, { status: HUMAN_ARMED_CONVERSATION_STATUS.CONSUMED, contactId: 7, bindingId: BINDING_ID });
  assert.equal(repository.state.permits.get(PERMIT_ID).permit_state, "CONSUMED");
  const update = repository.state.calls.find(call => call.type === "update-capture").input;
  assert.deepEqual(update, {
    captureId: CAPTURE_A,
    mappingStatus: "RESOLVED",
    humanReviewStatus: "CONFIRMED",
    resolvedContactId: 7,
    reviewedBy: "human_armed_permit"
  });
  assert.equal(JSON.stringify(repository.state.audits).includes(PERMIT_ID), false);

  const replay = await service(repository).consumeArmPermit({
    commandId: PERMIT_ID,
    deviceId: DEVICE_ID,
    captureId: CAPTURE_A
  });
  assert.deepEqual(replay, {
    status: HUMAN_ARMED_CONVERSATION_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: HUMAN_ARMED_CONVERSATION_REASON.PERMIT_ALREADY_CONSUMED
  });
});

test("incoming V3 authorization is caller-transaction-owned and consumption follows the later insert without nesting", async () => {
  const repository = fixtureRepository({ bindings: [binding()], permits: [permit()] });
  const bindingService = service(repository);
  const transaction = { ownedByIngress: true };
  const authorized = await bindingService.authorizeIncomingCapturePermit(transaction, {
    commandId: PERMIT_ID,
    deviceId: DEVICE_ID,
    captureId: CAPTURE_B
  });
  assert.equal(authorized.status, HUMAN_ARMED_CONVERSATION_STATUS.AUTHORIZED);
  assert.equal(repository.state.transactionCalls, 0);
  assert.equal(repository.state.permits.get(PERMIT_ID).permit_state, "ISSUED");
  assert.equal(repository.state.calls.some(call => call.type === "update-capture"), false);

  // The caller's V3 store would insert CAPTURE_B here with the returned
  // contactId.  The service itself does not issue that insert or open a tx.
  const consumed = await bindingService.consumeAuthorizedIncomingPermit(transaction, {
    authorization: authorized.authorization,
    captureId: CAPTURE_B
  });
  assert.deepEqual(consumed, {
    status: HUMAN_ARMED_CONVERSATION_STATUS.CONSUMED,
    contactId: 7,
    bindingId: BINDING_ID
  });
  assert.equal(repository.state.transactionCalls, 0);
  assert.equal(repository.state.permits.get(PERMIT_ID).permit_state, "CONSUMED");
  assert.equal(repository.state.audits.length, 1);
  assertNoSensitiveValue({ audits: repository.state.audits });

  await assert.rejects(
    () => bindingService.consumeAuthorizedIncomingPermit(transaction, {
      authorization: { ...authorized.authorization },
      captureId: CAPTURE_B
    }),
    error => error instanceof TinderHumanArmedConversationBindingError && error.code === "INVALID_PERMIT_AUTHORIZATION"
  );
});

test("expired, wrong-device, changed-binding and non-pending permit consumption fail closed without resolution", async () => {
  const expiredRepository = fixtureRepository({ bindings: [binding()], permits: [permit({ expires_at: "2026-09-07T11:59:59.000Z" })] });
  assert.deepEqual(await service(expiredRepository).consumeArmPermit({ commandId: PERMIT_ID, deviceId: DEVICE_ID, captureId: CAPTURE_A }), {
    status: HUMAN_ARMED_CONVERSATION_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: HUMAN_ARMED_CONVERSATION_REASON.PERMIT_EXPIRED
  });
  assert.equal(expiredRepository.state.calls.some(call => call.type === "update-capture"), false);

  const wrongDeviceRepository = fixtureRepository({ bindings: [binding()], permits: [permit()] });
  assert.deepEqual(await service(wrongDeviceRepository).consumeArmPermit({ commandId: PERMIT_ID, deviceId: OTHER_DEVICE_ID, captureId: CAPTURE_A }), {
    status: HUMAN_ARMED_CONVERSATION_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: HUMAN_ARMED_CONVERSATION_REASON.PERMIT_DEVICE_MISMATCH
  });
  assert.equal(wrongDeviceRepository.state.calls.some(call => call.type === "update-capture"), false);

  const revisionRepository = fixtureRepository({ bindings: [binding({ binding_revision: 2 })], permits: [permit()] });
  assert.deepEqual(await service(revisionRepository).consumeArmPermit({ commandId: PERMIT_ID, deviceId: DEVICE_ID, captureId: CAPTURE_A }), {
    status: HUMAN_ARMED_CONVERSATION_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: HUMAN_ARMED_CONVERSATION_REASON.BINDING_REVISION_CHANGED
  });
  assert.equal(revisionRepository.state.calls.some(call => call.type === "update-capture"), false);

  const resolvedRepository = fixtureRepository({
    captures: [capture({ mapping_status: "RESOLVED", human_review_status: "CONFIRMED", resolved_contact_id: 7 })],
    bindings: [binding()], permits: [permit()]
  });
  assert.deepEqual(await service(resolvedRepository).consumeArmPermit({ commandId: PERMIT_ID, deviceId: DEVICE_ID, captureId: CAPTURE_A }), {
    status: HUMAN_ARMED_CONVERSATION_STATUS.PENDING_CAPTURE_REQUIRED,
    reasonCode: HUMAN_ARMED_CONVERSATION_REASON.CAPTURE_NOT_PENDING
  });
  assert.equal(resolvedRepository.state.permits.get(PERMIT_ID).permit_state, "ISSUED");
});

test("runtime loss after an arm prevents consumption; an absent/cleared permit has no implicit fallback", async () => {
  const stoppedRepository = fixtureRepository({
    bindings: [binding()],
    permits: [permit()],
    runtimeByDevice: new Map([[DEVICE_ID, runtime({ bridge_service_state: "STOPPED" })]])
  });
  assert.deepEqual(await service(stoppedRepository).consumeArmPermit({ commandId: PERMIT_ID, deviceId: DEVICE_ID, captureId: CAPTURE_A }), {
    status: HUMAN_ARMED_CONVERSATION_STATUS.DEVICE_NOT_READY,
    reasonCode: HUMAN_ARMED_CONVERSATION_REASON.BRIDGE_NOT_RUNNING
  });
  assert.equal(stoppedRepository.state.permits.get(PERMIT_ID).permit_state, "ISSUED");

  const absentRepository = fixtureRepository({ bindings: [binding()] });
  assert.deepEqual(await service(absentRepository).consumeArmPermit({ commandId: PERMIT_ID, deviceId: DEVICE_ID, captureId: CAPTURE_A }), {
    status: HUMAN_ARMED_CONVERSATION_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: HUMAN_ARMED_CONVERSATION_REASON.PERMIT_NOT_FOUND
  });
});

test("constructor and input validation fail closed", async () => {
  assert.throws(
    () => createTinderHumanArmedConversationBindingService({}, {}),
    /repository\.withTransaction/
  );
  const missingResumeLookup = fixtureRepository();
  delete missingResumeLookup.findActiveOfficialAppResumePermitForDevice;
  assert.throws(
    () => service(missingResumeLookup),
    /repository\.findActiveOfficialAppResumePermitForDevice/
  );
  assert.doesNotThrow(
    () => service(fixtureRepository(), { armTtlMs: 15 * 60_000 })
  );
  assert.throws(
    () => service(fixtureRepository(), { armTtlMs: 15 * 60_000 + 1 }),
    /safe bounded duration/
  );
  const repository = fixtureRepository();
  await assert.rejects(
    () => service(repository).armInitialCapture({ captureId: CAPTURE_A, action: "BIND_EXISTING", contactId: 7, confirmed: true, messageText: "no" }),
    error => error instanceof TinderHumanArmedConversationBindingError && error.code === "INVALID_INITIAL_ARM_REQUEST"
  );
  await assert.rejects(
    () => service(repository).consumeArmPermit({ commandId: "not-a-uuid", deviceId: DEVICE_ID, captureId: CAPTURE_A }),
    error => error instanceof TinderHumanArmedConversationBindingError && error.code === "INVALID_ARM_COMMAND_ID"
  );
});
