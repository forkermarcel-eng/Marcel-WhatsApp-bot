import crypto from "node:crypto";
import {
  DEVICE_BRIDGE_PROTOCOL,
  isTinderManualGateCapable,
  isTinderUnboundInboxConversationSweepCapable
} from "../device-bridge/protocol-v1.js";
import {
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE
} from "./tinder-unbound-inbox-conversation-sweep.js";

/* ==================================================
V8 UNBOUND INBOX SWEEP -- GATE RECOVERY COORDINATOR
================================================== */

// A V8 child can be issued only while the Android-side Tinder manual gate is
// connected. A genuine Bridge-runtime restart intentionally clears that
// RAM-only gate. This coordinator may recover that *existing* parent once by
// issuing the already-authorized T1 CONNECT_TINDER command. It has no reader,
// selection, transcript, launch, return, or identity authority.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_AUDIT_EVENT =
  "TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_CONNECT_CREATED";
export const TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_CREATED_BY =
  "server_tinder_unbound_inbox_sweep_gate_recovery";
export const TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_CONNECT_TTL_MS = 5 * 60_000;

export const TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS = Object.freeze({
  NOT_APPLICABLE: "NOT_APPLICABLE",
  PENDING: "PENDING",
  BLOCKED: "BLOCKED"
});

export class TinderUnboundInboxSweepGateRecoveryError extends Error {
  constructor(message, code = "INVALID_TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY") {
    super(message);
    this.name = "TinderUnboundInboxSweepGateRecoveryError";
    this.code = code;
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

function normalizeUuid(value, field, code) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!UUID_V4.test(normalized)) {
    throw new TinderUnboundInboxSweepGateRecoveryError(`${field} is invalid.`, code);
  }
  return normalized;
}

function exactDeviceInput(value) {
  if (!exactKeys(value, ["deviceId", "mayIssue"])) {
    throw new TinderUnboundInboxSweepGateRecoveryError(
      "The Tinder gate recovery request is invalid.",
      "INVALID_TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_REQUEST"
    );
  }
  return Object.freeze({
    deviceId: normalizeUuid(value.deviceId, "Device identifier", "INVALID_DEVICE_ID"),
    mayIssue: value.mayIssue === true
  });
}

function normalizedStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function onlineAt(lastAcceptedAt, now) {
  const acceptedAt = new Date(lastAcceptedAt);
  const current = new Date(now);
  if (Number.isNaN(acceptedAt.valueOf()) || Number.isNaN(current.valueOf())) return false;
  const age = current.valueOf() - acceptedAt.valueOf();
  return age >= 0 && age <= DEVICE_BRIDGE_PROTOCOL.offlineAfterSeconds * 1000;
}

function runtimeCanRecoverGate(runtime, now) {
  if (!plainObject(runtime)) return false;
  return normalizedStatus(sourceValue(runtime, "enrollmentState", "enrollment_state")) === "ACTIVE"
    && !sourceValue(runtime, "revokedAt", "revoked_at")
    && onlineAt(sourceValue(runtime, "lastAcceptedHeartbeatAt", "last_accepted_heartbeat_at"), now)
    && normalizedStatus(sourceValue(runtime, "bridgeServiceState", "bridge_service_state")) === "RUNNING"
    && normalizedStatus(sourceValue(runtime, "tinderState", "tinder_state")) === "DISCONNECTED"
    && normalizedStatus(sourceValue(runtime, "automationState", "automation_state")) === "STOPPED"
    && isTinderManualGateCapable(sourceValue(runtime, "capabilities", "capabilities"))
    && isTinderUnboundInboxConversationSweepCapable(
      sourceValue(runtime, "capabilities", "capabilities"));
}

