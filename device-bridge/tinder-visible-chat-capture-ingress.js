import {
  DEVICE_BRIDGE_PROTOCOL,
  DeviceBridgeProtocolError,
  isTinderManualGateCapable,
  isUuidV4,
  protocolErrorBody
} from "./protocol-v1.js";
import {
  registerAuthenticatedRequestReplay,
  verifyAuthenticatedDeviceRequest
} from "./device-auth.js";
import { deriveDeviceStatus } from "./heartbeat.js";
import {
  TinderCaptureValidationError,
  createPgTinderCaptureRepository,
  createTinderCaptureStore
} from "../services/tinder-capture-store.js";
import {
  createPgTinderProductConversationRepository,
  createTinderProductConversationService
} from "../services/tinder-product-conversation-store.js";
import {
  createPgTinderHumanArmedConversationBindingRepository,
  createTinderHumanArmedConversationBindingService
} from "../services/tinder-human-armed-conversation-binding.js";

/* ==================================================
T2 TINDER VISIBLE-CHAT CAPTURE INGRESS

This module accepts only a signed, manual-gate-protected visible-chat
capture. The separate capture-table migration is never imported by startup.
Until it is explicitly applied, the ingress fails closed.
================================================== */

const TINDER_CAPTURE_PATH_SUFFIX = "/tinder-visible-chat-captures";
// The passive read channel is a separate signed ingress policy.  It keeps
// the historical manual-capture route intact while allowing a locally-safe
// read to reach the existing PENDING capture foundation without waiting for
// a server-projected heartbeat, V8 child, or return receipt.
const TINDER_PASSIVE_READ_CAPTURE_PATH_SUFFIX = "/tinder-passive-read-captures";
// This is a narrowly scoped transition endpoint, not a second reader. It
// accepts the same signed passive V2 envelope but rolls back if the exact
// viewport is not already immutable capture evidence. Its only permitted
// mutation is one product-conversation projection of that existing row.
const TINDER_PASSIVE_READ_DUPLICATE_REPROJECTION_PROOF_PATH_SUFFIX = "/tinder-passive-read-duplicate-reprojection-proofs";
const TINDER_CAPTURE_FOUNDATION_ERROR_CODES = new Set(["42P01", "42703", "23502"]);
const TINDER_PRODUCT_CONVERSATION_DISPOSITIONS = new Set([
  "CREATED", "UPDATED", "IDEMPOTENT_DUPLICATE", "NOT_READY"
]);
const TINDER_PRODUCT_CONVERSATION_HISTORY_STATES = new Set(["PARTIAL", "COMPLETE"]);
const TINDER_PRODUCT_CONVERSATION_READ_DISPOSITIONS = new Set([
  "FULL_READ_REQUIRED", "UNCHANGED", "DELTA_ACCEPTED"
]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return plainObject(value) &&
    Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function invalidCaptureRequest(message) {
  return new DeviceBridgeProtocolError(400, "INVALID_TINDER_CAPTURE_REQUEST", message);
}

function foundationNotReadyError() {
  return new DeviceBridgeProtocolError(
    503,
    "TINDER_IDENTITY_FOUNDATION_NOT_READY",
    "Tinder identity foundation migration is not ready",
    true
  );
}

function isFoundationNotReadyError(error) {
  return TINDER_CAPTURE_FOUNDATION_ERROR_CODES.has(error?.code);
}

function safeMessage(error) {
  return error?.message || "Tinder capture could not be processed";
}

function captureValidationProtocolError(error) {
  const status = new Set([
    "IDEMPOTENT_DUPLICATE_REQUIRED",
    "IDEMPOTENT_DUPLICATE_REPROJECTION_INELIGIBLE",
    "TINDER_PRODUCT_CONVERSATION_REPROJECTION_ALREADY_USED",
    "TINDER_PRODUCT_CONVERSATION_REPROJECTION_NOT_READY",
    "TINDER_PRODUCT_CONVERSATION_REPROJECTION_NOT_IDEMPOTENT"
  ]).has(error?.code) ? 409 : 400;
  return new DeviceBridgeProtocolError(status, error.code, safeMessage(error));
}

function parseSignedCaptureRequest(req) {
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw new DeviceBridgeProtocolError(400, "INVALID_JSON", "Tinder capture body is not valid JSON");
  }

  if (!exactKeys(body, ["protocol_version", "capture"])) {
    throw invalidCaptureRequest("Tinder capture request must contain only protocol_version and capture");
  }
  if (body.protocol_version !== DEVICE_BRIDGE_PROTOCOL.version) {
    throw new DeviceBridgeProtocolError(400, "PROTOCOL_VERSION_MISMATCH", "Tinder capture protocol version is invalid");
  }
  if (!plainObject(body.capture)) {
    throw invalidCaptureRequest("Tinder capture is invalid");
  }

  return body.capture;
}

