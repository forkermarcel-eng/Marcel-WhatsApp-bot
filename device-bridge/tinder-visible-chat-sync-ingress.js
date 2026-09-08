import {
  DEVICE_BRIDGE_PROTOCOL,
  DeviceBridgeProtocolError,
  isTinderVisibleChatSyncCapable,
  protocolErrorBody
} from "./protocol-v1.js";
import {
  registerAuthenticatedRequestReplay,
  verifyAuthenticatedDeviceRequest
} from "./device-auth.js";
import { deriveDeviceStatus } from "./heartbeat.js";
import {
  createPgTinderVisibleChatSyncRepository,
  TinderVisibleChatSyncError,
  TINDER_VISIBLE_CHAT_SYNC_REASON,
  TINDER_VISIBLE_CHAT_SYNC_STATUS
} from "../services/tinder-visible-chat-sync.js";
import {
  createTinderVisibleChatSyncStore,
  normalizeTinderVisibleChatSync,
  TinderVisibleChatSyncStoreError
} from "../services/tinder-visible-chat-sync-store.js";

/* ==================================================
TINDER V4 BOUNDED VISIBLE-CHAT SYNC INGRESS

Signed Android ingress for a staged, server-targeted current-chat transcript.
The request envelope has no name, thread, contact, capture or binding
reference. Its transcript hash is command-scoped integrity metadata, not a
conversation reference. The authenticated, locked server permit is its only
target authority. This module has no dashboard route, DDL, reply, send,
identity or mapping authority.
================================================== */

export const TINDER_VISIBLE_CHAT_SYNC_PATH_SUFFIX = "/tinder-visible-chat-syncs";
const FOUNDATION_ERROR_CODES = new Set(["42P01", "42703", "23502", "23503"]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...expected].sort().join("|");
}

function foundationNotReadyError() {
  return new DeviceBridgeProtocolError(
    503,
    "TINDER_VISIBLE_CHAT_SYNC_FOUNDATION_NOT_READY",
    "Tinder visible-chat sync foundation migration is not ready",
    true
  );
}

function safeMessage(error, fallback) {
  return typeof error?.message === "string" && error.message.length <= 180
    ? error.message : fallback;
}

function isFoundationNotReadyError(error) {
  return FOUNDATION_ERROR_CODES.has(error?.code);
}

export function parseSignedVisibleChatSyncRequest(req) {
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw new DeviceBridgeProtocolError(400, "INVALID_JSON", "Tinder visible-chat sync body is not valid JSON");
  }
  if (!exactKeys(body, ["protocol_version", "sync"])) {
    throw new DeviceBridgeProtocolError(400, "INVALID_TINDER_VISIBLE_CHAT_SYNC_REQUEST", "Tinder visible-chat sync request is invalid");
  }
  if (body.protocol_version !== DEVICE_BRIDGE_PROTOCOL.version) {
    throw new DeviceBridgeProtocolError(400, "PROTOCOL_VERSION_MISMATCH", "Tinder visible-chat sync protocol version is invalid");
  }
  try {
    return normalizeTinderVisibleChatSync(body.sync);
  } catch (error) {
    if (error instanceof TinderVisibleChatSyncStoreError) {
      throw new DeviceBridgeProtocolError(400, error.code, "Tinder visible-chat sync request is invalid");
    }
    throw error;
  }
}

async function assertVisibleChatSyncDeviceGates(client, auth, now) {
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
    throw new DeviceBridgeProtocolError(403, "DEVICE_REVOKED", "Device visible-chat sync is not authorized");
  }
  if (row.enrollment_state !== "ACTIVE") {
    throw new DeviceBridgeProtocolError(410, "RE_ENROLL_REQUIRED", "Device must enroll again");
  }
  if (!isTinderVisibleChatSyncCapable(row.capabilities)) {
    throw new DeviceBridgeProtocolError(409, "DEVICE_CAPABILITY_UNSUPPORTED", "Device does not support bounded visible-chat sync");
  }
  if (deriveDeviceStatus(row.last_accepted_heartbeat_at, now) !== "ONLINE") {
    throw new DeviceBridgeProtocolError(409, "DEVICE_OFFLINE", "Device must be online for a visible-chat sync");
  }
  if (row.bridge_service_state !== "RUNNING") {
    throw new DeviceBridgeProtocolError(409, "BRIDGE_NOT_RUNNING", "Bridge must be running for a visible-chat sync");
  }
  if (row.tinder_state !== "CONNECTED") {
    throw new DeviceBridgeProtocolError(409, "TINDER_GATE_NOT_CONNECTED", "Tinder manual gate must be connected for a visible-chat sync");
  }
  if (row.automation_state !== "STOPPED") {
    throw new DeviceBridgeProtocolError(409, "AUTOMATION_STATE_UNSAFE", "Automation must be stopped for a visible-chat sync");
  }
}

