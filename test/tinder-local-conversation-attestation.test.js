import assert from "node:assert/strict";
import test from "node:test";
import {
  createPgTinderLocalConversationAttestationRepository,
  createTinderLocalConversationAttestationService,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_FIELD,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS
} from "../services/tinder-local-conversation-attestation.js";
import {
  createTinderLocalConversationAttestationIngressHandler,
  parseSignedLocalConversationAttestationRequest
} from "../device-bridge/tinder-local-conversation-attestation-ingress.js";
import { projectTinderLocalConversationAttestationCommandAck } from "../device-bridge/tinder-local-conversation-attestation-command-ack.js";
import {
  T4_RESUME_ATTESTATION_DEVICE_CAPABILITIES,
  T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES
} from "../device-bridge/protocol-v1.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const BINDING_ID = "832d0663-8bb1-4947-ae8a-14a6d9de8924";
const COMMAND_ID = "d565e8a7-ef60-42d0-b19d-26e7904390fa";
const NEW_COMMAND_ID = "c565e8a7-ef60-42d0-b19d-26e7904390fa";
const AUDIT_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const NOW = new Date("2026-09-11T12:00:00.000Z");

function runtime(overrides = {}) {
  return {
    online: true,
    enrollment_state: "ACTIVE",
    bridge_service_state: "RUNNING",
    tinder_state: "CONNECTED",
    automation_state: "STOPPED",
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES,
    last_heartbeat_sequence: 1,
    ...overrides
  };
}

function binding(overrides = {}) {
  return {
    binding_id: BINDING_ID,
    device_id: DEVICE_ID,
    binding_revision: 3,
    binding_state: "CONFIRMED",
    human_verified: true,
    channel: "tinder",
    reference_kind: "tinder_human_armed_conversation_v1",
    ...overrides
  };
}

function stagedPermit(overrides = {}) {
  return {
    command_id: COMMAND_ID,
    binding_id: BINDING_ID,
    permit_binding_revision: 3,
    device_id: DEVICE_ID,
    permit_state: "STAGED",
    permit_contract_version: 1,
    expires_at: "2026-09-11T12:10:00.000Z",
    command_type: TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE,
    command_payload: { binding_revision: "3", attestation_contract_version: "2" },
    terminal_status: "SUCCEEDED",
    ack_status: "SUCCEEDED",
    ack_result: { local_conversation_attestation: "STAGED" },
    binding_device_id: DEVICE_ID,
    current_binding_revision: 3,
    binding_state: "CONFIRMED",
    human_verified: true,
    channel: "tinder",
    reference_kind: "tinder_human_armed_conversation_v1",
    ...overrides
  };
}

