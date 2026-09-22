import crypto from "node:crypto";
import {
  inspectTinderProductConversationSchema,
  TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE
} from "../device-bridge/tinder-product-conversation-schema.js";

/* ==================================================
TINDER PRODUCT CONVERSATIONS

Captures are immutable technical evidence.  This module is the deliberately
small product layer above them: one device-scoped Tinder thread may have a
durable Conversation before a real-world contact has been assigned.

It never uses a visible name as a key.  The legacy runtime fingerprint is
only a candidate bucket; a new capture joins an existing Conversation only
after a unique ordered, directional message overlap.  Ambiguity stays
unassigned instead of becoming a false merge.
================================================== */

export const TINDER_PRODUCT_CONVERSATION_IDENTITY_STATE = Object.freeze({
  UNASSIGNED: "UNASSIGNED",
  BOUND: "BOUND",
  CONFLICT: "CONFLICT"
});

export const TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE = Object.freeze({
  PROVISIONAL: "PROVISIONAL",
  CORRELATED: "CORRELATED",
  AMBIGUOUS: "AMBIGUOUS"
});

export const TINDER_PRODUCT_CONVERSATION_HISTORY_STATE = Object.freeze({
  PARTIAL: "PARTIAL",
  COMPLETE: "COMPLETE"
});

export const TINDER_PRODUCT_CONVERSATION_LINK_METHOD = Object.freeze({
  INITIAL: "INITIAL",
  ORDERED_MESSAGE_OVERLAP: "ORDERED_MESSAGE_OVERLAP"
});

export const TINDER_PRODUCT_CONVERSATION_DISPOSITION = Object.freeze({
  CREATED: "CREATED",
  UPDATED: "UPDATED",
  IDEMPOTENT_DUPLICATE: "IDEMPOTENT_DUPLICATE",
  NOT_READY: "NOT_READY"
});

export const TINDER_PRODUCT_CONVERSATION_MINIMUM_ORDERED_OVERLAP = 2;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MESSAGE_DIRECTIONS = new Set(["INCOMING", "OUTGOING", "UNKNOWN"]);

export class TinderProductConversationError extends Error {
  constructor(message, code = "INVALID_TINDER_PRODUCT_CONVERSATION") {
    super(message);
    this.code = code;
  }
}

function invalid(message, code) {
  throw new TinderProductConversationError(message, code);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sourceValue(source, camelCase, snakeCase) {
  return source?.[camelCase] ?? source?.[snakeCase];
}

function uuid(value, field) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!UUID_V4.test(normalized)) invalid(`Invalid Tinder product ${field}.`, "INVALID_TINDER_PRODUCT_CONVERSATION_RECORD");
  return normalized;
}

function hash(value, field) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!SHA256_HEX.test(normalized)) invalid(`Invalid Tinder product ${field}.`, "INVALID_TINDER_PRODUCT_CONVERSATION_RECORD");
  return normalized;
}

function timestamp(value, field) {
  const parsed = value instanceof Date ? new Date(value.valueOf()) : new Date(String(value || ""));
  if (Number.isNaN(parsed.valueOf())) invalid(`Invalid Tinder product ${field}.`, "INVALID_TINDER_PRODUCT_CONVERSATION_RECORD");
  return parsed.toISOString();
}

function positiveContactId(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function normalizedDirection(value) {
  const direction = String(value || "").trim().toUpperCase();
  if (!MESSAGE_DIRECTIONS.has(direction)) invalid("Invalid Tinder product message direction.", "INVALID_TINDER_PRODUCT_CONVERSATION_MESSAGES");
  return direction;
}

function normalizedText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > 4096) invalid("Invalid Tinder product message text.", "INVALID_TINDER_PRODUCT_CONVERSATION_MESSAGES");
  return text;
}