function normalizeCaptureRecord(row) {
  const captureId = String(row?.captureId ?? row?.capture_id ?? "").trim();
  const deviceId = String(row?.deviceId ?? row?.device_id ?? "").trim();
  const captureRevision = Number(row?.captureRevision ?? row?.capture_revision);
  const mappingStatus = String(row?.mappingStatus ?? row?.mapping_status ?? "").trim().toUpperCase();
  const reviewStatus = String(row?.humanReviewStatus ?? row?.human_review_status ?? "").trim().toUpperCase();
  const safetyStatus = String(row?.captureSafetyStatus ?? row?.capture_safety_status ?? "SAFE").trim().toUpperCase();
  const sourcePackage = String(row?.sourcePackage ?? row?.source_package ?? "com.tinder").trim();
  const metadata = row?.visibleThreadMetadata ?? row?.visible_thread_metadata ?? {};

  if (!isUuidV4(captureId) || !isUuidV4(deviceId) ||
      !Number.isInteger(captureRevision) || captureRevision < 1 ||
      !["NEEDS_HUMAN_MAPPING", "RESOLVED", "CONFLICT"].includes(mappingStatus) ||
      !["PENDING", "CONFIRMED", "REJECTED"].includes(reviewStatus) ||
      safetyStatus !== "SAFE" || sourcePackage !== "com.tinder" || !plainObject(metadata)) {
    throw new DeviceBridgeProtocolError(500, "INVALID_TINDER_CAPTURE_RECORD", "Tinder capture record is invalid");
  }

  const visibleName = String(metadata.visibleName ?? metadata.visible_name ?? "").trim();
  if (!visibleName || visibleName.length > 240) {
    throw new DeviceBridgeProtocolError(500, "INVALID_TINDER_CAPTURE_RECORD", "Tinder capture record is invalid");
  }

  const timestamp = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  };

  return Object.freeze({
    capture_id: captureId,
    device_id: deviceId,
    capture_revision: captureRevision,
    mapping_status: mappingStatus,
    human_review_status: reviewStatus,
    visible_name: visibleName,
    source_package: sourcePackage,
    captured_at: timestamp(row?.capturedAt ?? row?.captured_at),
    received_at: timestamp(row?.receivedAt ?? row?.received_at)
  });
}

async function assertCaptureDeviceIdentity(client, auth) {
  const result = await client.query(
    `SELECT d.device_id, d.enrollment_state, d.revoked_at,
            d.last_accepted_heartbeat_at, d.bridge_service_state,
            d.tinder_state, d.automation_state, d.capabilities,
            k.key_id, k.revoked_at AS key_revoked_at
       FROM device_bridge_devices d
       JOIN device_bridge_keys k ON k.device_id = d.device_id AND k.key_id = $2
      WHERE d.device_id = $1
      FOR UPDATE OF d, k`,
    [auth.deviceId, auth.keyId]
  );
  const row = result.rows[0];
  if (!row || row.enrollment_state === "REVOKED" || row.revoked_at) {
    throw new DeviceBridgeProtocolError(403, "DEVICE_REVOKED", "Device capture is not authorized");
  }
  if (row.enrollment_state !== "ACTIVE") {
    throw new DeviceBridgeProtocolError(410, "RE_ENROLL_REQUIRED", "Device must enroll again");
  }
  if (row.key_revoked_at) {
    throw new DeviceBridgeProtocolError(403, "KEY_REVOKED", "Device capture is not authorized");
  }
  if (!isTinderManualGateCapable(row.capabilities)) {
    throw new DeviceBridgeProtocolError(409, "DEVICE_CAPABILITY_UNSUPPORTED", "Device does not support the Tinder manual gate");
  }
  return row;
}

/**
 * Passive V2 receives only a fixed, identifier-free product outcome. It is a
 * planning result for the next bounded local read, never a permission or a
 * synchronous gate for navigation, reader, ingress, or header-back.
 */
