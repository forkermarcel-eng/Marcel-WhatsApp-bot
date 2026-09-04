import { verifyDeviceBridgeSchema } from "./schema-readiness.js";
import { markDeviceBridgeReady } from "./readiness.js";

/* ==================================================
DEVICE BRIDGE T0 — DATABASE INITIALIZATION ISOLATION
================================================== */

export async function initializeDeviceBridgeDatabase(
  pool,
  {
    verifySchema = verifyDeviceBridgeSchema,
    markReady = markDeviceBridgeReady,
    logger = console
  } = {}
) {
  try {
    await verifySchema(pool);
    markReady();
    logger.log("Device Bridge Protocol V1 schema readiness verified.");
    return true;
  } catch {
    logger.error("Device Bridge Protocol V1 schema readiness check failed.");
    return false;
  }
}
