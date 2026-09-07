import { DEVICE_BRIDGE_PROTOCOL } from "../device-bridge/protocol-v1.js";

/* ==================================================
T5 MANUAL SEND — SERVER-OWNED DELIVERY WINDOW

This is not a sender and contains no text, selector, browser or device
operation.  It only gives an already human-approved, server-bound intent a
short finite command window.  The command can still be rejected by every
downstream gate, including the deliberately blocked Android writer.
================================================== */

export const TINDER_MANUAL_SEND_DELIVERY_POLICY_REVISION =
  "tinder_manual_send_v1";
export const TINDER_MANUAL_SEND_DELIVERY_WINDOW_MS =
  DEVICE_BRIDGE_PROTOCOL.signatureWindowSeconds * 1000;

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validUuid(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function issueTime(now) {
  const value = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(value.valueOf())) throw new TypeError("Manual send policy time is invalid.");
  return value;
}

/**
 * A small server-only adapter.  It receives identifiers only and returns
 * fixed bounded timing; neither dashboard nor Android may supply policy
 * values.  `typingDurationMs` remains zero while the physical writer is
 * intentionally unavailable.
 */
export function createTinderManualSendDeliveryPolicy({ now = () => new Date() } = {}) {
  if (typeof now !== "function") throw new TypeError("now must be a function");

  return async function issueManualTinderSendDeliveryPlan(context = {}) {
    if (!validUuid(context.draftId) || !positiveInteger(context.draftRevision) ||
        !positiveInteger(context.contactId) || !validUuid(context.captureId) ||
        !validUuid(context.approvalId)) {
      return null;
    }
    const issuedAt = issueTime(now());
    return Object.freeze({
      revision: TINDER_MANUAL_SEND_DELIVERY_POLICY_REVISION,
      notBefore: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.valueOf() + TINDER_MANUAL_SEND_DELIVERY_WINDOW_MS).toISOString(),
      typingDurationMs: 0
    });
  };
}
