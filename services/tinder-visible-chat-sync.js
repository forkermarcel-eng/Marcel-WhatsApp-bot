import crypto from "node:crypto";
import { deriveDeviceStatus } from "../device-bridge/heartbeat.js";
import {
  isTinderVisibleChatSyncCapable
} from "../device-bridge/protocol-v1.js";

/* ==================================================
TINDER V4 VISIBLE-CHAT SYNC PERMIT

This is a narrow command-staging authority. It creates one opaque, empty
SYNC_TINDER_VISIBLE_CHAT command and its separate device-scoped permit in the
same transaction. The permit is linked only to an already human-confirmed
server-side source capture selected by the dashboard. A terminal device ACK
may move that permit only to STAGED. Android never supplies that target.
================================================== */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE = "SYNC_TINDER_VISIBLE_CHAT";
export const TINDER_VISIBLE_CHAT_SYNC_CAPABILITY = "TINDER_VISIBLE_CHAT_SYNC_V1";
export const TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE = "tinder_visible_chat_sync_permits";
export const TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE = "tinder_visible_chat_sync_transcripts";
export const TINDER_VISIBLE_CHAT_SYNC_PERMIT_TTL_MS = 10 * 60_000;
export const TINDER_VISIBLE_CHAT_SYNC_ACK_RESULT = Object.freeze({
  tinder_visible_chat_sync: "STAGED"
});

export const TINDER_VISIBLE_CHAT_SYNC_STATUS = Object.freeze({
  QUEUED: "QUEUED",
  STAGED: "STAGED",
  CONSUMED: "CONSUMED",
  DEVICE_NOT_READY: "DEVICE_NOT_READY",
  PERMIT_CONFLICT: "PERMIT_CONFLICT",
  PERMIT_NOT_AVAILABLE: "PERMIT_NOT_AVAILABLE"
});

export const TINDER_VISIBLE_CHAT_SYNC_REASON = Object.freeze({
  DEVICE_OFFLINE: "DEVICE_OFFLINE",
  DEVICE_ENROLLMENT_INACTIVE: "DEVICE_ENROLLMENT_INACTIVE",
  BRIDGE_NOT_RUNNING: "BRIDGE_NOT_RUNNING",
  TINDER_NOT_CONNECTED: "TINDER_NOT_CONNECTED",
  AUTOMATION_NOT_STOPPED: "AUTOMATION_NOT_STOPPED",
  DEVICE_CAPABILITY_UNSUPPORTED: "DEVICE_CAPABILITY_UNSUPPORTED",
  HUMAN_ARMED_PERMIT_ACTIVE: "HUMAN_ARMED_PERMIT_ACTIVE",
  OFFICIAL_APP_RESUME_PERMIT_ACTIVE: "OFFICIAL_APP_RESUME_PERMIT_ACTIVE",
  SYNC_PERMIT_ACTIVE: "SYNC_PERMIT_ACTIVE",
  PERMIT_NOT_FOUND: "PERMIT_NOT_FOUND",
  PERMIT_ALREADY_CONSUMED: "PERMIT_ALREADY_CONSUMED",
  PERMIT_NOT_STAGED: "PERMIT_NOT_STAGED",
  PERMIT_EXPIRED: "PERMIT_EXPIRED",
  PERMIT_ACK_NOT_STAGED: "PERMIT_ACK_NOT_STAGED",
  PERMIT_DEVICE_MISMATCH: "PERMIT_DEVICE_MISMATCH",
  SOURCE_CAPTURE_NOT_CONFIRMED: "SOURCE_CAPTURE_NOT_CONFIRMED"
});

