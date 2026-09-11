import assert from "node:assert/strict";
import test from "node:test";
import {
  createPgTinderVisibleChatSyncRepository,
  createTinderVisibleChatSyncService,
  TinderVisibleChatSyncError,
  TINDER_VISIBLE_CHAT_SYNC_ACK_RESULT,
  TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
  TINDER_VISIBLE_CHAT_SYNC_REASON,
  TINDER_VISIBLE_CHAT_SYNC_STATUS,
  TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION,
  TINDER_VISIBLE_CHAT_SYNC_LEGACY_PERMIT_CONTRACT_VERSION
} from "../services/tinder-visible-chat-sync.js";
import {
  T4_RESUME_ATTESTATION_DEVICE_CAPABILITIES,
  T4_RESUME_DEVICE_CAPABILITIES
} from "../device-bridge/protocol-v1.js";

const DEVICE_ID = "36761d7f-2ac3-4da9-9ad4-7fd381665f1e";
const OTHER_DEVICE_ID = "46761d7f-2ac3-4da9-9ad4-7fd381665f1e";
const COMMAND_ID = "d565e8a7-ef60-42d0-b19d-26e7904390fa";
const CAPTURE_ID = "6ebb6d37-8b69-444a-b22d-390b81860026";
const BINDING_ID = "832d0663-8bb1-4947-ae8a-14a6d9de8924";
const ATTESTATION_COMMAND_ID = "d8e7f31b-90f8-4b37-8aa8-88e6a6efc2b5";
const NOW = new Date("2026-09-07T12:00:00.000Z");

function runtime(overrides = {}) {
  return {
    online: true,
    enrollment_state: "ACTIVE",
    bridge_service_state: "RUNNING",
    tinder_state: "CONNECTED",
    automation_state: "STOPPED",
    capabilities: T4_RESUME_ATTESTATION_DEVICE_CAPABILITIES,
    ...overrides
  };
}

