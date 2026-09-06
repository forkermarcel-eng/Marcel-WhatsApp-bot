import crypto from "node:crypto";

/* ==================================================
T6 TINDER INBOUND QUEUE FOUNDATION

This is deliberately an unwired, server-side state boundary.  It consumes a
previously persisted T3 visible-chat capture by ID; it does not accept a
notification, a contact, message text, a thread, timing, or any browser-owned
truth.  No timer is created in memory and no draft, command, device, or Tinder
action is invoked from here.
================================================== */

const TINDER_INBOUND_CHANNEL = "tinder";
const TINDER_THREAD_REF_KIND = "runtime_thread_fingerprint_v1";
const TINDER_COLLECTION_WINDOW_MIN_MS = 3 * 60 * 1000;
const TINDER_COLLECTION_WINDOW_MAX_MS = 4 * 60 * 1000;

const TINDER_CONVERSATION_STATE = Object.freeze({
  NEW_MATCH: "NEW_MATCH",
  WAITING_FOR_US: "WAITING_FOR_US",
  WAITING_FOR_HER: "WAITING_FOR_HER",
  ACTIVE_CHAT: "ACTIVE_CHAT",
  DORMANT: "DORMANT",
  HANDOFF: "HANDOFF"
});

const TINDER_INBOUND_WORK_STATUS = Object.freeze({
  COLLECTING: "COLLECTING",
  ELIGIBLE_FOR_NEXT_STAGE: "ELIGIBLE_FOR_NEXT_STAGE",
  BLOCKED: "BLOCKED",
  CLOSED: "CLOSED"
});

const TINDER_INBOUND_BLOCK_REASON = Object.freeze({
  AUTO_REPLY_DISABLED: "AUTO_REPLY_DISABLED",
  DATE_LOCK_ACTIVE: "DATE_LOCK_ACTIVE",
  MANUAL_REVIEW_REQUIRED: "MANUAL_REVIEW_REQUIRED",
  HUMAN_TAKEOVER_ACTIVE: "HUMAN_TAKEOVER_ACTIVE",
  HANDOFF_ACTIVE: "HANDOFF_ACTIVE",
  CONTACT_CONTROL_UNVERIFIABLE: "CONTACT_CONTROL_UNVERIFIABLE",
  CAPTURE_REVISION_STALE: "CAPTURE_REVISION_STALE",
  CONTEXT_REFRESH_REQUIRED: "CONTEXT_REFRESH_REQUIRED",
  IDENTITY_NOT_CONFIRMED: "IDENTITY_NOT_CONFIRMED",
  CAPTURE_NOT_SAFE: "CAPTURE_NOT_SAFE"
});

const TINDER_INBOUND_CLOSED_REASON = Object.freeze({
  VERIFIED_OUTBOUND: "VERIFIED_OUTBOUND",
  IDENTITY_CHANGED: "IDENTITY_CHANGED"
});

