import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedTinderOfficialResumeHandoffDiagnostic
} from "../device-bridge/tinder-official-resume-handoff-diagnostic-contract.js";

test("official resume handoff diagnostic projects only its exact bounded two-enum shape", () => {
  const source = {
    stage: "CANDIDATE_ACCEPTED",
    reason: "NONE"
  };
  const projected = boundedTinderOfficialResumeHandoffDiagnostic(source);
  assert.deepEqual(projected, source);
  assert.notEqual(projected, source);
  assert.equal(Object.isFrozen(projected), true);
  for (const forbidden of [
    "command_id", "permit", "capture", "binding", "revision", "identity",
    "target", "timestamp", "tree", "text", "payload", "exception", "url"
  ]) assert.equal(Object.hasOwn(projected, forbidden), false);
});

test("official resume handoff diagnostic rejects IDLE, unknown vocabulary, extra keys, and non-objects", () => {
  const valid = { stage: "BLOCKED", reason: "CANDIDATE_POLICY_REJECTED" };
  for (const value of [
    null,
    [],
    {},
    { ...valid, stage: "IDLE" },
    { ...valid, reason: "raw exception" },
    { ...valid, command_id: "forbidden" },
    { ...valid, tree: "forbidden" }
  ]) assert.equal(boundedTinderOfficialResumeHandoffDiagnostic(value), null);
});
