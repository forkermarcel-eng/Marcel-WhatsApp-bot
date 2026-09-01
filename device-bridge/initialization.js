import { ensureDeviceBridgeTables } from "./database.js";
import { markDeviceBridgeReady } from "./readiness.js";

/* ==================================================
DEVICE BRIDGE T0 — DATABASE INITIALIZATION ISOLATION
================================================== */

export async function initializeDeviceBridgeDatabase(
  pool,
  {
    ensureTables = ensureDeviceBridgeTables,
    markReady = markDeviceBridgeReady,
    logger = console
  } = {}
) {
  try {
    await ensureTables(pool);
    markReady();
    logger.log("Device Bridge T0 Protocol V1 database foundation ready.");
    return true;
  } catch {
    logger.error("Device Bridge T0 Protocol V1 database initialization failed.");
    return false;
  }
}
