import crypto from "node:crypto";
import {
  deriveDeviceStatus,
  isBoundedTinderInboxNavigationDiagnostic,
  TINDER_INBOX_FRESH_REVIEWED_OBSERVATION_KIND
} from "../device-bridge/heartbeat.js";
import {
  isTinderUnboundInboxConversationSweepCapable
} from "../device-bridge/protocol-v1.js";

/* ==================================================
UNBOUND INBOX-CONVERSATION SWEEP -- V8

This is a direct V6 extension. A sweep has no row, person, contact, binding,
name, capture, source-capture, or transcript authority. It merely serializes
a fixed number of independently auditable, empty-payload child commands:

  READ slot -> bounded PENDING/null-contact transcript -> RETURN_ONLY -> next

At most one child is live.  A terminal rejection, expiry, drift, or unknown
outcome closes the parent; no replay, reset, daemon, or inferred continuation
exists.  Android receives only the child command ID already present in the
signed command envelope and an exact empty payload.
================================================== */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE =
  "READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE =
  "RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_COMMAND_TYPES = Object.freeze([
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE
]);
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_CAPABILITY =
  "TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_V1";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE =
  "tinder_unbound_inbox_conversation_sweeps";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE =
  "tinder_unbound_inbox_conversation_sweep_steps";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE =
  "tinder_unbound_inbox_conversation_sweep_transcripts";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE =
  "tinder_unbound_inbox_conversation_sweep_audit";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_CONTRACT_VERSION = 1;
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_MAX_SLOTS = 8;
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_TTL_MS = 3 * 60_000;
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_TTL_MS = 90_000;
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TTL_MS = 30 * 60_000;

export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_ACK_RESULT = Object.freeze({
  tinder_unbound_inbox_conversation_sweep_read: "STAGED"
});
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_ACK_RESULT = Object.freeze({
  // This only proves that Android has staged the return-only child.  It
  // intentionally cannot advance a sweep: the separately signed return
  // receipt below is the sole authority for that state transition.
  tinder_unbound_inbox_conversation_sweep_return: "STAGED"
});
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_RECEIPT_SCHEMA_VERSION =
  "tinder-unbound-inbox-conversation-sweep-return-receipt-v1";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_RECEIPT_STATUS = "RETURNED";

export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS = Object.freeze({
  QUEUED: "QUEUED",
  ACTIVE: "ACTIVE",
  COMPLETED: "COMPLETED",
  STOPPED: "STOPPED",
  EXPIRED: "EXPIRED",
  DEVICE_NOT_READY: "DEVICE_NOT_READY",
  SWEEP_NOT_AVAILABLE: "SWEEP_NOT_AVAILABLE",
  PERMIT_CONFLICT: "PERMIT_CONFLICT"
});

export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON = Object.freeze({
  DEVICE_OFFLINE: "DEVICE_OFFLINE",
  DEVICE_ENROLLMENT_INACTIVE: "DEVICE_ENROLLMENT_INACTIVE",
  BRIDGE_NOT_RUNNING: "BRIDGE_NOT_RUNNING",
  TINDER_NOT_CONNECTED: "TINDER_NOT_CONNECTED",
  AUTOMATION_NOT_STOPPED: "AUTOMATION_NOT_STOPPED",
  DEVICE_CAPABILITY_UNSUPPORTED: "DEVICE_CAPABILITY_UNSUPPORTED",
  INBOX_NOT_READY: "INBOX_NOT_READY",
  HUMAN_ARMED_PERMIT_ACTIVE: "HUMAN_ARMED_PERMIT_ACTIVE",
  VISIBLE_CHAT_SYNC_PERMIT_ACTIVE: "VISIBLE_CHAT_SYNC_PERMIT_ACTIVE",
  RESUME_PERMIT_ACTIVE: "RESUME_PERMIT_ACTIVE",
  ATTESTATION_ACTIVE: "ATTESTATION_ACTIVE",
  SWEEP_ACTIVE: "SWEEP_ACTIVE",
  STEP_NOT_FOUND: "STEP_NOT_FOUND",
  STEP_NOT_STAGED: "STEP_NOT_STAGED",
  STEP_DEVICE_MISMATCH: "STEP_DEVICE_MISMATCH",
  STEP_EXPIRED: "STEP_EXPIRED",
  STEP_ACK_INVALID: "STEP_ACK_INVALID",
  STEP_ALREADY_TERMINAL: "STEP_ALREADY_TERMINAL",
  THREAD_DRIFT: "THREAD_DRIFT",
  COMMAND_REJECTED: "COMMAND_REJECTED",
  RUNTIME_GATE_LOST: "RUNTIME_GATE_LOST",
  CHILD_EXPIRED: "CHILD_EXPIRED",
  SWEEP_EXPIRED: "SWEEP_EXPIRED",
  UNKNOWN_OUTCOME: "UNKNOWN_OUTCOME"
});

