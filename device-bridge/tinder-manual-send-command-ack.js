import { DeviceBridgeProtocolError } from "./protocol-v1.js";
import {
  TINDER_SEND_COMMAND_TYPE,
  TINDER_SEND_INTENT_STATE
} from "../services/tinder-manual-send.js";

/* ==================================================
T5 SIGNED COMMAND ACK PROJECTION

This module is called only from the existing signed command-ACK transaction.
It never sends, retries, reads Tinder, or stores payload text.  The unique
`command_id` already reserved by T5 is the exact correlation boundary; a new
foreign key is intentionally neither needed nor authorized for this release.
================================================== */

export const TINDER_WRITER_NOT_IMPLEMENTED_CODE =
  "TINDER_WRITER_NOT_IMPLEMENTED";

const DEVICE_ACTOR = "device_bridge_t5";

function mismatch(code, message) {
  return new DeviceBridgeProtocolError(409, code, message);
}

function expectedTransition(intent, ack) {
  if (ack.status === "REJECTED" || ack.status === "EXPIRED") {
    if (intent.state !== TINDER_SEND_INTENT_STATE.PENDING_T5_WRITER) return null;
    return {
      state: TINDER_SEND_INTENT_STATE.CANCELLED,
      receivedAt: null,
      completedAt: ack.occurred_at,
      resultCode: ack.status === "REJECTED"
        ? TINDER_WRITER_NOT_IMPLEMENTED_CODE
        : "EXPIRED",
      auditAction: "SEND_CANCELLED"
    };
  }

  // T5 has no physical writer.  Its only active receipt is a direct terminal
  // rejection; RECEIVED/FAILED/SUCCEEDED remain unavailable until a separately
  // authorized writer contract exists.  In particular, this release must not
  // manufacture SEND_RESULT_UNKNOWN without a real writer-side receipt.
  return null;
}

/**
 * Project a newly accepted signed ACK using the SAME client/transaction as
 * the Device Bridge ACK write.  Duplicate ACKs short-circuit before this
 * function is called by command-ack.js.
 */
export async function projectTinderManualSendCommandAck(client, { command, ack } = {}) {
  if (command?.command_type !== TINDER_SEND_COMMAND_TYPE) return null;
  const found = await client.query(
    `SELECT intent_id, approval_id, draft_id, state, received_at
       FROM tinder_reply_send_intents
      WHERE command_id=$1
      FOR UPDATE`,
    [command.command_id]
  );
  const intent = found.rows[0] || null;
  if (!intent) {
    throw mismatch("TINDER_SEND_INTENT_NOT_FOUND", "Tinder send intent is not available for this command");
  }

  const transition = expectedTransition(intent, ack);
  if (!transition) {
    throw mismatch("TINDER_SEND_INTENT_TRANSITION_INVALID", "Tinder send intent transition is invalid");
  }

  const updated = await client.query(
    `UPDATE tinder_reply_send_intents
        SET state=$2, received_at=$3, completed_at=$4, result_code=$5,
            updated_at=NOW()
      WHERE intent_id=$1
      RETURNING intent_id`,
    [intent.intent_id, transition.state, transition.receivedAt,
      transition.completedAt, transition.resultCode]
  );
  if (updated.rows.length !== 1) {
    throw new DeviceBridgeProtocolError(500, "TINDER_SEND_INTENT_UPDATE_FAILED", "Tinder send intent could not be updated");
  }

  await client.query(
    `INSERT INTO tinder_reply_send_audit (
      action, actor, source, draft_id, approval_id, intent_id, reason_code, details
    ) VALUES ($1,$2,'tinder_manual_send',$3,$4,$5,$6,$7::jsonb)`,
    [transition.auditAction, DEVICE_ACTOR, intent.draft_id, intent.approval_id,
      intent.intent_id, transition.resultCode,
      JSON.stringify({ resultCode: transition.resultCode })]
  );
  return Object.freeze({
    intentId: intent.intent_id,
    state: transition.state,
    resultCode: transition.resultCode
  });
}
