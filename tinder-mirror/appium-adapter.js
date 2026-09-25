import {
  mergeTinderHistory,
  normalizeTinderConversationDeltaPayload,
  normalizeTinderMirrorPayload
} from "./conversation.js";

/*
 * Appium/UiAutomator2 control deliberately stays outside this adapter.  The
 * caller supplies freshly observed visible profile/message snapshots after its
 * own allowed Appium actions.  No element ID, screenshot, node tree, or UI
 * coordinate crosses this boundary.
 */
export function createTinderAppiumAdapter({ deviceId, transport }) {
  if (typeof deviceId !== "string" || !deviceId) throw new TypeError("deviceId is required");
  if (!transport || typeof transport.resolve !== "function" || typeof transport.sync !== "function") {
    throw new TypeError("transport.resolve and transport.sync are required");
  }
  let state = null;

  function start({
    profile,
    messages,
    continuationConversationId = null,
    directContinuityRepair = false,
    lastMessageVisibleTime = undefined,
    inboxPosition = undefined
  }) {
    if (typeof directContinuityRepair !== "boolean") {
      throw new TypeError("directContinuityRepair must be a boolean");
    }
    state = {
      profile,
      messages: [...messages],
      continuation_conversation_id: continuationConversationId,
      direct_continuity_repair: directContinuityRepair,
      last_message_visible_time: lastMessageVisibleTime,
      inbox_position: inboxPosition
    };
  }

  function appendViewport(messages) {
    if (!state) throw new Error("No Tinder conversation is active");
    state.messages = mergeTinderHistory(state.messages, messages);
    return [...state.messages];
  }

  function observation(historyComplete = false) {
    if (!state) throw new Error("No Tinder conversation is active");
    const normalized = normalizeTinderMirrorPayload({
      continuation_conversation_id: state.continuation_conversation_id,
      ...(state.direct_continuity_repair ? { direct_continuity_repair: true } : {}),
      profile: state.profile,
      messages: state.messages,
      history_complete: historyComplete,
      ...(state.last_message_visible_time === undefined
        ? {}
        : { last_message_visible_time: state.last_message_visible_time }),
      ...(state.inbox_position === undefined ? {} : { inbox_position: state.inbox_position })
    });
    // `has_*` is server-local normalization bookkeeping.  The ordinary
    // dashboard transport accepts only source product fields and must never
    // receive those helper flags as part of its public observation contract.
    const {
      has_last_message_visible_time: _hasLastMessageVisibleTime,
      has_inbox_position: _hasInboxPosition,
      ...wireObservation
    } = normalized;
    return Object.freeze(wireObservation);
  }

  async function resolve() {
    const result = await transport.resolve({ deviceId, observation: observation(false) });
    if (result?.conversation?.id) state.continuation_conversation_id = result.conversation.id;
    return result;
  }

  async function persistCompletedHistory({ oldestBoundaryReached } = {}) {
    if (oldestBoundaryReached !== true) {
      throw new Error("A verified oldest history boundary is required before completion can be persisted");
    }
    const result = await transport.sync({ deviceId, observation: observation(true) });
    if (result?.conversation?.id) state.continuation_conversation_id = result.conversation.id;
    return result;
  }

  function clear() {
    state = null;
  }

  return Object.freeze({ start, appendViewport, resolve, persistCompletedHistory, clear });
}

/*
 * A live delta has no profile or history-reader state.  Keeping it separate
 * from the initial/full-history adapter makes that boundary explicit: callers
 * can submit only the freshly observed normal message viewport to an already
 * selected Conversation.
 */
export function createTinderAppiumDeltaAdapter({ deviceId, conversationId, transport }) {
  if (typeof deviceId !== "string" || !deviceId) throw new TypeError("deviceId is required");
  if (typeof conversationId !== "string" || !conversationId) throw new TypeError("conversationId is required");
  if (!transport || typeof transport.appendDelta !== "function") {
    throw new TypeError("transport.appendDelta is required");
  }

  async function persistViewport(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("A normal message viewport is required");
    }
    const allowed = new Set(["messages", "lastMessageVisibleTime", "inboxPosition"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) {
      throw new TypeError("A live Tinder delta cannot include profile or history fields");
    }
    const {
      messages,
      lastMessageVisibleTime = undefined,
      inboxPosition = undefined
    } = input;
    const normalized = normalizeTinderConversationDeltaPayload({
      messages,
      ...(lastMessageVisibleTime === undefined ? {} : { last_message_visible_time: lastMessageVisibleTime }),
      ...(inboxPosition === undefined ? {} : { inbox_position: inboxPosition })
    });
    const {
      has_last_message_visible_time: _hasLastMessageVisibleTime,
      has_inbox_position: _hasInboxPosition,
      ...delta
    } = normalized;
    return transport.appendDelta({ deviceId, conversationId, delta: Object.freeze(delta) });
  }

  return Object.freeze({ persistViewport });
}

export function createExistingDashboardBearerTransport({ baseUrl, bearerToken, fetchImpl = fetch }) {
  const origin = String(baseUrl || "").replace(/\/+$/, "");
  if (!origin || typeof bearerToken !== "string" || !bearerToken) {
    throw new TypeError("baseUrl and the existing dashboard bearer token are required");
  }
  async function request(path, body) {
    const response = await fetchImpl(`${origin}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(body),
      cache: "no-store"
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || "Tinder mirror ingress failed");
    }
    return data;
  }
  return Object.freeze({
    resolve: ({ deviceId, observation }) => request("/dashboard-api/tinder/conversations/resolve", {
      device_id: deviceId,
      observation
    }),
    sync: ({ deviceId, observation }) => request("/dashboard-api/tinder/conversations", {
      device_id: deviceId,
      observation
    }),
    appendDelta: ({ deviceId, conversationId, delta }) => request(
      `/dashboard-api/tinder/conversations/${encodeURIComponent(conversationId)}/delta`,
      { device_id: deviceId, delta }
    ),
    updateInboxOrder: ({ deviceId, conversationId, inboxPosition, lastMessageVisibleTime = undefined }) => request(
      `/dashboard-api/tinder/conversations/${encodeURIComponent(conversationId)}/inbox-order`,
      {
        device_id: deviceId,
        inbox_position: inboxPosition,
        ...(lastMessageVisibleTime === undefined ? {} : { last_message_visible_time: lastMessageVisibleTime })
      }
    )
  });
}
