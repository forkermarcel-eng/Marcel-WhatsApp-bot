import { DeviceBridgeProtocolError } from "./protocol-v1.js";
import {
  isExactVisibleChatSyncStagedAcknowledgement,
  TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
  TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE
} from "../services/tinder-visible-chat-sync.js";

/* ==================================================
TINDER V4 VISIBLE-CHAT SYNC — ACK PROJECTION

This runs only inside the already-authenticated command-ACK transaction. A
successful ACK records STAGED, never CAPTURED or COMPLETED. It creates no
capture, identity, display, message, or fingerprint association.
================================================== */

function mismatch(code, message) {
  return new DeviceBridgeProtocolError(409, code, message);
}

function terminalTransition(ack) {
  if (ack.status === "SUCCEEDED") {
    if (!isExactVisibleChatSyncStagedAcknowledgement(ack.result)) {
      throw mismatch("TINDER_VISIBLE_CHAT_SYNC_ACK_INVALID", "Visible-chat sync acknowledgement is not staged");
    }
    return { state: "STAGED", stagedAt: ack.occurred_at, closedAt: null };
  }
  if (["FAILED", "REJECTED", "EXPIRED"].includes(ack.status)) {
    return { state: "CANCELLED", stagedAt: null, closedAt: ack.occurred_at };
  }
  return null;
}

/**
 * Project a newly accepted ACK using the exact transaction supplied by
 * command-ack.js. Duplicate ACKs short-circuit before reaching this module.
 */
export async function projectTinderVisibleChatSyncCommandAck(client, { command, ack } = {}) {
  if (command?.command_type !== TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE) return null;
  const transition = terminalTransition(ack);
  if (!transition) return null;

  const found = await client.query(
    `SELECT command_id, device_id, permit_state
       FROM ${TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE}
      WHERE command_id=$1
      FOR UPDATE`,
    [command.command_id]
  );
  const permit = found.rows[0] || null;
  if (!permit || permit.device_id !== command.device_id) {
    throw mismatch("TINDER_VISIBLE_CHAT_SYNC_PERMIT_NOT_FOUND", "Visible-chat sync permit is not available for this command");
  }
  if (permit.permit_state !== "ISSUED") {
    throw mismatch("TINDER_VISIBLE_CHAT_SYNC_PERMIT_TRANSITION_INVALID", "Visible-chat sync permit transition is invalid");
  }

  const updated = await client.query(
    `UPDATE ${TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE}
        SET permit_state=$2, staged_at=$3, closed_at=$4, updated_at=NOW()
      WHERE command_id=$1
        AND permit_state='ISSUED'
      RETURNING command_id`,
    [command.command_id, transition.state, transition.stagedAt, transition.closedAt]
  );
  if (updated.rows.length !== 1 || updated.rows[0]?.command_id !== command.command_id) {
    throw new DeviceBridgeProtocolError(500, "TINDER_VISIBLE_CHAT_SYNC_PERMIT_UPDATE_FAILED", "Visible-chat sync permit could not be updated");
  }
  return Object.freeze({ state: transition.state });
}
