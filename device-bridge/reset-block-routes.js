import { createResetHeartbeatHandler } from "./reset-heartbeat.js";
import { createResetCommandAckHandler } from "./reset-command-ack.js";
import { createTinderPossibleChangeHandler } from "./tinder-change-hint.js";
import {
  createResetAdminCommandHandler,
  createResetAdminCommandStatusHandler,
  createResetAdminDeviceListHandler,
  createResetAdminDeviceRevokeHandler,
  createResetAdminDeviceStatusHandler
} from "./reset-admin.js";

/* ==================================================
DEVICE BRIDGE RESET ROUTES

Retains the enrolled device's generic transport and small baseline command
surface.
================================================== */

/*
 * A co-resident local Tinder/Appium host may supply its already-created
 * source dispatcher here.  The HTTP process does not create, configure, or
 * transport an Appium connection itself: a deployed backend normally has no
 * local device session to observe.  Once a signed, accepted hint commits,
 * the callback merely invokes the supplied dispatcher's existing RAM-only
 * `signal` method.  It is deliberately best-effort and cannot influence the
 * accepted HTTP response.
 */
function tinderPossibleChangeDispatcherCallback(dispatcher = null) {
  if (dispatcher === null || dispatcher === undefined) return null;
  if (typeof dispatcher !== "object" || typeof dispatcher.signal !== "function") {
    throw new TypeError("tinderPossibleChangeDispatcher must expose signal()");
  }
  return (hint) => dispatcher.signal(hint);
}

function registerDeviceBridgeResetRoutes({
  app,
  pool,
  dashboardApiReady,
  dashboardApiAuthorized,
  requireDeviceBridgeReady,
  tinderPossibleChangeDispatcher = null
}) {
  const heartbeat = createResetHeartbeatHandler(pool);
  const commandAck = createResetCommandAckHandler(pool);
  const tinderPossibleChange = createTinderPossibleChangeHandler(pool, {
    onAccepted: tinderPossibleChangeDispatcherCallback(tinderPossibleChangeDispatcher)
  });
  const listDevices = createResetAdminDeviceListHandler(pool);
  const deviceStatus = createResetAdminDeviceStatusHandler(pool);
  const createCommand = createResetAdminCommandHandler(pool);
  const commandStatus = createResetAdminCommandStatusHandler(pool);
  const revokeDevice = createResetAdminDeviceRevokeHandler(pool);

  const admin = (handler) => async (req, res) => {
    if (!dashboardApiReady(res)) return;
    if (!dashboardApiAuthorized(req)) return res.status(401).json({ ok: false, error: "Not authorized." });
    if (!requireDeviceBridgeReady(res)) return;
    return handler(req, res);
  };

  app.post("/device-bridge/v1/devices/:deviceId/heartbeat", heartbeat);
  app.post("/device-bridge/v1/devices/:deviceId/commands/:commandId/ack", commandAck);
  app.post("/device-bridge/v1/devices/:deviceId/tinder-change-hints", tinderPossibleChange);
  app.get("/dashboard-api/device-bridge/devices", admin(listDevices));
  app.get("/dashboard-api/device-bridge/devices/:deviceId/status", admin(deviceStatus));
  app.get("/dashboard-api/device-bridge/devices/:deviceId/commands/:commandId", admin(commandStatus));
  app.post("/dashboard-api/device-bridge/devices/:deviceId/revoke", admin(revokeDevice));
  app.post("/dashboard-api/device-bridge/devices/:deviceId/commands", admin(createCommand));
}

export {
  registerDeviceBridgeResetRoutes,
  tinderPossibleChangeDispatcherCallback
};
