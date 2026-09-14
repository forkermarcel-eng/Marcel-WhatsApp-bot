import crypto from "node:crypto";

/* ==================================================
RESUMED FOREGROUND CHAT -> INBOX RETURN -- V10

This authority is intentionally identity-free.  It is a one-shot, empty
payload navigation child of an exact terminal Resume V2 command.  It can only
return the currently foreground, locally structure-verified official chat to
Inbox.  It cannot read, select, capture, upload, map, draft, send, or carry
source/binding/revision/person data.
================================================== */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE =
  "RETURN_TINDER_RESUMED_FOREGROUND_CHAT_TO_INBOX";
export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE =
  "tinder_resumed_foreground_chat_return_permits";
export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_TABLE =
  "tinder_resumed_foreground_chat_return_audit";
export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_CONTRACT_VERSION = 1;
export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TTL_MS = 90_000;
export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_ACK_RESULT = Object.freeze({
  tinder_resumed_foreground_chat_return: "STAGED"
});
export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_RECEIPT_SCHEMA_VERSION =
  "tinder-resumed-foreground-chat-return-receipt-v1";
export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_RECEIPT_STATUS = "RETURNED";

export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_STATUS = Object.freeze({
  QUEUED: "QUEUED",
  PERMIT_CONFLICT: "PERMIT_CONFLICT",
  PERMIT_NOT_AVAILABLE: "PERMIT_NOT_AVAILABLE"
});

export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON = Object.freeze({
  HUMAN_ARMED_PERMIT_ACTIVE: "HUMAN_ARMED_PERMIT_ACTIVE",
  VISIBLE_CHAT_SYNC_PERMIT_ACTIVE: "VISIBLE_CHAT_SYNC_PERMIT_ACTIVE",
  RESUME_PERMIT_ACTIVE: "RESUME_PERMIT_ACTIVE",
  LOCAL_CONVERSATION_ATTESTATION_ACTIVE: "LOCAL_CONVERSATION_ATTESTATION_ACTIVE",
  UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE: "UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE",
  VERIFIED_CHAT_RETURN_PERMIT_ACTIVE: "VERIFIED_CHAT_RETURN_PERMIT_ACTIVE",
  RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_ACTIVE: "RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_ACTIVE",
  RESUME_NOT_DISPATCHED: "RESUME_NOT_DISPATCHED",
  RESUME_EXPIRED: "RESUME_EXPIRED",
  PERMIT_NOT_FOUND: "PERMIT_NOT_FOUND",
  PERMIT_NOT_STAGED: "PERMIT_NOT_STAGED",
  PERMIT_EXPIRED: "PERMIT_EXPIRED",
  PERMIT_DEVICE_MISMATCH: "PERMIT_DEVICE_MISMATCH",
  PERMIT_RESUME_MISMATCH: "PERMIT_RESUME_MISMATCH",
  RETURN_ALREADY_TERMINAL: "RETURN_ALREADY_TERMINAL"
});

export class TinderResumedForegroundChatReturnError extends Error {
  constructor(message, code = "INVALID_TINDER_RESUMED_FOREGROUND_CHAT_RETURN", statusCode = 400) {
    super(message);
    this.name = "TinderResumedForegroundChatReturnError";
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

function exactEmptyPayload(value) { return exactKeys(value, []); }

function normalizeUuid(value, field, code) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!UUID_V4.test(normalized)) {
    throw new TinderResumedForegroundChatReturnError(`${field} is invalid.`, code);
  }
  return normalized;
}

function sourceValue(source, camelCase, snakeCase) {
  return source?.[camelCase] ?? source?.[snakeCase];
}

function normalizedStatus(value) { return String(value || "").trim().toUpperCase(); }

function strictBoolean(value, method) {
  if (value !== true && value !== false) {
    throw new TinderResumedForegroundChatReturnError(
      `${method} returned an invalid result.`,
      "INVALID_TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REPOSITORY", 500
    );
  }
  return value;
}

