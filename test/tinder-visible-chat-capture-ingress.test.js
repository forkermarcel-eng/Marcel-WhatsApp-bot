import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DeviceBridgeProtocolError, T1_DEVICE_CAPABILITIES } from "../device-bridge/protocol-v1.js";
import { TinderCaptureValidationError } from "../services/tinder-capture-store.js";
import {
  createAuthenticatedCaptureStore,
  createTinderCaptureIngressHandler,
  createTinderPassiveReadCaptureIngressHandler,
  createTinderPassiveReadDuplicateReprojectionProofIngressHandler,
  normalizeCaptureRecord,
  normalizePassiveReadProductConversationOutcome,
  parseSignedCaptureRequest,
  registerTinderPassiveReadCaptureIngress,
  registerTinderPassiveReadDuplicateReprojectionProofIngress
} from "../device-bridge/tinder-visible-chat-capture-ingress.js";
import {
  assertDeviceBridgeAuthReplaySchemaReady,
  assertTinderPassiveReadIngressSchemaReady,
  createTinderPassiveReadIngressFoundationMiddleware
} from "../device-bridge/tinder-passive-read-readiness.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const KEY_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const CAPTURE_ID = "6c7308cf-5d40-423d-913b-c4424f0e4ee0";
const NOW = new Date("2026-09-04T18:01:00.000Z");

function safeCapture() {
  return {
    captureMetadata: {
      schemaVersion: "tinder-visible-chat-v1",
      sourcePackage: "com.tinder",
      capturedAt: "2026-09-04T18:00:00.000Z",
      visibleNodeCount: 2,
      captureFingerprint: "a".repeat(64)
    },
    visibleThreadMetadata: {
      visibleName: "Sandry",
      threadFingerprint: "b".repeat(64),
      headerClassName: "fixture.Header"
    },
    visibleMessages: [{ visibleOrder: 1, direction: "INCOMING", text: "Hallo" }],
    safetyStatus: "SAFE"
  };
}

function safeCaptureV2() {
  const capture = safeCapture();
  return {
    ...capture,
    captureMetadata: {
      ...capture.captureMetadata,
      schemaVersion: "tinder-visible-chat-v2"
    }
  };
}

function storedCapture() {
  return {
    capture_id: CAPTURE_ID,
    device_id: DEVICE_ID,
    capture_revision: 1,
    mapping_status: "NEEDS_HUMAN_MAPPING",
    human_review_status: "PENDING",
    visible_thread_metadata: { visible_name: "Sandry", thread_fingerprint: "b".repeat(64) },
    visible_messages: [{ visible_order: 1, text: "Hallo", direction: "INCOMING" }],
    source_package: "com.tinder",
    captured_at: "2026-09-04T18:00:00.000Z",
    received_at: "2026-09-04T18:01:00.000Z"
  };
}