function normalizeActiveIssuedSweep(value, expectedDeviceId, now) {
  if (!plainObject(value)) return null;
  const sweepId = normalizeUuid(sourceValue(value, "sweepId", "sweep_id"), "Sweep identifier",
    "INVALID_TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_SWEEP");
  const deviceId = normalizeUuid(sourceValue(value, "deviceId", "device_id"), "Sweep device identifier",
    "INVALID_TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_SWEEP");
  const activeCommandId = normalizeUuid(sourceValue(value, "activeCommandId", "active_command_id"),
    "Sweep child command identifier", "INVALID_TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_SWEEP");
  const sweepIssuedAt = new Date(sourceValue(value, "sweepIssuedAt", "sweep_issued_at"));
  const sweepExpiresAt = new Date(sourceValue(value, "sweepExpiresAt", "sweep_expires_at"));
  const childExpiresAt = new Date(sourceValue(value, "childExpiresAt", "child_expires_at"));
  const sweepState = normalizedStatus(sourceValue(value, "sweepState", "sweep_state"));
  const childState = normalizedStatus(sourceValue(value, "childState", "child_state"));
  const childKind = normalizedStatus(sourceValue(value, "childKind", "child_kind"));
  if (deviceId !== expectedDeviceId
      || sweepState !== "ACTIVE"
      || childState !== "ISSUED"
      || !["READ", "RETURN_ONLY"].includes(childKind)
      || Number.isNaN(sweepIssuedAt.valueOf())
      || Number.isNaN(sweepExpiresAt.valueOf())
      || Number.isNaN(childExpiresAt.valueOf())
      || sweepIssuedAt.valueOf() > now.valueOf()
      || sweepExpiresAt.valueOf() <= now.valueOf()
      || childExpiresAt.valueOf() <= now.valueOf()) {
    return null;
  }
  return Object.freeze({
    sweepId, deviceId, activeCommandId, sweepIssuedAt, sweepExpiresAt, childExpiresAt
  });
}

function normalizePriorCoordinatorRows(value, expectedDeviceId, now) {
  if (!Array.isArray(value)) {
    throw new TinderUnboundInboxSweepGateRecoveryError(
      "Prior coordinator rows are invalid.",
      "INVALID_TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_REPOSITORY"
    );
  }
  if (value.length === 0) return Object.freeze({ state: "NONE", commandId: null });
  // Any historical coordinator row consumes this recovery opportunity for
  // this exact active sweep. Multiple rows are anomalous and therefore inert,
  // never a reason to pick or replay one.
  if (value.length !== 1 || !plainObject(value[0])) {
    return Object.freeze({ state: "TERMINAL", commandId: null });
  }
  const row = value[0];
  let commandId;
  try {
    commandId = normalizeUuid(sourceValue(row, "commandId", "command_id"),
      "Coordinator command identifier", "INVALID_TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_REPOSITORY");
  } catch {
    return Object.freeze({ state: "TERMINAL", commandId: null });
  }
  const deviceId = String(sourceValue(row, "deviceId", "device_id") || "").trim().toLowerCase();
  const commandType = normalizedStatus(sourceValue(row, "commandType", "command_type"));
  const createdBy = String(sourceValue(row, "createdBy", "created_by") || "");
  const expiresAt = new Date(sourceValue(row, "expiresAt", "expires_at"));
  const terminalStatus = sourceValue(row, "terminalStatus", "terminal_status");
  if (deviceId !== expectedDeviceId
      || commandType !== "CONNECT_TINDER"
      || createdBy !== TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_CREATED_BY
      || !exactEmptyPayload(sourceValue(row, "payload", "payload"))
      || Number.isNaN(expiresAt.valueOf())
      || terminalStatus !== null && terminalStatus !== undefined) {
    return Object.freeze({ state: "TERMINAL", commandId: null });
  }
  return expiresAt.valueOf() > now.valueOf()
    ? Object.freeze({ state: "PENDING", commandId })
    : Object.freeze({ state: "TERMINAL", commandId: null });
}

function commandExpiry(now, sweep) {
  const candidate = Math.min(
    now.valueOf() + TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_CONNECT_TTL_MS,
    sweep.sweepExpiresAt.valueOf(),
    sweep.childExpiresAt.valueOf()
  );
  return Number.isFinite(candidate) && candidate > now.valueOf()
    ? new Date(candidate).toISOString()
    : null;
}

