import {
  DeviceBridgeProtocolError,
  assertJsonUtf8ContentType,
  assertRawBody,
  protocolErrorBody
} from "./protocol-v1.js";

/* ==================================================
DEVICE BRIDGE T0 — PROTOCOL V1 READINESS
================================================== */

let ready = false;

export function markDeviceBridgeReady() {
  ready = true;
}

export function isDeviceBridgeReady() {
  return ready;
}

export function requireDeviceBridgeReady(res) {
  if (ready) return true;
  const error = new DeviceBridgeProtocolError(503, "BACKEND_NOT_READY", "Device bridge backend is not ready", true);
  res.status(error.status).json(protocolErrorBody(error));
  return false;
}

export function deviceBridgeFoundationMiddleware(req, res, next) {
  try {
    if (req.originalUrl.includes("?")) {
      throw new DeviceBridgeProtocolError(400, "INVALID_HEADER", "Signed device bridge routes do not accept query strings");
    }
    assertJsonUtf8ContentType(req.get("content-type"));
    assertRawBody(req.body);
    if (!ready) {
      throw new DeviceBridgeProtocolError(503, "BACKEND_NOT_READY", "Device bridge backend is not ready", true);
    }
    next();
  } catch (error) {
    const status = error instanceof DeviceBridgeProtocolError ? error.status : 500;
    res.status(status).json(protocolErrorBody(error, req.get("x-marcel-request-id")));
  }
}

export function deviceBridgeRawBodyErrorMiddleware(error, req, res, next) {
  if (!error) return next();
  const mapped = error.type === "entity.too.large"
    ? new DeviceBridgeProtocolError(400, "REQUEST_TOO_LARGE", "Device bridge request exceeds 64 KiB")
    : new DeviceBridgeProtocolError(400, "INVALID_BODY", "Device bridge request body is invalid");
  res.status(mapped.status).json(protocolErrorBody(mapped, req.get("x-marcel-request-id")));
}