function fixtureRepository({
  runtimeByDevice = new Map([[DEVICE_ID, runtime()]]),
  activeHumanArmed = false,
  activeSync = false,
  activeOfficialAppResume = false,
  sourceConfirmed = true,
  sourceCaptureIsLatest = true,
  humanBindingSource = {
    device_id: DEVICE_ID,
    source_capture_id: CAPTURE_ID,
    attestation_command_id: ATTESTATION_COMMAND_ID,
    binding_id: BINDING_ID,
    binding_revision: 3
  },
  localAttestationState = null,
  attestationCurrent = true,
  permits = []
} = {}) {
  const permitRows = new Map(permits.map(row => [row.command_id, { ...row }]));
  const state = { commands: [], permits: permitRows, calls: [], transactions: 0 };
  return {
    state,
    async withTransaction(work) { state.transactions += 1; return work({}); },
    async getDeviceRuntimeForUpdate(_transaction, deviceId) {
      return runtimeByDevice.get(deviceId) || null;
    },
    async expireVisibleChatSyncPermits(_transaction, input) {
      state.calls.push({ type: "expire", input });
      for (const permit of permitRows.values()) {
        if (permit.device_id === input.deviceId
            && ["ISSUED", "STAGED"].includes(permit.permit_state)
            && new Date(permit.expires_at).valueOf() <= new Date(input.expiredAt).valueOf()) {
          permit.permit_state = "EXPIRED";
          permit.closed_at = input.expiredAt;
        }
      }
    },
    async findActiveHumanArmedPermitForDevice(_transaction, input) {
      state.calls.push({ type: "find-v3", input });
      return activeHumanArmed;
    },
    async findActiveVisibleChatSyncPermitForDevice(_transaction, input) {
      state.calls.push({ type: "find-v4", input });
      if (activeSync) return true;
      return [...permitRows.values()].some(permit => permit.device_id === input.deviceId
        && ["ISSUED", "STAGED"].includes(permit.permit_state)
        && new Date(permit.expires_at).valueOf() > new Date(input.now).valueOf());
    },
    async findActiveOfficialAppResumePermitForDevice(_transaction, input) {
      state.calls.push({ type: "find-v5-resume", input });
      return activeOfficialAppResume;
    },
    async lookupHumanBindingDeviceId(_transaction, bindingId) {
      state.calls.push({ type: "binding-device", input: { bindingId } });
      return bindingId === BINDING_ID ? DEVICE_ID : null;
    },
    async getConfirmedSourceCaptureForUpdate(_transaction, input) {
      state.calls.push({ type: "source-capture", input });
      return sourceConfirmed && sourceCaptureIsLatest;
    },
    async getConfirmedSourceCaptureForAttestedHumanBindingForUpdate(_transaction, input) {
      state.calls.push({ type: "human-binding-source", input });
      return humanBindingSource;
    },
    async getLocalConversationAttestationStateForBindingForUpdate(_transaction, input) {
      state.calls.push({ type: "attestation-state", input });
      return localAttestationState;
    },
    async queueVisibleChatSyncCommand(_transaction, command) {
      state.commands.push(command);
    },
    async createVisibleChatSyncPermit(_transaction, permit) {
      permitRows.set(permit.commandId, {
        command_id: permit.commandId,
        device_id: permit.deviceId,
        source_capture_id: permit.sourceCaptureId,
        permit_state: permit.permitState,
        expires_at: permit.expiresAt,
        command_type: TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
        permit_contract_version: permit.permitContractVersion,
        attestation_command_id: permit.attestationCommandId,
        binding_id: permit.bindingId,
        binding_revision: permit.bindingRevision,
        terminal_status: null,
        ack_status: null,
        ack_result: null
      });
    },
    async lookupVisibleChatSyncPermitForAuthorization(_transaction, commandId) {
      const permit = permitRows.get(commandId);
      if (!permit) return null;
      return {
        command_id: permit.command_id,
        device_id: permit.device_id,
        permit_contract_version: permit.permit_contract_version,
        attestation_command_id: permit.attestation_command_id,
        binding_id: permit.binding_id,
        binding_revision: permit.binding_revision
      };
    },
    async getVisibleChatSyncPermitForUpdate(_transaction, commandId) {
      return permitRows.get(commandId) || null;
    },
    async revalidateAttestedLocalConversationForSyncPermitForUpdate(_transaction, input) {
      state.calls.push({ type: "revalidate-attestation", input });
      return attestationCurrent;
    },
    async markVisibleChatSyncPermitConsumed(_transaction, input) {
      const permit = permitRows.get(input.commandId);
      if (!permit || permit.device_id !== input.deviceId || permit.permit_state !== "STAGED") return false;
      permit.permit_state = "CONSUMED";
      permit.consumed_at = input.consumedAt;
      return true;
    }
  };
}

function service(repository, overrides = {}) {
  return createTinderVisibleChatSyncService(repository, {
    createCommandId: () => COMMAND_ID,
    now: () => NOW,
    ...overrides
  });
}

test("V4 direct V1 issuance is permanently fail-closed after the local-attestation foundation", async () => {
  const repository = fixtureRepository();
  const result = await service(repository).queueVisibleChatSync({ deviceId: DEVICE_ID, sourceCaptureId: CAPTURE_ID });

  assert.deepEqual(result, {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.LOCAL_CONVERSATION_ATTESTATION_REQUIRED
  });
  assert.equal(repository.state.transactions, 0);
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.permits.size, 0);
});

test("V4 creator rejects capture, identity, display, and fingerprint injection before a transaction", async () => {
  const repository = fixtureRepository();
  for (const extra of [
    { captureId: COMMAND_ID },
    { contactId: 7 },
    { visibleName: "Sandry" },
    { threadFingerprint: "a".repeat(64) }
  ]) {
    await assert.rejects(
      () => service(repository).queueVisibleChatSync({ deviceId: DEVICE_ID, sourceCaptureId: CAPTURE_ID, ...extra }),
      error => error instanceof TinderVisibleChatSyncError && error.code === "INVALID_SYNC_REQUEST"
    );
  }
  assert.equal(repository.state.transactions, 0);
  assert.equal(repository.state.commands.length, 0);
});