function rawRequest(body = { protocol_version: 1, capture: safeCapture() }) {
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

test("signed capture request permits only the exact protocol envelope", () => {
  assert.deepEqual(parseSignedCaptureRequest(rawRequest()), safeCapture());
  for (const body of [
    { protocol_version: 1, capture: safeCapture(), contact_id: 7 },
    { protocol_version: 2, capture: safeCapture() },
    { protocol_version: 1, capture: [] }
  ]) {
    assert.throws(() => parseSignedCaptureRequest(rawRequest(body)), DeviceBridgeProtocolError);
  }
});

test("capture ingress binds the authenticated URL device and server-owned provenance", async () => {
  let received;
  const handler = createTinderCaptureIngressHandler({}, {
    now: () => NOW,
    async verifyRequest({ urlDeviceId }) {
      assert.equal(urlDeviceId, DEVICE_ID);
      return { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "d6fdcc0f-e5d1-4825-b749-b348a95dfe0e", contentSha256: "c".repeat(64) };
    },
    createAuthenticatedStore(_pool, auth, options) {
      assert.equal(auth.deviceId, DEVICE_ID);
      assert.equal(options.now(), NOW);
      return {
        async storeSafeCapture(input) {
          received = input;
          return storedCapture();
        }
      };
    }
  });
  const res = responseRecorder();
  await handler(rawRequest(), res);

  assert.equal(res.statusCode, 201);
  assert.equal(received.deviceId, DEVICE_ID);
  assert.deepEqual(received.provenance, { source: "android_visible_chat", protocolVersion: 1 });
  assert.equal(received.capture.visibleThreadMetadata.visibleName, "Sandry");
  assert.deepEqual(res.body.capture, {
    capture_id: CAPTURE_ID,
    device_id: DEVICE_ID,
    capture_revision: 1,
    mapping_status: "NEEDS_HUMAN_MAPPING",
    human_review_status: "PENDING",
    visible_name: "Sandry",
    source_package: "com.tinder",
    captured_at: "2026-09-04T18:00:00.000Z",
    received_at: "2026-09-04T18:01:00.000Z"
  });
  assert.equal(Object.hasOwn(res.body.capture, "visible_messages"), false);
  assert.equal(Object.hasOwn(res.body.capture, "thread_fingerprint"), false);
});

test("passive read ingress accepts only signed V2 captures and disables legacy fingerprint resolution", async () => {
  let received;
  const productConversationId = "d180455d-325c-4f35-9914-823dcb0e0d18";
  const handler = createTinderPassiveReadCaptureIngressHandler({}, {
    now: () => NOW,
    async verifyRequest() {
      return { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "d6fdcc0f-e5d1-4825-b749-b348a95dfe0e", contentSha256: "c".repeat(64) };
    },
    createAuthenticatedStore(_pool, auth, options) {
      assert.equal(auth.deviceId, DEVICE_ID);
      assert.equal(options.requireRuntimeGates, false);
      assert.equal(options.requireLegacyDeviceRuntimeAdmission, false);
      assert.equal(options.requireAutomationStopped, false);
      assert.equal(options.allowLegacyFingerprintMapping, false);
      assert.equal(options.projectProductConversations, true);
      return {
        async storeSafeCaptureWithDisposition(input) {
          received = input;
          return {
            capture: storedCapture(),
            captureDisposition: "CREATED",
            productConversation: {
              disposition: "CREATED",
              conversationId: productConversationId,
              historyState: "PARTIAL",
              readDisposition: "FULL_READ_REQUIRED"
            }
          };
        }
      };
    }
  });
  const res = responseRecorder();
  await handler(rawRequest({ protocol_version: 1, capture: safeCaptureV2() }), res);

  assert.equal(res.statusCode, 201);
  assert.equal(received.capture.captureMetadata.schemaVersion, "tinder-visible-chat-v2");
  assert.deepEqual(received.provenance, {
    source: "android_visible_chat",
    protocolVersion: 1,
    readChannel: "PASSIVE_READ"
  });
  assert.equal(JSON.stringify(res.body).includes(productConversationId), false);
  assert.deepEqual(res.body.product_conversation, {
    disposition: "CREATED",
    history_state: "PARTIAL",
    read_disposition: "FULL_READ_REQUIRED"
  });
  assert.equal(JSON.stringify(res.body.product_conversation).includes("conversationId"), false);

  const rejected = responseRecorder();
  await handler(rawRequest(), rejected);
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.body.error.code, "INVALID_TINDER_CAPTURE_REQUEST");
});

