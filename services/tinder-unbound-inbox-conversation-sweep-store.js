import crypto from "node:crypto";
import {
  createTinderUnboundInboxConversationSweepService,
  TinderUnboundInboxConversationSweepError,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_CONTRACT_VERSION,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STATUS
} from "./tinder-unbound-inbox-conversation-sweep.js";

/* ==================================================
UNBOUND INBOX-CONVERSATION SWEEP -- V8 TRANSCRIPT STORE

This is intentionally distinct from V4
confirmed visible-chat sync.  It accepts only a bounded, command-scoped
multi-segment transcript.  It never receives a row, contact, binding,
source-capture, capture, thread, name, or person field.
================================================== */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CANONICAL_TEXT = /^(?![\s\S]*[\u0000-\u001f\u007f])[\s\S]+$/;

export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_SCHEMA_VERSION =
  "tinder-unbound-inbox-conversation-sweep-transcript-v1";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_SOURCE_PACKAGE = "com.tinder";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_LAYOUT_SCHEMA_VERSION =
  "tinder-zte-visible-chat-scroll-v1";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_SEGMENTS = 8;
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_MESSAGES = 100;
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_TEXT_LENGTH = 4096;
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_CLASS_LENGTH = 256;
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_WINDOW_MS = 90_000;

export class TinderUnboundInboxConversationSweepStoreError extends Error {
  constructor(message, code = "INVALID_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT", statusCode = 400) {
    super(message);
    this.name = "TinderUnboundInboxConversationSweepStoreError";
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

function invalid(message, code = "INVALID_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT") {
  throw new TinderUnboundInboxConversationSweepStoreError(message, code);
}

function uuid(value, field) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UUID_V4.test(normalized)) invalid(`${field} is invalid.`);
  return normalized;
}

function canonicalText(value, field, maximum) {
  const text = typeof value === "string" ? value : "";
  if (!text || text.length > maximum || !CANONICAL_TEXT.test(text)) invalid(`${field} is invalid.`);
  return text;
}

function timestamp(value, field) {
  const raw = typeof value === "string" && value.length <= 64 ? value : "";
  const parsed = new Date(raw);
  if (!raw || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== raw) invalid(`${field} is invalid.`);
  return parsed;
}

function boundedInteger(value, field, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) invalid(`${field} is invalid.`);
  return value;
}

function normalizeMessage(value, expectedOrder) {
  if (!exactKeys(value, ["visible_order", "text", "direction", "source_class_name"])) {
    invalid("Unbound Inbox sweep transcript message shape is invalid.");
  }
  const visibleOrder = boundedInteger(value.visible_order, "visible_order", { min: expectedOrder, max: expectedOrder });
  const direction = typeof value.direction === "string" ? value.direction.trim().toUpperCase() : "";
  if (!new Set(["INBOUND", "OUTBOUND"]).has(direction)) invalid("Unbound Inbox sweep transcript message direction is invalid.");
  const text = canonicalText(value.text, "Unbound Inbox sweep transcript message text",
    TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_TEXT_LENGTH);
  // Source class helps Android validate local structure but is deliberately
  // discarded before persistence and never visible in a bounded receipt.
  canonicalText(value.source_class_name, "Unbound Inbox sweep transcript source class",
    TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_CLASS_LENGTH);
  return Object.freeze({ visibleOrder, direction, text });
}

function normalizeCanonicalMessage(value, expectedOrder) {
  if (!exactKeys(value, ["visibleOrder", "direction", "text"])) {
    invalid("Unbound Inbox sweep transcript message shape is invalid.");
  }
  const visibleOrder = boundedInteger(value.visibleOrder, "visibleOrder", { min: expectedOrder, max: expectedOrder });
  const direction = typeof value.direction === "string" ? value.direction.trim().toUpperCase() : "";
  if (!new Set(["INBOUND", "OUTBOUND"]).has(direction)) invalid("Unbound Inbox sweep transcript message direction is invalid.");
  const text = canonicalText(value.text, "Unbound Inbox sweep transcript message text",
    TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_TEXT_LENGTH);
  return Object.freeze({ visibleOrder, direction, text });
}

