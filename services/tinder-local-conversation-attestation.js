import crypto from "node:crypto";
import { deriveDeviceStatus } from "../device-bridge/heartbeat.js";
import {
  isTinderLocalConversationAttestationCapable
} from "../device-bridge/protocol-v1.js";
import {
  HUMAN_ARMED_CONVERSATION_BINDING_TABLE,
  HUMAN_ARMED_CONVERSATION_PERMIT_TABLE,
  HUMAN_ARMED_CONVERSATION_REFERENCE_KIND
} from "./tinder-human-armed-conversation-binding.js";

/* ==================================================
TINDER LOCAL CONVERSATION ATTESTATION

This is a narrow, human-bootstrapped continuity contract.  A bootstrap
command is bound to an existing confirmed binding revision, but it carries no
Tinder/platform identifier.  Android may attest only after its independent
local row-selection and Conversation-screen gates have passed.  A later V4
reader can use the resulting opaque handle only for that exact binding
revision; it never turns the handle into a Tinder identity.
================================================== */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE =
  "STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION";
export const TINDER_LOCAL_CONVERSATION_ATTESTATION_CAPABILITY =
  "TINDER_LOCAL_CONVERSATION_ATTESTATION_V1";
export const TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE =
  "tinder_local_conversation_attestation_permits";
export const TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE =
  "tinder_local_conversation_attestation_audit";
export const TINDER_LOCAL_CONVERSATION_ATTESTATION_TTL_MS = 10 * 60_000;
export const TINDER_LOCAL_CONVERSATION_ATTESTATION_CONTRACT_VERSION = 1;

// The bootstrap command's ID is the opaque local attestation handle.  The
// binding itself never crosses the command channel.
export const TINDER_LOCAL_CONVERSATION_ATTESTATION_BOOTSTRAP_PAYLOAD_FIELD =
  "binding_revision";
export const TINDER_LOCAL_CONVERSATION_ATTESTATION_V4_PAYLOAD_FIELD =
  "local_conversation_attestation";

export const TINDER_LOCAL_CONVERSATION_ATTESTATION_ACK_RESULT = Object.freeze({
  local_conversation_attestation: "STAGED"
});
export const TINDER_LOCAL_CONVERSATION_ATTESTATION_INGRESS_STATUS = "ATTESTED";

export const TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS = Object.freeze({
  QUEUED: "QUEUED",
  ATTESTED: "ATTESTED",
  INVALIDATED: "INVALIDATED",
  DEVICE_NOT_READY: "DEVICE_NOT_READY",
  PERMIT_CONFLICT: "PERMIT_CONFLICT",
  PERMIT_NOT_AVAILABLE: "PERMIT_NOT_AVAILABLE"
});

export const TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON = Object.freeze({
  DEVICE_OFFLINE: "DEVICE_OFFLINE",
  DEVICE_ENROLLMENT_INACTIVE: "DEVICE_ENROLLMENT_INACTIVE",
  BRIDGE_NOT_RUNNING: "BRIDGE_NOT_RUNNING",
  TINDER_NOT_CONNECTED: "TINDER_NOT_CONNECTED",
  AUTOMATION_NOT_STOPPED: "AUTOMATION_NOT_STOPPED",
  DEVICE_CAPABILITY_UNSUPPORTED: "DEVICE_CAPABILITY_UNSUPPORTED",
  HUMAN_ARMED_PERMIT_ACTIVE: "HUMAN_ARMED_PERMIT_ACTIVE",
  VISIBLE_CHAT_SYNC_PERMIT_ACTIVE: "VISIBLE_CHAT_SYNC_PERMIT_ACTIVE",
  OFFICIAL_APP_RESUME_PERMIT_ACTIVE: "OFFICIAL_APP_RESUME_PERMIT_ACTIVE",
  ATTESTATION_ACTIVE: "ATTESTATION_ACTIVE",
  LOCAL_CONVERSATION_ATTESTATION_DEVICE_BUSY: "LOCAL_CONVERSATION_ATTESTATION_DEVICE_BUSY",
  BINDING_NOT_FOUND: "BINDING_NOT_FOUND",
  BINDING_NOT_CONFIRMED: "BINDING_NOT_CONFIRMED",
  BINDING_NOT_HUMAN_VERIFIED: "BINDING_NOT_HUMAN_VERIFIED",
  BINDING_DEVICE_INVALID: "BINDING_DEVICE_INVALID",
  BINDING_REVISION_CHANGED: "BINDING_REVISION_CHANGED",
  PERMIT_NOT_FOUND: "PERMIT_NOT_FOUND",
  PERMIT_NOT_STAGED: "PERMIT_NOT_STAGED",
  PERMIT_EXPIRED: "PERMIT_EXPIRED",
  PERMIT_ACK_NOT_STAGED: "PERMIT_ACK_NOT_STAGED",
  PERMIT_DEVICE_MISMATCH: "PERMIT_DEVICE_MISMATCH",
  PERMIT_BINDING_MISMATCH: "PERMIT_BINDING_MISMATCH",
  READER_QUEUE_NOT_AVAILABLE: "READER_QUEUE_NOT_AVAILABLE",
  INVALIDATION_NOT_ALLOWED: "INVALIDATION_NOT_ALLOWED"
});

