import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DeviceBridgeProtocolError } from "../device-bridge/protocol-v1.js";
import {
  createTinderVisibleChatSyncIngressHandler,
  parseSignedVisibleChatSyncRequest
} from "../device-bridge/tinder-visible-chat-sync-ingress.js";
import {
  createPgTinderVisibleChatSyncRepository
} from "../services/tinder-visible-chat-sync.js";
import { createTinderVisibleChatSyncStore } from "../services/tinder-visible-chat-sync-store.js";
import {
  T4_DEVICE_CAPABILITIES,
  T4_RESUME_ATTESTATION_DEVICE_CAPABILITIES,
  T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES
} from "../device-bridge/protocol-v1.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const COMMAND_ID = "d565e8a7-ef60-42d0-b19d-26e7904390fa";
const CAPTURE_ID = "6ebb6d37-8b69-444a-b22d-390b81860026";
const BINDING_ID = "832d0663-8bb1-4947-ae8a-14a6d9de8924";
const ATTESTATION_COMMAND_ID = "d8e7f31b-90f8-4b37-8aa8-88e6a6efc2b5";
const SYNC_ID = "17b6d374-8b69-444a-b22d-390b81860026";
const KEY_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const NOW = new Date("2026-09-07T14:00:00.000Z");

function syncBody(overrides = {}) {
  return {
    schema_version: "tinder-visible-chat-sync-v1",
    command_id: COMMAND_ID,
    source_package: "com.tinder",
    layout_schema_version: "tinder-zte-visible-chat-scroll-v1",
    sync_started_at: "2026-09-07T13:59:10.000Z",
    sync_completed_at: "2026-09-07T14:00:00.000Z",
    initial_visible_node_count: 36,
    final_visible_node_count: 38,
    segment_count: 2,
    overlap_count: 2,
    transcript_fingerprint: "a".repeat(64),
    messages: [
      { visible_order: 1, text: "Hallo", direction: "INCOMING", source_class_name: "android.view.View" },
      { visible_order: 2, text: "Hi", direction: "OUTGOING", source_class_name: "android.view.View" }
    ],
    safety_status: "SAFE",
    ...overrides
  };
}