function normalizeIssueInput(value) {
  if (!exactKeys(value, ["deviceId", "resumeCommandId"])) {
    throw new TinderResumedForegroundChatReturnError(
      "The resumed foreground chat return request has unsupported fields.",
      "INVALID_TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REQUEST"
    );
  }
  return Object.freeze({
    deviceId: normalizeUuid(value.deviceId, "Device identifier", "INVALID_DEVICE_ID"),
    resumeCommandId: normalizeUuid(value.resumeCommandId, "Official resume command identifier",
      "INVALID_TINDER_RESUMED_FOREGROUND_CHAT_RETURN_RESUME")
  });
}

function normalizeReceiptInput(value) {
  if (!exactKeys(value, ["commandId", "deviceId", "status"])
      || value.status !== TINDER_RESUMED_FOREGROUND_CHAT_RETURN_RECEIPT_STATUS) {
    throw new TinderResumedForegroundChatReturnError(
      "The resumed foreground chat return receipt is invalid.",
      "INVALID_TINDER_RESUMED_FOREGROUND_CHAT_RETURN_RECEIPT"
    );
  }
  return Object.freeze({
    commandId: normalizeUuid(value.commandId, "Return command identifier",
      "INVALID_TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_ID"),
    deviceId: normalizeUuid(value.deviceId, "Device identifier", "INVALID_DEVICE_ID"),
    status: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_RECEIPT_STATUS
  });
}

function normalizeResume(value, expected) {
  if (!plainObject(value)) return null;
  const commandId = normalizeUuid(sourceValue(value, "commandId", "command_id"),
    "Official resume command identifier", "INVALID_TINDER_RESUMED_FOREGROUND_CHAT_RETURN_RESUME");
  const expiresAt = new Date(sourceValue(value, "expiresAt", "expires_at"));
  if (commandId !== expected.resumeCommandId || Number.isNaN(expiresAt.valueOf())) {
    throw new TinderResumedForegroundChatReturnError(
      "The dispatched official resume is invalid.",
      "INVALID_TINDER_RESUMED_FOREGROUND_CHAT_RETURN_RESUME", 500
    );
  }
  return Object.freeze({ commandId, expiresAt });
}

