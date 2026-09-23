import { createResetHeartbeatHandler } from "./reset-heartbeat.js";
import { createResetCommandAckHandler } from "./reset-command-ack.js";
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
surface.  The historical Tinder lifecycle is intentionally absent.
================================================== */

function registerDeviceBridgeResetRoutes({
  app,
  pool,
  dashboardApiReady,
  dashboardApiAuthorized,
  requireDeviceBridgeReady
}) {
  const heartbeat = createResetHeartbeatHandler(pool);
  const commandAck = createResetCommandAckHandler(pool);
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
  app.get("/dashboard-api/device-bridge/devices", admin(listDevices));
  app.get("/dashboard-api/device-bridge/devices/:deviceId/status", admin(deviceStatus));
  app.get("/dashboard-api/device-bridge/devices/:deviceId/commands/:commandId", admin(commandStatus));
  app.post("/dashboard-api/device-bridge/devices/:deviceId/revoke", admin(revokeDevice));
  app.post("/dashboard-api/device-bridge/devices/:deviceId/commands", admin(createCommand));
}

export { registerDeviceBridgeResetRoutes };
