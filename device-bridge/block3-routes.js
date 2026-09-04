import { createHeartbeatHandler } from "./heartbeat.js";
import { createCommandAckHandler } from "./command-ack.js";
import {
  createAdminCommandHandler,
  createAdminCommandStatusHandler,
  createAdminDeviceListHandler,
  createAdminDeviceRevokeHandler,
  createAdminDeviceStatusHandler,
  createAdminT1ReadOnlyPreflightHandler
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
  const commandStatus = createAdminCommandStatusHandler(pool);
  const t1ReadOnlyPreflight = createAdminT1ReadOnlyPreflightHandler(pool);

  const admin = handler => async (req, res) => {
    if (!dashboardApiReady(res)) return;
    if (!dashboardApiAuthorized(req)) return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
    if (!requireDeviceBridgeReady(res)) return;
    return handler(req, res);
  };

  // This fixed diagnostic must remain callable before the T1 schema is ready.
  // It retains dashboard authentication and has no mutation capability.
  const diagnostic = handler => async (req, res) => {
    if (!dashboardApiReady(res)) return;
    if (!dashboardApiAuthorized(req)) return res.status(401).json({ ok: false, error: "Nicht autorisiert." });
    return handler(req, res);
  };

  app.post("/device-bridge/v1/devices/:deviceId/heartbeat", heartbeat);
  app.post("/device-bridge/v1/devices/:deviceId/commands/:commandId/ack", commandAck);
  app.get("/dashboard-api/device-bridge/devices", admin(listDevices));
  app.get("/dashboard-api/device-bridge/devices/:deviceId/status", admin(deviceStatus));
  app.get("/dashboard-api/device-bridge/devices/:deviceId/commands/:commandId", admin(commandStatus));
  app.post("/dashboard-api/device-bridge/devices/:deviceId/revoke", admin(revokeDevice));
  app.post("/dashboard-api/device-bridge/devices/:deviceId/commands", admin(createCommand));
  app.get("/dashboard-api/device-bridge/t1-schema-preflight", diagnostic(t1ReadOnlyPreflight));
}
