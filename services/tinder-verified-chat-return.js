import crypto from "node:crypto";
import {
  HUMAN_ARMED_CONVERSATION_BINDING_TABLE,
  HUMAN_ARMED_CONVERSATION_PERMIT_TABLE,
  HUMAN_ARMED_CONVERSATION_REFERENCE_KIND
} from "./tinder-human-armed-conversation-binding.js";

/* ==================================================
VERIFIED CHAT -> INBOX RETURN -- V9 SEPARATE PERMIT

This authority is deliberately distinct from the launcher-only Resume V2
permit and from V8 sweep children. It can authorize exactly one local,
structure-verified header-back return from an already foreground official
Tinder conversation to Inbox. It carries an exact empty payload, cannot read
or select a chat, and its signed returned receipt cannot start a reader.
================================================== */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE =
  "RETURN_TINDER_VERIFIED_CHAT_TO_INBOX";
export const TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE =
  "tinder_verified_chat_return_permits";
export const TINDER_VERIFIED_CHAT_RETURN_AUDIT_TABLE =
  "tinder_verified_chat_return_audit";
export const TINDER_VERIFIED_CHAT_RETURN_PERMIT_CONTRACT_VERSION = 1;
export const TINDER_VERIFIED_CHAT_RETURN_PERMIT_TTL_MS = 90_000;
export const TINDER_VERIFIED_CHAT_RETURN_ACK_RESULT = Object.freeze({
  tinder_verified_chat_return: "STAGED"
});
export const TINDER_VERIFIED_CHAT_RETURN_RECEIPT_SCHEMA_VERSION =
  "tinder-verified-chat-return-receipt-v1";
export const TINDER_VERIFIED_CHAT_RETURN_RECEIPT_STATUS = "RETURNED";

export const TINDER_VERIFIED_CHAT_RETURN_STATUS = Object.freeze({
  QUEUED: "QUEUED",
  DEVICE_NOT_READY: "DEVICE_NOT_READY",
  PERMIT_CONFLICT: "PERMIT_CONFLICT",
  PERMIT_NOT_AVAILABLE: "PERMIT_NOT_AVAILABLE"
});

export const TINDER_VERIFIED_CHAT_RETURN_REASON = Object.freeze({
  DEVICE_OFFLINE: "DEVICE_OFFLINE",
  DEVICE_ENROLLMENT_INACTIVE: "DEVICE_ENROLLMENT_INACTIVE",
  BRIDGE_NOT_RUNNING: "BRIDGE_NOT_RUNNING",
  TINDER_NOT_CONNECTED: "TINDER_NOT_CONNECTED",
  AUTOMATION_NOT_STOPPED: "AUTOMATION_NOT_STOPPED",
  DEVICE_CAPABILITY_UNSUPPORTED: "DEVICE_CAPABILITY_UNSUPPORTED",
  HUMAN_ARMED_PERMIT_ACTIVE: "HUMAN_ARMED_PERMIT_ACTIVE",
  VISIBLE_CHAT_SYNC_PERMIT_ACTIVE: "VISIBLE_CHAT_SYNC_PERMIT_ACTIVE",
  RESUME_PERMIT_ACTIVE: "RESUME_PERMIT_ACTIVE",
  LOCAL_CONVERSATION_ATTESTATION_ACTIVE: "LOCAL_CONVERSATION_ATTESTATION_ACTIVE",
  UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE: "UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE",
  VERIFIED_CHAT_RETURN_PERMIT_ACTIVE: "VERIFIED_CHAT_RETURN_PERMIT_ACTIVE",
  SOURCE_CAPTURE_NOT_CONFIRMED: "SOURCE_CAPTURE_NOT_CONFIRMED",
  RESUME_NOT_DISPATCHED: "RESUME_NOT_DISPATCHED",
  RESUME_EXPIRED: "RESUME_EXPIRED",
  PERMIT_NOT_FOUND: "PERMIT_NOT_FOUND",
  PERMIT_NOT_STAGED: "PERMIT_NOT_STAGED",
  PERMIT_EXPIRED: "PERMIT_EXPIRED",
  PERMIT_DEVICE_MISMATCH: "PERMIT_DEVICE_MISMATCH",
  PERMIT_BINDING_MISMATCH: "PERMIT_BINDING_MISMATCH",
  PERMIT_SOURCE_MISMATCH: "PERMIT_SOURCE_MISMATCH",
  PERMIT_RESUME_MISMATCH: "PERMIT_RESUME_MISMATCH",
  CURRENT_BINDING_INVALID: "CURRENT_BINDING_INVALID",
  RETURN_ACK_INVALID: "RETURN_ACK_INVALID",
  RETURN_ALREADY_TERMINAL: "RETURN_ALREADY_TERMINAL"
});

