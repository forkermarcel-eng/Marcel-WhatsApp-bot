import assert from "node:assert/strict";
import test from "node:test";
import {
  CHANNEL_CONVERSATION_BINDING_ACTION,
  CHANNEL_CONVERSATION_BINDING_STATUS,
  createChannelConversationBindingService
} from "../services/channel-conversation-binding.js";

const DEVICE_ID = "36761d7f-2ac3-4da9-9ad4-7fd381665f1e";
const CAPTURE_A = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const CAPTURE_B = "b565e8a7-ef60-42d0-b19d-26e7904390fa";
const CAPTURE_C = "c565e8a7-ef60-42d0-b19d-26e7904390fa";
const BINDING_ID = "d565e8a7-ef60-42d0-b19d-26e7904390fa";
const TOKEN = "a".repeat(64);

function capture({ id = CAPTURE_A, runtime = "b".repeat(64), token = TOKEN, schema = "tinder-visible-chat-v2", safety = "SAFE" } = {}) {
  return {
    capture_id: id,
    device_id: DEVICE_ID,
    capture_schema_version: schema,
    capture_safety_status: safety,
    mapping_status: "NEEDS_HUMAN_MAPPING",
    human_review_status: "PENDING",
    runtime_thread_fingerprint: runtime,
    visible_thread_metadata: schema === "tinder-visible-chat-v2" ? {
      visibleName: "M", threadFingerprint: runtime, headerClassName: "android.widget.TextView",
      threadBindingEvidence: {
        kind: "tinder_accessibility_header_unique_id_hmac_v1",
        role: "HEADER_TITLE", status: "OBSERVED_UNVERIFIED", token
      }
    } : { visibleName: "M", threadFingerprint: runtime, headerClassName: "android.widget.TextView" }
  };
}

function key(candidate) {
  return `${candidate.channel}|${candidate.referenceKind}|${candidate.deviceId}|${candidate.referenceHash}`;
}

function fixtureRepository({ captures = [capture()], contacts = [7], activeBindings = [] } = {}) {
  const rows = new Map(captures.map(row => [row.capture_id, { ...row }]));
  const contactSet = new Set(contacts);
  const bindings = new Map();
  const audits = [];
  const calls = [];
  for (const binding of activeBindings) bindings.set(key({
    channel: binding.channel, referenceKind: binding.reference_kind,
    deviceId: binding.device_id, referenceHash: binding.reference_hash
  }), binding);
  function observations(candidate) {
    return [...rows.values()].filter(row => row.device_id === candidate.deviceId
      && row.visible_thread_metadata?.threadBindingEvidence?.token === candidate.referenceHash);
  }
  return {
    calls, rows, bindings, audits,
    async withTransaction(work) { return work({}); },
    async getCaptureForRead(id) { return rows.get(id) || null; },
    async getCaptureForUpdate(_client, id) { return rows.get(id) || null; },
    async findEvidenceObservations(candidate) { return observations(candidate); },
    async findEvidenceObservationsForUpdate(_client, candidate) { return observations(candidate); },
    async findActiveBinding(candidate) { return bindings.get(key(candidate)) || null; },
    async findActiveBindingForUpdate(_client, candidate) { return bindings.get(key(candidate)) || null; },
    async lockConversationReference(_client, candidate) { calls.push({ type: "lock", candidate }); },
    async getContactForUpdate(_client, contactId) { return contactSet.has(contactId) ? { id: contactId } : null; },
    async createChannelContact(_client, input) {
      calls.push({ type: "create-contact", input });
      const id = 101;
      contactSet.add(id);
      return { id };
    },
    async insertConfirmedBinding(_client, input) {
      const row = {
        binding_id: input.bindingId, channel: input.channel, reference_kind: input.referenceKind,
        reference_hash: input.referenceHash, device_id: input.deviceId, contact_id: input.contactId,
        binding_state: "CONFIRMED", binding_revision: 1, human_verified: true
      };
      bindings.set(key(input), row);
      calls.push({ type: "insert-binding", input });
      return row;
    },
    async updateCaptureMapping(_client, input) {
      calls.push({ type: "update-capture", input });
      Object.assign(rows.get(input.captureId), {
        mapping_status: input.mappingStatus,
        human_review_status: input.humanReviewStatus,
        resolved_contact_id: input.resolvedContactId
      });
    },
    async insertBindingAudit(_client, audit) { audits.push(audit); }
  };
}

function service(repository) {
  return createChannelConversationBindingService(repository, {
    createBindingId: () => BINDING_ID,
    createIdentityKey: () => "tinder_generated_identity_key"
  });
}

test("a legacy capture or one/same-runtime observation cannot become a durable candidate", async () => {
  const legacy = service(fixtureRepository({ captures: [capture({ schema: "tinder-visible-chat-v1" })] }));
  assert.deepEqual(await legacy.getReadiness(CAPTURE_A), {
    status: CHANNEL_CONVERSATION_BINDING_STATUS.LEGACY_CAPTURE
  });

  const one = service(fixtureRepository({ captures: [capture()] }));
  assert.deepEqual(await one.getReadiness(CAPTURE_A), {
    status: CHANNEL_CONVERSATION_BINDING_STATUS.AWAITING_STABILITY_EVIDENCE
  });

  const sameRuntime = service(fixtureRepository({ captures: [
    capture(), capture({ id: CAPTURE_B, runtime: "b".repeat(64) })
  ] }));
  assert.deepEqual(await sameRuntime.getReadiness(CAPTURE_A), {
    status: CHANNEL_CONVERSATION_BINDING_STATUS.AWAITING_STABILITY_EVIDENCE
  });
});