export class TinderUnboundInboxConversationSweepError extends Error {
  constructor(message, code = "INVALID_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP", statusCode = 400) {
    super(message);
    this.name = "TinderUnboundInboxConversationSweepError";
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
  if (!normalized) throw new TinderUnboundInboxConversationSweepError(`${field} is invalid.`, code);
  return normalized;
}

function normalizeDeviceInput(value) {
  if (!exactKeys(value, ["deviceId"])) {
    throw new TinderUnboundInboxConversationSweepError(
      "The unbound Inbox sweep request has unsupported fields.",
      "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_REQUEST"
    );
  }
  return Object.freeze({
    deviceId: normalizeUuid(value.deviceId, "Device identifier", "INVALID_DEVICE_ID")
  });
}

function normalizeFreshInboxObservationInput(value) {
  if (!exactKeys(value, ["deviceId", "heartbeatSequence", "inboxNavigation", "observationNonce"])
      || !Number.isSafeInteger(value.heartbeatSequence) || value.heartbeatSequence < 1
      || !isBoundedTinderInboxNavigationDiagnostic(value.inboxNavigation)
      || value.inboxNavigation.observation_kind !== TINDER_INBOX_FRESH_REVIEWED_OBSERVATION_KIND) {
    throw new TinderUnboundInboxConversationSweepError(
      "The unbound Inbox sweep observation is invalid.",
      "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_OBSERVATION"
    );
  }
  const observationNonce = normalizeUuid(
    value.observationNonce, "Inbox observation nonce", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_OBSERVATION_NONCE"
  );
  if (value.inboxNavigation.observation_nonce !== observationNonce || !currentInboxReady(value.inboxNavigation)) {
    throw new TinderUnboundInboxConversationSweepError(
      "The unbound Inbox sweep observation is unavailable.",
      "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_OBSERVATION"
    );
  }
  return Object.freeze({
    deviceId: normalizeUuid(value.deviceId, "Device identifier", "INVALID_DEVICE_ID"),
    heartbeatSequence: value.heartbeatSequence,
    inboxNavigation: Object.freeze({
      stage: value.inboxNavigation.stage,
      reason: value.inboxNavigation.reason,
      visible_conversation_count: value.inboxNavigation.visible_conversation_count,
      observed_event_count: value.inboxNavigation.observed_event_count,
      observation_kind: TINDER_INBOX_FRESH_REVIEWED_OBSERVATION_KIND,
      observation_nonce: observationNonce
    }),
    observationNonce
  });
}

function normalizeAuthorizationInput(value) {
  if (!exactKeys(value, ["commandId", "deviceId"])) {
    throw new TinderUnboundInboxConversationSweepError(
      "The unbound Inbox sweep authorization is invalid.",
      "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_AUTHORIZATION"
    );
  }
  return Object.freeze({
    commandId: normalizeUuid(value.commandId, "Step command identifier", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_COMMAND_ID"),
    deviceId: normalizeUuid(value.deviceId, "Device identifier", "INVALID_DEVICE_ID")
  });
}

function normalizeConsumptionInput(value) {
  if (!exactKeys(value, ["authorization", "transcriptId"]) || !plainObject(value.authorization)) {
    throw new TinderUnboundInboxConversationSweepError(
      "The unbound Inbox sweep consumption is invalid.",
      "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_CONSUMPTION"
    );
  }
  return Object.freeze({
    authorization: normalizeAuthorizationInput(value.authorization),
    transcriptId: normalizeUuid(value.transcriptId, "Transcript identifier", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_ID")
  });
}

function normalizeReturnReceiptInput(value) {
  if (!exactKeys(value, ["commandId", "deviceId", "status"])
      || value.status !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_RECEIPT_STATUS) {
    throw new TinderUnboundInboxConversationSweepError(
      "Unbound Inbox sweep return receipt is invalid.",
      "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_RECEIPT"
    );
  }
  return Object.freeze({
    commandId: normalizeUuid(value.commandId, "Return command identifier", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_COMMAND_ID"),
    deviceId: normalizeUuid(value.deviceId, "Device identifier", "INVALID_DEVICE_ID"),
    status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_RECEIPT_STATUS
  });
}

function runtimeGateResult(row) {
  const runtime = plainObject(row) ? row : null;
  if (!runtime || sourceValue(runtime, "online", "online") !== true) {
    return Object.freeze({ status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.DEVICE_OFFLINE });
  }
  if (normalizedStatus(sourceValue(runtime, "enrollmentState", "enrollment_state")) !== "ACTIVE") {
    return Object.freeze({ status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.DEVICE_ENROLLMENT_INACTIVE });
  }
  if (normalizedStatus(sourceValue(runtime, "bridgeServiceState", "bridge_service_state")) !== "RUNNING") {
    return Object.freeze({ status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.BRIDGE_NOT_RUNNING });
  }
  if (normalizedStatus(sourceValue(runtime, "tinderState", "tinder_state")) !== "CONNECTED") {
    return Object.freeze({ status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.TINDER_NOT_CONNECTED });
  }
  if (normalizedStatus(sourceValue(runtime, "automationState", "automation_state")) !== "STOPPED") {
    return Object.freeze({ status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.AUTOMATION_NOT_STOPPED });
  }
  if (!isTinderUnboundInboxConversationSweepCapable(sourceValue(runtime, "capabilities", "capabilities"))) {
    return Object.freeze({ status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.DEVICE_CAPABILITY_UNSUPPORTED });
  }
  return null;
}

function currentInboxReady(row) {
  const navigation = sourceValue(row, "inboxNavigation", "inbox_navigation")
    ?? (isBoundedTinderInboxNavigationDiagnostic(row) ? row : null);
  return isBoundedTinderInboxNavigationDiagnostic(navigation)
    && navigation.stage === "INBOX_READY"
    && navigation.reason === "NONE"
    && navigation.visible_conversation_count > 0;
}

function date(value) {
  const result = new Date(value);
  return Number.isNaN(result.valueOf()) ? null : result;
}

function currentSweepFromRow(row) {
  const sweepId = uuid(sourceValue(row, "sweepId", "sweep_id"));
  const deviceId = uuid(sourceValue(row, "deviceId", "device_id"));
  const activeCommandRaw = sourceValue(row, "activeCommandId", "active_command_id");
  const activeCommandId = activeCommandRaw === null || activeCommandRaw === undefined ? null : uuid(activeCommandRaw);
  const expiresAt = date(sourceValue(row, "expiresAt", "expires_at"));
  const maxSlots = Number(sourceValue(row, "maxSlots", "max_slots"));
  const nextSlot = Number(sourceValue(row, "nextSlot", "next_slot"));
  if (!sweepId || !deviceId || !expiresAt || !Number.isSafeInteger(maxSlots) || !Number.isSafeInteger(nextSlot)
      || (activeCommandRaw !== null && activeCommandRaw !== undefined && !activeCommandId)) return null;
  return Object.freeze({
    sweepId, deviceId, activeCommandId, expiresAt, maxSlots, nextSlot,
    sweepState: normalizedStatus(sourceValue(row, "sweepState", "sweep_state"))
  });
}

function currentStepFromRow(row) {
  const commandId = uuid(sourceValue(row, "commandId", "command_id"));
  const sweepId = uuid(sourceValue(row, "sweepId", "sweep_id"));
  const deviceId = uuid(sourceValue(row, "deviceId", "device_id"));
  const transcriptRaw = sourceValue(row, "transcriptId", "transcript_id");
  const transcriptId = transcriptRaw === null || transcriptRaw === undefined ? null : uuid(transcriptRaw);
  const expiresAt = date(sourceValue(row, "expiresAt", "expires_at"));
  const slotOrdinal = Number(sourceValue(row, "slotOrdinal", "slot_ordinal"));
  if (!commandId || !sweepId || !deviceId || !expiresAt || !Number.isSafeInteger(slotOrdinal)
      || (transcriptRaw !== null && transcriptRaw !== undefined && !transcriptId)) return null;
  return Object.freeze({
    commandId, sweepId, deviceId, transcriptId, expiresAt, slotOrdinal,
    childKind: normalizedStatus(sourceValue(row, "childKind", "child_kind")),
    childState: normalizedStatus(sourceValue(row, "childState", "child_state")),
    commandType: String(sourceValue(row, "commandType", "command_type") || "").trim(),
    commandPayload: sourceValue(row, "commandPayload", "command_payload"),
    commandTerminalStatus: normalizedStatus(sourceValue(row, "commandTerminalStatus", "terminal_status")),
    acknowledgementStatus: normalizedStatus(sourceValue(row, "acknowledgementStatus", "ack_status")),
    acknowledgementResult: sourceValue(row, "acknowledgementResult", "ack_result")
  });
}

function strictBoolean(value, method) {
  if (value !== true && value !== false) {
    throw new TinderUnboundInboxConversationSweepError(
      `${method} returned an invalid result.`, "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_REPOSITORY", 500
    );
  }
  return value;
}

function auditRecord({ auditId, sweepId, commandId = null, deviceId, slotOrdinal = null, transcriptId = null, action, actor, source, reasonCode = null }) {
  return Object.freeze({
    auditId: normalizeUuid(auditId, "Audit identifier", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_ID"),
    sweepId, commandId, deviceId, slotOrdinal, transcriptId, action, actor, source, reasonCode,
    details: Object.freeze({})
  });
}

function requireRepository(repository) {
  for (const method of [
    "withTransaction",
    "getDeviceRuntimeForUpdate",
    "findPriorFreshReviewedInboxObservationForDevice",
    "findUnboundInboxConversationSweepByObservationNonceForDevice",
    "expireUnboundInboxConversationSweepForDevice",
    "findActiveHumanArmedPermitForDevice",
    "findActiveVisibleChatSyncPermitForDevice",
    "findActiveOfficialAppResumePermitForDevice",
    "findActiveLocalConversationAttestationForDevice",
    "findActiveUnboundInboxConversationSweepForDevice",
    "queueUnboundInboxConversationSweepCommand",
    "createUnboundInboxConversationSweep",
    "createUnboundInboxConversationSweepStep",
    "setUnboundInboxConversationSweepActiveStep",
    "getUnboundInboxConversationSweepForUpdate",
    "getUnboundInboxConversationSweepForDeviceForUpdate",
    "getUnboundInboxConversationSweepStepForUpdate",
    "stageUnboundInboxConversationSweepReadStep",
    "stageUnboundInboxConversationSweepReturnStep",
    "acceptUnboundInboxConversationSweepReadStep",
    "acceptUnboundInboxConversationSweepReturnStep",
    "cancelUnboundInboxConversationSweepStepAndStop",
    "completeUnboundInboxConversationSweep",
    "insertUnboundInboxConversationSweepAudit"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
}

export function isExactUnboundInboxConversationSweepReadStagedAcknowledgement(value) {
  return exactKeys(value, Object.keys(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_ACK_RESULT))
    && value.tinder_unbound_inbox_conversation_sweep_read
      === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_ACK_RESULT.tinder_unbound_inbox_conversation_sweep_read;
}

export function isExactUnboundInboxConversationSweepReturnAcknowledgement(value) {
  return exactKeys(value, Object.keys(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_ACK_RESULT))
    && value.tinder_unbound_inbox_conversation_sweep_return
      === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_ACK_RESULT.tinder_unbound_inbox_conversation_sweep_return;
}

function childCommand({ commandId, deviceId, childKind, expiresAt }) {
  return Object.freeze({
    commandId,
    deviceId,
    commandType: childKind === "READ"
      ? TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE
      : TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE,
    payload: Object.freeze({}),
    expiresAt
  });
}

export function createTinderUnboundInboxConversationSweepService(repository, {
  createSweepId = () => crypto.randomUUID(),
  createCommandId = () => crypto.randomUUID(),
  createAuditId = () => crypto.randomUUID(),
  now = () => new Date(),
  maxSlots = TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_MAX_SLOTS,
  readTtlMs = TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_TTL_MS,
  returnTtlMs = TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_TTL_MS,
  sweepTtlMs = TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TTL_MS,
  // Dashboard status may terminalize an expired child/parent.  The route
  // supplies the exact catalog assertion so this otherwise bounded read
  // surface is inert when V8 has drifted.  Core service callers which already
  // hold their own canonical gate intentionally leave it null.
  assertFoundationReady = null
} = {}) {
  requireRepository(repository);
  if (maxSlots !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_MAX_SLOTS
      || !Number.isSafeInteger(readTtlMs) || readTtlMs < 30_000
      || readTtlMs > TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_TTL_MS
      || !Number.isSafeInteger(returnTtlMs) || returnTtlMs < 30_000
      || returnTtlMs > TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_TTL_MS
      || !Number.isSafeInteger(sweepTtlMs) || sweepTtlMs < readTtlMs
      || sweepTtlMs > TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TTL_MS
      || (assertFoundationReady !== null && typeof assertFoundationReady !== "function")) {
    throw new TypeError("Unbound Inbox sweep bounds are invalid");
  }
  const newSweepId = () => normalizeUuid(createSweepId(), "Sweep identifier", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_ID");
  const newCommandId = () => normalizeUuid(createCommandId(), "Step command identifier", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_COMMAND_ID");
  const newAuditId = () => normalizeUuid(createAuditId(), "Audit identifier", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_ID");

  async function expireForDevice(transaction, { deviceId, currentTime }) {
    const expired = await repository.expireUnboundInboxConversationSweepForDevice(transaction, {
      deviceId, expiredAt: currentTime.toISOString()
    });
    if (!Array.isArray(expired)) {
      throw new TinderUnboundInboxConversationSweepError(
        "Unbound Inbox sweep expiry returned invalid data.", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_REPOSITORY", 500
      );
    }
    let childExpiredCount = 0;
    let parentExpiredCount = 0;
    for (const row of expired) {
      const sweep = currentSweepFromRow(row);
      if (!sweep || sweep.deviceId !== deviceId) {
        throw new TinderUnboundInboxConversationSweepError(
          "Unbound Inbox sweep expiry returned invalid data.", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_REPOSITORY", 500
        );
      }
      const childExpired = sweep.sweepState === "STOPPED";
      const expiredCommandId = uuid(sourceValue(row, "expiredCommandId", "expired_command_id"));
      const expiredSlotOrdinal = Number(sourceValue(row, "expiredSlotOrdinal", "expired_slot_ordinal"));
      if (childExpired && (!expiredCommandId || !Number.isSafeInteger(expiredSlotOrdinal)
          || expiredSlotOrdinal < 1 || expiredSlotOrdinal > TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_MAX_SLOTS)) {
        throw new TinderUnboundInboxConversationSweepError(
          "Unbound Inbox sweep expiry returned invalid child provenance.", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_REPOSITORY", 500
        );
      }
      if (!childExpired && sweep.sweepState !== "EXPIRED") {
        throw new TinderUnboundInboxConversationSweepError(
          "Unbound Inbox sweep expiry returned invalid state.", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_REPOSITORY", 500
        );
      }
      await repository.insertUnboundInboxConversationSweepAudit(transaction, auditRecord({
        auditId: newAuditId(), sweepId: sweep.sweepId, deviceId,
        commandId: childExpired ? expiredCommandId : null,
        slotOrdinal: childExpired ? expiredSlotOrdinal : null,
        action: childExpired ? "CHILD_EXPIRED" : "SWEEP_EXPIRED",
        actor: "SERVER_EXPIRY", source: "SERVER_MAINTENANCE",
        reasonCode: childExpired
          ? TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.CHILD_EXPIRED
          : TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.SWEEP_EXPIRED
      }));
      if (childExpired) childExpiredCount += 1;
      else parentExpiredCount += 1;
    }
    return Object.freeze({ childExpiredCount, parentExpiredCount });
  }

  // Heartbeats must terminalize an expired V8 child before evaluating any
  // other deliverable command.  This stays inside the caller's already
  // locked transaction and returns only a bounded fact, never sweep data.
  async function expireUnboundInboxConversationSweepForHeartbeat(transaction, { deviceId } = {}) {
    const normalizedDeviceId = normalizeUuid(
      deviceId,
      "Device identifier",
      "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_DEVICE_ID"
    );
    const currentTime = new Date(now());
    if (Number.isNaN(currentTime.valueOf())) {
      throw new TinderUnboundInboxConversationSweepError(
        "Unbound Inbox sweep time is invalid.", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_TIME", 500
      );
    }
    const outcome = await expireForDevice(transaction, {
      deviceId: normalizedDeviceId,
      currentTime
    });
    const active = strictBoolean(
      await repository.findActiveUnboundInboxConversationSweepForDevice(transaction, {
        deviceId: normalizedDeviceId,
        now: currentTime.toISOString()
      }),
      "findActiveUnboundInboxConversationSweepForDevice"
    );
    return Object.freeze({ childExpired: outcome.childExpiredCount > 0, active });
  }

  async function issueChild(transaction, { sweep, childKind, slotOrdinal, currentTime }) {
    const commandId = newCommandId();
    const expiresAt = new Date(Math.min(
      currentTime.valueOf() + (childKind === "READ" ? readTtlMs : returnTtlMs),
      sweep.expiresAt.valueOf()
    )).toISOString();
    if (new Date(expiresAt).valueOf() <= currentTime.valueOf()) {
      throw new TinderUnboundInboxConversationSweepError(
        "Unbound Inbox sweep has expired.", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.SWEEP_EXPIRED, 409
      );
    }
    const command = childCommand({ commandId, deviceId: sweep.deviceId, childKind, expiresAt });
    await repository.queueUnboundInboxConversationSweepCommand(transaction, command);
    await repository.createUnboundInboxConversationSweepStep(transaction, Object.freeze({
      commandId, sweepId: sweep.sweepId, deviceId: sweep.deviceId, slotOrdinal,
      childKind, childState: "ISSUED", expiresAt
    }));
    await repository.setUnboundInboxConversationSweepActiveStep(transaction, {
      sweepId: sweep.sweepId, commandId, nextSlot: slotOrdinal
    });
    await repository.insertUnboundInboxConversationSweepAudit(transaction, auditRecord({
      auditId: newAuditId(), sweepId: sweep.sweepId, commandId, deviceId: sweep.deviceId,
      slotOrdinal, action: childKind === "READ" ? "READ_ISSUED" : "RETURN_ISSUED",
      actor: "SERVER_AUTOMATION", source: "SERVER_AUTOMATION"
    }));
    return commandId;
  }

  /**
   * Internal-only start path. The caller must already own the device row lock
   * in the signed heartbeat transaction and must have written the immutable
   * fresh-Inbox audit fact. There is deliberately no dashboard/manual route.
   */
  async function startUnboundInboxConversationSweepFromFreshInboxObservation(transaction, input = {}) {
    const normalized = normalizeFreshInboxObservationInput(input);
    const currentTime = new Date(now());
    if (Number.isNaN(currentTime.valueOf())) {
      throw new TinderUnboundInboxConversationSweepError(
        "Unbound Inbox sweep time is invalid.", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_TIME", 500
      );
    }
    const runtime = await repository.getDeviceRuntimeForUpdate(transaction, normalized.deviceId, currentTime);
    const gate = runtimeGateResult(runtime);
    if (gate) return gate;
    const heartbeatSequence = Number(sourceValue(runtime, "lastHeartbeatSequence", "last_heartbeat_sequence"));
    if (heartbeatSequence !== normalized.heartbeatSequence) {
      return Object.freeze({ status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS.SWEEP_NOT_AVAILABLE,
        reasonCode: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.INBOX_NOT_READY });
    }
    // The heartbeat audit is inserted before this call. A nonce from any
    // earlier sequence is permanently consumed, even when its first attempt
    // was blocked by a gate or conflict; retries must obtain a new local
    // reviewed Inbox observation instead of starting from stale evidence.
    if (strictBoolean(await repository.findPriorFreshReviewedInboxObservationForDevice(transaction, {
      deviceId: normalized.deviceId, observationNonce: normalized.observationNonce,
      heartbeatSequence: normalized.heartbeatSequence
    }), "findPriorFreshReviewedInboxObservationForDevice")) {
      return Object.freeze({ status: "INERT" });
    }
    if (strictBoolean(await repository.findUnboundInboxConversationSweepByObservationNonceForDevice(transaction, {
      deviceId: normalized.deviceId, observationNonce: normalized.observationNonce
    }), "findUnboundInboxConversationSweepByObservationNonceForDevice")) {
      return Object.freeze({ status: "INERT" });
    }
    await expireForDevice(transaction, { deviceId: normalized.deviceId, currentTime });
    const conflicts = [
      ["findActiveHumanArmedPermitForDevice", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.HUMAN_ARMED_PERMIT_ACTIVE],
      ["findActiveVisibleChatSyncPermitForDevice", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.VISIBLE_CHAT_SYNC_PERMIT_ACTIVE],
      ["findActiveOfficialAppResumePermitForDevice", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.RESUME_PERMIT_ACTIVE],
      ["findActiveLocalConversationAttestationForDevice", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.ATTESTATION_ACTIVE],
      ["findActiveUnboundInboxConversationSweepForDevice", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.SWEEP_ACTIVE]
    ];
    for (const [method, reasonCode] of conflicts) {
      if (strictBoolean(await repository[method](transaction, {
        deviceId: normalized.deviceId, now: currentTime.toISOString()
      }), method)) {
        return Object.freeze({ status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS.PERMIT_CONFLICT, reasonCode });
      }
    }
    const sweepId = newSweepId();
    const firstCommandId = newCommandId();
    const firstExpiresAt = new Date(Math.min(
      currentTime.valueOf() + readTtlMs,
      currentTime.valueOf() + sweepTtlMs
    )).toISOString();
    const sweep = Object.freeze({
      sweepId, deviceId: normalized.deviceId, maxSlots,
      nextSlot: 1, activeCommandId: firstCommandId, sweepState: "ACTIVE",
      expiresAt: new Date(currentTime.valueOf() + sweepTtlMs)
    });
    await repository.queueUnboundInboxConversationSweepCommand(transaction, childCommand({
      commandId: firstCommandId, deviceId: normalized.deviceId,
      childKind: "READ", expiresAt: firstExpiresAt
    }));
    await repository.createUnboundInboxConversationSweep(transaction, Object.freeze({
      sweepId, deviceId: normalized.deviceId,
      sweepContractVersion: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_CONTRACT_VERSION,
      maxSlots, inboxHeartbeatSequence: normalized.heartbeatSequence,
      inboxObservationNonce: normalized.observationNonce,
      activeCommandId: firstCommandId, expiresAt: sweep.expiresAt.toISOString()
    }));
    await repository.createUnboundInboxConversationSweepStep(transaction, Object.freeze({
      commandId: firstCommandId, sweepId, deviceId: normalized.deviceId, slotOrdinal: 1,
      childKind: "READ", childState: "ISSUED", expiresAt: firstExpiresAt
    }));
    await repository.insertUnboundInboxConversationSweepAudit(transaction, auditRecord({
      auditId: newAuditId(), sweepId, deviceId: normalized.deviceId,
      action: "SWEEP_ISSUED", actor: "SERVER_AUTOMATION", source: "SIGNED_DEVICE_INGRESS"
    }));
    await repository.insertUnboundInboxConversationSweepAudit(transaction, auditRecord({
      auditId: newAuditId(), sweepId, commandId: firstCommandId, deviceId: normalized.deviceId,
      slotOrdinal: 1, action: "READ_ISSUED", actor: "SERVER_AUTOMATION", source: "SERVER_AUTOMATION"
    }));
    return Object.freeze({ status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS.QUEUED });
  }

  async function authorizeIncomingSweepTranscript(transaction, input = {}) {
    const normalized = normalizeAuthorizationInput(input);
    const currentTime = new Date(now());
    if (Number.isNaN(currentTime.valueOf())) {
      throw new TinderUnboundInboxConversationSweepError(
        "Unbound Inbox sweep time is invalid.", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_TIME", 500
      );
    }
    const step = currentStepFromRow(await repository.getUnboundInboxConversationSweepStepForUpdate(transaction, normalized.commandId));
    if (!step) throw new TinderUnboundInboxConversationSweepError("Unbound Inbox sweep step is unavailable.", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.STEP_NOT_FOUND, 409);
    if (step.deviceId !== normalized.deviceId) throw new TinderUnboundInboxConversationSweepError("Unbound Inbox sweep step is unavailable.", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.STEP_DEVICE_MISMATCH, 409);
    const sweep = currentSweepFromRow(await repository.getUnboundInboxConversationSweepForUpdate(transaction, step.sweepId));
    if (!sweep || sweep.deviceId !== step.deviceId || sweep.sweepState !== "ACTIVE" || sweep.activeCommandId !== step.commandId) {
      throw new TinderUnboundInboxConversationSweepError("Unbound Inbox sweep is unavailable.", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.STEP_ALREADY_TERMINAL, 409);
    }
    if (step.childKind !== "READ" || step.childState !== "STAGED" || step.transcriptId !== null
        || step.commandType !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_READ_COMMAND_TYPE
        || !exactEmptyPayload(step.commandPayload)
        || step.commandTerminalStatus !== "SUCCEEDED" || step.acknowledgementStatus !== "SUCCEEDED"
        || !isExactUnboundInboxConversationSweepReadStagedAcknowledgement(step.acknowledgementResult)) {
      throw new TinderUnboundInboxConversationSweepError("Unbound Inbox sweep step is unavailable.", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.STEP_NOT_STAGED, 409);
    }
    if (step.expiresAt.valueOf() <= currentTime.valueOf() || sweep.expiresAt.valueOf() <= currentTime.valueOf()) {
      throw new TinderUnboundInboxConversationSweepError("Unbound Inbox sweep step has expired.", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.STEP_EXPIRED, 409);
    }
    return Object.freeze({ status: "STAGED", authorization: Object.freeze({ commandId: step.commandId, deviceId: step.deviceId }) });
  }

  async function consumeAuthorizedSweepTranscript(transaction, input = {}) {
    const normalized = normalizeConsumptionInput(input);
    const currentTime = new Date(now());
    const step = currentStepFromRow(await repository.getUnboundInboxConversationSweepStepForUpdate(transaction, normalized.authorization.commandId));
    if (!step || step.deviceId !== normalized.authorization.deviceId || step.childKind !== "READ" || step.childState !== "STAGED") {
      return Object.freeze({ status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS.SWEEP_NOT_AVAILABLE });
    }
    const sweep = currentSweepFromRow(await repository.getUnboundInboxConversationSweepForUpdate(transaction, step.sweepId));
    if (!sweep || sweep.sweepState !== "ACTIVE" || sweep.activeCommandId !== step.commandId
        || step.expiresAt.valueOf() <= currentTime.valueOf() || sweep.expiresAt.valueOf() <= currentTime.valueOf()) {
      return Object.freeze({ status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS.SWEEP_NOT_AVAILABLE });
    }
    if (!strictBoolean(await repository.acceptUnboundInboxConversationSweepReadStep(transaction, {
      commandId: step.commandId, transcriptId: normalized.transcriptId, acceptedAt: currentTime.toISOString()
    }), "acceptUnboundInboxConversationSweepReadStep")) {
      return Object.freeze({ status: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS.SWEEP_NOT_AVAILABLE });
    }
    await repository.insertUnboundInboxConversationSweepAudit(transaction, auditRecord({
      auditId: newAuditId(), sweepId: sweep.sweepId, commandId: step.commandId, deviceId: step.deviceId,
      slotOrdinal: step.slotOrdinal, transcriptId: normalized.transcriptId,
      action: "READ_TRANSCRIPT_ACCEPTED", actor: "SIGNED_TRANSCRIPT_INGRESS", source: "SIGNED_TRANSCRIPT_INGRESS"
    }));
    await issueChild(transaction, { sweep, childKind: "RETURN_ONLY", slotOrdinal: step.slotOrdinal, currentTime });
    return Object.freeze({ status: "RETURN_QUEUED" });
  }

  async function projectSweepChildAcknowledgement(transaction, { command, ack } = {}) {
    if (!TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_COMMAND_TYPES.includes(command?.command_type)) return null;
    if (!["SUCCEEDED", "FAILED", "REJECTED", "EXPIRED"].includes(ack?.status)) return null;
    const currentTime = new Date(now());
    const step = currentStepFromRow(await repository.getUnboundInboxConversationSweepStepForUpdate(transaction, command.command_id));
    if (!step || step.deviceId !== command.device_id || step.childState !== "ISSUED") {
      throw new TinderUnboundInboxConversationSweepError("Unbound Inbox sweep step transition is invalid.", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.STEP_ALREADY_TERMINAL, 409);
    }
    const sweep = currentSweepFromRow(await repository.getUnboundInboxConversationSweepForUpdate(transaction, step.sweepId));
    if (!sweep || sweep.sweepState !== "ACTIVE" || sweep.activeCommandId !== step.commandId) {
      throw new TinderUnboundInboxConversationSweepError("Unbound Inbox sweep is unavailable.", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.STEP_ALREADY_TERMINAL, 409);
    }
    if (ack.status !== "SUCCEEDED") {
      const reasonCode = ack.status === "EXPIRED"
        ? TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.CHILD_EXPIRED
        : ack.error?.code === "TINDER_UNBOUND_INBOX_SWEEP_THREAD_DRIFT"
          ? TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.THREAD_DRIFT
          : (ack.error?.code === "COMMAND_OUTCOME_UNRESOLVED"
            || ack.error?.code === "TINDER_UNBOUND_INBOX_SWEEP_OUTCOME_UNRESOLVED")
            ? TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.UNKNOWN_OUTCOME
          : ack.error?.code === "TINDER_UNBOUND_INBOX_SWEEP_LOCAL_CONTEXT_UNAVAILABLE"
            ? TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.RUNTIME_GATE_LOST
        : ack.status === "REJECTED"
          ? TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.COMMAND_REJECTED
          : TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.RUNTIME_GATE_LOST;
      if (!strictBoolean(await repository.cancelUnboundInboxConversationSweepStepAndStop(transaction, {
        commandId: step.commandId, sweepId: sweep.sweepId, closedAt: ack.occurred_at,
        childState: ack.status === "EXPIRED" ? "EXPIRED" : "CANCELLED", reasonCode
      }), "cancelUnboundInboxConversationSweepStepAndStop")) {
        throw new TinderUnboundInboxConversationSweepError("Unbound Inbox sweep terminal transition failed.", "UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSITION_FAILED", 500);
      }
      await repository.insertUnboundInboxConversationSweepAudit(transaction, auditRecord({
        auditId: newAuditId(), sweepId: sweep.sweepId, commandId: step.commandId, deviceId: step.deviceId,
        slotOrdinal: step.slotOrdinal, action: "SWEEP_STOPPED", actor: "ANDROID_RUNTIME", source: "SIGNED_DEVICE_INGRESS", reasonCode
      }));
      return Object.freeze({ state: "STOPPED" });
    }
    if (step.childKind === "READ") {
      if (!isExactUnboundInboxConversationSweepReadStagedAcknowledgement(ack.result)) {
        throw new TinderUnboundInboxConversationSweepError("Unbound Inbox sweep read acknowledgement is invalid.", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.STEP_ACK_INVALID, 409);
      }
      if (!strictBoolean(await repository.stageUnboundInboxConversationSweepReadStep(transaction, {
        commandId: step.commandId, stagedAt: ack.occurred_at
      }), "stageUnboundInboxConversationSweepReadStep")) {
        throw new TinderUnboundInboxConversationSweepError("Unbound Inbox sweep read staging failed.", "UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSITION_FAILED", 500);
      }
      await repository.insertUnboundInboxConversationSweepAudit(transaction, auditRecord({
        auditId: newAuditId(), sweepId: sweep.sweepId, commandId: step.commandId, deviceId: step.deviceId,
        slotOrdinal: step.slotOrdinal, action: "READ_STAGED", actor: "ANDROID_RUNTIME", source: "SIGNED_DEVICE_INGRESS"
      }));
      return Object.freeze({ state: "STAGED" });
    }
    if (!isExactUnboundInboxConversationSweepReturnAcknowledgement(ack.result)) {
      throw new TinderUnboundInboxConversationSweepError("Unbound Inbox sweep return acknowledgement is invalid.", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.STEP_ACK_INVALID, 409);
    }
    if (!strictBoolean(await repository.stageUnboundInboxConversationSweepReturnStep(transaction, {
      commandId: step.commandId, stagedAt: ack.occurred_at
    }), "stageUnboundInboxConversationSweepReturnStep")) {
      throw new TinderUnboundInboxConversationSweepError("Unbound Inbox sweep return staging failed.", "UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSITION_FAILED", 500);
    }
    await repository.insertUnboundInboxConversationSweepAudit(transaction, auditRecord({
      auditId: newAuditId(), sweepId: sweep.sweepId, commandId: step.commandId, deviceId: step.deviceId,
      slotOrdinal: step.slotOrdinal, action: "RETURN_STAGED", actor: "ANDROID_RUNTIME", source: "SIGNED_DEVICE_INGRESS"
    }));
    // A terminal command ACK establishes only that Android staged the local
    // return handoff.  It cannot claim the actual Inbox return or authorize
    // another Row/READ slot.  The distinct signed RETURNED receipt below is
    // the only next-slot transition authority.
    return Object.freeze({ state: "STAGED" });
  }

  async function acceptSignedSweepReturnReceipt(input = {}) {
    const normalized = normalizeReturnReceiptInput(input);
    return repository.withTransaction(async transaction => {
      const currentTime = new Date(now());
      if (Number.isNaN(currentTime.valueOf())) {
        throw new TinderUnboundInboxConversationSweepError(
          "Unbound Inbox sweep time is invalid.", "INVALID_UNBOUND_INBOX_CONVERSATION_SWEEP_TIME", 500
        );
      }
      const step = currentStepFromRow(await repository.getUnboundInboxConversationSweepStepForUpdate(transaction, normalized.commandId));
      if (!step || step.deviceId !== normalized.deviceId || step.childKind !== "RETURN_ONLY"
          || step.childState !== "RETURN_STAGED" || step.transcriptId !== null
          || step.commandType !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RETURN_COMMAND_TYPE
          || !exactEmptyPayload(step.commandPayload)
          || step.commandTerminalStatus !== "SUCCEEDED" || step.acknowledgementStatus !== "SUCCEEDED"
          || !isExactUnboundInboxConversationSweepReturnAcknowledgement(step.acknowledgementResult)) {
        throw new TinderUnboundInboxConversationSweepError(
          "Unbound Inbox sweep return is unavailable.", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.STEP_NOT_STAGED, 409
        );
      }
      const sweep = currentSweepFromRow(await repository.getUnboundInboxConversationSweepForUpdate(transaction, step.sweepId));
      if (!sweep || sweep.deviceId !== step.deviceId || sweep.sweepState !== "ACTIVE"
          || sweep.activeCommandId !== step.commandId) {
        throw new TinderUnboundInboxConversationSweepError(
          "Unbound Inbox sweep is unavailable.", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.STEP_ALREADY_TERMINAL, 409
        );
      }
      if (step.expiresAt.valueOf() <= currentTime.valueOf() || sweep.expiresAt.valueOf() <= currentTime.valueOf()) {
        throw new TinderUnboundInboxConversationSweepError(
          "Unbound Inbox sweep return has expired.", TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_REASON.STEP_EXPIRED, 409
        );
      }
      if (!strictBoolean(await repository.acceptUnboundInboxConversationSweepReturnStep(transaction, {
        commandId: step.commandId, acceptedAt: currentTime.toISOString()
      }), "acceptUnboundInboxConversationSweepReturnStep")) {
        throw new TinderUnboundInboxConversationSweepError(
          "Unbound Inbox sweep return transition failed.", "UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSITION_FAILED", 500
        );
      }
      await repository.insertUnboundInboxConversationSweepAudit(transaction, auditRecord({
        auditId: newAuditId(), sweepId: sweep.sweepId, commandId: step.commandId, deviceId: step.deviceId,
        slotOrdinal: step.slotOrdinal, action: "RETURN_ACCEPTED", actor: "SIGNED_RETURN_INGRESS", source: "SIGNED_RETURN_INGRESS"
      }));
      if (step.slotOrdinal >= sweep.maxSlots) {
        if (!strictBoolean(await repository.completeUnboundInboxConversationSweep(transaction, {
          sweepId: sweep.sweepId, closedAt: currentTime.toISOString(), nextSlot: sweep.maxSlots + 1
        }), "completeUnboundInboxConversationSweep")) {
          throw new TinderUnboundInboxConversationSweepError(
            "Unbound Inbox sweep completion failed.", "UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSITION_FAILED", 500
          );
        }
        await repository.insertUnboundInboxConversationSweepAudit(transaction, auditRecord({
          auditId: newAuditId(), sweepId: sweep.sweepId, deviceId: step.deviceId,
          action: "SWEEP_COMPLETED", actor: "SERVER_AUTOMATION", source: "SERVER_AUTOMATION"
        }));
        return Object.freeze({ status: "COMPLETED" });
      }
      await issueChild(transaction, { sweep, childKind: "READ", slotOrdinal: step.slotOrdinal + 1, currentTime });
      return Object.freeze({ status: "READ_QUEUED" });
    });
  }

  async function getBoundedSweepStatus(input = {}) {
    const normalized = normalizeDeviceInput(input);
    return repository.withTransaction(async transaction => {
      if (assertFoundationReady) await assertFoundationReady(transaction);
      const currentTime = new Date(now());
      await expireForDevice(transaction, { deviceId: normalized.deviceId, currentTime });
      const sweep = currentSweepFromRow(await repository.getUnboundInboxConversationSweepForDeviceForUpdate(transaction, normalized.deviceId));
      if (!sweep) return Object.freeze({ status: "NOT_REQUESTED" });
      const status = ["ACTIVE", "COMPLETED", "STOPPED", "EXPIRED"].includes(sweep.sweepState)
        ? sweep.sweepState : "STOPPED";
      return Object.freeze({ status });
    });
  }

  return Object.freeze({
    startUnboundInboxConversationSweepFromFreshInboxObservation,
    expireUnboundInboxConversationSweepForHeartbeat,
    authorizeIncomingSweepTranscript,
    consumeAuthorizedSweepTranscript,
    projectSweepChildAcknowledgement,
    acceptSignedSweepReturnReceipt,
    getBoundedSweepStatus
  });
}

/** PostgreSQL adapter only; explicit V8 DDL owns all target relations. */
export function createPgTinderUnboundInboxConversationSweepRepository(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("pool.connect and pool.query must be functions");
  }
  const activeStepStates = "('ISSUED','STAGED','RETURN_STAGED')";

  function exactQueueInput(input) {
    if (!TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_COMMAND_TYPES.includes(input?.commandType)
        || !exactEmptyPayload(input?.payload)) {
      throw new TypeError("Unbound Inbox sweep child commands require an exact empty payload");
    }
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

    async getDeviceRuntimeForUpdate(client, deviceId, currentTime = new Date()) {
      const result = await client.query(
        `SELECT device_id, enrollment_state, revoked_at, last_heartbeat_sequence,
                last_accepted_heartbeat_at, bridge_service_state, tinder_state,
                automation_state, capabilities
           FROM device_bridge_devices
          WHERE device_id=$1
          FOR UPDATE`,
        [deviceId]
      );
      const row = result.rows[0] || null;
      if (!row || row.revoked_at) return null;
      return { ...row, online: deriveDeviceStatus(row.last_accepted_heartbeat_at, currentTime) === "ONLINE" };
    },

    async findPriorFreshReviewedInboxObservationForDevice(client, {
      deviceId, observationNonce, heartbeatSequence
    }) {
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1
           FROM device_bridge_audit_events e
          WHERE e.device_id=$1
            AND e.event_type='HEARTBEAT_ACCEPTED'
            AND e.details -> 'tinder_inbox_navigation' ->> 'observation_kind'='FRESH_REVIEWED_INBOX_V1'
            AND e.details -> 'tinder_inbox_navigation' ->> 'observation_nonce'=$2
            AND e.details ->> 'sequence' <> $3
         ) AS consumed`,
        [deviceId, observationNonce, String(heartbeatSequence)]
      );
      return result.rows[0]?.consumed === true;
    },

    async findUnboundInboxConversationSweepByObservationNonceForDevice(client, {
      deviceId, observationNonce
    }) {
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1
             FROM ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE}
            WHERE device_id=$1 AND inbox_observation_nonce=$2
         ) AS found`,
        [deviceId, observationNonce]
      );
      return result.rows[0]?.found === true;
    },

    async expireUnboundInboxConversationSweepForDevice(client, { deviceId, expiredAt }) {
      const result = await client.query(
        `WITH child_expired AS (
           UPDATE ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE} step
              SET child_state='EXPIRED', closed_at=$2, terminal_reason='CHILD_EXPIRED', updated_at=NOW()
             FROM ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE} sweep
            WHERE step.sweep_id=sweep.sweep_id
              AND sweep.device_id=$1 AND sweep.sweep_state='ACTIVE'
              AND sweep.expires_at>$2
              AND step.child_state IN ${activeStepStates} AND step.expires_at <= $2
           RETURNING step.sweep_id, step.command_id, step.slot_ordinal
        ), terminalized_child_commands AS (
           -- A step expiry is the authoritative V8 authority boundary.  The
           -- command row must become terminal in the same transaction so a
           -- late device EXPIRED acknowledgement cannot leave a nonterminal
           -- delivery candidate behind.
           UPDATE device_bridge_commands command
              SET terminal_status='EXPIRED', terminal_at=$2
             FROM child_expired expired
            WHERE command.command_id=expired.command_id
              AND command.device_id=$1
              AND command.terminal_status IS NULL
           RETURNING command.command_id
         ), child_stopped AS (
           UPDATE ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE} sweep
              SET sweep_state='STOPPED', active_command_id=NULL, closed_at=$2,
                  terminal_reason='CHILD_EXPIRED', updated_at=NOW()
             FROM child_expired expired
            WHERE sweep.sweep_id=expired.sweep_id
              AND sweep.sweep_state='ACTIVE'
           RETURNING sweep.sweep_id, sweep.device_id, sweep.sweep_state,
                     sweep.max_slots, sweep.next_slot, sweep.expires_at, sweep.active_command_id,
                     expired.command_id AS expired_command_id,
                     expired.slot_ordinal AS expired_slot_ordinal
         ), parent_expired AS (
           UPDATE ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE} sweep
              SET sweep_state='EXPIRED', active_command_id=NULL, closed_at=$2,
                  terminal_reason='SWEEP_EXPIRED', updated_at=NOW()
            WHERE sweep.device_id=$1 AND sweep.sweep_state='ACTIVE' AND sweep.expires_at <= $2
           RETURNING sweep.sweep_id, sweep.device_id, sweep.sweep_state,
                     sweep.max_slots, sweep.next_slot, sweep.expires_at, sweep.active_command_id,
                     NULL::uuid AS expired_command_id, NULL::smallint AS expired_slot_ordinal
         )
         SELECT * FROM child_stopped
         UNION ALL
         SELECT * FROM parent_expired`,
        [deviceId, expiredAt]
      );
      return result.rows;
    },

    async findActiveUnboundInboxConversationSweepForDevice(client, { deviceId, now: currentTime }) {
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE}
            WHERE device_id=$1 AND sweep_state='ACTIVE' AND expires_at>$2
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
             JOIN device_bridge_commands command ON command.command_id=permit.command_id
            WHERE permit.device_id=$1 AND permit.permit_state='ISSUED' AND permit.expires_at>$2
              AND command.command_type='ARM_TINDER_CONVERSATION_BINDING'
         ) AS active`,
        [deviceId, currentTime]
      );
      return result.rows[0]?.active === true;
    },

    async findActiveVisibleChatSyncPermitForDevice(client, { deviceId, now: currentTime }) {
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM tinder_visible_chat_sync_permits
            WHERE device_id=$1 AND permit_state IN ('ISSUED','STAGED') AND expires_at>$2
         ) AS active`,
        [deviceId, currentTime]
      );
      return result.rows[0]?.active === true;
    },

    async findActiveOfficialAppResumePermitForDevice(client, { deviceId, now: currentTime }) {
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM tinder_official_app_resume_permits
            WHERE device_id=$1 AND permit_state='ISSUED' AND expires_at>$2
         ) AS active`,
        [deviceId, currentTime]
      );
      return result.rows[0]?.active === true;
    },

    async findActiveLocalConversationAttestationForDevice(client, { deviceId, now: currentTime }) {
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM tinder_local_conversation_attestation_permits
            WHERE device_id=$1 AND permit_state IN ('ISSUED','STAGED','ATTESTED') AND expires_at>$2
         ) AS active`,
        [deviceId, currentTime]
      );
      return result.rows[0]?.active === true;
    },

    async queueUnboundInboxConversationSweepCommand(client, input) {
      exactQueueInput(input);
      const result = await client.query(
        `INSERT INTO device_bridge_commands
          (command_id, device_id, protocol_version, command_type, payload,
           configuration_revision, issued_at, expires_at)
         SELECT $1,d.device_id,1,$3,'{}'::jsonb,d.configuration_revision,NOW(),$4
           FROM device_bridge_devices d
          WHERE d.device_id=$2
         RETURNING command_id`,
        [input.commandId, input.deviceId, input.commandType, input.expiresAt]
      );
      if (result.rows.length !== 1 || result.rows[0]?.command_id !== input.commandId) {
        throw new TinderUnboundInboxConversationSweepError(
          "Unbound Inbox sweep child command could not be created.",
          "UNBOUND_INBOX_CONVERSATION_SWEEP_COMMAND_WRITE_FAILED", 500
        );
      }
    },

    async createUnboundInboxConversationSweep(client, input) {
      if (input.sweepContractVersion !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_CONTRACT_VERSION
          || input.maxSlots !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_MAX_SLOTS
          || !Number.isSafeInteger(input.inboxHeartbeatSequence) || input.inboxHeartbeatSequence <= 0
          || !uuid(input.inboxObservationNonce)) {
        throw new TypeError("Unbound Inbox sweep must use the exact initial contract");
      }
      const result = await client.query(
        `INSERT INTO ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE} (
           sweep_id, device_id, sweep_contract_version, inbox_heartbeat_sequence, inbox_observation_nonce,
           max_slots, next_slot, active_command_id, issued_at, expires_at, created_at, updated_at
         ) VALUES ($1,$2,1,$3,$4,8,1,$5,NOW(),$6,NOW(),NOW())
         RETURNING sweep_id`,
        [input.sweepId, input.deviceId, input.inboxHeartbeatSequence, input.inboxObservationNonce, input.activeCommandId, input.expiresAt]
      );
      if (result.rows.length !== 1 || result.rows[0]?.sweep_id !== input.sweepId) {
        throw new TinderUnboundInboxConversationSweepError(
          "Unbound Inbox sweep could not be created.", "UNBOUND_INBOX_CONVERSATION_SWEEP_WRITE_FAILED", 500
        );
      }
    },

    async createUnboundInboxConversationSweepStep(client, input) {
      const validKind = input?.childKind === "READ" || input?.childKind === "RETURN_ONLY";
      if (!validKind || input?.childState !== "ISSUED" || !Number.isSafeInteger(input?.slotOrdinal)
          || input.slotOrdinal < 1 || input.slotOrdinal > TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_MAX_SLOTS) {
        throw new TypeError("Unbound Inbox sweep step must use the exact initial contract");
      }
      const result = await client.query(
        `INSERT INTO ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE} (
           command_id, sweep_id, device_id, step_contract_version, slot_ordinal,
           child_kind, child_state, issued_at, expires_at, created_at, updated_at
         ) VALUES ($1,$2,$3,1,$4,$5,'ISSUED',NOW(),$6,NOW(),NOW())
         RETURNING command_id`,
        [input.commandId, input.sweepId, input.deviceId, input.slotOrdinal, input.childKind, input.expiresAt]
      );
      if (result.rows.length !== 1 || result.rows[0]?.command_id !== input.commandId) {
        throw new TinderUnboundInboxConversationSweepError(
          "Unbound Inbox sweep step could not be created.", "UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_WRITE_FAILED", 500
        );
      }
    },

    async setUnboundInboxConversationSweepActiveStep(client, { sweepId, commandId, nextSlot }) {
      const result = await client.query(
        `UPDATE ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE}
            SET active_command_id=$2, next_slot=$3, updated_at=NOW()
          WHERE sweep_id=$1 AND sweep_state='ACTIVE'
          RETURNING sweep_id`,
        [sweepId, commandId, nextSlot]
      );
      if (result.rows.length !== 1 || result.rows[0]?.sweep_id !== sweepId) {
        throw new TinderUnboundInboxConversationSweepError(
          "Unbound Inbox sweep active child could not be updated.", "UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE_STEP_WRITE_FAILED", 500
        );
      }
    },

    async getUnboundInboxConversationSweepForUpdate(client, sweepId) {
      const result = await client.query(
        `SELECT sweep_id, device_id, sweep_state, max_slots, next_slot,
                active_command_id, expires_at
           FROM ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE}
          WHERE sweep_id=$1
          FOR UPDATE`,
        [sweepId]
      );
      return result.rows[0] || null;
    },

    async getUnboundInboxConversationSweepForDeviceForUpdate(client, deviceId) {
      const result = await client.query(
        `SELECT sweep_id, device_id, sweep_state, max_slots, next_slot,
                active_command_id, expires_at
           FROM ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE}
          WHERE device_id=$1
          ORDER BY issued_at DESC, sweep_id DESC
          LIMIT 1
          FOR UPDATE`,
        [deviceId]
      );
      return result.rows[0] || null;
    },

    async getUnboundInboxConversationSweepStepForUpdate(client, commandId) {
      const result = await client.query(
        `SELECT step.command_id, step.sweep_id, step.device_id, step.slot_ordinal,
                step.child_kind, step.child_state, step.transcript_id, step.expires_at,
                command.command_type, command.payload AS command_payload,
                command.terminal_status AS terminal_status,
                ack.status AS ack_status, ack.result AS ack_result
           FROM ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE} step
           JOIN device_bridge_commands command ON command.command_id=step.command_id
      LEFT JOIN LATERAL (
             SELECT status, result
               FROM device_bridge_command_acks
              WHERE command_id=step.command_id AND status='SUCCEEDED'
              ORDER BY accepted_at DESC, ack_id DESC
              LIMIT 1
           ) ack ON TRUE
          WHERE step.command_id=$1
          FOR UPDATE OF step, command`,
        [commandId]
      );
      return result.rows[0] || null;
    },

    async stageUnboundInboxConversationSweepReadStep(client, { commandId, stagedAt }) {
      const result = await client.query(
        `UPDATE ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE}
            SET child_state='STAGED', staged_at=$2, updated_at=NOW()
          WHERE command_id=$1 AND child_kind='READ' AND child_state='ISSUED'
          RETURNING command_id`,
        [commandId, stagedAt]
      );
      return result.rows.length === 1 && result.rows[0]?.command_id === commandId;
    },

    async stageUnboundInboxConversationSweepReturnStep(client, { commandId, stagedAt }) {
      const result = await client.query(
        `UPDATE ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE}
            SET child_state='RETURN_STAGED', staged_at=$2, updated_at=NOW()
          WHERE command_id=$1 AND child_kind='RETURN_ONLY' AND child_state='ISSUED'
          RETURNING command_id`,
        [commandId, stagedAt]
      );
      return result.rows.length === 1 && result.rows[0]?.command_id === commandId;
    },

    async acceptUnboundInboxConversationSweepReadStep(client, { commandId, transcriptId, acceptedAt }) {
      const result = await client.query(
        `UPDATE ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE}
            SET child_state='TRANSCRIPT_ACCEPTED', transcript_id=$2,
                accepted_at=$3, closed_at=$3, terminal_reason='TRANSCRIPT_ACCEPTED', updated_at=NOW()
          WHERE command_id=$1 AND child_kind='READ' AND child_state='STAGED'
            AND transcript_id IS NULL AND expires_at>$3
          RETURNING command_id`,
        [commandId, transcriptId, acceptedAt]
      );
      return result.rows.length === 1 && result.rows[0]?.command_id === commandId;
    },

    async acceptUnboundInboxConversationSweepReturnStep(client, { commandId, acceptedAt }) {
      const result = await client.query(
        `UPDATE ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE}
            SET child_state='RETURN_ACCEPTED', accepted_at=$2, closed_at=$2,
                terminal_reason='RETURNED', updated_at=NOW()
          WHERE command_id=$1 AND child_kind='RETURN_ONLY' AND child_state='RETURN_STAGED'
            AND expires_at>$2
          RETURNING command_id`,
        [commandId, acceptedAt]
      );
      return result.rows.length === 1 && result.rows[0]?.command_id === commandId;
    },

    async cancelUnboundInboxConversationSweepStepAndStop(client, {
      commandId, sweepId, closedAt, childState, reasonCode
    }) {
      const step = await client.query(
        `UPDATE ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE}
            SET child_state=$3, closed_at=$4, terminal_reason=$5, updated_at=NOW()
          WHERE command_id=$1 AND sweep_id=$2 AND child_state IN ${activeStepStates}
          RETURNING command_id`,
        [commandId, sweepId, childState, closedAt, reasonCode]
      );
      if (step.rows.length !== 1 || step.rows[0]?.command_id !== commandId) return false;
      const sweep = await client.query(
        `UPDATE ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE}
            SET sweep_state='STOPPED', active_command_id=NULL, closed_at=$3,
                terminal_reason=$4, updated_at=NOW()
          WHERE sweep_id=$1 AND active_command_id=$2 AND sweep_state='ACTIVE'
          RETURNING sweep_id`,
        [sweepId, commandId, closedAt, reasonCode]
      );
      return sweep.rows.length === 1 && sweep.rows[0]?.sweep_id === sweepId;
    },

    async completeUnboundInboxConversationSweep(client, { sweepId, closedAt, nextSlot }) {
      const result = await client.query(
        `UPDATE ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE}
            SET sweep_state='COMPLETED', active_command_id=NULL, next_slot=$3,
                closed_at=$2, terminal_reason='SLOTS_EXHAUSTED', updated_at=NOW()
          WHERE sweep_id=$1 AND sweep_state='ACTIVE'
          RETURNING sweep_id`,
        [sweepId, closedAt, nextSlot]
      );
      return result.rows.length === 1 && result.rows[0]?.sweep_id === sweepId;
    },

    async insertUnboundInboxConversationSweepAudit(client, audit) {
      if (!exactEmptyPayload(audit?.details)) {
        throw new TypeError("Unbound Inbox sweep audit details must be empty");
      }
      const result = await client.query(
        `INSERT INTO ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE} (
           audit_id, sweep_id, command_id, device_id, slot_ordinal, transcript_id,
           action, reason_code, actor, source, details
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}'::jsonb)
         RETURNING audit_id`,
        [audit.auditId, audit.sweepId, audit.commandId, audit.deviceId, audit.slotOrdinal,
          audit.transcriptId, audit.action, audit.reasonCode, audit.actor, audit.source]
      );
      if (result.rows.length !== 1 || result.rows[0]?.audit_id !== audit.auditId) {
        throw new TinderUnboundInboxConversationSweepError(
          "Unbound Inbox sweep audit could not be written.", "UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_WRITE_FAILED", 500
        );
      }
    },

    async insertUnboundInboxConversationSweepTranscript(client, input) {
      if (input?.transcriptContractVersion !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_CONTRACT_VERSION
          || input?.schemaVersion !== "tinder-unbound-inbox-conversation-sweep-transcript-v1"
          || input?.sourcePackage !== "com.tinder"
          || input?.layoutSchemaVersion !== "tinder-zte-visible-chat-scroll-v1"
          || input?.safetyStatus !== "SAFE"
          || !Array.isArray(input?.messages)) {
        throw new TypeError("Unbound Inbox sweep transcript must use the exact V8 contract");
      }
      const result = await client.query(
        `INSERT INTO ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE} (
           transcript_id, command_id, sweep_id, device_id, transcript_contract_version,
           transcript_schema_version, source_package, layout_schema_version,
           sync_started_at, sync_completed_at, initial_visible_node_count,
           final_visible_node_count, segment_count, overlap_count, transcript_fingerprint,
           visible_messages, transcript_safety_status, mapping_status,
           human_review_status, received_at, created_at
         ) SELECT
           $1,$2,step.sweep_id,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,
           'SAFE','NEEDS_HUMAN_MAPPING','PENDING',$15,NOW()
           FROM ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE} step
          WHERE step.command_id=$2 AND step.device_id=$3
         RETURNING transcript_id, mapping_status, human_review_status`,
        [
          input.transcriptId, input.commandId, input.deviceId,
          input.schemaVersion, input.sourcePackage, input.layoutSchemaVersion,
          input.syncStartedAt, input.syncCompletedAt, input.initialVisibleNodeCount,
          input.finalVisibleNodeCount, input.segmentCount, input.overlapCount,
          input.transcriptFingerprint,
          JSON.stringify(input.messages.map(message => ({
            visible_order: message.visibleOrder, direction: message.direction, text: message.text
          }))),
          input.receivedAt
        ]
      );
      const stored = result.rows[0] || null;
      if (result.rows.length !== 1 || stored?.transcript_id !== input.transcriptId
          || stored.mapping_status !== "NEEDS_HUMAN_MAPPING" || stored.human_review_status !== "PENDING") {
        throw new TinderUnboundInboxConversationSweepError(
          "Unbound Inbox sweep transcript could not be stored.",
          "UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_WRITE_FAILED", 500
        );
      }
      return stored;
    },

    /**
     * Authenticated dashboard projection only.  The result deliberately
     * omits every correlation/identity/audit field: no transcript, sweep,
     * child, command, contact, binding, source-capture, or fingerprint ID
     * crosses this repository boundary.  The caller receives at most the
     * fixed parent capacity, in chronological order, for one device.
     */
    async listPendingUnboundInboxConversationSweepTranscripts({ deviceId }) {
      const normalizedDeviceId = normalizeUuid(
        deviceId, "Device identifier", "INVALID_DEVICE_ID"
      );
      const result = await pool.query(
        `SELECT received_at, mapping_status, human_review_status, visible_messages
           FROM (
             SELECT transcript_id, received_at, mapping_status, human_review_status, visible_messages
               FROM ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE}
              WHERE device_id=$1
                AND mapping_status='NEEDS_HUMAN_MAPPING'
                AND human_review_status='PENDING'
              ORDER BY received_at DESC, transcript_id DESC
              LIMIT $2
           ) pending_transcripts
          ORDER BY received_at ASC, transcript_id ASC`,
        [normalizedDeviceId, TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_MAX_SLOTS]
      );
      return result.rows;
    }
  });
}