/** Normalizes the V8-only Android transcript envelope. */
export function normalizeTinderUnboundInboxConversationSweepTranscript(value) {
  const keys = [
    "schema_version", "command_id", "source_package", "layout_schema_version",
    "sync_started_at", "sync_completed_at", "initial_visible_node_count",
    "final_visible_node_count", "segment_count", "overlap_count",
    "transcript_fingerprint", "messages", "safety_status"
  ];
  if (!exactKeys(value, keys)) invalid("Unbound Inbox sweep transcript contains unsupported fields.");
  if (value.schema_version !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_SCHEMA_VERSION
      || value.source_package !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_SOURCE_PACKAGE
      || value.layout_schema_version !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_LAYOUT_SCHEMA_VERSION
      || value.safety_status !== "SAFE") invalid("Unbound Inbox sweep transcript contract is invalid.");
  const commandId = uuid(value.command_id, "command_id");
  const syncStartedAt = timestamp(value.sync_started_at, "sync_started_at");
  const syncCompletedAt = timestamp(value.sync_completed_at, "sync_completed_at");
  if (syncCompletedAt.valueOf() < syncStartedAt.valueOf()
      || syncCompletedAt.valueOf() - syncStartedAt.valueOf()
        > TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_WINDOW_MS) {
    invalid("Unbound Inbox sweep transcript timing is invalid.");
  }
  const initialVisibleNodeCount = boundedInteger(value.initial_visible_node_count,
    "initial_visible_node_count", { min: 1, max: 5000 });
  const finalVisibleNodeCount = boundedInteger(value.final_visible_node_count,
    "final_visible_node_count", { min: 1, max: 5000 });
  const segmentCount = boundedInteger(value.segment_count, "segment_count", {
    min: 1, max: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_SEGMENTS
  });
  const overlapCount = boundedInteger(value.overlap_count, "overlap_count", {
    min: 0, max: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_MESSAGES
  });
  if (typeof value.transcript_fingerprint !== "string" || !SHA256_HEX.test(value.transcript_fingerprint)) {
    invalid("Unbound Inbox sweep transcript fingerprint is invalid.");
  }
  if (!Array.isArray(value.messages) || value.messages.length < 1
      || value.messages.length > TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_MESSAGES) {
    invalid("Unbound Inbox sweep transcript messages are invalid.");
  }
  const messages = Object.freeze(value.messages.map((message, index) => normalizeMessage(message, index + 1)));
  return Object.freeze({
    commandId,
    schemaVersion: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_SCHEMA_VERSION,
    sourcePackage: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_SOURCE_PACKAGE,
    layoutSchemaVersion: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_LAYOUT_SCHEMA_VERSION,
    syncStartedAt: syncStartedAt.toISOString(),
    syncCompletedAt: syncCompletedAt.toISOString(),
    initialVisibleNodeCount,
    finalVisibleNodeCount,
    segmentCount,
    overlapCount,
    transcriptFingerprint: value.transcript_fingerprint,
    messages,
    safetyStatus: "SAFE"
  });
}

/* The signed ingress supplies this store with an already-normalized, exact
 * wire envelope. Validate that internal representation again without allowing
 * camelCase JSON at the external ingress boundary. */
function normalizeStoredTinderUnboundInboxConversationSweepTranscript(value) {
  if (exactKeys(value, [
    "commandId", "schemaVersion", "sourcePackage", "layoutSchemaVersion",
    "syncStartedAt", "syncCompletedAt", "initialVisibleNodeCount",
    "finalVisibleNodeCount", "segmentCount", "overlapCount",
    "transcriptFingerprint", "messages", "safetyStatus"
  ])) {
    if (value.schemaVersion !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_SCHEMA_VERSION
        || value.sourcePackage !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_SOURCE_PACKAGE
        || value.layoutSchemaVersion !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_LAYOUT_SCHEMA_VERSION
        || value.safetyStatus !== "SAFE") invalid("Unbound Inbox sweep transcript contract is invalid.");
    const commandId = uuid(value.commandId, "commandId");
    const syncStartedAt = timestamp(value.syncStartedAt, "syncStartedAt");
    const syncCompletedAt = timestamp(value.syncCompletedAt, "syncCompletedAt");
    if (syncCompletedAt.valueOf() < syncStartedAt.valueOf()
        || syncCompletedAt.valueOf() - syncStartedAt.valueOf()
          > TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_WINDOW_MS) {
      invalid("Unbound Inbox sweep transcript timing is invalid.");
    }
    const initialVisibleNodeCount = boundedInteger(value.initialVisibleNodeCount,
      "initialVisibleNodeCount", { min: 1, max: 5000 });
    const finalVisibleNodeCount = boundedInteger(value.finalVisibleNodeCount,
      "finalVisibleNodeCount", { min: 1, max: 5000 });
    const segmentCount = boundedInteger(value.segmentCount, "segmentCount", {
      min: 1, max: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_SEGMENTS
    });
    const overlapCount = boundedInteger(value.overlapCount, "overlapCount", {
      min: 0, max: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_MESSAGES
    });
    if (typeof value.transcriptFingerprint !== "string" || !SHA256_HEX.test(value.transcriptFingerprint)) {
      invalid("Unbound Inbox sweep transcript fingerprint is invalid.");
    }
    if (!Array.isArray(value.messages) || value.messages.length < 1
        || value.messages.length > TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_MAX_MESSAGES) {
      invalid("Unbound Inbox sweep transcript messages are invalid.");
    }
    return Object.freeze({
      commandId,
      schemaVersion: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_SCHEMA_VERSION,
      sourcePackage: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_SOURCE_PACKAGE,
      layoutSchemaVersion: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_LAYOUT_SCHEMA_VERSION,
      syncStartedAt: syncStartedAt.toISOString(),
      syncCompletedAt: syncCompletedAt.toISOString(),
      initialVisibleNodeCount,
      finalVisibleNodeCount,
      segmentCount,
      overlapCount,
      transcriptFingerprint: value.transcriptFingerprint,
      messages: Object.freeze(value.messages.map((message, index) => normalizeCanonicalMessage(message, index + 1))),
      safetyStatus: "SAFE"
    });
  }
  return normalizeTinderUnboundInboxConversationSweepTranscript(value);
}