test("V4 human-bound current-chat sync derives its only source server-side and emits exact V2 opaque payload", async () => {
  const repository = fixtureRepository();
  const result = await service(repository).queueVisibleChatSyncForHumanBinding({ bindingId: BINDING_ID });

  assert.deepEqual(result, { status: TINDER_VISIBLE_CHAT_SYNC_STATUS.QUEUED });
  assert.equal(repository.state.transactions, 1);
  assert.equal(repository.state.calls.some(call => call.type === "binding-device"), true);
  assert.equal(repository.state.calls.some(call => call.type === "human-binding-source"), true);
  assert.equal(repository.state.commands.length, 1);
  assert.deepEqual(repository.state.commands[0].payload, {
    local_conversation_attestation: ATTESTATION_COMMAND_ID,
    binding_revision: "3"
  });
  assert.equal(repository.state.commands[0].permitContractVersion,
    TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION);
  assert.equal(repository.state.commands[0].attestationCommandId, ATTESTATION_COMMAND_ID);
  assert.equal(repository.state.commands[0].bindingRevision, 3);
  assert.equal(repository.state.permits.get(COMMAND_ID).permit_contract_version,
    TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION);
  assert.equal(repository.state.permits.get(COMMAND_ID).attestation_command_id, ATTESTATION_COMMAND_ID);
  const rendered = JSON.stringify({ result, calls: repository.state.calls, command: repository.state.commands[0] });
  assert.equal(rendered.includes("visibleName"), false);
  assert.equal(rendered.includes("threadFingerprint"), false);
  assert.equal(rendered.includes("captureFingerprint"), false);
  assert.equal(JSON.stringify(result).includes(BINDING_ID), false);
  assert.equal(JSON.stringify(result).includes(CAPTURE_ID), false);
  assert.equal(JSON.stringify(result).includes(DEVICE_ID), false);
});

test("V4 human-bound current-chat sync rejects browser capture, identity, timing, and content input before a transaction", async () => {
  const repository = fixtureRepository();
  for (const input of [
    {},
    { bindingId: "not-a-binding" },
    { bindingId: BINDING_ID, captureId: CAPTURE_ID },
    { bindingId: BINDING_ID, contactId: 7 },
    { bindingId: BINDING_ID, deviceId: DEVICE_ID },
    { bindingId: BINDING_ID, visibleName: "M" },
    { bindingId: BINDING_ID, capturedAt: "2026-09-08T12:00:00.000Z" },
    { bindingId: BINDING_ID, threadFingerprint: "a".repeat(64) },
    { bindingId: BINDING_ID, captureFingerprint: "b".repeat(64) },
    { bindingId: BINDING_ID, messages: ["private"] }
  ]) {
    await assert.rejects(
      () => service(repository).queueVisibleChatSyncForHumanBinding(input),
      error => error instanceof TinderVisibleChatSyncError
        && ["INVALID_HUMAN_BINDING_SYNC_REQUEST", "INVALID_HUMAN_BINDING_ID"].includes(error.code)
    );
  }
  assert.equal(repository.state.transactions, 0);
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.permits.size, 0);
});

