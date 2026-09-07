import {
  hydrateFutureTinderSendCommandPayload,
  TINDER_SEND_COMMAND_TYPE,
  TinderManualSendError
} from "../services/tinder-manual-send.js";

/* ==================================================
T5 SIGNED COMMAND — TRANSIENT HEARTBEAT HYDRATION

`device_bridge_commands.payload` contains a content-free descriptor only.
The exact 21-field payload is rebuilt in memory under the existing signed
heartbeat transaction's row locks.  This module has no write, retry, route,
or Tinder-access authority.
================================================== */

const HYDRATION_SQL = `
  SELECT
    jsonb_build_object(
      'command_id', command.command_id,
      'device_id', command.device_id,
      'protocol_version', command.protocol_version,
      'command_type', command.command_type,
      'payload', command.payload,
      'configuration_revision', command.configuration_revision,
      'issued_at', command.issued_at,
      'expires_at', command.expires_at,
      'terminal_status', command.terminal_status
    ) AS command,
    jsonb_build_object(
      'draft_id', draft.draft_id,
      'draft_status', draft.status,
      'draft_revision', draft.draft_revision,
      'contact_id', draft.contact_id,
      'capture_id', draft.capture_id,
      'runtime_thread_fingerprint', draft.runtime_thread_fingerprint,
      'capture_revision', draft.capture_revision,
      'draft_identity_revision', draft.identity_revision,
      'original_draft', draft.original_draft,
      'current_identity_revision', capture.identity_revision,
      'capture_fingerprint', capture.capture_fingerprint,
      'capture_safety_status', capture.capture_safety_status,
      'mapping_status', capture.mapping_status,
      'human_review_status', capture.human_review_status,
      'resolved_contact_id', capture.resolved_contact_id,
      'device_id', capture.device_id,
      'human_takeover_active', capture.human_takeover_active,
      'handoff_active', capture.handoff_active,
      'device_enrollment_state', device.enrollment_state,
      'bridge_service_state', device.bridge_service_state,
      'tinder_state', device.tinder_state,
      'automation_state', device.automation_state,
      'configuration_revision', device.configuration_revision,
      'device_capabilities', device.capabilities,
      'last_accepted_heartbeat_at', device.last_accepted_heartbeat_at,
      'latest_capture_revision', (
        SELECT MAX(newer.capture_revision)
        FROM tinder_visible_chat_captures newer
        WHERE newer.device_id = capture.device_id
          AND newer.runtime_thread_fingerprint = capture.runtime_thread_fingerprint
      )
    ) AS snapshot,
    jsonb_build_object(
      'approval_id', approval.approval_id,
      'draft_id', approval.draft_id,
      'draft_revision', approval.draft_revision,
      'contact_id', approval.contact_id,
      'capture_id', approval.capture_id,
      'capture_fingerprint', approval.capture_fingerprint,
      'thread_ref_kind', approval.thread_ref_kind,
      'runtime_thread_fingerprint', approval.runtime_thread_fingerprint,
      'capture_revision', approval.capture_revision,
      'identity_revision', approval.identity_revision,
      'approved_text_sha256', approval.approved_text_sha256,
      'approval_binding_sha256', approval.approval_binding_sha256,
      'approved_by', approval.approved_by,
      'approved_at', approval.approved_at,
      'state', approval.state
    ) AS approval,
    jsonb_build_object(
      'intent_id', intent.intent_id,
      'approval_id', intent.approval_id,
      'draft_id', intent.draft_id,
      'draft_revision', intent.draft_revision,
      'contact_id', intent.contact_id,
      'capture_id', intent.capture_id,
      'capture_fingerprint', intent.capture_fingerprint,
      'thread_ref_kind', intent.thread_ref_kind,
      'runtime_thread_fingerprint', intent.runtime_thread_fingerprint,
      'identity_revision', intent.identity_revision,
      'command_id', intent.command_id,
      'command_type', intent.command_type,
      'protocol_version', intent.protocol_version,
      'approved_text_sha256', intent.approved_text_sha256,
      'approval_binding_sha256', intent.approval_binding_sha256,
      'delivery_policy_revision', intent.delivery_policy_revision,
      'not_before', intent.not_before,
      'expires_at', intent.expires_at,
      'typing_duration_ms', intent.typing_duration_ms,
      'state', intent.state,
      'received_at', intent.received_at,
      'completed_at', intent.completed_at,
      'result_code', intent.result_code,
      'created_at', intent.created_at
    ) AS intent
  FROM device_bridge_commands command
  JOIN tinder_reply_send_intents intent ON intent.command_id = command.command_id
  JOIN tinder_reply_send_approvals approval ON approval.approval_id = intent.approval_id
  JOIN tinder_reply_drafts draft ON draft.draft_id = intent.draft_id
  JOIN tinder_visible_chat_captures capture ON capture.capture_id = intent.capture_id
  JOIN device_bridge_devices device ON device.device_id = command.device_id
  WHERE command.command_id = $1
    AND command.device_id = $2
    AND command.command_type = '${TINDER_SEND_COMMAND_TYPE}'
    AND command.terminal_status IS NULL
  /* The signed capture ingress locks this same device row before it computes
     a capture revision and inserts a capture.  The heartbeat transaction
     locked the device before reaching this query, so the MAX snapshot and
     this delivery decision are serialized against a concurrent capture. */
  FOR UPDATE OF command, intent, approval, draft, capture, device
`;

/**
 * Returns the full envelope only for the current heartbeat response.  A
 * missing/stale/inconsistent source returns null and leaves every durable row
 * unchanged.  Database failures are deliberately allowed to abort the signed
 * heartbeat transaction rather than being reclassified as a deliverable row.
 */
export async function hydrateTinderManualSendCommandForHeartbeat(client, {
  commandId,
  deviceId,
  now = new Date()
} = {}) {
  const result = await client.query(HYDRATION_SQL, [commandId, deviceId]);
  const row = result.rows[0] || null;
  if (!row) return null;
  try {
    return hydrateFutureTinderSendCommandPayload({
      command: row.command,
      snapshot: row.snapshot,
      approval: row.approval,
      intent: row.intent,
      now
    });
  } catch (error) {
    if (error instanceof TinderManualSendError) return null;
    throw error;
  }
}

export { HYDRATION_SQL };
