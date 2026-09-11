import {
  DEVICE_BRIDGE_PROTOCOL,
  DeviceBridgeProtocolError,
  isTinderLocalConversationAttestationCapable,
  isUuidV4,
  protocolErrorBody
} from "./protocol-v1.js";
import {
  registerAuthenticatedRequestReplay,
  verifyAuthenticatedDeviceRequest
} from "./device-auth.js";
import { deriveDeviceStatus } from "./heartbeat.js";
import {
  createPgTinderLocalConversationAttestationRepository,
  createTinderLocalConversationAttestationService,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_INVALIDATION_REASON,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_INGRESS_STATUS,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS,
  TinderLocalConversationAttestationError
} from "../services/tinder-local-conversation-attestation.js";
import {
  createPgTinderVisibleChatSyncRepository,
  createTinderVisibleChatSyncService
} from "../services/tinder-visible-chat-sync.js";

/* ==================================================
LOCAL CONVERSATION ATTESTATION — SIGNED DEVICE INGRESS

This ingress transports only an opaque server command handle and a bounded
state. It deliberately accepts no Tinder identifier, display value, message,
thread/capture fingerprint, UI node, bounds or content. The locked permit and
confirmed binding revision remain server-side authority.
================================================== */

export const TINDER_LOCAL_CONVERSATION_ATTESTATION_PATH_SUFFIX =
  "/tinder-local-conversation-attestations";

const FOUNDATION_ERROR_CODES = new Set(["42P01", "42703", "23502", "23503"]);
const ANDROID_INVALIDATION_REASONS = new Set([
  "CONVERSATION_CHANGED",
  "CONTINUITY_UNPROVEN",
  "LOCAL_STATE_DESTROYED",
  "AUTH_OR_REVIEW",
  "IDENTITY_CONFLICT"
]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function foundationNotReadyError() {
  return new DeviceBridgeProtocolError(
    503,
    "TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_NOT_READY",
    "Local conversation attestation foundation migration is not ready",
    true
  );
}

function safeReasonCode(value) {
  const reasonCode = String(value || "").trim().toUpperCase();
  return Object.values(TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON).includes(reasonCode)
    ? reasonCode : "LOCAL_CONVERSATION_ATTESTATION_NOT_AVAILABLE";
}

export function parseSignedLocalConversationAttestationRequest(req) {
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw new DeviceBridgeProtocolError(400, "INVALID_JSON", "Local conversation attestation body is not valid JSON");
  }
  if (!exactKeys(body, ["protocol_version", "attestation"])) {
    throw new DeviceBridgeProtocolError(400, "INVALID_TINDER_LOCAL_CONVERSATION_ATTESTATION_REQUEST", "Local conversation attestation request is invalid");
  }
  if (body.protocol_version !== DEVICE_BRIDGE_PROTOCOL.version || !plainObject(body.attestation)) {
    throw new DeviceBridgeProtocolError(400, "INVALID_TINDER_LOCAL_CONVERSATION_ATTESTATION_REQUEST", "Local conversation attestation request is invalid");
  }
  const status = body.attestation.status;
  if (status === TINDER_LOCAL_CONVERSATION_ATTESTATION_INGRESS_STATUS
      && exactKeys(body.attestation, ["command_id", "status"])
      && isUuidV4(body.attestation.command_id)) {
    return Object.freeze({
      commandId: body.attestation.command_id,
      status
    });
  }
  if (status === "INVALIDATED"
      && exactKeys(body.attestation, ["command_id", "status", "reason"])
      && isUuidV4(body.attestation.command_id)) {
    const reasonCode = body.attestation.reason;
    if (typeof reasonCode === "string"
        && reasonCode === reasonCode.trim().toUpperCase()
        && ANDROID_INVALIDATION_REASONS.has(reasonCode)
        && TINDER_LOCAL_CONVERSATION_ATTESTATION_INVALIDATION_REASON.includes(reasonCode)) {
      return Object.freeze({
        commandId: body.attestation.command_id,
        status,
        reasonCode
      });
    }
  }
  throw new DeviceBridgeProtocolError(400, "INVALID_TINDER_LOCAL_CONVERSATION_ATTESTATION_REQUEST", "Local conversation attestation request is invalid");
}

async function assertActiveAttestationDevice(client, auth) {
  const result = await client.query(
    `SELECT d.device_id, d.enrollment_state, d.revoked_at,
            d.last_accepted_heartbeat_at, d.bridge_service_state,
            d.tinder_state, d.automation_state, d.capabilities,
            k.key_id, k.revoked_at AS key_revoked_at
       FROM device_bridge_devices d
       JOIN device_bridge_keys k ON k.device_id=d.device_id AND k.key_id=$2
      WHERE d.device_id=$1
      FOR UPDATE OF d, k`,
    [auth.deviceId, auth.keyId]
  );
  const row = result.rows[0];
  if (!row || row.enrollment_state === "REVOKED" || row.revoked_at || row.key_revoked_at) {
    throw new DeviceBridgeProtocolError(403, "DEVICE_REVOKED", "Device local conversation attestation is not authorized");
  }
  if (row.enrollment_state !== "ACTIVE") {
    throw new DeviceBridgeProtocolError(410, "RE_ENROLL_REQUIRED", "Device must enroll again");
  }
  return row;
}