function requireRepository(repository) {
  for (const method of [
    "getDeviceRuntimeForUpdate",
    "getActiveIssuedUnboundInboxSweepForDeviceForUpdate",
    "findCoordinatorConnectRowsForSweep",
    "findNonCoordinatorPendingConnectForDevice",
    "queueCoordinatorConnect",
    "appendCoordinatorConnectAudit"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
}

/**
 * Internal-only coordinator. Its caller must already own the heartbeat
 * transaction; the repository additionally locks the device and V8 parent so
 * this helper cannot create a parallel recovery command when reused.
 */
export function createTinderUnboundInboxSweepGateRecoveryCoordinator(repository, {
  createCommandId = () => crypto.randomUUID(),
  now = () => new Date()
} = {}) {
  requireRepository(repository);
  const newCommandId = () => normalizeUuid(createCommandId(), "Coordinator command identifier",
    "INVALID_TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_COMMAND");

  async function coordinateExistingActiveSweep(transaction, input = {}) {
    const normalized = exactDeviceInput(input);
    const currentTime = new Date(now());
    if (Number.isNaN(currentTime.valueOf())) {
      throw new TinderUnboundInboxSweepGateRecoveryError("Coordinator time is invalid.",
        "INVALID_TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_TIME");
    }
    // This is intentionally a second FOR UPDATE read even though the signed
    // heartbeat already locked the device. It makes the coordinator safe only
    // under the same per-device serialization contract.
    const runtime = await repository.getDeviceRuntimeForUpdate(transaction, {
      deviceId: normalized.deviceId
    });
    if (!runtimeCanRecoverGate(runtime, currentTime)) {
      return Object.freeze({ status: TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS.NOT_APPLICABLE });
    }
    const sweep = normalizeActiveIssuedSweep(
      await repository.getActiveIssuedUnboundInboxSweepForDeviceForUpdate(transaction, {
        deviceId: normalized.deviceId,
        now: currentTime.toISOString()
      }),
      normalized.deviceId,
      currentTime
    );
    if (!sweep) {
      return Object.freeze({ status: TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS.NOT_APPLICABLE });
    }
    const prior = normalizePriorCoordinatorRows(
    await repository.findCoordinatorConnectRowsForSweep(transaction, {
        deviceId: normalized.deviceId,
        sweepId: sweep.sweepId,
        sweepIssuedAt: sweep.sweepIssuedAt.toISOString(),
        sweepExpiresAt: sweep.sweepExpiresAt.toISOString()
      }),
      normalized.deviceId,
      currentTime
    );
    if (prior.state === "PENDING") {
      return Object.freeze({
        status: TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS.PENDING,
        commandId: prior.commandId
      });
    }
    if (prior.state === "TERMINAL" || normalized.mayIssue !== true) {
      // A coordinator command, even one that expired or terminalized, cannot
      // be replayed or replaced within this V8 parent. Likewise, an idempotent
      // heartbeat never creates a new authority.
      return Object.freeze({ status: TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS.BLOCKED });
    }
    if (await repository.findNonCoordinatorPendingConnectForDevice(transaction, {
      deviceId: normalized.deviceId,
      now: currentTime.toISOString(),
      sweepId: sweep.sweepId
    }) === true) {
      // Do not coalesce an unrelated/manual T1 command into a V8 authority.
      return Object.freeze({ status: TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS.BLOCKED });
    }
    const expiresAt = commandExpiry(currentTime, sweep);
    if (!expiresAt) {
      return Object.freeze({ status: TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS.BLOCKED });
    }
    const commandId = newCommandId();
    const inserted = await repository.queueCoordinatorConnect(transaction, Object.freeze({
      commandId, deviceId: normalized.deviceId, sweepId: sweep.sweepId,
      activeCommandId: sweep.activeCommandId, expiresAt,
      commandType: "CONNECT_TINDER", payload: Object.freeze({})
    }));
    if (inserted !== true) {
      return Object.freeze({ status: TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS.BLOCKED });
    }
    await repository.appendCoordinatorConnectAudit(transaction, Object.freeze({
      commandId, deviceId: normalized.deviceId, sweepId: sweep.sweepId
    }));
    return Object.freeze({
      status: TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS.PENDING,
      commandId
    });
  }

  return Object.freeze({ coordinateExistingActiveSweep });
}

/** PostgreSQL adapter used only inside the already-locked heartbeat transaction. */
export function createPgTinderUnboundInboxSweepGateRecoveryRepository(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("pool.connect and pool.query must be functions");
  }
  return Object.freeze({
    async getDeviceRuntimeForUpdate(client, { deviceId }) {
      const result = await client.query(
        `SELECT device_id, enrollment_state, revoked_at, last_accepted_heartbeat_at,
                bridge_service_state, tinder_state, automation_state, capabilities
           FROM device_bridge_devices
          WHERE device_id=$1
          FOR UPDATE`,
        [deviceId]
      );
      return result.rows[0] || null;
    },

    async getActiveIssuedUnboundInboxSweepForDeviceForUpdate(client, { deviceId, now }) {
      const result = await client.query(
        `SELECT sweep.sweep_id, sweep.device_id, sweep.sweep_state,
                sweep.active_command_id, sweep.issued_at AS sweep_issued_at,
                sweep.expires_at AS sweep_expires_at,
                step.child_state, step.child_kind,
                LEAST(step.expires_at, child_command.expires_at) AS child_expires_at
           FROM tinder_unbound_inbox_conversation_sweeps sweep
           JOIN tinder_unbound_inbox_conversation_sweep_steps step
             ON step.sweep_id=sweep.sweep_id
            AND step.device_id=sweep.device_id
            AND step.command_id=sweep.active_command_id
           JOIN device_bridge_commands child_command
             ON child_command.command_id=step.command_id
            AND child_command.device_id=step.device_id
          WHERE sweep.device_id=$1
            AND sweep.sweep_state='ACTIVE'
            AND sweep.expires_at>$2
            AND step.child_state='ISSUED'
            AND step.child_kind IN ('READ','RETURN_ONLY')
            AND step.expires_at>$2
            AND child_command.terminal_status IS NULL
            AND child_command.expires_at>$2
            AND child_command.payload='{}'::jsonb
            AND (
              (step.child_kind='READ'
                AND child_command.command_type='${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE}')
              OR (step.child_kind='RETURN_ONLY'
                AND child_command.command_type='${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE}')
            )
          FOR UPDATE OF sweep, step, child_command`,
        [deviceId, now]
      );
      return result.rows.length === 1 ? result.rows[0] : null;
    },

    async findCoordinatorConnectRowsForSweep(client, {
      deviceId, sweepId, sweepIssuedAt, sweepExpiresAt
    }) {
      const result = await client.query(
        `WITH audited AS (
           SELECT command.command_id, command.device_id, command.command_type,
                  command.payload, command.expires_at, command.terminal_status,
                  command.created_by
             FROM device_bridge_audit_events audit
        LEFT JOIN device_bridge_commands command
               ON command.command_id=audit.command_id
              AND command.device_id=audit.device_id
            WHERE audit.device_id=$1
              AND audit.event_type=$2
              AND audit.details=jsonb_build_object('sweep_id',$3::text)
         ), tagged_in_parent_window AS (
           SELECT command.command_id, command.device_id, command.command_type,
                  command.payload, command.expires_at, command.terminal_status,
                  command.created_by
             FROM device_bridge_commands command
            WHERE command.device_id=$1
              AND command.created_by=$4
              AND command.issued_at >= $5::timestamptz
              AND command.issued_at < $6::timestamptz
         )
         SELECT command_id, device_id, command_type, payload, expires_at,
                terminal_status, created_by
           FROM audited
         UNION
         SELECT command_id, device_id, command_type, payload, expires_at,
                terminal_status, created_by
           FROM tagged_in_parent_window
         ORDER BY command_id ASC NULLS FIRST`,
        [deviceId, TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_AUDIT_EVENT, sweepId,
          TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_CREATED_BY, sweepIssuedAt, sweepExpiresAt]
      );
      return result.rows;
    },

    async findNonCoordinatorPendingConnectForDevice(client, { deviceId, now, sweepId }) {
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1
             FROM device_bridge_commands command
            WHERE command.device_id=$1
              AND command.command_type='CONNECT_TINDER'
              AND command.payload='{}'::jsonb
              AND command.terminal_status IS NULL
              AND command.expires_at>$2
              AND NOT (
                command.created_by=$4
                AND EXISTS (
                  SELECT 1
                    FROM device_bridge_audit_events audit
                   WHERE audit.command_id=command.command_id
                     AND audit.device_id=command.device_id
                     AND audit.event_type=$3
                     AND audit.details=jsonb_build_object('sweep_id',$5::text)
                )
              )
         ) AS active`,
        [deviceId, now, TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_AUDIT_EVENT,
          TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_CREATED_BY, sweepId]
      );
      return result.rows[0]?.active === true;
    },

    async queueCoordinatorConnect(client, input) {
      if (input?.commandType !== "CONNECT_TINDER" || !exactEmptyPayload(input?.payload)) {
        throw new TypeError("Coordinator command must be exact empty CONNECT_TINDER");
      }
      const result = await client.query(
        `INSERT INTO device_bridge_commands (
           command_id, device_id, protocol_version, command_type, payload,
           configuration_revision, issued_at, expires_at, created_by
         )
         SELECT $1,device.device_id,1,'CONNECT_TINDER','{}'::jsonb,
                device.configuration_revision,NOW(),LEAST($4::timestamptz,
                  sweep.expires_at,step.expires_at),$5
           FROM device_bridge_devices device
           JOIN tinder_unbound_inbox_conversation_sweeps sweep
             ON sweep.device_id=device.device_id
           JOIN tinder_unbound_inbox_conversation_sweep_steps step
             ON step.sweep_id=sweep.sweep_id
            AND step.device_id=sweep.device_id
            AND step.command_id=sweep.active_command_id
           JOIN device_bridge_commands child_command
             ON child_command.command_id=step.command_id
            AND child_command.device_id=step.device_id
          WHERE device.device_id=$2
            AND device.enrollment_state='ACTIVE'
            AND device.revoked_at IS NULL
            AND device.bridge_service_state='RUNNING'
            AND device.tinder_state='DISCONNECTED'
            AND device.automation_state='STOPPED'
            AND sweep.sweep_id=$3
            AND sweep.sweep_state='ACTIVE'
            AND sweep.expires_at>NOW()
            AND step.command_id=$6
            AND step.child_state='ISSUED'
            AND step.child_kind IN ('READ','RETURN_ONLY')
            AND step.expires_at>NOW()
            AND child_command.terminal_status IS NULL
            AND child_command.expires_at>NOW()
            AND child_command.payload='{}'::jsonb
            AND (
              (step.child_kind='READ'
                AND child_command.command_type='${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE}')
              OR (step.child_kind='RETURN_ONLY'
                AND child_command.command_type='${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE}')
            )
            AND LEAST($4::timestamptz,sweep.expires_at,step.expires_at,child_command.expires_at)>NOW()
         RETURNING command_id`,
        [input.commandId, input.deviceId, input.sweepId, input.expiresAt,
          TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_CREATED_BY, input.activeCommandId]
      );
      return result.rows.length === 1 && result.rows[0]?.command_id === input.commandId;
    },

    async appendCoordinatorConnectAudit(client, { commandId, deviceId, sweepId }) {
      const result = await client.query(
        `INSERT INTO device_bridge_audit_events
          (event_type, device_id, command_id, result_code, http_status, details)
         VALUES ($1,$2,$3,'SUCCEEDED',201,jsonb_build_object('sweep_id',$4::text))
         RETURNING audit_event_id`,
        [TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_AUDIT_EVENT, deviceId, commandId, sweepId]
      );
      if (result.rows.length !== 1) {
        throw new TinderUnboundInboxSweepGateRecoveryError(
          "Coordinator audit could not be written.",
          "TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_AUDIT_WRITE_FAILED"
        );
      }
    }
  });
}