export function normalizeTinderProductConversationMessages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    invalid("Invalid Tinder product message list.", "INVALID_TINDER_PRODUCT_CONVERSATION_MESSAGES");
  }

  let previousOrder = 0;
  return Object.freeze(value.map((message) => {
    if (!plainObject(message)) invalid("Invalid Tinder product message.", "INVALID_TINDER_PRODUCT_CONVERSATION_MESSAGES");
    const visibleOrder = Number(sourceValue(message, "visibleOrder", "visible_order"));
    if (!Number.isInteger(visibleOrder) || visibleOrder <= previousOrder) {
      invalid("Invalid Tinder product message ordering.", "INVALID_TINDER_PRODUCT_CONVERSATION_MESSAGES");
    }
    previousOrder = visibleOrder;
    return Object.freeze({
      visibleOrder,
      direction: normalizedDirection(message.direction),
      text: normalizedText(message.text)
    });
  }));
}

function messageKey(message) {
  return `${message.direction}\u0000${message.text}`;
}

function sameMessage(left, right) {
  return messageKey(left) === messageKey(right);
}

function sameWindow(left, leftStart, right, rightStart, length) {
  for (let offset = 0; offset < length; offset += 1) {
    if (!sameMessage(left[leftStart + offset], right[rightStart + offset])) return false;
  }
  return true;
}

function containedAt(container, candidate) {
  if (candidate.length > container.length) return -1;
  for (let start = 0; start <= container.length - candidate.length; start += 1) {
    if (sameWindow(container, start, candidate, 0, candidate.length)) return start;
  }
  return -1;
}

/**
 * Finds the largest contiguous ordered directional overlap which can join two
 * viewport observations at an edge.  It intentionally does not treat a set
 * of matching text snippets as correlation evidence.
 */
export function orderedDirectionalOverlap(leftInput, rightInput) {
  const left = normalizeTinderProductConversationMessages(leftInput);
  const right = normalizeTinderProductConversationMessages(rightInput);

  if (containedAt(left, right) >= 0) return Object.freeze({ count: right.length, relation: "RIGHT_CONTAINED" });
  if (containedAt(right, left) >= 0) return Object.freeze({ count: left.length, relation: "LEFT_CONTAINED" });

  const maximum = Math.min(left.length, right.length);
  for (let count = maximum; count >= 1; count -= 1) {
    if (sameWindow(left, left.length - count, right, 0, count)) {
      return Object.freeze({ count, relation: "APPEND_RIGHT" });
    }
    if (sameWindow(right, right.length - count, left, 0, count)) {
      return Object.freeze({ count, relation: "PREPEND_RIGHT" });
    }
  }
  return Object.freeze({ count: 0, relation: "NONE" });
}

/**
 * Merges only observations whose ordered overlap establishes their position.
 * An unmerged segment is deliberately returned separately rather than being
 * appended heuristically and corrupting the product history.
 */
export function mergeOrderedTinderMessageHistory(historyInput, observationInput) {
  const history = historyInput.length === 0
    ? Object.freeze([])
    : normalizeTinderProductConversationMessages(historyInput);
  const observation = normalizeTinderProductConversationMessages(observationInput);

  if (history.length === 0) {
    return Object.freeze({ messages: observation, overlap: observation.length, relation: "INITIAL", merged: true });
  }

  const overlap = orderedDirectionalOverlap(history, observation);
  if (overlap.relation === "RIGHT_CONTAINED") {
    return Object.freeze({ messages: history, overlap: overlap.count, relation: overlap.relation, merged: true });
  }
  if (overlap.relation === "LEFT_CONTAINED") {
    return Object.freeze({ messages: observation, overlap: overlap.count, relation: overlap.relation, merged: true });
  }
  if (overlap.relation === "APPEND_RIGHT") {
    return Object.freeze({
      messages: Object.freeze([...history, ...observation.slice(overlap.count)]),
      overlap: overlap.count,
      relation: overlap.relation,
      merged: true
    });
  }
  if (overlap.relation === "PREPEND_RIGHT") {
    return Object.freeze({
      messages: Object.freeze([...observation.slice(0, observation.length - overlap.count), ...history]),
      overlap: overlap.count,
      relation: overlap.relation,
      merged: true
    });
  }
  return Object.freeze({ messages: history, overlap: 0, relation: "NONE", merged: false });
}