function normalizePassiveReadProductConversationOutcome(value) {
  if (!plainObject(value)) {
    return Object.freeze({
      disposition: "NOT_READY",
      history_state: null,
      read_disposition: "FULL_READ_REQUIRED"
    });
  }
  const disposition = String(value.disposition || "").trim().toUpperCase();
  if (!TINDER_PRODUCT_CONVERSATION_DISPOSITIONS.has(disposition)) {
    throw new DeviceBridgeProtocolError(
      500,
      "INVALID_TINDER_PRODUCT_CONVERSATION_OUTCOME",
      "Tinder product conversation outcome is invalid"
    );
  }
  if (disposition === "NOT_READY") {
    const suppliedHistoryState = value.historyState ?? value.history_state ?? null;
    const suppliedReadDisposition = value.readDisposition ?? value.read_disposition ?? null;
    if (suppliedHistoryState !== null
        || (suppliedReadDisposition !== null
          && String(suppliedReadDisposition).trim().toUpperCase() !== "FULL_READ_REQUIRED")) {
      throw new DeviceBridgeProtocolError(
        500,
        "INVALID_TINDER_PRODUCT_CONVERSATION_OUTCOME",
        "Tinder product conversation outcome is invalid"
      );
    }
    return Object.freeze({
      disposition,
      history_state: null,
      read_disposition: "FULL_READ_REQUIRED"
    });
  }
  const historyState = String(value.historyState ?? value.history_state ?? "").trim().toUpperCase();
  const readDisposition = String(value.readDisposition ?? value.read_disposition ?? "").trim().toUpperCase();
  if (!TINDER_PRODUCT_CONVERSATION_HISTORY_STATES.has(historyState)
      || !TINDER_PRODUCT_CONVERSATION_READ_DISPOSITIONS.has(readDisposition)) {
    throw new DeviceBridgeProtocolError(
      500,
      "INVALID_TINDER_PRODUCT_CONVERSATION_OUTCOME",
      "Tinder product conversation outcome is invalid"
    );
  }
  const invalid = () => {
    throw new DeviceBridgeProtocolError(
      500,
      "INVALID_TINDER_PRODUCT_CONVERSATION_OUTCOME",
      "Tinder product conversation outcome is invalid"
    );
  };
  if (disposition === "IDEMPOTENT_DUPLICATE") {
    // An immutable capture already linked to this device Conversation can
    // never authorize another full history read. Its historical state stays
    // visible, but the action planning result is always a skip.
    if (readDisposition !== "UNCHANGED") invalid();
  } else if (disposition === "CREATED") {
    // A fresh Conversation must always drive its first full read. Even a
    // capture that already reaches the oldest boundary cannot claim that the
    // initial product history was previously synchronized.
    if (readDisposition !== "FULL_READ_REQUIRED") invalid();
  } else if (disposition === "UPDATED") {
    // Only a durable complete Conversation can safely identify an unchanged
    // viewport or an overlap-proven delta. A partial state remains a full-read
    // request even when the server response is otherwise well-formed.
    if (historyState !== "COMPLETE"
        && readDisposition !== "FULL_READ_REQUIRED") invalid();
  } else {
    invalid();
  }
  return Object.freeze({
    disposition,
    history_state: historyState,
    read_disposition: readDisposition
  });
}

/**
 * The one-time proof must return no capture metadata: its existing opaque
 * capture identifier is used only by the immediately waiting Android method
 * and is discarded there. In particular it does not echo a display value,
 * timestamp, device identifier, revision, mapping state, or any transcript
 * material.
 */
function normalizeDuplicateReprojectionProofReceipt(row) {
  const captureId = String(row?.captureId ?? row?.capture_id ?? "").trim();
  if (!isUuidV4(captureId)) {
    throw new TinderCaptureValidationError(
      "Die Tinder-Re-Projection hat keine gültige bestehende Capture-ID.",
      "INVALID_TINDER_CAPTURE_RECORD"
    );
  }
  return Object.freeze({ capture_id: captureId });
}

async function assertCaptureDeviceGates(client, auth, now) {
  const row = await assertCaptureDeviceIdentity(client, auth);
  if (deriveDeviceStatus(row.last_accepted_heartbeat_at, now) !== "ONLINE") {
    throw new DeviceBridgeProtocolError(409, "DEVICE_OFFLINE", "Device must be online for a Tinder capture");
  }
  if (row.bridge_service_state !== "RUNNING") {
    throw new DeviceBridgeProtocolError(409, "BRIDGE_NOT_RUNNING", "Bridge must be running for a Tinder capture");
  }
  if (row.tinder_state !== "CONNECTED") {
    throw new DeviceBridgeProtocolError(409, "TINDER_GATE_NOT_CONNECTED", "Tinder manual gate must be connected for a capture");
  }
  assertCaptureAutomationStopped(row);
}

