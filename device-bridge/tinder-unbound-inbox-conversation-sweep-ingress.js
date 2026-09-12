import {
  DEVICE_BRIDGE_PROTOCOL,
  DeviceBridgeProtocolError,
  isTinderUnboundInboxConversationSweepCapable,
  protocolErrorBody
} from "./protocol-v1.js";
import {
  registerAuthenticatedRequestReplay,
  verifyAuthenticatedDeviceRequest
} from "./device-auth.js";
import { deriveDeviceStatus } from "./heartbeat.js";
import {
  createPgTinderUnboundInboxConversationSweepRepository,
  TinderUnboundInboxConversationSweepError,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON
} from "../services/tinder-unbound-inbox-conversation-sweep.js";
import {
  createTinderUnboundInboxConversationSweepStore,
  normalizeTinderUnboundInboxConversationSweepTranscript,
  TinderUnboundInboxConversationSweepStoreError
} from "../services/tinder-unbound-inbox-conversation-sweep-store.js";
import {
  assertTinderUnboundInboxConversationSweepSchemaReady
} from "./tinder-unbound-inbox-conversation-sweep-schema.js";

/* Signed V8 READ transcript ingress. Separate from V4. */

export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_PATH_SUFFIX =
  "/tinder-unbound-inbox-conversation-sweep-transcripts";
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
    "TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_NOT_READY",
    "Unbound Inbox sweep foundation is not ready",
    true
  );
}

// The transcript ingress is a V8 state transition, not a best-effort
// persistence endpoint.  Inspect the exact canonical catalog inside the
// same transaction before replay registration or any sweep write.  A catalog
// mismatch is deliberately indistinguishable from an unavailable foundation.
async function assertUnboundInboxConversationSweepFoundationReady(client, assertFoundationReady) {
  try {
    await assertFoundationReady(client);
  } catch {
    throw foundationNotReadyError();
  }
}

function parseJson(req) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw new DeviceBridgeProtocolError(400, "INVALID_JSON", "Unbound Inbox sweep transcript body is not valid JSON");
  }
}

export function parseSignedUnboundInboxConversationSweepTranscriptRequest(req) {
  const body = parseJson(req);
  if (!exactKeys(body, ["protocol_version", "unbound_inbox_sweep_read"])) {
    throw new DeviceBridgeProtocolError(
      400,
      "INVALID_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_REQUEST",
      "Unbound Inbox sweep transcript request is invalid"
    );
  }
  if (body.protocol_version !== DEVICE_BRIDGE_PROTOCOL.version) {
    throw new DeviceBridgeProtocolError(400, "PROTOCOL_VERSION_MISMATCH", "Unbound Inbox sweep transcript protocol is invalid");
  }
  try {
    return normalizeTinderUnboundInboxConversationSweepTranscript(body.unbound_inbox_sweep_read);
  } catch (error) {
    if (error instanceof TinderUnboundInboxConversationSweepStoreError) {
      throw new DeviceBridgeProtocolError(400, error.code, "Unbound Inbox sweep transcript request is invalid");
    }
    throw error;
  }
}

export async function assertUnboundInboxConversationSweepDeviceGates(client, auth, now) {
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
    throw new DeviceBridgeProtocolError(403, "DEVICE_REVOKED", "Device unbound Inbox sweep is not authorized");
  }
  if (row.enrollment_state !== "ACTIVE") {
    throw new DeviceBridgeProtocolError(410, "RE_ENROLL_REQUIRED", "Device must enroll again");
  }
  if (!isTinderUnboundInboxConversationSweepCapable(row.capabilities)) {
    throw new DeviceBridgeProtocolError(409, "DEVICE_CAPABILITY_UNSUPPORTED", "Device does not support unbound Inbox sweeps");
  }
  if (deriveDeviceStatus(row.last_accepted_heartbeat_at, now) !== "ONLINE") {
    throw new DeviceBridgeProtocolError(409, "DEVICE_OFFLINE", "Device must be online for an unbound Inbox sweep");
  }
  if (row.bridge_service_state !== "RUNNING") {
    throw new DeviceBridgeProtocolError(409, "BRIDGE_NOT_RUNNING", "Bridge must be running for an unbound Inbox sweep");
  }
  if (row.tinder_state !== "CONNECTED") {
    throw new DeviceBridgeProtocolError(409, "TINDER_GATE_NOT_CONNECTED", "Tinder manual gate must be connected for an unbound Inbox sweep");
  }
  if (row.automation_state !== "STOPPED") {
    throw new DeviceBridgeProtocolError(409, "AUTOMATION_STATE_UNSAFE", "Automation must be stopped for an unbound Inbox sweep");
  }
}

/** Injects authenticated device/replay gates into the exact V8 store transaction. */
export function createAuthenticatedUnboundInboxConversationSweepStore(pool, auth, {
  now = () => new Date(),
  createRepository = createPgTinderUnboundInboxConversationSweepRepository,
  createStore = createTinderUnboundInboxConversationSweepStore,
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
  return createStore(transactionRepository, { now });
}

function protocolErrorForSweep(error) {
  if (error instanceof TinderUnboundInboxConversationSweepError) {
    const code = Object.values(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON).includes(error.code)
      ? error.code : "TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_NOT_AVAILABLE";
    return new DeviceBridgeProtocolError(error.statusCode || 409, code, "Unbound Inbox sweep is not available");
  }
  return null;
}

export function createTinderUnboundInboxConversationSweepTranscriptIngressHandler(pool, {
  now = () => new Date(),
  verifyRequest = verifyAuthenticatedDeviceRequest,
  createAuthenticatedStore = createAuthenticatedUnboundInboxConversationSweepStore
} = {}) {
  return async function tinderUnboundInboxConversationSweepTranscriptIngressHandler(req, res) {
    try {
      const auth = await verifyRequest({ req, pool, urlDeviceId: req.params.deviceId });
      const transcript = parseSignedUnboundInboxConversationSweepTranscriptRequest(req);
      const store = createAuthenticatedStore(pool, auth, { now });
      const stored = await store.storeStagedUnboundInboxConversationSweepTranscript({
        deviceId: auth.deviceId, transcript
      });
      if (stored?.status !== "ACCEPTED") {
        throw new DeviceBridgeProtocolError(409, "TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_NOT_AVAILABLE", "Unbound Inbox sweep is not available");
      }
      return res.status(201).json({
        ok: true,
        protocol_version: DEVICE_BRIDGE_PROTOCOL.version,
        server_time: now().toISOString(),
        unbound_inbox_sweep_read: { status: "ACCEPTED" }
      });
    } catch (error) {
      const mapped = FOUNDATION_ERROR_CODES.has(error?.code) ? foundationNotReadyError()
        : protocolErrorForSweep(error) || error;
      const status = mapped instanceof DeviceBridgeProtocolError ? mapped.status : 500;
      if (!(mapped instanceof DeviceBridgeProtocolError)) console.error("Tinder unbound Inbox sweep transcript ingress failed.");
      return res.status(status).json(protocolErrorBody(mapped, req.get("x-marcel-request-id")));
    }
  };
}

export function registerTinderUnboundInboxConversationSweepTranscriptIngress({ app, pool }) {
  if (!app || typeof app.post !== "function") throw new TypeError("app.post must be a function");
  app.post(
    `/device-bridge/v1/devices/:deviceId${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_PATH_SUFFIX}`,
    createTinderUnboundInboxConversationSweepTranscriptIngressHandler(pool)
  );
}