function captureOrder(left, right) {
  const leftTime = Date.parse(left.capturedAt || left.receivedAt || "");
  const rightTime = Date.parse(right.capturedAt || right.receivedAt || "");
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.captureId.localeCompare(right.captureId);
}

/** Aggregates already-linked capture evidence without copying it into a new message table. */
export function aggregateTinderProductConversationHistory(captures) {
  if (!Array.isArray(captures)) invalid("Invalid Tinder product capture sequence.", "INVALID_TINDER_PRODUCT_CONVERSATION_RECORD");
  const normalized = captures.map(normalizeCaptureForProjection).sort(captureOrder);
  let messages = Object.freeze([]);
  let unmergedCaptureCount = 0;
  for (const capture of normalized) {
    const merged = mergeOrderedTinderMessageHistory(messages, capture.visibleMessages);
    if (!merged.merged) {
      unmergedCaptureCount += 1;
      continue;
    }
    messages = merged.messages;
  }
  return Object.freeze({ messages, unmergedCaptureCount });
}

function normalizeCaptureForProjection(value) {
  if (!plainObject(value)) invalid("Invalid Tinder product capture.", "INVALID_TINDER_PRODUCT_CONVERSATION_RECORD");
  const metadata = sourceValue(value, "visibleThreadMetadata", "visible_thread_metadata");
  const fingerprint = sourceValue(value, "runtimeThreadFingerprint", "runtime_thread_fingerprint")
    ?? sourceValue(metadata, "threadFingerprint", "thread_fingerprint");
  return Object.freeze({
    captureId: uuid(sourceValue(value, "captureId", "capture_id"), "capture id"),
    deviceId: uuid(sourceValue(value, "deviceId", "device_id"), "device id"),
    runtimeThreadFingerprint: hash(fingerprint, "thread correlation hint"),
    visibleMessages: normalizeTinderProductConversationMessages(sourceValue(value, "visibleMessages", "visible_messages")),
    capturedAt: timestamp(sourceValue(value, "capturedAt", "captured_at"), "capture time"),
    receivedAt: timestamp(sourceValue(value, "receivedAt", "received_at"), "receipt time"),
    mappingStatus: String(sourceValue(value, "mappingStatus", "mapping_status") || "").trim().toUpperCase(),
    humanReviewStatus: String(sourceValue(value, "humanReviewStatus", "human_review_status") || "").trim().toUpperCase(),
    resolvedContactId: positiveContactId(sourceValue(value, "resolvedContactId", "resolved_contact_id"))
  });
}

function captureIdentity(capture) {
  return capture.mappingStatus === "RESOLVED"
    && capture.humanReviewStatus === "CONFIRMED"
    && capture.resolvedContactId !== null
    ? Object.freeze({ state: TINDER_PRODUCT_CONVERSATION_IDENTITY_STATE.BOUND, contactId: capture.resolvedContactId })
    : Object.freeze({ state: TINDER_PRODUCT_CONVERSATION_IDENTITY_STATE.UNASSIGNED, contactId: null });
}

