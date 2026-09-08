import crypto from "node:crypto";
import { deriveDeviceStatus } from "../device-bridge/heartbeat.js";
import {
  isTinderOfficialAppResumeCapable
} from "../device-bridge/protocol-v1.js";

/* ==================================================
TINDER OFFICIAL-APP RESUME \u2014 DURABLE ONE-SHOT PERMIT

This narrow authority queues one exact empty command for a dashboard-selected,
already confirmed server-side source capture.  It neither identifies nor
selects a Tinder conversation and it contains no Android-provided target.
The separate permit is durable so a later ACK projector can audit exactly one
terminal launcher-dispatch outcome for this command without overloading the
visible-chat sync authority.
================================================== */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE = "RESUME_OFFICIAL_TINDER_APP";
export const TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE = "tinder_official_app_resume_permits";
export const TINDER_OFFICIAL_APP_RESUME_PERMIT_TTL_MS = 2 * 60_000;
export const TINDER_OFFICIAL_APP_RESUME_ACK_RESULT = Object.freeze({
  official_tinder_app_resume: "INTENT_DISPATCHED"
});

export const TINDER_OFFICIAL_APP_RESUME_STATUS = Object.freeze({
  QUEUED: "QUEUED",
  DEVICE_NOT_READY: "DEVICE_NOT_READY",
  PERMIT_CONFLICT: "PERMIT_CONFLICT",
  PERMIT_NOT_AVAILABLE: "PERMIT_NOT_AVAILABLE"
});

export const TINDER_OFFICIAL_APP_RESUME_REASON = Object.freeze({
  DEVICE_OFFLINE: "DEVICE_OFFLINE",
  DEVICE_ENROLLMENT_INACTIVE: "DEVICE_ENROLLMENT_INACTIVE",
  BRIDGE_NOT_RUNNING: "BRIDGE_NOT_RUNNING",
  TINDER_NOT_CONNECTED: "TINDER_NOT_CONNECTED",
  AUTOMATION_NOT_STOPPED: "AUTOMATION_NOT_STOPPED",
  DEVICE_CAPABILITY_UNSUPPORTED: "DEVICE_CAPABILITY_UNSUPPORTED",
  HUMAN_ARMED_PERMIT_ACTIVE: "HUMAN_ARMED_PERMIT_ACTIVE",
  VISIBLE_CHAT_SYNC_PERMIT_ACTIVE: "VISIBLE_CHAT_SYNC_PERMIT_ACTIVE",
  RESUME_PERMIT_ACTIVE: "RESUME_PERMIT_ACTIVE",
  SOURCE_CAPTURE_NOT_CONFIRMED: "SOURCE_CAPTURE_NOT_CONFIRMED",
  SOURCE_CAPTURE_ALREADY_USED: "SOURCE_CAPTURE_ALREADY_USED"
});