test("two separate runtime observations make only a human-confirmed binding eligible", async () => {
  const repository = fixtureRepository({ captures: [
    capture(), capture({ id: CAPTURE_B, runtime: "c".repeat(64) })
  ] });
  const binding = service(repository);
  assert.deepEqual(await binding.getReadiness(CAPTURE_A), {
    status: CHANNEL_CONVERSATION_BINDING_STATUS.ELIGIBLE_FOR_HUMAN_BINDING
  });

  const result = await binding.confirmBinding({
    captureId: CAPTURE_A,
    action: CHANNEL_CONVERSATION_BINDING_ACTION.BIND_EXISTING,
    contactId: 7,
    confirmed: true,
    // A caller may not influence this route with a token; this ignored field
    // proves service inputs own no client evidence parameter.
    referenceHash: "f".repeat(64)
  });
  assert.deepEqual(result, {
    status: CHANNEL_CONVERSATION_BINDING_STATUS.CONFIRMED,
    contactId: 7,
    idempotent: false
  });
  assert.equal(repository.calls.filter(call => call.type === "insert-binding").length, 1);
  assert.equal(repository.rows.get(CAPTURE_A).resolved_contact_id, 7);
  assert.equal(repository.audits.length, 1);
  assert.deepEqual(repository.audits[0].details, { channel: "tinder" });
  assert.equal(JSON.stringify(repository.audits).includes(TOKEN), false);
  assert.equal(JSON.stringify(repository.calls).includes("contact_identifiers"), false);
});

test("active conversation ownership blocks a different human choice without an overwrite", async () => {
  const active = {
    binding_id: BINDING_ID, channel: "tinder",
    reference_kind: "tinder_accessibility_header_unique_id_hmac_v1",
    reference_hash: TOKEN, device_id: DEVICE_ID, contact_id: 7,
    binding_state: "CONFIRMED", binding_revision: 1, human_verified: true
  };
  const repository = fixtureRepository({
    captures: [capture(), capture({ id: CAPTURE_B, runtime: "c".repeat(64) })],
    contacts: [7, 8], activeBindings: [active]
  });
  const result = await service(repository).confirmBinding({
    captureId: CAPTURE_A, action: CHANNEL_CONVERSATION_BINDING_ACTION.BIND_EXISTING,
    contactId: 8, confirmed: true
  });
  assert.deepEqual(result, { status: CHANNEL_CONVERSATION_BINDING_STATUS.CONFLICT });
  assert.equal(repository.calls.some(call => call.type === "insert-binding"), false);
  assert.equal(repository.rows.get(CAPTURE_A).resolved_contact_id, undefined);
  assert.equal(repository.audits[0].action, "CONFLICT_BLOCKED");
});

test("a conflicting BIND_CREATE never leaves an orphan contact behind", async () => {
  const active = {
    binding_id: BINDING_ID, channel: "tinder",
    reference_kind: "tinder_accessibility_header_unique_id_hmac_v1",
    reference_hash: TOKEN, device_id: DEVICE_ID, contact_id: 7,
    binding_state: "CONFIRMED", binding_revision: 1, human_verified: true
  };
  const repository = fixtureRepository({
    captures: [capture(), capture({ id: CAPTURE_B, runtime: "c".repeat(64) })],
    contacts: [7], activeBindings: [active]
  });
  const result = await service(repository).confirmBinding({
    captureId: CAPTURE_A, action: CHANNEL_CONVERSATION_BINDING_ACTION.BIND_CREATE,
    newContactName: "M Tinder Test", confirmed: true
  });
  assert.deepEqual(result, { status: CHANNEL_CONVERSATION_BINDING_STATUS.CONFLICT });
  assert.equal(repository.calls.some(call => call.type === "create-contact"), false);
  assert.equal(repository.calls.some(call => call.type === "insert-binding"), false);
  assert.equal(repository.calls.some(call => call.type === "update-capture"), false);
  assert.equal(repository.audits.length, 1);
  assert.equal(repository.audits[0].action, "CONFLICT_BLOCKED");
  assert.equal(repository.audits[0].newContactId, null);
});

test("binding confirmation can create a channel-native contact without creating a Tinder profile identifier", async () => {
  const repository = fixtureRepository({ captures: [
    capture(), capture({ id: CAPTURE_B, runtime: "c".repeat(64) })
  ], contacts: [] });
  const result = await service(repository).confirmBinding({
    captureId: CAPTURE_A, action: CHANNEL_CONVERSATION_BINDING_ACTION.BIND_CREATE,
    newContactName: "M Tinder Test", confirmed: true
  });
  assert.equal(result.status, CHANNEL_CONVERSATION_BINDING_STATUS.CONFIRMED);
  assert.equal(result.contactId, 101);
  assert.deepEqual(repository.calls.find(call => call.type === "create-contact").input, {
    canonicalName: "M Tinder Test",
    memoryIdentityKey: "tinder_generated_identity_key",
    sourcePlatform: "tinder",
    currentPlatform: "tinder"
  });
});