function normalizeCandidate(value) {
  if (!plainObject(value)) invalid("Invalid Tinder product candidate.", "INVALID_TINDER_PRODUCT_CONVERSATION_RECORD");
  const correlationState = String(sourceValue(value, "correlationState", "correlation_state") || "").trim().toUpperCase();
  const identityBindingState = String(sourceValue(value, "identityBindingState", "identity_binding_state") || "").trim().toUpperCase();
  const historyState = String(sourceValue(value, "historyState", "history_state") || "").trim().toUpperCase();
  if (!Object.values(TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE).includes(correlationState)
      || !Object.values(TINDER_PRODUCT_CONVERSATION_IDENTITY_STATE).includes(identityBindingState)
      || !Object.values(TINDER_PRODUCT_CONVERSATION_HISTORY_STATE).includes(historyState)) {
    invalid("Invalid Tinder product candidate state.", "INVALID_TINDER_PRODUCT_CONVERSATION_RECORD");
  }
  const captures = value.captures;
  if (!Array.isArray(captures) || captures.length === 0) invalid("Invalid Tinder product candidate captures.", "INVALID_TINDER_PRODUCT_CONVERSATION_RECORD");
  const resolvedContactId = positiveContactId(sourceValue(value, "resolvedContactId", "resolved_contact_id"));
  if ((identityBindingState === TINDER_PRODUCT_CONVERSATION_IDENTITY_STATE.BOUND) !== (resolvedContactId !== null)) {
    invalid("Invalid Tinder product candidate identity.", "INVALID_TINDER_PRODUCT_CONVERSATION_RECORD");
  }
  return Object.freeze({
    conversationId: uuid(sourceValue(value, "conversationId", "conversation_id"), "conversation id"),
    correlationState,
    identityBindingState,
    resolvedContactId,
    historyState,
    captures: Object.freeze(captures.map(normalizeCaptureForProjection))
  });
}

function conversationIdentityAfter(existing, capture) {
  const incoming = captureIdentity(capture);
  if (existing.identityBindingState === TINDER_PRODUCT_CONVERSATION_IDENTITY_STATE.CONFLICT) {
    return Object.freeze({ state: TINDER_PRODUCT_CONVERSATION_IDENTITY_STATE.CONFLICT, contactId: null });
  }
  if (existing.identityBindingState === TINDER_PRODUCT_CONVERSATION_IDENTITY_STATE.BOUND) {
    if (incoming.state === TINDER_PRODUCT_CONVERSATION_IDENTITY_STATE.BOUND
        && incoming.contactId !== existing.resolvedContactId) {
      return Object.freeze({ state: TINDER_PRODUCT_CONVERSATION_IDENTITY_STATE.CONFLICT, contactId: null });
    }
    return Object.freeze({ state: TINDER_PRODUCT_CONVERSATION_IDENTITY_STATE.BOUND, contactId: existing.resolvedContactId });
  }
  return incoming;
}