const TINDER_INBOUND_AUDIT_ACTION = Object.freeze({
  INBOUND_ENQUEUED: "INBOUND_ENQUEUED",
  COLLECTION_WINDOW_RESET: "COLLECTION_WINDOW_RESET",
  WORK_ITEM_BLOCKED: "WORK_ITEM_BLOCKED",
  WORK_ITEM_ELIGIBLE: "WORK_ITEM_ELIGIBLE",
  VERIFIED_OUTBOUND_OBSERVED: "VERIFIED_OUTBOUND_OBSERVED",
  IDENTITY_CHANGED: "IDENTITY_CHANGED"
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const VISIBLE_DIRECTIONS = new Set(["INCOMING", "OUTGOING", "UNKNOWN"]);

class TinderInboundQueueError extends Error {
  constructor(message, code = "TINDER_INBOUND_QUEUE_ERROR", statusCode = 409) {
    super(message);
    this.name = "TinderInboundQueueError";
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

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function normalizedUuid(value, field = "ID") {
  const identifier = String(value || "").trim();
  if (!UUID_V4.test(identifier)) {
    throw new TinderInboundQueueError(`${field} ist ungültig.`, `INVALID_${field.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, 400);
  }
  return identifier;
}

function normalizedFingerprint(value, field = "Fingerprint") {
  const fingerprint = String(value || "").trim().toLowerCase();
  if (!SHA256_HEX.test(fingerprint)) {
    throw new TinderInboundQueueError(`${field} ist ungültig.`, `INVALID_${field.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`, 409);
  }
  return fingerprint;
}

function normalizedDate(value, field = "Zeit") {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new TinderInboundQueueError(`${field} ist ungültig.`, "INVALID_TIMESTAMP", 500);
  }
  return date;
}

function nowIso(now) {
  return normalizedDate(now?.(), "Serverzeit").toISOString();
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactInput(value, fields) {
  if (!plainObject(value) || Object.keys(value).sort().join("|") !== [...fields].sort().join("|")) {
    throw new TinderInboundQueueError("Die T6-Queue-Anfrage enthält nicht die erlaubten Felder.", "INVALID_T6_QUEUE_INPUT", 400);
  }
}

function normalizeVisibleMessages(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new TinderInboundQueueError("Das bestätigte Tinder-Capture enthält keine gültigen Nachrichten.", "INVALID_VISIBLE_CAPTURE");
  }

  let previousOrder = 0;
  return value.map((item) => {
    if (!plainObject(item)) {
      throw new TinderInboundQueueError("Das bestätigte Tinder-Capture ist ungültig.", "INVALID_VISIBLE_CAPTURE");
    }
    const visibleOrder = positiveInteger(sourceValue(item, "visibleOrder", "visible_order"));
    const direction = normalizedState(item.direction);
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!visibleOrder || visibleOrder <= previousOrder || !text || text.length > 4096 || !VISIBLE_DIRECTIONS.has(direction)) {
      throw new TinderInboundQueueError("Das bestätigte Tinder-Capture ist ungültig.", "INVALID_VISIBLE_CAPTURE");
    }
    previousOrder = visibleOrder;
    return Object.freeze({ visibleOrder, direction, text });
  });
}

function normalizeCaptureSnapshot(row, { allowIneligible = false } = {}) {
  if (!plainObject(row)) {
    throw new TinderInboundQueueError("Das Tinder-Capture wurde nicht gefunden.", "CAPTURE_NOT_FOUND", 404);
  }

  const captureId = normalizedUuid(sourceValue(row, "captureId", "capture_id"), "Capture-ID");
  const deviceId = normalizedUuid(sourceValue(row, "deviceId", "device_id"), "Device-ID");
  const contactId = positiveInteger(
    sourceValue(row, "captureResolvedContactId", "capture_resolved_contact_id")
      ?? sourceValue(row, "resolvedContactId", "resolved_contact_id")
  );
  const captureSafetyStatus = normalizedState(sourceValue(row, "captureSafetyStatus", "capture_safety_status"));
  const mappingStatus = normalizedState(sourceValue(row, "mappingStatus", "mapping_status"));
  const humanReviewStatus = normalizedState(sourceValue(row, "humanReviewStatus", "human_review_status"));
  const captureRevision = positiveInteger(sourceValue(row, "captureRevision", "capture_revision"));
  const latestCaptureRevision = positiveInteger(sourceValue(row, "latestCaptureRevision", "latest_capture_revision"));
  const identityRevision = positiveInteger(
    sourceValue(row, "captureIdentityRevision", "capture_identity_revision")
      ?? sourceValue(row, "identityRevision", "identity_revision")
  );

  const eligibilityProblem = captureSafetyStatus !== "SAFE"
    ? TINDER_INBOUND_BLOCK_REASON.CAPTURE_NOT_SAFE
    : (mappingStatus !== "RESOLVED" || humanReviewStatus !== "CONFIRMED" || contactId === null || identityRevision === null)
      ? TINDER_INBOUND_BLOCK_REASON.IDENTITY_NOT_CONFIRMED
      : (captureRevision === null || latestCaptureRevision === null || captureRevision !== latestCaptureRevision)
        ? TINDER_INBOUND_BLOCK_REASON.CONTEXT_REFRESH_REQUIRED
        : null;
  if (eligibilityProblem && !allowIneligible) {
    const code = eligibilityProblem === TINDER_INBOUND_BLOCK_REASON.CAPTURE_NOT_SAFE
      ? "CAPTURE_NOT_SAFE"
      : eligibilityProblem === TINDER_INBOUND_BLOCK_REASON.CONTEXT_REFRESH_REQUIRED
        ? "CAPTURE_REVISION_STALE"
        : "IDENTITY_NOT_CONFIRMED";
    const message = code === "CAPTURE_NOT_SAFE"
      ? "Nur sichere T3-Captures dürfen in die T6-Queue."
      : code === "CAPTURE_REVISION_STALE"
        ? "Das Tinder-Capture ist nicht die aktuelle Thread-Revision."
        : "Die Tinder-Identität ist nicht menschlich bestätigt.";
    throw new TinderInboundQueueError(message, code);
  }

  return Object.freeze({
    captureId,
    deviceId,
    contactId,
    captureFingerprint: normalizedFingerprint(sourceValue(row, "captureFingerprint", "capture_fingerprint"), "Capture-Fingerprint"),
    runtimeThreadFingerprint: normalizedFingerprint(sourceValue(row, "runtimeThreadFingerprint", "runtime_thread_fingerprint"), "Thread-Fingerprint"),
    captureRevision,
    latestCaptureRevision,
    identityRevision,
    eligibilityProblem,
    receivedAt: normalizedDate(sourceValue(row, "receivedAt", "received_at"), "Capture-Empfangszeit").toISOString(),
    visibleMessages: normalizeVisibleMessages(sourceValue(row, "visibleMessages", "visible_messages")),
    humanTakeoverActive: sourceValue(row, "humanTakeoverActive", "human_takeover_active"),
    handoffActive: sourceValue(row, "handoffActive", "handoff_active"),
    autoReplyEnabled: sourceValue(row, "autoReplyEnabled", "auto_reply_enabled"),
    dateLockEnabled: sourceValue(row, "dateLockEnabled", "date_lock_enabled"),
    manualReviewRequired: sourceValue(row, "manualReviewRequired", "manual_review_required")
  });
}

function terminalVisibleMessage(snapshot) {
  const terminal = snapshot.visibleMessages[snapshot.visibleMessages.length - 1];
  if (terminal.direction === "UNKNOWN") {
    throw new TinderInboundQueueError("Die letzte sichtbare Tinder-Nachricht ist nicht verifizierbar.", "TERMINAL_DIRECTION_UNKNOWN");
  }
  const textSha256 = sha256(terminal.text);
  const messageFingerprint = sha256(canonicalJson({
    version: "tinder-terminal-visible-message-v1",
    runtimeThreadFingerprint: snapshot.runtimeThreadFingerprint,
    direction: terminal.direction,
    visibleOrder: terminal.visibleOrder,
    textSha256
  }));
  const captureFrameDedupKey = sha256(canonicalJson({
    version: "tinder-inbound-capture-frame-v1",
    channel: TINDER_INBOUND_CHANNEL,
    deviceId: snapshot.deviceId,
    runtimeThreadFingerprint: snapshot.runtimeThreadFingerprint,
    captureFingerprint: snapshot.captureFingerprint,
    terminalMessageFingerprint: messageFingerprint
  }));
  return Object.freeze({
    direction: terminal.direction,
    messageFingerprint,
    captureFrameDedupKey
  });
}

function blockReasonFor(snapshot) {
  if (snapshot.handoffActive !== false) return TINDER_INBOUND_BLOCK_REASON.HANDOFF_ACTIVE;
  if (snapshot.humanTakeoverActive !== false) return TINDER_INBOUND_BLOCK_REASON.HUMAN_TAKEOVER_ACTIVE;
  if (snapshot.autoReplyEnabled === false) return TINDER_INBOUND_BLOCK_REASON.AUTO_REPLY_DISABLED;
  if (snapshot.dateLockEnabled === true) return TINDER_INBOUND_BLOCK_REASON.DATE_LOCK_ACTIVE;
  if (snapshot.manualReviewRequired === true) return TINDER_INBOUND_BLOCK_REASON.MANUAL_REVIEW_REQUIRED;
  if (![true, false].includes(snapshot.autoReplyEnabled) ||
      ![true, false].includes(snapshot.dateLockEnabled) ||
      ![true, false].includes(snapshot.manualReviewRequired)) {
    return TINDER_INBOUND_BLOCK_REASON.CONTACT_CONTROL_UNVERIFIABLE;
  }
  return null;
}

function drawCollectionWindow(draw) {
  const value = Number(draw());
  if (!Number.isInteger(value) || value < TINDER_COLLECTION_WINDOW_MIN_MS || value > TINDER_COLLECTION_WINDOW_MAX_MS) {
    throw new TinderInboundQueueError("Das Tinder-Sammelfenster ist nicht sicher konfiguriert.", "INVALID_COLLECTION_WINDOW", 500);
  }
  return value;
}

function addMilliseconds(iso, milliseconds) {
  return new Date(normalizedDate(iso).valueOf() + milliseconds).toISOString();
}

function valueOf(row, camelCase, snakeCase) {
  return sourceValue(row, camelCase, snakeCase);
}

function normalizeWorkItem(row, { idempotent = false, ignored = false } = {}) {
  if (!plainObject(row)) {
    throw new TinderInboundQueueError("Der T6-Queue-Eintrag konnte nicht gelesen werden.", "WORK_ITEM_NOT_FOUND", 500);
  }
  const workItemId = normalizedUuid(valueOf(row, "workItemId", "work_item_id"), "Work-Item-ID");
  const status = normalizedState(valueOf(row, "queueStatus", "queue_status"));
  const conversationState = normalizedState(valueOf(row, "conversationState", "conversation_state"));
  if (!Object.values(TINDER_INBOUND_WORK_STATUS).includes(status) ||
      !Object.values(TINDER_CONVERSATION_STATE).includes(conversationState)) {
    throw new TinderInboundQueueError("Der T6-Queue-Status ist ungültig.", "INVALID_WORK_ITEM", 500);
  }
  return Object.freeze({
    workItemId,
    channel: TINDER_INBOUND_CHANNEL,
    contactId: positiveInteger(valueOf(row, "contactId", "contact_id")),
    captureId: normalizedUuid(valueOf(row, "captureId", "capture_id"), "Capture-ID"),
    runtimeThreadFingerprint: normalizedFingerprint(valueOf(row, "runtimeThreadFingerprint", "runtime_thread_fingerprint"), "Thread-Fingerprint"),
    conversationState,
    queueStatus: status,
    collectionWindowMs: Number(valueOf(row, "collectionWindowMs", "collection_window_ms")),
    collectionStartedAt: normalizedDate(valueOf(row, "collectionStartedAt", "collection_started_at")).toISOString(),
    eligibleAt: normalizedDate(valueOf(row, "eligibleAt", "eligible_at")).toISOString(),
    blockReason: valueOf(row, "blockReason", "block_reason") || null,
    closedReason: valueOf(row, "closedReason", "closed_reason") || null,
    idempotent,
    ignored
  });
}

function sameIdentityBinding(workItem, snapshot) {
  return Number(valueOf(workItem, "contactId", "contact_id")) === snapshot.contactId &&
    String(valueOf(workItem, "runtimeThreadFingerprint", "runtime_thread_fingerprint") || "").toLowerCase() === snapshot.runtimeThreadFingerprint &&
    Number(valueOf(workItem, "identityRevision", "identity_revision")) === snapshot.identityRevision;
}

function sameInboundMessage(workItem, terminal) {
  return String(valueOf(workItem, "latestInboundMessageFingerprint", "latest_inbound_message_fingerprint") || "").toLowerCase() === terminal.messageFingerprint;
}

function requiredRepository(repository) {
  for (const method of [
    "withTransaction",
    "getCaptureWithContactForUpdate",
    "lockThread",
    "findCaptureFrameEventForUpdate",
    "findActiveWorkItemForThreadForUpdate",
    "insertWorkItem",
    "resetWorkItemForInbound",
    "refreshWorkItemWithoutWindowReset",
    "closeWorkItem",
    "insertCaptureFrameEvent",
    "insertAudit",
    "findDueWorkItemsForUpdate",
    "markWorkItemEligible",
    "markWorkItemBlocked"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
}

function createTinderInboundQueueService({
  repository,
  now = () => new Date(),
  createWorkItemId = () => crypto.randomUUID(),
  createEventId = () => crypto.randomUUID(),
  drawCollectionWindowMs = () => crypto.randomInt(TINDER_COLLECTION_WINDOW_MIN_MS, TINDER_COLLECTION_WINDOW_MAX_MS + 1)
} = {}) {
  requiredRepository(repository);

  async function recordVerifiedCapture(input = {}) {
    exactInput(input, ["captureId"]);
    const captureId = normalizedUuid(input.captureId, "Capture-ID");

    return repository.withTransaction(async (transaction) => {
      const snapshot = normalizeCaptureSnapshot(await repository.getCaptureWithContactForUpdate(transaction, captureId));
      await repository.lockThread(transaction, {
        deviceId: snapshot.deviceId,
        runtimeThreadFingerprint: snapshot.runtimeThreadFingerprint
      });
      const terminal = terminalVisibleMessage(snapshot);
      const duplicate = await repository.findCaptureFrameEventForUpdate(transaction, terminal.captureFrameDedupKey);
      if (duplicate) {
        return normalizeWorkItem(duplicate, { idempotent: true });
      }

      let active = await repository.findActiveWorkItemForThreadForUpdate(transaction, {
        deviceId: snapshot.deviceId,
        runtimeThreadFingerprint: snapshot.runtimeThreadFingerprint
      });

      if (terminal.direction === "OUTGOING") {
        if (!active) {
          return Object.freeze({
            channel: TINDER_INBOUND_CHANNEL,
            conversationState: TINDER_CONVERSATION_STATE.WAITING_FOR_HER,
            queueStatus: TINDER_INBOUND_WORK_STATUS.CLOSED,
            ignored: true,
            reason: "NO_OPEN_INBOUND_WORK_ITEM"
          });
        }
        if (!sameIdentityBinding(active, snapshot)) {
          const closed = await repository.closeWorkItem(transaction, active.work_item_id ?? active.workItemId, {
            reason: TINDER_INBOUND_CLOSED_REASON.IDENTITY_CHANGED,
            changedAt: nowIso(now),
            conversationState: TINDER_CONVERSATION_STATE.DORMANT
          });
          await repository.insertAudit(transaction, {
            workItemId: closed.work_item_id ?? closed.workItemId,
            action: TINDER_INBOUND_AUDIT_ACTION.IDENTITY_CHANGED,
            reasonCode: TINDER_INBOUND_CLOSED_REASON.IDENTITY_CHANGED,
            details: { captureRevision: snapshot.captureRevision, identityRevision: snapshot.identityRevision }
          });
          return normalizeWorkItem(closed);
        }
        const closed = await repository.closeWorkItem(transaction, active.work_item_id ?? active.workItemId, {
          reason: TINDER_INBOUND_CLOSED_REASON.VERIFIED_OUTBOUND,
          changedAt: nowIso(now),
          conversationState: TINDER_CONVERSATION_STATE.WAITING_FOR_HER,
          capture: snapshot
        });
        await repository.insertAudit(transaction, {
          workItemId: closed.work_item_id ?? closed.workItemId,
          action: TINDER_INBOUND_AUDIT_ACTION.VERIFIED_OUTBOUND_OBSERVED,
          reasonCode: TINDER_INBOUND_CLOSED_REASON.VERIFIED_OUTBOUND,
          details: { captureRevision: snapshot.captureRevision, identityRevision: snapshot.identityRevision }
        });
        return normalizeWorkItem(closed);
      }

      const blockReason = blockReasonFor(snapshot);
      const conversationState = blockReason === TINDER_INBOUND_BLOCK_REASON.HANDOFF_ACTIVE
        ? TINDER_CONVERSATION_STATE.HANDOFF
        : TINDER_CONVERSATION_STATE.WAITING_FOR_US;
      const queueStatus = blockReason
        ? TINDER_INBOUND_WORK_STATUS.BLOCKED
        : TINDER_INBOUND_WORK_STATUS.COLLECTING;
      const startedAt = nowIso(now);

      if (active && !sameIdentityBinding(active, snapshot)) {
        const old = await repository.closeWorkItem(transaction, active.work_item_id ?? active.workItemId, {
          reason: TINDER_INBOUND_CLOSED_REASON.IDENTITY_CHANGED,
          changedAt: startedAt,
          conversationState: TINDER_CONVERSATION_STATE.DORMANT
        });
        await repository.insertAudit(transaction, {
          workItemId: old.work_item_id ?? old.workItemId,
          action: TINDER_INBOUND_AUDIT_ACTION.IDENTITY_CHANGED,
          reasonCode: TINDER_INBOUND_CLOSED_REASON.IDENTITY_CHANGED,
          details: { captureRevision: snapshot.captureRevision, identityRevision: snapshot.identityRevision }
        });
        active = null;
      }

      if (active && sameInboundMessage(active, terminal)) {
        const refreshed = await repository.refreshWorkItemWithoutWindowReset(transaction, active.work_item_id ?? active.workItemId, {
          capture: snapshot,
          blockReason,
          conversationState,
          queueStatus
        });
        await repository.insertCaptureFrameEvent(transaction, {
          eventId: normalizedUuid(createEventId(), "Event-ID"),
          workItemId: refreshed.work_item_id ?? refreshed.workItemId,
          capture: snapshot,
          terminal,
          observedAt: startedAt
        });
        return normalizeWorkItem(refreshed, { idempotent: true });
      }

      const collectionWindowMs = drawCollectionWindow(drawCollectionWindowMs);
      const payload = Object.freeze({
        capture: snapshot,
        terminal,
        conversationState,
        queueStatus,
        blockReason,
        collectionWindowMs,
        collectionStartedAt: startedAt,
        eligibleAt: addMilliseconds(startedAt, collectionWindowMs)
      });
      const workItem = active
        ? await repository.resetWorkItemForInbound(transaction, active.work_item_id ?? active.workItemId, payload)
        : await repository.insertWorkItem(transaction, {
          workItemId: normalizedUuid(createWorkItemId(), "Work-Item-ID"),
          ...payload
        });
      await repository.insertCaptureFrameEvent(transaction, {
        eventId: normalizedUuid(createEventId(), "Event-ID"),
        workItemId: workItem.work_item_id ?? workItem.workItemId,
        capture: snapshot,
        terminal,
        observedAt: startedAt
      });
      await repository.insertAudit(transaction, {
        workItemId: workItem.work_item_id ?? workItem.workItemId,
        action: active
          ? TINDER_INBOUND_AUDIT_ACTION.COLLECTION_WINDOW_RESET
          : (blockReason ? TINDER_INBOUND_AUDIT_ACTION.WORK_ITEM_BLOCKED : TINDER_INBOUND_AUDIT_ACTION.INBOUND_ENQUEUED),
        reasonCode: blockReason,
        details: {
          captureRevision: snapshot.captureRevision,
          identityRevision: snapshot.identityRevision,
          collectionWindowMs
        }
      });
      return normalizeWorkItem(workItem);
    });
  }

  /**
   * Explicit future-worker seam.  It has no route, no startup invocation and
   * no draft/send side effect: it only changes a persisted quiet window to a
   * visible eligibility state after rechecking current authority/locks.
   */
  async function advanceDueCollectionWindows() {
    const asOf = nowIso(now);
    return repository.withTransaction(async (transaction) => {
      const due = await repository.findDueWorkItemsForUpdate(transaction, asOf);
      const outcomes = [];
      for (const row of Array.isArray(due) ? due : []) {
        const snapshot = normalizeCaptureSnapshot(row, { allowIneligible: true });
        const workItemId = normalizedUuid(valueOf(row, "workItemId", "work_item_id"), "Work-Item-ID");
        const latestInboundFingerprint = normalizedFingerprint(
          valueOf(row, "latestInboundMessageFingerprint", "latest_inbound_message_fingerprint"),
          "Inbound-Fingerprint"
        );
        const blockReason = snapshot.eligibilityProblem || blockReasonFor(snapshot);
        const currentTerminal = terminalVisibleMessage(snapshot);
        const identityBindingChanged = Number(valueOf(row, "contactId", "contact_id")) !== snapshot.contactId ||
          Number(valueOf(row, "identityRevision", "identity_revision")) !== snapshot.identityRevision;
        const isStale = currentTerminal.direction !== "INCOMING" ||
          currentTerminal.messageFingerprint !== latestInboundFingerprint;
        const effectiveBlock = isStale || identityBindingChanged
          ? TINDER_INBOUND_BLOCK_REASON.CONTEXT_REFRESH_REQUIRED
          : blockReason;
        const updated = effectiveBlock
          ? await repository.markWorkItemBlocked(transaction, workItemId, {
            reason: effectiveBlock,
            conversationState: effectiveBlock === TINDER_INBOUND_BLOCK_REASON.HANDOFF_ACTIVE
              ? TINDER_CONVERSATION_STATE.HANDOFF
              : TINDER_CONVERSATION_STATE.WAITING_FOR_US,
            changedAt: asOf
          })
          : await repository.markWorkItemEligible(transaction, workItemId, { changedAt: asOf });
        await repository.insertAudit(transaction, {
          workItemId,
          action: effectiveBlock
            ? TINDER_INBOUND_AUDIT_ACTION.WORK_ITEM_BLOCKED
            : TINDER_INBOUND_AUDIT_ACTION.WORK_ITEM_ELIGIBLE,
          reasonCode: effectiveBlock,
          details: { captureRevision: snapshot.captureRevision, identityRevision: snapshot.identityRevision }
        });
        outcomes.push(normalizeWorkItem(updated));
      }
      return Object.freeze(outcomes);
    });
  }

  return Object.freeze({ recordVerifiedCapture, advanceDueCollectionWindows });
}

function createPgTinderInboundQueueRepository(pool) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new TypeError("pool.query and pool.connect must be functions");
  }

  const captureWithContact = `
    SELECT
      c.capture_id, c.device_id, c.capture_safety_status,
      c.mapping_status, c.human_review_status, c.resolved_contact_id,
      c.runtime_thread_fingerprint, c.capture_fingerprint,
      c.capture_revision, c.identity_revision, c.visible_messages,
      c.human_takeover_active, c.handoff_active, c.received_at,
      contact.auto_reply_enabled, contact.date_lock_enabled,
      contact.manual_review_required,
      (
        SELECT MAX(newer.capture_revision)
        FROM tinder_visible_chat_captures newer
        WHERE newer.device_id = c.device_id
          AND newer.runtime_thread_fingerprint = c.runtime_thread_fingerprint
      ) AS latest_capture_revision
    FROM tinder_visible_chat_captures c
    JOIN contacts contact ON contact.id = c.resolved_contact_id`;

  const singleRow = (result) => result.rows[0] || null;

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

    async getCaptureWithContactForUpdate(client, captureId) {
      return singleRow(await client.query(`${captureWithContact}\nWHERE c.capture_id = $1\nFOR UPDATE OF c, contact`, [captureId]));
    },

    async lockThread(client, { deviceId, runtimeThreadFingerprint }) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tinder-inbound:${deviceId}:${runtimeThreadFingerprint}`]);
    },

    async findCaptureFrameEventForUpdate(client, dedupKey) {
      return singleRow(await client.query(
        `SELECT w.*
           FROM tinder_inbound_work_events event
           JOIN tinder_inbound_work_items w ON w.work_item_id = event.work_item_id
          WHERE event.dedup_key = $1
          FOR UPDATE OF event, w`,
        [dedupKey]
      ));
    },

    async findActiveWorkItemForThreadForUpdate(client, { deviceId, runtimeThreadFingerprint }) {
      return singleRow(await client.query(
        `SELECT *
           FROM tinder_inbound_work_items
          WHERE device_id = $1
            AND runtime_thread_fingerprint = $2
            AND queue_status IN ('COLLECTING', 'ELIGIBLE_FOR_NEXT_STAGE', 'BLOCKED')
          ORDER BY updated_at DESC
          FOR UPDATE`,
        [deviceId, runtimeThreadFingerprint]
      ));
    },

    async insertWorkItem(client, record) {
      return singleRow(await client.query(
        `INSERT INTO tinder_inbound_work_items (
           work_item_id, channel, device_id, contact_id, capture_id,
           capture_fingerprint, thread_ref_kind, runtime_thread_fingerprint,
           capture_revision, identity_revision, latest_inbound_message_fingerprint,
           conversation_state, queue_status, priority, block_reason,
           collection_window_ms, collection_started_at, eligible_at,
           last_verified_inbound_at, created_at, updated_at
         ) VALUES (
           $1,'tinder',$2,$3,$4,$5,'runtime_thread_fingerprint_v1',$6,
           $7,$8,$9,$10,$11,'LIVE_INBOUND',$12,$13,$14,$15,$16,$16,$16
         ) RETURNING *`,
        [
          record.workItemId, record.capture.deviceId, record.capture.contactId,
          record.capture.captureId, record.capture.captureFingerprint,
          record.capture.runtimeThreadFingerprint, record.capture.captureRevision,
          record.capture.identityRevision, record.terminal.messageFingerprint,
          record.conversationState, record.queueStatus, record.blockReason,
          record.collectionWindowMs, record.collectionStartedAt, record.eligibleAt,
          record.capture.receivedAt
        ]
      ));
    },

    async resetWorkItemForInbound(client, workItemId, record) {
      return singleRow(await client.query(
        `UPDATE tinder_inbound_work_items
            SET contact_id = $2, capture_id = $3, capture_fingerprint = $4,
                capture_revision = $5, identity_revision = $6,
                latest_inbound_message_fingerprint = $7,
                conversation_state = $8, queue_status = $9, block_reason = $10,
                closed_reason = NULL, collection_window_ms = $11,
                collection_started_at = $12, eligible_at = $13,
                last_verified_inbound_at = $14, updated_at = $12
          WHERE work_item_id = $1
          RETURNING *`,
        [
          workItemId, record.capture.contactId, record.capture.captureId,
          record.capture.captureFingerprint, record.capture.captureRevision,
          record.capture.identityRevision, record.terminal.messageFingerprint,
          record.conversationState, record.queueStatus, record.blockReason,
          record.collectionWindowMs, record.collectionStartedAt, record.eligibleAt,
          record.capture.receivedAt
        ]
      ));
    },

    async refreshWorkItemWithoutWindowReset(client, workItemId, record) {
      return singleRow(await client.query(
        `UPDATE tinder_inbound_work_items
            SET capture_id = $2, capture_fingerprint = $3,
                capture_revision = $4, identity_revision = $5,
                queue_status = CASE WHEN $6 = 'BLOCKED' THEN 'BLOCKED' ELSE queue_status END,
                conversation_state = CASE WHEN $6 = 'BLOCKED' THEN $7 ELSE conversation_state END,
                block_reason = CASE WHEN $6 = 'BLOCKED' THEN $8 ELSE block_reason END,
                updated_at = NOW()
          WHERE work_item_id = $1
          RETURNING *`,
        [
          workItemId, record.capture.captureId, record.capture.captureFingerprint,
          record.capture.captureRevision, record.capture.identityRevision,
          record.queueStatus, record.conversationState, record.blockReason
        ]
      ));
    },

    async closeWorkItem(client, workItemId, { reason, changedAt, conversationState, capture = null }) {
      const result = await client.query(
        `UPDATE tinder_inbound_work_items
            SET queue_status = 'CLOSED',
                conversation_state = $3,
                block_reason = NULL, closed_reason = $2,
                capture_id = COALESCE($4::uuid, capture_id),
                capture_fingerprint = COALESCE($5::char(64), capture_fingerprint),
                capture_revision = COALESCE($6::integer, capture_revision),
                identity_revision = COALESCE($7::integer, identity_revision),
                updated_at = $8
          WHERE work_item_id = $1
          RETURNING *`,
        [
          workItemId, reason, conversationState, capture?.captureId ?? null,
          capture?.captureFingerprint ?? null, capture?.captureRevision ?? null,
          capture?.identityRevision ?? null, changedAt
        ]
      );
      return singleRow(result);
    },

    async insertCaptureFrameEvent(client, event) {
      return singleRow(await client.query(
        `INSERT INTO tinder_inbound_work_events (
           event_id, work_item_id, capture_id, capture_fingerprint,
           terminal_message_fingerprint, dedup_key, observed_at, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         ON CONFLICT (dedup_key) DO NOTHING
         RETURNING *`,
        [
          event.eventId, event.workItemId, event.capture.captureId,
          event.capture.captureFingerprint, event.terminal.messageFingerprint,
          event.terminal.captureFrameDedupKey, event.observedAt
        ]
      ));
    },

    async insertAudit(client, entry) {
      return client.query(
        `INSERT INTO tinder_inbound_work_audit (
           work_item_id, action, reason_code, details
         ) VALUES ($1,$2,$3,$4::jsonb)`,
        [entry.workItemId, entry.action, entry.reasonCode, JSON.stringify(entry.details || {})]
      );
    },

    async findDueWorkItemsForUpdate(client, asOf) {
      const result = await client.query(
        `SELECT
           w.*,
           c.capture_safety_status, c.mapping_status, c.human_review_status,
           c.resolved_contact_id AS capture_resolved_contact_id,
           c.identity_revision AS capture_identity_revision,
           c.visible_messages, c.human_takeover_active, c.handoff_active,
           c.received_at,
           contact.auto_reply_enabled, contact.date_lock_enabled,
           contact.manual_review_required,
           (
             SELECT MAX(newer.capture_revision)
             FROM tinder_visible_chat_captures newer
             WHERE newer.device_id = c.device_id
               AND newer.runtime_thread_fingerprint = c.runtime_thread_fingerprint
           ) AS latest_capture_revision
         FROM tinder_inbound_work_items w
         JOIN tinder_visible_chat_captures c ON c.capture_id = w.capture_id
         JOIN contacts contact ON contact.id = w.contact_id
         WHERE w.queue_status = 'COLLECTING'
           AND w.eligible_at <= $1
         ORDER BY w.eligible_at ASC
         FOR UPDATE OF w, c, contact SKIP LOCKED`,
        [asOf]
      );
      return result.rows;
    },

    async markWorkItemEligible(client, workItemId, { changedAt }) {
      return singleRow(await client.query(
        `UPDATE tinder_inbound_work_items
            SET queue_status = 'ELIGIBLE_FOR_NEXT_STAGE', block_reason = NULL,
                updated_at = $2
          WHERE work_item_id = $1 AND queue_status = 'COLLECTING'
          RETURNING *`,
        [workItemId, changedAt]
      ));
    },

    async markWorkItemBlocked(client, workItemId, { reason, conversationState, changedAt }) {
      return singleRow(await client.query(
        `UPDATE tinder_inbound_work_items
            SET queue_status = 'BLOCKED', conversation_state = $2,
                block_reason = $3, updated_at = $4
          WHERE work_item_id = $1 AND queue_status = 'COLLECTING'
          RETURNING *`,
        [workItemId, conversationState, reason, changedAt]
      ));
    }
  });
}

export {
  TINDER_COLLECTION_WINDOW_MAX_MS,
  TINDER_COLLECTION_WINDOW_MIN_MS,
  TINDER_CONVERSATION_STATE,
  TINDER_INBOUND_AUDIT_ACTION,
  TINDER_INBOUND_BLOCK_REASON,
  TINDER_INBOUND_CHANNEL,
  TINDER_INBOUND_CLOSED_REASON,
  TINDER_INBOUND_WORK_STATUS,
  TINDER_THREAD_REF_KIND,
  TinderInboundQueueError,
  createPgTinderInboundQueueRepository,
  createTinderInboundQueueService
};
