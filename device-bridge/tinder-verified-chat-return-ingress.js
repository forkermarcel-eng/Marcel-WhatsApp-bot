import {
  DEVICE_BRIDGE_PROTOCOL,
  DeviceBridgeProtocolError,
  isTinderVerifiedChatReturnCapable,
  isUuidV4,
  protocolErrorBody
} from "./protocol-v1.js";
import {
  registerAuthenticatedRequestReplay,
  verifyAuthenticatedDeviceRequest
} from "./device-auth.js";
import { deriveDeviceStatus } from "./heartbeat.js";
import {
  createPgTinderVerifiedChatReturnRepository,
  createTinderVerifiedChatReturnService,
  TinderVerifiedChatReturnError,
  TINDER_VERIFIED_CHAT_RETURN_RECEIPT_SCHEMA_VERSION,
  TINDER_VERIFIED_CHAT_RETURN_RECEIPT_STATUS
} from "../services/tinder-verified-chat-return.js";
import {
  assertTinderVerifiedChatReturnSchemaReady
} from "./tinder-verified-chat-return-schema.js";

/*
Exact signed V9 return receipt contract, intentionally content-free:
{
  protocol_version: 1,
  tinder_verified_chat_return: {
    schema_version: "tinder-verified-chat-return-receipt-v1",
    command_id: "<uuid>",
    status: "RETURNED"
  }
}
No binding, capture, resume, revision, UI, or Tinder data is accepted from
Android. Those facts remain in the locked durable permit and are revalidated.
*/

export const TINDER_VERIFIED_CHAT_RETURN_PATH_SUFFIX =
  "/tinder-verified-chat-returns";
export const TINDER_VERIFIED_CHAT_RETURN_RECEIPT_JSON_SHAPE = Object.freeze({
  protocol_version: DEVICE_BRIDGE_PROTOCOL.version,
  tinder_verified_chat_return: Object.freeze({
    schema_version: TINDER_VERIFIED_CHAT_RETURN_RECEIPT_SCHEMA_VERSION,
    command_id: "UUID_V4",
    status: TINDER_VERIFIED_CHAT_RETURN_RECEIPT_STATUS
  })
});

const FOUNDATION_ERROR_CODES = new Set(["42P01", "42703", "23502", "23503"]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function foundationNotReadyError() {
  return new DeviceBridgeProtocolError(
    503,
    "TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_NOT_READY",
    "Verified chat return foundation is not ready",
    true
  );
}

export function parseSignedTinderVerifiedChatReturnRequest(req) {
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw new DeviceBridgeProtocolError(400, "INVALID_JSON", "Verified chat return body is not valid JSON");
  }
  const receipt = body?.tinder_verified_chat_return;
  if (!exactKeys(body, ["protocol_version", "tinder_verified_chat_return"])
      || body.protocol_version !== DEVICE_BRIDGE_PROTOCOL.version
      || !exactKeys(receipt, ["schema_version", "command_id", "status"])
      || receipt.schema_version !== TINDER_VERIFIED_CHAT_RETURN_RECEIPT_SCHEMA_VERSION
      || !isUuidV4(receipt.command_id)
      || receipt.status !== TINDER_VERIFIED_CHAT_RETURN_RECEIPT_STATUS) {
    throw new DeviceBridgeProtocolError(400, "INVALID_TINDER_VERIFIED_CHAT_RETURN_REQUEST", "Verified chat return request is invalid");
  }
  return Object.freeze({
    commandId: receipt.command_id.toLowerCase(),
    status: TINDER_VERIFIED_CHAT_RETURN_RECEIPT_STATUS
  });
}

async function assertAuthenticatedReturnDevice(client, auth, now) {
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
  const row = result.rows[0] || null;
  if (!row || row.enrollment_state === "REVOKED" || row.revoked_at || row.key_revoked_at) {
    throw new DeviceBridgeProtocolError(403, "DEVICE_REVOKED", "Verified chat return is not authorized");
  }
  if (row.enrollment_state !== "ACTIVE") {
    throw new DeviceBridgeProtocolError(410, "RE_ENROLL_REQUIRED", "Device must enroll again");
  }
  if (!isTinderVerifiedChatReturnCapable(row.capabilities)
      || deriveDeviceStatus(row.last_accepted_heartbeat_at, now) !== "ONLINE"
      || row.bridge_service_state !== "RUNNING"
      || row.tinder_state !== "CONNECTED"
      || row.automation_state !== "STOPPED") {
    throw new DeviceBridgeProtocolError(409, "TINDER_VERIFIED_CHAT_RETURN_NOT_AVAILABLE", "Verified chat return is not available");
  }
}

export function createAuthenticatedTinderVerifiedChatReturnService(pool, auth, {
  now = () => new Date(),
  createRepository = createPgTinderVerifiedChatReturnRepository,
  createService = createTinderVerifiedChatReturnService,
  assertFoundationReady = assertTinderVerifiedChatReturnSchemaReady
} = {}) {
  const repository = createRepository(pool);
  const transactionRepository = Object.freeze({
    ...repository,
    async withTransaction(work) {
      const client = await pool.connect();
      try {
        const transactionNow = now();
        await client.query("BEGIN");
        try {
          await assertFoundationReady(client);
        } catch {
          throw foundationNotReadyError();
        }
        await assertAuthenticatedReturnDevice(client, auth, transactionNow);
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
  return createService(transactionRepository, { now });
}

export function createTinderVerifiedChatReturnIngressHandler(pool, {
  now = () => new Date(),
  verifyRequest = verifyAuthenticatedDeviceRequest,
  createAuthenticatedService = createAuthenticatedTinderVerifiedChatReturnService
} = {}) {
  return async function tinderVerifiedChatReturnIngressHandler(req, res) {
    try {
      const auth = await verifyRequest({ req, pool, urlDeviceId: req.params.deviceId });
      const receipt = parseSignedTinderVerifiedChatReturnRequest(req);
      const service = createAuthenticatedService(pool, auth, { now });
      const accepted = await service.acceptSignedReturnReceipt({
        commandId: receipt.commandId,
        deviceId: auth.deviceId,
        status: receipt.status
      });
      if (accepted?.status !== "ACCEPTED") {
        throw new DeviceBridgeProtocolError(409, "TINDER_VERIFIED_CHAT_RETURN_NOT_AVAILABLE", "Verified chat return is not available");
      }
      return res.status(201).json({
        ok: true,
        protocol_version: DEVICE_BRIDGE_PROTOCOL.version,
        server_time: now().toISOString(),
        tinder_verified_chat_return: { status: "ACCEPTED" }
      });
    } catch (error) {
      const mapped = FOUNDATION_ERROR_CODES.has(error?.code) ? foundationNotReadyError()
        : error instanceof TinderVerifiedChatReturnError
          ? new DeviceBridgeProtocolError(error.statusCode || 409, error.code, "Verified chat return is not available")
          : error;
      const status = mapped instanceof DeviceBridgeProtocolError ? mapped.status : 500;
      if (!(mapped instanceof DeviceBridgeProtocolError)) console.error("Verified chat return ingress failed.");
      return res.status(status).json(protocolErrorBody(mapped, req.get("x-marcel-request-id")));
    }
  };
}

export function registerTinderVerifiedChatReturnIngress({ app, pool }) {
  if (!app || typeof app.post !== "function") throw new TypeError("app.post must be a function");
  app.post(
    `/device-bridge/v1/devices/:deviceId${TINDER_VERIFIED_CHAT_RETURN_PATH_SUFFIX}`,
    createTinderVerifiedChatReturnIngressHandler(pool)
  );
}