function requiredRepository(repository) {
  for (const method of [
    "isReady", "findCaptureLink", "findCandidates", "createConversation", "linkCapture", "updateConversation"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
  return repository;
}

/**
 * Projects a freshly persisted capture inside its existing capture transaction.
 * `NOT_READY` is intentionally non-blocking before the explicit product-schema
 * DDL has been applied; capture provenance continues to be safely recorded.
 */
export function createTinderProductConversationService(repository, {
  createConversationId = () => crypto.randomUUID(),
  now = () => new Date(),
  minimumOrderedOverlap = TINDER_PRODUCT_CONVERSATION_MINIMUM_ORDERED_OVERLAP
} = {}) {
  requiredRepository(repository);
  if (!Number.isInteger(minimumOrderedOverlap) || minimumOrderedOverlap < 1 || minimumOrderedOverlap > 100) {
    throw new TypeError("minimumOrderedOverlap must be a bounded positive integer");
  }

  /**
   * The transition proof is explicitly one-time, device-scoped, and only
   * available while this product foundation has no durable Conversation for
   * that device. The PostgreSQL adapter serializes proof attempts on the
   * existing device row before it reads the total; no proof-state row or
   * schema is introduced. Other product projections never call this method.
   */
  async function hasEmptyDeviceSlotForDuplicateReprojectionProof(transaction, { deviceId } = {}) {
    if (await repository.isReady(transaction) !== true
        || typeof repository.hasEmptyDeviceSlotForDuplicateReprojectionProof !== "function") {
      return false;
    }
    return (await repository.hasEmptyDeviceSlotForDuplicateReprojectionProof(transaction, {
      deviceId: uuid(deviceId, "device id")
    })) === true;
  }

  async function projectCapture(transaction, inputCapture) {
    const capture = normalizeCaptureForProjection(inputCapture);
    if (await repository.isReady(transaction) !== true) {
      return Object.freeze({ disposition: TINDER_PRODUCT_CONVERSATION_DISPOSITION.NOT_READY, conversationId: null });
    }

    // A capture-link idempotency lookup is meaningful only within the same
    // device scope.  An accidentally corrupt cross-device link must never
    // turn a new observation into an apparently successful duplicate.
    const existingLink = await repository.findCaptureLink(transaction, {
      captureId: capture.captureId,
      deviceId: capture.deviceId
    });
    if (existingLink?.conversationId || existingLink?.conversation_id) {
      return Object.freeze({
        disposition: TINDER_PRODUCT_CONVERSATION_DISPOSITION.IDEMPOTENT_DUPLICATE,
        conversationId: uuid(existingLink.conversationId ?? existingLink.conversation_id, "conversation id")
      });
    }

    const candidates = (await repository.findCandidates(transaction, {
      deviceId: capture.deviceId,
      runtimeThreadFingerprint: capture.runtimeThreadFingerprint
    })).map(normalizeCandidate);

    const matches = candidates.map(candidate => {
      const aggregate = aggregateTinderProductConversationHistory(candidate.captures);
      const overlap = orderedDirectionalOverlap(aggregate.messages, capture.visibleMessages);
      return Object.freeze({ candidate, aggregate, overlap });
    }).filter(match => match.aggregate.unmergedCaptureCount === 0 && match.overlap.count >= minimumOrderedOverlap);

    const observedAt = capture.capturedAt;
    if (matches.length === 1) {
      const match = matches[0];
      const merged = mergeOrderedTinderMessageHistory(match.aggregate.messages, capture.visibleMessages);
      // The overlap test above guarantees the edge-aware merge. Keep this
      // defensive check so a future matcher cannot silently weaken it.
      if (!merged.merged) invalid("Tinder product correlation cannot merge history.", "TINDER_PRODUCT_CONVERSATION_CORRELATION_INVALID");
      const identity = conversationIdentityAfter(match.candidate, capture);
      const correlationState = match.candidate.correlationState === TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.AMBIGUOUS
        ? TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.AMBIGUOUS
        : TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.CORRELATED;
      const linked = await repository.linkCapture(transaction, {
        conversationId: match.candidate.conversationId,
        captureId: capture.captureId,
        linkMethod: TINDER_PRODUCT_CONVERSATION_LINK_METHOD.ORDERED_MESSAGE_OVERLAP,
        linkedAt: timestamp(now(), "link time")
      });
      if (!linked) {
        invalid("Tinder product capture link was rejected.", "TINDER_PRODUCT_CONVERSATION_LINK_REJECTED");
      }
      const linkedConversationId = linked.conversationId ?? linked.conversation_id;
      if (linkedConversationId !== match.candidate.conversationId) {
        return Object.freeze({
          disposition: TINDER_PRODUCT_CONVERSATION_DISPOSITION.IDEMPOTENT_DUPLICATE,
          conversationId: uuid(linkedConversationId, "conversation id")
        });
      }
      await repository.updateConversation(transaction, {
        conversationId: match.candidate.conversationId,
        correlationState,
        identityBindingState: identity.state,
        resolvedContactId: identity.contactId,
        lastObservedAt: observedAt,
        lastHistoryAt: observedAt,
        updatedAt: timestamp(now(), "update time")
      });
      return Object.freeze({
        disposition: TINDER_PRODUCT_CONVERSATION_DISPOSITION.UPDATED,
        conversationId: match.candidate.conversationId
      });
    }

    const identity = captureIdentity(capture);
    const correlationState = matches.length > 1
      ? TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.AMBIGUOUS
      : TINDER_PRODUCT_CONVERSATION_CORRELATION_STATE.PROVISIONAL;
    const conversationId = uuid(createConversationId(), "conversation id");
    await repository.createConversation(transaction, {
      conversationId,
      deviceId: capture.deviceId,
      runtimeThreadFingerprintHint: capture.runtimeThreadFingerprint,
      identityBindingState: identity.state,
      resolvedContactId: identity.contactId,
      correlationState,
      historyState: TINDER_PRODUCT_CONVERSATION_HISTORY_STATE.PARTIAL,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      lastHistoryAt: observedAt,
      createdAt: timestamp(now(), "creation time"),
      updatedAt: timestamp(now(), "update time")
    });
    const linked = await repository.linkCapture(transaction, {
      conversationId,
      captureId: capture.captureId,
      linkMethod: TINDER_PRODUCT_CONVERSATION_LINK_METHOD.INITIAL,
      linkedAt: timestamp(now(), "link time")
    });
    if (!linked) {
      invalid("Tinder product capture link was rejected.", "TINDER_PRODUCT_CONVERSATION_LINK_REJECTED");
    }
    const linkedConversationId = linked.conversationId ?? linked.conversation_id;
    if (linkedConversationId !== conversationId) {
      invalid("Tinder product capture link conflicts with its new conversation.", "TINDER_PRODUCT_CONVERSATION_LINK_CONFLICT");
    }
    return Object.freeze({ disposition: TINDER_PRODUCT_CONVERSATION_DISPOSITION.CREATED, conversationId });
  }

  return Object.freeze({ projectCapture, hasEmptyDeviceSlotForDuplicateReprojectionProof });
}

/** PostgreSQL adapter. It is inert until the additive product schema exists. */
export function createPgTinderProductConversationRepository(pool) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("pool.query must be a function");

  return Object.freeze({
    async isReady(client) {
      // Product projection is optional until the explicit additive DDL is
      // canonical.  A half-created or drifted pair of relation names is not
      // treated as usable: that would turn a later query error into a capture
      // rollback.  `INVALID` is therefore safely non-projecting, while real
      // database faults still propagate rather than being misreported as a
      // successful Conversation.
      const inspection = await inspectTinderProductConversationSchema(client);
      return inspection.state === TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE.CANONICAL;
    },

    async findCaptureLink(client, { captureId, deviceId }) {
      const result = await client.query(
        `SELECT link.conversation_id
           FROM tinder_thread_conversation_capture_links link
           JOIN tinder_thread_conversations conversation
             ON conversation.conversation_id = link.conversation_id
           JOIN tinder_visible_chat_captures capture
             ON capture.capture_id = link.capture_id
          WHERE link.capture_id = $1
            AND conversation.device_id = $2
            AND link.device_id = conversation.device_id
            AND capture.device_id = conversation.device_id`,
        [captureId, deviceId]
      );
      return result.rows[0] || null;
    },

    /**
     * No durable claim is written here. The existing device row makes
     * concurrent proof requests serialize; the count then makes every later
     * proof fail closed after the first proof creates its Conversation.
     */
    async hasEmptyDeviceSlotForDuplicateReprojectionProof(client, { deviceId }) {
      const device = await client.query(
        `SELECT device_id
           FROM device_bridge_devices
          WHERE device_id = $1
          FOR UPDATE`,
        [deviceId]
      );
      if (device.rows.length !== 1) return false;
      const existing = await client.query(
        `SELECT count(*)::integer AS total
           FROM tinder_thread_conversations
          WHERE device_id = $1`,
        [deviceId]
      );
      return Number(existing.rows[0]?.total) === 0;
    },

    async findCandidates(client, { deviceId, runtimeThreadFingerprint }) {
      const result = await client.query(
        `SELECT conversation.conversation_id,
                conversation.correlation_state,
                conversation.identity_binding_state,
                conversation.resolved_contact_id,
                conversation.history_state,
                capture.capture_id,
                capture.device_id,
                capture.runtime_thread_fingerprint,
                capture.visible_messages,
                capture.mapping_status,
                capture.human_review_status,
                capture.resolved_contact_id,
                capture.captured_at,
                capture.received_at
           FROM tinder_thread_conversations conversation
           JOIN tinder_thread_conversation_capture_links link
             ON link.conversation_id = conversation.conversation_id
          JOIN tinder_visible_chat_captures capture
             ON capture.capture_id = link.capture_id
          WHERE conversation.device_id = $1
            AND conversation.runtime_thread_fingerprint_hint = $2
            AND capture.device_id = conversation.device_id
          ORDER BY conversation.conversation_id,
                   capture.captured_at ASC,
                   capture.received_at ASC,
                   capture.capture_id ASC`,
        [deviceId, runtimeThreadFingerprint]
      );
      const grouped = new Map();
      for (const row of result.rows) {
        const key = row.conversation_id;
        const candidate = grouped.get(key) || {
          conversation_id: row.conversation_id,
          correlation_state: row.correlation_state,
          identity_binding_state: row.identity_binding_state,
          resolved_contact_id: row.resolved_contact_id,
          history_state: row.history_state,
          captures: []
        };
        candidate.captures.push({
          capture_id: row.capture_id,
          device_id: row.device_id,
          runtime_thread_fingerprint: row.runtime_thread_fingerprint,
          visible_messages: row.visible_messages,
          mapping_status: row.mapping_status,
          human_review_status: row.human_review_status,
          resolved_contact_id: row.resolved_contact_id,
          captured_at: row.captured_at,
          received_at: row.received_at
        });
        grouped.set(key, candidate);
      }
      return [...grouped.values()];
    },

    async createConversation(client, record) {
      await client.query(
        `INSERT INTO tinder_thread_conversations (
           conversation_id, device_id, runtime_thread_fingerprint_hint,
           identity_binding_state, resolved_contact_id, correlation_state,
           history_state, first_observed_at, last_observed_at, last_history_at,
           created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          record.conversationId, record.deviceId, record.runtimeThreadFingerprintHint,
          record.identityBindingState, record.resolvedContactId, record.correlationState,
          record.historyState, record.firstObservedAt, record.lastObservedAt, record.lastHistoryAt,
          record.createdAt, record.updatedAt
        ]
      );
    },

    async linkCapture(client, record) {
      const inserted = await client.query(
        `INSERT INTO tinder_thread_conversation_capture_links
           (conversation_id, capture_id, device_id, link_method, linked_at)
         SELECT conversation.conversation_id, capture.capture_id, conversation.device_id, $3, $4
           FROM tinder_thread_conversations conversation
           JOIN tinder_visible_chat_captures capture
             ON capture.capture_id = $2
          WHERE conversation.conversation_id = $1
            AND conversation.device_id = capture.device_id
         ON CONFLICT (capture_id) DO NOTHING
         RETURNING conversation_id`,
        [record.conversationId, record.captureId, record.linkMethod, record.linkedAt]
      );
      if (inserted.rows[0]) return inserted.rows[0];
      const existing = await client.query(
        `SELECT link.conversation_id
           FROM tinder_thread_conversation_capture_links link
           JOIN tinder_thread_conversations conversation
             ON conversation.conversation_id = link.conversation_id
           JOIN tinder_visible_chat_captures capture
             ON capture.capture_id = link.capture_id
          WHERE link.capture_id = $1
            AND link.device_id = conversation.device_id
            AND capture.device_id = conversation.device_id`,
        [record.captureId]
      );
      return existing.rows[0] || null;
    },

    async updateConversation(client, record) {
      await client.query(
        `UPDATE tinder_thread_conversations
            SET correlation_state = $2,
                identity_binding_state = $3,
                resolved_contact_id = $4,
                last_observed_at = GREATEST(last_observed_at, $5::timestamptz),
                last_history_at = GREATEST(last_history_at, $6::timestamptz),
                updated_at = $7
          WHERE conversation_id = $1`,
        [
          record.conversationId, record.correlationState, record.identityBindingState,
          record.resolvedContactId, record.lastObservedAt, record.lastHistoryAt, record.updatedAt
        ]
      );
    }
  });
}