export class TinderVisibleChatSyncError extends Error {
  constructor(message, code = "INVALID_TINDER_VISIBLE_CHAT_SYNC", statusCode = 400) {
    super(message);
    this.name = "TinderVisibleChatSyncError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  if (!normalized) throw new TinderVisibleChatSyncError(`${field} ist ungültig.`, code);
  return normalized;
}

function exactKeys(value, keys) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

function exactEmptyPayload(value) {
  return exactKeys(value, []);
}

function normalizeIssueInput(value) {
  if (!exactKeys(value, ["deviceId", "sourceCaptureId"])) {
    throw new TinderVisibleChatSyncError(
      "Die sichtbare Chat-Sync-Anfrage enthält nicht erlaubte Felder.",
      "INVALID_SYNC_REQUEST"
    );
  }
  return Object.freeze({
    deviceId: normalizeUuid(value.deviceId, "Die Device-ID", "INVALID_DEVICE_ID"),
    // This is a dashboard-selected server reference. It is never provided by
    // the Android sync payload and never crosses the Device-Bridge command.
    sourceCaptureId: normalizeUuid(value.sourceCaptureId, "Die Quellaufnahme", "INVALID_SOURCE_CAPTURE_ID")
  });
}

function normalizePermitInput(value) {
  if (!exactKeys(value, ["commandId", "deviceId"])) {
    throw new TinderVisibleChatSyncError(
      "Die sichtbare Chat-Sync-Freigabe ist ungültig.",
      "INVALID_SYNC_PERMIT_REQUEST"
    );
  }
  return Object.freeze({
    commandId: normalizeUuid(value.commandId, "Die Sync-Command-ID", "INVALID_SYNC_COMMAND_ID"),
    deviceId: normalizeUuid(value.deviceId, "Die Device-ID", "INVALID_DEVICE_ID")
  });
}

function normalizeConsumeInput(value) {
  if (!exactKeys(value, ["authorization"])) {
    throw new TinderVisibleChatSyncError(
      "Die sichtbare Chat-Sync-Verbrauchsanfrage ist ungültig.",
      "INVALID_SYNC_PERMIT_CONSUME_REQUEST"
    );
  }
  return value.authorization;
}

function runtimeGateResult(row) {
  const runtime = plainObject(row) ? row : null;
  if (!runtime || sourceValue(runtime, "online", "online") !== true) {
    return Object.freeze({
      status: TINDER_VISIBLE_CHAT_SYNC_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.DEVICE_OFFLINE
    });
  }
  if (normalizedStatus(sourceValue(runtime, "enrollmentState", "enrollment_state")) !== "ACTIVE") {
    return Object.freeze({
      status: TINDER_VISIBLE_CHAT_SYNC_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.DEVICE_ENROLLMENT_INACTIVE
    });
  }
  if (normalizedStatus(sourceValue(runtime, "bridgeServiceState", "bridge_service_state")) !== "RUNNING") {
    return Object.freeze({
      status: TINDER_VISIBLE_CHAT_SYNC_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.BRIDGE_NOT_RUNNING
    });
  }
  if (normalizedStatus(sourceValue(runtime, "tinderState", "tinder_state")) !== "CONNECTED") {
    return Object.freeze({
      status: TINDER_VISIBLE_CHAT_SYNC_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.TINDER_NOT_CONNECTED
    });
  }
  if (normalizedStatus(sourceValue(runtime, "automationState", "automation_state")) !== "STOPPED") {
    return Object.freeze({
      status: TINDER_VISIBLE_CHAT_SYNC_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.AUTOMATION_NOT_STOPPED
    });
  }
  if (!isTinderVisibleChatSyncCapable(sourceValue(runtime, "capabilities", "capabilities"))) {
    return Object.freeze({
      status: TINDER_VISIBLE_CHAT_SYNC_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.DEVICE_CAPABILITY_UNSUPPORTED
    });
  }
  return null;
}

function syncPermitFromRow(row) {
  const commandId = uuid(sourceValue(row, "commandId", "command_id"));
  const deviceId = uuid(sourceValue(row, "deviceId", "device_id"));
  const sourceCaptureId = uuid(sourceValue(row, "sourceCaptureId", "source_capture_id"));
  const expiresAt = new Date(sourceValue(row, "expiresAt", "expires_at"));
  if (!commandId || !deviceId || !sourceCaptureId || Number.isNaN(expiresAt.valueOf())) return null;
  const commandType = String(sourceValue(row, "commandType", "command_type") || "").trim();
  if (commandType && commandType !== TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE) return null;
  return Object.freeze({
    commandId,
    deviceId,
    sourceCaptureId,
    state: normalizedStatus(sourceValue(row, "permitState", "permit_state")),
    expiresAt,
    commandTerminalStatus: normalizedStatus(sourceValue(row, "commandTerminalStatus", "terminal_status")),
    acknowledgementStatus: normalizedStatus(sourceValue(row, "acknowledgementStatus", "ack_status")),
    acknowledgementResult: sourceValue(row, "acknowledgementResult", "ack_result")
  });
}

export function isExactVisibleChatSyncStagedAcknowledgement(value) {
  return exactKeys(value, Object.keys(TINDER_VISIBLE_CHAT_SYNC_ACK_RESULT))
    && value.tinder_visible_chat_sync === TINDER_VISIBLE_CHAT_SYNC_ACK_RESULT.tinder_visible_chat_sync;
}

function permitStateResult(permit, currentTime) {
  if (!permit) {
    return Object.freeze({
      status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.PERMIT_NOT_FOUND
    });
  }
  if (permit.state === "CONSUMED") {
    return Object.freeze({
      status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.PERMIT_ALREADY_CONSUMED
    });
  }
  if (permit.expiresAt.valueOf() <= currentTime.valueOf()) {
    return Object.freeze({
      status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.PERMIT_EXPIRED
    });
  }
  if (permit.state !== "STAGED") {
    return Object.freeze({
      status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.PERMIT_NOT_STAGED
    });
  }
  if (permit.commandTerminalStatus !== "SUCCEEDED"
      || permit.acknowledgementStatus !== "SUCCEEDED"
      || !isExactVisibleChatSyncStagedAcknowledgement(permit.acknowledgementResult)) {
    return Object.freeze({
      status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.PERMIT_ACK_NOT_STAGED
    });
  }
  return null;
}

function requireRepository(repository) {
  for (const method of [
    "withTransaction",
    "getDeviceRuntimeForUpdate",
    "expireVisibleChatSyncPermits",
    "findActiveHumanArmedPermitForDevice",
    "findActiveVisibleChatSyncPermitForDevice",
    "findActiveOfficialAppResumePermitForDevice",
    "getConfirmedSourceCaptureForUpdate",
    "queueVisibleChatSyncCommand",
    "createVisibleChatSyncPermit",
    "getVisibleChatSyncPermitForUpdate",
    "markVisibleChatSyncPermitConsumed"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
}

function strictBoolean(value, method) {
  if (value !== true && value !== false) {
    throw new TinderVisibleChatSyncError(`${method} hat einen ungültigen Status geliefert.`, "INVALID_SYNC_REPOSITORY", 500);
  }
  return value;
}

export function createTinderVisibleChatSyncService(repository, {
  createCommandId = () => crypto.randomUUID(),
  now = () => new Date(),
  syncPermitTtlMs = TINDER_VISIBLE_CHAT_SYNC_PERMIT_TTL_MS
} = {}) {
  requireRepository(repository);
  if (!Number.isSafeInteger(syncPermitTtlMs) || syncPermitTtlMs < 10_000 || syncPermitTtlMs > 15 * 60_000) {
    throw new TypeError("syncPermitTtlMs must be a safe bounded duration");
  }
  // An internal-only handle gives a later, separately approved capture seam a
  // way to prove that it observed this exact staged permit. It carries no
  // person, visible UI value, capture ID, or fingerprint.
  const stagedPermitHandles = new WeakSet();

  function newCommandId() {
    return normalizeUuid(createCommandId(), "Die Sync-Command-ID", "INVALID_SYNC_COMMAND_ID");
  }

  async function queueVisibleChatSync(input = {}) {
    const normalized = normalizeIssueInput(input);
    return repository.withTransaction(async transaction => {
      const currentTime = new Date(now());
      if (Number.isNaN(currentTime.valueOf())) {
        throw new TinderVisibleChatSyncError("Die Sync-Zeit ist ungültig.", "INVALID_SYNC_TIME", 500);
      }
      const runtimeResult = runtimeGateResult(
        await repository.getDeviceRuntimeForUpdate(transaction, normalized.deviceId)
      );
      if (runtimeResult) return runtimeResult;

      await repository.expireVisibleChatSyncPermits(transaction, {
        deviceId: normalized.deviceId,
        expiredAt: currentTime.toISOString()
      });
      if (strictBoolean(await repository.findActiveHumanArmedPermitForDevice(transaction, {
        deviceId: normalized.deviceId,
        now: currentTime.toISOString()
      }), "findActiveHumanArmedPermitForDevice")) {
        return Object.freeze({
          status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_CONFLICT,
          reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.HUMAN_ARMED_PERMIT_ACTIVE
        });
      }
      if (strictBoolean(await repository.findActiveVisibleChatSyncPermitForDevice(transaction, {
        deviceId: normalized.deviceId,
        now: currentTime.toISOString()
      }), "findActiveVisibleChatSyncPermitForDevice")) {
        return Object.freeze({
          status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_CONFLICT,
          reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.SYNC_PERMIT_ACTIVE
        });
      }
      if (strictBoolean(await repository.findActiveOfficialAppResumePermitForDevice(transaction, {
        deviceId: normalized.deviceId,
        now: currentTime.toISOString()
      }), "findActiveOfficialAppResumePermitForDevice")) {
        return Object.freeze({
          status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_CONFLICT,
          reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.OFFICIAL_APP_RESUME_PERMIT_ACTIVE
        });
      }

      if (strictBoolean(await repository.getConfirmedSourceCaptureForUpdate(transaction, {
        sourceCaptureId: normalized.sourceCaptureId,
        deviceId: normalized.deviceId
      }), "getConfirmedSourceCaptureForUpdate") !== true) {
        return Object.freeze({
          status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.SOURCE_CAPTURE_NOT_CONFIRMED
        });
      }

      const commandId = newCommandId();
      const expiresAt = new Date(currentTime.valueOf() + syncPermitTtlMs).toISOString();
      const command = Object.freeze({
        commandId,
        deviceId: normalized.deviceId,
        commandType: TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE,
        payload: Object.freeze({}),
        expiresAt
      });
      if (!exactEmptyPayload(command.payload)) {
        throw new TinderVisibleChatSyncError("Der sichtbare Chat-Sync-Command ist ungültig.", "INVALID_SYNC_COMMAND", 500);
      }
      await repository.queueVisibleChatSyncCommand(transaction, command);
      await repository.createVisibleChatSyncPermit(transaction, Object.freeze({
        commandId,
        deviceId: normalized.deviceId,
        sourceCaptureId: normalized.sourceCaptureId,
        permitState: "ISSUED",
        expiresAt
      }));
      // Deliberately do not disclose the opaque command/permit UUID from this
      // creation result. The authenticated device receives it only through
      // the signed command channel.
      return Object.freeze({ status: TINDER_VISIBLE_CHAT_SYNC_STATUS.QUEUED });
    });
  }

  /**
   * Read/lock seam for the separate bounded transcript ingress. It does not
   * expose the dashboard-selected source capture to Android.
   */
  async function authorizeStagedVisibleChatSyncPermit(transaction, input = {}) {
    const normalized = normalizePermitInput(input);
    const permit = syncPermitFromRow(
      await repository.getVisibleChatSyncPermitForUpdate(transaction, normalized.commandId)
    );
    const permitResult = permitStateResult(permit, new Date(now()));
    if (permitResult) return permitResult;
    if (permit.commandId !== normalized.commandId || permit.deviceId !== normalized.deviceId) {
      return Object.freeze({
        status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
        reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.PERMIT_DEVICE_MISMATCH
      });
    }
    const authorization = Object.freeze({
      commandId: permit.commandId,
      deviceId: permit.deviceId,
      sourceCaptureId: permit.sourceCaptureId
    });
    stagedPermitHandles.add(authorization);
    return Object.freeze({
      status: TINDER_VISIBLE_CHAT_SYNC_STATUS.STAGED,
      authorization
    });
  }

  /**
   * The bounded V4 ingress calls this only after it has inserted its separate
   * transcript in the same transaction. Its source capture comes exclusively
   * from the server-side permit, never Android UI data.
   */
  async function consumeAuthorizedStagedVisibleChatSyncPermit(transaction, input = {}) {
    const authorization = normalizeConsumeInput(input);
    if (!plainObject(authorization) || !stagedPermitHandles.has(authorization)) {
      throw new TinderVisibleChatSyncError(
        "Die sichtbare Chat-Sync-Autorisierung ist ungültig.",
        "INVALID_SYNC_PERMIT_AUTHORIZATION",
        500
      );
    }
    const consumed = await repository.markVisibleChatSyncPermitConsumed(transaction, {
      commandId: authorization.commandId,
      deviceId: authorization.deviceId,
      consumedAt: new Date(now()).toISOString()
    });
    if (consumed !== true) {
      return Object.freeze({
        status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
        reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.PERMIT_ALREADY_CONSUMED
      });
    }
    return Object.freeze({ status: TINDER_VISIBLE_CHAT_SYNC_STATUS.CONSUMED });
  }

  function isAuthorizedStagedVisibleChatSyncPermit(authorization) {
    return plainObject(authorization) && stagedPermitHandles.has(authorization);
  }

  return Object.freeze({
    queueVisibleChatSync,
    authorizeStagedVisibleChatSyncPermit,
    consumeAuthorizedStagedVisibleChatSyncPermit,
    isAuthorizedStagedVisibleChatSyncPermit
  });
}

/**
 * PostgreSQL adapter for the separately migrated V4 permit foundation. It is
 * not imported by startup and has no route, capture, Tinder, or UI authority.
 */
export function createPgTinderVisibleChatSyncRepository(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("pool.connect and pool.query must be functions");
  }

  return Object.freeze({
    async withTransaction(work) {
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
    },

    async getDeviceRuntimeForUpdate(client, deviceId) {
      const result = await client.query(
        `SELECT device_id, enrollment_state, revoked_at,
                last_accepted_heartbeat_at, bridge_service_state,
                tinder_state, automation_state, capabilities
           FROM device_bridge_devices
          WHERE device_id=$1
          FOR UPDATE`,
        [deviceId]
      );
      const row = result.rows[0] || null;
      if (!row || row.revoked_at) return null;
      return {
        ...row,
        online: deriveDeviceStatus(row.last_accepted_heartbeat_at) === "ONLINE"
      };
    },

    async expireVisibleChatSyncPermits(client, { deviceId, expiredAt }) {
      await client.query(
        `UPDATE ${TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE}
            SET permit_state='EXPIRED', closed_at=$2, updated_at=NOW()
          WHERE device_id=$1
            AND permit_state IN ('ISSUED','STAGED')
            AND expires_at <= $2`,
        [deviceId, expiredAt]
      );
    },

    async findActiveHumanArmedPermitForDevice(client, { deviceId, now: currentTime }) {
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1
             FROM contact_human_armed_conversation_binding_permits permit
             JOIN device_bridge_commands command
               ON command.command_id=permit.command_id
            WHERE permit.device_id=$1
              AND permit.permit_state='ISSUED'
              AND permit.expires_at>$2
              AND command.command_type='ARM_TINDER_CONVERSATION_BINDING'
         ) AS active`,
        [deviceId, currentTime]
      );
      return result.rows[0]?.active === true;
    },

    async findActiveVisibleChatSyncPermitForDevice(client, { deviceId, now: currentTime }) {
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1
             FROM ${TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE}
            WHERE device_id=$1
              AND permit_state IN ('ISSUED','STAGED')
              AND expires_at>$2
         ) AS active`,
        [deviceId, currentTime]
      );
      return result.rows[0]?.active === true;
    },

    async findActiveOfficialAppResumePermitForDevice(client, { deviceId, now: currentTime }) {
      const relation = await client.query(
        "SELECT to_regclass('tinder_official_app_resume_permits') AS relation_name"
      );
      if (!relation.rows[0]?.relation_name) return false;
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1
             FROM tinder_official_app_resume_permits
            WHERE device_id=$1
              AND permit_state='ISSUED'
              AND expires_at>$2
         ) AS active`,
        [deviceId, currentTime]
      );
      return result.rows[0]?.active === true;
    },

    async queueVisibleChatSyncCommand(client, input) {
      if (!exactEmptyPayload(input.payload)
          || input.commandType !== TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE) {
        throw new TypeError("Visible-chat sync command payload must be exact empty object");
      }
      const result = await client.query(
        `INSERT INTO device_bridge_commands
          (command_id, device_id, protocol_version, command_type, payload,
           configuration_revision, issued_at, expires_at)
         SELECT $1, d.device_id, 1, $3, '{}'::jsonb,
                d.configuration_revision, NOW(), $4
           FROM device_bridge_devices d
          WHERE d.device_id=$2
         RETURNING command_id`,
        [input.commandId, input.deviceId, input.commandType, input.expiresAt]
      );
      if (result.rows.length !== 1 || result.rows[0]?.command_id !== input.commandId) {
        throw new TinderVisibleChatSyncError("Der sichtbare Chat-Sync-Command konnte nicht angelegt werden.", "SYNC_COMMAND_WRITE_FAILED", 500);
      }
    },

    async createVisibleChatSyncPermit(client, input) {
      const result = await client.query(
        `INSERT INTO ${TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE} (
           command_id, device_id, source_capture_id, permit_state, issued_at, expires_at,
           created_at, updated_at
         ) VALUES ($1,$2,$3,'ISSUED',NOW(),$4,NOW(),NOW())
         RETURNING command_id`,
        [input.commandId, input.deviceId, input.sourceCaptureId, input.expiresAt]
      );
      if (result.rows.length !== 1 || result.rows[0]?.command_id !== input.commandId) {
        throw new TinderVisibleChatSyncError("Die sichtbare Chat-Sync-Freigabe konnte nicht angelegt werden.", "SYNC_PERMIT_WRITE_FAILED", 500);
      }
    },

    async getVisibleChatSyncPermitForUpdate(client, commandId) {
      const result = await client.query(
        `SELECT permit.command_id, permit.device_id, permit.source_capture_id, permit.permit_state,
                permit.expires_at, command.command_type, command.terminal_status,
                acknowledgement.status AS ack_status,
                acknowledgement.result AS ack_result
           FROM ${TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE} permit
           JOIN device_bridge_commands command
             ON command.command_id=permit.command_id
      LEFT JOIN device_bridge_command_acks acknowledgement
             ON acknowledgement.command_id=permit.command_id
            AND acknowledgement.status='SUCCEEDED'
          WHERE permit.command_id=$1
          FOR UPDATE OF permit, command`,
        [commandId]
      );
      return result.rows[0] || null;
    },

    async getConfirmedSourceCaptureForUpdate(client, { sourceCaptureId, deviceId }) {
      const result = await client.query(
        `SELECT capture_id
           FROM tinder_visible_chat_captures capture
          WHERE capture.capture_id=$1
            AND capture.device_id=$2
            AND capture.source_package='com.tinder'
            AND capture.capture_safety_status='SAFE'
            AND capture.mapping_status='RESOLVED'
            AND capture.human_review_status='CONFIRMED'
            AND capture.resolved_contact_id IS NOT NULL
            -- Never stage a bounded visible-chat traversal from a stale
            -- confirmed revision. A newer capture for this same technical
            -- device/thread must be reviewed before it can become a source.
            AND capture.capture_revision = (
              SELECT MAX(newer.capture_revision)
                FROM tinder_visible_chat_captures newer
               WHERE newer.device_id = capture.device_id
                 AND newer.runtime_thread_fingerprint = capture.runtime_thread_fingerprint
            )
          FOR UPDATE`,
        [sourceCaptureId, deviceId]
      );
      return result.rows.length === 1;
    },

    async markVisibleChatSyncPermitConsumed(client, { commandId, deviceId, consumedAt }) {
      const result = await client.query(
        `UPDATE ${TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE}
            SET permit_state='CONSUMED', consumed_at=$3, updated_at=NOW()
          WHERE command_id=$1
            AND device_id=$2
            AND permit_state='STAGED'
            AND expires_at>$3
         RETURNING command_id`,
        [commandId, deviceId, consumedAt]
      );
      return result.rows.length === 1;
    },

    /**
     * The caller supplies only the normalized, identity-free V4 wire shape.
     * In particular this query has no Android name, header, thread, contact,
     * capture fingerprint, or binding input. `transcriptFingerprint` is only
     * a bounded command-scoped integrity value; the server-side source capture
     * is taken from the locked staged permit.
     */
    async insertVisibleChatSyncTranscript(client, input) {
      const result = await client.query(
        `INSERT INTO ${TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE} (
           sync_id, command_id, source_capture_id, device_id,
           sync_schema_version, source_package, layout_schema_version,
           sync_started_at, sync_completed_at,
           initial_visible_node_count, final_visible_node_count,
           segment_count, overlap_count, transcript_fingerprint, visible_messages,
           sync_safety_status, received_at, created_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,NOW()
         ) RETURNING sync_id`,
        [
          input.syncId, input.commandId, input.sourceCaptureId, input.deviceId,
          input.schemaVersion, input.sourcePackage, input.layoutSchemaVersion,
          input.syncStartedAt, input.syncCompletedAt,
          input.initialVisibleNodeCount, input.finalVisibleNodeCount,
          input.segmentCount, input.overlapCount, input.transcriptFingerprint,
          JSON.stringify(input.messages.map(message => ({
            visible_order: message.visibleOrder,
            direction: message.direction,
            text: message.text
          }))),
          input.safetyStatus, input.receivedAt
        ]
      );
      if (result.rows.length !== 1) {
        throw new TinderVisibleChatSyncError(
          "Der sichtbare Chat-Sync konnte nicht gespeichert werden.",
          "SYNC_TRANSCRIPT_WRITE_FAILED",
          500
        );
      }
      return result.rows[0];
    }
  });
}