test("passive product outcomes reject incoherent full-read and skip combinations", () => {
  assert.deepEqual(
    normalizePassiveReadProductConversationOutcome({
      disposition: "IDEMPOTENT_DUPLICATE",
      historyState: "PARTIAL",
      readDisposition: "UNCHANGED"
    }),
    {
      disposition: "IDEMPOTENT_DUPLICATE",
      history_state: "PARTIAL",
      read_disposition: "UNCHANGED"
    }
  );
  assert.deepEqual(
    normalizePassiveReadProductConversationOutcome({
      disposition: "NOT_READY"
    }),
    {
      disposition: "NOT_READY",
      history_state: null,
      read_disposition: "FULL_READ_REQUIRED"
    }
  );
  // A direct full-reader fallback can create its first Conversation after it
  // has already reached the oldest boundary. It remains a full-read result;
  // only CREATED + UNCHANGED/DELTA would be incoherent.
  assert.deepEqual(
    normalizePassiveReadProductConversationOutcome({
      disposition: "CREATED",
      historyState: "COMPLETE",
      readDisposition: "FULL_READ_REQUIRED"
    }),
    {
      disposition: "CREATED",
      history_state: "COMPLETE",
      read_disposition: "FULL_READ_REQUIRED"
    }
  );

  for (const malformed of [
    {
      disposition: "CREATED",
      historyState: "COMPLETE",
      readDisposition: "UNCHANGED"
    },
    {
      disposition: "UPDATED",
      historyState: "PARTIAL",
      readDisposition: "DELTA_ACCEPTED"
    },
    {
      disposition: "IDEMPOTENT_DUPLICATE",
      historyState: "PARTIAL",
      readDisposition: "FULL_READ_REQUIRED"
    },
    {
      disposition: "NOT_READY",
      historyState: "PARTIAL",
      readDisposition: "FULL_READ_REQUIRED"
    },
    {
      disposition: "NOT_READY",
      readDisposition: "UNCHANGED"
    }
  ]) {
    assert.throws(
      () => normalizePassiveReadProductConversationOutcome(malformed),
      error => error instanceof DeviceBridgeProtocolError
        && error.code === "INVALID_TINDER_PRODUCT_CONVERSATION_OUTCOME"
    );
  }
});

test("duplicate-only reprojection proof is passive V2, returns no product identifier, and enables only its in-transaction proof policy", async () => {
  let received;
  const handler = createTinderPassiveReadDuplicateReprojectionProofIngressHandler({}, {
    now: () => NOW,
    async verifyRequest() {
      return { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "d6fdcc0f-e5d1-4825-b749-b348a95dfe0e", contentSha256: "c".repeat(64) };
    },
    createAuthenticatedStore(_pool, auth, options) {
      assert.equal(auth.deviceId, DEVICE_ID);
      assert.equal(options.requireRuntimeGates, false);
      assert.equal(options.requireLegacyDeviceRuntimeAdmission, false);
      assert.equal(options.requireAutomationStopped, false);
      assert.equal(options.allowLegacyFingerprintMapping, false);
      assert.equal(options.projectProductConversations, true);
      assert.equal(options.requireExistingDuplicate, true);
      assert.equal(options.reprojectExistingDuplicate, true);
      assert.equal(options.verifyExistingDuplicateReprojection, true);
      return {
        async storeSafeCaptureWithDisposition(input) {
          received = input;
          return {
            capture: storedCapture(),
            captureDisposition: "IDEMPOTENT_DUPLICATE",
            productConversation: {
              disposition: "CREATED",
              conversationId: "d180455d-325c-4f35-9914-823dcb0e0d18"
            }
          };
        }
      };
    }
  });
  const res = responseRecorder();
  await handler(rawRequest({ protocol_version: 1, capture: safeCaptureV2() }), res);

  assert.equal(res.statusCode, 201);
  assert.deepEqual(received.provenance, {
    source: "android_visible_chat",
    protocolVersion: 1,
    readChannel: "PASSIVE_READ"
  });
  assert.equal(JSON.stringify(res.body).includes("d180455d-325c-4f35-9914-823dcb0e0d18"), false);
  assert.equal(Object.hasOwn(res.body, "product_conversation"), false);
  assert.deepEqual(res.body.capture, { capture_id: CAPTURE_ID });
  assert.equal(JSON.stringify(res.body).includes("Sandry"), false);
  assert.equal(Object.hasOwn(res.body, "server_time"), false);
});

