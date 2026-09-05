import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DeviceBridgeProtocolError, T1_DEVICE_CAPABILITIES } from "../device-bridge/protocol-v1.js";
import {
  createAuthenticatedCaptureStore,
  createTinderCaptureIngressHandler,
  normalizeCaptureRecord,
  parseSignedCaptureRequest
} from "../device-bridge/tinder-visible-chat-capture-ingress.js";

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

test("capture record presentation never exposes raw messages or technical fingerprint", () => {
  const presented = normalizeCaptureRecord(storedCapture());
  assert.equal(Object.hasOwn(presented, "visible_messages"), false);
  assert.equal(Object.hasOwn(presented, "runtime_thread_fingerprint"), false);
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
  assert.doesNotMatch(source, /app\.get\(/);
  assert.doesNotMatch(source, /dashboard-api/);
  assert.doesNotMatch(source, /tinder-human-mapping|tinder-identity-resolution/);
});
