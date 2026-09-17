import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedTinderUnboundInboxSweepStartDisposition
} from "../device-bridge/tinder-unbound-inbox-sweep-start-disposition-contract.js";

test("V8 start disposition accepts only the exact bounded outcome grammar", () => {
  for (const value of [
    { status: "QUEUED" },
    { status: "INERT" },
    { status: "BLOCKED_CAPABILITY" },
    { status: "BLOCKED_V9_ACTIVE" },
    { status: "BLOCKED_V10_ACTIVE" },
    { status: "BLOCKED_FOUNDATION" },
    { status: "DEVICE_NOT_READY", reason_code: "TINDER_NOT_CONNECTED" },
    { status: "SWEEP_NOT_AVAILABLE", reason_code: "INBOX_NOT_READY" },
    { status: "PERMIT_CONFLICT", reason_code: "RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_ACTIVE" }
  ]) {
    assert.deepEqual(boundedTinderUnboundInboxSweepStartDisposition(value), value);
  }
});

test("V8 start disposition rejects correlation material, contents, and malformed pairs", () => {
  for (const value of [
    { status: "QUEUED", command_id: "forbidden" },
    { status: "QUEUED", observation_nonce: "forbidden" },
    { status: "PERMIT_CONFLICT", reason_code: "INBOX_NOT_READY" },
    { status: "SWEEP_NOT_AVAILABLE", reason_code: "SWEEP_ACTIVE" },
    { status: "DEVICE_NOT_READY", reason_code: "UNKNOWN" },
    { status: "NOT_REQUESTED" },
    { status: "BLOCKED_V9_ACTIVE", message: "forbidden" },
    { status: "INERT", transcript: "forbidden" }
  ]) {
    assert.equal(boundedTinderUnboundInboxSweepStartDisposition(value), null);
  }
});
