import crypto from "node:crypto";
import { DEVICE_BRIDGE_PROTOCOL, T1_DEVICE_CAPABILITIES } from "../device-bridge/protocol-v1.js";

/* ==================================================
T5 HUMAN-APPROVED TINDER SEND CONTRACT

This is deliberately a sealed, future-writer contract.  It can record an
immutable approval and reserve exactly one server-owned SEND_TINDER_DRAFT
intent, but it never inserts into device_bridge_commands and never touches a
device, browser, accessibility service, or Tinder network endpoint.

The active T0/T1 heartbeat/ACK path must remain unchanged until a separately
reviewed Android writer has durable point-of-no-return handling.  In
particular, a current non-terminal Device Bridge command can be delivered more
than once, which is unacceptable for a physical send action.
================================================== */

const TINDER_SEND_COMMAND_TYPE = "SEND_TINDER_DRAFT";
const TINDER_THREAD_REF_KIND = "runtime_thread_fingerprint_v1";
const TINDER_MANUAL_SEND_CAPABILITY = "TINDER_DRAFT_SEND_V1";
const TINDER_T5_PAYLOAD_VERSION = "tinder_t5_send_v1";

/* This exact profile is a future contract only.  protocol-v1.js intentionally
does not yet accept it, so an existing T0/T1 Android runtime cannot receive a
send intent by accident. */
const FUTURE_T5_DEVICE_CAPABILITIES = Object.freeze([
  ...T1_DEVICE_CAPABILITIES,
  TINDER_MANUAL_SEND_CAPABILITY
]);

const TINDER_APPROVAL_STATE = Object.freeze({
  ACTIVE: "ACTIVE",
  INVALIDATED: "INVALIDATED",
  CANCELLED: "CANCELLED"
});

const TINDER_SEND_INTENT_STATE = Object.freeze({
  PENDING_T5_WRITER: "PENDING_T5_WRITER",
  DISPATCHING: "DISPATCHING",
  SENT: "SENT",
  FAILED: "FAILED",
  STALE: "STALE",
  CANCELLED: "CANCELLED",
  SEND_RESULT_UNKNOWN: "SEND_RESULT_UNKNOWN"
});