function fixtureRepository({
  runtimeRow = runtime(),
  bindingRow = binding(),
  permitRows = [],
  activeLocal = null,
  activeUnboundInboxSweep = false,
  inboxNavigation = {
    stage: "CHAT_VERIFIED",
    reason: "NONE",
    visible_conversation_count: 1,
    observed_event_count: 1
  },
  acceptedHeartbeatSequence = 1
} = {}) {
  const permits = new Map(permitRows.map(row => [row.command_id, { ...row }]));
  const state = {
    permits,
    commands: [],
    audits: [],
    cancelledChildren: [],
    calls: [],
    readerQueues: 0
  };
  const repository = {
    state,
    async withTransaction(work) { return work({}); },
    async getDeviceRuntimeForUpdate(_transaction, deviceId) {
      state.calls.push({ type: "device", deviceId });
      return deviceId === DEVICE_ID ? runtimeRow : null;
    },
    async getCurrentAcceptedInboxNavigationForDevice(_transaction, { deviceId, heartbeatSequence }) {
      state.calls.push({ type: "inbox-navigation", deviceId, heartbeatSequence });
      return deviceId === DEVICE_ID && heartbeatSequence === acceptedHeartbeatSequence && inboxNavigation !== null
        ? { inbox_navigation: inboxNavigation }
        : null;
    },
    async expireLocalConversationAttestationPermits(_transaction, { deviceId, expiredAt }) {
      const expired = [];
      for (const permit of permits.values()) {
        if (permit.device_id === deviceId
            && ["ISSUED", "STAGED", "ATTESTED"].includes(permit.permit_state)
            && new Date(permit.expires_at).valueOf() <= new Date(expiredAt).valueOf()) {
          permit.permit_state = "EXPIRED";
          permit.closed_at = expiredAt;
          permit.terminal_reason = "EXPIRED";
          expired.push({
            command_id: permit.command_id,
            binding_id: permit.binding_id,
            binding_revision: permit.permit_binding_revision ?? permit.binding_revision,
            device_id: permit.device_id
          });
        }
      }
      return expired;
    },
    async findActiveHumanArmedPermitForDevice() { return false; },
    async findActiveVisibleChatSyncPermitForDevice() { return false; },
    async findActiveOfficialAppResumePermitForDevice() { return false; },
    async findActiveUnboundInboxConversationSweepForDevice(_transaction, input) {
      state.calls.push({ type: "find-v8-sweep", input });
      return activeUnboundInboxSweep;
    },
    async lookupHumanBindingDeviceId(_transaction, bindingId) {
      return bindingId === BINDING_ID ? bindingRow.device_id : null;
    },
    async getConfirmedHumanBindingForUpdate(_transaction, bindingId) {
      return bindingId === BINDING_ID ? { ...bindingRow } : null;
    },
    async findActiveLocalConversationAttestationForDeviceForUpdate(_transaction, { deviceId }) {
      if (activeLocal !== null) return activeLocal;
      return [...permits.values()].find(permit => permit.device_id === deviceId
        && ["ISSUED", "STAGED", "ATTESTED"].includes(permit.permit_state)) || null;
    },
    async queueLocalConversationAttestationCommand(_transaction, command) {
      state.commands.push(command);
    },
    async createLocalConversationAttestationPermit(_transaction, permit) {
      if ([...permits.values()].some(existing => existing.device_id === permit.deviceId
          && ["ISSUED", "STAGED", "ATTESTED"].includes(existing.permit_state))) {
        const error = new Error("active proof");
        error.code = "LOCAL_CONVERSATION_ATTESTATION_DEVICE_BUSY";
        throw error;
      }
      permits.set(permit.commandId, stagedPermit({
        command_id: permit.commandId,
        binding_id: permit.bindingId,
        permit_binding_revision: permit.bindingRevision,
        device_id: permit.deviceId,
        permit_state: "ISSUED",
        expires_at: permit.expiresAt,
        terminal_status: null,
        ack_status: null,
        ack_result: null
      }));
    },
    async getLocalConversationAttestationPermitForUpdate(_transaction, commandId) {
      return permits.get(commandId) ? { ...permits.get(commandId), ...bindingRow } : null;
    },
    async markLocalConversationAttestationAttested(_transaction, { commandId, deviceId, attestedAt }) {
      const permit = permits.get(commandId);
      if (!permit || permit.device_id !== deviceId || permit.permit_state !== "STAGED"
          || new Date(permit.expires_at).valueOf() <= new Date(attestedAt).valueOf()) return false;
      permit.permit_state = "ATTESTED";
      permit.attested_at = attestedAt;
      return true;
    },
    async markLocalConversationAttestationInvalidated(_transaction, { commandId, deviceId, invalidatedAt, reasonCode }) {
      const permit = permits.get(commandId);
      if (!permit || permit.device_id !== deviceId || !["STAGED", "ATTESTED"].includes(permit.permit_state)) return false;
      permit.permit_state = "INVALIDATED";
      permit.invalidated_at = invalidatedAt;
      permit.closed_at = invalidatedAt;
      permit.terminal_reason = reasonCode;
      return true;
    },
    async cancelDependentVisibleChatSyncPermits(_transaction, input) {
      state.cancelledChildren.push(input);
      return [];
    },
    async insertLocalConversationAttestationAudit(_transaction, record) {
      state.audits.push(record);
    }
  };
  return repository;
}

function service(repository, options = {}) {
  return createTinderLocalConversationAttestationService(repository, {
    createCommandId: () => COMMAND_ID,
    createAuditId: () => AUDIT_ID,
    now: () => NOW,
    ...options
  });
}