function requireRepository(repository) {
  for (const method of [
    "withTransaction",
    "expireResumedForegroundChatReturnPermits",
    "findActiveHumanArmedPermitForDevice",
    "findActiveVisibleChatSyncPermitForDevice",
    "findActiveOfficialAppResumePermitForDevice",
    "findActiveLocalConversationAttestationPermitForDevice",
    "findActiveUnboundInboxConversationSweepForDevice",
    "findActiveVerifiedChatReturnPermitForDevice",
    "findActiveResumedForegroundChatReturnPermitForDevice",
    "getTerminalOfficialAppResumeForUpdate",
    "findResumedForegroundChatReturnForResumeForUpdate",
    "queueResumedForegroundChatReturnCommand",
    "createResumedForegroundChatReturnPermit",
    "appendResumedForegroundChatReturnAudit",
    "getResumedForegroundChatReturnPermitForUpdate",
    "revalidateResumedForegroundChatReturnPermitForUpdate",
    "markResumedForegroundChatReturnReturned"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
}

export function isExactResumedForegroundChatReturnStagedAcknowledgement(value) {
  return exactKeys(value, Object.keys(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_ACK_RESULT))
    && value.tinder_resumed_foreground_chat_return
      === TINDER_RESUMED_FOREGROUND_CHAT_RETURN_ACK_RESULT.tinder_resumed_foreground_chat_return;
}

export function createTinderResumedForegroundChatReturnService(repository, {
  createCommandId = () => crypto.randomUUID(),
  createAuditId = () => crypto.randomUUID(),
  now = () => new Date(),
  permitTtlMs = TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TTL_MS
} = {}) {
  requireRepository(repository);
  if (!Number.isSafeInteger(permitTtlMs) || permitTtlMs < 30_000 || permitTtlMs > 5 * 60_000) {
    throw new TypeError("resumed foreground chat return permit TTL must be a safe bounded duration");
  }
  const newCommandId = () => normalizeUuid(createCommandId(), "Return command identifier",
    "INVALID_TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_ID");
  const newAuditId = () => normalizeUuid(createAuditId(), "Return audit identifier",
    "INVALID_TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_ID");

  async function stageResumedForegroundChatReturnForDispatchedResume(transaction, input = {}) {
    const normalized = normalizeIssueInput(input);
    const currentTime = new Date(now());
    if (Number.isNaN(currentTime.valueOf())) {
      throw new TinderResumedForegroundChatReturnError("Return time is invalid.",
        "INVALID_TINDER_RESUMED_FOREGROUND_CHAT_RETURN_TIME", 500);
    }
    await repository.expireResumedForegroundChatReturnPermits(transaction, {
      deviceId: normalized.deviceId, expiredAt: currentTime.toISOString()
    });
    const resume = normalizeResume(
      await repository.getTerminalOfficialAppResumeForUpdate(transaction, {
        resumeCommandId: normalized.resumeCommandId,
        deviceId: normalized.deviceId,
        now: currentTime.toISOString()
      }),
      normalized
    );
    if (!resume) return Object.freeze({ status: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.RESUME_NOT_DISPATCHED });
    if (resume.expiresAt.valueOf() <= currentTime.valueOf()) {
      return Object.freeze({ status: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_STATUS.PERMIT_NOT_AVAILABLE,
        reasonCode: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.RESUME_EXPIRED });
    }
    if (await repository.findResumedForegroundChatReturnForResumeForUpdate(transaction, {
      resumeCommandId: resume.commandId
    })) {
      return Object.freeze({ status: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_STATUS.PERMIT_NOT_AVAILABLE,
        reasonCode: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.RESUME_NOT_DISPATCHED });
    }
    const conflicts = [
      ["findActiveHumanArmedPermitForDevice", TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.HUMAN_ARMED_PERMIT_ACTIVE],
      ["findActiveVisibleChatSyncPermitForDevice", TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.VISIBLE_CHAT_SYNC_PERMIT_ACTIVE],
      ["findActiveOfficialAppResumePermitForDevice", TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.RESUME_PERMIT_ACTIVE],
      ["findActiveLocalConversationAttestationPermitForDevice", TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.LOCAL_CONVERSATION_ATTESTATION_ACTIVE],
      ["findActiveUnboundInboxConversationSweepForDevice", TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE],
      ["findActiveVerifiedChatReturnPermitForDevice", TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.VERIFIED_CHAT_RETURN_PERMIT_ACTIVE],
      ["findActiveResumedForegroundChatReturnPermitForDevice", TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_ACTIVE]
    ];
    for (const [method, reasonCode] of conflicts) {
      if (strictBoolean(await repository[method](transaction, {
        deviceId: normalized.deviceId, now: currentTime.toISOString()
      }), method)) {
        return Object.freeze({ status: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_STATUS.PERMIT_CONFLICT, reasonCode });
      }
    }
    const expiryMillis = Math.min(currentTime.valueOf() + permitTtlMs, resume.expiresAt.valueOf());
    if (!Number.isFinite(expiryMillis) || expiryMillis <= currentTime.valueOf()) {
      return Object.freeze({ status: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_STATUS.PERMIT_NOT_AVAILABLE,
        reasonCode: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.RESUME_EXPIRED });
    }
    const commandId = newCommandId();
    const expiresAt = new Date(expiryMillis).toISOString();
    const command = Object.freeze({ commandId, deviceId: normalized.deviceId,
      commandType: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE,
      payload: Object.freeze({}), expiresAt });
    if (!exactEmptyPayload(command.payload)) {
      throw new TinderResumedForegroundChatReturnError("Return command is invalid.",
        "INVALID_TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND", 500);
    }
    await repository.queueResumedForegroundChatReturnCommand(transaction, command);
    await repository.createResumedForegroundChatReturnPermit(transaction, Object.freeze({
      commandId, deviceId: normalized.deviceId, resumeCommandId: resume.commandId,
      permitContractVersion: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_CONTRACT_VERSION,
      expiresAt
    }));
    await repository.appendResumedForegroundChatReturnAudit(transaction, Object.freeze({
      auditId: newAuditId(), commandId, deviceId: normalized.deviceId,
      action: "RETURN_ISSUED", reasonCode: null, actor: "SERVER", source: "RESUME_ACK", details: {}
    }));
    return Object.freeze({ status: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_STATUS.QUEUED });
  }

  async function acceptSignedReturnReceipt(input = {}) {
    const normalized = normalizeReceiptInput(input);
    return repository.withTransaction(async transaction => {
      const currentTime = new Date(now());
      const permit = await repository.getResumedForegroundChatReturnPermitForUpdate(
        transaction, normalized.commandId);
      if (!plainObject(permit)) {
        throw new TinderResumedForegroundChatReturnError("Return permit is unavailable.",
          TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.PERMIT_NOT_FOUND, 409);
      }
      const permitDeviceId = normalizeUuid(sourceValue(permit, "deviceId", "device_id"),
        "Permit device identifier", "INVALID_TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT");
      if (permitDeviceId !== normalized.deviceId) {
        throw new TinderResumedForegroundChatReturnError("Return device is invalid.",
          TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.PERMIT_DEVICE_MISMATCH, 409);
      }
      const state = normalizedStatus(sourceValue(permit, "permitState", "permit_state"));
      if (state !== "STAGED") {
        throw new TinderResumedForegroundChatReturnError("Return permit is not staged.",
          ["RETURNED", "CANCELLED", "EXPIRED"].includes(state)
            ? TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.RETURN_ALREADY_TERMINAL
            : TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.PERMIT_NOT_STAGED, 409);
      }
      const expiresAt = new Date(sourceValue(permit, "expiresAt", "expires_at"));
      if (Number.isNaN(expiresAt.valueOf()) || expiresAt.valueOf() <= currentTime.valueOf()) {
        throw new TinderResumedForegroundChatReturnError("Return permit is expired.",
          TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.PERMIT_EXPIRED, 409);
      }
      if (strictBoolean(await repository.revalidateResumedForegroundChatReturnPermitForUpdate(
        transaction, { commandId: normalized.commandId, deviceId: normalized.deviceId,
          now: currentTime.toISOString() }),
      "revalidateResumedForegroundChatReturnPermitForUpdate") !== true) {
        throw new TinderResumedForegroundChatReturnError("Return permit no longer matches its resume.",
          TINDER_RESUMED_FOREGROUND_CHAT_RETURN_REASON.PERMIT_RESUME_MISMATCH, 409);
      }
      await repository.markResumedForegroundChatReturnReturned(transaction, {
        commandId: normalized.commandId, returnedAt: currentTime.toISOString()
      });
      await repository.appendResumedForegroundChatReturnAudit(transaction, Object.freeze({
        auditId: newAuditId(), commandId: normalized.commandId, deviceId: normalized.deviceId,
        action: "RETURNED", reasonCode: null, actor: "DEVICE", source: "SIGNED_RECEIPT", details: {}
      }));
      return Object.freeze({ status: "ACCEPTED" });
    });
  }

  return Object.freeze({ stageResumedForegroundChatReturnForDispatchedResume, acceptSignedReturnReceipt });
}

/** PostgreSQL adapter for V10 only. Importing it has no DDL or runtime authority. */
export function createPgTinderResumedForegroundChatReturnRepository(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("pool.connect and pool.query must be functions");
  }
  const withTransaction = async work => {
    const client = await pool.connect();
    try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
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
    async expireResumedForegroundChatReturnPermits(client, { deviceId, expiredAt }) {
      const expired = await client.query(
        `UPDATE ${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE}
            SET permit_state='EXPIRED', terminal_reason='PERMIT_EXPIRED', closed_at=$2, updated_at=NOW()
          WHERE device_id=$1 AND permit_state IN ('ISSUED','STAGED') AND expires_at <= $2
          RETURNING command_id, device_id`, [deviceId, expiredAt]
      );
      for (const row of expired.rows || []) {
        await client.query(
          `INSERT INTO ${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_TABLE}
             (audit_id, command_id, device_id, action, reason_code, actor, source, details)
           VALUES ($1,$2,$3,'RETURN_EXPIRED','PERMIT_EXPIRED','SERVER','EXPIRY','{}'::jsonb)`,
          [crypto.randomUUID(), row.command_id, row.device_id]
        );
      }
      return (expired.rows || []).length;
    },
    async findActiveHumanArmedPermitForDevice(client, { deviceId, now: currentTime }) {
      const result = await client.query(`SELECT EXISTS (SELECT 1 FROM contact_human_armed_conversation_binding_permits
        WHERE device_id=$1 AND permit_state='ISSUED' AND expires_at>$2) AS active`, [deviceId, currentTime]);
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
      const result = await client.query(`SELECT EXISTS (SELECT 1 FROM tinder_unbound_inbox_conversation_sweeps
        WHERE device_id=$1 AND sweep_state='ACTIVE' AND expires_at>$2) AS active`, [deviceId, currentTime]);
      return result.rows[0]?.active === true;
    },
    async findActiveVerifiedChatReturnPermitForDevice(client, { deviceId, now: currentTime }) {
      return active(client, "tinder_verified_chat_return_permits", deviceId, currentTime, ["ISSUED", "STAGED"]);
    },
    async findActiveResumedForegroundChatReturnPermitForDevice(client, { deviceId, now: currentTime }) {
      return active(client, TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE, deviceId, currentTime, ["ISSUED", "STAGED"]);
    },
    async getTerminalOfficialAppResumeForUpdate(client, input) {
      const result = await client.query(
        `SELECT resume.command_id, resume.expires_at
           FROM tinder_official_app_resume_permits resume
           JOIN device_bridge_commands command ON command.command_id=resume.command_id
          WHERE resume.command_id=$1 AND resume.device_id=$2
            AND resume.permit_contract_version=2 AND resume.permit_state='DISPATCHED'
            AND command.device_id=resume.device_id AND command.command_type='RESUME_OFFICIAL_TINDER_APP'
            AND command.terminal_status='SUCCEEDED' AND command.payload='{}'::jsonb
          FOR UPDATE OF resume, command`, [input.resumeCommandId, input.deviceId]
      );
      return result.rows[0] || null;
    },
    async findResumedForegroundChatReturnForResumeForUpdate(client, { resumeCommandId }) {
      const result = await client.query(`SELECT command_id FROM ${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE}
        WHERE resume_command_id=$1 FOR UPDATE`, [resumeCommandId]);
      return result.rows[0] || null;
    },
    async queueResumedForegroundChatReturnCommand(client, input) {
      if (input.commandType !== TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE || !exactEmptyPayload(input.payload)) {
        throw new TypeError("Resumed foreground chat return command payload must be exact empty object");
      }
      const result = await client.query(
        `INSERT INTO device_bridge_commands
           (command_id, device_id, protocol_version, command_type, payload, configuration_revision, issued_at, expires_at)
         SELECT $1,d.device_id,1,$3,'{}'::jsonb,d.configuration_revision,NOW(),$4
           FROM device_bridge_devices d WHERE d.device_id=$2 RETURNING command_id`,
        [input.commandId, input.deviceId, input.commandType, input.expiresAt]
      );
      if (result.rows.length !== 1 || result.rows[0]?.command_id !== input.commandId) {
        throw new TinderResumedForegroundChatReturnError("Return command could not be created.",
          "TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_WRITE_FAILED", 500);
      }
    },
    async createResumedForegroundChatReturnPermit(client, input) {
      const result = await client.query(
        `INSERT INTO ${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE}
           (command_id, device_id, resume_command_id, permit_contract_version, permit_state, issued_at, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'ISSUED',NOW(),$5,NOW(),NOW()) RETURNING command_id`,
        [input.commandId, input.deviceId, input.resumeCommandId, input.permitContractVersion, input.expiresAt]
      );
      if (result.rows.length !== 1 || result.rows[0]?.command_id !== input.commandId) {
        throw new TinderResumedForegroundChatReturnError("Return permit could not be created.",
          "TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_WRITE_FAILED", 500);
      }
    },
    async appendResumedForegroundChatReturnAudit(client, input) {
      if (!exactEmptyPayload(input.details)) throw new TypeError("Return audit details must be empty");
      const result = await client.query(
        `INSERT INTO ${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_TABLE}
           (audit_id, command_id, device_id, action, reason_code, actor, source, details)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'{}'::jsonb) RETURNING audit_id`,
        [input.auditId, input.commandId, input.deviceId, input.action, input.reasonCode, input.actor, input.source]
      );
      if (result.rows.length !== 1 || result.rows[0]?.audit_id !== input.auditId) {
        throw new TinderResumedForegroundChatReturnError("Return audit could not be recorded.",
          "TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_WRITE_FAILED", 500);
      }
    },
    async getResumedForegroundChatReturnPermitForUpdate(client, commandId) {
      const result = await client.query(`SELECT command_id, device_id, resume_command_id, permit_state, expires_at
        FROM ${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE} WHERE command_id=$1 FOR UPDATE`, [commandId]);
      return result.rows[0] || null;
    },
    async revalidateResumedForegroundChatReturnPermitForUpdate(client, { commandId, deviceId, now: currentTime }) {
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM ${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE} permit
           JOIN device_bridge_commands command ON command.command_id=permit.command_id
           JOIN tinder_official_app_resume_permits resume ON resume.command_id=permit.resume_command_id
           JOIN device_bridge_commands resume_command ON resume_command.command_id=resume.command_id
          WHERE permit.command_id=$1 AND permit.device_id=$2 AND permit.permit_contract_version=1
            AND permit.permit_state='STAGED' AND permit.expires_at>$3
            AND command.device_id=permit.device_id AND command.command_type='${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE}'
            AND command.terminal_status='SUCCEEDED' AND command.payload='{}'::jsonb
            AND resume.device_id=permit.device_id AND resume.permit_contract_version=2
            AND resume.permit_state='DISPATCHED' AND resume.expires_at>$3
            AND resume_command.device_id=resume.device_id AND resume_command.command_type='RESUME_OFFICIAL_TINDER_APP'
            AND resume_command.terminal_status='SUCCEEDED' AND resume_command.payload='{}'::jsonb
         ) AS valid`, [commandId, deviceId, currentTime]
      );
      return result.rows[0]?.valid === true;
    },
    async markResumedForegroundChatReturnReturned(client, { commandId, returnedAt }) {
      const result = await client.query(
        `UPDATE ${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE}
            SET permit_state='RETURNED', returned_at=$2, closed_at=$2, updated_at=NOW()
          WHERE command_id=$1 AND permit_state='STAGED' RETURNING command_id`, [commandId, returnedAt]
      );
      if (result.rows.length !== 1 || result.rows[0]?.command_id !== commandId) {
        throw new TinderResumedForegroundChatReturnError("Return could not be completed.",
          "TINDER_RESUMED_FOREGROUND_CHAT_RETURN_UPDATE_FAILED", 500);
      }
    }
  });
}