test("duplicate-only reprojection proof reports an exact-miss fail-closed without a capture result", async () => {
  const handler = createTinderPassiveReadDuplicateReprojectionProofIngressHandler({}, {
    async verifyRequest() {
      return { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "d6fdcc0f-e5d1-4825-b749-b348a95dfe0e", contentSha256: "c".repeat(64) };
    },
    createAuthenticatedStore() {
      return {
        async storeSafeCaptureWithDisposition() {
          throw new TinderCaptureValidationError(
            "exact duplicate required",
            "IDEMPOTENT_DUPLICATE_REQUIRED"
          );
        }
      };
    }
  });
  const res = responseRecorder();
  await handler(rawRequest({ protocol_version: 1, capture: safeCaptureV2() }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.code, "IDEMPOTENT_DUPLICATE_REQUIRED");
  assert.equal(Object.hasOwn(res.body, "capture"), false);
});

test("duplicate-only proof rolls back its replay nonce and creates no capture on an exact-miss", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql: String(sql), values });
      return { rows: [] };
    },
    release() {}
  };
  const repository = {
    async nextCaptureRevision() { return 1; },
    async findCaptureByFingerprint() { return null; },
    async insertCapture() { throw new Error("must not insert"); },
    async findReusableConfirmedMapping() { return null; },
    async findCaptureById() { return null; },
    async findPendingHumanMappingCaptures() { return []; }
  };
  const store = createAuthenticatedCaptureStore({
    query() {},
    async connect() { return client; }
  }, {
    deviceId: DEVICE_ID,
    keyId: KEY_ID,
    requestId: "d6fdcc0f-e5d1-4825-b749-b348a95dfe0e",
    contentSha256: "c".repeat(64)
  }, {
    now: () => NOW,
    requireRuntimeGates: false,
    requireLegacyDeviceRuntimeAdmission: false,
    requireAutomationStopped: false,
    allowLegacyFingerprintMapping: false,
    projectProductConversations: true,
    reprojectExistingDuplicate: true,
    verifyExistingDuplicateReprojection: true,
    requireExistingDuplicate: true,
    createRepository: () => repository
  });

  await assert.rejects(
    () => store.storeSafeCaptureWithDisposition({
      deviceId: DEVICE_ID,
      capture: safeCaptureV2(),
      provenance: {
        source: "android_visible_chat", protocolVersion: 1, readChannel: "PASSIVE_READ"
      }
    }),
    (error) => error instanceof TinderCaptureValidationError
      && error.code === "IDEMPOTENT_DUPLICATE_REQUIRED"
  );
  assert.equal(calls.some(({ sql }) => /device_bridge_request_nonces/.test(sql)), true);
  assert.equal(calls.some(({ sql }) => /tinder_visible_chat_captures/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /COMMIT/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /ROLLBACK/.test(sql)), true);
});

test("authenticated capture store wires the additive product projector only when explicitly enabled", () => {
  const projector = { async projectCapture() { return { disposition: "NOT_READY", conversationId: null }; } };
  let receivedProductRepository = null;
  let receivedOptions = null;
  const captureRepository = {
    withTransaction() {},
    nextCaptureRevision() {},
    insertCapture() {},
    findCaptureByFingerprint() {},
    findReusableConfirmedMapping() {},
    findCaptureById() {},
    findPendingHumanMappingCaptures() {}
  };
  const pool = { query() {}, connect() {} };
  const auth = { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "d6fdcc0f-e5d1-4825-b749-b348a95dfe0e", contentSha256: "c".repeat(64) };
  const createStore = (_repository, options) => {
    receivedOptions = options;
    return { storeSafeCapture() {} };
  };

  createAuthenticatedCaptureStore(pool, auth, {
    createRepository: () => captureRepository,
    createStore,
    createProductConversationRepository(received) {
      receivedProductRepository = received;
      return { ignored: true };
    },
    createProductConversationService() { return projector; },
    projectProductConversations: true
  });

  assert.equal(receivedProductRepository, pool);
  assert.equal(receivedOptions.productConversationProjector, projector);

  receivedProductRepository = null;
  receivedOptions = null;
  createAuthenticatedCaptureStore(pool, auth, {
    createRepository: () => captureRepository,
    createStore,
    createProductConversationRepository() { throw new Error("must remain inert"); },
    projectProductConversations: false
  });
  assert.equal(receivedProductRepository, null);
  assert.equal(receivedOptions.productConversationProjector, null);
});

