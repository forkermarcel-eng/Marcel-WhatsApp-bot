import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  runTinderDuplicateReprojectionProofPostcheckCli
} from "../scripts/verify-tinder-duplicate-reprojection-proof.js";

const CONVERSATION_ID = "d565e8a7-ef60-42d0-b19d-26e7904390fa";

function logger() {
  const lines = [];
  return { lines, log(line) { lines.push(String(line)); } };
}

function passRow(overrides = {}) {
  return {
    durable_total: 1,
    unassigned_total: 1,
    capture_links: 1,
    proof_conversation_id: CONVERSATION_ID,
    candidate_v2_unlinked_capture_total: 9,
    direct_reprojection_eligible_capture_total: 2,
    ...overrides
  };
}

function dependencies(row) {
  const calls = [];
  const output = logger();
  return {
    calls,
    output,
    environment: { DATABASE_URL: "postgres://local-proof-test@127.0.0.1:5432/postgres" },
    async createPool() {
      return { async end() { calls.push("pool.end"); } };
    },
    async assertSchemaReady(client) {
      calls.push(["schema", client]);
    },
    async readOnlyTransaction(_pool, work) {
      calls.push("read-only");
      const client = {
        async query(sql) {
          calls.push(["query", String(sql)]);
          return { rows: [row] };
        }
      };
      return work(client);
    }
  };
}

test("duplicate reprojection proof postcheck is read-only, bounded, and reports only its opaque product handle", async () => {
  const fixture = dependencies(passRow());
  const result = await runTinderDuplicateReprojectionProofPostcheckCli({
    ...fixture,
    logger: fixture.output
  });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "PROOF_CONFIRMED");
  assert.equal(result.transaction, "READ_ONLY_REPEATABLE_READ");
  assert.equal(result.rollback, "COMPLETED");
  assert.equal(result.durable_total, 1);
  assert.equal(result.unassigned_total, 1);
  assert.equal(result.capture_links, 1);
  assert.equal(result.proof_conversation_id, CONVERSATION_ID);
  assert.equal(result.candidate_v2_unlinked_capture_total, 9);
  assert.equal(result.direct_reprojection_eligible_capture_total, 2);
  assert.equal(result.historical_v2_reconciliation_only_capture_total, 7);
  assert.equal(result.strict_unambiguous_historical_thread_total, 0);
  assert.equal(result.strict_ambiguous_capture_total, 9);
  assert.equal(result.historical_thread_lower_bound, 1);
  assert.equal(result.historical_thread_upper_bound, 9);
  const sql = fixture.calls.find(call => Array.isArray(call) && call[0] === "query")[1];
  assert.match(sql, /^\s*SELECT\b/i);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|LOCK)\b/i);
  assert.doesNotMatch(sql, /(?:visible_name|display_name|runtime_thread_fingerprint|capture_id\s+AS|device_id\s+AS)/i);
  assert.equal(fixture.output.lines.length, 1);
  assert.match(fixture.output.lines[0], /proof_conversation_id=/);
});

test("duplicate reprojection proof postcheck fails closed when the exact one-row postcondition is absent", async () => {
  const fixture = dependencies(passRow({ durable_total: 2, proof_conversation_id: null }));
  const result = await runTinderDuplicateReprojectionProofPostcheckCli({
    ...fixture,
    logger: fixture.output
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "PROOF_POSTCONDITION_FAILED");
  assert.equal(result.proof_conversation_id, null);
  assert.equal(result.durable_total, 2);
  assert.equal(result.transaction, "READ_ONLY_REPEATABLE_READ");
  assert.equal(result.rollback, "COMPLETED");
});

test("duplicate reprojection proof postcheck does not connect without its explicit database authority", async () => {
  let connected = false;
  const output = logger();
  const result = await runTinderDuplicateReprojectionProofPostcheckCli({
    environment: {},
    async createPool() { connected = true; throw new Error("must not connect"); },
    logger: output
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "DATABASE_URL_REQUIRED");
  assert.equal(connected, false);
});

test("proof postcheck source contains no mutable SQL and no raw Tinder projection fields", () => {
  const source = readFileSync(new URL("../scripts/verify-tinder-duplicate-reprojection-proof.js", import.meta.url), "utf8");
  assert.match(source, /withDeviceBridgeReadOnlyTransaction/);
  assert.match(source, /assertTinderProductConversationSchemaReady/);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE)\b/i);
  assert.doesNotMatch(source, /(?:visible_name|display_name|runtime_thread_fingerprint)/i);
});