/**
 * Unlike heartbeat and runtime projection, this remains a server-side safety boundary for every
 * capture route. A local passive reader must never race a known non-stopped automation state.
 */
function assertCaptureAutomationStopped(row) {
  if (row?.automation_state !== "STOPPED") {
    throw new DeviceBridgeProtocolError(409, "AUTOMATION_STATE_UNSAFE", "Automation must be stopped for a Tinder capture");
  }
}

function createAuthenticatedCaptureStore(pool, auth, {
  now = () => new Date(),
  createRepository = createPgTinderCaptureRepository,
  createStore = createTinderCaptureStore,
  createProductConversationRepository = createPgTinderProductConversationRepository,
  createProductConversationService = createTinderProductConversationService,
  createHumanArmedRepository = createPgTinderHumanArmedConversationBindingRepository,
  createHumanArmedService = createTinderHumanArmedConversationBindingService,
  requireRuntimeGates = true,
  requireLegacyDeviceRuntimeAdmission = true,
  requireAutomationStopped = true,
  allowLegacyFingerprintMapping = true,
  projectProductConversations = false,
  reprojectExistingDuplicate = false,
  verifyExistingDuplicateReprojection = false,
  requireExistingDuplicate = false
} = {}) {
  if (typeof requireRuntimeGates !== "boolean" || typeof requireLegacyDeviceRuntimeAdmission !== "boolean" ||
      typeof requireAutomationStopped !== "boolean" ||
      typeof allowLegacyFingerprintMapping !== "boolean" || typeof projectProductConversations !== "boolean" ||
      typeof reprojectExistingDuplicate !== "boolean"
      || typeof verifyExistingDuplicateReprojection !== "boolean"
      || typeof requireExistingDuplicate !== "boolean") {
    throw new TypeError("Capture ingress policy flags must be booleans");
  }
  if (typeof createProductConversationRepository !== "function"
      || typeof createProductConversationService !== "function") {
    throw new TypeError("Product conversation factories must be functions");
  }
  const repository = createRepository(pool);
  // This is intentionally opt-in for the autonomous V2 reader only.  The
  // additive conversation schema may still be absent; in that case the
  // projector reports NOT_READY inside the existing transaction and leaves
  // immutable capture provenance safely persisted rather than blocking read.
  const productConversationProjector = projectProductConversations
    ? createProductConversationService(createProductConversationRepository(pool), { now })
    : null;
  let humanArmedService = null;
  const currentHumanArmedService = () => {
    if (!humanArmedService) {
      humanArmedService = createHumanArmedService(
        createHumanArmedRepository(pool),
        { now }
      );
    }
    return humanArmedService;
  };
  const transactionRepository = Object.freeze({
    ...repository,
    async withTransaction(work) {
      const client = await pool.connect();
      try {
        const transactionNow = now();
        await client.query("BEGIN");
        if (requireRuntimeGates) {
          await assertCaptureDeviceGates(client, auth, transactionNow);
        } else if (requireLegacyDeviceRuntimeAdmission) {
          // The device's signed identity and declared manual-gate capability
          // remain mandatory.  Current Bridge/Tinder/screen safety is checked
          // locally by the read channel; asynchronous heartbeat projection is
          // deliberately not a synchronous read dependency.
          const device = await assertCaptureDeviceIdentity(client, auth);
          if (requireAutomationStopped) assertCaptureAutomationStopped(device);
        }
        await registerAuthenticatedRequestReplay(client, auth, transactionNow);
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
  });
  return createStore(transactionRepository, {
    now,
    humanBindingPermitGateway: Object.freeze({
      authorizeIncomingCapturePermit: (...args) =>
        currentHumanArmedService().authorizeIncomingCapturePermit(...args),
      consumeAuthorizedIncomingPermit: (...args) =>
        currentHumanArmedService().consumeAuthorizedIncomingPermit(...args)
    }),
    allowLegacyFingerprintMapping,
    productConversationProjector,
    reprojectExistingDuplicate,
    verifyExistingDuplicateReprojection,
    requireExistingDuplicate
  });
}

function assertPassiveReadCapture(capture) {
  const metadata = capture?.captureMetadata ?? capture?.capture_metadata;
  if (!plainObject(metadata)
      || metadata.schemaVersion !== "tinder-visible-chat-v2"
      || Object.hasOwn(metadata, "humanBindingPermit")
      || Object.hasOwn(metadata, "human_binding_permit")) {
    throw invalidCaptureRequest("Passive Tinder reads require exactly a V2 capture without a human-binding permit");
  }
  return capture;
}

function createTinderCaptureIngressHandler(pool, {
  now = () => new Date(),
  verifyRequest = verifyAuthenticatedDeviceRequest,
  createAuthenticatedStore = createAuthenticatedCaptureStore
} = {}) {
  return async function tinderCaptureIngressHandler(req, res) {
    try {
      const auth = await verifyRequest({ req, pool, urlDeviceId: req.params.deviceId });
      const capture = parseSignedCaptureRequest(req);
      const store = createAuthenticatedStore(pool, auth, { now });
      const stored = await store.storeSafeCapture({
        deviceId: auth.deviceId,
        capture,
        provenance: { source: "android_visible_chat", protocolVersion: DEVICE_BRIDGE_PROTOCOL.version }
      });
      const record = normalizeCaptureRecord(stored);
      return res.status(201).json({
        ok: true,
        protocol_version: DEVICE_BRIDGE_PROTOCOL.version,
        server_time: now().toISOString(),
        capture: record
      });
    } catch (error) {
      const mapped = isFoundationNotReadyError(error) ? foundationNotReadyError()
        : error instanceof TinderCaptureValidationError
          ? captureValidationProtocolError(error)
          : error;
      const status = mapped instanceof DeviceBridgeProtocolError ? mapped.status : 500;
      if (!(mapped instanceof DeviceBridgeProtocolError)) {
        console.error("Tinder visible-chat capture ingress failed.");
      }
      return res.status(status).json(protocolErrorBody(mapped, req.get("x-marcel-request-id")));
    }
  };
}

/**
 * A narrowly scoped, device-signed adapter for the autonomous read channel.
 * It never accepts V3 human-binding permits, never resolves a contact from a
 * runtime fingerprint, and has no command/permit/receipt input.  The stored
 * V2 capture is therefore either independently bound through opaque evidence
 * or remains PENDING for a later human decision.
 */
function createTinderPassiveReadIngressHandler(pool, {
  now = () => new Date(),
  verifyRequest = verifyAuthenticatedDeviceRequest,
  createAuthenticatedStore = createAuthenticatedCaptureStore,
  requireExistingDuplicate = false,
  verifyExistingDuplicateReprojection = false
} = {}) {
  if (typeof requireExistingDuplicate !== "boolean"
      || typeof verifyExistingDuplicateReprojection !== "boolean") {
    throw new TypeError("passive read proof policy flags must be booleans");
  }
  if (verifyExistingDuplicateReprojection && !requireExistingDuplicate) {
    throw new TypeError("duplicate reprojection verification requires duplicate-only mode");
  }
  return async function tinderPassiveReadIngressHandler(req, res) {
    try {
      const auth = await verifyRequest({ req, pool, urlDeviceId: req.params.deviceId });
      const capture = assertPassiveReadCapture(parseSignedCaptureRequest(req));
      const store = createAuthenticatedStore(pool, auth, {
        now,
        requireRuntimeGates: false,
        // Signature verification already enforces the active device/key and
        // this transaction records the request nonce.  Passive V2 reads must
        // not synchronously inherit the legacy command-profile, manual-gate,
        // or automation-state admission path.
        requireLegacyDeviceRuntimeAdmission: false,
        requireAutomationStopped: false,
        allowLegacyFingerprintMapping: false,
        projectProductConversations: true,
        reprojectExistingDuplicate: requireExistingDuplicate,
        verifyExistingDuplicateReprojection,
        requireExistingDuplicate
      });
      const result = await store.storeSafeCaptureWithDisposition({
        deviceId: auth.deviceId,
        capture,
        provenance: {
          source: "android_visible_chat",
          protocolVersion: DEVICE_BRIDGE_PROTOCOL.version,
          readChannel: "PASSIVE_READ"
        }
      });
      const stored = result.capture;
      /*
       * No product Conversation identifier or message content is returned to
       * Android. The fixed outcome is sufficient to choose a later bounded
       * full read, unchanged skip, or overlap-proven delta without becoming a
       * new permission, receipt, or read-path gate.
       */
      const record = requireExistingDuplicate
        ? normalizeDuplicateReprojectionProofReceipt(stored)
        : normalizeCaptureRecord(stored);
      return res.status(201).json({
        ok: true,
        protocol_version: DEVICE_BRIDGE_PROTOCOL.version,
        capture: record,
        ...(requireExistingDuplicate
          ? {}
          : {
            server_time: now().toISOString(),
            product_conversation: normalizePassiveReadProductConversationOutcome(
              result.productConversation
            )
          })
      });
    } catch (error) {
      const mapped = isFoundationNotReadyError(error) ? foundationNotReadyError()
        : error instanceof TinderCaptureValidationError
          ? captureValidationProtocolError(error)
          : error;
      const status = mapped instanceof DeviceBridgeProtocolError ? mapped.status : 500;
      if (!(mapped instanceof DeviceBridgeProtocolError)) {
        console.error("Tinder passive read ingress failed.");
      }
      return res.status(status).json(protocolErrorBody(mapped, req.get("x-marcel-request-id")));
    }
  };
}

function createTinderPassiveReadCaptureIngressHandler(pool, options = {}) {
  return createTinderPassiveReadIngressHandler(pool, options);
}

/**
 * A single-use migration proof transport.  It never accepts a new capture:
 * a fingerprint miss rolls back the signed request transaction, including its
 * nonce.  An exact existing passive V2 duplicate is projected and immediately
 * reprojected in the same transaction to prove the capture-link invariant.
 */
function createTinderPassiveReadDuplicateReprojectionProofIngressHandler(pool, options = {}) {
  return createTinderPassiveReadIngressHandler(pool, {
    ...options,
    requireExistingDuplicate: true,
    verifyExistingDuplicateReprojection: true
  });
}

function registerTinderVisibleChatCaptureIngress({ app, pool }) {
  if (!app || typeof app.post !== "function") {
    throw new TypeError("app.post must be a function");
  }
  app.post(
    `/device-bridge/v1/devices/:deviceId${TINDER_CAPTURE_PATH_SUFFIX}`,
    createTinderCaptureIngressHandler(pool)
  );
}

function registerTinderPassiveReadCaptureIngress({ app, pool, middleware = [] }) {
  if (!app || typeof app.post !== "function") {
    throw new TypeError("app.post must be a function");
  }
  const chain = Array.isArray(middleware) ? middleware : [middleware];
  if (!chain.every(handler => typeof handler === "function")) {
    throw new TypeError("passive read middleware must be a function or an array of functions");
  }
  app.post(
    `/device-bridge/v1/devices/:deviceId${TINDER_PASSIVE_READ_CAPTURE_PATH_SUFFIX}`,
    ...chain,
    createTinderPassiveReadCaptureIngressHandler(pool)
  );
}

function registerTinderPassiveReadDuplicateReprojectionProofIngress({ app, pool, middleware = [] }) {
  if (!app || typeof app.post !== "function") {
    throw new TypeError("app.post must be a function");
  }
  const chain = Array.isArray(middleware) ? middleware : [middleware];
  if (!chain.every(handler => typeof handler === "function")) {
    throw new TypeError("passive read proof middleware must be a function or an array of functions");
  }
  app.post(
    `/device-bridge/v1/devices/:deviceId${TINDER_PASSIVE_READ_DUPLICATE_REPROJECTION_PROOF_PATH_SUFFIX}`,
    ...chain,
    createTinderPassiveReadDuplicateReprojectionProofIngressHandler(pool)
  );
}

export {
  TINDER_CAPTURE_PATH_SUFFIX,
  TINDER_PASSIVE_READ_CAPTURE_PATH_SUFFIX,
  TINDER_PASSIVE_READ_DUPLICATE_REPROJECTION_PROOF_PATH_SUFFIX,
  createAuthenticatedCaptureStore,
  createTinderCaptureIngressHandler,
  createTinderPassiveReadCaptureIngressHandler,
  createTinderPassiveReadDuplicateReprojectionProofIngressHandler,
  normalizeCaptureRecord,
  normalizePassiveReadProductConversationOutcome,
  parseSignedCaptureRequest,
  registerTinderPassiveReadCaptureIngress,
  registerTinderPassiveReadDuplicateReprojectionProofIngress,
  registerTinderVisibleChatCaptureIngress
};