test("capture ingress is fail closed when the standalone T2 capture storage schema is absent", async () => {
  const handler = createTinderCaptureIngressHandler({}, {
    async verifyRequest() {
      return { deviceId: DEVICE_ID, keyId: KEY_ID, requestId: "d6fdcc0f-e5d1-4825-b749-b348a95dfe0e", contentSha256: "c".repeat(64) };
    },
    createAuthenticatedStore() {
      return { async storeSafeCapture() { const error = new Error("missing relation"); error.code = "42P01"; throw error; } };
    }
  });
  const res = responseRecorder();
  await handler(rawRequest(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error.code, "TINDER_IDENTITY_FOUNDATION_NOT_READY");
});

test("capture persistence registers replay protection and capture storage in one transaction", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/SELECT d\.device_id/.test(sql)) {
        return {
          rows: [{
            device_id: DEVICE_ID,
            enrollment_state: "ACTIVE",
            revoked_at: null,
            key_revoked_at: null,
            last_accepted_heartbeat_at: NOW,
            bridge_service_state: "RUNNING",
            tinder_state: "CONNECTED",
            automation_state: "STOPPED",
            capabilities: T1_DEVICE_CAPABILITIES
          }]
        };
      }
      return { rows: [] };
    },
    release() { calls.push({ sql: "RELEASE" }); }
  };
  const pool = { async connect() { return client; } };
  const repository = {
    async findCaptureByFingerprint() { return null; },
    async nextCaptureRevision() { return 1; },
    async insertCapture() { return storedCapture(); },
    async findCaptureById() { return null; }
  };
  const store = createAuthenticatedCaptureStore(pool, {
    deviceId: DEVICE_ID,
    keyId: KEY_ID,
    requestId: "d6fdcc0f-e5d1-4825-b749-b348a95dfe0e",
    contentSha256: "c".repeat(64)
  }, {
    now: () => NOW,
    createRepository() { return repository; },
    createStore(transactionRepository) {
      return {
        async storeSafeCapture() {
          return transactionRepository.withTransaction(async (transaction) => {
            await transaction.query("INSERT INTO tinder_visible_chat_captures (capture_id) VALUES ($1)", [CAPTURE_ID]);
            return storedCapture();
          });
        }
      };
    }
  });

  await store.storeSafeCapture({});
  const orderedSql = calls.map((call) => call.sql);
  assert.ok(orderedSql.indexOf("BEGIN") < orderedSql.findIndex((sql) => /SELECT d\.device_id/.test(sql)));
  assert.ok(orderedSql.findIndex((sql) => /SELECT d\.device_id/.test(sql)) < orderedSql.findIndex((sql) => /device_bridge_request_nonces/.test(sql)));
  assert.ok(orderedSql.findIndex((sql) => /device_bridge_request_nonces/.test(sql)) < orderedSql.findIndex((sql) => /tinder_visible_chat_captures/.test(sql)));
  assert.ok(orderedSql.findIndex((sql) => /tinder_visible_chat_captures/.test(sql)) < orderedSql.indexOf("COMMIT"));
  assert.equal(orderedSql.includes("ROLLBACK"), false);
});

test("capture ingress fails closed before replay or persistence when the T1 gate is not connected", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (/SELECT d\.device_id/.test(sql)) {
        return {
          rows: [{
            device_id: DEVICE_ID,
            enrollment_state: "ACTIVE",
            revoked_at: null,
            key_revoked_at: null,
            last_accepted_heartbeat_at: NOW,
            bridge_service_state: "RUNNING",
            tinder_state: "DISCONNECTED",
            automation_state: "STOPPED",
            capabilities: T1_DEVICE_CAPABILITIES
          }]
        };
      }
      return { rows: [] };
    },
    release() {}
  };
  const pool = { async connect() { return client; } };
  const store = createAuthenticatedCaptureStore(pool, {
    deviceId: DEVICE_ID,
    keyId: KEY_ID,
    requestId: "d6fdcc0f-e5d1-4825-b749-b348a95dfe0e",
    contentSha256: "c".repeat(64)
  }, {
    now: () => NOW,
    createRepository() {
      return {
        async findCaptureByFingerprint() { return null; },
        async nextCaptureRevision() { return 1; },
        async insertCapture() { throw new Error("must not persist"); },
        async findCaptureById() { return null; }
      };
    },
    createStore(transactionRepository) {
      return { async storeSafeCapture() { return transactionRepository.withTransaction(async () => storedCapture()); } };
    }
  });

  await assert.rejects(
    () => store.storeSafeCapture({}),
    (error) => error instanceof DeviceBridgeProtocolError && error.code === "TINDER_GATE_NOT_CONNECTED"
  );
  assert.equal(calls.some((sql) => /device_bridge_request_nonces/.test(sql)), false);
  assert.equal(calls.some((sql) => /tinder_visible_chat_captures/.test(sql)), false);
  assert.equal(calls.includes("ROLLBACK"), true);
});