test("V4 human-bound current-chat sync distinguishes a pending or invalid local proof from missing binding evidence", async () => {
  const pending = fixtureRepository({ humanBindingSource: null, localAttestationState: "STAGED" });
  assert.deepEqual(await service(pending).queueVisibleChatSyncForHumanBinding({ bindingId: BINDING_ID }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.LOCAL_CONVERSATION_ATTESTATION_NOT_ATTESTED
  });
  const invalid = fixtureRepository({ humanBindingSource: null, localAttestationState: "INVALIDATED" });
  assert.deepEqual(await service(invalid).queueVisibleChatSyncForHumanBinding({ bindingId: BINDING_ID }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.LOCAL_CONVERSATION_ATTESTATION_INVALID
  });
  const repository = fixtureRepository({ humanBindingSource: null });
  assert.deepEqual(await service(repository).queueVisibleChatSyncForHumanBinding({ bindingId: BINDING_ID }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.HUMAN_ARMED_BINDING_NOT_CONFIRMED
  });
  assert.equal(repository.state.transactions, 1);
  assert.equal(repository.state.calls.some(call => call.type === "human-binding-source"), true);
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.permits.size, 0);
});

test("V4 refuses an active V3 permit or another active V4 permit without command writes", async () => {
  const v3Repository = fixtureRepository({ activeHumanArmed: true });
  assert.deepEqual(await service(v3Repository).queueVisibleChatSyncForHumanBinding({ bindingId: BINDING_ID }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_CONFLICT,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.HUMAN_ARMED_PERMIT_ACTIVE
  });
  assert.equal(v3Repository.state.commands.length, 0);

  const v4Repository = fixtureRepository({ activeSync: true });
  assert.deepEqual(await service(v4Repository).queueVisibleChatSyncForHumanBinding({ bindingId: BINDING_ID }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_CONFLICT,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.SYNC_PERMIT_ACTIVE
  });
  assert.equal(v4Repository.state.commands.length, 0);
});

test("V4 fails closed for an active ISSUED official-app resume permit before command writes", async () => {
  const repository = fixtureRepository({ activeOfficialAppResume: true });
  assert.deepEqual(await service(repository).queueVisibleChatSyncForHumanBinding({ bindingId: BINDING_ID }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_CONFLICT,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.OFFICIAL_APP_RESUME_PERMIT_ACTIVE
  });
  assert.equal(repository.state.calls.some(call => call.type === "find-v5-resume"), true);
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.permits.size, 0);
});

test("V4 fails closed when the official-app resume-permit lookup is indeterminate", async () => {
  const repository = fixtureRepository();
  repository.findActiveOfficialAppResumePermitForDevice = async () => undefined;
  await assert.rejects(
    () => service(repository).queueVisibleChatSyncForHumanBinding({ bindingId: BINDING_ID }),
    error => error instanceof TinderVisibleChatSyncError && error.code === "INVALID_SYNC_REPOSITORY"
  );
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.permits.size, 0);
});


test("V4 PostgreSQL source lock requires the latest revision for the same device/thread", async () => {
  const calls = [];
  const repository = createPgTinderVisibleChatSyncRepository({
    async connect() { throw new Error("not used by this focused repository query"); },
    async query() { throw new Error("not used by this focused repository query"); }
  });
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [{ capture_id: CAPTURE_ID }] };
    }
  };

  assert.equal(await repository.getConfirmedSourceCaptureForUpdate(client, {
    sourceCaptureId: CAPTURE_ID,
    deviceId: DEVICE_ID
  }), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].parameters, [CAPTURE_ID, DEVICE_ID]);
  assert.match(calls[0].sql, /capture\.capture_revision\s*=\s*\(\s*SELECT MAX\(newer\.capture_revision\)/s);
  assert.match(calls[0].sql, /newer\.device_id\s*=\s*capture\.device_id/s);
  assert.match(calls[0].sql, /newer\.runtime_thread_fingerprint\s*=\s*capture\.runtime_thread_fingerprint/s);
  assert.match(calls[0].sql, /FOR UPDATE/);
});

