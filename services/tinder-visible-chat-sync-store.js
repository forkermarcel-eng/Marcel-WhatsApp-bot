import crypto from "node:crypto";
import {
  createTinderVisibleChatSyncService,
  TinderVisibleChatSyncError,
  TINDER_VISIBLE_CHAT_SYNC_REASON,
  TINDER_VISIBLE_CHAT_SYNC_STATUS
} from "./tinder-visible-chat-sync.js";

/* ==================================================
TINDER V4 BOUNDED VISIBLE-CHAT TRANSCRIPT STORE

The Android envelope is deliberately identity-free.  It contains no name,
thread identifier, contact identifier, source capture identifier, binding
identifier, or UI header value.  The only conversation target comes from the
server-side staged permit created by the authenticated dashboard action.

`transcript_fingerprint` is a bounded command-scoped integrity/dedupe value,
not a T2 capture or identity reference. `source_class_name` is accepted solely
to validate the exact bounded Android wire format and is discarded before
persistence. Neither is an identity, matching, or routing input here.
================================================== */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const CANONICAL_TEXT = /^(?![\s\S]*[\u0000-\u001f\u007f])[\s\S]+$/;

export const TINDER_VISIBLE_CHAT_SYNC_SCHEMA_VERSION = "tinder-visible-chat-sync-v1";
export const TINDER_VISIBLE_CHAT_SYNC_SOURCE_PACKAGE = "com.tinder";
// V4 is assembled from the bounded V3 scroll grammar, not the legacy
// one-window V2 capture grammar.  Keeping this value exact avoids accepting a
// superficially similar, unreviewed Android payload.
export const TINDER_VISIBLE_CHAT_SYNC_LAYOUT_SCHEMA_VERSION = "tinder-zte-visible-chat-scroll-v1";
export const TINDER_VISIBLE_CHAT_SYNC_MAX_SEGMENTS = 8;
export const TINDER_VISIBLE_CHAT_SYNC_MAX_MESSAGES = 100;
export const TINDER_VISIBLE_CHAT_SYNC_MAX_TEXT_LENGTH = 4096;
export const TINDER_VISIBLE_CHAT_SYNC_MAX_CLASS_LENGTH = 256;
export const TINDER_VISIBLE_CHAT_SYNC_MAX_SYNC_WINDOW_MS = 2 * 60_000;

export class TinderVisibleChatSyncStoreError extends Error {
  constructor(message, code = "INVALID_TINDER_VISIBLE_CHAT_SYNC", statusCode = 400) {
    super(message);
    this.name = "TinderVisibleChatSyncStoreError";
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

function invalid(message, code = "INVALID_TINDER_VISIBLE_CHAT_SYNC") {
  throw new TinderVisibleChatSyncStoreError(message, code);
}

function uuid(value, field) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UUID_V4.test(normalized)) invalid(`${field} is invalid.`, "INVALID_TINDER_VISIBLE_CHAT_SYNC");
  return normalized;
}

function canonicalText(value, field, maximum) {
  const text = typeof value === "string" ? value : "";
  if (!text || text.length > maximum || !CANONICAL_TEXT.test(text)) {
    invalid(`${field} is invalid.`, "INVALID_TINDER_VISIBLE_CHAT_SYNC");
  }
  return text;
}

function timestamp(value, field) {
  const raw = typeof value === "string" && value.length <= 64 ? value : "";
  const parsed = new Date(raw);
  if (!raw || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== raw) {
    invalid(`${field} is invalid.`, "INVALID_TINDER_VISIBLE_CHAT_SYNC");
  }
  return parsed;
}

function boundedInteger(value, field, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    invalid(`${field} is invalid.`, "INVALID_TINDER_VISIBLE_CHAT_SYNC");
  }
  return value;
}