test("passive read storage uses signed request replay without legacy runtime admission", async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/SELECT d\.device_id/.test(sql)) {
        throw new Error("passive ingress must not read legacy runtime admission");
      }
      return { rows: [] };
    },
    release() {}
  };
  const store = createAuthenticatedCaptureStore({ async connect() { return client; } }, {
    deviceId: DEVICE_ID,
    keyId: KEY_ID,
    requestId: "d6fdcc0f-e5d1-4825-b749-b348a95dfe0e",
    contentSha256: "c".repeat(64)
  }, {
    now: () => NOW,
    requireRuntimeGates: false,
    requireLegacyDeviceRuntimeAdmission: false,
    requireAutomationStopped: false,
    allowLegacyFingerprintMapping: false,
    createRepository() { return {}; },
    createStore(transactionRepository, options) {
      assert.equal(options.allowLegacyFingerprintMapping, false);
      return {
        async storeSafeCapture() {
          return transactionRepository.withTransaction(async () => storedCapture());
        }
      };
    }
  });

  const stored = await store.storeSafeCapture({});
  assert.equal(stored.capture_id, CAPTURE_ID);
  assert.equal(calls.some(({ sql }) => /device_bridge_request_nonces/.test(sql)), true);
  assert.equal(calls.some(({ sql }) => /SELECT d\.device_id/.test(sql)), false);
  assert.equal(calls.some(({ sql }) => /COMMIT/.test(sql)), true);
});

test("passive read storage still blocks a non-stopped automation state without waiting for heartbeat projection", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (/SELECT d\.device_id/.test(sql)) {
        return {
          rows: [{
            device_id: DEVICE_ID,
            enrollment_state: "ACTIVE",
            revoked_at: null,
            key_revoked_at: null,
            last_accepted_heartbeat_at: new Date("2020-01-01T00:00:00.000Z"),
            bridge_service_state: "STOPPED",
            tinder_state: "DISCONNECTED",
            automation_state: "RUNNING",
            capabilities: T1_DEVICE_CAPABILITIES
          }]
        };
      }
      return { rows: [] };
    },
    release() {}
  };
  const store = createAuthenticatedCaptureStore({ async connect() { return client; } }, {
    deviceId: DEVICE_ID,
    keyId: KEY_ID,
    requestId: "d6fdcc0f-e5d1-4825-b749-b348a95dfe0e",
    contentSha256: "c".repeat(64)
  }, {
    now: () => NOW,
    requireRuntimeGates: false,
    requireAutomationStopped: true,
    allowLegacyFingerprintMapping: false,
    createRepository() { return {}; },
    createStore(transactionRepository) {
      return {
        async storeSafeCapture() {
          return transactionRepository.withTransaction(async () => {
            throw new Error("must not persist");
          });
        }
      };
    }
  });

  await assert.rejects(
    () => store.storeSafeCapture({}),
    (error) => error instanceof DeviceBridgeProtocolError && error.code === "AUTOMATION_STATE_UNSAFE"
  );
  assert.equal(calls.some((sql) => /device_bridge_request_nonces/.test(sql)), false);
  assert.equal(calls.some((sql) => /COMMIT/.test(sql)), false);
  assert.equal(calls.includes("ROLLBACK"), true);
});