test("V4 V2 final source lock requires the current binding's consumed V3 capture and contact", async () => {
  const calls = [];
  const repository = createPgTinderVisibleChatSyncRepository({
    async connect() { throw new Error("not used by this focused repository query"); },
    async query() { throw new Error("not used by this focused repository query"); }
  });
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows: [{ command_id: COMMAND_ID }] };
    }
  };

  assert.equal(await repository.getConfirmedSourceCaptureForAttestedSyncPermitForUpdate(client, {
    commandId: COMMAND_ID,
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID,
    attestationCommandId: ATTESTATION_COMMAND_ID,
    bindingId: BINDING_ID,
    bindingRevision: 3,
    now: NOW.toISOString()
  }), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].parameters, [
    COMMAND_ID, DEVICE_ID, CAPTURE_ID,
    TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION,
    ATTESTATION_COMMAND_ID, BINDING_ID, 3, NOW.toISOString(), 1,
    "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION",
    "tinder_human_armed_conversation_v1"
  ]);
  assert.match(calls[0].sql, /binding_permit\.consumed_capture_id\s*=\s*permit\.source_capture_id/i);
  assert.match(calls[0].sql, /capture\.resolved_contact_id\s*=\s*binding\.contact_id/i);
  assert.match(calls[0].sql, /capture\.capture_schema_version='tinder-visible-chat-v3'/i);
  assert.match(calls[0].sql, /FOR UPDATE OF attestation, binding, permit, binding_permit, capture/i);
});

test("V4 PostgreSQL human-binding source lock requires the exact live local-attestation tuple", async () => {
  const calls = [];
  let rows = [{
    device_id: DEVICE_ID,
    source_capture_id: CAPTURE_ID,
    attestation_command_id: ATTESTATION_COMMAND_ID,
    binding_id: BINDING_ID,
    binding_revision: 3
  }];
  const repository = createPgTinderVisibleChatSyncRepository({
    async connect() { throw new Error("not used by this focused repository query"); },
    async query() { throw new Error("not used by this focused repository query"); }
  });
  const client = {
    async query(sql, parameters) {
      calls.push({ sql, parameters });
      return { rows };
    }
  };

  assert.deepEqual(await repository.getConfirmedSourceCaptureForAttestedHumanBindingForUpdate(client, {
    bindingId: BINDING_ID,
    now: NOW.toISOString()
  }), rows[0]);
  assert.deepEqual(calls[0].parameters, [
    BINDING_ID,
    "tinder_human_armed_conversation_v1",
    1,
    NOW.toISOString(),
    "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION"
  ]);
  assert.match(calls[0].sql, /binding\.channel='tinder'/i);
  assert.match(calls[0].sql, /binding\.binding_state='CONFIRMED'/i);
  assert.match(calls[0].sql, /binding\.human_verified=TRUE/i);
  assert.match(calls[0].sql, /permit\.binding_revision=binding\.binding_revision/i);
  assert.match(calls[0].sql, /permit\.permit_state='CONSUMED'/i);
  assert.match(calls[0].sql, /attestation\.permit_state='ATTESTED'/i);
  assert.match(calls[0].sql, /attestation\.expires_at>\$4/i);
  assert.match(calls[0].sql, /attestation_command\.command_type=\$5/i);
  assert.match(calls[0].sql, /capture\.capture_schema_version='tinder-visible-chat-v3'/i);
  assert.match(calls[0].sql, /capture\.capture_safety_status='SAFE'/i);
  assert.match(calls[0].sql, /capture\.mapping_status='RESOLVED'/i);
  assert.match(calls[0].sql, /capture\.human_review_status='CONFIRMED'/i);
  assert.match(calls[0].sql, /capture\.resolved_contact_id=binding\.contact_id/i);
  assert.match(calls[0].sql, /MAX\(newer\.capture_revision\)/i);
  assert.match(calls[0].sql, /FOR UPDATE OF binding, attestation, permit, capture/i);
  assert.doesNotMatch(calls[0].sql, /ORDER BY|visible_name|captured_at|received_at|capture_fingerprint|binding\.source_capture_id|reference_hash/i);

  rows = [{ device_id: DEVICE_ID, source_capture_id: CAPTURE_ID }, {
    device_id: DEVICE_ID,
    source_capture_id: COMMAND_ID
  }];
  assert.equal(await repository.getConfirmedSourceCaptureForAttestedHumanBindingForUpdate(client, {
    bindingId: BINDING_ID,
    now: NOW.toISOString()
  }), null);
});