test("bootstrap emits only the opaque exact V2 post-chat payload", async () => {
  const repository = fixtureRepository();
  const result = await service(repository).queueBootstrap({
    bindingId: BINDING_ID,
    confirmed: true,
    actor: "DASHBOARD_HUMAN"
  });

  assert.deepEqual(result, { status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.QUEUED });
  assert.equal(repository.state.commands.length, 1);
  assert.deepEqual(repository.state.commands[0].payload, {
    binding_revision: "3",
    [TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_FIELD]: "2"
  });
  assert.equal(repository.state.commands[0].commandType, TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE);
  assert.deepEqual(Object.keys(repository.state.audits[0]).sort(), [
    "action", "actor", "auditId", "bindingId", "bindingRevision", "commandId", "details", "deviceId", "reasonCode", "source"
  ]);
  assert.deepEqual(repository.state.audits[0].details, {});
  assert.equal(JSON.stringify(result).includes(BINDING_ID), false);
  assert.equal(JSON.stringify(result).includes(DEVICE_ID), false);
});

test("bootstrap requires the latest accepted content-free CHAT_VERIFIED/NONE observation", async () => {
  for (const [runtimeRow, inboxNavigation] of [
    [runtime(), null],
    [runtime(), {
      stage: "BLOCKED",
      reason: "CHAT_STRUCTURE_REJECTED",
      visible_conversation_count: 0,
      observed_event_count: 2
    }],
    [runtime(), {
      stage: "CHAT_VERIFIED",
      reason: "CHAT_STRUCTURE_REJECTED",
      visible_conversation_count: 1,
      observed_event_count: 2
    }],
    [runtime({ last_heartbeat_sequence: 2 }), {
      stage: "CHAT_VERIFIED",
      reason: "NONE",
      visible_conversation_count: 1,
      observed_event_count: 1
    }]
  ]) {
    const repository = fixtureRepository({
      runtimeRow,
      inboxNavigation,
      acceptedHeartbeatSequence: 1
    });
    const result = await service(repository).queueBootstrap({
      bindingId: BINDING_ID,
      confirmed: true,
      actor: "DASHBOARD_HUMAN"
    });
    assert.deepEqual(result, {
      status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.CHAT_VERIFICATION_REQUIRED
    });
    assert.equal(repository.state.commands.length, 0);
    assert.equal(repository.state.audits.length, 0);
  }
});

test("legacy V1 attestation profile remains recognized but cannot mint a post-chat bootstrap", async () => {
  const repository = fixtureRepository({
    runtimeRow: runtime({ capabilities: T4_RESUME_ATTESTATION_DEVICE_CAPABILITIES })
  });
  const result = await service(repository).queueBootstrap({
    bindingId: BINDING_ID,
    confirmed: true,
    actor: "DASHBOARD_HUMAN"
  });
  assert.deepEqual(result, {
    status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.DEVICE_NOT_READY,
    reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.DEVICE_CAPABILITY_UNSUPPORTED
  });
  assert.equal(repository.state.calls.some(call => call.type === "inbox-navigation"), false);
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.audits.length, 0);
});

test("one active local proof per device fails closed without replacing the existing permit", async () => {
  const repository = fixtureRepository({ activeLocal: { command_id: COMMAND_ID, permit_state: "STAGED" } });
  const result = await service(repository).queueBootstrap({
    bindingId: BINDING_ID,
    confirmed: true,
    actor: "DASHBOARD_HUMAN"
  });
  assert.deepEqual(result, {
    status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_CONFLICT,
    reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.LOCAL_CONVERSATION_ATTESTATION_DEVICE_BUSY
  });
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.audits.length, 0);
});

test("local attestation fails closed while an active V8 Inbox sweep owns the locked device", async () => {
  const repository = fixtureRepository({ activeUnboundInboxSweep: true });
  const result = await service(repository).queueBootstrap({
    bindingId: BINDING_ID,
    confirmed: true,
    actor: "DASHBOARD_HUMAN"
  });

  assert.deepEqual(result, {
    status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_CONFLICT,
    reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE
  });
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.permits.size, 0);
  assert.equal(repository.state.calls.some(call => call.type === "find-v8-sweep"), true);
});

