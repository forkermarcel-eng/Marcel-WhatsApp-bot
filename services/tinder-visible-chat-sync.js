import crypto from "node:crypto";
import { deriveDeviceStatus } from "../device-bridge/heartbeat.js";
import {
  isTinderLocalConversationAttestationPostChatCapable,
  isTinderVisibleChatSyncCapable,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_VERSION
} from "../device-bridge/protocol-v1.js";
import {
  HUMAN_ARMED_CONVERSATION_BINDING_TABLE,
  HUMAN_ARMED_CONVERSATION_PERMIT_TABLE,
  HUMAN_ARMED_CONVERSATION_REFERENCE_KIND
} from "./tinder-human-armed-conversation-binding.js";
import {
  TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_CONTRACT_VERSION,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_V4_PAYLOAD_FIELD
} from "./tinder-local-conversation-attestation.js";

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
export const TINDER_VISIBLE_CHAT_SYNC_LEGACY_PERMIT_CONTRACT_VERSION = 1;
export const TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION = 2;
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
  // V8 owns the device while it is reading and returning between Inbox rows.
  // A V4 reader must never be queued concurrently with that bounded sweep.
  UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE: "UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE",
  SYNC_PERMIT_ACTIVE: "SYNC_PERMIT_ACTIVE",
  PERMIT_NOT_FOUND: "PERMIT_NOT_FOUND",
  PERMIT_ALREADY_CONSUMED: "PERMIT_ALREADY_CONSUMED",
  PERMIT_NOT_STAGED: "PERMIT_NOT_STAGED",
  PERMIT_EXPIRED: "PERMIT_EXPIRED",
  PERMIT_ACK_NOT_STAGED: "PERMIT_ACK_NOT_STAGED",
  PERMIT_DEVICE_MISMATCH: "PERMIT_DEVICE_MISMATCH",
  SOURCE_CAPTURE_NOT_CONFIRMED: "SOURCE_CAPTURE_NOT_CONFIRMED",
  HUMAN_ARMED_BINDING_NOT_CONFIRMED: "HUMAN_ARMED_BINDING_NOT_CONFIRMED",
  LOCAL_CONVERSATION_ATTESTATION_REQUIRED: "LOCAL_CONVERSATION_ATTESTATION_REQUIRED",
  LOCAL_CONVERSATION_ATTESTATION_NOT_ATTESTED: "LOCAL_CONVERSATION_ATTESTATION_NOT_ATTESTED",
  LOCAL_CONVERSATION_ATTESTATION_INVALID: "LOCAL_CONVERSATION_ATTESTATION_INVALID"
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

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
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

