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

/* ==================================================
T2 TINDER VISIBLE-CHAT CAPTURE INGRESS

This module accepts only a signed, manual-gate-protected visible-chat
capture. The separate capture-table migration is never imported by startup.
Until it is explicitly applied, the ingress fails closed.
================================================== */

const TINDER_CAPTURE_PATH_SUFFIX = "/tinder-visible-chat-captures";
const TINDER_CAPTURE_FOUNDATION_ERROR_CODES = new Set(["42P01", "42703", "23502"]);

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

async function assertCaptureDeviceGates(client, auth, now) {
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
  if (deriveDeviceStatus(row.last_accepted_heartbeat_at, now) !== "ONLINE") {
    throw new DeviceBridgeProtocolError(409, "DEVICE_OFFLINE", "Device must be online for a Tinder capture");
  }
  if (row.bridge_service_state !== "RUNNING") {
    throw new DeviceBridgeProtocolError(409, "BRIDGE_NOT_RUNNING", "Bridge must be running for a Tinder capture");
  }
  if (row.tinder_state !== "CONNECTED") {
    throw new DeviceBridgeProtocolError(409, "TINDER_GATE_NOT_CONNECTED", "Tinder manual gate must be connected for a capture");
  }
  if (row.automation_state !== "STOPPED") {
    throw new DeviceBridgeProtocolError(409, "AUTOMATION_STATE_UNSAFE", "Automation must be stopped for a Tinder capture");
  }
}

function createAuthenticatedCaptureStore(pool, auth, {
  now = () => new Date(),
  createRepository = createPgTinderCaptureRepository,
  createStore = createTinderCaptureStore
} = {}) {
  const repository = createRepository(pool);
  const transactionRepository = Object.freeze({
    ...repository,
    async withTransaction(work) {
      const client = await pool.connect();
      try {
        const transactionNow = now();
        await client.query("BEGIN");
        await assertCaptureDeviceGates(client, auth, transactionNow);
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
  return createStore(transactionRepository, { now });
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
          ? new DeviceBridgeProtocolError(400, error.code, safeMessage(error))
          : error;
      const status = mapped instanceof DeviceBridgeProtocolError ? mapped.status : 500;
      if (!(mapped instanceof DeviceBridgeProtocolError)) {
        console.error("Tinder visible-chat capture ingress failed.");
      }
      return res.status(status).json(protocolErrorBody(mapped, req.get("x-marcel-request-id")));
    }
  };
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

export {
  TINDER_CAPTURE_PATH_SUFFIX,
  createAuthenticatedCaptureStore,
  createTinderCaptureIngressHandler,
  normalizeCaptureRecord,
  parseSignedCaptureRequest,
  registerTinderVisibleChatCaptureIngress
};