function authReplayCatalogRows() {
  return {
    relations: [
      { table_name: "device_bridge_devices", relkind: "r" },
      { table_name: "device_bridge_keys", relkind: "r" },
      { table_name: "device_bridge_request_nonces", relkind: "r" }
    ],
    columns: [
      ["device_bridge_devices", "device_id", "uuid", true],
      ["device_bridge_devices", "enrollment_state", "text", true],
      ["device_bridge_devices", "revoked_at", "timestamp with time zone", false],
      ["device_bridge_keys", "key_id", "uuid", true],
      ["device_bridge_keys", "device_id", "uuid", true],
      ["device_bridge_keys", "public_key_spki_der", "bytea", true],
      ["device_bridge_keys", "revoked_at", "timestamp with time zone", false],
      ["device_bridge_request_nonces", "auth_subject", "text", true],
      ["device_bridge_request_nonces", "request_id", "uuid", true],
      ["device_bridge_request_nonces", "content_sha256", "character(64)", true],
      ["device_bridge_request_nonces", "accepted_at", "timestamp with time zone", true],
      ["device_bridge_request_nonces", "expires_at", "timestamp with time zone", true]
    ].map(([table_name, column_name, data_type, not_null]) => ({ table_name, column_name, data_type, not_null })),
    constraints: [
      { table_name: "device_bridge_devices", contype: "p", column_names: ["device_id"], reference_table: null, reference_column_names: [], convalidated: true, condeferrable: false, condeferred: false },
      { table_name: "device_bridge_keys", contype: "p", column_names: ["key_id"], reference_table: null, reference_column_names: [], convalidated: true, condeferrable: false, condeferred: false },
      { table_name: "device_bridge_keys", contype: "f", column_names: ["device_id"], reference_table: "device_bridge_devices", reference_column_names: ["device_id"], convalidated: true, condeferrable: false, condeferred: false },
      { table_name: "device_bridge_request_nonces", contype: "p", column_names: ["auth_subject", "request_id"], reference_table: null, reference_column_names: [], convalidated: true, condeferrable: false, condeferred: false }
    ]
  };
}

function authReplayCatalogClient({ rows = authReplayCatalogRows() } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(String(sql));
      if (/SELECT c\.relname AS table_name, c\.relkind/.test(sql)) return { rows: rows.relations };
      if (/format_type\(a\.atttypid, a\.atttypmod\) AS data_type/.test(sql)) return { rows: rows.columns };
      if (/FROM pg_constraint c/.test(sql)) return { rows: rows.constraints };
      throw new Error("Unexpected passive-read schema query");
    }
  };
}

test("passive read readiness inspects only signed auth/replay and the additive T2 capture base", async () => {
  const client = authReplayCatalogClient();
  let captureBaseCalls = 0;

  assert.deepEqual(
    await assertTinderPassiveReadIngressSchemaReady(client, {
      async assertCaptureSchemaReady(received) {
        captureBaseCalls += 1;
        assert.equal(received, client);
        return { state: "BASE_COMPATIBLE" };
      }
    }),
    { state: "BASE_COMPATIBLE" }
  );
  assert.equal(captureBaseCalls, 1);
  assert.equal(client.queries.some(sql => /device_bridge_commands|device_bridge_command_acks|device_bridge_audit_events/i.test(sql)), false);
});

test("passive read readiness fails closed when the replay uniqueness contract is absent", async () => {
  const rows = authReplayCatalogRows();
  rows.constraints = rows.constraints.filter(row => row.table_name !== "device_bridge_request_nonces");
  await assert.rejects(
    () => assertDeviceBridgeAuthReplaySchemaReady(authReplayCatalogClient({ rows })),
    /authentication\/replay schema is not ready/
  );
});

