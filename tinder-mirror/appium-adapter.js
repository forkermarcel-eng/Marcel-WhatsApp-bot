import { mergeTinderHistory, normalizeTinderMirrorPayload } from "./conversation.js";

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

  function start({ profile, messages, continuationConversationId = null }) {
    state = {
      profile,
      messages: [...messages],
      continuation_conversation_id: continuationConversationId
    };
  }

  function appendViewport(messages) {
    if (!state) throw new Error("No Tinder conversation is active");
    state.messages = mergeTinderHistory(state.messages, messages);
    return [...state.messages];
  }

  function observation(historyComplete = false) {
    if (!state) throw new Error("No Tinder conversation is active");
    return normalizeTinderMirrorPayload({
      continuation_conversation_id: state.continuation_conversation_id,
      profile: state.profile,
      messages: state.messages,
      history_complete: historyComplete
    });
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
    })
  });
}