test("staged proof atomically becomes ATTESTED and queues one separate reader authority", async () => {
  const repository = fixtureRepository({ permitRows: [stagedPermit()] });
  const result = await service(repository, {
    async queueReaderAfterAttestation(_transaction, proof) {
      repository.state.readerQueues += 1;
      assert.equal(proof.commandId, COMMAND_ID);
      assert.equal(proof.bindingRevision, 3);
      return { status: "QUEUED" };
    }
  }).attestLocalConversation({ commandId: COMMAND_ID, deviceId: DEVICE_ID, status: "ATTESTED" });

  assert.deepEqual(result, { status: "ATTESTED", readerStatus: "READER_QUEUED" });
  assert.equal(repository.state.permits.get(COMMAND_ID).permit_state, "ATTESTED");
  assert.equal(repository.state.readerQueues, 1);
  assert.equal(repository.state.audits.at(-1).action, "ATTESTED");
  assert.equal(repository.state.audits.at(-1).actor, "ANDROID_RUNTIME");
});

test("legacy V1 attestation profile cannot positively attest a staged post-chat permit", async () => {
  const repository = fixtureRepository({
    runtimeRow: runtime({ capabilities: T4_RESUME_ATTESTATION_DEVICE_CAPABILITIES }),
    permitRows: [stagedPermit()]
  });
  const result = await service(repository).attestLocalConversation({
    commandId: COMMAND_ID,
    deviceId: DEVICE_ID,
    status: "ATTESTED"
  });
  assert.deepEqual(result, {
    status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.DEVICE_NOT_READY,
    reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.DEVICE_CAPABILITY_UNSUPPORTED
  });
  assert.equal(repository.state.permits.get(COMMAND_ID).permit_state, "STAGED");
  assert.equal(repository.state.audits.length, 0);
});

test("a legacy one-field bootstrap cannot become ATTESTED after a V2 profile upgrade", async () => {
  const repository = fixtureRepository({
    permitRows: [stagedPermit({ command_payload: { binding_revision: "3" } })]
  });
  const result = await service(repository).attestLocalConversation({
    commandId: COMMAND_ID,
    deviceId: DEVICE_ID,
    status: "ATTESTED"
  });
  assert.deepEqual(result, {
    status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.PERMIT_NOT_STAGED
  });
  assert.equal(repository.state.permits.get(COMMAND_ID).permit_state, "STAGED");
  assert.equal(repository.state.readerQueues, 0);
  assert.equal(repository.state.audits.length, 0);
});

test("an ATTESTED replay cannot queue a duplicate reader command", async () => {
  const repository = fixtureRepository({ permitRows: [stagedPermit()] });
  const attestation = service(repository, {
    async queueReaderAfterAttestation() {
      repository.state.readerQueues += 1;
      return { status: "QUEUED" };
    }
  });
  assert.equal((await attestation.attestLocalConversation({ commandId: COMMAND_ID, deviceId: DEVICE_ID, status: "ATTESTED" })).status, "ATTESTED");
  const replay = await attestation.attestLocalConversation({ commandId: COMMAND_ID, deviceId: DEVICE_ID, status: "ATTESTED" });
  assert.deepEqual(replay, {
    status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.PERMIT_NOT_STAGED
  });
  assert.equal(repository.state.readerQueues, 1);
});

test("signed local loss invalidates a staged proof, cancels its derivative V4 authority, and cannot later attest", async () => {
  const repository = fixtureRepository({ permitRows: [stagedPermit()] });
  const attestation = service(repository);
  const invalidated = await attestation.invalidateLocalConversation({
    commandId: COMMAND_ID,
    deviceId: DEVICE_ID,
    reasonCode: "CONTINUITY_UNPROVEN"
  });
  assert.deepEqual(invalidated, { status: "INVALIDATED" });
  assert.equal(repository.state.permits.get(COMMAND_ID).permit_state, "INVALIDATED");
  assert.equal(repository.state.cancelledChildren.length, 1);
  assert.equal(repository.state.audits.at(-1).action, "INVALIDATED");
  const later = await attestation.attestLocalConversation({ commandId: COMMAND_ID, deviceId: DEVICE_ID, status: "ATTESTED" });
  assert.deepEqual(later, {
    status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.PERMIT_NOT_STAGED
  });
});

