import crypto from "node:crypto";
import { DeviceBridgeProtocolError } from "./protocol-v1.js";
import {
  isExactLocalConversationAttestationStagedAcknowledgement,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE
} from "../services/tinder-local-conversation-attestation.js";

/* ==================================================
LOCAL CONVERSATION ATTESTATION — ACK PROJECTION

The generic command ACK may only stage the opaque bootstrap permit.  It never
attests a Tinder screen.  Only the separate signed local-attestation ingress,
after Android has passed its local human-row and Conversation gates, may make
the record ATTESTED.
================================================== */

function mismatch(code, message) {
  return new DeviceBridgeProtocolError(409, code, message);
}

function terminalTransition(ack) {
  if (ack.status === "SUCCEEDED") {
    if (!isExactLocalConversationAttestationStagedAcknowledgement(ack.result)) {
      throw mismatch(
        "TINDER_LOCAL_CONVERSATION_ATTESTATION_ACK_INVALID",
        "Local conversation attestation acknowledgement is not staged"
      );
    }
    return Object.freeze({ state: "STAGED", stagedAt: ack.occurred_at, closedAt: null, reasonCode: null });
  }
  if (["FAILED", "REJECTED", "EXPIRED"].includes(ack.status)) {
    if (ack.status === "EXPIRED") {
      return Object.freeze({
        state: "EXPIRED",
        stagedAt: null,
        closedAt: ack.occurred_at,
        reasonCode: "EXPIRED",
        auditAction: "EXPIRED"
      });
    }
    return Object.freeze({
      state: "CANCELLED",
      stagedAt: null,
      closedAt: ack.occurred_at,
      reasonCode: ack.status === "REJECTED" ? "COMMAND_REJECTED" : "RUNTIME_GATE_LOST",
      auditAction: "CANCELLED"
    });
  }
  return null;
}

/** Runs only inside the authenticated command-ACK transaction. */
export async function projectTinderLocalConversationAttestationCommandAck(client, { command, ack } = {}) {
  if (command?.command_type !== TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE) return null;
  const transition = terminalTransition(ack);
  if (!transition) return null;

  const found = await client.query(
    `SELECT command_id, binding_id, binding_revision, device_id, permit_state
       FROM ${TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE}
      WHERE command_id=$1
      FOR UPDATE`,
    [command.command_id]
  );
  const permit = found.rows[0] || null;
  if (!permit || permit.device_id !== command.device_id) {
    throw mismatch(
      "TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_NOT_FOUND",
      "Local conversation attestation permit is unavailable for this command"
    );
  }
  if (permit.permit_state !== "ISSUED") {
    throw mismatch(
      "TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TRANSITION_INVALID",
      "Local conversation attestation permit transition is invalid"
    );
  }

  const updated = await client.query(
    `UPDATE ${TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE}
        SET permit_state=$2, staged_at=$3, closed_at=$4,
            terminal_reason=$5, updated_at=NOW()
      WHERE command_id=$1 AND permit_state='ISSUED'
      RETURNING command_id`,
    [command.command_id, transition.state, transition.stagedAt, transition.closedAt, transition.reasonCode]
  );
  if (updated.rows.length !== 1 || updated.rows[0]?.command_id !== command.command_id) {
    throw new DeviceBridgeProtocolError(
      500,
      "TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_UPDATE_FAILED",
      "Local conversation attestation permit could not be updated"
    );
  }
  await client.query(
    `INSERT INTO ${TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE} (
       audit_id, command_id, binding_id, binding_revision, device_id, action, actor,
       source, reason_code, details
     ) VALUES ($1,$2,$3,$4,$5,$6,'ANDROID_RUNTIME','SIGNED_DEVICE_INGRESS',$7,'{}'::jsonb)`,
    [
      crypto.randomUUID(),
      permit.command_id,
      permit.binding_id,
      permit.binding_revision,
      permit.device_id,
      transition.state === "STAGED" ? "STAGED" : transition.auditAction,
      transition.reasonCode
    ]
  );
  return Object.freeze({ state: transition.state });
}