/**
 * Supplies authenticated device/replay gates to the exact same V4 repository
 * transaction used for permit lock, transcript store and permit consumption.
 */
export function createAuthenticatedVisibleChatSyncStore(pool, auth, {
  now = () => new Date(),
  createRepository = createPgTinderVisibleChatSyncRepository,
  createStore = createTinderVisibleChatSyncStore
} = {}) {
  const repository = createRepository(pool);
  const transactionRepository = Object.freeze({
    ...repository,
    async withTransaction(work) {
      const client = await pool.connect();
      try {
        const transactionNow = now();
        await client.query("BEGIN");
        await assertVisibleChatSyncDeviceGates(client, auth, transactionNow);
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

function protocolErrorForStoreResult(result) {
  if (result?.status === TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE) {
    const code = Object.values(TINDER_VISIBLE_CHAT_SYNC_REASON).includes(result.reasonCode)
      ? result.reasonCode : "SYNC_PERMIT_NOT_AVAILABLE";
    return new DeviceBridgeProtocolError(409, code, "Visible-chat sync permit is not available");
  }
  if (result?.status === TINDER_VISIBLE_CHAT_SYNC_STATUS.DEVICE_NOT_READY
      || result?.status === TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_CONFLICT) {
    const code = Object.values(TINDER_VISIBLE_CHAT_SYNC_REASON).includes(result.reasonCode)
      ? result.reasonCode : "VISIBLE_CHAT_SYNC_NOT_AVAILABLE";
    return new DeviceBridgeProtocolError(409, code, "Visible-chat sync is not available");
  }
  return new DeviceBridgeProtocolError(500, "VISIBLE_CHAT_SYNC_STORE_FAILED", "Visible-chat sync could not be stored");
}

export function createTinderVisibleChatSyncIngressHandler(pool, {
  now = () => new Date(),
  verifyRequest = verifyAuthenticatedDeviceRequest,
  createAuthenticatedStore = createAuthenticatedVisibleChatSyncStore
} = {}) {
  return async function tinderVisibleChatSyncIngressHandler(req, res) {
    try {
      const auth = await verifyRequest({ req, pool, urlDeviceId: req.params.deviceId });
      const sync = parseSignedVisibleChatSyncRequest(req);
      const store = createAuthenticatedStore(pool, auth, { now });
      const result = await store.storeStagedVisibleChatSync({ deviceId: auth.deviceId, sync });
      if (result?.status !== "ACCEPTED") throw protocolErrorForStoreResult(result);
      return res.status(201).json({
        ok: true,
        protocol_version: DEVICE_BRIDGE_PROTOCOL.version,
        server_time: now().toISOString(),
        // Operation correlation only: this is the already authenticated,
        // staged Device-Bridge command, never a Tinder/contact/capture ID.
        sync: { command_id: sync.commandId, status: "ACCEPTED" }
      });
    } catch (error) {
      const mapped = isFoundationNotReadyError(error) ? foundationNotReadyError()
        : error instanceof TinderVisibleChatSyncStoreError || error instanceof TinderVisibleChatSyncError
          ? new DeviceBridgeProtocolError(error.statusCode || 400, error.code, safeMessage(error, "Visible-chat sync is invalid"))
          : error;
      const status = mapped instanceof DeviceBridgeProtocolError ? mapped.status : 500;
      if (!(mapped instanceof DeviceBridgeProtocolError)) {
        console.error("Tinder visible-chat sync ingress failed.");
      }
      return res.status(status).json(protocolErrorBody(mapped, req.get("x-marcel-request-id")));
    }
  };
}

export function registerTinderVisibleChatSyncIngress({ app, pool }) {
  if (!app || typeof app.post !== "function") throw new TypeError("app.post must be a function");
  app.post(
    `/device-bridge/v1/devices/:deviceId${TINDER_VISIBLE_CHAT_SYNC_PATH_SUFFIX}`,
    createTinderVisibleChatSyncIngressHandler(pool)
  );
}