function exactAttestedPayload(value, attestationCommandId, bindingRevision) {
  return exactKeys(value, [
    TINDER_LOCAL_CONVERSATION_ATTESTATION_V4_PAYLOAD_FIELD,
    "binding_revision"
  ])
    && value[TINDER_LOCAL_CONVERSATION_ATTESTATION_V4_PAYLOAD_FIELD] === attestationCommandId
    && value.binding_revision === String(bindingRevision);
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

/**
 * The opaque binding handle comes only from the existing bounded human-armed
 * dashboard reader. It is a server-side association handle, never a Tinder
 * identifier and never a capture choice rendered to Marcel.
 */
function normalizeHumanBindingIssueInput(value) {
  if (!exactKeys(value, ["bindingId"])) {
    throw new TinderVisibleChatSyncError(
      "Die menschlich best\u00e4tigte Conversation-Anfrage enth\u00e4lt nicht erlaubte Felder.",
      "INVALID_HUMAN_BINDING_SYNC_REQUEST"
    );
  }
  return Object.freeze({
    bindingId: normalizeUuid(value.bindingId, "Die Conversation-Bindung", "INVALID_HUMAN_BINDING_ID")
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
  const permitContractVersion = positiveInteger(
    sourceValue(row, "permitContractVersion", "permit_contract_version")
  );
  const attestationCommandId = sourceValue(row, "attestationCommandId", "attestation_command_id") === null
    || sourceValue(row, "attestationCommandId", "attestation_command_id") === undefined
    ? null : uuid(sourceValue(row, "attestationCommandId", "attestation_command_id"));
  const bindingId = sourceValue(row, "bindingId", "binding_id") === null
    || sourceValue(row, "bindingId", "binding_id") === undefined
    ? null : uuid(sourceValue(row, "bindingId", "binding_id"));
  const bindingRevision = sourceValue(row, "bindingRevision", "binding_revision") === null
    || sourceValue(row, "bindingRevision", "binding_revision") === undefined
    ? null : positiveInteger(sourceValue(row, "bindingRevision", "binding_revision"));
  const legacyPermit = permitContractVersion === TINDER_VISIBLE_CHAT_SYNC_LEGACY_PERMIT_CONTRACT_VERSION
    && attestationCommandId === null && bindingId === null && bindingRevision === null;
  const attestedPermit = permitContractVersion === TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION
    && Boolean(attestationCommandId) && Boolean(bindingId) && Boolean(bindingRevision);
  if (!legacyPermit && !attestedPermit) return null;
  return Object.freeze({
    commandId,
    deviceId,
    sourceCaptureId,
    state: normalizedStatus(sourceValue(row, "permitState", "permit_state")),
    expiresAt,
    commandTerminalStatus: normalizedStatus(sourceValue(row, "commandTerminalStatus", "terminal_status")),
    acknowledgementStatus: normalizedStatus(sourceValue(row, "acknowledgementStatus", "ack_status")),
    acknowledgementResult: sourceValue(row, "acknowledgementResult", "ack_result"),
    permitContractVersion,
    attestationCommandId,
    bindingId,
    bindingRevision
  });
}

function humanBindingSourceFromRow(row) {
  const deviceId = uuid(sourceValue(row, "deviceId", "device_id"));
  const sourceCaptureId = uuid(sourceValue(row, "sourceCaptureId", "source_capture_id"));
  const attestationCommandId = uuid(sourceValue(row, "attestationCommandId", "attestation_command_id"));
  const bindingId = uuid(sourceValue(row, "bindingId", "binding_id"));
  const bindingRevision = positiveInteger(sourceValue(row, "bindingRevision", "binding_revision"));
  return deviceId && sourceCaptureId && attestationCommandId && bindingId && bindingRevision
    ? Object.freeze({ deviceId, sourceCaptureId, attestationCommandId, bindingId, bindingRevision })
    : null;
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
    "findActiveUnboundInboxConversationSweepForDevice",
    "getConfirmedSourceCaptureForUpdate",
    "queueVisibleChatSyncCommand",
    "createVisibleChatSyncPermit",
    "lookupVisibleChatSyncPermitForAuthorization",
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
  // person, visible UI value, Tinder identifier, or fingerprint. Its
  // server-side source-capture reference never crosses the device or HTTP
  // boundary.
  const stagedPermitHandles = new WeakSet();
  // The public-shaped handle intentionally stays identity-free. Its bounded
  // V2 scope is held only in this process so the final ingress recheck can
  // prove that the already-staged permit still points at the same confirmed
  // binding/revision/consumed V3 source without giving that tuple to Android.
  const stagedPermitContexts = new WeakMap();

  function newCommandId() {
    return normalizeUuid(createCommandId(), "Die Sync-Command-ID", "INVALID_SYNC_COMMAND_ID");
  }

  function normalizeAttestedHumanBindingSource(source) {
    const attestationCommandId = normalizeUuid(
      source?.attestationCommandId,
      "Die lokale Conversation-Attestation",
      "INVALID_LOCAL_CONVERSATION_ATTESTATION"
    );
    const bindingId = normalizeUuid(
      source?.bindingId,
      "Die Conversation-Bindung",
      "INVALID_HUMAN_BINDING_ID"
    );
    const bindingRevision = positiveInteger(source?.bindingRevision);
    if (!bindingRevision) {
      throw new TinderVisibleChatSyncError(
        "Die Conversation-Bindungsrevision ist ungültig.",
        "INVALID_HUMAN_BINDING_REVISION"
      );
    }
    return Object.freeze({ attestationCommandId, bindingId, bindingRevision });
  }

  async function queueFromNormalizedSource(normalized, existingTransaction = null, {
    attestation = null,
    sourceAlreadyValidated = false
  } = {}) {
    const normalizedAttestation = attestation === null
      ? null : normalizeAttestedHumanBindingSource(attestation);
    if (normalizedAttestation === null) {
      // V1 rows remain readable/auditable, but after the V6 canonical schema
      // no service path may issue a fresh empty-payload V1 reader command.
      return Object.freeze({
        status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
        reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.LOCAL_CONVERSATION_ATTESTATION_REQUIRED
      });
    }
    const queue = async transaction => {
      const currentTime = new Date(now());
      if (Number.isNaN(currentTime.valueOf())) {
        throw new TinderVisibleChatSyncError("Die Sync-Zeit ist ungültig.", "INVALID_SYNC_TIME", 500);
      }
      const runtime = await repository.getDeviceRuntimeForUpdate(transaction, normalized.deviceId);
      const runtimeResult = runtimeGateResult(runtime);
      if (runtimeResult) return runtimeResult;
      // A V2 reader command carries an attestation handle and therefore must
      // never be issued to a runtime that can only understand legacy V4.
      // This does not grant the reader any new authority; it only prevents a
      // capability downgrade from receiving an opaque V2 contract it cannot
      // revalidate locally.
      if (normalizedAttestation !== null
          && !isTinderLocalConversationAttestationPostChatCapable(
            sourceValue(runtime, "capabilities", "capabilities")
          )) {
        return Object.freeze({
          status: TINDER_VISIBLE_CHAT_SYNC_STATUS.DEVICE_NOT_READY,
          reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.DEVICE_CAPABILITY_UNSUPPORTED
        });
      }

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
      if (strictBoolean(await repository.findActiveUnboundInboxConversationSweepForDevice(transaction, {
        deviceId: normalized.deviceId,
        now: currentTime.toISOString()
      }), "findActiveUnboundInboxConversationSweepForDevice")) {
        return Object.freeze({
          status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_CONFLICT,
          reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE
        });
      }

      if (!sourceAlreadyValidated && strictBoolean(await repository.getConfirmedSourceCaptureForUpdate(transaction, {
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
        payload: normalizedAttestation === null
          ? Object.freeze({})
          : Object.freeze({
            [TINDER_LOCAL_CONVERSATION_ATTESTATION_V4_PAYLOAD_FIELD]: normalizedAttestation.attestationCommandId,
            binding_revision: String(normalizedAttestation.bindingRevision)
          }),
        permitContractVersion: normalizedAttestation === null
          ? TINDER_VISIBLE_CHAT_SYNC_LEGACY_PERMIT_CONTRACT_VERSION
          : TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION,
        attestationCommandId: normalizedAttestation?.attestationCommandId ?? null,
        bindingRevision: normalizedAttestation?.bindingRevision ?? null,
        expiresAt
      });
      if ((normalizedAttestation === null && !exactEmptyPayload(command.payload))
          || (normalizedAttestation !== null && !exactAttestedPayload(
            command.payload,
            normalizedAttestation.attestationCommandId,
            normalizedAttestation.bindingRevision
          ))) {
        throw new TinderVisibleChatSyncError("Der sichtbare Chat-Sync-Command ist ungültig.", "INVALID_SYNC_COMMAND", 500);
      }
      await repository.queueVisibleChatSyncCommand(transaction, command);
      await repository.createVisibleChatSyncPermit(transaction, Object.freeze({
        commandId,
        deviceId: normalized.deviceId,
        sourceCaptureId: normalized.sourceCaptureId,
        permitState: "ISSUED",
        expiresAt,
        permitContractVersion: normalizedAttestation === null
          ? TINDER_VISIBLE_CHAT_SYNC_LEGACY_PERMIT_CONTRACT_VERSION
          : TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION,
        attestationCommandId: normalizedAttestation?.attestationCommandId ?? null,
        bindingId: normalizedAttestation?.bindingId ?? null,
        bindingRevision: normalizedAttestation?.bindingRevision ?? null
      }));
      // Deliberately do not disclose the opaque command/permit UUID from this
      // creation result. The authenticated device receives it only through
      // the signed command channel.
      return Object.freeze({ status: TINDER_VISIBLE_CHAT_SYNC_STATUS.QUEUED });
    };
    return existingTransaction ? queue(existingTransaction) : repository.withTransaction(queue);
  }

  // The older direct capture route is retained only as a fail-closed public
  // compatibility seam. It must never mint a new V1 empty-payload permit.
  async function queueVisibleChatSync(input = {}, existingTransaction = null) {
    normalizeIssueInput(input);
    return Object.freeze({
      status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
      reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.LOCAL_CONVERSATION_ATTESTATION_REQUIRED
    });
  }

  /**
   * The only current-view bridge permitted when Tinder exposes no stable
   * platform reference. A human explicitly confirms the already-visible
   * official chat on an existing binding card; the server then derives the
   * one eligible consumed capture without accepting a name, timestamp,
   * fingerprint, message, device, or capture choice from the caller.
   */
  async function queueVisibleChatSyncForHumanBinding(input = {}, existingTransaction = null) {
    const normalized = normalizeHumanBindingIssueInput(input);
    if (typeof repository.lookupHumanBindingDeviceId !== "function"
        || typeof repository.getConfirmedSourceCaptureForAttestedHumanBindingForUpdate !== "function") {
      throw new TinderVisibleChatSyncError(
        "Die menschlich best\u00e4tigte Conversation-Quelle ist nicht verf\u00fcgbar.",
        "INVALID_SYNC_REPOSITORY",
        500
      );
    }
    const queue = async transaction => {
      const currentTime = new Date(now());
      if (Number.isNaN(currentTime.valueOf())) {
        throw new TinderVisibleChatSyncError("Die Sync-Zeit ist ungültig.", "INVALID_SYNC_TIME", 500);
      }
      const preliminaryDeviceId = uuid(
        await repository.lookupHumanBindingDeviceId(transaction, normalized.bindingId)
      );
      if (!preliminaryDeviceId) {
        return Object.freeze({
          status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.HUMAN_ARMED_BINDING_NOT_CONFIRMED
        });
      }
      const runtimeResult = runtimeGateResult(
        await repository.getDeviceRuntimeForUpdate(transaction, preliminaryDeviceId)
      );
      if (runtimeResult) return runtimeResult;
      const source = humanBindingSourceFromRow(
        await repository.getConfirmedSourceCaptureForAttestedHumanBindingForUpdate(transaction, {
          bindingId: normalized.bindingId,
          now: currentTime.toISOString()
        })
      );
      if (!source) {
        const attestationState = typeof repository.getLocalConversationAttestationStateForBindingForUpdate === "function"
          ? normalizedStatus(await repository.getLocalConversationAttestationStateForBindingForUpdate(transaction, {
            bindingId: normalized.bindingId,
            deviceId: preliminaryDeviceId
          }))
          : "";
        return Object.freeze({
          status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: ["ISSUED", "STAGED"].includes(attestationState)
            ? TINDER_VISIBLE_CHAT_SYNC_REASON.LOCAL_CONVERSATION_ATTESTATION_NOT_ATTESTED
            : ["INVALIDATED", "EXPIRED", "CANCELLED"].includes(attestationState)
              ? TINDER_VISIBLE_CHAT_SYNC_REASON.LOCAL_CONVERSATION_ATTESTATION_INVALID
              : TINDER_VISIBLE_CHAT_SYNC_REASON.HUMAN_ARMED_BINDING_NOT_CONFIRMED
        });
      }
      if (source.deviceId !== preliminaryDeviceId) {
        return Object.freeze({
          status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.HUMAN_ARMED_BINDING_NOT_CONFIRMED
        });
      }
      return queueFromNormalizedSource(source, transaction, {
        attestation: source,
        sourceAlreadyValidated: true
      });
    };
    return existingTransaction ? queue(existingTransaction) : repository.withTransaction(queue);
  }

  /**
   * Read/lock seam for the separate bounded transcript ingress. It does not
   * expose the dashboard-selected source capture to Android.
   */
  async function authorizeStagedVisibleChatSyncPermit(transaction, input = {}) {
    const normalized = normalizePermitInput(input);
    // Discovery is explicitly non-authoritative. It establishes the device
    // lock before the local proof and, finally, the V4 permit.
    const discovered = await repository.lookupVisibleChatSyncPermitForAuthorization(
      transaction,
      normalized.commandId
    );
    const discoveredDeviceId = uuid(sourceValue(discovered, "deviceId", "device_id"));
    const discoveredContractVersion = positiveInteger(
      sourceValue(discovered, "permitContractVersion", "permit_contract_version")
    );
    const discoveredAttestationCommandId = sourceValue(discovered, "attestationCommandId", "attestation_command_id") === null
      || sourceValue(discovered, "attestationCommandId", "attestation_command_id") === undefined
      ? null : uuid(sourceValue(discovered, "attestationCommandId", "attestation_command_id"));
    const discoveredBindingId = sourceValue(discovered, "bindingId", "binding_id") === null
      || sourceValue(discovered, "bindingId", "binding_id") === undefined
      ? null : uuid(sourceValue(discovered, "bindingId", "binding_id"));
    const discoveredBindingRevision = sourceValue(discovered, "bindingRevision", "binding_revision") === null
      || sourceValue(discovered, "bindingRevision", "binding_revision") === undefined
      ? null : positiveInteger(sourceValue(discovered, "bindingRevision", "binding_revision"));
    if (!discoveredDeviceId || !discoveredContractVersion) {
      return Object.freeze({
        status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
        reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.PERMIT_NOT_FOUND
      });
    }
    const attestedDiscovery = discoveredContractVersion === TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION;
    if (attestedDiscovery && (!discoveredAttestationCommandId || !discoveredBindingId || !discoveredBindingRevision)) {
      return Object.freeze({
        status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
        reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.LOCAL_CONVERSATION_ATTESTATION_INVALID
      });
    }
    const runtime = await repository.getDeviceRuntimeForUpdate(transaction, discoveredDeviceId);
    if (!runtime) {
      return Object.freeze({
        status: TINDER_VISIBLE_CHAT_SYNC_STATUS.DEVICE_NOT_READY,
        reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.DEVICE_OFFLINE
      });
    }
    if (attestedDiscovery && !isTinderLocalConversationAttestationPostChatCapable(
      sourceValue(runtime, "capabilities", "capabilities")
    )) {
      return Object.freeze({
        status: TINDER_VISIBLE_CHAT_SYNC_STATUS.DEVICE_NOT_READY,
        reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.DEVICE_CAPABILITY_UNSUPPORTED
      });
    }
    if (attestedDiscovery) {
      if (typeof repository.revalidateAttestedLocalConversationForSyncPermitForUpdate !== "function") {
        throw new TinderVisibleChatSyncError(
          "Local conversation attestation repository is unavailable.",
          "INVALID_SYNC_REPOSITORY",
          500
        );
      }
      const attestationCurrent = strictBoolean(
        await repository.revalidateAttestedLocalConversationForSyncPermitForUpdate(transaction, {
          commandId: normalized.commandId,
          deviceId: discoveredDeviceId,
          attestationCommandId: discoveredAttestationCommandId,
          bindingId: discoveredBindingId,
          bindingRevision: discoveredBindingRevision,
          now: new Date(now()).toISOString()
        }),
        "revalidateAttestedLocalConversationForSyncPermitForUpdate"
      );
      if (!attestationCurrent) {
        return Object.freeze({
          status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.LOCAL_CONVERSATION_ATTESTATION_INVALID
        });
      }
    }
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
    if (permit.deviceId !== discoveredDeviceId
        || permit.permitContractVersion !== discoveredContractVersion
        || (attestedDiscovery && (permit.attestationCommandId !== discoveredAttestationCommandId
          || permit.bindingId !== discoveredBindingId
          || permit.bindingRevision !== discoveredBindingRevision))) {
      return Object.freeze({
        status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
        reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.LOCAL_CONVERSATION_ATTESTATION_INVALID
      });
    }
    const authorization = Object.freeze({
      commandId: permit.commandId,
      deviceId: permit.deviceId,
      sourceCaptureId: permit.sourceCaptureId
    });
    stagedPermitHandles.add(authorization);
    stagedPermitContexts.set(authorization, Object.freeze({
      permitContractVersion: permit.permitContractVersion,
      attestationCommandId: permit.attestationCommandId,
      bindingId: permit.bindingId,
      bindingRevision: permit.bindingRevision
    }));
    return Object.freeze({
      status: TINDER_VISIBLE_CHAT_SYNC_STATUS.STAGED,
      authorization
    });
  }

  /**
   * Final server-side source recheck immediately before transcript storage.
   * A V1 row may finish its historic lifecycle with the original generic
   * source proof. A V2 row must additionally still be the consumed V3 source
   * of its current confirmed binding revision and contact. This closes the
   * remap race between STAGED acknowledgement and signed ingress.
   */
  async function revalidateAuthorizedStagedVisibleChatSyncSource(transaction, authorization) {
    if (!plainObject(authorization) || !stagedPermitHandles.has(authorization)) {
      throw new TinderVisibleChatSyncError(
        "Die sichtbare Chat-Sync-Autorisierung ist ungÃ¼ltig.",
        "INVALID_SYNC_PERMIT_AUTHORIZATION",
        500
      );
    }
    const context = stagedPermitContexts.get(authorization);
    if (!context) {
      throw new TinderVisibleChatSyncError(
        "Der lokale Chat-Sync-Kontext ist nicht verfÃ¼gbar.",
        "INVALID_SYNC_PERMIT_AUTHORIZATION",
        500
      );
    }
    if (context.permitContractVersion === TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION) {
      if (typeof repository.getConfirmedSourceCaptureForAttestedSyncPermitForUpdate !== "function") {
        return false;
      }
      return strictBoolean(
        await repository.getConfirmedSourceCaptureForAttestedSyncPermitForUpdate(transaction, {
          commandId: authorization.commandId,
          deviceId: authorization.deviceId,
          sourceCaptureId: authorization.sourceCaptureId,
          attestationCommandId: context.attestationCommandId,
          bindingId: context.bindingId,
          bindingRevision: context.bindingRevision,
          now: new Date(now()).toISOString()
        }),
        "getConfirmedSourceCaptureForAttestedSyncPermitForUpdate"
      );
    }
    return strictBoolean(
      await repository.getConfirmedSourceCaptureForUpdate(transaction, {
        sourceCaptureId: authorization.sourceCaptureId,
        deviceId: authorization.deviceId
      }),
      "getConfirmedSourceCaptureForUpdate"
    );
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
    queueVisibleChatSyncForHumanBinding,
    authorizeStagedVisibleChatSyncPermit,
    revalidateAuthorizedStagedVisibleChatSyncSource,
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
      const attestationRelation = await client.query(
        "SELECT to_regclass('tinder_local_conversation_attestation_permits') AS relation_name"
      );
      if (!attestationRelation.rows[0]?.relation_name) {
        const legacy = await client.query(
          `SELECT EXISTS (
             SELECT 1
               FROM ${TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE}
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
             FROM ${TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE} sync_permit
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

    // V8 is optional until its explicit foundation migration has committed.
    // The issuer already holds the device row lock, so this guarded lookup
    // serializes V4 issuance against an active V8 parent without making a
    // pre-V8 deployment query a schema-absence failure.
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

    // Discovery only: authorization comes from the subsequent locked source
    // query.  Taking the device lock first keeps V2 issuance aligned with the
    // command ACK and signed ingress transaction order.
    async lookupHumanBindingDeviceId(client, bindingId) {
      const result = await client.query(
        `SELECT device_id
           FROM ${HUMAN_ARMED_CONVERSATION_BINDING_TABLE}
          WHERE binding_id=$1`,
        [bindingId]
      );
      return result.rows[0]?.device_id || null;
    },

    async queueVisibleChatSyncCommand(client, input) {
      const legacy = input.permitContractVersion === TINDER_VISIBLE_CHAT_SYNC_LEGACY_PERMIT_CONTRACT_VERSION
        && input.attestationCommandId === null && input.bindingRevision === null
        && exactEmptyPayload(input.payload);
      const attested = input.permitContractVersion === TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION
        && Boolean(uuid(input.attestationCommandId))
        && Boolean(positiveInteger(input.bindingRevision))
        && exactAttestedPayload(input.payload, input.attestationCommandId, input.bindingRevision);
      if ((!legacy && !attested) || input.commandType !== TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE) {
        throw new TypeError("Visible-chat sync command payload is not a valid permit contract");
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
        throw new TinderVisibleChatSyncError("Der sichtbare Chat-Sync-Command konnte nicht angelegt werden.", "SYNC_COMMAND_WRITE_FAILED", 500);
      }
    },

    async createVisibleChatSyncPermit(client, input) {
      const legacy = input.permitContractVersion === TINDER_VISIBLE_CHAT_SYNC_LEGACY_PERMIT_CONTRACT_VERSION
        && input.attestationCommandId === null && input.bindingId === null && input.bindingRevision === null;
      const attested = input.permitContractVersion === TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION
        && Boolean(uuid(input.attestationCommandId)) && Boolean(uuid(input.bindingId))
        && Boolean(positiveInteger(input.bindingRevision));
      if (!legacy && !attested) {
        throw new TypeError("Visible-chat sync permit contract is invalid");
      }
      const result = await client.query(
        `INSERT INTO ${TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE} (
            command_id, device_id, source_capture_id, permit_state, issued_at, expires_at,
            permit_contract_version, attestation_command_id, binding_id, binding_revision,
            created_at, updated_at
          ) VALUES ($1,$2,$3,'ISSUED',NOW(),$4,$5,$6,$7,$8,NOW(),NOW())
          RETURNING command_id`,
        [input.commandId, input.deviceId, input.sourceCaptureId, input.expiresAt,
          input.permitContractVersion, input.attestationCommandId, input.bindingId, input.bindingRevision]
      );
      if (result.rows.length !== 1 || result.rows[0]?.command_id !== input.commandId) {
        throw new TinderVisibleChatSyncError("Die sichtbare Chat-Sync-Freigabe konnte nicht angelegt werden.", "SYNC_PERMIT_WRITE_FAILED", 500);
      }
    },

    // Discovery only. The authorization flow locks the discovered device,
    // then the attestation/binding tuple, then performs the locked permit
    // re-read. This query must never be used as authority by itself.
    async lookupVisibleChatSyncPermitForAuthorization(client, commandId) {
      const result = await client.query(
        `SELECT command_id, device_id, permit_contract_version,
                attestation_command_id, binding_id, binding_revision
           FROM ${TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE}
          WHERE command_id=$1`,
        [commandId]
      );
      return result.rows[0] || null;
    },

    async getVisibleChatSyncPermitForUpdate(client, commandId) {
      const result = await client.query(
        `SELECT permit.command_id, permit.device_id, permit.source_capture_id, permit.permit_state,
                permit.permit_contract_version, permit.attestation_command_id,
                permit.binding_id, permit.binding_revision,
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

    /**
     * V2's final ingress gate.  This is intentionally stricter than the
     * historic generic source check: the staged V4 permit must still point to
     * the consumed V3 capture of the same currently confirmed binding
     * revision, and that capture must still resolve to that binding's contact.
     * The caller already owns device -> attestation/binding -> V4 locks; this
     * acquires only the remaining binding-permit/capture facts in that order.
     */
    async getConfirmedSourceCaptureForAttestedSyncPermitForUpdate(client, input) {
      const result = await client.query(
        `SELECT permit.command_id
           FROM ${TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE} permit
           JOIN ${TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE} attestation
             ON attestation.command_id=permit.attestation_command_id
           JOIN device_bridge_commands attestation_command
             ON attestation_command.command_id=attestation.command_id
           JOIN ${HUMAN_ARMED_CONVERSATION_BINDING_TABLE} binding
             ON binding.binding_id=permit.binding_id
           JOIN ${HUMAN_ARMED_CONVERSATION_PERMIT_TABLE} binding_permit
             ON binding_permit.binding_id=binding.binding_id
           JOIN tinder_visible_chat_captures capture
             ON capture.capture_id=binding_permit.consumed_capture_id
          WHERE permit.command_id=$1
            AND permit.device_id=$2
            AND permit.source_capture_id=$3
            AND permit.permit_contract_version=$4
            AND permit.attestation_command_id=$5
            AND permit.binding_id=$6
            AND permit.binding_revision=$7
            AND permit.permit_state='STAGED'
            AND permit.expires_at>$8
            AND attestation.device_id=permit.device_id
            AND attestation.binding_id=permit.binding_id
            AND attestation.binding_revision=permit.binding_revision
            AND attestation.permit_contract_version=$9
            AND attestation.permit_state='ATTESTED'
            AND attestation.expires_at>$8
            AND attestation_command.command_type=$10
            AND attestation_command.payload=jsonb_build_object(
              'binding_revision', attestation.binding_revision::text,
              'attestation_contract_version', '${TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_VERSION}'
            )
            AND binding.device_id=permit.device_id
            AND binding.binding_revision=permit.binding_revision
            AND binding.channel='tinder'
            AND binding.reference_kind=$11
            AND binding.binding_state='CONFIRMED'
            AND binding.human_verified=TRUE
            AND binding_permit.device_id=binding.device_id
            AND binding_permit.binding_revision=binding.binding_revision
            AND binding_permit.permit_state='CONSUMED'
            AND binding_permit.consumed_capture_id=permit.source_capture_id
            AND capture.device_id=binding.device_id
            AND capture.source_package='com.tinder'
            AND capture.capture_schema_version='tinder-visible-chat-v3'
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
          FOR UPDATE OF attestation, binding, permit, binding_permit, capture`,
        [input.commandId, input.deviceId, input.sourceCaptureId,
          TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION,
          input.attestationCommandId, input.bindingId, input.bindingRevision,
          input.now, TINDER_LOCAL_CONVERSATION_ATTESTATION_CONTRACT_VERSION,
          TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE,
          HUMAN_ARMED_CONVERSATION_REFERENCE_KIND]
      );
      return result.rows.length === 1;
    },

    // Bounded sequencing read only. It exposes no attestation handle or
    // binding data to a caller and merely distinguishes a confirmed binding
    // waiting for its local proof from one whose proof is terminally invalid.
    async getLocalConversationAttestationStateForBindingForUpdate(client, { bindingId, deviceId }) {
      const result = await client.query(
        `SELECT permit_state
           FROM ${TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE}
          WHERE binding_id=$1 AND device_id=$2
          ORDER BY issued_at DESC, command_id ASC
          LIMIT 1
          FOR UPDATE`,
        [bindingId, deviceId]
      );
      return result.rows[0]?.permit_state || null;
    },

    /**
     * V2 does not select a conversation from a Tinder/UI identifier. The only
     * admissible source is the one consumed V3 capture already bound to the
     * current human-confirmed binding revision *and* an unexpired local
     * attestation for that exact revision. No name, time, fingerprint or
     * content-derived value participates in this selection.
     */
    async getConfirmedSourceCaptureForAttestedHumanBindingForUpdate(client, { bindingId, now: currentTime }) {
      const result = await client.query(
        `SELECT binding.device_id, permit.consumed_capture_id AS source_capture_id,
                attestation.command_id AS attestation_command_id,
                binding.binding_id, binding.binding_revision
           FROM ${HUMAN_ARMED_CONVERSATION_BINDING_TABLE} binding
           JOIN ${TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE} attestation
             ON attestation.binding_id=binding.binding_id
            AND attestation.binding_revision=binding.binding_revision
            AND attestation.device_id=binding.device_id
           JOIN device_bridge_commands attestation_command
             ON attestation_command.command_id=attestation.command_id
            JOIN ${HUMAN_ARMED_CONVERSATION_PERMIT_TABLE} permit
              ON permit.binding_id=binding.binding_id
           JOIN tinder_visible_chat_captures capture
             ON capture.capture_id=permit.consumed_capture_id
          WHERE binding.binding_id=$1
            AND binding.channel='tinder'
            AND binding.reference_kind=$2
            AND binding.binding_state='CONFIRMED'
             AND binding.human_verified=TRUE
             AND binding.device_id IS NOT NULL
             AND attestation.permit_contract_version=$3
             AND attestation.permit_state='ATTESTED'
             AND attestation.expires_at>$4
             AND attestation_command.command_type=$5
             AND attestation_command.payload=jsonb_build_object(
               'binding_revision', attestation.binding_revision::text,
               'attestation_contract_version', '${TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_VERSION}'
             )
             AND permit.device_id=binding.device_id
            AND permit.binding_revision=binding.binding_revision
            AND permit.permit_state='CONSUMED'
            AND permit.consumed_capture_id IS NOT NULL
            AND capture.device_id=binding.device_id
            AND capture.source_package='com.tinder'
            AND capture.capture_schema_version='tinder-visible-chat-v3'
             AND capture.capture_safety_status='SAFE'
             AND capture.mapping_status='RESOLVED'
             AND capture.human_review_status='CONFIRMED'
             AND capture.resolved_contact_id=binding.contact_id
             -- This is the pre-existing V4 freshness guard for the already
             -- server-bound source capture. It is not used to identify or
             -- select a Tinder conversation: that authority is the confirmed
             -- binding revision plus local attestation above.
             AND capture.capture_revision = (
               SELECT MAX(newer.capture_revision)
                 FROM tinder_visible_chat_captures newer
                WHERE newer.device_id=capture.device_id
                  AND newer.runtime_thread_fingerprint=capture.runtime_thread_fingerprint
             )
          FOR UPDATE OF binding, attestation, permit, capture`,
         [bindingId, HUMAN_ARMED_CONVERSATION_REFERENCE_KIND,
           TINDER_LOCAL_CONVERSATION_ATTESTATION_CONTRACT_VERSION, currentTime,
           TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE]
      );
      return result.rows.length === 1 ? result.rows[0] : null;
    },

    /**
     * The signed V4 ingress rechecks this immediately before it accepts a
     * transcript. The caller already owns the device lock; this locks the
     * local attestation/binding before the separate V4 permit lock, so a
     * proof invalidation and transcript ingress cannot invert each other.
     */
    async revalidateAttestedLocalConversationForSyncPermitForUpdate(client, input) {
      const result = await client.query(
        `SELECT permit.command_id
           FROM ${TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE} permit
           JOIN ${TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE} attestation
             ON attestation.command_id=permit.attestation_command_id
           JOIN device_bridge_commands attestation_command
             ON attestation_command.command_id=attestation.command_id
           JOIN ${HUMAN_ARMED_CONVERSATION_BINDING_TABLE} binding
             ON binding.binding_id=permit.binding_id
          WHERE permit.command_id=$1
            AND permit.device_id=$2
            AND permit.permit_contract_version=$3
            AND permit.attestation_command_id=$4
            AND permit.binding_id=$5
            AND permit.binding_revision=$6
            AND attestation.device_id=permit.device_id
            AND attestation.binding_id=permit.binding_id
            AND attestation.binding_revision=permit.binding_revision
            AND attestation.permit_contract_version=$7
            AND attestation.permit_state='ATTESTED'
            AND attestation.expires_at>$8
            AND attestation_command.command_type=$9
            AND attestation_command.payload=jsonb_build_object(
              'binding_revision', attestation.binding_revision::text,
              'attestation_contract_version', '${TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_CONTRACT_VERSION}'
            )
            AND binding.device_id=permit.device_id
            AND binding.binding_revision=permit.binding_revision
            AND binding.channel='tinder'
            AND binding.reference_kind=$10
            AND binding.binding_state='CONFIRMED'
            AND binding.human_verified=TRUE
          FOR UPDATE OF attestation, binding`,
        [input.commandId, input.deviceId,
          TINDER_VISIBLE_CHAT_SYNC_ATTESTED_PERMIT_CONTRACT_VERSION,
          input.attestationCommandId, input.bindingId, input.bindingRevision,
          TINDER_LOCAL_CONVERSATION_ATTESTATION_CONTRACT_VERSION,
          input.now, TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE,
          HUMAN_ARMED_CONVERSATION_REFERENCE_KIND]
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