export class TinderOfficialAppResumeError extends Error {
  constructor(message, code = "INVALID_TINDER_OFFICIAL_APP_RESUME", statusCode = 400) {
    super(message);
    this.name = "TinderOfficialAppResumeError";
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
  if (!normalized) throw new TinderOfficialAppResumeError(`${field} is invalid.`, code);
  return normalized;
}

function normalizeIssueInput(value) {
  if (!exactKeys(value, ["deviceId", "sourceCaptureId"])) {
    throw new TinderOfficialAppResumeError(
      "The official-app resume request has unsupported fields.",
      "INVALID_OFFICIAL_APP_RESUME_REQUEST"
    );
  }
  return Object.freeze({
    deviceId: normalizeUuid(value.deviceId, "Device identifier", "INVALID_DEVICE_ID"),
    // This remains a server-selected reference. It never enters the Android
    // command payload and Android cannot use it as a Tinder identity.
    sourceCaptureId: normalizeUuid(value.sourceCaptureId, "Source capture identifier", "INVALID_SOURCE_CAPTURE_ID")
  });
}

function runtimeGateResult(row) {
  const runtime = plainObject(row) ? row : null;
  if (!runtime || sourceValue(runtime, "online", "online") !== true) {
    return Object.freeze({
      status: TINDER_OFFICIAL_APP_RESUME_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.DEVICE_OFFLINE
    });
  }
  if (normalizedStatus(sourceValue(runtime, "enrollmentState", "enrollment_state")) !== "ACTIVE") {
    return Object.freeze({
      status: TINDER_OFFICIAL_APP_RESUME_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.DEVICE_ENROLLMENT_INACTIVE
    });
  }
  if (normalizedStatus(sourceValue(runtime, "bridgeServiceState", "bridge_service_state")) !== "RUNNING") {
    return Object.freeze({
      status: TINDER_OFFICIAL_APP_RESUME_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.BRIDGE_NOT_RUNNING
    });
  }
  if (normalizedStatus(sourceValue(runtime, "tinderState", "tinder_state")) !== "CONNECTED") {
    return Object.freeze({
      status: TINDER_OFFICIAL_APP_RESUME_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.TINDER_NOT_CONNECTED
    });
  }
  if (normalizedStatus(sourceValue(runtime, "automationState", "automation_state")) !== "STOPPED") {
    return Object.freeze({
      status: TINDER_OFFICIAL_APP_RESUME_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.AUTOMATION_NOT_STOPPED
    });
  }
  if (!isTinderOfficialAppResumeCapable(sourceValue(runtime, "capabilities", "capabilities"))) {
    return Object.freeze({
      status: TINDER_OFFICIAL_APP_RESUME_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.DEVICE_CAPABILITY_UNSUPPORTED
    });
  }
  return null;
}

function requireRepository(repository) {
  for (const method of [
    "withTransaction",
    "getDeviceRuntimeForUpdate",
    "expireOfficialAppResumePermits",
    "findActiveHumanArmedPermitForDevice",
    "findActiveVisibleChatSyncPermitForDevice",
    "findActiveOfficialAppResumePermitForDevice",
    "getConfirmedSourceCaptureForUpdate",
    "findOfficialAppResumePermitForSourceCapture",
    "queueOfficialAppResumeCommand",
    "createOfficialAppResumePermit"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
}

function strictBoolean(value, method) {
  if (value !== true && value !== false) {
    throw new TinderOfficialAppResumeError(
      `${method} returned an invalid result.`,
      "INVALID_OFFICIAL_APP_RESUME_REPOSITORY",
      500
    );
  }
  return value;
}

export function isExactOfficialAppResumeIntentDispatchedAcknowledgement(value) {
  return exactKeys(value, Object.keys(TINDER_OFFICIAL_APP_RESUME_ACK_RESULT))
    && value.official_tinder_app_resume === TINDER_OFFICIAL_APP_RESUME_ACK_RESULT.official_tinder_app_resume;
}

export function createTinderOfficialAppResumeService(repository, {
  createCommandId = () => crypto.randomUUID(),
  now = () => new Date(),
  resumePermitTtlMs = TINDER_OFFICIAL_APP_RESUME_PERMIT_TTL_MS
} = {}) {
  requireRepository(repository);
  if (!Number.isSafeInteger(resumePermitTtlMs)
      || resumePermitTtlMs < 30_000
      || resumePermitTtlMs > 15 * 60_000) {
    throw new TypeError("resumePermitTtlMs must be a safe bounded duration");
  }

  function newCommandId() {
    return normalizeUuid(createCommandId(), "Official-app resume command identifier", "INVALID_OFFICIAL_APP_RESUME_COMMAND_ID");
  }

  async function queueOfficialAppResume(input = {}) {
    const normalized = normalizeIssueInput(input);
    return repository.withTransaction(async transaction => {
      const currentTime = new Date(now());
      if (Number.isNaN(currentTime.valueOf())) {
        throw new TinderOfficialAppResumeError("Official-app resume time is invalid.", "INVALID_OFFICIAL_APP_RESUME_TIME", 500);
      }
      const runtimeResult = runtimeGateResult(
        await repository.getDeviceRuntimeForUpdate(transaction, normalized.deviceId)
      );
      if (runtimeResult) return runtimeResult;

      await repository.expireOfficialAppResumePermits(transaction, {
        deviceId: normalized.deviceId,
        expiredAt: currentTime.toISOString()
      });
      if (strictBoolean(await repository.findActiveHumanArmedPermitForDevice(transaction, {
        deviceId: normalized.deviceId,
        now: currentTime.toISOString()
      }), "findActiveHumanArmedPermitForDevice")) {
        return Object.freeze({
          status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_CONFLICT,
          reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.HUMAN_ARMED_PERMIT_ACTIVE
        });
      }
      if (strictBoolean(await repository.findActiveVisibleChatSyncPermitForDevice(transaction, {
        deviceId: normalized.deviceId,
        now: currentTime.toISOString()
      }), "findActiveVisibleChatSyncPermitForDevice")) {
        return Object.freeze({
          status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_CONFLICT,
          reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.VISIBLE_CHAT_SYNC_PERMIT_ACTIVE
        });
      }
      if (strictBoolean(await repository.findActiveOfficialAppResumePermitForDevice(transaction, {
        deviceId: normalized.deviceId,
        now: currentTime.toISOString()
      }), "findActiveOfficialAppResumePermitForDevice")) {
        return Object.freeze({
          status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_CONFLICT,
          reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.RESUME_PERMIT_ACTIVE
        });
      }

      if (strictBoolean(await repository.getConfirmedSourceCaptureForUpdate(transaction, {
        sourceCaptureId: normalized.sourceCaptureId,
        deviceId: normalized.deviceId
      }), "getConfirmedSourceCaptureForUpdate") !== true) {
        return Object.freeze({
          status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.SOURCE_CAPTURE_NOT_CONFIRMED
        });
      }
      // The source capture row is locked by the confirmation lookup above.
      // This durable one-shot check therefore serializes concurrent attempts
      // for the same server-side capture even if they originate from distinct
      // dashboard sessions or device rows. Terminal outcomes remain used.
      if (strictBoolean(await repository.findOfficialAppResumePermitForSourceCapture(transaction, {
        sourceCaptureId: normalized.sourceCaptureId
      }), "findOfficialAppResumePermitForSourceCapture")) {
        return Object.freeze({
          status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.SOURCE_CAPTURE_ALREADY_USED
        });
      }

      const commandId = newCommandId();
      const expiresAt = new Date(currentTime.valueOf() + resumePermitTtlMs).toISOString();
      const command = Object.freeze({
        commandId,
        deviceId: normalized.deviceId,
        commandType: TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE,
        payload: Object.freeze({}),
        expiresAt
      });
      if (!exactEmptyPayload(command.payload)) {
        throw new TinderOfficialAppResumeError("Official-app resume command is invalid.", "INVALID_OFFICIAL_APP_RESUME_COMMAND", 500);
      }
      await repository.queueOfficialAppResumeCommand(transaction, command);
      await repository.createOfficialAppResumePermit(transaction, Object.freeze({
        commandId,
        deviceId: normalized.deviceId,
        sourceCaptureId: normalized.sourceCaptureId,
        permitState: "ISSUED",
        expiresAt
      }));
      // The opaque command ID reaches only the signed Device-Bridge command
      // channel. Dashboard code receives bounded queue state only.
      return Object.freeze({ status: TINDER_OFFICIAL_APP_RESUME_STATUS.QUEUED });
    });
  }

  return Object.freeze({ queueOfficialAppResume });
}

/**
 * PostgreSQL adapter for the separately migrated durable resume-permit
 * foundation. It has no route or startup authority and never launches Tinder.
 */
export function createPgTinderOfficialAppResumeRepository(pool) {
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

    async expireOfficialAppResumePermits(client, { deviceId, expiredAt }) {
      await client.query(
        `UPDATE ${TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE}
            SET permit_state='EXPIRED', closed_at=$2, updated_at=NOW()
          WHERE device_id=$1
            AND permit_state='ISSUED'
            AND expires_at <= $2`,
        [deviceId, expiredAt]
      );
    },

    async findActiveOfficialAppResumePermitForDevice(client, { deviceId, now: currentTime }) {
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1
             FROM ${TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE}
            WHERE device_id=$1
              AND permit_state='ISSUED'
              AND expires_at>$2
         ) AS active`,
        [deviceId, currentTime]
      );
      return result.rows[0]?.active === true;
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
             FROM tinder_visible_chat_sync_permits
            WHERE device_id=$1
              AND permit_state IN ('ISSUED','STAGED')
              AND expires_at>$2
         ) AS active`,
        [deviceId, currentTime]
      );
      return result.rows[0]?.active === true;
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
            AND capture.capture_revision = (
              SELECT MAX(newer.capture_revision)
                FROM tinder_visible_chat_captures newer
               WHERE newer.device_id=capture.device_id
                 AND newer.runtime_thread_fingerprint=capture.runtime_thread_fingerprint
            )
          FOR UPDATE`,
        [sourceCaptureId, deviceId]
      );
      return result.rows.length === 1;
    },

    async findOfficialAppResumePermitForSourceCapture(client, { sourceCaptureId }) {
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1
             FROM ${TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE}
            WHERE source_capture_id=$1
         ) AS used`,
        [sourceCaptureId]
      );
      return result.rows[0]?.used === true;
    },

