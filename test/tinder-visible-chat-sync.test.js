import assert from "node:assert/strict";
import test from "node:test";
import {
  createPgTinderVisibleChatSyncRepository,
  createTinderVisibleChatSyncService,
  TinderVisibleChatSyncError,
  TINDER_VISIBLE_CHAT_SYNC_ACK_RESULT,
  TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
  TINDER_VISIBLE_CHAT_SYNC_REASON,
  TINDER_VISIBLE_CHAT_SYNC_STATUS
} from "../services/tinder-visible-chat-sync.js";
import { T4_DEVICE_CAPABILITIES } from "../device-bridge/protocol-v1.js";

const DEVICE_ID = "36761d7f-2ac3-4da9-9ad4-7fd381665f1e";
const OTHER_DEVICE_ID = "46761d7f-2ac3-4da9-9ad4-7fd381665f1e";
const COMMAND_ID = "d565e8a7-ef60-42d0-b19d-26e7904390fa";
const CAPTURE_ID = "6ebb6d37-8b69-444a-b22d-390b81860026";
const NOW = new Date("2026-09-07T12:00:00.000Z");

function runtime(overrides = {}) {
  return {
    online: true,
    enrollment_state: "ACTIVE",
    bridge_service_state: "RUNNING",
    tinder_state: "CONNECTED",
    automation_state: "STOPPED",
    capabilities: T4_DEVICE_CAPABILITIES,
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
    async getConfirmedSourceCaptureForUpdate(_transaction, input) {
      state.calls.push({ type: "source-capture", input });
      return sourceConfirmed && sourceCaptureIsLatest;
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
        terminal_status: null,
        ack_status: null,
        ack_result: null
      });
    },
    async getVisibleChatSyncPermitForUpdate(_transaction, commandId) {
      return permitRows.get(commandId) || null;
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

test("V4 queues exactly one typed empty-payload command and opaque separate permit", async () => {
  const repository = fixtureRepository();
  const result = await service(repository).queueVisibleChatSync({ deviceId: DEVICE_ID, sourceCaptureId: CAPTURE_ID });

  assert.deepEqual(result, { status: TINDER_VISIBLE_CHAT_SYNC_STATUS.QUEUED });
  assert.deepEqual(repository.state.commands, [{
    commandId: COMMAND_ID,
    deviceId: DEVICE_ID,
    commandType: TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
    payload: {},
    expiresAt: "2026-09-07T12:10:00.000Z"
  }]);
  assert.deepEqual(repository.state.permits.get(COMMAND_ID), {
    command_id: COMMAND_ID,
    device_id: DEVICE_ID,
    source_capture_id: CAPTURE_ID,
    permit_state: "ISSUED",
    expires_at: "2026-09-07T12:10:00.000Z",
    command_type: TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
    terminal_status: null,
    ack_status: null,
    ack_result: null
  });
  assert.equal(Object.keys(repository.state.commands[0].payload).length, 0);
  assert.equal(JSON.stringify({ result, state: repository.state }).includes("Sandry"), false);
  assert.equal(JSON.stringify({ result, state: repository.state }).includes("fingerprint"), false);
  assert.equal(JSON.stringify(result).includes(COMMAND_ID), false);
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

test("V4 refuses an active V3 permit or another active V4 permit without command writes", async () => {
  const v3Repository = fixtureRepository({ activeHumanArmed: true });
  assert.deepEqual(await service(v3Repository).queueVisibleChatSync({ deviceId: DEVICE_ID, sourceCaptureId: CAPTURE_ID }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_CONFLICT,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.HUMAN_ARMED_PERMIT_ACTIVE
  });
  assert.equal(v3Repository.state.commands.length, 0);

  const v4Repository = fixtureRepository({ activeSync: true });
  assert.deepEqual(await service(v4Repository).queueVisibleChatSync({ deviceId: DEVICE_ID, sourceCaptureId: CAPTURE_ID }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_CONFLICT,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.SYNC_PERMIT_ACTIVE
  });
  assert.equal(v4Repository.state.commands.length, 0);
});

test("V4 fails closed for an active ISSUED official-app resume permit before command writes", async () => {
  const repository = fixtureRepository({ activeOfficialAppResume: true });
  assert.deepEqual(await service(repository).queueVisibleChatSync({
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID
  }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_CONFLICT,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.OFFICIAL_APP_RESUME_PERMIT_ACTIVE
  });
  assert.deepEqual(repository.state.calls.map(call => call.type), [
    "expire", "find-v3", "find-v4", "find-v5-resume"
  ]);
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.permits.size, 0);
});

test("V4 fails closed when the official-app resume-permit lookup is indeterminate", async () => {
  const repository = fixtureRepository();
  repository.findActiveOfficialAppResumePermitForDevice = async () => undefined;
  await assert.rejects(
    () => service(repository).queueVisibleChatSync({ deviceId: DEVICE_ID, sourceCaptureId: CAPTURE_ID }),
    error => error instanceof TinderVisibleChatSyncError && error.code === "INVALID_SYNC_REPOSITORY"
  );
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.permits.size, 0);
});

test("V4 queues only for a server-confirmed source capture on the same device", async () => {
  const repository = fixtureRepository({ sourceConfirmed: false });
  assert.deepEqual(await service(repository).queueVisibleChatSync({
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID
  }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.SOURCE_CAPTURE_NOT_CONFIRMED
  });
  assert.equal(repository.state.commands.length, 0);
  assert.equal(repository.state.permits.size, 0);
});

test("V4 refuses a stale confirmed source capture before command or permit creation", async () => {
  const repository = fixtureRepository({ sourceCaptureIsLatest: false });
  assert.deepEqual(await service(repository).queueVisibleChatSync({
    deviceId: DEVICE_ID,
    sourceCaptureId: CAPTURE_ID
  }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.SOURCE_CAPTURE_NOT_CONFIRMED
  });
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

test("V4 staged authorization fails closed for an unconfirmed ACK, wrong device, or unavailable V4 capability", async () => {
  const wrongAck = fixtureRepository({ permits: [{
    command_id: COMMAND_ID,
    device_id: DEVICE_ID,
    source_capture_id: CAPTURE_ID,
    permit_state: "STAGED",
    expires_at: "2026-09-07T12:10:00.000Z",
    command_type: TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
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
  assert.deepEqual(await service(incompatible).queueVisibleChatSync({ deviceId: DEVICE_ID, sourceCaptureId: CAPTURE_ID }), {
    status: TINDER_VISIBLE_CHAT_SYNC_STATUS.DEVICE_NOT_READY,
    reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.DEVICE_CAPABILITY_UNSUPPORTED
  });
  assert.equal(incompatible.state.commands.length, 0);
});
