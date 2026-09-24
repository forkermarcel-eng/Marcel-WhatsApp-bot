import crypto from "node:crypto";

/*
 * Block 2 stores only ordinary Tinder product data.  It deliberately has no
 * capture, permit, receipt, contact mapping, or Appium element-id model.
 * Appium remains responsible for navigation and observation; this module only
 * normalizes a completed observation and persists a Conversation + messages +
 * profile snapshot.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ATTRIBUTE_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_MESSAGES = 5_000;
const MAX_MESSAGE_TEXT = 12_000;
const MAX_PROFILE_TEXT = 12_000;
const MAX_PROFILE_ATTRIBUTES = 32;
const MAX_MEDIA_REFS = 40;

export class TinderMirrorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "TinderMirrorError";
    this.code = code;
    this.status = status;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedText(value, field, maximum, { nullable = false } = {}) {
  if (value === undefined || value === null) {
    if (nullable) return null;
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", `${field} is required`);
  }
  if (typeof value !== "string") {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", `${field} must be text`);
  }
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > maximum) {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", `${field} is invalid`);
  }
  return normalized;
}

function nullableText(value, field, maximum) {
  if (value === undefined || value === null || value === "") return null;
  return normalizedText(value, field, maximum);
}

function normalizeMediaRef(value) {
  const reference = normalizedText(value, "profile.media_refs", 2_048);
  let url;
  try {
    url = new URL(reference);
  } catch {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "profile media reference is invalid");
  }
  if (!new Set(["https:", "http:"]).has(url.protocol)) {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "profile media reference is not a regular remote reference");
  }
  return url.toString();
}

export function normalizeTinderProfile(value) {
  if (!plainObject(value)) {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "profile must be an object");
  }
  const allowed = new Set(["display_name", "attributes", "media_refs"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "profile contains unsupported fields");
  }

  const displayName = normalizedText(value.display_name, "profile.display_name", 160);
  const rawAttributes = value.attributes ?? {};
  if (!plainObject(rawAttributes) || Object.keys(rawAttributes).length > MAX_PROFILE_ATTRIBUTES) {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "profile attributes are invalid");
  }
  const attributes = {};
  for (const [key, rawValue] of Object.entries(rawAttributes)) {
    if (!ATTRIBUTE_KEY.test(key)) {
      throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "profile attribute key is invalid");
    }
    attributes[key] = normalizedText(rawValue, `profile.attributes.${key}`, MAX_PROFILE_TEXT);
  }

  const rawMediaRefs = value.media_refs ?? [];
  if (!Array.isArray(rawMediaRefs) || rawMediaRefs.length > MAX_MEDIA_REFS) {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "profile media references are invalid");
  }
  const mediaRefs = [...new Set(rawMediaRefs.map(normalizeMediaRef))];

  return Object.freeze({
    display_name: displayName,
    attributes: Object.freeze(attributes),
    media_refs: Object.freeze(mediaRefs)
  });
}

export function normalizeTinderMessage(value) {
  if (!plainObject(value)) {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "message must be an object");
  }
  const allowed = new Set(["direction", "text", "visible_time", "visible_status"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "message contains unsupported fields");
  }
  const direction = String(value.direction || "").trim().toUpperCase();
  if (!new Set(["INBOUND", "OUTBOUND"]).has(direction)) {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "message direction is invalid");
  }
  return Object.freeze({
    direction,
    text: normalizedText(value.text, "message.text", MAX_MESSAGE_TEXT),
    visible_time: nullableText(value.visible_time, "message.visible_time", 256),
    visible_status: nullableText(value.visible_status, "message.visible_status", 256)
  });
}

export function normalizeTinderMirrorPayload(value, { requireCompleteHistory = false } = {}) {
  if (!plainObject(value)) {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "payload must be an object");
  }
  const allowed = new Set(["continuation_conversation_id", "profile", "messages", "history_complete"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "payload contains unsupported fields");
  }
  const continuation = value.continuation_conversation_id;
  if (continuation !== undefined && continuation !== null && (!UUID_V4.test(continuation))) {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "continuation conversation id is invalid");
  }
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > MAX_MESSAGES) {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "messages are invalid");
  }
  if (typeof value.history_complete !== "boolean") {
    throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "history_complete must be boolean");
  }
  if (requireCompleteHistory && value.history_complete !== true) {
    throw new TinderMirrorError("TINDER_HISTORY_NOT_COMPLETE", "A completed reachable history is required before persistence");
  }
  return Object.freeze({
    continuation_conversation_id: continuation || null,
    profile: normalizeTinderProfile(value.profile),
    messages: Object.freeze(value.messages.map(normalizeTinderMessage)),
    history_complete: value.history_complete
  });
}

function sameOptionalText(left, right) {
  return left === null || right === null || left === right;
}

export function messagesEqual(left, right) {
  return left.direction === right.direction
    && left.text === right.text
    && sameOptionalText(left.visible_time, right.visible_time)
    && sameOptionalText(left.visible_status, right.visible_status);
}

/*
 * Direction is a property that the observer can correct after seeing a
 * bubble's real container.  It must not prevent the same ordered message
 * from being recognized while that correction is being applied.  This is
 * deliberately not a fingerprint: it is only an ordered equality check for
 * the ordinary message fields already persisted by the mirror.
 */