export class TinderVerifiedChatReturnError extends Error {
  constructor(message, code = "INVALID_TINDER_VERIFIED_CHAT_RETURN", statusCode = 400) {
    super(message);
    this.name = "TinderVerifiedChatReturnError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function exactEmptyPayload(value) {
  return exactKeys(value, []);
}

function sourceValue(source, camelCase, snakeCase) {
  return source?.[camelCase] ?? source?.[snakeCase];
}

function normalizedStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function uuid(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return UUID_V4.test(normalized) ? normalized : null;
}

function normalizeUuid(value, field, code) {
  const normalized = uuid(value);
  if (!normalized) throw new TinderVerifiedChatReturnError(`${field} is invalid.`, code);
  return normalized;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeDispatchedResumeIssueInput(value) {
  if (!exactKeys(value, ["deviceId", "resumeCommandId"])) {
    throw new TinderVerifiedChatReturnError(
      "The dispatched official resume return request has unsupported fields.",
      "INVALID_TINDER_VERIFIED_CHAT_RETURN_REQUEST"
    );
  }
  return Object.freeze({
    deviceId: normalizeUuid(value.deviceId, "Device identifier", "INVALID_DEVICE_ID"),
    resumeCommandId: normalizeUuid(
      value.resumeCommandId,
      "Official resume command identifier",
      "INVALID_TINDER_VERIFIED_CHAT_RETURN_RESUME"
    )
  });
}

function normalizeReceiptInput(value) {
  if (!exactKeys(value, ["commandId", "deviceId", "status"])
      || value.status !== TINDER_VERIFIED_CHAT_RETURN_RECEIPT_STATUS) {
    throw new TinderVerifiedChatReturnError(
      "The verified chat return receipt is invalid.",
      "INVALID_TINDER_VERIFIED_CHAT_RETURN_RECEIPT"
    );
  }
  return Object.freeze({
    commandId: normalizeUuid(value.commandId, "Return command identifier", "INVALID_TINDER_VERIFIED_CHAT_RETURN_COMMAND_ID"),
    deviceId: normalizeUuid(value.deviceId, "Device identifier", "INVALID_DEVICE_ID"),
    status: TINDER_VERIFIED_CHAT_RETURN_RECEIPT_STATUS
  });
}

function normalizeConfirmedSource(value, expected) {
  if (!plainObject(value)) return null;
  const sourceCaptureId = normalizeUuid(
    sourceValue(value, "sourceCaptureId", "source_capture_id"),
    "Confirmed source capture identifier",
    "INVALID_CONFIRMED_TINDER_RETURN_SOURCE"
  );
  const bindingId = normalizeUuid(
    sourceValue(value, "bindingId", "binding_id"),
    "Confirmed conversation binding identifier",
    "INVALID_CONFIRMED_TINDER_RETURN_BINDING"
  );
  const bindingRevision = positiveInteger(sourceValue(value, "bindingRevision", "binding_revision"));
  if (!bindingRevision || sourceCaptureId !== expected.sourceCaptureId) {
    throw new TinderVerifiedChatReturnError(
      "The confirmed Tinder return source is invalid.",
      "INVALID_CONFIRMED_TINDER_RETURN_SOURCE",
      500
    );
  }
  return Object.freeze({ sourceCaptureId, bindingId, bindingRevision });
}

function normalizeDispatchedResume(value, source) {
  if (!plainObject(value)) return null;
  const commandId = normalizeUuid(
    sourceValue(value, "commandId", "command_id"),
    "Dispatched official resume command identifier",
    "INVALID_TINDER_VERIFIED_CHAT_RETURN_RESUME"
  );
  const sourceCaptureId = normalizeUuid(
    sourceValue(value, "sourceCaptureId", "source_capture_id"),
    "Dispatched official resume source capture identifier",
    "INVALID_TINDER_VERIFIED_CHAT_RETURN_RESUME"
  );
  const bindingId = normalizeUuid(
    sourceValue(value, "bindingId", "binding_id"),
    "Dispatched official resume binding identifier",
    "INVALID_TINDER_VERIFIED_CHAT_RETURN_RESUME"
  );
  const bindingRevision = positiveInteger(sourceValue(value, "bindingRevision", "binding_revision"));
  const expiresAt = new Date(sourceValue(value, "expiresAt", "expires_at"));
  if (!bindingRevision || Number.isNaN(expiresAt.valueOf())
      || (source?.sourceCaptureId !== null && source?.sourceCaptureId !== undefined
        && sourceCaptureId !== source.sourceCaptureId)
      || (source?.bindingId !== null && source?.bindingId !== undefined
        && bindingId !== source.bindingId)
      || (source?.bindingRevision !== null && source?.bindingRevision !== undefined
        && bindingRevision !== source.bindingRevision)) {
    throw new TinderVerifiedChatReturnError(
      "The dispatched official resume is invalid.",
      "INVALID_TINDER_VERIFIED_CHAT_RETURN_RESUME",
      500
    );
  }
  return Object.freeze({ commandId, sourceCaptureId, bindingId, bindingRevision, expiresAt });
}

function strictBoolean(value, method) {
  if (value !== true && value !== false) {
    throw new TinderVerifiedChatReturnError(
      `${method} returned an invalid result.`,
      "INVALID_TINDER_VERIFIED_CHAT_RETURN_REPOSITORY",
      500
    );
  }
  return value;
}

function requireRepository(repository) {
  for (const method of [
    "withTransaction",
    "expireVerifiedChatReturnPermits",
    "findActiveHumanArmedPermitForDevice",
    "findActiveVisibleChatSyncPermitForDevice",
    "findActiveOfficialAppResumePermitForDevice",
    "findActiveLocalConversationAttestationPermitForDevice",
    "findActiveUnboundInboxConversationSweepForDevice",
    "findActiveVerifiedChatReturnPermitForDevice",
    "getDispatchedOfficialAppResumeForUpdate",
    "queueVerifiedChatReturnCommand",
    "createVerifiedChatReturnPermit",
    "appendVerifiedChatReturnAudit",
    "getVerifiedChatReturnPermitForUpdate",
    "revalidateVerifiedChatReturnPermitForUpdate",
    "markVerifiedChatReturnReturned"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
}

export function isExactVerifiedChatReturnStagedAcknowledgement(value) {
  return exactKeys(value, Object.keys(TINDER_VERIFIED_CHAT_RETURN_ACK_RESULT))
    && value.tinder_verified_chat_return === TINDER_VERIFIED_CHAT_RETURN_ACK_RESULT.tinder_verified_chat_return;
}

function terminalStatus(row, now) {
  if (!plainObject(row)) return "NOT_REQUESTED";
  const state = normalizedStatus(sourceValue(row, "permitState", "permit_state"));
  const expires = new Date(sourceValue(row, "expiresAt", "expires_at"));
  if (!Number.isNaN(expires.valueOf()) && state === "ISSUED" && expires.valueOf() <= now.valueOf()) return "EXPIRED";
  return ["ISSUED", "STAGED", "RETURNED", "CANCELLED", "EXPIRED"].includes(state) ? state : "NOT_REQUESTED";
}

export function createTinderVerifiedChatReturnService(repository, {
  createCommandId = () => crypto.randomUUID(),
  createAuditId = () => crypto.randomUUID(),
  now = () => new Date(),
  permitTtlMs = TINDER_VERIFIED_CHAT_RETURN_PERMIT_TTL_MS
} = {}) {
  requireRepository(repository);
  if (!Number.isSafeInteger(permitTtlMs) || permitTtlMs < 30_000 || permitTtlMs > 5 * 60_000) {
    throw new TypeError("verified chat return permit TTL must be a safe bounded duration");
  }
  const newCommandId = () => normalizeUuid(createCommandId(), "Return command identifier", "INVALID_TINDER_VERIFIED_CHAT_RETURN_COMMAND_ID");
  const newAuditId = () => normalizeUuid(createAuditId(), "Return audit identifier", "INVALID_TINDER_VERIFIED_CHAT_RETURN_AUDIT_ID");

  async function stageVerifiedChatReturnForDispatchedResume(transaction, input = {}) {
    const normalized = normalizeDispatchedResumeIssueInput(input);
    const currentTime = new Date(now());
    if (Number.isNaN(currentTime.valueOf())) {
      throw new TinderVerifiedChatReturnError("Verified chat return time is invalid.", "INVALID_TINDER_VERIFIED_CHAT_RETURN_TIME", 500);
    }
    await repository.expireVerifiedChatReturnPermits(transaction, {
      deviceId: normalized.deviceId, expiredAt: currentTime.toISOString()
    });
    const resume = normalizeDispatchedResume(
      await repository.getDispatchedOfficialAppResumeForUpdate(transaction, {
        resumeCommandId: normalized.resumeCommandId,
        deviceId: normalized.deviceId,
        now: currentTime.toISOString()
      }),
      { sourceCaptureId: null, bindingId: null, bindingRevision: null }
    );
    if (!resume) {
      return Object.freeze({ status: TINDER_VERIFIED_CHAT_RETURN_STATUS.PERMIT_NOT_AVAILABLE,
        reasonCode: TINDER_VERIFIED_CHAT_RETURN_REASON.RESUME_NOT_DISPATCHED });
    }
    // The repository joins the live confirmed binding, its consumed safe
    // source and the exact terminal V2 resume atomically. Do not infer a
    // source from a name, time, fingerprint, or Android observation.
    const source = Object.freeze({
      sourceCaptureId: resume.sourceCaptureId,
      bindingId: resume.bindingId,
      bindingRevision: resume.bindingRevision
    });
    if (resume.expiresAt.valueOf() <= currentTime.valueOf()) {
      return Object.freeze({ status: TINDER_VERIFIED_CHAT_RETURN_STATUS.PERMIT_NOT_AVAILABLE,
        reasonCode: TINDER_VERIFIED_CHAT_RETURN_REASON.RESUME_EXPIRED });
    }
    const conflicts = [
        ["findActiveHumanArmedPermitForDevice", TINDER_VERIFIED_CHAT_RETURN_REASON.HUMAN_ARMED_PERMIT_ACTIVE],
        ["findActiveVisibleChatSyncPermitForDevice", TINDER_VERIFIED_CHAT_RETURN_REASON.VISIBLE_CHAT_SYNC_PERMIT_ACTIVE],
        ["findActiveOfficialAppResumePermitForDevice", TINDER_VERIFIED_CHAT_RETURN_REASON.RESUME_PERMIT_ACTIVE],
        ["findActiveLocalConversationAttestationPermitForDevice", TINDER_VERIFIED_CHAT_RETURN_REASON.LOCAL_CONVERSATION_ATTESTATION_ACTIVE],
        ["findActiveUnboundInboxConversationSweepForDevice", TINDER_VERIFIED_CHAT_RETURN_REASON.UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE],
        ["findActiveVerifiedChatReturnPermitForDevice", TINDER_VERIFIED_CHAT_RETURN_REASON.VERIFIED_CHAT_RETURN_PERMIT_ACTIVE]
    ];
    for (const [method, reasonCode] of conflicts) {
      if (strictBoolean(await repository[method](transaction, {
        deviceId: normalized.deviceId, now: currentTime.toISOString()
      }), method)) {
        return Object.freeze({ status: TINDER_VERIFIED_CHAT_RETURN_STATUS.PERMIT_CONFLICT, reasonCode });
      }
    }
    // A child may never outlive the exact Resume V2 authority which caused
    // it.  The fixed V9 window is therefore capped at the locked parent
    // expiry rather than merely checking the parent once at issuance.
    const childExpiry = Math.min(
      currentTime.valueOf() + permitTtlMs,
      resume.expiresAt.valueOf()
    );
    if (!Number.isFinite(childExpiry) || childExpiry <= currentTime.valueOf()) {
      return Object.freeze({ status: TINDER_VERIFIED_CHAT_RETURN_STATUS.PERMIT_NOT_AVAILABLE,
        reasonCode: TINDER_VERIFIED_CHAT_RETURN_REASON.RESUME_EXPIRED });
    }
    const commandId = newCommandId();
    const expiresAt = new Date(childExpiry).toISOString();
    const command = Object.freeze({
      commandId, deviceId: normalized.deviceId,
      commandType: TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE,
      payload: Object.freeze({}), expiresAt
    });
    if (!exactEmptyPayload(command.payload)) {
      throw new TinderVerifiedChatReturnError("Verified chat return command is invalid.", "INVALID_TINDER_VERIFIED_CHAT_RETURN_COMMAND", 500);
    }
    await repository.queueVerifiedChatReturnCommand(transaction, command);
    await repository.createVerifiedChatReturnPermit(transaction, Object.freeze({
      commandId, deviceId: normalized.deviceId, sourceCaptureId: source.sourceCaptureId,
      resumeCommandId: resume.commandId, bindingId: source.bindingId,
      bindingRevision: source.bindingRevision,
      permitContractVersion: TINDER_VERIFIED_CHAT_RETURN_PERMIT_CONTRACT_VERSION,
      expiresAt
    }));
    await repository.appendVerifiedChatReturnAudit(transaction, Object.freeze({
      auditId: newAuditId(), commandId, deviceId: normalized.deviceId,
      bindingId: source.bindingId, bindingRevision: source.bindingRevision,
      action: "RETURN_ISSUED", reasonCode: null, actor: "SERVER", source: "RESUME_ACK", details: {}
    }));
    return Object.freeze({ status: TINDER_VERIFIED_CHAT_RETURN_STATUS.QUEUED });
  }

  async function acceptSignedReturnReceipt(input = {}) {
    const normalized = normalizeReceiptInput(input);
    return repository.withTransaction(async transaction => {
      const currentTime = new Date(now());
      const permit = await repository.getVerifiedChatReturnPermitForUpdate(transaction, normalized.commandId);
      if (!plainObject(permit)) {
        throw new TinderVerifiedChatReturnError("Verified chat return permit is unavailable.", TINDER_VERIFIED_CHAT_RETURN_REASON.PERMIT_NOT_FOUND, 409);
      }
      const permitDeviceId = normalizeUuid(sourceValue(permit, "deviceId", "device_id"), "Permit device identifier", "INVALID_TINDER_VERIFIED_CHAT_RETURN_PERMIT");
      if (permitDeviceId !== normalized.deviceId) {
        throw new TinderVerifiedChatReturnError("Verified chat return device is invalid.", TINDER_VERIFIED_CHAT_RETURN_REASON.PERMIT_DEVICE_MISMATCH, 409);
      }
      const state = normalizedStatus(sourceValue(permit, "permitState", "permit_state"));
      if (state !== "STAGED") {
        throw new TinderVerifiedChatReturnError("Verified chat return permit is not staged.",
          ["RETURNED", "CANCELLED", "EXPIRED"].includes(state)
            ? TINDER_VERIFIED_CHAT_RETURN_REASON.RETURN_ALREADY_TERMINAL
            : TINDER_VERIFIED_CHAT_RETURN_REASON.PERMIT_NOT_STAGED,
          409
        );
      }
      const expiresAt = new Date(sourceValue(permit, "expiresAt", "expires_at"));
      if (Number.isNaN(expiresAt.valueOf()) || expiresAt.valueOf() <= currentTime.valueOf()) {
        throw new TinderVerifiedChatReturnError("Verified chat return permit is expired.", TINDER_VERIFIED_CHAT_RETURN_REASON.PERMIT_EXPIRED, 409);
      }
      if (strictBoolean(await repository.revalidateVerifiedChatReturnPermitForUpdate(transaction, {
        commandId: normalized.commandId, deviceId: normalized.deviceId, now: currentTime.toISOString()
      }), "revalidateVerifiedChatReturnPermitForUpdate") !== true) {
        throw new TinderVerifiedChatReturnError("Verified chat return facts changed.", TINDER_VERIFIED_CHAT_RETURN_REASON.CURRENT_BINDING_INVALID, 409);
      }
      await repository.markVerifiedChatReturnReturned(transaction, {
        commandId: normalized.commandId, returnedAt: currentTime.toISOString()
      });
      await repository.appendVerifiedChatReturnAudit(transaction, Object.freeze({
        auditId: newAuditId(), commandId: normalized.commandId, deviceId: normalized.deviceId,
        bindingId: normalizeUuid(sourceValue(permit, "bindingId", "binding_id"), "Permit binding identifier", "INVALID_TINDER_VERIFIED_CHAT_RETURN_PERMIT"),
        bindingRevision: positiveInteger(sourceValue(permit, "bindingRevision", "binding_revision")),
        action: "RETURNED", reasonCode: null, actor: "DEVICE", source: "SIGNED_RECEIPT", details: {}
      }));
      return Object.freeze({ status: "ACCEPTED" });
    });
  }

  async function getBoundedReturnStatus({ sourceCaptureId } = {}) {
    const captureId = normalizeUuid(sourceCaptureId, "Source capture identifier", "INVALID_SOURCE_CAPTURE_ID");
    if (typeof repository.withReadOnlyTransaction !== "function"
        || typeof repository.findLatestVerifiedChatReturnForSourceReadOnly !== "function") {
      throw new TinderVerifiedChatReturnError("Verified chat return status is unavailable.", "RETURN_STATUS_UNAVAILABLE", 503);
    }
    return repository.withReadOnlyTransaction(async transaction => Object.freeze({
      status: terminalStatus(
        await repository.findLatestVerifiedChatReturnForSourceReadOnly(transaction, captureId),
        new Date(now())
      )
    }));
  }

  return Object.freeze({ stageVerifiedChatReturnForDispatchedResume, acceptSignedReturnReceipt, getBoundedReturnStatus });
}

/** PostgreSQL adapter for V9 only. Importing it has no DDL or runtime authority. */
export function createPgTinderVerifiedChatReturnRepository(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("pool.connect and pool.query must be functions");
  }
  const withTransaction = async work => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };
  const withReadOnlyTransaction = async work => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      const result = await work(client);
      await client.query("ROLLBACK");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  };
  const active = async (client, table, deviceId, currentTime, states) => {
    const result = await client.query(
      `SELECT EXISTS (SELECT 1 FROM ${table} WHERE device_id=$1 AND permit_state = ANY($2::text[]) AND expires_at>$3) AS active`,
      [deviceId, states, currentTime]
    );
    return result.rows[0]?.active === true;
  };
  return Object.freeze({
    withTransaction,
    withReadOnlyTransaction,
    async expireVerifiedChatReturnPermits(client, { deviceId, expiredAt }) {
      const expired = await client.query(
        `UPDATE ${TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE}
            SET permit_state='EXPIRED', terminal_reason='PERMIT_EXPIRED', closed_at=$2, updated_at=NOW()
          WHERE device_id=$1 AND permit_state IN ('ISSUED','STAGED') AND expires_at <= $2
          RETURNING command_id, device_id, binding_id, binding_revision`,
        [deviceId, expiredAt]
      );
      for (const row of expired.rows || []) {
        await client.query(
          `INSERT INTO ${TINDER_VERIFIED_CHAT_RETURN_AUDIT_TABLE}
            (audit_id, command_id, device_id, binding_id, binding_revision, action, reason_code, actor, source, details)
           VALUES ($1,$2,$3,$4,$5,'RETURN_EXPIRED','PERMIT_EXPIRED','SERVER','EXPIRY','{}'::jsonb)`,
          [crypto.randomUUID(), row.command_id, row.device_id, row.binding_id, row.binding_revision]
        );
      }
      // Callers inside an already locked heartbeat transaction need a
      // bounded signal that a previously live child became terminal.  The
      // rows and all scope remain durable-only; this number is used only to
      // avoid delivering an unrelated command in that same heartbeat.
      return (expired.rows || []).length;
    },
    async findActiveHumanArmedPermitForDevice(client, { deviceId, now: currentTime }) {
      const result = await client.query(
        `SELECT EXISTS (SELECT 1 FROM contact_human_armed_conversation_binding_permits
          WHERE device_id=$1 AND permit_state='ISSUED' AND expires_at>$2) AS active`, [deviceId, currentTime]
      );
      return result.rows[0]?.active === true;
    },
    async findActiveVisibleChatSyncPermitForDevice(client, { deviceId, now: currentTime }) {
      return active(client, "tinder_visible_chat_sync_permits", deviceId, currentTime, ["ISSUED", "STAGED"]);
    },
    async findActiveOfficialAppResumePermitForDevice(client, { deviceId, now: currentTime }) {
      return active(client, "tinder_official_app_resume_permits", deviceId, currentTime, ["ISSUED"]);
    },
    async findActiveLocalConversationAttestationPermitForDevice(client, { deviceId, now: currentTime }) {
      return active(client, "tinder_local_conversation_attestation_permits", deviceId, currentTime, ["ISSUED"]);
    },
    async findActiveUnboundInboxConversationSweepForDevice(client, { deviceId, now: currentTime }) {
      const result = await client.query(
        `SELECT EXISTS (SELECT 1 FROM tinder_unbound_inbox_conversation_sweeps
          WHERE device_id=$1 AND sweep_state='ACTIVE' AND expires_at>$2) AS active`, [deviceId, currentTime]
      );
      return result.rows[0]?.active === true;
    },
    async findActiveVerifiedChatReturnPermitForDevice(client, { deviceId, now: currentTime }) {
      return active(client, TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE, deviceId, currentTime, ["ISSUED", "STAGED"]);
    },
    async getDispatchedOfficialAppResumeForUpdate(client, input) {
      const result = await client.query(
        `SELECT resume.command_id, resume.source_capture_id, resume.binding_id, resume.binding_revision, resume.expires_at
           FROM tinder_official_app_resume_permits resume
           JOIN device_bridge_commands resume_command ON resume_command.command_id=resume.command_id
           JOIN ${HUMAN_ARMED_CONVERSATION_BINDING_TABLE} binding ON binding.binding_id=resume.binding_id
           JOIN ${HUMAN_ARMED_CONVERSATION_PERMIT_TABLE} binding_permit ON binding_permit.binding_id=binding.binding_id
           JOIN tinder_visible_chat_captures capture ON capture.capture_id=resume.source_capture_id
          WHERE resume.command_id=$1 AND resume.device_id=$2
            AND resume.permit_contract_version=2 AND resume.permit_state='DISPATCHED' AND resume.expires_at>$3
            AND resume_command.device_id=resume.device_id AND resume_command.command_type='RESUME_OFFICIAL_TINDER_APP'
            AND resume_command.terminal_status='SUCCEEDED' AND resume_command.payload='{}'::jsonb
            AND binding.device_id=resume.device_id AND binding.binding_revision=resume.binding_revision
            AND binding.channel='tinder' AND binding.reference_kind=$4
            AND binding.binding_state='CONFIRMED' AND binding.human_verified=TRUE
            AND binding_permit.device_id=binding.device_id AND binding_permit.binding_revision=binding.binding_revision
            AND binding_permit.permit_state='CONSUMED' AND binding_permit.consumed_capture_id=resume.source_capture_id
            AND capture.device_id=binding.device_id AND capture.source_package='com.tinder'
            AND capture.capture_safety_status='SAFE' AND capture.mapping_status='RESOLVED'
            AND capture.human_review_status='CONFIRMED' AND capture.resolved_contact_id=binding.contact_id
            AND capture.capture_revision=(SELECT MAX(newer.capture_revision) FROM tinder_visible_chat_captures newer
              WHERE newer.device_id=capture.device_id AND newer.runtime_thread_fingerprint=capture.runtime_thread_fingerprint)
          FOR UPDATE OF resume, resume_command, binding, binding_permit, capture`,
        [input.resumeCommandId, input.deviceId, input.now, HUMAN_ARMED_CONVERSATION_REFERENCE_KIND]
      );
      return result.rows[0] || null;
    },
    async queueVerifiedChatReturnCommand(client, input) {
      if (input.commandType !== TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE || !exactEmptyPayload(input.payload)) {
        throw new TypeError("Verified chat return command payload must be exact empty object");
      }
      const result = await client.query(
        `INSERT INTO device_bridge_commands
          (command_id, device_id, protocol_version, command_type, payload, configuration_revision, issued_at, expires_at)
         SELECT $1, d.device_id, 1, $3, '{}'::jsonb, d.configuration_revision, NOW(), $4
           FROM device_bridge_devices d WHERE d.device_id=$2 RETURNING command_id`,
        [input.commandId, input.deviceId, input.commandType, input.expiresAt]
      );
      if (result.rows.length !== 1 || result.rows[0]?.command_id !== input.commandId) {
        throw new TinderVerifiedChatReturnError("Verified chat return command could not be created.", "TINDER_VERIFIED_CHAT_RETURN_COMMAND_WRITE_FAILED", 500);
      }
    },
    async createVerifiedChatReturnPermit(client, input) {
      const result = await client.query(
        `INSERT INTO ${TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE}
          (command_id, device_id, source_capture_id, resume_command_id, binding_id, binding_revision,
           permit_contract_version, permit_state, issued_at, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'ISSUED',NOW(),$8,NOW(),NOW()) RETURNING command_id`,
        [input.commandId, input.deviceId, input.sourceCaptureId, input.resumeCommandId,
          input.bindingId, input.bindingRevision, input.permitContractVersion, input.expiresAt]
      );
      if (result.rows.length !== 1 || result.rows[0]?.command_id !== input.commandId) {
        throw new TinderVerifiedChatReturnError("Verified chat return permit could not be created.", "TINDER_VERIFIED_CHAT_RETURN_PERMIT_WRITE_FAILED", 500);
      }
    },
    async appendVerifiedChatReturnAudit(client, input) {
      if (!exactEmptyPayload(input.details)) throw new TypeError("Verified chat return audit details must be empty");
      const result = await client.query(
        `INSERT INTO ${TINDER_VERIFIED_CHAT_RETURN_AUDIT_TABLE}
          (audit_id, command_id, device_id, binding_id, binding_revision, action, reason_code, actor, source, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'{}'::jsonb) RETURNING audit_id`,
        [input.auditId, input.commandId, input.deviceId, input.bindingId, input.bindingRevision,
          input.action, input.reasonCode, input.actor, input.source]
      );
      if (result.rows.length !== 1 || result.rows[0]?.audit_id !== input.auditId) {
        throw new TinderVerifiedChatReturnError("Verified chat return audit could not be recorded.", "TINDER_VERIFIED_CHAT_RETURN_AUDIT_WRITE_FAILED", 500);
      }
    },
    async getVerifiedChatReturnPermitForUpdate(client, commandId) {
      const result = await client.query(
        `SELECT command_id, device_id, source_capture_id, resume_command_id, binding_id, binding_revision,
                permit_state, expires_at
           FROM ${TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE} WHERE command_id=$1 FOR UPDATE`, [commandId]
      );
      return result.rows[0] || null;
    },
    async revalidateVerifiedChatReturnPermitForUpdate(client, { commandId, deviceId, now: currentTime }) {
      const result = await client.query(
        `SELECT EXISTS (
          SELECT 1 FROM ${TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE} permit
          JOIN device_bridge_commands command ON command.command_id=permit.command_id
          JOIN tinder_official_app_resume_permits resume ON resume.command_id=permit.resume_command_id
          JOIN device_bridge_commands resume_command ON resume_command.command_id=resume.command_id
          JOIN ${HUMAN_ARMED_CONVERSATION_BINDING_TABLE} binding ON binding.binding_id=permit.binding_id
          JOIN ${HUMAN_ARMED_CONVERSATION_PERMIT_TABLE} binding_permit ON binding_permit.binding_id=binding.binding_id
          JOIN tinder_visible_chat_captures capture ON capture.capture_id=permit.source_capture_id
          WHERE permit.command_id=$1 AND permit.device_id=$2 AND permit.permit_contract_version=1
            AND permit.permit_state='STAGED' AND permit.expires_at>$3
            AND command.device_id=permit.device_id AND command.command_type='${TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE}'
            AND command.terminal_status='SUCCEEDED' AND command.payload='{}'::jsonb
            AND resume.device_id=permit.device_id AND resume.source_capture_id=permit.source_capture_id
            AND resume.binding_id=permit.binding_id AND resume.binding_revision=permit.binding_revision
            AND resume.permit_contract_version=2 AND resume.permit_state='DISPATCHED' AND resume.expires_at>$3
            AND resume_command.device_id=resume.device_id AND resume_command.command_type='RESUME_OFFICIAL_TINDER_APP'
            AND resume_command.terminal_status='SUCCEEDED' AND resume_command.payload='{}'::jsonb
            AND binding.device_id=permit.device_id AND binding.binding_revision=permit.binding_revision
            AND binding.channel='tinder' AND binding.reference_kind='${HUMAN_ARMED_CONVERSATION_REFERENCE_KIND}'
            AND binding.binding_state='CONFIRMED' AND binding.human_verified=TRUE
            AND binding_permit.device_id=binding.device_id AND binding_permit.binding_revision=binding.binding_revision
            AND binding_permit.permit_state='CONSUMED' AND binding_permit.consumed_capture_id=permit.source_capture_id
            AND capture.device_id=binding.device_id AND capture.source_package='com.tinder'
            AND capture.capture_safety_status='SAFE' AND capture.mapping_status='RESOLVED'
            AND capture.human_review_status='CONFIRMED' AND capture.resolved_contact_id=binding.contact_id
            AND capture.capture_revision=(SELECT MAX(newer.capture_revision) FROM tinder_visible_chat_captures newer
              WHERE newer.device_id=capture.device_id AND newer.runtime_thread_fingerprint=capture.runtime_thread_fingerprint)
        ) AS valid`, [commandId, deviceId, currentTime]
      );
      return result.rows[0]?.valid === true;
    },
    async markVerifiedChatReturnReturned(client, { commandId, returnedAt }) {
      const result = await client.query(
        `UPDATE ${TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE}
            SET permit_state='RETURNED', returned_at=$2, closed_at=$2, updated_at=NOW()
          WHERE command_id=$1 AND permit_state='STAGED' RETURNING command_id`, [commandId, returnedAt]
      );
      if (result.rows.length !== 1 || result.rows[0]?.command_id !== commandId) {
        throw new TinderVerifiedChatReturnError("Verified chat return could not be completed.", "TINDER_VERIFIED_CHAT_RETURN_UPDATE_FAILED", 500);
      }
    },
    async findLatestVerifiedChatReturnForSourceReadOnly(client, sourceCaptureId) {
      const result = await client.query(
        `SELECT permit_state, expires_at FROM ${TINDER_VERIFIED_CHAT_RETURN_PERMIT_TABLE}
          WHERE source_capture_id=$1 ORDER BY created_at DESC, command_id DESC LIMIT 1`, [sourceCaptureId]
      );
      return result.rows[0] || null;
    }
  });
}