function requireRepository(repository) {
  for (const method of ["withTransaction", "insertUnboundInboxConversationSweepTranscript"]) {
    if (typeof repository?.[method] !== "function") throw new TypeError(`repository.${method} must be a function`);
  }
}

function requireStoredTranscript(row, expectedTranscriptId) {
  const transcriptId = typeof row?.transcriptId === "string" ? row.transcriptId : row?.transcript_id;
  if (String(transcriptId || "").toLowerCase() !== expectedTranscriptId
      || row?.mapping_status !== "NEEDS_HUMAN_MAPPING" || row?.human_review_status !== "PENDING") {
    throw new TinderUnboundInboxConversationSweepStoreError(
      "Unbound Inbox sweep transcript persistence returned an invalid result.",
      "UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_WRITE_FAILED", 500
    );
  }
}

/**
 * Atomically locks a STAGED V8 READ child, persists an explicitly unbound
 * PENDING transcript, terminalizes that READ child, and queues one distinct
 * RETURN_ONLY child.  Any failure rolls the entire unit back.
 */
export function createTinderUnboundInboxConversationSweepStore(repository, {
  now = () => new Date(),
  createTranscriptId = () => crypto.randomUUID(),
  createSweepService = createTinderUnboundInboxConversationSweepService
} = {}) {
  requireRepository(repository);
  const sweepService = createSweepService(repository, { now });

  async function storeStagedUnboundInboxConversationSweepTranscript({ deviceId, transcript } = {}) {
    const normalizedDeviceId = uuid(deviceId, "device_id");
    const normalizedTranscript = normalizeStoredTinderUnboundInboxConversationSweepTranscript(transcript);
    if (normalizedTranscript.commandId === normalizedDeviceId) invalid("Unbound Inbox sweep transcript command is invalid.");
    return repository.withTransaction(async transaction => {
      const staged = await sweepService.authorizeIncomingSweepTranscript(transaction, {
        commandId: normalizedTranscript.commandId, deviceId: normalizedDeviceId
      });
      if (staged.status !== "STAGED") return staged;
      const transcriptId = uuid(createTranscriptId(), "transcript_id");
      const stored = await repository.insertUnboundInboxConversationSweepTranscript(transaction, {
        transcriptId,
        commandId: staged.authorization.commandId,
        deviceId: staged.authorization.deviceId,
        transcriptContractVersion: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_CONTRACT_VERSION,
        ...normalizedTranscript,
        receivedAt: new Date(now()).toISOString()
      });
      requireStoredTranscript(stored, transcriptId);
      const consumed = await sweepService.consumeAuthorizedSweepTranscript(transaction, {
        authorization: staged.authorization, transcriptId
      });
      if (consumed.status !== "RETURN_QUEUED") {
        throw new TinderUnboundInboxConversationSweepStoreError(
          "Unbound Inbox sweep transcript could not be consumed.",
          "UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_CONSUME_FAILED", 409
        );
      }
      return Object.freeze({ status: "ACCEPTED" });
    });
  }

  return Object.freeze({ storeStagedUnboundInboxConversationSweepTranscript });
}