export function messageIdentityEqual(left, right) {
  return left.text === right.text
    && sameOptionalText(left.visible_time, right.visible_time)
    && sameOptionalText(left.visible_status, right.visible_status);
}

function sequenceMatchesAt(haystack, needle, start, equals = messagesEqual) {
  return needle.every((message, offset) => equals(haystack[start + offset], message));
}

function findSequenceStart(haystack, needle, equals = messagesEqual) {
  if (needle.length === 0) return 0;
  if (needle.length > haystack.length) return -1;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (sequenceMatchesAt(haystack, needle, start, equals)) return start;
  }
  return -1;
}

function containsSequence(haystack, needle, equals = messagesEqual) {
  return findSequenceStart(haystack, needle, equals) !== -1;
}

function boundaryOverlap(left, right, equals = messagesEqual) {
  const maximum = Math.min(left.length, right.length);
  for (let size = maximum; size > 0; size -= 1) {
    if (sequenceMatchesAt(left, right.slice(0, size), left.length - size, equals)) return size;
  }
  return 0;
}

export function largestContiguousOverlap(left, right, { identityOnly = false } = {}) {
  const equals = identityOnly ? messageIdentityEqual : messagesEqual;
  let largest = 0;
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      let size = 0;
      while (leftIndex + size < left.length
        && rightIndex + size < right.length
        && equals(left[leftIndex + size], right[rightIndex + size])) {
        size += 1;
      }
      largest = Math.max(largest, size);
    }
  }
  return largest;
}

/*
 * This is sequence overlap, not a message fingerprint: repeated equal text is
 * retained when it appears at different positions.  A non-overlapping viewport
 * is refused rather than guessed into an order.
 */
export function mergeTinderHistory(existing, observed) {
  if (existing.length === 0) return [...observed];
  if (observed.length === 0) return [...existing];

  const mergeObserved = (stored, fresh) => ({
    direction: fresh.direction,
    text: fresh.text,
    visible_time: fresh.visible_time ?? stored.visible_time ?? null,
    visible_status: fresh.visible_status ?? stored.visible_status ?? null
  });
  const overlay = (stored, fresh) => fresh.map((message, index) => mergeObserved(stored[index], message));

  const observedInExistingAt = findSequenceStart(existing, observed, messageIdentityEqual);
  if (observedInExistingAt !== -1) {
    return [
      ...existing.slice(0, observedInExistingAt),
      ...overlay(existing.slice(observedInExistingAt, observedInExistingAt + observed.length), observed),
      ...existing.slice(observedInExistingAt + observed.length)
    ];
  }

  const existingInObservedAt = findSequenceStart(observed, existing, messageIdentityEqual);
  if (existingInObservedAt !== -1) {
    return [
      ...observed.slice(0, existingInObservedAt),
      ...overlay(existing, observed.slice(existingInObservedAt, existingInObservedAt + existing.length)),
      ...observed.slice(existingInObservedAt + existing.length)
    ];
  }

  const existingThenObserved = boundaryOverlap(existing, observed, messageIdentityEqual);
  if (existingThenObserved > 0) {
    return [
      ...existing.slice(0, existing.length - existingThenObserved),
      ...overlay(existing.slice(existing.length - existingThenObserved), observed.slice(0, existingThenObserved)),
      ...observed.slice(existingThenObserved)
    ];
  }
  const observedThenExisting = boundaryOverlap(observed, existing, messageIdentityEqual);
  if (observedThenExisting > 0) {
    return [
      ...observed.slice(0, observed.length - observedThenExisting),
      ...overlay(existing.slice(0, observedThenExisting), observed.slice(observed.length - observedThenExisting)),
      ...existing.slice(observedThenExisting)
    ];
  }
  throw new TinderMirrorError(
    "TINDER_HISTORY_OVERLAP_UNVERIFIED",
    "History viewports do not share an ordered overlap"
  );
}