test("expired proof terminalizes derivative V4 authority before a fresh bootstrap is considered", async () => {
  const expired = stagedPermit({ permit_state: "ATTESTED", expires_at: "2026-09-11T11:59:59.999Z" });
  const repository = fixtureRepository({ permitRows: [expired] });
  const result = await service(repository, { createCommandId: () => NEW_COMMAND_ID }).queueBootstrap({
    bindingId: BINDING_ID,
    confirmed: true,
    actor: "DASHBOARD_HUMAN"
  });
  assert.equal(result.status, "QUEUED");
  assert.equal(repository.state.permits.get(COMMAND_ID).permit_state, "EXPIRED");
  assert.equal(repository.state.cancelledChildren.length, 1);
  assert.equal(repository.state.audits.some(audit => audit.action === "EXPIRED" && audit.reasonCode === "PERMIT_EXPIRED"), true);
});

test("a current binding revision change invalidates the staged proof under server validation", async () => {
  const repository = fixtureRepository({
    bindingRow: binding({ binding_revision: 4, current_binding_revision: 4 }),
    permitRows: [stagedPermit()]
  });
  const result = await service(repository).attestLocalConversation({ commandId: COMMAND_ID, deviceId: DEVICE_ID, status: "ATTESTED" });
  assert.deepEqual(result, {
    status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: "BINDING_REVISION_CHANGED"
  });
  assert.equal(repository.state.permits.get(COMMAND_ID).permit_state, "INVALIDATED");
  assert.equal(repository.state.audits.at(-1).actor, "SERVER_VALIDATION");
  assert.equal(repository.state.audits.at(-1).reasonCode, "BINDING_REVISION_CHANGED");
});

