import { DeviceBridgeProtocolError } from "./protocol-v1.js";
import {
  isExactOfficialAppResumeIntentDispatchedAcknowledgement,
  TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE,
  TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE
} from "../services/tinder-official-app-resume.js";

/* ==================================================
TINDER OFFICIAL APP RESUME — ACK PROJECTION

The command ACK is the sole state-transition authority for this durable
one-shot permit. A positive ACK proves only that Android dispatched the
standard launcher intent. It deliberately does not establish a Tinder
session, a visible chat, a capture, a contact, or a navigation outcome.
================================================== */

function mismatch(code, message) {
  return new DeviceBridgeProtocolError(409, code, message);
}

function terminalTransition(ack) {
  if (ack.status === "SUCCEEDED") {
    if (!isExactOfficialAppResumeIntentDispatchedAcknowledgement(ack.result)) {
      throw mismatch("TINDER_OFFICIAL_APP_RESUME_ACK_INVALID", "Official Tinder app resume acknowledgement is invalid");
    }
    return { state: "DISPATCHED", dispatchedAt: ack.occurred_at, closedAt: null };
  }
  if (["FAILED", "REJECTED", "EXPIRED"].includes(ack.status)) {
    return { state: "CANCELLED", dispatchedAt: null, closedAt: ack.occurred_at };
  }
  return null;
}

/**
 * Runs only inside the already authenticated command-ACK transaction.
 * Duplicate ACKs short-circuit in command-ack.js before reaching this
 * projector, so this cannot create a second launcher dispatch authority.
 */
export async function projectTinderOfficialAppResumeCommandAck(client, { command, ack } = {}) {
  if (command?.command_type !== TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE) return null;
  const transition = terminalTransition(ack);
  if (!transition) return null;

  const found = await client.query(
    `SELECT command_id, device_id, permit_state
       FROM ${TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE}
      WHERE command_id=$1
      FOR UPDATE`,
    [command.command_id]
  );
  const permit = found.rows[0] || null;
  if (!permit || permit.device_id !== command.device_id) {
    throw mismatch("TINDER_OFFICIAL_APP_RESUME_PERMIT_NOT_FOUND", "Official Tinder app resume permit is unavailable for this command");
  }
  if (permit.permit_state !== "ISSUED") {
    throw mismatch("TINDER_OFFICIAL_APP_RESUME_PERMIT_TRANSITION_INVALID", "Official Tinder app resume permit transition is invalid");
  }

  const updated = await client.query(
    `UPDATE ${TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE}
        SET permit_state=$2, dispatched_at=$3, closed_at=$4, updated_at=NOW()
      WHERE command_id=$1
        AND permit_state='ISSUED'
      RETURNING command_id`,
    [command.command_id, transition.state, transition.dispatchedAt, transition.closedAt]
  );
  if (updated.rows.length !== 1 || updated.rows[0]?.command_id !== command.command_id) {
    throw new DeviceBridgeProtocolError(500, "TINDER_OFFICIAL_APP_RESUME_PERMIT_UPDATE_FAILED", "Official Tinder app resume permit could not be updated");
  }
  return Object.freeze({ state: transition.state });
}