function asProfile(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return plainObject(value) ? value : {};
}

function normalizedStoredProfile(value) {
  try {
    return normalizeTinderProfile(asProfile(value));
  } catch {
    return null;
  }
}

function profileDoesNotConflict(storedValue, observedProfile) {
  const stored = normalizedStoredProfile(storedValue);
  if (!stored || stored.display_name !== observedProfile.display_name) return false;
  const storedAttributes = stored.attributes || {};
  const observedAttributes = observedProfile.attributes || {};
  const sharedKeys = Object.keys(storedAttributes).filter((key) => Object.hasOwn(observedAttributes, key));
  if (sharedKeys.some((key) => storedAttributes[key] !== observedAttributes[key])) return false;
  return true;
}

function hasCompatibleProfileEvidence(storedValue, observedProfile) {
  if (!profileDoesNotConflict(storedValue, observedProfile)) return false;
  const stored = normalizedStoredProfile(storedValue);
  const storedAttributes = stored.attributes || {};
  const observedAttributes = observedProfile.attributes || {};
  const sharedKeys = Object.keys(storedAttributes).filter((key) => Object.hasOwn(observedAttributes, key));
  if (sharedKeys.some((key) => storedAttributes[key] === observedAttributes[key])) return true;
  return stored.media_refs.some((reference) => observedProfile.media_refs.includes(reference));
}

export function selectConservativeConversationMatch(candidates, observation) {
  const matches = candidates.filter((candidate) => hasCompatibleProfileEvidence(candidate.profile, observation.profile)
    // A re-read can correct the UI-derived direction while every ordinary
    // product field is unchanged.  Direction therefore cannot be a matching
    // precondition here; profile evidence and two ordered ordinary messages
    // still make an ambiguous match fail closed.
    && largestContiguousOverlap(candidate.messages || [], observation.messages, { identityOnly: true }) >= 2);
  return matches.length === 1 ? matches[0] : null;
}

export function mergeTinderProfile(existingValue, observedProfile) {
  const existing = normalizedStoredProfile(existingValue);
  if (!existing) return observedProfile;
  return Object.freeze({
    display_name: observedProfile.display_name,
    attributes: Object.freeze({ ...existing.attributes, ...observedProfile.attributes }),
    media_refs: Object.freeze([...new Set([...existing.media_refs, ...observedProfile.media_refs])])
  });
}

function profilesEqual(leftValue, rightValue) {
  const left = normalizedStoredProfile(leftValue);
  const right = normalizedStoredProfile(rightValue);
  if (!left || !right || left.display_name !== right.display_name) return false;
  const leftKeys = Object.keys(left.attributes).sort();
  const rightKeys = Object.keys(right.attributes).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  if (leftKeys.some((key) => left.attributes[key] !== right.attributes[key])) return false;
  return left.media_refs.length === right.media_refs.length
    && left.media_refs.every((reference) => right.media_refs.includes(reference));
}

function dbMessage(row) {
  return {
    direction: row.direction,
    text: row.message_text,
    visible_time: row.visible_time ?? null,
    visible_status: row.visible_status ?? null
  };
}

