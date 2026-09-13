import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedTinderUnboundInboxSweepDiagnostic
} from "../device-bridge/tinder-unbound-inbox-sweep-diagnostic-contract.js";

function diagnostic(overrides = {}) {
  return {
    stage: "INGRESS",
    command_handoff_stage: "SERVICE_HANDOFF_QUEUED",
    reason: "UNBOUND_READER_INGRESS_FAILED",
    session_state: "READ_IN_PROGRESS",
    current_slot: 1,
    reads_accepted: 0,
    returns_accepted: 0,
    reader_result: "COMPLETE",
    ingress_phase: "READ",
    ingress_outcome: "REJECTED",
    ingress_stage: "HTTP_RESPONSE",
    ...overrides
  };
}

test("V8 sweep diagnostic projects only its exact finite, content-free shape", () => {
  const source = diagnostic();
  const projected = boundedTinderUnboundInboxSweepDiagnostic(source);
  assert.deepEqual(projected, source);
  assert.notEqual(projected, source);
  assert.equal(Object.isFrozen(projected), true);
  for (const forbidden of ["id", "name", "text", "content", "fingerprint", "payload", "url", "code", "http_status", "exception"]) {
    assert.equal(Object.hasOwn(projected, forbidden), false);
  }
});

test("V8 legacy diagnostic is accepted only as a bounded NOT_REPORTED projection", () => {
  const legacy = diagnostic();
  delete legacy.command_handoff_stage;

  const projected = boundedTinderUnboundInboxSweepDiagnostic(legacy);

  assert.deepEqual(projected, {
    ...legacy,
    command_handoff_stage: "NOT_REPORTED"
  });
  assert.equal(Object.isFrozen(projected), true);
});

test("V8 sweep diagnostic fails closed for future fields, invalid enums, and unbounded counters", () => {
  for (const invalid of [
    null,
    {},
    { ...diagnostic(), extra: "future" },
    diagnostic({ command_handoff_stage: "FUTURE_STAGE" }),
    diagnostic({ stage: "UNBOUNDED" }),
    diagnostic({ reason: "raw exception" }),
    diagnostic({ session_state: "UNKNOWN" }),
    diagnostic({ reader_result: "future" }),
    diagnostic({ ingress_phase: "OTHER" }),
    diagnostic({ ingress_outcome: "FAILED" }),
    diagnostic({ ingress_stage: "raw-stack" }),
    diagnostic({ current_slot: 9 }),
    diagnostic({ reads_accepted: -1 }),
    diagnostic({ returns_accepted: 1.5 })
  ]) {
    assert.equal(boundedTinderUnboundInboxSweepDiagnostic(invalid), null);
  }
});