export const TINDER_LOCAL_CONVERSATION_ATTESTATION_INVALIDATION_REASON = Object.freeze([
  "BINDING_REVISION_CHANGED",
  "CONVERSATION_CHANGED",
  "CONTINUITY_UNPROVEN",
  "LOCAL_STATE_DESTROYED",
  "AUTH_OR_REVIEW",
  "IDENTITY_CONFLICT",
  "HUMAN_REBIND"
]);

const ATTESTATION_AUDIT_ACTOR = Object.freeze({
  DASHBOARD_HUMAN: "DASHBOARD_HUMAN",
  ANDROID_RUNTIME: "ANDROID_RUNTIME",
  SERVER_EXPIRY: "SERVER_EXPIRY",
  SERVER_VALIDATION: "SERVER_VALIDATION"
});

const ATTESTATION_AUDIT_SOURCE = Object.freeze({
  MANUAL_DASHBOARD: "MANUAL_DASHBOARD",
  SIGNED_DEVICE_INGRESS: "SIGNED_DEVICE_INGRESS",
  SERVER_MAINTENANCE: "SERVER_MAINTENANCE"
});

export class TinderLocalConversationAttestationError extends Error {
  constructor(message, code = "INVALID_TINDER_LOCAL_CONVERSATION_ATTESTATION", statusCode = 400) {
    super(message);
    this.name = "TinderLocalConversationAttestationError";
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
  if (!normalized) throw new TinderLocalConversationAttestationError(`${field} is invalid.`, code);
  return normalized;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeActor(value) {
  const actor = String(value || "").trim();
  if (actor !== ATTESTATION_AUDIT_ACTOR.DASHBOARD_HUMAN) {
    throw new TinderLocalConversationAttestationError("Attestation actor is invalid.", "INVALID_ATTESTATION_ACTOR");
  }
  return actor;
}

function normalizeBootstrapInput(value) {
  if (!exactKeys(value, ["bindingId", "confirmed", "actor"]) || value.confirmed !== true) {
    throw new TinderLocalConversationAttestationError(
      "Human confirmation is required for local conversation attestation.",
      "HUMAN_CONFIRMATION_REQUIRED"
    );
  }
  return Object.freeze({
    bindingId: normalizeUuid(value.bindingId, "Binding identifier", "INVALID_HUMAN_BINDING_ID"),
    actor: normalizeActor(value.actor)
  });
}

function normalizeConfirmationInput(value) {
  if (!exactKeys(value, ["commandId", "deviceId", "status"])
      || value.status !== TINDER_LOCAL_CONVERSATION_ATTESTATION_INGRESS_STATUS) {
    throw new TinderLocalConversationAttestationError(
      "Local conversation attestation confirmation is invalid.",
      "INVALID_LOCAL_CONVERSATION_ATTESTATION_CONFIRMATION"
    );
  }
  return Object.freeze({
    commandId: normalizeUuid(value.commandId, "Attestation command identifier", "INVALID_ATTESTATION_COMMAND_ID"),
    deviceId: normalizeUuid(value.deviceId, "Device identifier", "INVALID_DEVICE_ID")
  });
}

function normalizeInvalidationInput(value) {
  if (!exactKeys(value, ["commandId", "deviceId", "reasonCode"])) {
    throw new TinderLocalConversationAttestationError(
      "Local conversation attestation invalidation is invalid.",
      "INVALID_LOCAL_CONVERSATION_ATTESTATION_INVALIDATION"
    );
  }
  const reasonCode = String(value.reasonCode || "").trim().toUpperCase();
  if (!TINDER_LOCAL_CONVERSATION_ATTESTATION_INVALIDATION_REASON.includes(reasonCode)) {
    throw new TinderLocalConversationAttestationError(
      "Local conversation attestation invalidation reason is invalid.",
      "INVALID_LOCAL_CONVERSATION_ATTESTATION_INVALIDATION"
    );
  }
  return Object.freeze({
    commandId: normalizeUuid(value.commandId, "Attestation command identifier", "INVALID_ATTESTATION_COMMAND_ID"),
    deviceId: normalizeUuid(value.deviceId, "Device identifier", "INVALID_DEVICE_ID"),
    reasonCode
  });
}

function runtimeGateResult(row) {
  const runtime = plainObject(row) ? row : null;
  if (!runtime || sourceValue(runtime, "online", "online") !== true) {
    return Object.freeze({
      status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.DEVICE_OFFLINE
    });
  }
  if (normalizedStatus(sourceValue(runtime, "enrollmentState", "enrollment_state")) !== "ACTIVE") {
    return Object.freeze({
      status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.DEVICE_ENROLLMENT_INACTIVE
    });
  }
  if (normalizedStatus(sourceValue(runtime, "bridgeServiceState", "bridge_service_state")) !== "RUNNING") {
    return Object.freeze({
      status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.BRIDGE_NOT_RUNNING
    });
  }
  if (normalizedStatus(sourceValue(runtime, "tinderState", "tinder_state")) !== "CONNECTED") {
    return Object.freeze({
      status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.TINDER_NOT_CONNECTED
    });
  }
  if (normalizedStatus(sourceValue(runtime, "automationState", "automation_state")) !== "STOPPED") {
    return Object.freeze({
      status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.AUTOMATION_NOT_STOPPED
    });
  }
  if (!isTinderLocalConversationAttestationCapable(sourceValue(runtime, "capabilities", "capabilities"))) {
    return Object.freeze({
      status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.DEVICE_NOT_READY,
      reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.DEVICE_CAPABILITY_UNSUPPORTED
    });
  }
  return null;
}

function bindingFromRow(row) {
  const bindingId = uuid(sourceValue(row, "bindingId", "binding_id"));
  const deviceId = uuid(sourceValue(row, "deviceId", "device_id"));
  const bindingRevision = positiveInteger(sourceValue(row, "bindingRevision", "binding_revision"));
  if (!bindingId || !deviceId || !bindingRevision) return null;
  return Object.freeze({
    bindingId,
    deviceId,
    bindingRevision,
    bindingState: normalizedStatus(sourceValue(row, "bindingState", "binding_state")),
    humanVerified: sourceValue(row, "humanVerified", "human_verified") === true,
    channel: String(sourceValue(row, "channel", "channel") || "").trim(),
    referenceKind: String(sourceValue(row, "referenceKind", "reference_kind") || "").trim()
  });
}

function bindingStateResult(binding) {
  if (!binding) {
    return Object.freeze({
      status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.BINDING_NOT_FOUND
    });
  }
  if (binding.channel !== "tinder" || binding.referenceKind !== HUMAN_ARMED_CONVERSATION_REFERENCE_KIND
      || binding.bindingState !== "CONFIRMED") {
    return Object.freeze({
      status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.BINDING_NOT_CONFIRMED
    });
  }
  if (binding.humanVerified !== true) {
    return Object.freeze({
      status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.BINDING_NOT_HUMAN_VERIFIED
    });
  }
  return null;
}

function attestationPermitFromRow(row) {
  const commandId = uuid(sourceValue(row, "commandId", "command_id"));
  const bindingId = uuid(sourceValue(row, "bindingId", "binding_id"));
  const deviceId = uuid(sourceValue(row, "deviceId", "device_id"));
  const bindingRevision = positiveInteger(
    sourceValue(row, "permitBindingRevision", "permit_binding_revision")
      ?? sourceValue(row, "bindingRevision", "binding_revision")
  );
  const expiresAt = new Date(sourceValue(row, "expiresAt", "expires_at"));
  if (!commandId || !bindingId || !deviceId || !bindingRevision || Number.isNaN(expiresAt.valueOf())) return null;
  const commandType = String(sourceValue(row, "commandType", "command_type") || "").trim();
  if (commandType && commandType !== TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE) return null;
  return Object.freeze({
    commandId,
    bindingId,
    deviceId,
    bindingRevision,
    permitState: normalizedStatus(sourceValue(row, "permitState", "permit_state") ?? sourceValue(row, "state", "state")),
    permitContractVersion: positiveInteger(sourceValue(row, "permitContractVersion", "permit_contract_version")),
    expiresAt,
    commandTerminalStatus: normalizedStatus(sourceValue(row, "commandTerminalStatus", "terminal_status")),
    acknowledgementStatus: normalizedStatus(sourceValue(row, "acknowledgementStatus", "ack_status")),
    acknowledgementResult: sourceValue(row, "acknowledgementResult", "ack_result"),
    binding: bindingFromRow({
      bindingId,
      deviceId: sourceValue(row, "bindingDeviceId", "binding_device_id"),
      bindingRevision: sourceValue(row, "currentBindingRevision", "current_binding_revision"),
      bindingState: sourceValue(row, "bindingState", "binding_state"),
      humanVerified: sourceValue(row, "humanVerified", "human_verified"),
      channel: sourceValue(row, "channel", "channel"),
      referenceKind: sourceValue(row, "referenceKind", "reference_kind")
    })
  });
}

function exactBootstrapPayload(value, revision) {
  return exactKeys(value, [TINDER_LOCAL_CONVERSATION_ATTESTATION_BOOTSTRAP_PAYLOAD_FIELD])
    && value.binding_revision === String(revision);
}

export function isExactLocalConversationAttestationStagedAcknowledgement(value) {
  return exactKeys(value, Object.keys(TINDER_LOCAL_CONVERSATION_ATTESTATION_ACK_RESULT))
    && value.local_conversation_attestation
      === TINDER_LOCAL_CONVERSATION_ATTESTATION_ACK_RESULT.local_conversation_attestation;
}

function stagedPermitResult(permit, currentTime) {
  if (!permit) {
    return Object.freeze({
      status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.PERMIT_NOT_FOUND
    });
  }
  if (permit.permitState === "EXPIRED" || permit.expiresAt.valueOf() <= currentTime.valueOf()) {
    return Object.freeze({
      status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.PERMIT_EXPIRED
    });
  }
  if (permit.permitContractVersion !== TINDER_LOCAL_CONVERSATION_ATTESTATION_CONTRACT_VERSION) {
    return Object.freeze({
      status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.PERMIT_NOT_FOUND
    });
  }
  if (permit.permitState !== "STAGED") {
    return Object.freeze({
      status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.PERMIT_NOT_STAGED
    });
  }
  if (permit.commandTerminalStatus !== "SUCCEEDED"
      || permit.acknowledgementStatus !== "SUCCEEDED"
      || !isExactLocalConversationAttestationStagedAcknowledgement(permit.acknowledgementResult)) {
    return Object.freeze({
      status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.PERMIT_ACK_NOT_STAGED
    });
  }
  return null;
}

function auditRecord({ auditId, commandId, bindingId, bindingRevision, deviceId, action, actor,
  source, reasonCode = null }) {
  return Object.freeze({
    auditId: normalizeUuid(auditId, "Attestation audit identifier", "INVALID_ATTESTATION_AUDIT_ID"),
    commandId,
    bindingId,
    bindingRevision,
    deviceId,
    action,
    actor,
    source,
    reasonCode,
    // Keep the bounded audit body intentionally empty.  The schema prohibits
    // raw Tinder/UI/capture/fingerprint/identifier material independently.
    details: Object.freeze({})
  });
}

function strictBoolean(value, method) {
  if (value !== true && value !== false) {
    throw new TinderLocalConversationAttestationError(
      `${method} returned an invalid result.`,
      "INVALID_LOCAL_CONVERSATION_ATTESTATION_REPOSITORY",
      500
    );
  }
  return value;
}

function requireRepository(repository) {
  for (const method of [
    "withTransaction",
    "getDeviceRuntimeForUpdate",
    "expireLocalConversationAttestationPermits",
    "findActiveHumanArmedPermitForDevice",
    "findActiveVisibleChatSyncPermitForDevice",
    "findActiveOfficialAppResumePermitForDevice",
    "lookupHumanBindingDeviceId",
    "getConfirmedHumanBindingForUpdate",
    "findActiveLocalConversationAttestationForDeviceForUpdate",
    "queueLocalConversationAttestationCommand",
    "createLocalConversationAttestationPermit",
    "getLocalConversationAttestationPermitForUpdate",
    "markLocalConversationAttestationAttested",
    "markLocalConversationAttestationInvalidated",
    "cancelDependentVisibleChatSyncPermits",
    "insertLocalConversationAttestationAudit"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
}

export function createTinderLocalConversationAttestationService(repository, {
  createCommandId = () => crypto.randomUUID(),
  createAuditId = () => crypto.randomUUID(),
  now = () => new Date(),
  bootstrapTtlMs = TINDER_LOCAL_CONVERSATION_ATTESTATION_TTL_MS,
  queueReaderAfterAttestation = null
} = {}) {
  requireRepository(repository);
  if (!Number.isSafeInteger(bootstrapTtlMs) || bootstrapTtlMs < 30_000 || bootstrapTtlMs > 15 * 60_000) {
    throw new TypeError("bootstrapTtlMs must be a safe bounded duration");
  }
  if (queueReaderAfterAttestation !== null && typeof queueReaderAfterAttestation !== "function") {
    throw new TypeError("queueReaderAfterAttestation must be a function or null");
  }

  function newCommandId() {
    return normalizeUuid(createCommandId(), "Attestation command identifier", "INVALID_ATTESTATION_COMMAND_ID");
  }

  function newAuditId() {
    return normalizeUuid(createAuditId(), "Attestation audit identifier", "INVALID_ATTESTATION_AUDIT_ID");
  }

  async function expireForDevice(transaction, { deviceId, currentTime }) {
    const expired = await repository.expireLocalConversationAttestationPermits(transaction, {
      deviceId,
      expiredAt: currentTime.toISOString()
    });
    if (!Array.isArray(expired)) {
      throw new TinderLocalConversationAttestationError(
        "Local conversation attestation expiry returned an invalid result.",
        "INVALID_LOCAL_CONVERSATION_ATTESTATION_REPOSITORY",
        500
      );
    }
    for (const row of expired) {
      const commandId = uuid(sourceValue(row, "commandId", "command_id"));
      const bindingId = uuid(sourceValue(row, "bindingId", "binding_id"));
      const device = uuid(sourceValue(row, "deviceId", "device_id"));
      const bindingRevision = positiveInteger(sourceValue(row, "bindingRevision", "binding_revision"));
      if (!commandId || !bindingId || !device || !bindingRevision || device !== deviceId) {
        throw new TinderLocalConversationAttestationError(
          "Local conversation attestation expiry returned invalid data.",
          "INVALID_LOCAL_CONVERSATION_ATTESTATION_REPOSITORY",
          500
        );
      }
      await cancelDependentReaderPermits(transaction, commandId, currentTime.toISOString());
      await repository.insertLocalConversationAttestationAudit(transaction, auditRecord({
        auditId: newAuditId(),
        commandId,
        bindingId,
        bindingRevision,
        deviceId: device,
        action: "EXPIRED",
        actor: ATTESTATION_AUDIT_ACTOR.SERVER_EXPIRY,
        source: ATTESTATION_AUDIT_SOURCE.SERVER_MAINTENANCE,
        reasonCode: "PERMIT_EXPIRED"
      }));
    }
  }

  async function invalidateStagedPermit(transaction, permit, reasonCode, invalidatedAt) {
    const invalidated = await repository.markLocalConversationAttestationInvalidated(transaction, {
      commandId: permit.commandId,
      deviceId: permit.deviceId,
      invalidatedAt,
      reasonCode
    });
    if (invalidated !== true) {
      throw new TinderLocalConversationAttestationError(
        "Local conversation attestation permit could not be invalidated.",
        "LOCAL_CONVERSATION_ATTESTATION_INVALIDATION_FAILED",
        500
      );
    }
    await cancelDependentReaderPermits(transaction, permit.commandId, invalidatedAt);
    await repository.insertLocalConversationAttestationAudit(transaction, auditRecord({
      auditId: newAuditId(),
      commandId: permit.commandId,
      bindingId: permit.bindingId,
      bindingRevision: permit.bindingRevision,
      deviceId: permit.deviceId,
      action: "INVALIDATED",
      actor: ATTESTATION_AUDIT_ACTOR.SERVER_VALIDATION,
      source: ATTESTATION_AUDIT_SOURCE.SERVER_MAINTENANCE,
      reasonCode
    }));
  }

  async function cancelDependentReaderPermits(transaction, attestationCommandId, closedAt) {
    const cancelled = await repository.cancelDependentVisibleChatSyncPermits(transaction, {
      attestationCommandId,
      closedAt
    });
    if (!Array.isArray(cancelled)) {
      throw new TinderLocalConversationAttestationError(
        "Dependent visible-chat sync cancellation returned an invalid result.",
        "INVALID_LOCAL_CONVERSATION_ATTESTATION_REPOSITORY",
        500
      );
    }
  }

  async function queueBootstrap(input = {}) {
    const normalized = normalizeBootstrapInput(input);
    const queue = async transaction => {
      const currentTime = new Date(now());
      if (Number.isNaN(currentTime.valueOf())) {
        throw new TinderLocalConversationAttestationError(
          "Local conversation attestation time is invalid.",
          "INVALID_LOCAL_CONVERSATION_ATTESTATION_TIME",
          500
        );
      }
      // Lock ordering is deliberately device -> binding -> attestation.  The
      // first lookup merely discovers the immutable device relation; the
      // locked binding is re-read and compared below before it can authorize
      // a command.  This prevents the bootstrap from inverting the same
      // order used by signed ingress and V4 issuance.
      const preliminaryDeviceId = uuid(
        await repository.lookupHumanBindingDeviceId(transaction, normalized.bindingId)
      );
      if (!preliminaryDeviceId) {
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.BINDING_NOT_FOUND
        });
      }
      const runtimeResult = runtimeGateResult(
        await repository.getDeviceRuntimeForUpdate(transaction, preliminaryDeviceId)
      );
      if (runtimeResult) return runtimeResult;
      const binding = bindingFromRow(
        await repository.getConfirmedHumanBindingForUpdate(transaction, normalized.bindingId)
      );
      const bindingResult = bindingStateResult(binding);
      if (bindingResult) return bindingResult;
      if (binding.deviceId !== preliminaryDeviceId) {
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.BINDING_DEVICE_INVALID
        });
      }

      await expireForDevice(transaction, { deviceId: binding.deviceId, currentTime });
      if (strictBoolean(await repository.findActiveHumanArmedPermitForDevice(transaction, {
        deviceId: binding.deviceId,
        now: currentTime.toISOString()
      }), "findActiveHumanArmedPermitForDevice")) {
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_CONFLICT,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.HUMAN_ARMED_PERMIT_ACTIVE
        });
      }
      if (strictBoolean(await repository.findActiveVisibleChatSyncPermitForDevice(transaction, {
        deviceId: binding.deviceId,
        now: currentTime.toISOString()
      }), "findActiveVisibleChatSyncPermitForDevice")) {
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_CONFLICT,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.VISIBLE_CHAT_SYNC_PERMIT_ACTIVE
        });
      }
      if (strictBoolean(await repository.findActiveOfficialAppResumePermitForDevice(transaction, {
        deviceId: binding.deviceId,
        now: currentTime.toISOString()
      }), "findActiveOfficialAppResumePermitForDevice")) {
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_CONFLICT,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.OFFICIAL_APP_RESUME_PERMIT_ACTIVE
        });
      }
      const active = await repository.findActiveLocalConversationAttestationForDeviceForUpdate(transaction, {
        deviceId: binding.deviceId
      });
      if (active !== null && active !== undefined) {
        // Android deliberately has one current local Conversation proof per
        // device.  It must never be asked to distinguish two simultaneous
        // opaque bootstrap commands without a local target identifier.
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_CONFLICT,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.LOCAL_CONVERSATION_ATTESTATION_DEVICE_BUSY
        });
      }

      const commandId = newCommandId();
      const expiresAt = new Date(currentTime.valueOf() + bootstrapTtlMs).toISOString();
      const payload = Object.freeze({ binding_revision: String(binding.bindingRevision) });
      if (!exactBootstrapPayload(payload, binding.bindingRevision)) {
        throw new TinderLocalConversationAttestationError(
          "Local conversation attestation command payload is invalid.",
          "INVALID_LOCAL_CONVERSATION_ATTESTATION_COMMAND",
          500
        );
      }
      await repository.queueLocalConversationAttestationCommand(transaction, {
        commandId,
        deviceId: binding.deviceId,
        commandType: TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE,
        payload,
        expiresAt
      });
      await repository.createLocalConversationAttestationPermit(transaction, {
        commandId,
        bindingId: binding.bindingId,
        bindingRevision: binding.bindingRevision,
        deviceId: binding.deviceId,
        expiresAt
      });
      await repository.insertLocalConversationAttestationAudit(transaction, auditRecord({
        auditId: newAuditId(),
        commandId,
        bindingId: binding.bindingId,
        bindingRevision: binding.bindingRevision,
        deviceId: binding.deviceId,
        action: "ISSUED",
        actor: normalized.actor,
        source: ATTESTATION_AUDIT_SOURCE.MANUAL_DASHBOARD
      }));
      return Object.freeze({ status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.QUEUED });
    };
    try {
      return await repository.withTransaction(queue);
    } catch (error) {
      // The partial active-per-device unique index is the race-safe backstop
      // for a second bootstrap arriving at the same time.  It must surface as
      // a bounded conflict, never as a generic database failure.
      if (error?.code === "LOCAL_CONVERSATION_ATTESTATION_DEVICE_BUSY") {
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_CONFLICT,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.LOCAL_CONVERSATION_ATTESTATION_DEVICE_BUSY
        });
      }
      throw error;
    }
  }

  async function attestLocalConversation(input = {}) {
    const normalized = normalizeConfirmationInput(input);
    return repository.withTransaction(async transaction => {
      const currentTime = new Date(now());
      const runtimeResult = runtimeGateResult(
        await repository.getDeviceRuntimeForUpdate(transaction, normalized.deviceId)
      );
      if (runtimeResult) return runtimeResult;
      await expireForDevice(transaction, { deviceId: normalized.deviceId, currentTime });
      const permit = attestationPermitFromRow(
        await repository.getLocalConversationAttestationPermitForUpdate(transaction, normalized.commandId)
      );
      const permitResult = stagedPermitResult(permit, currentTime);
      if (permitResult) return permitResult;
      if (permit.commandId !== normalized.commandId || permit.deviceId !== normalized.deviceId) {
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.PERMIT_DEVICE_MISMATCH
        });
      }
      const bindingResult = bindingStateResult(permit.binding);
      if (bindingResult) {
        await invalidateStagedPermit(
          transaction,
          permit,
          TINDER_LOCAL_CONVERSATION_ATTESTATION_INVALIDATION_REASON.includes(
            bindingResult.reasonCode
          ) ? bindingResult.reasonCode : "IDENTITY_CONFLICT",
          currentTime.toISOString()
        );
        return bindingResult;
      }
      if (permit.binding.bindingId !== permit.bindingId || permit.binding.deviceId !== permit.deviceId) {
        await invalidateStagedPermit(transaction, permit, "IDENTITY_CONFLICT", currentTime.toISOString());
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.PERMIT_BINDING_MISMATCH
        });
      }
      if (permit.binding.bindingRevision !== permit.bindingRevision) {
        await invalidateStagedPermit(transaction, permit, "BINDING_REVISION_CHANGED", currentTime.toISOString());
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.BINDING_REVISION_CHANGED
        });
      }
      const attested = await repository.markLocalConversationAttestationAttested(transaction, {
        commandId: permit.commandId,
        deviceId: permit.deviceId,
        attestedAt: currentTime.toISOString()
      });
      if (attested !== true) {
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.PERMIT_NOT_STAGED
        });
      }
      await repository.insertLocalConversationAttestationAudit(transaction, auditRecord({
        auditId: newAuditId(),
        commandId: permit.commandId,
        bindingId: permit.bindingId,
        bindingRevision: permit.bindingRevision,
        deviceId: permit.deviceId,
        action: "ATTESTED",
        actor: ATTESTATION_AUDIT_ACTOR.ANDROID_RUNTIME,
        source: ATTESTATION_AUDIT_SOURCE.SIGNED_DEVICE_INGRESS
      }));
      if (queueReaderAfterAttestation !== null) {
        const reader = await queueReaderAfterAttestation(transaction, Object.freeze({
          commandId: permit.commandId,
          bindingId: permit.bindingId,
          bindingRevision: permit.bindingRevision,
          deviceId: permit.deviceId
        }));
        // A local proof must not be presented as a usable reader transition
        // unless a distinct, separately audited V4 permit was issued while
        // the same locks and current binding facts were held.  The proof is
        // terminally invalidated rather than silently reused or retried.
        if (!plainObject(reader) || reader.status !== "QUEUED") {
          await invalidateStagedPermit(
            transaction,
            permit,
            "CONTINUITY_UNPROVEN",
            currentTime.toISOString()
          );
          return Object.freeze({
            status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
            reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.READER_QUEUE_NOT_AVAILABLE
          });
        }
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.ATTESTED,
          readerStatus: "READER_QUEUED"
        });
      }
      return Object.freeze({ status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.ATTESTED });
    });
  }

  async function invalidateLocalConversation(input = {}) {
    const normalized = normalizeInvalidationInput(input);
    return repository.withTransaction(async transaction => {
      // Invalidations must remain available while the bridge/Tinder runtime is
      // degraded, but they still take the same device-first lock used by
      // bootstrap, positive attestation and V4 ingress. This avoids a cycle
      // with V4's attestation-before-permit authorization path.
      const device = await repository.getDeviceRuntimeForUpdate(transaction, normalized.deviceId);
      if (!device) {
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.PERMIT_DEVICE_MISMATCH
        });
      }
      const permit = attestationPermitFromRow(
        await repository.getLocalConversationAttestationPermitForUpdate(transaction, normalized.commandId)
      );
      if (!permit) {
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.PERMIT_NOT_FOUND
        });
      }
      if (permit.deviceId !== normalized.deviceId) {
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.PERMIT_DEVICE_MISMATCH
        });
      }
      if (!new Set(["STAGED", "ATTESTED"]).has(permit.permitState)) {
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.INVALIDATION_NOT_ALLOWED
        });
      }
      const invalidatedAt = new Date(now()).toISOString();
      const invalidated = await repository.markLocalConversationAttestationInvalidated(transaction, {
        commandId: permit.commandId,
        deviceId: permit.deviceId,
        invalidatedAt,
        reasonCode: normalized.reasonCode
      });
      if (invalidated !== true) {
        return Object.freeze({
          status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_LOCAL_CONVERSATION_ATTESTATION_REASON.INVALIDATION_NOT_ALLOWED
        });
      }
      await cancelDependentReaderPermits(transaction, permit.commandId, invalidatedAt);
      await repository.insertLocalConversationAttestationAudit(transaction, auditRecord({
        auditId: newAuditId(),
        commandId: permit.commandId,
        bindingId: permit.bindingId,
        bindingRevision: permit.bindingRevision,
        deviceId: permit.deviceId,
        action: "INVALIDATED",
        actor: ATTESTATION_AUDIT_ACTOR.ANDROID_RUNTIME,
        source: ATTESTATION_AUDIT_SOURCE.SIGNED_DEVICE_INGRESS,
        reasonCode: normalized.reasonCode
      }));
      return Object.freeze({ status: TINDER_LOCAL_CONVERSATION_ATTESTATION_STATUS.INVALIDATED });
    });
  }

  return Object.freeze({
    queueBootstrap,
    attestLocalConversation,
    invalidateLocalConversation
  });
}