    async queueOfficialAppResumeCommand(client, input) {
      if (!exactEmptyPayload(input.payload)
          || input.commandType !== TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE) {
        throw new TypeError("Official-app resume command payload must be exact empty object");
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
        throw new TinderOfficialAppResumeError(
          "Official-app resume command could not be created.",
          "OFFICIAL_APP_RESUME_COMMAND_WRITE_FAILED",
          500
        );
      }
    },

    async createOfficialAppResumePermit(client, input) {
      const result = await client.query(
        `INSERT INTO ${TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE} (
           command_id, device_id, source_capture_id, permit_state,
           issued_at, expires_at, created_at, updated_at
         ) VALUES ($1,$2,$3,'ISSUED',NOW(),$4,NOW(),NOW())
         RETURNING command_id`,
        [input.commandId, input.deviceId, input.sourceCaptureId, input.expiresAt]
      );
      if (result.rows.length !== 1 || result.rows[0]?.command_id !== input.commandId) {
        throw new TinderOfficialAppResumeError(
          "Official-app resume permit could not be created.",
          "OFFICIAL_APP_RESUME_PERMIT_WRITE_FAILED",
          500
        );
      }
    },

    // Reserved for the later command-ACK projector. It is deliberately not
    // called while the dashboard queues a command.
    async getOfficialAppResumePermitForUpdate(client, commandId) {
      const result = await client.query(
        `SELECT permit.command_id, permit.device_id, permit.source_capture_id,
                permit.permit_state, permit.expires_at, command.command_type
           FROM ${TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE} permit
           JOIN device_bridge_commands command
             ON command.command_id=permit.command_id
          WHERE permit.command_id=$1
          FOR UPDATE OF permit, command`,
        [commandId]
      );
      return result.rows[0] || null;
    }
  });
}