function publicConversation(row, messageCount = null) {
  return {
    id: row.conversation_id,
    channel: "tinder",
    profile: asProfile(row.profile),
    history_complete: Boolean(row.history_complete),
    profile_synced_at: row.profile_synced_at ? new Date(row.profile_synced_at).toISOString() : null,
    history_synced_at: row.history_synced_at ? new Date(row.history_synced_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    ...(messageCount === null ? {} : { message_count: Number(messageCount) })
  };
}

function isSchemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

function mapDatabaseError(error) {
  if (error instanceof TinderMirrorError) return error;
  if (isSchemaMissing(error)) {
    return new TinderMirrorError(
      "TINDER_MIRROR_SCHEMA_UNAVAILABLE",
      "Tinder mirror schema is not available",
      503
    );
  }
  return error;
}

async function assertExistingDevice(client, deviceId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT device_id FROM device_bridge_devices WHERE device_id=$1${lock ? " FOR UPDATE" : ""}`,
    [deviceId]
  );
  if (!result.rows[0]) {
    throw new TinderMirrorError("TINDER_DEVICE_NOT_FOUND", "The selected device is not enrolled", 404);
  }
}

async function readConversationMessages(client, conversationId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT message_id, ordinal, direction, message_text, visible_time, visible_status
       FROM tinder_conversation_messages
      WHERE conversation_id=$1
      ORDER BY ordinal ASC${lock ? " FOR UPDATE" : ""}`,
    [conversationId]
  );
  return result.rows;
}

function messagesFromRows(rows) {
  return rows.map(dbMessage);
}

async function loadConversationMessageRows(client, conversationId, options = {}) {
  return readConversationMessages(client, conversationId, options);
}

async function loadCandidateConversations(client, deviceId, displayName, { lock = false } = {}) {
  const result = await client.query(
    `SELECT conversation_id, device_id, profile, history_complete, profile_synced_at,
            history_synced_at, created_at, updated_at
       FROM tinder_conversations
      WHERE device_id=$1 AND profile->>'display_name'=$2
      ORDER BY created_at ASC
      LIMIT 25${lock ? " FOR UPDATE" : ""}`,
    [deviceId, displayName]
  );
  return Promise.all(result.rows.map(async (row) => {
    const messageRows = await loadConversationMessageRows(client, row.conversation_id, { lock });
    return { ...row, messageRows, messages: messagesFromRows(messageRows) };
  }));
}

async function loadContinuationConversation(client, deviceId, conversationId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT conversation_id, device_id, profile, history_complete, profile_synced_at,
            history_synced_at, created_at, updated_at
       FROM tinder_conversations
      WHERE device_id=$1 AND conversation_id=$2${lock ? " FOR UPDATE" : ""}`,
    [deviceId, conversationId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const messageRows = await loadConversationMessageRows(client, row.conversation_id, { lock });
  return { ...row, messageRows, messages: messagesFromRows(messageRows) };
}

async function resolveStoredConversation(client, deviceId, observation, { lock = false, continuationRequired = false } = {}) {
  if (observation.continuation_conversation_id) {
    const continuation = await loadContinuationConversation(client, deviceId, observation.continuation_conversation_id, { lock });
    if (continuation
      && profileDoesNotConflict(continuation.profile, observation.profile)
      && largestContiguousOverlap(continuation.messages, observation.messages, { identityOnly: true }) >= 2) {
      return continuation;
    }
    if (continuationRequired) {
      throw new TinderMirrorError(
        "TINDER_CONTINUATION_UNVERIFIED",
        "The selected existing conversation no longer matches the observed ordered history",
        409
      );
    }
  }
  const candidates = await loadCandidateConversations(client, deviceId, observation.profile.display_name, { lock });
  return selectConservativeConversationMatch(candidates, observation);
}

async function insertMessages(client, conversationId, messages, { startOrdinal = 0 } = {}) {
  for (const [ordinal, message] of messages.entries()) {
    await client.query(
      `INSERT INTO tinder_conversation_messages
         (message_id, conversation_id, ordinal, direction, message_text, visible_time, visible_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [crypto.randomUUID(), conversationId, startOrdinal + ordinal, message.direction, message.text,
        message.visible_time, message.visible_status]
    );
  }
}

