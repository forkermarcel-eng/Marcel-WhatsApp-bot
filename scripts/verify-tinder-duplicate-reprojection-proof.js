import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertTinderProductConversationSchemaReady
} from "../device-bridge/tinder-product-conversation-schema.js";
import {
  READ_ONLY_GUARD_CODE,
  withDeviceBridgeReadOnlyTransaction
} from "../device-bridge/read-only-transaction.js";

/*
 * One operational postcheck for the explicitly authorized duplicate-only
 * transition proof. It is not a migration, backfill, reconciliation planner,
 * or dashboard route. It reads only aggregate product state and the one
 * opaque product Conversation handle needed for the proof report.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REASONS = new Set([
  "DATABASE_URL_REQUIRED",
  "DATABASE_CONNECTION_FAILED",
  "READ_ONLY_TRANSACTION_FAILED",
  "PREFLIGHT_GUARD_BLOCKED",
  "PRODUCT_FOUNDATION_NOT_READY",
  "PROOF_POSTCONDITION_FAILED",
  "RESULT_INVALID",
  "CLEANUP_FAILED"
]);

// The fixed query intentionally emits no capture ID, device ID, name, text,
// timestamp, fingerprint, provenance value, or raw history. It uses only
// predicates needed to count the later historical-reconciliation scope.
const PROOF_POSTCHECK_SQL = `
SELECT
  (SELECT count(*)::integer
     FROM tinder_thread_conversations) AS durable_total,
  (SELECT count(*)::integer
     FROM tinder_thread_conversations
    WHERE identity_binding_state = 'UNASSIGNED'
      AND resolved_contact_id IS NULL) AS unassigned_total,
  (SELECT count(*)::integer
     FROM tinder_thread_conversation_capture_links) AS capture_links,
  (SELECT min(conversation_id::text)
     FROM tinder_thread_conversations
    WHERE identity_binding_state = 'UNASSIGNED'
      AND resolved_contact_id IS NULL) AS proof_conversation_id,
  (SELECT count(*)::integer
     FROM tinder_visible_chat_captures capture
    WHERE capture.device_id = (
      SELECT min(device_id)
        FROM tinder_thread_conversations
       WHERE identity_binding_state = 'UNASSIGNED'
         AND resolved_contact_id IS NULL
    )
      AND capture.capture_schema_version = 'tinder-visible-chat-v2'
      AND capture.source_platform = 'tinder'
      AND capture.source_package = 'com.tinder'
      AND capture.capture_safety_status = 'SAFE'
      AND capture.mapping_status = 'NEEDS_HUMAN_MAPPING'
      AND capture.human_review_status = 'PENDING'
      AND capture.resolved_contact_id IS NULL
      AND CASE
        WHEN jsonb_typeof(capture.visible_messages) = 'array'
        THEN jsonb_array_length(capture.visible_messages) > 0
        ELSE FALSE
      END
      AND NOT EXISTS (
        SELECT 1
          FROM tinder_thread_conversation_capture_links link
         WHERE link.capture_id = capture.capture_id
           AND link.device_id = capture.device_id
      )) AS candidate_v2_unlinked_capture_total,
  (SELECT count(*)::integer
     FROM tinder_visible_chat_captures capture
    WHERE capture.device_id = (
      SELECT min(device_id)
        FROM tinder_thread_conversations
       WHERE identity_binding_state = 'UNASSIGNED'
         AND resolved_contact_id IS NULL
    )
      AND capture.capture_schema_version = 'tinder-visible-chat-v2'
      AND capture.source_platform = 'tinder'
      AND capture.source_package = 'com.tinder'
      AND capture.capture_safety_status = 'SAFE'
      AND capture.mapping_status = 'NEEDS_HUMAN_MAPPING'
      AND capture.human_review_status = 'PENDING'
      AND capture.resolved_contact_id IS NULL
      AND CASE
        WHEN jsonb_typeof(capture.visible_messages) = 'array'
        THEN jsonb_array_length(capture.visible_messages) > 0
        ELSE FALSE
      END
      AND capture.provenance ->> 'source' = 'android_visible_chat'
      AND capture.provenance ->> 'protocolVersion' = '1'
      AND capture.provenance ->> 'readChannel' = 'PASSIVE_READ'
      AND NOT EXISTS (
        SELECT 1
          FROM tinder_thread_conversation_capture_links link
         WHERE link.capture_id = capture.capture_id
           AND link.device_id = capture.device_id
      )) AS direct_reprojection_eligible_capture_total`;

function integer(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized >= 0 && normalized <= 1_000_000
    ? normalized : null;
}

function proofConversationId(value) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return UUID_V4.test(normalized) ? normalized : null;
}

function boundedResult({
  ok = false,
  reason = "RESULT_INVALID",
  transaction = "NOT_STARTED",
  rollback = "NOT_ATTEMPTED",
  durableTotal = 0,
  unassignedTotal = 0,
  captureLinks = 0,
  proofConversationId: conversationId = null,
  candidateV2UnlinkedCaptureTotal = 0,
  directReprojectionEligibleCaptureTotal = 0
} = {}) {
  const durable = integer(durableTotal);
  const unassigned = integer(unassignedTotal);
  const links = integer(captureLinks);
  const candidates = integer(candidateV2UnlinkedCaptureTotal);
  const direct = integer(directReprojectionEligibleCaptureTotal);
  const valid = durable !== null && unassigned !== null && links !== null
    && candidates !== null && direct !== null && direct <= candidates;
  const passes = ok === true && valid && durable === 1 && unassigned === 1 && links === 1
    && proofConversationId(conversationId) !== null;
  return Object.freeze({
    ok: passes,
    reason: passes ? "PROOF_CONFIRMED"
      : ok === true ? "PROOF_POSTCONDITION_FAILED"
      : REASONS.has(reason) ? reason : "RESULT_INVALID",
    transaction: transaction === "READ_ONLY_REPEATABLE_READ" ? transaction : "NOT_STARTED",
    rollback: rollback === "COMPLETED" ? rollback : "NOT_ATTEMPTED",
    durable_total: valid ? durable : 0,
    unassigned_total: valid ? unassigned : 0,
    capture_links: valid ? links : 0,
    proof_conversation_id: passes ? proofConversationId(conversationId) : null,
    candidate_v2_unlinked_capture_total: valid ? candidates : 0,
    direct_reprojection_eligible_capture_total: valid ? direct : 0,
    historical_v2_reconciliation_only_capture_total: valid ? candidates - direct : 0,
    strict_unambiguous_historical_thread_total: 0,
    strict_ambiguous_capture_total: valid ? candidates : 0,
    historical_thread_lower_bound: valid && candidates > 0 ? 1 : 0,
    historical_thread_upper_bound: valid ? candidates : 0
  });
}

function logResult(logger, result) {
  logger.log(
    `Tinder duplicate reprojection proof postcheck: status=${result.ok ? "PASS" : "FAIL"}`
      + ` reason=${result.reason} durable_total=${result.durable_total}`
      + ` unassigned_total=${result.unassigned_total} capture_links=${result.capture_links}`
      + ` proof_conversation_id=${result.proof_conversation_id || "NONE"}`
      + ` candidate_v2_unlinked_capture_total=${result.candidate_v2_unlinked_capture_total}`
      + ` direct_reprojection_eligible_capture_total=${result.direct_reprojection_eligible_capture_total}`
      + ` historical_v2_reconciliation_only_capture_total=${result.historical_v2_reconciliation_only_capture_total}`
      + ` strict_unambiguous_historical_thread_total=${result.strict_unambiguous_historical_thread_total}`
      + ` strict_ambiguous_capture_total=${result.strict_ambiguous_capture_total}`
      + ` historical_thread_lower_bound=${result.historical_thread_lower_bound}`
      + ` historical_thread_upper_bound=${result.historical_thread_upper_bound}`
      + ` transaction=${result.transaction} rollback=${result.rollback}`
  );
}

function reasonFor(error) {
  if (error?.code === READ_ONLY_GUARD_CODE) return "PREFLIGHT_GUARD_BLOCKED";
  if (error?.message === "Tinder product conversation schema is not ready.") {
    return "PRODUCT_FOUNDATION_NOT_READY";
  }
  return "READ_ONLY_TRANSACTION_FAILED";
}

export async function runTinderDuplicateReprojectionProofPostcheckCli({
  environment = process.env,
  createPool = async options => {
    const { default: pg } = await import("pg");
    return new pg.Pool(options);
  },
  assertSchemaReady = assertTinderProductConversationSchemaReady,
  readOnlyTransaction = withDeviceBridgeReadOnlyTransaction,
  logger = console
} = {}) {
  if (!environment.DATABASE_URL) {
    const result = boundedResult({ reason: "DATABASE_URL_REQUIRED" });
    logResult(logger, result);
    return result;
  }
  let pool;
  let poolCreated = false;
  let enteredTransaction = false;
  let result;
  try {
    pool = await createPool({ connectionString: environment.DATABASE_URL });
    poolCreated = true;
    const row = await readOnlyTransaction(pool, async client => {
      enteredTransaction = true;
      await assertSchemaReady(client);
      const queried = await client.query(PROOF_POSTCHECK_SQL);
      if (!Array.isArray(queried?.rows) || queried.rows.length !== 1) {
        throw new Error("Tinder duplicate reprojection proof result is invalid.");
      }
      return queried.rows[0];
    });
    result = boundedResult({
      ok: true,
      reason: "PROOF_CONFIRMED",
      transaction: "READ_ONLY_REPEATABLE_READ",
      rollback: "COMPLETED",
      durableTotal: row.durable_total,
      unassignedTotal: row.unassigned_total,
      captureLinks: row.capture_links,
      proofConversationId: row.proof_conversation_id,
      candidateV2UnlinkedCaptureTotal: row.candidate_v2_unlinked_capture_total,
      directReprojectionEligibleCaptureTotal: row.direct_reprojection_eligible_capture_total
    });
  } catch (error) {
    result = boundedResult({
      reason: poolCreated ? reasonFor(error) : "DATABASE_CONNECTION_FAILED",
      transaction: enteredTransaction ? "READ_ONLY_REPEATABLE_READ" : "NOT_STARTED",
      rollback: enteredTransaction ? "COMPLETED" : "NOT_ATTEMPTED"
    });
  }
  try {
    await pool?.end();
  } catch {
    result = boundedResult({
      ...result,
      reason: "CLEANUP_FAILED",
      transaction: result?.transaction,
      rollback: result?.rollback
    });
  }
  logResult(logger, result);
  return result;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runTinderDuplicateReprojectionProofPostcheckCli();
  if (!result.ok) process.exitCode = 1;
}