test("V4 PostgreSQL resume conflict lookup accepts only live ISSUED permits", async () => {
  const calls = [];
  const repository = createPgTinderVisibleChatSyncRepository({
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

test("only an exact terminal STAGED ACK can authorize a later V4 transcript transaction", async () => {
  const repository = fixtureRepository({ permits: [{
    command_id: COMMAND_ID,
    device_id: DEVICE_ID,
    source_capture_id: CAPTURE_ID,
    permit_state: "STAGED",
    expires_at: "2026-09-07T12:10:00.000Z",
    command_type: TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
    permit_contract_version: TINDER_VISIBLE_CHAT_SYNC_LEGACY_PERMIT_CONTRACT_VERSION,
    attestation_command_id: null,
    binding_id: null,
    binding_revision: null,
    terminal_status: "SUCCEEDED",
    ack_status: "SUCCEEDED",
    ack_result: TINDER_VISIBLE_CHAT_SYNC_ACK_RESULT
  }] });
  const sync = service(repository);
  const transaction = { ownedByFutureIngress: true };
  const staged = await sync.authorizeStagedVisibleChatSyncPermit(transaction, {
    commandId: COMMAND_ID,
    deviceId: DEVICE_ID
  });
  assert.equal(staged.status, TINDER_VISIBLE_CHAT_SYNC_STATUS.STAGED);
  assert.deepEqual(staged.authorization, { commandId: COMMAND_ID, deviceId: DEVICE_ID, sourceCaptureId: CAPTURE_ID });
  assert.equal(JSON.stringify(staged.authorization).includes("contact"), false);
  assert.equal(JSON.stringify(staged.authorization).includes("fingerprint"), false);

  await assert.rejects(
    () => sync.consumeAuthorizedStagedVisibleChatSyncPermit(transaction, {
      authorization: staged.authorization,
      captureId: COMMAND_ID
    }),
    error => error instanceof TinderVisibleChatSyncError && error.code === "INVALID_SYNC_PERMIT_CONSUME_REQUEST"
  );
  assert.deepEqual(
    await sync.consumeAuthorizedStagedVisibleChatSyncPermit(transaction, { authorization: staged.authorization }),
    { status: TINDER_VISIBLE_CHAT_SYNC_STATUS.CONSUMED }
  );
  assert.equal(repository.state.permits.get(COMMAND_ID).permit_state, "CONSUMED");
});

test("V4 V2 keeps its proof and binding scope process-private after STAGED authorization", async () => {
  const repository = fixtureRepository({ permits: [{
    command_id: COMMAND_ID,
    device_id: DEVICE_ID,
    source_capture_id: CAPTURE_ID,
    permit_state: "STAGED",
    expires_at: "2026-09-07T12:10:00.000Z",
    command_type: TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
    permit_contract_version: TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION,
    attestation_command_id: ATTESTATION_COMMAND_ID,
    binding_id: BINDING_ID,
    binding_revision: 3,
    terminal_status: "SUCCEEDED",
    ack_status: "SUCCEEDED",
    ack_result: TINDER_VISIBLE_CHAT_SYNC_ACK_RESULT
  }] });
  const staged = await service(repository).authorizeStagedVisibleChatSyncPermit({}, {
    commandId: COMMAND_ID,
    deviceId: DEVICE_ID
  });
  assert.equal(staged.status, TINDER_VISIBLE_CHAT_SYNC_STATUS.STAGED);
  assert.deepEqual(staged.authorization, {
    commandId: COMMAND_ID,
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID
  });
  assert.doesNotMatch(JSON.stringify(staged), /attestation|binding|revision/i);
});

test("V4 staged authorization fails closed for an unconfirmed ACK, wrong device, or unavailable V4 capability", async () => {
  const wrongAck = fixtureRepository({ permits: [{
    command_id: COMMAND_ID,
    device_id: DEVICE_ID,
    source_capture_id: CAPTURE_ID,
    permit_state: "STAGED",
    expires_at: "2026-09-07T12:10:00.000Z",
    command_type: TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
    permit_contract_version: TINDER_VISIBLE_CHAT_SYNC_LEGACY_PERMIT_CONTRACT_VERSION,
    attestation_command_id: null,
    binding_id: null,
    binding_revision: null,
    terminal_status: "SUCCEEDED",
    ack_status: "SUCCEEDED",
    ack_result: { tinder_visible_chat_sync: "COMPLETE" }
  }] });
  assert.deepEqual(await service(wrongAck).authorizeStagedVisibleChatSyncPermit({}, {
    commandId: COMMAND_ID,
    deviceId: DEVICE_ID
  }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.PERMIT_ACK_NOT_STAGED
  });

  const staged = fixtureRepository({ permits: [{
    command_id: COMMAND_ID,
    device_id: DEVICE_ID,
    source_capture_id: CAPTURE_ID,
    permit_state: "STAGED",
    expires_at: "2026-09-07T12:10:00.000Z",
    command_type: TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
    permit_contract_version: TINDER_VISIBLE_CHAT_SYNC_LEGACY_PERMIT_CONTRACT_VERSION,
    attestation_command_id: null,
    binding_id: null,
    binding_revision: null,
    terminal_status: "SUCCEEDED",
    ack_status: "SUCCEEDED",
    ack_result: TINDER_VISIBLE_CHAT_SYNC_ACK_RESULT
  }] });
  assert.deepEqual(await service(staged).authorizeStagedVisibleChatSyncPermit({}, {
    commandId: COMMAND_ID,
    deviceId: OTHER_DEVICE_ID
  }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.PERMIT_DEVICE_MISMATCH
  });

  const incompatible = fixtureRepository({
    runtimeByDevice: new Map([[DEVICE_ID, runtime({ capabilities: [] })]])
  });
  assert.deepEqual(await service(incompatible).queueVisibleChatSyncForHumanBinding({ bindingId: BINDING_ID }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.DEVICE_NOT_READY,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.DEVICE_CAPABILITY_UNSUPPORTED
  });
  assert.equal(incompatible.state.commands.length, 0);

  const attestedPermitOnDowngradedRuntime = fixtureRepository({
    runtimeByDevice: new Map([[DEVICE_ID, runtime({ capabilities: T4_RESUME_DEVICE_CAPABILITIES })]]),
    permits: [{
      command_id: COMMAND_ID,
      device_id: DEVICE_ID,
      source_capture_id: CAPTURE_ID,
      permit_state: "STAGED",
      expires_at: "2026-09-07T12:10:00.000Z",
      command_type: TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
      permit_contract_version: TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION,
      attestation_command_id: ATTESTATION_COMMAND_ID,
      binding_id: BINDING_ID,
      binding_revision: 3,
      terminal_status: "SUCCEEDED",
      ack_status: "SUCCEEDED",
      ack_result: TINDER_VISIBLE_CHAT_SYNC_ACK_RESULT
    }]
  });
  assert.deepEqual(await service(attestedPermitOnDowngradedRuntime).authorizeStagedVisibleChatSyncPermit({}, {
    commandId: COMMAND_ID,
    deviceId: DEVICE_ID
  }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.DEVICE_NOT_READY,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.DEVICE_CAPABILITY_UNSUPPORTED
  });
  assert.equal(attestedPermitOnDowngradedRuntime.state.calls.some(call => call.type === "revalidate-attestation"), false);
});