function rawRequest(body = { protocol_version: 1, sync: syncBody() }) {
  return {
    body: Buffer.from(JSON.stringify(body), "utf8"),
    params: { deviceId: DEVICE_ID },
    get(name) { return name === "x-marcel-request-id" ? "d6fdcc0f-e5d1-4825-b749-b348a95dfe0e" : undefined; }
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

function stagedPermit(overrides = {}) {
  return {
    command_id: COMMAND_ID,
    device_id: DEVICE_ID,
    source_capture_id: CAPTURE_ID,
    permit_state: "STAGED",
    expires_at: "2026-09-07T14:10:00.000Z",
    command_type: "SYNC_TINDER_VISIBLE_CHAT",
    // Historical V1 permits may complete their already-issued lifecycle;
    // only fresh issuance is prohibited by the V6 service contract.
    permit_contract_version: 1,
    attestation_command_id: null,
    binding_id: null,
    binding_revision: null,
    terminal_status: "SUCCEEDED",
    ack_status: "SUCCEEDED",
    ack_result: { tinder_visible_chat_sync: "STAGED" },
    ...overrides
  };
}

function storeRepository({
  sourceReady = true,
  attestedSourceReady = true,
  permit = stagedPermit(),
  runtimeCapabilities = null
} = {}) {
  const state = { calls: [], inserted: null, permit };
  return {
    state,
    async withTransaction(work) { state.calls.push("BEGIN"); try { const value = await work({}); state.calls.push("COMMIT"); return value; } catch (error) { state.calls.push("ROLLBACK"); throw error; } },
    async getDeviceRuntimeForUpdate() {
      return {
        online: true,
        enrollment_state: "ACTIVE",
        bridge_service_state: "RUNNING",
        tinder_state: "CONNECTED",
        automation_state: "STOPPED",
        capabilities: runtimeCapabilities || (permit.permit_contract_version === 2
          ? T4_RESUME_ATTESTATION_POST_CHAT_DEVICE_CAPABILITIES : T4_DEVICE_CAPABILITIES
        )
      };
    },
    async expireVisibleChatSyncPermits() {},
    async findActiveHumanArmedPermitForDevice() { return false; },
    async findActiveVisibleChatSyncPermitForDevice() { return false; },
    async findActiveOfficialAppResumePermitForDevice() { return false; },
    async getConfirmedSourceCaptureForUpdate(_transaction, input) {
      state.calls.push({ type: "source", input });
      return sourceReady && input.sourceCaptureId === CAPTURE_ID && input.deviceId === DEVICE_ID;
    },
    async getConfirmedSourceCaptureForAttestedSyncPermitForUpdate(_transaction, input) {
      state.calls.push({ type: "attested-source", input });
      return attestedSourceReady
        && input.commandId === COMMAND_ID
        && input.deviceId === DEVICE_ID
        && input.sourceCaptureId === CAPTURE_ID
        && input.attestationCommandId === ATTESTATION_COMMAND_ID
        && input.bindingId === BINDING_ID
        && input.bindingRevision === 3;
    },
    async queueVisibleChatSyncCommand() {},
    async createVisibleChatSyncPermit() {},
    async lookupVisibleChatSyncPermitForAuthorization() {
      return {
        command_id: permit.command_id,
        device_id: permit.device_id,
        permit_contract_version: permit.permit_contract_version,
        attestation_command_id: permit.attestation_command_id,
        binding_id: permit.binding_id,
        binding_revision: permit.binding_revision
      };
    },
    async getVisibleChatSyncPermitForUpdate() { return permit; },
    async revalidateAttestedLocalConversationForSyncPermitForUpdate() {
      return true;
    },
    async insertVisibleChatSyncTranscript(_transaction, input) {
      state.calls.push("INSERT");
      state.inserted = input;
      return { sync_id: SYNC_ID };
    },
    async markVisibleChatSyncPermitConsumed() { state.calls.push("CONSUME"); permit.permit_state = "CONSUMED"; return true; }
  };
}

test("V4 parser accepts only an identity-free envelope and retains only its transcript integrity hash", () => {
  const parsed = parseSignedVisibleChatSyncRequest(rawRequest());
  assert.deepEqual(parsed.messages, [
    { visibleOrder: 1, direction: "INCOMING", text: "Hallo" },
    { visibleOrder: 2, direction: "OUTGOING", text: "Hi" }
  ]);
  const serialized = JSON.stringify(parsed);
  assert.equal(serialized.includes("capture_fingerprint"), false);
  assert.equal(parsed.transcriptFingerprint, "a".repeat(64));
  assert.equal(serialized.includes("source_class_name"), false);
  assert.equal(serialized.includes("visible_name"), false);
  assert.equal(serialized.includes("thread_fingerprint"), false);
  assert.equal(serialized.includes("contact"), false);
  assert.equal(serialized.includes("binding"), false);

  for (const body of [
    { protocol_version: 1, sync: { ...syncBody(), visible_name: "M" } },
    { protocol_version: 1, sync: { ...syncBody(), thread_fingerprint: "b".repeat(64) } },
    { protocol_version: 1, sync: { ...syncBody(), contact_id: 7 } },
    { protocol_version: 1, sync: { ...syncBody(), source_capture_id: CAPTURE_ID } },
    { protocol_version: 1, sync: { ...syncBody(), capture_fingerprint: "a".repeat(64) } },
    { protocol_version: 1, sync: { ...syncBody(), messages: [{ ...syncBody().messages[0], capture_id: CAPTURE_ID }] } }
  ]) {
    assert.throws(() => parseSignedVisibleChatSyncRequest(rawRequest(body)), DeviceBridgeProtocolError);
  }
});

test("V4 store uses only staged server permit source and atomically writes before consume", async () => {
  const repository = storeRepository();
  const store = createTinderVisibleChatSyncStore(repository, {
    now: () => NOW,
    createSyncId: () => SYNC_ID
  });
  const result = await store.storeStagedVisibleChatSync({ deviceId: DEVICE_ID, sync: syncBody() });
  assert.deepEqual(result, { status: "ACCEPTED" });
  assert.equal(repository.state.calls.indexOf("INSERT") < repository.state.calls.indexOf("CONSUME"), true);
  assert.equal(repository.state.permit.permit_state, "CONSUMED");
  assert.equal(repository.state.inserted.sourceCaptureId, CAPTURE_ID);
  assert.equal(repository.state.inserted.transcriptFingerprint, "a".repeat(64));
  assert.equal(JSON.stringify(repository.state.inserted).includes("sourceClass"), false);
  assert.equal(JSON.stringify(repository.state.inserted).includes("visibleName"), false);
  assert.equal(JSON.stringify(repository.state.inserted).includes("thread"), false);
});

test("V4 rechecks the source immediately before persistence and blocks a now-stale revision", async () => {
  const repository = storeRepository({ sourceReady: false });
  const store = createTinderVisibleChatSyncStore(repository, {
    now: () => NOW,
    createSyncId: () => SYNC_ID
  });

  assert.deepEqual(await store.storeStagedVisibleChatSync({ deviceId: DEVICE_ID, sync: syncBody() }), {
    status: "PERMIT_NOT_AVAILABLE",
    reasonCode: "SOURCE_CAPTURE_NOT_CONFIRMED"
  });
  assert.equal(repository.state.calls.includes("INSERT"), false);
  assert.equal(repository.state.calls.includes("CONSUME"), false);
  assert.equal(repository.state.permit.permit_state, "STAGED");
  assert.deepEqual(repository.state.calls.find(call => call?.type === "source"), {
    type: "source",
    input: { sourceCaptureId: CAPTURE_ID, deviceId: DEVICE_ID }
  });
});

test("V4 V2 ingress rejects a source remapped away from the current confirmed binding", async () => {
  const repository = storeRepository({
    attestedSourceReady: false,
    permit: stagedPermit({
      permit_contract_version: 2,
      attestation_command_id: ATTESTATION_COMMAND_ID,
      binding_id: BINDING_ID,
      binding_revision: 3
    })
  });
  const store = createTinderVisibleChatSyncStore(repository, {
    now: () => NOW,
    createSyncId: () => SYNC_ID
  });

  assert.deepEqual(await store.storeStagedVisibleChatSync({ deviceId: DEVICE_ID, sync: syncBody() }), {
    status: "PERMIT_NOT_AVAILABLE",
    reasonCode: "SOURCE_CAPTURE_NOT_CONFIRMED"
  });
  assert.equal(repository.state.calls.some(call => call?.type === "source"), false);
  assert.equal(repository.state.calls.some(call => call?.type === "attested-source"), true);
  assert.equal(repository.state.calls.includes("INSERT"), false);
  assert.equal(repository.state.calls.includes("CONSUME"), false);
  assert.equal(repository.state.permit.permit_state, "STAGED");
});

test("V4 V2 ingress rejects the legacy V1 attestation profile before transcript persistence", async () => {
  const repository = storeRepository({
    runtimeCapabilities: T4_RESUME_ATTESTATION_DEVICE_CAPABILITIES,
    permit: stagedPermit({
      permit_contract_version: 2,
      attestation_command_id: ATTESTATION_COMMAND_ID,
      binding_id: BINDING_ID,
      binding_revision: 3
    })
  });
  const store = createTinderVisibleChatSyncStore(repository, {
    now: () => NOW,
    createSyncId: () => SYNC_ID
  });
  assert.deepEqual(await store.storeStagedVisibleChatSync({ deviceId: DEVICE_ID, sync: syncBody() }), {
    status: "DEVICE_NOT_READY",
    reasonCode: "DEVICE_CAPABILITY_UNSUPPORTED"
  });
  assert.equal(repository.state.calls.includes("INSERT"), false);
  assert.equal(repository.state.calls.includes("CONSUME"), false);
});

test("V4 PostgreSQL insert persists only the command-scoped transcript fingerprint and bound tuple", async () => {
  const calls = [];
  const repository = createPgTinderVisibleChatSyncRepository({
    async connect() { throw new Error("not used"); },
    async query() { throw new Error("not used"); }
  });
  const client = {
    async query(sql, values) {
      calls.push({ sql: String(sql), values });
      return { rows: [{ sync_id: SYNC_ID }] };
    }
  };
  const sync = parseSignedVisibleChatSyncRequest(rawRequest());
  const stored = await repository.insertVisibleChatSyncTranscript(client, {
    syncId: SYNC_ID,
    sourceCaptureId: CAPTURE_ID,
    deviceId: DEVICE_ID,
    ...sync,
    receivedAt: NOW.toISOString()
  });
  assert.deepEqual(stored, { sync_id: SYNC_ID });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /command_id, source_capture_id, device_id/i);
  assert.match(calls[0].sql, /transcript_fingerprint/i);
  assert.doesNotMatch(calls[0].sql, /capture_fingerprint/i);
  assert.equal(calls[0].values[1], COMMAND_ID);
  assert.equal(calls[0].values[2], CAPTURE_ID);
  assert.equal(calls[0].values[3], DEVICE_ID);
  assert.equal(calls[0].values[13], "a".repeat(64));
  assert.equal(JSON.stringify(calls[0].values).includes("source_class_name"), false);
});

test("V4 HTTP ingress requires authentication and returns only bounded acceptance", async () => {
  let received;
  const handler = createTinderVisibleChatSyncIngressHandler({}, {
    now: () => NOW,
    async verifyRequest({ urlDeviceId }) {
      assert.equal(urlDeviceId, DEVICE_ID);
      return { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "d6fdcc0f-e5d1-4825-b749-b348a95dfe0e", contentSha256: "c".repeat(64) };
    },
    createAuthenticatedStore(_pool, auth) {
      assert.equal(auth.deviceId, DEVICE_ID);
      return { async storeStagedVisibleChatSync(input) { received = input; return { status: "ACCEPTED" }; } };
    }
  });
  const res = responseRecorder();
  await handler(rawRequest(), res);
  assert.equal(res.statusCode, 201);
  assert.equal(received.deviceId, DEVICE_ID);
  assert.deepEqual(res.body.sync, { command_id: COMMAND_ID, status: "ACCEPTED" });
  assert.equal(JSON.stringify(res.body).includes(CAPTURE_ID), false);
  assert.equal(JSON.stringify(res.body).includes("Hallo"), false);
});

test("V4 ingress remains signed-only and cannot reach WhatsApp, drafts, sends, or raw SQL", () => {
  const source = readFileSync(new URL("../device-bridge/tinder-visible-chat-sync-ingress.js", import.meta.url), "utf8");
  assert.match(source, /verifyAuthenticatedDeviceRequest/);
  assert.match(source, /registerAuthenticatedRequestReplay/);
  assert.match(source, /app\.post\(/);
  assert.doesNotMatch(source, /app\.get\(/);
  assert.doesNotMatch(source, /dashboard-api/);
  assert.doesNotMatch(source, /whatsapp_jid/i);
  assert.doesNotMatch(source, /SEND_TINDER_DRAFT/);
  assert.doesNotMatch(source, /CREATE\s+TABLE/i);
  assert.doesNotMatch(source, /ALTER\s+TABLE/i);
});
