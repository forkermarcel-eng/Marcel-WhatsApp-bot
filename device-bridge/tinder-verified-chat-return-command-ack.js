import crypto from "node:crypto";
import { DeviceBridgeProtocolError } from "./protocol-v1.js";
import {
  createPgTinderVerifiedChatReturnRepository,
  createTinderVerifiedChatReturnService,
  isExactVerifiedChatReturnStagedAcknowledgement,
  TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE,
  TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE
} from "../services/tinder-verified-chat-return.js";
import {
  isExactOfficialAppResumeIntentDispatchedAcknowledgement
} from "../services/tinder-official-app-resume.js";

/*
V9 has two deliberately separate projections:
1. A precise successful Resume ACK creates a brand-new return authority.
2. That authority's own command ACK can only reach STAGED or a bounded
   terminal cancellation.  It cannot reactivate a historical Resume permit.
*/

function inertPool() {
  return {
    async connect() {
      throw new Error("V9 ACK projection cannot open a nested transaction");
    },
    async query() {
      throw new Error("V9 ACK projection cannot query outside the ACK transaction");
    }
  };
}

function mismatch(code, message) {
  return new DeviceBridgeProtocolError(409, code, message);
}

function terminalCancellation(ack) {
  if (["FAILED", "REJECTED", "EXPIRED"].includes(ack?.status)) {
    return {
      reasonCode: ack.status === "FAILED" ? "COMMAND_FAILED"
        : ack.status === "REJECTED" ? "COMMAND_REJECTED" : "COMMAND_EXPIRED"
    };
  }
  return null;
}

export async function stageTinderVerifiedChatReturnAfterOfficialResumeAck(client, {
  command,
  ack,
  foundationReady = true
} = {}) {
  if (command?.command_type !== "RESUME_OFFICIAL_TINDER_APP"
      || ack?.status !== "SUCCEEDED"
      || !isExactOfficialAppResumeIntentDispatchedAcknowledgement(ack?.result)) {
    return null;
  }
  // Deploy-before-DDL remains safe: the Resume ACK is terminally durable,
  // while the additive V9 authority is simply not available yet.  Do not
  // rollback a real launcher dispatch merely because a later foundation is
  // absent or drifted.
  if (foundationReady !== true) return Object.freeze({ status: "FOUNDATION_NOT_READY" });
  const repository = createPgTinderVerifiedChatReturnRepository(inertPool());
  const service = createTinderVerifiedChatReturnService(repository);
  return service.stageVerifiedChatReturnForDispatchedResume(client, {
    deviceId: command.device_id,
    resumeCommandId: command.command_id
  });
}

export async function projectTinderVerifiedChatReturnCommandAck(client, { command, ack } = {}) {
  if (command?.command_type !== TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE) return null;
  const found = await client.query(
    `SELECT command_id, device_id, binding_id, binding_revision, permit_state
       FROM ${TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE}
      WHERE command_id=$1
      FOR UPDATE`,
    [command.command_id]
  );
  const permit = found.rows[0] || null;
  if (!permit || permit.device_id !== command.device_id) {
    throw mismatch("TINDER_VERIFIED_CHAT_RETURN_PERMIT_NOT_FOUND", "Verified chat return permit is unavailable for this command");
  }
  if (permit.permit_state !== "ISSUED") {
    throw mismatch("TINDER_VERIFIED_CHAT_RETURN_PERMIT_TRANSITION_INVALID", "Verified chat return permit transition is invalid");
  }

  if (ack.status === "SUCCEEDED") {
    if (!isExactVerifiedChatReturnStagedAcknowledgement(ack.result)) {
      throw mismatch("TINDER_VERIFIED_CHAT_RETURN_ACK_INVALID", "Verified chat return acknowledgement is invalid");
    }
    const updated = await client.query(
      `UPDATE ${TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE}
          SET permit_state='STAGED', staged_at=$2, updated_at=NOW()
        WHERE command_id=$1 AND permit_state='ISSUED'
      RETURNING command_id`,
      [command.command_id, ack.occurred_at]
    );
    if (updated.rows.length !== 1) {
      throw new DeviceBridgeProtocolError(500, "TINDER_VERIFIED_CHAT_RETURN_PERMIT_UPDATE_FAILED", "Verified chat return permit could not be updated");
    }
    await appendAudit(client, permit, command.command_id, "RETURN_STAGED", null, "DEVICE", "COMMAND_ACK");
    return Object.freeze({ state: "STAGED" });
  }

  const cancellation = terminalCancellation(ack);
  if (!cancellation) return null;
  const updated = await client.query(
    `UPDATE ${TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE}
        SET permit_state='CANCELLED', terminal_reason=$2, closed_at=$3, updated_at=NOW()
      WHERE command_id=$1 AND permit_state='ISSUED'
    RETURNING command_id`,
    [command.command_id, cancellation.reasonCode, ack.occurred_at]
  );
  if (updated.rows.length !== 1) {
    throw new DeviceBridgeProtocolError(500, "TINDER_VERIFIED_CHAT_RETURN_PERMIT_UPDATE_FAILED", "Verified chat return permit could not be updated");
  }
  await appendAudit(client, permit, command.command_id, "RETURN_CANCELLED", cancellation.reasonCode, "SERVER", "COMMAND_ACK");
  return Object.freeze({ state: "CANCELLED" });
}

async function appendAudit(client, permit, commandId, action, reasonCode, actor, source) {
  await client.query(
    `INSERT INTO tinder_verified_chat_return_audit
      (audit_id, command_id, device_id, binding_id, binding_revision, action, reason_code, actor, source, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb)`,
    [crypto.randomUUID(), commandId, permit.device_id, permit.binding_id, permit.binding_revision,
      action, reasonCode, actor, source]
  );
}
