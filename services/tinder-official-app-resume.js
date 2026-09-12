import crypto from "node:crypto";
import { deriveDeviceStatus } from "../device-bridge/heartbeat.js";
import {
  isTinderOfficialAppResumeCapable,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_VERSION
} from "../device-bridge/protocol-v1.js";
import {
  HUMAN_ARMED_CONVERSATION_BINDING_TABLE,
  HUMAN_ARMED_CONVERSATION_PERMIT_TABLE,
  HUMAN_ARMED_CONVERSATION_REFERENCE_KIND
} from "./tinder-human-armed-conversation-binding.js";

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
export const TINDER_OFFICIAL_APP_RESUME_PERMIT_CONTRACT_VERSION = 2;
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
  UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE: "UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE",
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

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * The dashboard still supplies only the opaque selected source capture.  The
 * repository derives this immutable snapshot from the current human-confirmed
 * binding under the same transaction and lock.  No display value, thread hash,
 * contact, or Android-provided value may enter this authority.
 */
function normalizeConfirmedHumanArmedSource(value, expected) {
  if (!plainObject(value)) return null;
  const sourceCaptureId = normalizeUuid(
    sourceValue(value, "sourceCaptureId", "source_capture_id"),
    "Confirmed source capture identifier",
    "INVALID_CONFIRMED_TINDER_RESUME_SOURCE"
  );
  const bindingId = normalizeUuid(
    sourceValue(value, "bindingId", "binding_id"),
    "Confirmed conversation binding identifier",
    "INVALID_CONFIRMED_TINDER_RESUME_BINDING"
  );
  const bindingRevision = positiveInteger(
    sourceValue(value, "bindingRevision", "binding_revision")
  );
  if (!bindingRevision || sourceCaptureId !== expected.sourceCaptureId) {
    throw new TinderOfficialAppResumeError(
      "The confirmed Tinder resume source is invalid.",
      "INVALID_CONFIRMED_TINDER_RESUME_SOURCE",
      500
    );
  }
  return Object.freeze({ sourceCaptureId, bindingId, bindingRevision });
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
    "findActiveUnboundInboxConversationSweepForDevice",
    "getConfirmedHumanArmedSourceForUpdate",
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
      if (strictBoolean(await repository.findActiveUnboundInboxConversationSweepForDevice(transaction, {
        deviceId: normalized.deviceId,
        now: currentTime.toISOString()
      }), "findActiveUnboundInboxConversationSweepForDevice")) {
        return Object.freeze({
          status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_CONFLICT,
          reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE
        });
      }

      const confirmedSource = normalizeConfirmedHumanArmedSource(
        await repository.getConfirmedHumanArmedSourceForUpdate(transaction, {
        sourceCaptureId: normalized.sourceCaptureId,
        deviceId: normalized.deviceId
        }),
        normalized
      );
      if (!confirmedSource) {
        return Object.freeze({
          status: TINDER_OFFICIAL_APP_RESUME_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_OFFICIAL_APP_RESUME_REASON.SOURCE_CAPTURE_NOT_CONFIRMED
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
        sourceCaptureId: confirmedSource.sourceCaptureId,
        bindingId: confirmedSource.bindingId,
        bindingRevision: confirmedSource.bindingRevision,
        permitContractVersion: TINDER_OFFICIAL_APP_RESUME_PERMIT_CONTRACT_VERSION,
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
      const attestationRelation = await client.query(
        "SELECT to_regclass('tinder_local_conversation_attestation_permits') AS relation_name"
      );
      if (!attestationRelation.rows[0]?.relation_name) {
        const legacy = await client.query(
          `SELECT EXISTS (
             SELECT 1
               FROM tinder_visible_chat_sync_permits
              WHERE device_id=$1
                AND permit_state IN ('ISSUED','STAGED')
                AND expires_at>$2
           ) AS active`,
          [deviceId, currentTime]
        );
        return legacy.rows[0]?.active === true;
      }
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1
             FROM tinder_visible_chat_sync_permits sync_permit
        LEFT JOIN tinder_local_conversation_attestation_permits attestation
               ON attestation.command_id=sync_permit.attestation_command_id
        LEFT JOIN device_bridge_commands attestation_command
               ON attestation_command.command_id=attestation.command_id
        LEFT JOIN ${HUMAN_ARMED_CONVERSATION_BINDING_TABLE} binding
               ON binding.binding_id=sync_permit.binding_id
        LEFT JOIN ${HUMAN_ARMED_CONVERSATION_PERMIT_TABLE} binding_permit
               ON binding_permit.binding_id=binding.binding_id
        LEFT JOIN tinder_visible_chat_captures source_capture
               ON source_capture.capture_id=binding_permit.consumed_capture_id
            WHERE sync_permit.device_id=$1
              AND sync_permit.permit_state IN ('ISSUED','STAGED')
              AND sync_permit.expires_at>$2
              AND (
                sync_permit.permit_contract_version=1
                OR (
                  sync_permit.permit_contract_version=2
                  AND attestation.device_id=sync_permit.device_id
                  AND attestation.binding_id=sync_permit.binding_id
                  AND attestation.binding_revision=sync_permit.binding_revision
                  AND attestation.permit_contract_version=1
                  AND attestation.permit_state='ATTESTED'
                  AND attestation.expires_at>$2
                  AND attestation_command.command_type='STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION'
                  AND attestation_command.payload=jsonb_build_object(
                    'binding_revision', attestation.binding_revision::text,
                    'attestation_contract_version', '${TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_VERSION}'
                  )
                  AND binding.device_id=sync_permit.device_id
                  AND binding.binding_revision=sync_permit.binding_revision
                  AND binding.channel='tinder'
                  AND binding.reference_kind='${HUMAN_ARMED_CONVERSATION_REFERENCE_KIND}'
                  AND binding.binding_state='CONFIRMED'
                  AND binding.human_verified=TRUE
                  AND binding_permit.device_id=binding.device_id
                  AND binding_permit.binding_revision=binding.binding_revision
                  AND binding_permit.permit_state='CONSUMED'
                  AND binding_permit.consumed_capture_id=sync_permit.source_capture_id
                  AND source_capture.device_id=binding.device_id
                  AND source_capture.source_package='com.tinder'
                  AND source_capture.capture_safety_status='SAFE'
                  AND source_capture.mapping_status='RESOLVED'
                  AND source_capture.human_review_status='CONFIRMED'
                  AND source_capture.resolved_contact_id=binding.contact_id
                  AND source_capture.capture_revision = (
                    SELECT MAX(newer.capture_revision)
                      FROM tinder_visible_chat_captures newer
                     WHERE newer.device_id=source_capture.device_id
                       AND newer.runtime_thread_fingerprint=source_capture.runtime_thread_fingerprint
                  )
                )
              )
         ) AS active`,
        [deviceId, currentTime]
      );
      return result.rows[0]?.active === true;
    },

    // The V8 table is intentionally absent before its explicit migration.
    // Once present, this check runs after getDeviceRuntimeForUpdate has locked
    // the shared device row, making a fresh launcher permit mutually exclusive
    // with an active V8 read/return parent.
    async findActiveUnboundInboxConversationSweepForDevice(client, { deviceId, now: currentTime }) {
      const relation = await client.query(
        "SELECT to_regclass('tinder_unbound_inbox_conversation_sweeps') AS relation_name"
      );
      if (!relation.rows[0]?.relation_name) return false;
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1
             FROM tinder_unbound_inbox_conversation_sweeps
            WHERE device_id=$1
              AND sweep_state='ACTIVE'
              AND expires_at>$2
         ) AS active`,
        [deviceId, currentTime]
      );
      return result.rows[0]?.active === true;
    },

    async getConfirmedHumanArmedSourceForUpdate(client, { sourceCaptureId, deviceId }) {
      const result = await client.query(
        `SELECT binding.binding_id,
                binding.binding_revision,
                permit.consumed_capture_id AS source_capture_id
           FROM ${HUMAN_ARMED_CONVERSATION_BINDING_TABLE} binding
           JOIN ${HUMAN_ARMED_CONVERSATION_PERMIT_TABLE} permit
             ON permit.binding_id=binding.binding_id
           JOIN tinder_visible_chat_captures capture
             ON capture.capture_id=permit.consumed_capture_id
          WHERE permit.consumed_capture_id=$1
            AND binding.device_id=$2
            AND binding.channel='tinder'
            AND binding.reference_kind=$3
            AND binding.binding_state='CONFIRMED'
            AND binding.human_verified=TRUE
            AND binding.device_id IS NOT NULL
            AND permit.device_id=binding.device_id
            AND permit.binding_revision=binding.binding_revision
            AND permit.permit_state='CONSUMED'
            AND permit.consumed_capture_id IS NOT NULL
            AND capture.device_id=binding.device_id
            AND capture.source_package='com.tinder'
            AND capture.capture_safety_status='SAFE'
            AND capture.mapping_status='RESOLVED'
            AND capture.human_review_status='CONFIRMED'
            AND capture.resolved_contact_id=binding.contact_id
            AND capture.capture_revision = (
              SELECT MAX(newer.capture_revision)
                FROM tinder_visible_chat_captures newer
               WHERE newer.device_id=capture.device_id
                  AND newer.runtime_thread_fingerprint=capture.runtime_thread_fingerprint
            )
          FOR UPDATE OF binding, permit, capture`,
        [sourceCaptureId, deviceId, HUMAN_ARMED_CONVERSATION_REFERENCE_KIND]
      );
      return result.rows.length === 1 ? result.rows[0] : null;
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
      if (input.permitContractVersion !== TINDER_OFFICIAL_APP_RESUME_PERMIT_CONTRACT_VERSION) {
        throw new TypeError("Official-app resume permit must use the current contract version");
      }
      const result = await client.query(
        `INSERT INTO ${TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE} (
           command_id, device_id, source_capture_id, binding_id, binding_revision,
           permit_contract_version, permit_state,
           issued_at, expires_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'ISSUED',NOW(),$7,NOW(),NOW())
          RETURNING command_id`,
        [
          input.commandId, input.deviceId, input.sourceCaptureId,
          input.bindingId, input.bindingRevision, input.permitContractVersion,
          input.expiresAt
        ]
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
