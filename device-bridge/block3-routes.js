import { createHeartbeatHandler } from "./heartbeat.js";
import { createCommandAckHandler } from "./command-ack.js";
import {
  createAdminCommandHandler,
  createAdminDeviceListHandler,
  createAdminDeviceRevokeHandler,
  createAdminDeviceStatusHandler
} from "./admin.js";

/* ==================================================
DEVICE BRIDGE T0 — BLOCK 3 ROUTES
================================================== */

export function registerDeviceBridgeBlock3Routes({
  app,
  pool,
  dashboardApiReady,
  dashboardApiAuthorized,
  requireDeviceBridgeReady
}) {
  const heartbeat = createHeartbeatHandler(pool);
  const commandAck = createCommandAckHandler(pool);
  const listDevices = createAdminDeviceListHandler(pool);
  const deviceStatus = createAdminDeviceStatusHandler(pool);
  const revokeDevice = createAdminDeviceRevokeHandler(pool);
  const createCommand = createAdminCommandHandler(pool);

  const admin = handler => async (req, res) => {
    if (!dashboardApiReady(res)) return;
    if (!dashboardApiAuthorized(req)) return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
    if (!requireDeviceBridgeReady(res)) return;
    return handler(req, res);
  };

  app.post("/device-bridge/v1/devices/:deviceId/heartbeat", heartbeat);
  app.post("/device-bridge/v1/devices/:deviceId/commands/:commandId/ack", commandAck);
  app.get("/dashboard-api/device-bridge/devices", admin(listDevices));
  app.get("/dashboard-api/device-bridge/devices/:deviceId/status", admin(deviceStatus));
  app.post("/dashboard-api/device-bridge/devices/:deviceId/revoke", admin(revokeDevice));
  app.post("/dashboard-api/device-bridge/devices/:deviceId/commands", admin(createCommand));
}
