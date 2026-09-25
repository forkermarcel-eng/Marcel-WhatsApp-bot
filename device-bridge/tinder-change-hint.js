import {
  DeviceBridgeProtocolError,
  isExactUtcTimestamp,
  protocolErrorBody
} from "./protocol-v1.js";
import {
  registerAuthenticatedRequestReplay,
  verifyAuthenticatedDeviceRequest
} from "./device-auth.js";

/* ==================================================
TINDER POSSIBLE CHANGE — BEST-EFFORT DEVICE HINT

This signed ingress is deliberately content-free.  It is only a wake-up
hint for a separately local, source-of-truth Tinder inventory.  It neither
creates work, grants an action, stores an Inbox snapshot, nor changes any
Bridge/heartbeat state.  Delivery failure is intentionally harmless: the
next ordinary source inventory remains authoritative.
================================================== */

const ROOT_FIELDS = new Set(["protocol_version", "sent_at", "event_type"]);
const EVENT_TYPE = "TINDER_POSSIBLE_CHANGE";

function invalidHint(message = "Tinder change hint is invalid") {
  return new DeviceBridgeProtocolError(400, "INVALID_BODY", message);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseAndValidateTinderPossibleChange(req) {
  let body;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(req.body));
  } catch {
    throw new DeviceBridgeProtocolError(400, "INVALID_JSON", "Tinder change hint body is not valid JSON");
  }
  if (!plainObject(body) || Object.keys(body).some((key) => !ROOT_FIELDS.has(key))) {
    throw invalidHint();
  }
  if (Object.keys(body).length !== ROOT_FIELDS.size
      || body.protocol_version !== 1
      || body.event_type !== EVENT_TYPE
      || body.sent_at !== req.get("x-marcel-timestamp")
      || !isExactUtcTimestamp(body.sent_at)) {
    throw invalidHint();
  }
  return Object.freeze({ sent_at: body.sent_at, event_type: EVENT_TYPE });
}

function response(now) {
  return Object.freeze({
    ok: true,
    protocol_version: 1,
    accepted_at: now.toISOString(),
    event_type: EVENT_TYPE,
    delivery: "BEST_EFFORT"
  });
}

async function processTinderPossibleChangeTransaction(pool, auth, _hint, now = new Date()) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT d.device_id, d.enrollment_state, d.revoked_at,
              k.key_id, k.revoked_at AS key_revoked_at
         FROM device_bridge_devices d
         JOIN device_bridge_keys k ON k.device_id=d.device_id AND k.key_id=$2
        WHERE d.device_id=$1
        FOR UPDATE OF d, k`,
      [auth.deviceId, auth.keyId]
    );
    const device = locked.rows[0];
    if (!device || device.enrollment_state === "REVOKED" || device.revoked_at || device.key_revoked_at) {
      throw new DeviceBridgeProtocolError(403, "DEVICE_REVOKED", "Device change hint is not authorized");
    }
    if (device.enrollment_state !== "ACTIVE") {
      throw new DeviceBridgeProtocolError(410, "RE_ENROLL_REQUIRED", "Device must enroll again");
    }

    await registerAuthenticatedRequestReplay(client, auth, now);
    // Existing audit telemetry only.  This is not a durable event queue and
    // no later action reads it as a gate or authorization decision.
    await client.query(
      `INSERT INTO device_bridge_audit_events
         (event_type, request_id, device_id, key_id, result_code, http_status, details)
       VALUES ('TINDER_POSSIBLE_CHANGE_ACCEPTED',$1,$2,$3,'SUCCEEDED',200,'{}'::jsonb)`,
      [auth.requestId, auth.deviceId, auth.keyId]
    );
    await client.query("COMMIT");
    return response(now);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function createTinderPossibleChangeHandler(pool, { onAccepted = null } = {}) {
  if (onAccepted !== null && typeof onAccepted !== "function") {
    throw new TypeError("onAccepted must be a function or null");
  }
  return async function tinderPossibleChangeHandler(req, res) {
    try {
      const auth = await verifyAuthenticatedDeviceRequest({ req, pool, urlDeviceId: req.params.deviceId });
      const hint = parseAndValidateTinderPossibleChange(req);
      const accepted = await processTinderPossibleChangeTransaction(pool, auth, hint);
      // A live local dispatcher may be attached by the local Appium host.
      // It is intentionally best-effort and cannot affect this response.
      if (onAccepted) {
        Promise.resolve(onAccepted(Object.freeze({ device_id: auth.deviceId, event_type: EVENT_TYPE }))).catch(() => {});
      }
      return res.status(200).json(accepted);
    } catch (error) {
      const status = error instanceof DeviceBridgeProtocolError ? error.status : 500;
      if (!(error instanceof DeviceBridgeProtocolError)) console.error("Tinder possible-change hint failed.");
      return res.status(status).json(protocolErrorBody(error, req.get("x-marcel-request-id")));
    }
  };
}

export {
  EVENT_TYPE as TINDER_POSSIBLE_CHANGE_EVENT_TYPE,
  createTinderPossibleChangeHandler,
  parseAndValidateTinderPossibleChange,
  processTinderPossibleChangeTransaction
};