function historiesEqual(left, right) {
  return left.length === right.length && left.every((message, index) => messagesEqual(message, right[index]));
}

/*
 * A completed re-read can prepend older messages and can fix a direction.
 * Preserve every already stored row when its ordinary ordered identity still
 * exists in the assembled history; only genuinely new messages are inserted.
 * If that preservation cannot be proven, abort the transaction rather than
 * delete or recreate a history.
 */
async function reconcileMessagesInPlace(client, conversationId, existingRows, desiredMessages) {
  const storedMessages = messagesFromRows(existingRows);
  const existingAt = findSequenceStart(desiredMessages, storedMessages, messageIdentityEqual);
  if (existingAt === -1) {
    throw new TinderMirrorError(
      "TINDER_HISTORY_RECONCILIATION_UNVERIFIED",
      "Existing history cannot be aligned with the completed observed history"
    );
  }

  const mapped = existingRows.map((row, index) => ({ row, message: desiredMessages[existingAt + index], ordinal: existingAt + index }));
  const requiresOrdinalShift = mapped.some(({ row, ordinal }) => Number(row.ordinal) !== ordinal);
  if (requiresOrdinalShift) {
    const largestStoredOrdinal = Math.max(-1, ...existingRows.map((row) => Number(row.ordinal)));
    const offset = largestStoredOrdinal + desiredMessages.length + existingRows.length + 1;
    await client.query(
      "UPDATE tinder_conversation_messages SET ordinal=ordinal+$2 WHERE conversation_id=$1",
      [conversationId, offset]
    );
  }

  for (const { row, message, ordinal } of mapped) {
    if (requiresOrdinalShift || Number(row.ordinal) !== ordinal || !messagesEqual(dbMessage(row), message)) {
      await client.query(
        `UPDATE tinder_conversation_messages
            SET ordinal=$3, direction=$4, message_text=$5, visible_time=$6, visible_status=$7
          WHERE conversation_id=$1 AND message_id=$2`,
        [conversationId, row.message_id, ordinal, message.direction, message.text,
          message.visible_time, message.visible_status]
      );
    }
  }

  const before = desiredMessages.slice(0, existingAt);
  const after = desiredMessages.slice(existingAt + existingRows.length);
  await insertMessages(client, conversationId, before, { startOrdinal: 0 });
  await insertMessages(client, conversationId, after, { startOrdinal: existingAt + existingRows.length });
}