function normalizeMessage(value, expectedOrder) {
  if (!exactKeys(value, ["visible_order", "text", "direction", "source_class_name"])) {
    invalid("Visible-chat message shape is invalid.", "INVALID_TINDER_VISIBLE_CHAT_SYNC");
  }
  const order = boundedInteger(value.visible_order, "visible_order", { min: expectedOrder, max: expectedOrder });
  const direction = typeof value.direction === "string" ? value.direction.trim().toUpperCase() : "";
  if (!new Set(["INCOMING", "OUTGOING"]).has(direction)) {
    invalid("Visible-chat message direction is invalid.", "INVALID_TINDER_VISIBLE_CHAT_SYNC");
  }
  const text = canonicalText(value.text, "Visible-chat message text", TINDER_VISIBLE_CHAT_SYNC_MAX_TEXT_LENGTH);
  // Validate the Android source class for grammar integrity, but discard it.
  canonicalText(value.source_class_name, "Visible-chat source class", TINDER_VISIBLE_CHAT_SYNC_MAX_CLASS_LENGTH);
  return Object.freeze({ visibleOrder: order, direction, text });
}

/**
 * Parses the Android V4 body to an identity-free persistence shape.
 * No caller receives Android node class values or any identity-bearing field.
 */
export function normalizeTinderVisibleChatSync(value) {
  const keys = [
    "schema_version", "command_id", "source_package", "layout_schema_version",
    "sync_started_at", "sync_completed_at", "initial_visible_node_count",
    "final_visible_node_count", "segment_count", "overlap_count",
    "transcript_fingerprint", "messages", "safety_status"
  ];
  if (!exactKeys(value, keys)) {
    invalid("Visible-chat sync contains unsupported fields.", "INVALID_TINDER_VISIBLE_CHAT_SYNC");
  }
  if (value.schema_version !== TINDER_VISIBLE_CHAT_SYNC_SCHEMA_VERSION
      || value.source_package !== TINDER_VISIBLE_CHAT_SYNC_SOURCE_PACKAGE
      || value.layout_schema_version !== TINDER_VISIBLE_CHAT_SYNC_LAYOUT_SCHEMA_VERSION
      || value.safety_status !== "SAFE") {
    invalid("Visible-chat sync contract is invalid.", "INVALID_TINDER_VISIBLE_CHAT_SYNC");
  }

  const commandId = uuid(value.command_id, "command_id");
  const syncStartedAt = timestamp(value.sync_started_at, "sync_started_at");
  const syncCompletedAt = timestamp(value.sync_completed_at, "sync_completed_at");
  if (syncCompletedAt.valueOf() < syncStartedAt.valueOf()
      || syncCompletedAt.valueOf() - syncStartedAt.valueOf() > TINDER_VISIBLE_CHAT_SYNC_MAX_SYNC_WINDOW_MS) {
    invalid("Visible-chat sync timing is invalid.", "INVALID_TINDER_VISIBLE_CHAT_SYNC");
  }
  const initialVisibleNodeCount = boundedInteger(value.initial_visible_node_count,
    "initial_visible_node_count", { min: 1, max: 5000 });
  const finalVisibleNodeCount = boundedInteger(value.final_visible_node_count,
    "final_visible_node_count", { min: 1, max: 5000 });
  const segmentCount = boundedInteger(value.segment_count, "segment_count", {
    min: 1, max: TINDER_VISIBLE_CHAT_SYNC_MAX_SEGMENTS
  });
  const overlapCount = boundedInteger(value.overlap_count, "overlap_count", {
    min: 0, max: TINDER_VISIBLE_CHAT_SYNC_MAX_MESSAGES
  });
  if (typeof value.transcript_fingerprint !== "string" || !SHA256_HEX.test(value.transcript_fingerprint)) {
    invalid("Visible-chat transcript fingerprint is invalid.", "INVALID_TINDER_VISIBLE_CHAT_SYNC");
  }
  if (!Array.isArray(value.messages) || value.messages.length < 1
      || value.messages.length > TINDER_VISIBLE_CHAT_SYNC_MAX_MESSAGES) {
    invalid("Visible-chat messages are invalid.", "INVALID_TINDER_VISIBLE_CHAT_SYNC");
  }
  const messages = Object.freeze(value.messages.map((message, index) => normalizeMessage(message, index + 1)));

  return Object.freeze({
    commandId,
    schemaVersion: TINDER_VISIBLE_CHAT_SYNC_SCHEMA_VERSION,
    sourcePackage: TINDER_VISIBLE_CHAT_SYNC_SOURCE_PACKAGE,
    layoutSchemaVersion: TINDER_VISIBLE_CHAT_SYNC_LAYOUT_SCHEMA_VERSION,
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

function requireRepository(repository) {
  for (const method of [
    "withTransaction",
    "getConfirmedSourceCaptureForUpdate",
    "insertVisibleChatSyncTranscript"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
}

function requireStoredTranscript(row) {
  const syncId = typeof row?.syncId === "string" ? row.syncId : row?.sync_id;
  if (!UUID_V4.test(String(syncId || ""))) {
    throw new TinderVisibleChatSyncStoreError(
      "Visible-chat sync persistence returned an invalid result.",
      "SYNC_TRANSCRIPT_WRITE_FAILED",
      500
    );
  }
}

/**
 * Atomically validates the staged server-side target, stores a sanitized V4
 * transcript, and consumes the one-time permit.  It intentionally returns
 * only a bounded acceptance state; the product reader owns all later detail
 * projection.
 */
export function createTinderVisibleChatSyncStore(repository, {
  now = () => new Date(),
  createSyncId = () => crypto.randomUUID(),
  createSyncService = createTinderVisibleChatSyncService
} = {}) {
  requireRepository(repository);
  const syncService = createSyncService(repository, { now });

  async function storeStagedVisibleChatSync({ deviceId, sync } = {}) {
    const normalizedDeviceId = uuid(deviceId, "device_id");
    const normalizedSync = normalizeTinderVisibleChatSync(sync);
    if (normalizedSync.commandId === normalizedDeviceId) {
      invalid("Visible-chat sync command is invalid.", "INVALID_TINDER_VISIBLE_CHAT_SYNC");
    }

    return repository.withTransaction(async transaction => {
      const staged = await syncService.authorizeStagedVisibleChatSyncPermit(transaction, {
        commandId: normalizedSync.commandId,
        deviceId: normalizedDeviceId
      });
      if (staged.status !== TINDER_VISIBLE_CHAT_SYNC_STATUS.STAGED) {
        return staged;
      }

      const authorization = staged.authorization;
      const sourceReady = await repository.getConfirmedSourceCaptureForUpdate(transaction, {
        sourceCaptureId: authorization.sourceCaptureId,
        deviceId: authorization.deviceId
      });
      if (sourceReady !== true) {
        return Object.freeze({
          status: TINDER_VISIBLE_CHAT_SYNC_STATUS.PERMIT_NOT_AVAILABLE,
          reasonCode: TINDER_VISIBLE_CHAT_SYNC_REASON.SOURCE_CAPTURE_NOT_CONFIRMED
        });
      }

      const syncId = uuid(createSyncId(), "sync_id");
      const stored = await repository.insertVisibleChatSyncTranscript(transaction, {
        syncId,
        commandId: authorization.commandId,
        sourceCaptureId: authorization.sourceCaptureId,
        deviceId: authorization.deviceId,
        ...normalizedSync,
        receivedAt: new Date(now()).toISOString()
      });
      requireStoredTranscript(stored);

      const consumed = await syncService.consumeAuthorizedStagedVisibleChatSyncPermit(transaction, {
        authorization
      });
      if (consumed.status !== TINDER_VISIBLE_CHAT_SYNC_STATUS.CONSUMED) {
        throw new TinderVisibleChatSyncStoreError(
          "Visible-chat sync permit could not be consumed.",
          "SYNC_PERMIT_CONSUME_FAILED",
          409
        );
      }
      return Object.freeze({ status: "ACCEPTED" });
    });
  }

  return Object.freeze({ storeStagedVisibleChatSync });
}