function assertPositiveAttestationRuntimeGates(row, now) {
  if (!isTinderLocalConversationAttestationCapable(row.capabilities)) {
    throw new DeviceBridgeProtocolError(409, "DEVICE_CAPABILITY_UNSUPPORTED", "Device does not support local conversation attestation");
  }
  if (deriveDeviceStatus(row.last_accepted_heartbeat_at, now) !== "ONLINE") {
    throw new DeviceBridgeProtocolError(409, "DEVICE_OFFLINE", "Device must be online for local conversation attestation");
  }
  if (row.bridge_service_state !== "RUNNING") {
    throw new DeviceBridgeProtocolError(409, "BRIDGE_NOT_RUNNING", "Bridge must be running for local conversation attestation");
  }
  if (row.tinder_state !== "CONNECTED") {
    throw new DeviceBridgeProtocolError(409, "TINDER_GATE_NOT_CONNECTED", "Tinder manual gate must be connected for local conversation attestation");
  }
  if (row.automation_state !== "STOPPED") {
    throw new DeviceBridgeProtocolError(409, "AUTOMATION_STATE_UNSAFE", "Automation must be stopped for local conversation attestation");
  }
}

export function createAuthenticatedLocalConversationAttestationService(pool, auth, {
  now = () => new Date(),
  createRepository = createPgTinderLocalConversationAttestationRepository,
  createService = createTinderLocalConversationAttestationService,
  createVisibleChatSyncRepository = createPgTinderVisibleChatSyncRepository,
  createVisibleChatSyncService = createTinderVisibleChatSyncService,
  requirePositiveRuntimeGates = true
} = {}) {
  const repository = createRepository(pool);
  const visibleChatSyncService = createVisibleChatSyncService(
    createVisibleChatSyncRepository(pool),
    { now }
  );
  const transactionRepository = Object.freeze({
    ...repository,
    async withTransaction(work) {
      const client = await pool.connect();
      try {
        const transactionNow = now();
        await client.query("BEGIN");
        const device = await assertActiveAttestationDevice(client, auth);
        if (requirePositiveRuntimeGates) {
          assertPositiveAttestationRuntimeGates(device, transactionNow);
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
  return createService(transactionRepository, {
    now,
    // This does not grant the bootstrap permit reader authority.  It is a
    // separate V4 command/permit issued only after the signed local proof
    // reached ATTESTED under this exact transaction's device-first lock.
    queueReaderAfterAttestation: async (client, proof) =>
      visibleChatSyncService.queueVisibleChatSyncForHumanBinding(
        { bindingId: proof.bindingId },
        client
      )
  });
}

function protocolErrorForResult(result) {
  const code = safeReasonCode(result?.reasonCode);
  if (result?.status === TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.DEVICE_NOT_READY
      || result?.status === TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE
      || result?.status === TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_CONFLICT) {
    return new DeviceBridgeProtocolError(409, code, "Local conversation attestation is not available");
  }
  return new DeviceBridgeProtocolError(500, "TINDER_LOCAL_CONVERSATION_ATTESTATION_INGRESS_FAILED", "Local conversation attestation could not be accepted");
}

export function createTinderLocalConversationAttestationIngressHandler(pool, {
  now = () => new Date(),
  verifyRequest = verifyAuthenticatedDeviceRequest,
  createAuthenticatedService = createAuthenticatedLocalConversationAttestationService
} = {}) {
  return async function tinderLocalConversationAttestationIngressHandler(req, res) {
    try {
      const auth = await verifyRequest({ req, pool, urlDeviceId: req.params.deviceId });
      const attestation = parseSignedLocalConversationAttestationRequest(req);
      const service = createAuthenticatedService(pool, auth, {
        now,
        requirePositiveRuntimeGates: attestation.status === TINDER_LOCAL_CONVERSATION_ATTESTATION_INGRESS_STATUS
      });
      const result = attestation.status === TINDER_LOCAL_CONVERSATION_ATTESTATION_INGRESS_STATUS
        ? await service.attestLocalConversation({
          commandId: attestation.commandId,
          deviceId: auth.deviceId,
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_INGRESS_STATUS
        })
        : await service.invalidateLocalConversation({
          commandId: attestation.commandId,
          deviceId: auth.deviceId,
          reasonCode: attestation.reasonCode
        });
      const expected = attestation.status === TINDER_LOCAL_CONVERSATION_ATTESTATION_INGRESS_STATUS
        ? TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.ATTESTED
        : TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.INVALIDATED;
      if (result?.status !== expected) throw protocolErrorForResult(result);
      return res.status(201).json({
        ok: true,
        protocol_version: DEVICE_BRIDGE_PROTOCOL.version,
        server_time: now().toISOString(),
        attestation: { command_id: attestation.commandId, status: "ACCEPTED" }
      });
    } catch (error) {
      const mapped = FOUNDATION_ERROR_CODES.has(error?.code) ? foundationNotReadyError()
        : error instanceof TinderLocalConversationAttestationError
          ? new DeviceBridgeProtocolError(error.statusCode || 400, error.code, "Local conversation attestation is invalid")
          : error;
      const status = mapped instanceof DeviceBridgeProtocolError ? mapped.status : 500;
      if (!(mapped instanceof DeviceBridgeProtocolError)) {
        console.error("Tinder local conversation attestation ingress failed.");
      }
      return res.status(status).json(protocolErrorBody(mapped, req.get("x-marcel-request-id")));
    }
  };
}

export function registerTinderLocalConversationAttestationIngress({ app, pool }) {
  if (!app || typeof app.post !== "function") throw new TypeError("app.post must be a function");
  app.post(
    `/device-bridge/v1/devices/:deviceId${TINDER_LOCAL_CONVERSATION_ATTESTATION_PATH_SUFFIX}`,
    createTinderLocalConversationAttestationIngressHandler(pool)
  );
}