export function createTinderConversationMirror({ pool, now = () => new Date(), idFactory = crypto.randomUUID }) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("A PostgreSQL pool is required");

  async function resolve({ deviceId, payload }) {
    if (!UUID_V4.test(deviceId || "")) {
      throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "device id is invalid");
    }
    const observation = normalizeTinderMirrorPayload(payload);
    const client = await pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await assertExistingDevice(client, deviceId);
      const conversation = await resolveStoredConversation(client, deviceId, observation);
      await client.query("COMMIT");
      if (!conversation) {
        return Object.freeze({ action: "READ_HISTORY", conversation: null });
      }
      return Object.freeze({
        action: conversation.history_complete ? "SKIP_HISTORY" : "READ_HISTORY",
        conversation: publicConversation(conversation, conversation.messages.length)
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async function sync({ deviceId, payload }) {
    if (!UUID_V4.test(deviceId || "")) {
      throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "device id is invalid");
    }
    const observation = normalizeTinderMirrorPayload(payload, { requireCompleteHistory: true });
    const timestamp = now();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serializing at the ordinary device row prevents concurrent adapters
      // from creating two initial records before either can be recognized.
      await assertExistingDevice(client, deviceId, { lock: true });
      let conversation = await resolveStoredConversation(client, deviceId, observation, {
        lock: true,
        continuationRequired: Boolean(observation.continuation_conversation_id)
      });
      let created = false;
      let historyChanged = false;

      if (!conversation) {
        const conversationId = idFactory();
        await client.query(
          `INSERT INTO tinder_conversations
             (conversation_id, device_id, channel, profile, history_complete,
              profile_synced_at, history_synced_at, created_at, updated_at)
           VALUES ($1,$2,'tinder',$3::jsonb,$4,$5,$5,$5,$5)`,
          [conversationId, deviceId, JSON.stringify(observation.profile), observation.history_complete, timestamp]
        );
        await insertMessages(client, conversationId, observation.messages);
        conversation = {
          conversation_id: conversationId,
          device_id: deviceId,
          profile: observation.profile,
          history_complete: observation.history_complete,
          profile_synced_at: timestamp,
          history_synced_at: timestamp,
          created_at: timestamp,
          updated_at: timestamp,
          messages: observation.messages
        };
        created = true;
        historyChanged = true;
      } else {
        const mergedProfile = mergeTinderProfile(conversation.profile, observation.profile);
        const mergedHistory = mergeTinderHistory(conversation.messages, observation.messages);
        const profileChanged = !profilesEqual(mergedProfile, conversation.profile);
        historyChanged = !historiesEqual(mergedHistory, conversation.messages);
        const completionChanged = Boolean(conversation.history_complete) !== observation.history_complete;
        if (profileChanged || historyChanged || completionChanged) {
          await client.query(
            `UPDATE tinder_conversations
                SET profile=$2::jsonb, history_complete=$3,
                    profile_synced_at=CASE WHEN $4 THEN $5 ELSE profile_synced_at END,
                    history_synced_at=CASE WHEN $6 THEN $5 ELSE history_synced_at END,
                    updated_at=$5
              WHERE conversation_id=$1`,
            [conversation.conversation_id, JSON.stringify(mergedProfile), observation.history_complete,
              profileChanged, timestamp, historyChanged || completionChanged]
          );
          if (historyChanged) {
            await reconcileMessagesInPlace(
              client,
              conversation.conversation_id,
              conversation.messageRows,
              mergedHistory
            );
          }
        }
        conversation = {
          ...conversation,
          profile: mergedProfile,
          messages: mergedHistory,
          history_complete: observation.history_complete,
          profile_synced_at: profileChanged ? timestamp : conversation.profile_synced_at,
          history_synced_at: historyChanged || completionChanged ? timestamp : conversation.history_synced_at,
          updated_at: profileChanged || historyChanged || completionChanged ? timestamp : conversation.updated_at
        };
      }
      await client.query("COMMIT");
      return Object.freeze({
        created,
        history_changed: historyChanged,
        conversation: publicConversation(conversation, conversation.messages.length)
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async function list() {
    try {
      const result = await pool.query(
        `SELECT c.conversation_id, c.profile, c.history_complete, c.profile_synced_at,
                c.history_synced_at, c.created_at, c.updated_at, COUNT(m.message_id)::int AS message_count
           FROM tinder_conversations c
           LEFT JOIN tinder_conversation_messages m ON m.conversation_id=c.conversation_id
          GROUP BY c.conversation_id
          ORDER BY c.updated_at DESC, c.created_at DESC`
      );
      return result.rows.map((row) => publicConversation(row, row.message_count));
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  async function detail(conversationId) {
    if (!UUID_V4.test(conversationId || "")) {
      throw new TinderMirrorError("INVALID_TINDER_MIRROR_PAYLOAD", "conversation id is invalid");
    }
    try {
      const result = await pool.query(
        `SELECT conversation_id, profile, history_complete, profile_synced_at,
                history_synced_at, created_at, updated_at
           FROM tinder_conversations
          WHERE conversation_id=$1`,
        [conversationId]
      );
      const row = result.rows[0];
      if (!row) throw new TinderMirrorError("TINDER_CONVERSATION_NOT_FOUND", "Conversation not found", 404);
      const messages = messagesFromRows(await readConversationMessages(pool, conversationId));
      return {
        conversation: publicConversation(row, messages.length),
        messages: messages.map((message, index) => ({ order: index, ...message }))
      };
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  return Object.freeze({ resolve, sync, list, detail });
}
