import {
  DEVICE_BRIDGE_PROTOCOL,
  DeviceBridgeProtocolError,
  isUuidV4,
  protocolErrorBody
} from "./protocol-v1.js";
import {
  registerAuthenticatedRequestReplay,
  verifyAuthenticatedDeviceRequest
} from "./device-auth.js";
import {
  assertUnboundInboxConversationSweepDeviceGates
} from "./tinder-unbound-inbox-conversation-sweep-ingress.js";
import {
  createPgTinderUnboundInboxConversationSweepRepository,
  createTinderUnboundInboxConversationSweepService,
  TinderUnboundInboxConversationSweepError,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_RECEIPT_SCHEMA_VERSION,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_RECEIPT_STATUS
} from "../services/tinder-unbound-inbox-conversation-sweep.js";
import {
  assertTinderUnboundInboxConversationSweepSchemaReady
} from "./tinder-unbound-inbox-conversation-sweep-schema.js";

/* Signed V8 RETURN_ONLY completion receipt. It alone advances a parent. */

export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_PATH_SUFFIX =
  "/tinder-unbound-inbox-conversation-sweep-returns";
const FOUNDATION_ERROR_CODES = new Set(["42P01", "42703", "23502", "23503"]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function parseJson(req) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw new DeviceBridgeProtocolError(400, "INVALID_JSON", "Unbound Inbox sweep return body is not valid JSON");
  }
}

function foundationNotReadyError() {
  return new DeviceBridgeProtocolError(
    503,
    "TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_NOT_READY",
    "Unbound Inbox sweep foundation is not ready",
    true
  );
}

// RETURNED advances the parent and can mint the next child.  Canonical V8
// catalog truth therefore has to be checked in this transaction before the
// authenticated replay record or any parent/step mutation is written.
async function assertUnboundInboxConversationSweepFoundationReady(client, assertFoundationReady) {
  try {
    await assertFoundationReady(client);
  } catch {
    throw foundationNotReadyError();
  }
}

export function parseSignedUnboundInboxConversationSweepReturnRequest(req) {
  const body = parseJson(req);
  if (!exactKeys(body, ["protocol_version", "unbound_inbox_sweep_return"])) {
    throw new DeviceBridgeProtocolError(
      400,
      "INVALID_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_REQUEST",
      "Unbound Inbox sweep return request is invalid"
    );
  }
  if (body.protocol_version !== DEVICE_BRIDGE_PROTOCOL.version) {
    throw new DeviceBridgeProtocolError(400, "PROTOCOL_VERSION_MISMATCH", "Unbound Inbox sweep return protocol is invalid");
  }
  const receipt = body.unbound_inbox_sweep_return;
  if (!exactKeys(receipt, ["schema_version", "command_id", "status"])
      || receipt.schema_version !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_RECEIPT_SCHEMA_VERSION
      || !isUuidV4(receipt.command_id)
      || receipt.status !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_RECEIPT_STATUS) {
    throw new DeviceBridgeProtocolError(
      400,
      "INVALID_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_REQUEST",
      "Unbound Inbox sweep return request is invalid"
    );
  }
  return Object.freeze({
    commandId: receipt.command_id.toLowerCase(),
    status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_RECEIPT_STATUS
  });
}

/** Injects authenticated device/replay gates into the exact V8 return transaction. */
export function createAuthenticatedUnboundInboxConversationSweepReturnService(pool, auth, {
  now = () => new Date(),
  createRepository = createPgTinderUnboundInboxConversationSweepRepository,
  createService = createTinderUnboundInboxConversationSweepService,
  assertFoundationReady = assertTinderUnboundInboxConversationSweepSchemaReady
} = {}) {
  const repository = createRepository(pool);
  const transactionRepository = Object.freeze({
    ...repository,
    async withTransaction(work) {
      const client = await pool.connect();
      try {
        const transactionNow = now();
        await client.query("BEGIN");
        await assertUnboundInboxConversationSweepFoundationReady(client, assertFoundationReady);
        await assertUnboundInboxConversationSweepDeviceGates(client, auth, transactionNow);
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

function protocolErrorForSweep(error) {
  if (error instanceof TinderUnboundInboxConversationSweepError) {
    const code = Object.values(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON).includes(error.code)
      ? error.code : "TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_NOT_AVAILABLE";
    return new DeviceBridgeProtocolError(error.statusCode || 409, code, "Unbound Inbox sweep is not available");
  }
  return null;
}

export function createTinderUnboundInboxConversationSweepReturnIngressHandler(pool, {
  now = () => new Date(),
  verifyRequest = verifyAuthenticatedDeviceRequest,
  createAuthenticatedService = createAuthenticatedUnboundInboxConversationSweepReturnService
} = {}) {
  return async function tinderUnboundInboxConversationSweepReturnIngressHandler(req, res) {
    try {
      const auth = await verifyRequest({ req, pool, urlDeviceId: req.params.deviceId });
      const receipt = parseSignedUnboundInboxConversationSweepReturnRequest(req);
      const service = createAuthenticatedService(pool, auth, { now });
      const accepted = await service.acceptSignedSweepReturnReceipt({
        commandId: receipt.commandId, deviceId: auth.deviceId, status: receipt.status
      });
      if (!accepted || !["READ_QUEUED", "COMPLETED"].includes(accepted.status)) {
        throw new DeviceBridgeProtocolError(409, "TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_NOT_AVAILABLE", "Unbound Inbox sweep is not available");
      }
      return res.status(201).json({
        ok: true,
        protocol_version: DEVICE_BRIDGE_PROTOCOL.version,
        server_time: now().toISOString(),
        unbound_inbox_sweep_return: { status: "ACCEPTED" }
      });
    } catch (error) {
      const mapped = FOUNDATION_ERROR_CODES.has(error?.code) ? foundationNotReadyError()
        : protocolErrorForSweep(error) || error;
      const status = mapped instanceof DeviceBridgeProtocolError ? mapped.status : 500;
      if (!(mapped instanceof DeviceBridgeProtocolError)) console.error("Tinder unbound Inbox sweep return ingress failed.");
      return res.status(status).json(protocolErrorBody(mapped, req.get("x-marcel-request-id")));
    }
  };
}

export function registerTinderUnboundInboxConversationSweepReturnIngress({ app, pool }) {
  if (!app || typeof app.post !== "function") throw new TypeError("app.post must be a function");
  app.post(
    `/device-bridge/v1/devices/:deviceId${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_PATH_SUFFIX}`,
    createTinderUnboundInboxConversationSweepReturnIngressHandler(pool)
  );
}