/**
 * PostgreSQL adapter.  The matching explicit migration owns the table
 * contract; this adapter never creates, repairs, or discovers schema.
 */
export function createPgTinderLocalConversationAttestationRepository(pool) {
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
      return { ...row, online: deriveDeviceStatus(row.last_accepted_heartbeat_at) === "ONLINE" };
    },

    async expireLocalConversationAttestationPermits(client, { deviceId, expiredAt }) {
      const result = await client.query(
        `UPDATE ${TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE}
            SET permit_state='EXPIRED', closed_at=$2,
                terminal_reason='EXPIRED', updated_at=NOW()
           WHERE device_id=$1
             AND permit_state IN ('ISSUED','STAGED','ATTESTED')
             AND expires_at <= $2
         RETURNING command_id, binding_id, binding_revision, device_id`,
        [deviceId, expiredAt]
      );
      return result.rows;
    },

    async findActiveHumanArmedPermitForDevice(client, { deviceId, now: currentTime }) {
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1
             FROM contact_human_armed_conversation_binding_permits permit
             JOIN device_bridge_commands command ON command.command_id=permit.command_id
            WHERE permit.device_id=$1 AND permit.permit_state='ISSUED'
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
             SELECT 1 FROM tinder_visible_chat_sync_permits
              WHERE device_id=$1 AND permit_state IN ('ISSUED','STAGED') AND expires_at>$2
           ) AS active`,
          [deviceId, currentTime]
        );
        return legacy.rows[0]?.active === true;
      }
      const result = await client.query(
        `SELECT EXISTS (
           SELECT 1 FROM tinder_visible_chat_sync_permits
                 sync_permit
       LEFT JOIN ${TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE} attestation
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

    // This discovery read intentionally takes no binding lock.  The caller
    // immediately locks the device first and then re-reads the binding FOR
    // UPDATE, rejecting any device drift.  That establishes the shared lock
    // order without treating this preliminary value as authorization.
    async lookupHumanBindingDeviceId(client, bindingId) {
      const result = await client.query(
        `SELECT device_id
           FROM ${HUMAN_ARMED_CONVERSATION_BINDING_TABLE}
          WHERE binding_id=$1`,
        [bindingId]
      );
      return result.rows[0]?.device_id || null;
    },

    async getConfirmedHumanBindingForUpdate(client, bindingId) {
      const result = await client.query(
        `SELECT binding_id, device_id, binding_revision, binding_state,
                human_verified, channel, reference_kind
           FROM ${HUMAN_ARMED_CONVERSATION_BINDING_TABLE}
          WHERE binding_id=$1
          FOR UPDATE`,
        [bindingId]
      );
      return result.rows[0] || null;
    },

    async findActiveLocalConversationAttestationForDeviceForUpdate(client, input) {
      const result = await client.query(
        `SELECT command_id, permit_state
           FROM ${TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE}
          WHERE device_id=$1
            AND permit_state IN ('ISSUED','STAGED','ATTESTED')
          ORDER BY created_at DESC, command_id ASC
          LIMIT 1
          FOR UPDATE`,
        [input.deviceId]
      );
      return result.rows[0] || null;
    },

    async queueLocalConversationAttestationCommand(client, input) {
      if (input.commandType !== TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE
          || !exactBootstrapPayload(input.payload, Number(input.payload?.binding_revision))) {
        throw new TypeError("Local conversation attestation command payload must be exact");
      }
      const result = await client.query(
        `INSERT INTO device_bridge_commands
          (command_id, device_id, protocol_version, command_type, payload,
           configuration_revision, issued_at, expires_at)
         SELECT $1, d.device_id, 1, $3, $4::jsonb,
                d.configuration_revision, NOW(), $5
           FROM device_bridge_devices d
          WHERE d.device_id=$2
         RETURNING command_id`,
        [input.commandId, input.deviceId, input.commandType, JSON.stringify(input.payload), input.expiresAt]
      );
      if (result.rows.length !== 1 || result.rows[0]?.command_id !== input.commandId) {
        throw new TinderLocalConversationAttestationError(
          "Local conversation attestation command could not be created.",
          "LOCAL_CONVERSATION_ATTESTATION_COMMAND_WRITE_FAILED",
          500
        );
      }
    },

    async createLocalConversationAttestationPermit(client, input) {
      const result = await client.query(
        `INSERT INTO ${TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE} (
           command_id, binding_id, binding_revision, device_id,
           permit_contract_version, permit_state,
           issued_at, expires_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,'ISSUED',NOW(),$6,NOW(),NOW())
           ON CONFLICT DO NOTHING
         RETURNING command_id`,
        [input.commandId, input.bindingId, input.bindingRevision, input.deviceId,
          TINDER_LOCAL_CONVERSATION_ATTESTATION_CONTRACT_VERSION, input.expiresAt]
      );
      if (result.rows.length === 0) {
        throw new TinderLocalConversationAttestationError(
          "A local conversation attestation is already active for this device.",
          "LOCAL_CONVERSATION_ATTESTATION_DEVICE_BUSY",
          409
        );
      }
      if (result.rows.length !== 1 || result.rows[0]?.command_id !== input.commandId) {
        throw new TinderLocalConversationAttestationError(
          "Local conversation attestation permit could not be created.",
          "LOCAL_CONVERSATION_ATTESTATION_PERMIT_WRITE_FAILED",
          500
        );
      }
    },

    async getLocalConversationAttestationPermitForUpdate(client, commandId) {
      const result = await client.query(
        `SELECT permit.command_id, permit.binding_id,
                permit.binding_revision AS permit_binding_revision,
                permit.device_id, permit.permit_state,
                permit.permit_contract_version, permit.expires_at,
                command.command_type, command.terminal_status,
                acknowledgement.status AS ack_status, acknowledgement.result AS ack_result,
                binding.binding_state, binding.human_verified, binding.channel,
                binding.reference_kind, binding.device_id AS binding_device_id,
                binding.binding_revision AS current_binding_revision
           FROM ${TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE} permit
           JOIN device_bridge_commands command ON command.command_id=permit.command_id
           JOIN ${HUMAN_ARMED_CONVERSATION_BINDING_TABLE} binding ON binding.binding_id=permit.binding_id
      LEFT JOIN device_bridge_command_acks acknowledgement
             ON acknowledgement.command_id=permit.command_id
            AND acknowledgement.status='SUCCEEDED'
          WHERE permit.command_id=$1
          FOR UPDATE OF permit, command, binding`,
        [commandId]
      );
      const row = result.rows[0] || null;
      if (!row) return null;
      return row;
    },

    async markLocalConversationAttestationAttested(client, { commandId, deviceId, attestedAt }) {
      const result = await client.query(
        `UPDATE ${TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE}
            SET permit_state='ATTESTED', attested_at=$3, updated_at=NOW()
          WHERE command_id=$1 AND device_id=$2 AND permit_state='STAGED'
            AND expires_at>$3
         RETURNING command_id`,
        [commandId, deviceId, attestedAt]
      );
      return result.rows.length === 1;
    },

    async markLocalConversationAttestationInvalidated(client, {
      commandId, deviceId, invalidatedAt, reasonCode
    }) {
      const result = await client.query(
        `UPDATE ${TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE}
            SET permit_state='INVALIDATED', invalidated_at=$3,
                closed_at=$3, terminal_reason=$4, updated_at=NOW()
          WHERE command_id=$1 AND device_id=$2
            AND permit_state IN ('STAGED','ATTESTED')
         RETURNING command_id`,
        [commandId, deviceId, invalidatedAt, reasonCode]
      );
      return result.rows.length === 1;
    },

    // A V2 sync permit is derivative authority only.  Once the local proof
    // expires or is invalidated it must not remain an active device conflict
    // until its own TTL.  The permit row is durably terminalized in the same
    // transaction; the command is deliberately not replayed or retargeted.
    async cancelDependentVisibleChatSyncPermits(client, { attestationCommandId, closedAt }) {
      const result = await client.query(
        `UPDATE tinder_visible_chat_sync_permits
            SET permit_state='CANCELLED', closed_at=$2, updated_at=NOW()
          WHERE attestation_command_id=$1
            AND permit_contract_version=2
            AND permit_state IN ('ISSUED','STAGED')
         RETURNING command_id`,
        [attestationCommandId, closedAt]
      );
      return result.rows;
    },

    async insertLocalConversationAttestationAudit(client, audit) {
      await client.query(
        `INSERT INTO ${TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE} (
            audit_id, command_id, binding_id, binding_revision, device_id, action, actor,
            source, reason_code, details
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
         [audit.auditId, audit.commandId, audit.bindingId, audit.bindingRevision, audit.deviceId,
           audit.action, audit.actor, audit.source, audit.reasonCode, JSON.stringify(audit.details)]
      );
    }
  });
}