test("a stale V2 reader tuple does not keep the device busy for a new local bootstrap", async () => {
  const calls = [];
  const repository = createPgTinderLocalConversationAttestationRepository({
    async connect() { throw new Error("not used by this focused repository query"); },
    async query() { throw new Error("not used by this focused repository query"); }
  });
  const client = {
    async query(sql, parameters) {
      calls.push({ sql: String(sql), parameters });
      if (String(sql).includes("to_regclass")) {
        return { rows: [{ relation_name: "tinder_local_conversation_attestation_permits" }] };
      }
      return { rows: [{ active: false }] };
    }
  };
  assert.equal(await repository.findActiveVisibleChatSyncPermitForDevice(client, {
    deviceId: DEVICE_ID,
    now: NOW.toISOString()
  }), false);
  const sql = calls.at(-1).sql;
  for (const required of [
    /sync_permit\.permit_contract_version=1/,
    /sync_permit\.permit_contract_version=2/,
    /attestation\.permit_state='ATTESTED'/,
    /attestation_command\.payload=jsonb_build_object\(/,
    /'attestation_contract_version', '2'/,
    /binding\.binding_revision=sync_permit\.binding_revision/,
    /binding_permit\.consumed_capture_id=sync_permit\.source_capture_id/,
    /source_capture\.capture_safety_status='SAFE'/,
    /MAX\(newer\.capture_revision\)/
  ]) assert.match(sql, required);
});

test("signed ingress accepts only exact opaque bodies and returns the exact bounded receipt", async () => {
  const positive = Buffer.from(JSON.stringify({
    protocol_version: 1,
    attestation: { command_id: COMMAND_ID, status: "ATTESTED" }
  }), "utf8");
  assert.deepEqual(parseSignedLocalConversationAttestationRequest({ body: positive }), {
    commandId: COMMAND_ID,
    status: "ATTESTED"
  });
  for (const body of [
    { protocol_version: 1, attestation: { command_id: COMMAND_ID, status: "ATTESTED", capture_id: COMMAND_ID } },
    { protocol_version: 1, attestation: { command_id: COMMAND_ID, status: "INVALIDATED", reason: "HUMAN_REBIND" } },
    { protocol_version: 1, attestation: { command_id: COMMAND_ID, status: "ATTESTED", message: "private" } }
  ]) {
    assert.throws(() => parseSignedLocalConversationAttestationRequest({ body: Buffer.from(JSON.stringify(body), "utf8") }));
  }

  let received;
  const handler = createTinderLocalConversationAttestationIngressHandler({}, {
    now: () => NOW,
    async verifyRequest() { return { deviceId: DEVICE_ID, keyId: AUDIT_ID, requestId: AUDIT_ID }; },
    createAuthenticatedService() {
      return {
        async attestLocalConversation(input) {
          received = input;
          return { status: "ATTESTED", readerStatus: "READER_QUEUED" };
        },
        async invalidateLocalConversation() { assert.fail("wrong ingress transition"); }
      };
    }
  });
  const req = {
    body: positive,
    params: { deviceId: DEVICE_ID },
    get(name) { return name === "x-marcel-request-id" ? AUDIT_ID : undefined; }
  };
  const res = { statusCode: null, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await handler(req, res);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, {
    ok: true,
    protocol_version: 1,
    server_time: NOW.toISOString(),
    attestation: { command_id: COMMAND_ID, status: "ACCEPTED" }
  });
  assert.deepEqual(received, { commandId: COMMAND_ID, deviceId: DEVICE_ID, status: "ATTESTED" });
  assert.equal(JSON.stringify(res.body).includes(BINDING_ID), false);
});

test("signed proof-loss ingress keeps the active-device/replay boundary but skips positive runtime gates", async () => {
  let options;
  let received;
  const handler = createTinderLocalConversationAttestationIngressHandler({}, {
    now: () => NOW,
    async verifyRequest() { return { deviceId: DEVICE_ID, keyId: AUDIT_ID, requestId: AUDIT_ID }; },
    createAuthenticatedService(_pool, _auth, configured) {
      options = configured;
      return {
        async attestLocalConversation() { assert.fail("positive transition must not run"); },
        async invalidateLocalConversation(input) {
          received = input;
          return { status: "INVALIDATED" };
        }
      };
    }
  });
  const req = {
    body: Buffer.from(JSON.stringify({
      protocol_version: 1,
      attestation: {
        command_id: COMMAND_ID,
        status: "INVALIDATED",
        reason: "CONTINUITY_UNPROVEN"
      }
    }), "utf8"),
    params: { deviceId: DEVICE_ID },
    get(name) { return name === "x-marcel-request-id" ? AUDIT_ID : undefined; }
  };
  const res = { statusCode: null, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await handler(req, res);
  assert.equal(options.requirePositiveRuntimeGates, false);
  assert.deepEqual(received, {
    commandId: COMMAND_ID,
    deviceId: DEVICE_ID,
    reasonCode: "CONTINUITY_UNPROVEN"
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body.attestation, { command_id: COMMAND_ID, status: "ACCEPTED" });
});

test("the ACK projector stages only the exact bootstrap acknowledgement and writes bounded audit fields", async () => {
  const state = { permit: { command_id: COMMAND_ID, binding_id: BINDING_ID, binding_revision: 3, device_id: DEVICE_ID, permit_state: "ISSUED" }, audits: [] };
  const client = {
    async query(sql, values = []) {
      if (String(sql).includes("SELECT command_id, binding_id")) return { rows: [state.permit] };
      if (String(sql).includes("UPDATE tinder_local_conversation_attestation_permits")) {
        state.permit.permit_state = values[1];
        return { rows: [{ command_id: COMMAND_ID }] };
      }
      if (String(sql).includes("INSERT INTO tinder_local_conversation_attestation_audit")) {
        state.audits.push(values);
        return { rows: [] };
      }
      throw new Error("unexpected query");
    }
  };
  const result = await projectTinderLocalConversationAttestationCommandAck(client, {
    command: { command_type: TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE, command_id: COMMAND_ID, device_id: DEVICE_ID },
    ack: { status: "SUCCEEDED", occurred_at: NOW.toISOString(), result: { local_conversation_attestation: "STAGED" } }
  });
  assert.deepEqual(result, { state: "STAGED" });
  assert.equal(state.permit.permit_state, "STAGED");
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0][5], "STAGED");
  assert.equal(state.audits[0][6], null);
});
