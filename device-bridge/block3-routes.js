import { createHeartbeatHandler } from "./heartbeat.js";
import {
  createAdminCommandHandler,
  createAdminDeviceListHandler,
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
  const listDevices = createAdminDeviceListHandler(pool);
  const deviceStatus = createAdminDeviceStatusHandler(pool);
  const createCommand = createAdminCommandHandler(pool);

  const admin = handler => async (req, res) => {
    if (!dashboardApiReady(res)) return;
    if (!dashboardApiAuthorized(req)) return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
    if (!requireDeviceBridgeReady(res)) return;
    return handler(req, res);
  };

  app.post("/device-bridge/v1/devices/:deviceId/heartbeat", heartbeat);
  app.get("/dashboard-api/device-bridge/devices", admin(listDevices));
  app.get("/dashboard-api/device-bridge/devices/:deviceId/status", admin(deviceStatus));
  app.post("/dashboard-api/device-bridge/devices/:deviceId/commands", admin(createCommand));
}