const TINDER_SEND_OUTCOME = Object.freeze({
  RECEIVED: "RECEIVED",
  SENT: "SENT",
  FAILED: "FAILED",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
  SEND_RESULT_UNKNOWN: "SEND_RESULT_UNKNOWN"
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const DRAFT_STATUSES = new Set(["DRAFT", "APPROVED", "REJECTED", "STALE"]);
const INTENT_STATES = new Set(Object.values(TINDER_SEND_INTENT_STATE));
const APPROVAL_STATES = new Set(Object.values(TINDER_APPROVAL_STATE));
const SEND_OUTCOMES = new Set(Object.values(TINDER_SEND_OUTCOME));

class TinderManualSendError extends Error {
  constructor(message, code = "TINDER_SEND_NOT_ALLOWED", statusCode = 409) {
    super(message);
    this.name = "TinderManualSendError";
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

function normalizedState(value) {
  return String(value ?? "").trim().toUpperCase();
}

function exactArray(left, right) {
  return Array.isArray(left) && left.length === right.length &&
    left.every((item, index) => item === right[index]);
}

function normalizeCapabilities(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizedUuid(value, field, statusCode = 400) {
  const identifier = String(value || "").trim();
  if (!UUID_V4.test(identifier)) {
    throw new TinderManualSendError(`${field} ist ungültig.`, `INVALID_${field.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, statusCode);
  }
  return identifier;
}

function positiveInteger(value, field, statusCode = 409) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TinderManualSendError(`${field} ist ungültig.`, `INVALID_${field.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, statusCode);
  }
  return number;
}

function normalizedHash(value, field, statusCode = 409) {
  const hash = String(value || "").trim().toLowerCase();
  if (!SHA256_HEX.test(hash)) {
    throw new TinderManualSendError(`${field} ist ungültig.`, `INVALID_${field.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, statusCode);
  }
  return hash;
}

function normalizedText(value, field = "Draft", statusCode = 409) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 8000) {
    throw new TinderManualSendError(`${field} ist ungültig.`, `INVALID_${field.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, statusCode);
  }
  return text;
}

function normalizedActor(value) {
  const actor = String(value || "marcel_dashboard").trim();
  if (!actor || actor.length > 80) {
    throw new TinderManualSendError("Der Freigabe-Akteur ist ungültig.", "INVALID_APPROVAL_ACTOR", 400);
  }
  return actor;
}

function normalizedTimestamp(value, field, statusCode = 409) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new TinderManualSendError(`${field} ist ungültig.`, `INVALID_${field.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, statusCode);
  }
  return date.toISOString();
}

function nowIso(now) {
  return normalizedTimestamp(now?.(), "Zeit", 500);
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function approvalBindingHash(binding) {
  return crypto.createHash("sha256").update(stableJson({
    draft_id: binding.draftId,
    draft_revision: binding.draftRevision,
    contact_id: binding.contactId,
    capture_id: binding.captureId,
    capture_fingerprint: binding.captureFingerprint,
    thread_ref_kind: binding.threadRefKind,
    thread_ref: binding.runtimeThreadFingerprint,
    capture_revision: binding.captureRevision,
    identity_revision: binding.identityRevision,
    text_sha256: binding.approvedTextSha256
  }), "utf8").digest("hex");
}

/*
 * The future Android writer persists only content-free descriptor metadata.
 * These two hashes bind that descriptor to the exact server-owned command
 * payload without reusing a weaker approval hash as a payload identity.
 * `stableJson` sorts object keys, making this format independently
 * reproducible by a later reviewed Android parser.
 */
function sealedFuturePayloadHash(payload) {
  const sealed = { ...payload };
  delete sealed.sealed_payload_sha256;
  delete sealed.command_fingerprint;
  return crypto.createHash("sha256").update(stableJson(sealed), "utf8").digest("hex");
}

function futureCommandFingerprint({ commandId, intentId, sealedPayloadHash }) {
  return crypto.createHash("sha256").update(stableJson({
    version: TINDER_T5_PAYLOAD_VERSION,
    command_id: commandId,
    command_type: TINDER_SEND_COMMAND_TYPE,
    protocol_version: DEVICE_BRIDGE_PROTOCOL.version,
    intent_id: intentId,
    sealed_payload_sha256: sealedPayloadHash
  }), "utf8").digest("hex");
}

function futureT5Capable(value) {
  return exactArray(normalizeCapabilities(value), FUTURE_T5_DEVICE_CAPABILITIES);
}

function statusFromHeartbeat(lastAcceptedHeartbeatAt, now) {
  if (!lastAcceptedHeartbeatAt) return "OFFLINE";
  const timestamp = new Date(lastAcceptedHeartbeatAt);
  if (Number.isNaN(timestamp.valueOf())) return "OFFLINE";
  const age = now.valueOf() - timestamp.valueOf();
  return age >= 0 && age <= DEVICE_BRIDGE_PROTOCOL.offlineAfterSeconds * 1000
    ? "ONLINE"
    : "OFFLINE";
}

function normalizeDraftSnapshot(row) {
  if (!plainObject(row)) {
    throw new TinderManualSendError("Der Tinder-Draft wurde nicht gefunden.", "DRAFT_NOT_FOUND", 404);
  }
  const draftStatus = normalizedState(sourceValue(row, "draftStatus", "draft_status") ?? row.status);
  if (!DRAFT_STATUSES.has(draftStatus)) {
    throw new TinderManualSendError("Der gespeicherte Draft-Status ist ungültig.", "INVALID_DRAFT_STATE", 409);
  }
  const snapshot = {
    draftId: normalizedUuid(sourceValue(row, "draftId", "draft_id"), "Draft-ID", 409),
    draftStatus,
    draftRevision: positiveInteger(sourceValue(row, "draftRevision", "draft_revision") ?? 1, "Draft-Revision"),
    contactId: positiveInteger(sourceValue(row, "contactId", "contact_id"), "Kontakt-ID"),
    captureId: normalizedUuid(sourceValue(row, "captureId", "capture_id"), "Capture-ID", 409),
    captureRevision: positiveInteger(sourceValue(row, "captureRevision", "capture_revision"), "Capture-Revision"),
    latestCaptureRevision: positiveInteger(
      sourceValue(row, "latestCaptureRevision", "latest_capture_revision") ?? sourceValue(row, "captureRevision", "capture_revision"),
      "Aktuelle Capture-Revision"
    ),
    captureFingerprint: normalizedHash(sourceValue(row, "captureFingerprint", "capture_fingerprint"), "Capture-Fingerprint"),
    runtimeThreadFingerprint: normalizedHash(sourceValue(row, "runtimeThreadFingerprint", "runtime_thread_fingerprint"), "Thread-Fingerprint"),
    // A draft is bound to the identity revision observed at creation.  The
    // capture can subsequently be remapped/re-reviewed without changing the
    // draft row, so its current revision must be loaded separately and checked
    // before an approval or future intent is allowed.
    identityRevision: positiveInteger(
      sourceValue(row, "draftIdentityRevision", "draft_identity_revision"),
      "Draft-Identitäts-Revision"
    ),
    currentIdentityRevision: positiveInteger(
      sourceValue(row, "currentIdentityRevision", "current_identity_revision"),
      "Aktuelle Identitäts-Revision"
    ),
    originalDraft: normalizedText(sourceValue(row, "originalDraft", "original_draft"), "Draft"),
    captureSafetyStatus: normalizedState(sourceValue(row, "captureSafetyStatus", "capture_safety_status")),
    mappingStatus: normalizedState(sourceValue(row, "mappingStatus", "mapping_status")),
    humanReviewStatus: normalizedState(sourceValue(row, "humanReviewStatus", "human_review_status")),
    resolvedContactId: positiveInteger(sourceValue(row, "resolvedContactId", "resolved_contact_id"), "Aufgelöste Kontakt-ID"),
    deviceId: normalizedUuid(sourceValue(row, "deviceId", "device_id"), "Device-ID", 409),
    enrollmentState: normalizedState(sourceValue(row, "deviceEnrollmentState", "device_enrollment_state")),
    bridgeState: normalizedState(sourceValue(row, "bridgeServiceState", "bridge_service_state")),
    tinderState: normalizedState(sourceValue(row, "tinderState", "tinder_state")),
    automationState: normalizedState(sourceValue(row, "automationState", "automation_state")),
    capabilities: normalizeCapabilities(sourceValue(row, "deviceCapabilities", "device_capabilities") ?? row.capabilities),
    lastAcceptedHeartbeatAt: sourceValue(row, "lastAcceptedHeartbeatAt", "last_accepted_heartbeat_at"),
    humanTakeoverActive: sourceValue(row, "humanTakeoverActive", "human_takeover_active"),
    handoffActive: sourceValue(row, "handoffActive", "handoff_active")
  };
  return Object.freeze(snapshot);
}

function normalizeApproval(row) {
  if (!plainObject(row)) return null;
  const state = normalizedState(row.state);
  if (!APPROVAL_STATES.has(state)) {
    throw new TinderManualSendError("Die gespeicherte Draft-Freigabe ist ungültig.", "INVALID_APPROVAL_RECORD", 500);
  }
  const approval = {
    approvalId: normalizedUuid(sourceValue(row, "approvalId", "approval_id"), "Freigabe-ID", 500),
    draftId: normalizedUuid(sourceValue(row, "draftId", "draft_id"), "Draft-ID", 500),
    draftRevision: positiveInteger(sourceValue(row, "draftRevision", "draft_revision"), "Draft-Revision", 500),
    contactId: positiveInteger(sourceValue(row, "contactId", "contact_id"), "Kontakt-ID", 500),
    captureId: normalizedUuid(sourceValue(row, "captureId", "capture_id"), "Capture-ID", 500),
    captureFingerprint: normalizedHash(sourceValue(row, "captureFingerprint", "capture_fingerprint"), "Capture-Fingerprint", 500),
    threadRefKind: String(sourceValue(row, "threadRefKind", "thread_ref_kind") || "").trim(),
    runtimeThreadFingerprint: normalizedHash(sourceValue(row, "runtimeThreadFingerprint", "runtime_thread_fingerprint"), "Thread-Fingerprint", 500),
    captureRevision: positiveInteger(sourceValue(row, "captureRevision", "capture_revision"), "Capture-Revision", 500),
    identityRevision: positiveInteger(sourceValue(row, "identityRevision", "identity_revision"), "Identitäts-Revision", 500),
    approvedTextSha256: normalizedHash(sourceValue(row, "approvedTextSha256", "approved_text_sha256"), "Freigabe-Text-Hash", 500),
    approvalBindingSha256: normalizedHash(sourceValue(row, "approvalBindingSha256", "approval_binding_sha256"), "Freigabe-Bindung", 500),
    approvedBy: normalizedActor(sourceValue(row, "approvedBy", "approved_by")),
    approvedAt: normalizedTimestamp(sourceValue(row, "approvedAt", "approved_at"), "Freigabe-Zeit", 500),
    state
  };
  if (approval.threadRefKind !== TINDER_THREAD_REF_KIND) {
    throw new TinderManualSendError("Die gespeicherte Thread-Referenz ist ungültig.", "INVALID_APPROVAL_RECORD", 500);
  }
  return Object.freeze(approval);
}

function normalizeIntent(row) {
  if (!plainObject(row)) return null;
  const state = normalizedState(row.state);
  if (!INTENT_STATES.has(state)) {
    throw new TinderManualSendError("Der gespeicherte Send-Intent ist ungültig.", "INVALID_SEND_INTENT", 500);
  }
  return Object.freeze({
    intentId: normalizedUuid(sourceValue(row, "intentId", "intent_id"), "Intent-ID", 500),
    approvalId: normalizedUuid(sourceValue(row, "approvalId", "approval_id"), "Freigabe-ID", 500),
    draftId: normalizedUuid(sourceValue(row, "draftId", "draft_id"), "Draft-ID", 500),
    draftRevision: positiveInteger(sourceValue(row, "draftRevision", "draft_revision"), "Draft-Revision", 500),
    commandId: normalizedUuid(sourceValue(row, "commandId", "command_id"), "Command-ID", 500),
    deliveryPolicyRevision: (() => {
      const value = String(sourceValue(row, "deliveryPolicyRevision", "delivery_policy_revision") || "").trim();
      if (!/^[A-Za-z0-9._:-]{1,120}$/.test(value)) {
        throw new TinderManualSendError("Der gespeicherte Send-Intent ist ungültig.", "INVALID_SEND_INTENT", 500);
      }
      return value;
    })(),
    notBefore: normalizedTimestamp(sourceValue(row, "notBefore", "not_before"), "Policy-Start", 500),
    expiresAt: normalizedTimestamp(sourceValue(row, "expiresAt", "expires_at"), "Policy-Ablauf", 500),
    typingDurationMs: (() => {
      const value = Number(sourceValue(row, "typingDurationMs", "typing_duration_ms"));
      if (!Number.isSafeInteger(value) || value < 0 || value > 900000) {
        throw new TinderManualSendError("Der gespeicherte Send-Intent ist ungültig.", "INVALID_SEND_INTENT", 500);
      }
      return value;
    })(),
    state,
    receivedAt: sourceValue(row, "receivedAt", "received_at")
      ? normalizedTimestamp(sourceValue(row, "receivedAt", "received_at"), "Received-Zeit", 500) : null,
    completedAt: sourceValue(row, "completedAt", "completed_at")
      ? normalizedTimestamp(sourceValue(row, "completedAt", "completed_at"), "Abschluss-Zeit", 500) : null,
    resultCode: row.resultCode ?? row.result_code ?? null,
    createdAt: sourceValue(row, "createdAt", "created_at")
      ? normalizedTimestamp(sourceValue(row, "createdAt", "created_at"), "Intent-Zeit", 500) : null
  });
}

/*
 * This is deliberately a dashboard-review projection, not a capture reader.
 * It contains the draft Marcel must review, but never contact/device
 * identifiers, capture/thread fingerprints, hashes, payloads, approval IDs,
 * intent IDs, or raw captured Tinder content.
 */
function normalizeDraftReview(row, expectedCaptureId) {
  if (!plainObject(row)) {
    throw new TinderManualSendError("Für dieses Capture liegt kein aktueller Tinder-Draft vor.", "DRAFT_REVIEW_NOT_FOUND", 404);
  }
  const review = {
    draftId: normalizedUuid(sourceValue(row, "draftId", "draft_id"), "Draft-ID", 500),
    captureId: normalizedUuid(sourceValue(row, "captureId", "capture_id"), "Capture-ID", 500),
    draftRevision: positiveInteger(sourceValue(row, "draftRevision", "draft_revision"), "Draft-Revision", 500),
    captureRevision: positiveInteger(sourceValue(row, "captureRevision", "capture_revision"), "Capture-Revision", 500),
    identityRevision: positiveInteger(sourceValue(row, "draftIdentityRevision", "draft_identity_revision"), "Identitäts-Revision", 500),
    status: normalizedState(sourceValue(row, "draftStatus", "draft_status") ?? row.status),
    approvalState: (() => {
      const value = sourceValue(row, "approvalState", "approval_state");
      return value === null || value === undefined ? null : normalizedState(value);
    })(),
    intentState: (() => {
      const value = sourceValue(row, "intentState", "intent_state");
      return value === null || value === undefined ? null : normalizedState(value);
    })(),
    originalDraft: normalizedText(sourceValue(row, "originalDraft", "original_draft"), "Draft", 500),
    controlDraftDe: (() => {
      const value = sourceValue(row, "controlDraftDe", "control_draft_de");
      return value === null || value === undefined ? null : normalizedText(value, "Kontroll-Draft", 500);
    })(),
    sourceLanguage: (() => {
      const value = sourceValue(row, "sourceLanguage", "source_language");
      if (value === null || value === undefined) return null;
      const language = String(value).trim();
      if (!/^[A-Za-z-]{2,32}$/.test(language)) {
        throw new TinderManualSendError("Der gespeicherte Tinder-Draft ist ungültig.", "INVALID_DRAFT_REVIEW", 500);
      }
      return language;
    })(),
    modelVersion: (() => {
      const value = String(sourceValue(row, "modelVersion", "model_version") || "").trim();
      if (!value || value.length > 160) {
        throw new TinderManualSendError("Der gespeicherte Tinder-Draft ist ungültig.", "INVALID_DRAFT_REVIEW", 500);
      }
      return value;
    })(),
    createdAt: normalizedTimestamp(sourceValue(row, "createdAt", "created_at"), "Draft-Zeit", 500)
  };
  if (review.captureId !== expectedCaptureId || !DRAFT_STATUSES.has(review.status) ||
      (review.approvalState !== null && !APPROVAL_STATES.has(review.approvalState)) ||
      (review.intentState !== null && !INTENT_STATES.has(review.intentState))) {
    throw new TinderManualSendError("Der gespeicherte Tinder-Draft ist ungültig.", "INVALID_DRAFT_REVIEW", 500);
  }
  return Object.freeze(review);
}

function approvalFromSnapshot(snapshot, { approvalId, actor, approvedAt }) {
  const approvedTextSha256 = sha256Text(snapshot.originalDraft);
  const approval = {
    approvalId: normalizedUuid(approvalId, "Freigabe-ID", 500),
    draftId: snapshot.draftId,
    draftRevision: snapshot.draftRevision,
    contactId: snapshot.contactId,
    captureId: snapshot.captureId,
    captureFingerprint: snapshot.captureFingerprint,
    threadRefKind: TINDER_THREAD_REF_KIND,
    runtimeThreadFingerprint: snapshot.runtimeThreadFingerprint,
    captureRevision: snapshot.captureRevision,
    identityRevision: snapshot.identityRevision,
    approvedTextSha256,
    approvedBy: normalizedActor(actor),
    approvedAt: normalizedTimestamp(approvedAt, "Freigabe-Zeit", 500),
    state: TINDER_APPROVAL_STATE.ACTIVE
  };
  approval.approvalBindingSha256 = approvalBindingHash(approval);
  return Object.freeze(approval);
}

function sameApprovalBinding(approval, snapshot) {
  const textHash = sha256Text(snapshot.originalDraft);
  return approval.draftId === snapshot.draftId &&
    approval.draftRevision === snapshot.draftRevision &&
    approval.contactId === snapshot.contactId &&
    approval.captureId === snapshot.captureId &&
    approval.captureFingerprint === snapshot.captureFingerprint &&
    approval.threadRefKind === TINDER_THREAD_REF_KIND &&
    approval.runtimeThreadFingerprint === snapshot.runtimeThreadFingerprint &&
    approval.captureRevision === snapshot.captureRevision &&
    approval.identityRevision === snapshot.identityRevision &&
    approval.approvedTextSha256 === textHash &&
    approval.approvalBindingSha256 === approvalBindingHash({
      ...approval,
      approvedTextSha256: textHash
    });
}

function assertIdentityAndCaptureReady(snapshot) {
  if (snapshot.captureSafetyStatus !== "SAFE") {
    throw new TinderManualSendError("Das Capture ist nicht send-sicher.", "CAPTURE_NOT_SAFE");
  }
  if (snapshot.mappingStatus !== "RESOLVED" || snapshot.humanReviewStatus !== "CONFIRMED" ||
      snapshot.resolvedContactId !== snapshot.contactId) {
    throw new TinderManualSendError("Die zentrale Kontaktzuordnung ist nicht bestätigt.", "IDENTITY_NOT_CONFIRMED");
  }
  if (snapshot.identityRevision !== snapshot.currentIdentityRevision) {
    throw new TinderManualSendError("Die Identitätsbindung des Captures hat sich geändert.", "IDENTITY_REVISION_CHANGED");
  }
  if (snapshot.captureRevision !== snapshot.latestCaptureRevision) {
    throw new TinderManualSendError("Ein neueres Capture macht den Draft ungültig.", "NEWER_CAPTURE_REVISION");
  }
  if (snapshot.humanTakeoverActive !== false) {
    throw new TinderManualSendError("Ein menschlicher Takeover ist aktiv oder unklar.", "HUMAN_TAKEOVER_ACTIVE");
  }
  if (snapshot.handoffActive !== false) {
    throw new TinderManualSendError("Ein Handoff ist aktiv oder unklar.", "HANDOFF_ACTIVE");
  }
}

function assertFutureWriterGates(snapshot, now) {
  if (statusFromHeartbeat(snapshot.lastAcceptedHeartbeatAt, now) !== "ONLINE") {
    throw new TinderManualSendError("Das Device ist nicht online.", "DEVICE_OFFLINE");
  }
  if (snapshot.enrollmentState !== "ACTIVE") {
    throw new TinderManualSendError("Das Device-Enrollment ist nicht aktiv.", "DEVICE_ENROLLMENT_INACTIVE");
  }
  if (!futureT5Capable(snapshot.capabilities)) {
    throw new TinderManualSendError("Ein verifizierter T5-Writer ist nicht verfügbar.", "T5_WRITER_UNAVAILABLE");
  }
  if (snapshot.bridgeState !== "RUNNING") {
    throw new TinderManualSendError("Die Bridge läuft nicht.", "BRIDGE_NOT_RUNNING");
  }
  if (snapshot.tinderState === "AUTH_REQUIRED") {
    throw new TinderManualSendError("Tinder benötigt eine Authentifizierung.", "TINDER_AUTH_REQUIRED");
  }
  if (snapshot.tinderState === "REVIEW_REQUIRED") {
    throw new TinderManualSendError("Tinder benötigt eine manuelle Prüfung.", "TINDER_REVIEW_REQUIRED");
  }
  if (snapshot.tinderState === "UNKNOWN") {
    throw new TinderManualSendError("Der Tinder-Zustand ist unbekannt.", "TINDER_STATE_UNKNOWN");
  }
  if (snapshot.tinderState !== "CONNECTED") {
    throw new TinderManualSendError("Das Tinder Manual Gate ist nicht verbunden.", "TINDER_GATE_NOT_CONNECTED");
  }
  if (snapshot.automationState !== "STOPPED") {
    throw new TinderManualSendError("Die Automation muss gestoppt bleiben.", "AUTOMATION_NOT_STOPPED");
  }
}

function normalizeDeliveryPlan(value, now) {
  if (!plainObject(value)) {
    throw new TinderManualSendError("Eine serverseitige Delivery Policy ist nicht verfügbar.", "DELIVERY_POLICY_UNAVAILABLE");
  }
  const revision = String(value.revision ?? value.policyRevision ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(revision)) {
    throw new TinderManualSendError("Die serverseitige Delivery Policy ist ungültig.", "INVALID_DELIVERY_POLICY", 500);
  }
  const notBefore = normalizedTimestamp(value.notBefore ?? value.not_before, "Policy-Start", 500);
  const expiresAt = normalizedTimestamp(value.expiresAt ?? value.expires_at, "Policy-Ablauf", 500);
  const typingDurationMs = Number(value.typingDurationMs ?? value.typing_duration_ms);
  if (!Number.isSafeInteger(typingDurationMs) || typingDurationMs < 0 || typingDurationMs > 900000 ||
      new Date(expiresAt).valueOf() <= new Date(notBefore).valueOf() ||
      new Date(expiresAt).valueOf() <= now.valueOf()) {
    throw new TinderManualSendError("Die serverseitige Delivery Policy ist ungültig.", "INVALID_DELIVERY_POLICY", 500);
  }
  return Object.freeze({ revision, notBefore, expiresAt, typingDurationMs });
}

function presentApproval(approval, idempotent = false) {
  return Object.freeze({
    approvalId: approval.approvalId,
    draftId: approval.draftId,
    draftRevision: approval.draftRevision,
    state: approval.state,
    approvedAt: approval.approvedAt,
    idempotent
  });
}

function presentIntent(intent, idempotent = false) {
  return Object.freeze({
    intentId: intent.intentId,
    commandId: intent.commandId,
    approvalId: intent.approvalId,
    draftId: intent.draftId,
    draftRevision: intent.draftRevision,
    state: intent.state,
    receivedAt: intent.receivedAt,
    completedAt: intent.completedAt,
    resultCode: intent.resultCode,
    idempotent
  });
}

function intentFromApproval(approval, plan, { intentId, commandId, createdAt }) {
  return Object.freeze({
    intentId: normalizedUuid(intentId, "Intent-ID", 500),
    commandId: normalizedUuid(commandId, "Command-ID", 500),
    approvalId: approval.approvalId,
    draftId: approval.draftId,
    draftRevision: approval.draftRevision,
    contactId: approval.contactId,
    captureId: approval.captureId,
    captureFingerprint: approval.captureFingerprint,
    threadRefKind: approval.threadRefKind,
    runtimeThreadFingerprint: approval.runtimeThreadFingerprint,
    identityRevision: approval.identityRevision,
    approvedTextSha256: approval.approvedTextSha256,
    approvalBindingSha256: approval.approvalBindingSha256,
    commandType: TINDER_SEND_COMMAND_TYPE,
    protocolVersion: DEVICE_BRIDGE_PROTOCOL.version,
    deliveryPolicyRevision: plan.revision,
    notBefore: plan.notBefore,
    expiresAt: plan.expiresAt,
    typingDurationMs: plan.typingDurationMs,
    state: TINDER_SEND_INTENT_STATE.PENDING_T5_WRITER,
    receivedAt: null,
    completedAt: null,
    resultCode: null,
    createdAt
  });
}

function assertIntentMatchesApproval(intent, approval) {
  return intent.approvalId === approval.approvalId &&
    intent.draftId === approval.draftId &&
    intent.draftRevision === approval.draftRevision;
}

function requireRepository(repository) {
  for (const method of [
    "withTransaction",
    "lockDraftSnapshot",
    "findCurrentDraftReviewByCapture",
    "findApprovalForDraftRevision",
    "findActiveApprovalForDraft",
    "insertApproval",
    "updateDraftStatus",
    "invalidateApproval",
    "findIntentForApproval",
    "insertIntent",
    "updateIntent",
    "findIntentByCommand",
    "insertAudit"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
}

function safeAuditDetails(value) {
  const details = plainObject(value) ? value : {};
  const safe = {};
  for (const [key, item] of Object.entries(details)) {
    if (["draftRevision", "captureRevision", "identityRevision"].includes(key) && Number.isSafeInteger(item)) {
      safe[key] = item;
    } else if (["approvalBindingSha256", "approvedTextSha256"].includes(key) && SHA256_HEX.test(String(item || ""))) {
      safe[key] = item;
    } else if (["reasonCode", "resultCode"].includes(key) && /^[A-Z0-9_]{1,120}$/.test(String(item || ""))) {
      safe[key] = item;
    } else if (key === "policyRevision" && /^[A-Za-z0-9._:-]{1,120}$/.test(String(item || ""))) {
      safe[key] = item;
    }
  }
  return safe;
}

function shouldInvalidateFor(error) {
  return new Set([
    "NEWER_CAPTURE_REVISION",
    "IDENTITY_NOT_CONFIRMED",
    "IDENTITY_REVISION_CHANGED",
    "HUMAN_TAKEOVER_ACTIVE",
    "HANDOFF_ACTIVE",
    "APPROVAL_BINDING_CHANGED"
  ]).has(error?.code);
}

function futureCommandPayload(snapshot, approval, intent) {
  const binding = {
    payload_version: TINDER_T5_PAYLOAD_VERSION,
    intent_id: intent.intentId,
    command_id: intent.commandId,
    approval_id: approval.approvalId,
    draft_id: approval.draftId,
    draft_revision: String(approval.draftRevision),
    contact_id: String(approval.contactId),
    capture_id: approval.captureId,
    capture_fingerprint: approval.captureFingerprint,
    thread_ref_kind: approval.threadRefKind,
    thread_ref_hash: approval.runtimeThreadFingerprint,
    identity_revision: String(approval.identityRevision),
    approved_text: snapshot.originalDraft,
    approved_text_sha256: approval.approvedTextSha256,
    approval_binding_sha256: approval.approvalBindingSha256,
    delivery_policy_revision: intent.deliveryPolicyRevision,
    not_before: intent.notBefore,
    expires_at: intent.expiresAt,
    typing_duration_ms: String(intent.typingDurationMs)
  };
  const sealedPayloadHash = sealedFuturePayloadHash(binding);
  const payload = {
    ...binding,
    sealed_payload_sha256: sealedPayloadHash,
    command_fingerprint: futureCommandFingerprint({
      commandId: intent.commandId,
      intentId: intent.intentId,
      sealedPayloadHash
    })
  };
  assertFutureTinderSendPayload(payload);
  return Object.freeze(payload);
}

function assertFutureTinderSendPayload(payload) {
  const fields = [
    "payload_version", "intent_id", "command_id", "approval_id", "draft_id", "draft_revision", "contact_id", "capture_id",
    "capture_fingerprint", "thread_ref_kind", "thread_ref_hash", "identity_revision",
    "approved_text", "approved_text_sha256", "approval_binding_sha256",
    "delivery_policy_revision", "not_before", "expires_at", "typing_duration_ms",
    "sealed_payload_sha256", "command_fingerprint"
  ];
  if (!plainObject(payload) || Object.keys(payload).length !== fields.length ||
      Object.keys(payload).some(key => !fields.includes(key)) ||
      Object.values(payload).some(value => typeof value !== "string")) {
    throw new TinderManualSendError("Der zukünftige Send-Command ist ungültig.", "INVALID_SEND_COMMAND_PAYLOAD", 500);
  }
  if (payload.payload_version !== TINDER_T5_PAYLOAD_VERSION) {
    throw new TinderManualSendError("Der zukünftige Send-Command ist ungültig.", "INVALID_SEND_COMMAND_PAYLOAD", 500);
  }
  normalizedUuid(payload.intent_id, "Intent-ID", 500);
  normalizedUuid(payload.command_id, "Command-ID", 500);
  normalizedUuid(payload.approval_id, "Freigabe-ID", 500);
  normalizedUuid(payload.draft_id, "Draft-ID", 500);
  normalizedUuid(payload.capture_id, "Capture-ID", 500);
  positiveInteger(payload.draft_revision, "Draft-Revision", 500);
  positiveInteger(payload.contact_id, "Kontakt-ID", 500);
  positiveInteger(payload.identity_revision, "Identitäts-Revision", 500);
  normalizedHash(payload.capture_fingerprint, "Capture-Fingerprint", 500);
  normalizedHash(payload.thread_ref_hash, "Thread-Fingerprint", 500);
  normalizedHash(payload.approved_text_sha256, "Freigabe-Text-Hash", 500);
  normalizedHash(payload.approval_binding_sha256, "Freigabe-Bindung", 500);
  normalizedHash(payload.sealed_payload_sha256, "Sealed-Payload-Hash", 500);
  normalizedHash(payload.command_fingerprint, "Command-Fingerprint", 500);
  if (payload.thread_ref_kind !== TINDER_THREAD_REF_KIND ||
      sha256Text(normalizedText(payload.approved_text, "Freigabe-Text", 500)) !== payload.approved_text_sha256 ||
      !/^[A-Za-z0-9._:-]{1,120}$/.test(payload.delivery_policy_revision) ||
      !/^\d+$/.test(payload.typing_duration_ms) || Number(payload.typing_duration_ms) > 900000) {
    throw new TinderManualSendError("Der zukünftige Send-Command ist ungültig.", "INVALID_SEND_COMMAND_PAYLOAD", 500);
  }
  const notBefore = normalizedTimestamp(payload.not_before, "Policy-Start", 500);
  const expiresAt = normalizedTimestamp(payload.expires_at, "Policy-Ablauf", 500);
  if (new Date(expiresAt).valueOf() <= new Date(notBefore).valueOf() ||
      sealedFuturePayloadHash(payload) !== payload.sealed_payload_sha256 ||
      futureCommandFingerprint({
        commandId: payload.command_id,
        intentId: payload.intent_id,
        sealedPayloadHash: payload.sealed_payload_sha256
      }) !== payload.command_fingerprint) {
    throw new TinderManualSendError("Der zukünftige Send-Command ist ungültig.", "INVALID_SEND_COMMAND_PAYLOAD", 500);
  }
  return true;
}

/**
 * Server-owned T5 contract.  The deliveryPolicy adapter is deliberately
 * optional at construction time but a missing policy blocks reservation; this
 * repository currently has no shared delivery-policy implementation.
 */
function createTinderManualSendService({
  repository,
  now = () => new Date(),
  createApprovalId = () => crypto.randomUUID(),
  createIntentId = () => crypto.randomUUID(),
  createCommandId = () => crypto.randomUUID(),
  deliveryPolicy = async () => null
} = {}) {
  requireRepository(repository);
  if (typeof deliveryPolicy !== "function") throw new TypeError("deliveryPolicy must be a function");

  async function invalidateForChangedSnapshot(transaction, approval, error, actor, timestamp) {
    if (!shouldInvalidateFor(error)) return;
    await repository.invalidateApproval(transaction, approval.approvalId, {
      state: TINDER_APPROVAL_STATE.INVALIDATED,
      reasonCode: error.code,
      changedAt: timestamp
    });
    await repository.insertAudit(transaction, {
      action: "APPROVAL_INVALIDATED",
      actor,
      approvalId: approval.approvalId,
      draftId: approval.draftId,
      reasonCode: error.code,
      details: safeAuditDetails({ reasonCode: error.code, approvalBindingSha256: approval.approvalBindingSha256 })
    });
  }

  async function approveDraft({ draftId, actor = "marcel_dashboard" } = {}) {
    const normalizedDraftId = normalizedUuid(draftId, "Draft-ID");
    const normalizedActorValue = normalizedActor(actor);
    const timestamp = nowIso(now);
    return repository.withTransaction(async (transaction) => {
      const snapshot = normalizeDraftSnapshot(await repository.lockDraftSnapshot(transaction, normalizedDraftId));
      const existing = normalizeApproval(
        await repository.findApprovalForDraftRevision(transaction, snapshot.draftId, snapshot.draftRevision)
      );
      // Load any active approval before validating the live capture snapshot.
      // A later human remap can advance capture.identity_revision while the
      // older approval is still ACTIVE.  The approval must then be closed and
      // audited atomically instead of becoming an invisible stale authority.
      const activeApproval = existing?.state === TINDER_APPROVAL_STATE.ACTIVE
        ? existing
        : normalizeApproval(await repository.findActiveApprovalForDraft(transaction, snapshot.draftId));
      try {
        assertIdentityAndCaptureReady(snapshot);
      } catch (error) {
        if (activeApproval?.state === TINDER_APPROVAL_STATE.ACTIVE) {
          await invalidateForChangedSnapshot(
            transaction,
            activeApproval,
            error,
            normalizedActorValue,
            timestamp
          );
        }
        throw error;
      }
      if (existing) {
        if (existing.state === TINDER_APPROVAL_STATE.ACTIVE && sameApprovalBinding(existing, snapshot) &&
            snapshot.draftStatus === "APPROVED") {
          return presentApproval(existing, true);
        }
        if (existing.state === TINDER_APPROVAL_STATE.ACTIVE && !sameApprovalBinding(existing, snapshot)) {
          await repository.invalidateApproval(transaction, existing.approvalId, {
            state: TINDER_APPROVAL_STATE.INVALIDATED,
            reasonCode: "APPROVAL_BINDING_CHANGED",
            changedAt: timestamp
          });
          await repository.insertAudit(transaction, {
            action: "APPROVAL_INVALIDATED",
            actor: normalizedActorValue,
            approvalId: existing.approvalId,
            draftId: existing.draftId,
            reasonCode: "APPROVAL_BINDING_CHANGED",
            details: safeAuditDetails({ reasonCode: "APPROVAL_BINDING_CHANGED", approvalBindingSha256: existing.approvalBindingSha256 })
          });
          throw new TinderManualSendError("Der Draft oder seine Bindung hat sich seit der Freigabe geändert.", "APPROVAL_BINDING_CHANGED");
        }
        throw new TinderManualSendError("Diese Draft-Revision darf nicht erneut freigegeben werden.", "APPROVAL_ALREADY_FINALIZED");
      }
      if (snapshot.draftStatus !== "DRAFT") {
        throw new TinderManualSendError("Nur ein aktueller DRAFT kann freigegeben werden.", "DRAFT_NOT_APPROVABLE");
      }
      const priorActiveApproval = activeApproval;
      if (priorActiveApproval) {
        await repository.invalidateApproval(transaction, priorActiveApproval.approvalId, {
          state: TINDER_APPROVAL_STATE.INVALIDATED,
          reasonCode: "DRAFT_REVISION_CHANGED",
          changedAt: timestamp
        });
        await repository.insertAudit(transaction, {
          action: "APPROVAL_INVALIDATED",
          actor: normalizedActorValue,
          approvalId: priorActiveApproval.approvalId,
          draftId: priorActiveApproval.draftId,
          reasonCode: "DRAFT_REVISION_CHANGED",
          details: safeAuditDetails({ reasonCode: "DRAFT_REVISION_CHANGED", approvalBindingSha256: priorActiveApproval.approvalBindingSha256 })
        });
      }
      const approval = approvalFromSnapshot(snapshot, {
        approvalId: createApprovalId(),
        actor: normalizedActorValue,
        approvedAt: timestamp
      });
      await repository.insertApproval(transaction, approval);
      await repository.updateDraftStatus(transaction, snapshot.draftId, "APPROVED", null);
      await repository.insertAudit(transaction, {
        action: "APPROVAL_CREATED",
        actor: normalizedActorValue,
        approvalId: approval.approvalId,
        draftId: approval.draftId,
        reasonCode: null,
        details: safeAuditDetails({
          draftRevision: approval.draftRevision,
          captureRevision: approval.captureRevision,
          identityRevision: approval.identityRevision,
          approvedTextSha256: approval.approvedTextSha256,
          approvalBindingSha256: approval.approvalBindingSha256
        })
      });
      return presentApproval(approval, false);
    });
  }

  async function getDraftReviewForCapture({ captureId } = {}) {
    const normalizedCaptureId = normalizedUuid(captureId, "Capture-ID");
    return normalizeDraftReview(
      await repository.findCurrentDraftReviewByCapture(normalizedCaptureId),
      normalizedCaptureId
    );
  }

  async function reserveApprovedSend({ draftId, actor = "marcel_dashboard" } = {}) {
    const normalizedDraftId = normalizedUuid(draftId, "Draft-ID");
    const normalizedActorValue = normalizedActor(actor);
    const timestamp = nowIso(now);
    const currentNow = new Date(timestamp);
    return repository.withTransaction(async (transaction) => {
      const snapshot = normalizeDraftSnapshot(await repository.lockDraftSnapshot(transaction, normalizedDraftId));
      const approval = normalizeApproval(
        await repository.findApprovalForDraftRevision(transaction, snapshot.draftId, snapshot.draftRevision)
      );
      if (!approval) {
        const priorActiveApproval = normalizeApproval(
          await repository.findActiveApprovalForDraft(transaction, snapshot.draftId)
        );
        if (priorActiveApproval) {
          await repository.invalidateApproval(transaction, priorActiveApproval.approvalId, {
            state: TINDER_APPROVAL_STATE.INVALIDATED,
            reasonCode: "DRAFT_REVISION_CHANGED",
            changedAt: timestamp
          });
          await repository.insertAudit(transaction, {
            action: "APPROVAL_INVALIDATED",
            actor: normalizedActorValue,
            approvalId: priorActiveApproval.approvalId,
            draftId: priorActiveApproval.draftId,
            reasonCode: "DRAFT_REVISION_CHANGED",
            details: safeAuditDetails({ reasonCode: "DRAFT_REVISION_CHANGED", approvalBindingSha256: priorActiveApproval.approvalBindingSha256 })
          });
        }
        throw new TinderManualSendError("Der Draft wurde nicht explizit freigegeben.", "DRAFT_NOT_APPROVED");
      }
      if (approval.state !== TINDER_APPROVAL_STATE.ACTIVE) {
        throw new TinderManualSendError("Die Draft-Freigabe ist nicht mehr aktiv.", "APPROVAL_NOT_ACTIVE");
      }
      try {
        assertIdentityAndCaptureReady(snapshot);
        if (snapshot.draftStatus !== "APPROVED") {
          throw new TinderManualSendError("Der Draft ist nicht mehr freigegeben.", "DRAFT_NOT_APPROVED");
        }
        if (!sameApprovalBinding(approval, snapshot)) {
          throw new TinderManualSendError("Der Draft oder seine Bindung hat sich seit der Freigabe geändert.", "APPROVAL_BINDING_CHANGED");
        }
      } catch (error) {
        await invalidateForChangedSnapshot(transaction, approval, error, normalizedActorValue, timestamp);
        throw error;
      }
      const existing = normalizeIntent(await repository.findIntentForApproval(transaction, approval.approvalId));
      if (existing) {
        if (!assertIntentMatchesApproval(existing, approval)) {
          throw new TinderManualSendError("Der vorhandene Send-Intent ist inkonsistent.", "SEND_INTENT_INCONSISTENT", 500);
        }
        if ([TINDER_SEND_INTENT_STATE.PENDING_T5_WRITER, TINDER_SEND_INTENT_STATE.DISPATCHING].includes(existing.state)) {
          return presentIntent(existing, true);
        }
        throw new TinderManualSendError("Für diese Freigabe existiert bereits ein terminaler Send-Vorgang.", "SEND_ATTEMPT_ALREADY_TERMINAL");
      }
      assertFutureWriterGates(snapshot, currentNow);
      const plan = normalizeDeliveryPlan(await deliveryPolicy(Object.freeze({
        draftId: snapshot.draftId,
        draftRevision: snapshot.draftRevision,
        contactId: snapshot.contactId,
        captureId: snapshot.captureId,
        approvalId: approval.approvalId
      })), currentNow);
      const intent = intentFromApproval(approval, plan, {
        intentId: createIntentId(),
        commandId: createCommandId(),
        createdAt: timestamp
      });
      await repository.insertIntent(transaction, intent);
      await repository.insertAudit(transaction, {
        action: "SEND_INTENT_RESERVED",
        actor: normalizedActorValue,
        approvalId: approval.approvalId,
        intentId: intent.intentId,
        draftId: approval.draftId,
        reasonCode: null,
        details: safeAuditDetails({
          draftRevision: approval.draftRevision,
          approvedTextSha256: approval.approvedTextSha256,
          approvalBindingSha256: approval.approvalBindingSha256,
          policyRevision: plan.revision
        })
      });
      return presentIntent(intent, false);
    });
  }

  async function rejectDraft({ draftId, actor = "marcel_dashboard" } = {}) {
    const normalizedDraftId = normalizedUuid(draftId, "Draft-ID");
    const normalizedActorValue = normalizedActor(actor);
    return repository.withTransaction(async (transaction) => {
      const snapshot = normalizeDraftSnapshot(await repository.lockDraftSnapshot(transaction, normalizedDraftId));
      if (snapshot.draftStatus === "REJECTED") {
        return Object.freeze({ draftId: snapshot.draftId, draftRevision: snapshot.draftRevision, state: "REJECTED", idempotent: true });
      }
      if (snapshot.draftStatus !== "DRAFT") {
        throw new TinderManualSendError("Nur ein nicht freigegebener Draft kann abgelehnt werden.", "DRAFT_NOT_REJECTABLE");
      }
      const approval = normalizeApproval(
        await repository.findApprovalForDraftRevision(transaction, snapshot.draftId, snapshot.draftRevision)
      );
      if (approval) {
        throw new TinderManualSendError("Ein freigegebener Draft muss widerrufen werden.", "DRAFT_ALREADY_APPROVED");
      }
      await repository.updateDraftStatus(transaction, snapshot.draftId, "REJECTED", null);
      await repository.insertAudit(transaction, {
        action: "DRAFT_REJECTED",
        actor: normalizedActorValue,
        draftId: snapshot.draftId,
        reasonCode: "MANUAL_REJECTED",
        details: safeAuditDetails({ reasonCode: "MANUAL_REJECTED", draftRevision: snapshot.draftRevision })
      });
      return Object.freeze({ draftId: snapshot.draftId, draftRevision: snapshot.draftRevision, state: "REJECTED", idempotent: false });
    });
  }

  async function cancelApprovedSend({ draftId, actor = "marcel_dashboard" } = {}) {
    const normalizedDraftId = normalizedUuid(draftId, "Draft-ID");
    const normalizedActorValue = normalizedActor(actor);
    const timestamp = nowIso(now);
    return repository.withTransaction(async (transaction) => {
      const snapshot = normalizeDraftSnapshot(await repository.lockDraftSnapshot(transaction, normalizedDraftId));
      const approval = normalizeApproval(
        await repository.findApprovalForDraftRevision(transaction, snapshot.draftId, snapshot.draftRevision)
      );
      if (!approval || approval.state !== TINDER_APPROVAL_STATE.ACTIVE) {
        throw new TinderManualSendError("Es gibt keine aktive Draft-Freigabe zum Widerrufen.", "APPROVAL_NOT_ACTIVE");
      }
      const intent = normalizeIntent(await repository.findIntentForApproval(transaction, approval.approvalId));
      if (intent?.receivedAt) {
        const unknown = await repository.updateIntent(transaction, intent.intentId, {
          state: TINDER_SEND_INTENT_STATE.SEND_RESULT_UNKNOWN,
          completedAt: timestamp,
          resultCode: "CANCEL_AFTER_RECEIPT"
        });
        await repository.invalidateApproval(transaction, approval.approvalId, {
          state: TINDER_APPROVAL_STATE.INVALIDATED,
          reasonCode: "CANCEL_AFTER_RECEIPT",
          changedAt: timestamp
        });
        await repository.insertAudit(transaction, {
          action: "SEND_RESULT_UNKNOWN",
          actor: normalizedActorValue,
          approvalId: approval.approvalId,
          intentId: intent.intentId,
          draftId: approval.draftId,
          reasonCode: "CANCEL_AFTER_RECEIPT",
          details: safeAuditDetails({ reasonCode: "CANCEL_AFTER_RECEIPT" })
        });
        return presentIntent(normalizeIntent(unknown), false);
      }
      if (intent && ![TINDER_SEND_INTENT_STATE.PENDING_T5_WRITER, TINDER_SEND_INTENT_STATE.DISPATCHING].includes(intent.state)) {
        return presentIntent(intent, true);
      }
      const cancelledIntent = intent
        ? normalizeIntent(await repository.updateIntent(transaction, intent.intentId, {
          state: TINDER_SEND_INTENT_STATE.CANCELLED,
          completedAt: timestamp,
          resultCode: "MANUAL_CANCELLED"
        }))
        : null;
      await repository.invalidateApproval(transaction, approval.approvalId, {
        state: TINDER_APPROVAL_STATE.CANCELLED,
        reasonCode: "MANUAL_CANCELLED",
        changedAt: timestamp
      });
      await repository.insertAudit(transaction, {
        action: "APPROVAL_CANCELLED",
        actor: normalizedActorValue,
        approvalId: approval.approvalId,
        intentId: cancelledIntent?.intentId || null,
        draftId: approval.draftId,
        reasonCode: "MANUAL_CANCELLED",
        details: safeAuditDetails({ reasonCode: "MANUAL_CANCELLED" })
      });
      return cancelledIntent
        ? presentIntent(cancelledIntent, false)
        : Object.freeze({ draftId: approval.draftId, draftRevision: approval.draftRevision, state: "CANCELLED", idempotent: false });
    });
  }

  /* Internal future-ACK projection only.  No active endpoint invokes this
  method while the Android writer is absent. */
  async function recordFutureSendOutcome({ commandId, outcome, actor = "device_bridge_future" } = {}) {
    const normalizedCommandId = normalizedUuid(commandId, "Command-ID");
    const normalizedOutcome = normalizedState(outcome);
    if (!SEND_OUTCOMES.has(normalizedOutcome)) {
      throw new TinderManualSendError("Das Send-Ergebnis ist ungültig.", "INVALID_SEND_OUTCOME", 400);
    }
    const normalizedActorValue = normalizedActor(actor);
    const timestamp = nowIso(now);
    return repository.withTransaction(async (transaction) => {
      const intent = normalizeIntent(await repository.findIntentByCommand(transaction, normalizedCommandId));
      if (!intent) throw new TinderManualSendError("Der Send-Intent wurde nicht gefunden.", "SEND_INTENT_NOT_FOUND", 404);
      const terminal = new Set([
        TINDER_SEND_INTENT_STATE.SENT,
        TINDER_SEND_INTENT_STATE.FAILED,
        TINDER_SEND_INTENT_STATE.CANCELLED,
        TINDER_SEND_INTENT_STATE.STALE,
        TINDER_SEND_INTENT_STATE.SEND_RESULT_UNKNOWN
      ]);
      if (terminal.has(intent.state)) {
        return presentIntent(intent, true);
      }
      let patch;
      let auditAction;
      if (normalizedOutcome === TINDER_SEND_OUTCOME.RECEIVED) {
        patch = { state: TINDER_SEND_INTENT_STATE.DISPATCHING, receivedAt: timestamp, resultCode: "RECEIVED" };
        auditAction = "SEND_RECEIVED";
      } else if (normalizedOutcome === TINDER_SEND_OUTCOME.SENT) {
        patch = { state: TINDER_SEND_INTENT_STATE.SENT, completedAt: timestamp, resultCode: "SENT" };
        auditAction = "SEND_SUCCEEDED";
      } else if (normalizedOutcome === TINDER_SEND_OUTCOME.REJECTED || normalizedOutcome === TINDER_SEND_OUTCOME.EXPIRED) {
        patch = intent.receivedAt
          ? { state: TINDER_SEND_INTENT_STATE.SEND_RESULT_UNKNOWN, completedAt: timestamp, resultCode: normalizedOutcome }
          : { state: TINDER_SEND_INTENT_STATE.CANCELLED, completedAt: timestamp, resultCode: normalizedOutcome };
        auditAction = patch.state === TINDER_SEND_INTENT_STATE.CANCELLED ? "SEND_CANCELLED" : "SEND_RESULT_UNKNOWN";
      } else if (normalizedOutcome === TINDER_SEND_OUTCOME.FAILED) {
        patch = intent.receivedAt
          ? { state: TINDER_SEND_INTENT_STATE.SEND_RESULT_UNKNOWN, completedAt: timestamp, resultCode: "FAILED_AFTER_RECEIPT" }
          : { state: TINDER_SEND_INTENT_STATE.FAILED, completedAt: timestamp, resultCode: "FAILED" };
        auditAction = patch.state === TINDER_SEND_INTENT_STATE.FAILED ? "SEND_FAILED" : "SEND_RESULT_UNKNOWN";
      } else {
        patch = { state: TINDER_SEND_INTENT_STATE.SEND_RESULT_UNKNOWN, completedAt: timestamp, resultCode: "SEND_RESULT_UNKNOWN" };
        auditAction = "SEND_RESULT_UNKNOWN";
      }
      const updated = normalizeIntent(await repository.updateIntent(transaction, intent.intentId, patch));
      await repository.insertAudit(transaction, {
        action: auditAction,
        actor: normalizedActorValue,
        approvalId: updated.approvalId,
        intentId: updated.intentId,
        draftId: updated.draftId,
        reasonCode: updated.resultCode,
        details: safeAuditDetails({ resultCode: updated.resultCode })
      });
      return presentIntent(updated, false);
    });
  }

  async function buildReservedFutureCommand({ draftId } = {}) {
    const normalizedDraftId = normalizedUuid(draftId, "Draft-ID");
    return repository.withTransaction(async (transaction) => {
      const snapshot = normalizeDraftSnapshot(await repository.lockDraftSnapshot(transaction, normalizedDraftId));
      const approval = normalizeApproval(await repository.findApprovalForDraftRevision(transaction, snapshot.draftId, snapshot.draftRevision));
      if (!approval || approval.state !== TINDER_APPROVAL_STATE.ACTIVE || !sameApprovalBinding(approval, snapshot)) {
        throw new TinderManualSendError("Die Freigabe für den zukünftigen Send-Command ist nicht gültig.", "APPROVAL_NOT_ACTIVE");
      }
      const intent = normalizeIntent(await repository.findIntentForApproval(transaction, approval.approvalId));
      if (!intent || intent.state !== TINDER_SEND_INTENT_STATE.PENDING_T5_WRITER) {
        throw new TinderManualSendError("Es gibt keinen reservierten zukünftigen Send-Command.", "SEND_INTENT_NOT_PENDING");
      }
      return Object.freeze({
        commandId: intent.commandId,
        commandType: TINDER_SEND_COMMAND_TYPE,
        protocolVersion: DEVICE_BRIDGE_PROTOCOL.version,
        payload: futureCommandPayload(snapshot, approval, intent)
      });
    });
  }

  return Object.freeze({
    approveDraft,
    getDraftReviewForCapture,
    reserveApprovedSend,
    rejectDraft,
    cancelApprovedSend,
    recordFutureSendOutcome,
    buildReservedFutureCommand
  });
}

function createPgTinderManualSendRepository(pool) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new TypeError("pool.query and pool.connect must be functions");
  }
  function singleRow(result) {
    return result.rows[0] || null;
  }
  const snapshotSql = `
    SELECT
      draft.draft_id, draft.status AS draft_status, draft.draft_revision,
      draft.contact_id, draft.capture_id, draft.runtime_thread_fingerprint,
      draft.capture_revision, draft.identity_revision AS draft_identity_revision, draft.original_draft,
      capture.identity_revision AS current_identity_revision,
      capture.capture_fingerprint, capture.capture_safety_status,
      capture.mapping_status, capture.human_review_status,
      capture.resolved_contact_id, capture.device_id,
      capture.human_takeover_active, capture.handoff_active,
      device.enrollment_state AS device_enrollment_state,
      device.bridge_service_state, device.tinder_state, device.automation_state,
      device.capabilities AS device_capabilities,
      device.last_accepted_heartbeat_at,
      (
        SELECT MAX(newer.capture_revision)
        FROM tinder_visible_chat_captures newer
        WHERE newer.device_id = capture.device_id
          AND newer.runtime_thread_fingerprint = capture.runtime_thread_fingerprint
      ) AS latest_capture_revision
    FROM tinder_reply_drafts draft
    JOIN tinder_visible_chat_captures capture ON capture.capture_id = draft.capture_id
    JOIN device_bridge_devices device ON device.device_id = capture.device_id
    WHERE draft.draft_id = $1`;
  // A review returns the current capture-bound draft.  If a remap made an
  // already-approved older draft stale, return that single outstanding
  // approval as STALE solely so the human can explicitly cancel it.  It can
  // never be approved again or dispatched through this reader.
  const draftReviewSql = `
    SELECT
      draft.draft_id, draft.capture_id, draft.draft_revision,
      draft.capture_revision, draft.identity_revision AS draft_identity_revision,
      CASE
        WHEN draft.capture_revision = capture.capture_revision
         AND draft.identity_revision = capture.identity_revision
          THEN draft.status
        ELSE 'STALE'
      END AS draft_status,
      draft.original_draft, draft.control_draft_de,
      draft.source_language, draft.model_version, draft.created_at,
      approval.state AS approval_state,
      intent.state AS intent_state
    FROM tinder_reply_drafts draft
    JOIN tinder_visible_chat_captures capture ON capture.capture_id = draft.capture_id
    LEFT JOIN LATERAL (
      SELECT approval_record.approval_id, approval_record.state
      FROM tinder_reply_send_approvals approval_record
      WHERE approval_record.draft_id = draft.draft_id
        AND approval_record.draft_revision = draft.draft_revision
      ORDER BY approval_record.approved_at DESC, approval_record.approval_id DESC
      LIMIT 1
    ) approval ON TRUE
    LEFT JOIN LATERAL (
      SELECT intent_record.state
      FROM tinder_reply_send_intents intent_record
      WHERE intent_record.approval_id = approval.approval_id
      ORDER BY intent_record.created_at DESC, intent_record.intent_id DESC
      LIMIT 1
    ) intent ON TRUE
    WHERE draft.capture_id = $1
      AND (
        (draft.capture_revision = capture.capture_revision
          AND draft.identity_revision = capture.identity_revision)
        OR (draft.status = 'APPROVED' AND approval.state = 'ACTIVE')
      )
    ORDER BY
      CASE
        WHEN draft.capture_revision = capture.capture_revision
         AND draft.identity_revision = capture.identity_revision
          THEN 0
        ELSE 1
      END,
      draft.created_at DESC,
      draft.draft_id DESC
    LIMIT 1`;

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

    async lockDraftSnapshot(client, draftId) {
      return singleRow(await client.query(`${snapshotSql} FOR UPDATE OF draft, capture, device`, [draftId]));
    },

    async findCurrentDraftReviewByCapture(captureId) {
      return singleRow(await pool.query(draftReviewSql, [captureId]));
    },

    async findApprovalForDraftRevision(client, draftId, draftRevision) {
      return singleRow(await client.query(
        `SELECT * FROM tinder_reply_send_approvals
         WHERE draft_id=$1 AND draft_revision=$2 FOR UPDATE`,
        [draftId, draftRevision]
      ));
    },

    async findActiveApprovalForDraft(client, draftId) {
      return singleRow(await client.query(
        `SELECT * FROM tinder_reply_send_approvals
         WHERE draft_id=$1 AND state='ACTIVE'
         ORDER BY approved_at DESC, approval_id DESC
         LIMIT 1 FOR UPDATE`,
        [draftId]
      ));
    },

    async insertApproval(client, approval) {
      const result = await client.query(
        `INSERT INTO tinder_reply_send_approvals (
          approval_id, draft_id, draft_revision, contact_id, capture_id,
          capture_fingerprint, thread_ref_kind, runtime_thread_fingerprint,
          capture_revision, identity_revision, approved_text_sha256,
          approval_binding_sha256, approved_by, approved_at, state
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        RETURNING *`,
        [approval.approvalId, approval.draftId, approval.draftRevision, approval.contactId,
          approval.captureId, approval.captureFingerprint, approval.threadRefKind,
          approval.runtimeThreadFingerprint, approval.captureRevision, approval.identityRevision,
          approval.approvedTextSha256, approval.approvalBindingSha256, approval.approvedBy,
          approval.approvedAt, approval.state]
      );
      return singleRow(result);
    },

    async updateDraftStatus(client, draftId, status, staleReason) {
      const result = await client.query(
        `UPDATE tinder_reply_drafts
            SET status=$2, stale_reason=$3, updated_at=NOW()
          WHERE draft_id=$1
        RETURNING *`,
        [draftId, status, staleReason]
      );
      return singleRow(result);
    },

    async invalidateApproval(client, approvalId, { state, reasonCode, changedAt }) {
      const result = await client.query(
        `UPDATE tinder_reply_send_approvals
            SET state=$2, invalidated_reason=$3, invalidated_at=$4
          WHERE approval_id=$1
        RETURNING *`,
        [approvalId, state, reasonCode, changedAt]
      );
      return singleRow(result);
    },

    async findIntentForApproval(client, approvalId) {
      return singleRow(await client.query(
        "SELECT * FROM tinder_reply_send_intents WHERE approval_id=$1 FOR UPDATE",
        [approvalId]
      ));
    },

    async insertIntent(client, intent) {
      const result = await client.query(
        `INSERT INTO tinder_reply_send_intents (
          intent_id, approval_id, draft_id, draft_revision, contact_id,
          capture_id, capture_fingerprint, thread_ref_kind,
          runtime_thread_fingerprint, identity_revision, command_id,
          command_type, protocol_version, approved_text_sha256,
          approval_binding_sha256, delivery_policy_revision, not_before,
          expires_at, typing_duration_ms, state, created_at, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21
        ) RETURNING *`,
        [intent.intentId, intent.approvalId, intent.draftId, intent.draftRevision,
          intent.contactId, intent.captureId, intent.captureFingerprint, intent.threadRefKind,
          intent.runtimeThreadFingerprint, intent.identityRevision, intent.commandId,
          intent.commandType, intent.protocolVersion, intent.approvedTextSha256,
          intent.approvalBindingSha256, intent.deliveryPolicyRevision, intent.notBefore,
          intent.expiresAt, intent.typingDurationMs, intent.state, intent.createdAt]
      );
      return singleRow(result);
    },

    async updateIntent(client, intentId, patch) {
      const fields = [];
      const values = [intentId];
      const mapping = [
        ["state", "state"],
        ["receivedAt", "received_at"],
        ["completedAt", "completed_at"],
        ["resultCode", "result_code"]
      ];
      for (const [input, column] of mapping) {
        if (Object.hasOwn(patch, input)) {
          values.push(patch[input]);
          fields.push(`${column}=$${values.length}`);
        }
      }
      if (fields.length === 0) throw new TypeError("intent patch must not be empty");
      values.push(new Date().toISOString());
      fields.push(`updated_at=$${values.length}`);
      const result = await client.query(
        `UPDATE tinder_reply_send_intents SET ${fields.join(", ")} WHERE intent_id=$1 RETURNING *`,
        values
      );
      return singleRow(result);
    },

    async findIntentByCommand(client, commandId) {
      return singleRow(await client.query(
        "SELECT * FROM tinder_reply_send_intents WHERE command_id=$1 FOR UPDATE",
        [commandId]
      ));
    },

    async insertAudit(client, entry) {
      const result = await client.query(
        `INSERT INTO tinder_reply_send_audit (
          action, actor, source, draft_id, approval_id, intent_id, reason_code, details
        ) VALUES ($1,$2,'tinder_manual_send',$3,$4,$5,$6,$7::jsonb) RETURNING *`,
        [entry.action, entry.actor, entry.draftId, entry.approvalId || null,
          entry.intentId || null, entry.reasonCode || null, JSON.stringify(entry.details || {})]
      );
      return singleRow(result);
    }
  });
}

export {
  FUTURE_T5_DEVICE_CAPABILITIES,
  TINDER_APPROVAL_STATE,
  TINDER_MANUAL_SEND_CAPABILITY,
  TINDER_T5_PAYLOAD_VERSION,
  TINDER_SEND_COMMAND_TYPE,
  TINDER_SEND_INTENT_STATE,
  TINDER_SEND_OUTCOME,
  TINDER_THREAD_REF_KIND,
  TinderManualSendError,
  assertFutureTinderSendPayload,
  futureCommandFingerprint,
  sealedFuturePayloadHash,
  createPgTinderManualSendRepository,
  createTinderManualSendService,
  futureT5Capable,
  sha256Text
};