test("passive read readiness never imports the global V1 through V10 verifier", () => {
  const source = readFileSync(new URL("../device-bridge/tinder-passive-read-readiness.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /verifyDeviceBridgeSchema|assertDeviceBridgeT1SchemaReady|assertDeviceBridgeAckSchemaReady/);
  assert.match(source, /assertTinderVisibleChatCaptureBaseSchemaReady/);
});

test("passive read foundation middleware is independent of global bridge readiness and fails closed locally", async () => {
  const client = { releaseCalls: 0, release() { this.releaseCalls += 1; } };
  const middleware = createTinderPassiveReadIngressFoundationMiddleware({
    async connect() { return client; }
  }, {
    async assertFoundationReady(received) {
      assert.equal(received, client);
      return { state: "BASE_COMPATIBLE" };
    }
  });
  let continued = false;
  await middleware({ get() { return "d6fdcc0f-e5d1-4825-b749-b348a95dfe0e"; } }, {}, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(client.releaseCalls, 1);

  const rejecting = createTinderPassiveReadIngressFoundationMiddleware({
    async connect() { return { release() {} }; }
  }, {
    async assertFoundationReady() { throw new Error("legacy command constraint drift"); }
  });
  const response = responseRecorder();
  await rejecting({ get() { return "d6fdcc0f-e5d1-4825-b749-b348a95dfe0e"; } }, response, () => assert.fail("must fail closed"));
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error.code, "TINDER_PASSIVE_READ_FOUNDATION_NOT_READY");
  assert.equal(JSON.stringify(response.body).includes("legacy command constraint drift"), false);
});

test("passive and duplicate-only proof route registration accept only server-provided middleware before their handlers", () => {
  const routes = [];
  const middleware = () => {};
  registerTinderPassiveReadCaptureIngress({
    app: { post(...args) { routes.push(args); } },
    pool: {},
    middleware
  });
  assert.equal(routes.length, 1);
  assert.match(routes[0][0], /tinder-passive-read-captures$/);
  assert.equal(routes[0][1], middleware);
  assert.equal(typeof routes[0][2], "function");
  registerTinderPassiveReadDuplicateReprojectionProofIngress({
    app: { post(...args) { routes.push(args); } },
    pool: {},
    middleware
  });
  assert.match(routes[1][0], /tinder-passive-read-duplicate-reprojection-proofs$/);
  assert.equal(routes[1][1], middleware);
  assert.equal(typeof routes[1][2], "function");
  assert.throws(
    () => registerTinderPassiveReadCaptureIngress({ app: { post() {} }, pool: {}, middleware: [middleware, "invalid"] }),
    /middleware must be a function/
  );
  assert.throws(
    () => registerTinderPassiveReadDuplicateReprojectionProofIngress({ app: { post() {} }, pool: {}, middleware: [middleware, "invalid"] }),
    /middleware must be a function/
  );
});

test("capture record presentation never exposes raw messages or technical fingerprint", () => {
  const presented = normalizeCaptureRecord({
    ...storedCapture(),
    visible_thread_metadata: {
      ...storedCapture().visible_thread_metadata,
      threadBindingEvidence: {
        kind: "tinder_accessibility_header_unique_id_hmac_v1",
        role: "HEADER_TITLE",
        status: "OBSERVED_UNVERIFIED",
        token: "e".repeat(64)
      }
    }
  });
  assert.equal(Object.hasOwn(presented, "visible_messages"), false);
  assert.equal(Object.hasOwn(presented, "runtime_thread_fingerprint"), false);
  assert.equal(JSON.stringify(presented).includes("threadBindingEvidence"), false);
  assert.equal(JSON.stringify(presented).includes("e".repeat(64)), false);
  assert.equal(presented.visible_name, "Sandry");
});

test("T2 ingress remains separate from WhatsApp message persistence", () => {
  const source = readFileSync(new URL("../device-bridge/tinder-visible-chat-capture-ingress.js", import.meta.url), "utf8");
  assert.match(source, /verifyAuthenticatedDeviceRequest/);
  assert.match(source, /registerAuthenticatedRequestReplay/);
  assert.doesNotMatch(source, /INSERT\s+INTO\s+messages/i);
  assert.doesNotMatch(source, /whatsapp_jid/i);
});

test("T2 registration remains signed-ingress-only with no dashboard or mapping route", () => {
  const source = readFileSync(new URL("../device-bridge/tinder-visible-chat-capture-ingress.js", import.meta.url), "utf8");
  assert.match(source, /app\.post\(\s*`\/device-bridge\/v1\/devices\/:deviceId\$\{TINDER_CAPTURE_PATH_SUFFIX\}`/);
  assert.match(source, /app\.post\(\s*`\/device-bridge\/v1\/devices\/:deviceId\$\{TINDER_PASSIVE_READ_CAPTURE_PATH_SUFFIX\}`/);
  assert.doesNotMatch(source, /app\.get\(/);
  assert.doesNotMatch(source, /dashboard-api/);
  assert.doesNotMatch(source, /tinder-human-mapping|tinder-identity-resolution/);
});
