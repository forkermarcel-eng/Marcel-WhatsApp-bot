import {
  observeInboxFromXml,
  observeMatchCarouselFromXml
} from "./appium-conversation-reader.js";
import { createTinderPossibleChangeDispatcher } from "./possible-change-dispatch.js";
import {
  TINDER_POSSIBLE_CHANGE_EVENT_TYPE,
  normalizeTinderDiscoveryJob
} from "./pg-boss-discovery.js";

const visibleText = value => String(value || "").normalize("NFC").replace(/\s+/gu, " ").trim();

export function planInboxReconciliation(inventory, stored) {
  return inventory.map(entry => {
    const texts = JSON.parse(entry.observed_row.ram_key).texts.map(visibleText);
    const possible = stored.filter(item => texts.includes(visibleText(item.conversation.profile?.display_name)));
    const unchanged = possible.filter(item => {
      const name = visibleText(item.conversation.profile?.display_name);
      const tail = visibleText(item.messages?.at(-1)?.text);
      if (!tail) return false;
      if (entry.last_message_visible_time !== undefined
        && entry.last_message_visible_time !== item.conversation.last_message_visible_time) return false;
      return texts.some(text => {
        if (text === name) return false;
        if (/^[↩↪↶↷]/u.test(text) && item.messages.at(-1).direction !== "outbound") return false;
        const preview = text.replace(/^[↩↪↶↷]\s*/u, "");
        // Only an unchanged visible projection, not a durable identity or a
        // claim about messages hidden behind Tinder's truncated preview.
        return preview === tail || (/…$|\.{3}$/u.test(preview)
          && preview.replace(/…$|\.{3}$/u, "").length >= 12
          && tail.startsWith(preview.replace(/…$|\.{3}$/u, "")));
      });
    });
    const identicalRows = inventory.filter(other =>
      JSON.stringify(JSON.parse(other.observed_row.ram_key).texts.map(visibleText)) === JSON.stringify(texts)).length;
    if (identicalRows !== 1 || unchanged.length > 1) return { entry, action: "AMBIGUOUS" };
    if (unchanged.length === 1) return { entry, action: "UNCHANGED", conversation: unchanged[0].conversation };
    return { entry, action: possible.length ? "REVALIDATE" : "INITIAL_READ" };
  });
}

function assertRuntime(value) {
  if (!value || typeof value !== "object") throw new TypeError("A local Tinder runtime is required");
  const methods = ["readSourceXml", "readKnownChanged", "readNewThread", "readMatchDiscovery"];
  for (const method of methods) {
    if (typeof value[method] !== "function") throw new TypeError(`Local Tinder runtime must expose ${method}()`);
  }
  if (typeof value.deviceId !== "string" || !value.deviceId) {
    throw new TypeError("Local Tinder runtime must expose deviceId");
  }
}

function assertCandidateOutcome(value, allowed) {
  if (!value || typeof value !== "object" || !allowed.has(value.outcome)) {
    throw new Error("Local Tinder candidate processor returned an invalid outcome");
  }
  return value;
}

function bindingKey(row) {
  return typeof row?.ram_key === "string" && row.ram_key ? row.ram_key : null;
}

function directCurrentRow(projection, candidate) {
  const row = projection?.rows?.[candidate.current_index];
  return bindingKey(row) ? row : null;
}

/*
 * This is the small composition missing from the old source comparator. It
 * retains only direct, in-process row continuity after this worker has itself
 * completed an initial read or revalidated stored ordered Messages. No RAM
 * binding is reconstructed from a name or an old Inbox position alone.
 */
export function createLocalTinderDiscoveryExecutor({
  runtime,
  debounceMilliseconds = 1_500,
  setTimeoutFn = setTimeout
} = {}) {
  assertRuntime(runtime);
  if (!Number.isInteger(debounceMilliseconds) || debounceMilliseconds < 0 || debounceMilliseconds > 30_000) {
    throw new TypeError("debounceMilliseconds must be between 0 and 30000");
  }

  let previousInbox = null;
  let currentInbox = null;
  let currentMatches = null;
  const directBindings = new Map();

  async function readSourceXml() {
    const xml = await runtime.readSourceXml();
    previousInbox = currentInbox;
    currentInbox = observeInboxFromXml(xml);
    currentMatches = observeMatchCarouselFromXml(xml);
    return xml;
  }

  async function processInboxCandidate(candidate) {
    const currentRow = directCurrentRow(currentInbox, candidate);
    if (!currentRow) return "AMBIGUOUS";

    if (candidate.source_change === "SINGLE_REPLACEMENT") {
      const previousRow = previousInbox?.rows?.[candidate.previous_index] || null;
      const previousKey = bindingKey(previousRow);
      const conversationId = previousKey ? directBindings.get(previousKey) : null;
      if (!conversationId && typeof runtime.readUnboundChanged !== "function") return "AMBIGUOUS";
      const observed = assertCandidateOutcome(
        conversationId
          ? await runtime.readKnownChanged({ row: currentRow, conversationId, candidate })
          : await runtime.readUnboundChanged({ row: currentRow, candidate }),
        new Set(["KNOWN_CHANGED", "AMBIGUOUS", "UNCHANGED"])
      );
      if (observed.outcome !== "KNOWN_CHANGED") return observed;
      const currentKey = bindingKey(currentRow);
      directBindings.delete(previousKey);
      directBindings.set(currentKey, conversationId || observed.conversation_id);
      return "KNOWN_CHANGED";
    }

    if (candidate.source_change === "SINGLE_INSERTION") {
      const observed = assertCandidateOutcome(
        await runtime.readNewThread({ row: currentRow, candidate }),
        new Set(["NEW_THREAD", "KNOWN_CHANGED", "AMBIGUOUS", "UNCHANGED"])
      );
      if (observed.outcome !== "NEW_THREAD" && observed.outcome !== "KNOWN_CHANGED") return observed;
      if (typeof observed.conversation_id !== "string" || !observed.conversation_id) {
        throw new Error("A completed initial Tinder read requires its existing conversation ID");
      }
      directBindings.set(bindingKey(currentRow), observed.conversation_id);
      return observed.outcome;
    }

    return "AMBIGUOUS";
  }

  async function processMatchCandidate(candidate) {
    if (!currentMatches?.tiles?.[candidate.current_index]) return "AMBIGUOUS";
    const observed = assertCandidateOutcome(
      await runtime.readMatchDiscovery({
        tile: currentMatches.tiles[candidate.current_index],
        candidate
      }),
      new Set(["MATCH_UPDATED", "AMBIGUOUS", "UNCHANGED"])
    );
    return observed.outcome;
  }

  const dispatcher = createTinderPossibleChangeDispatcher({
    readSourceXml,
    reconcile: runtime.reconcile || null,
    onInboxSourceCandidate: processInboxCandidate,
    onMatchSourceCandidate: processMatchCandidate,
    debounceMilliseconds,
    setTimeoutFn
  });

  async function signal(job) {
    const payload = normalizeTinderDiscoveryJob(job);
    if (payload.device_id !== runtime.deviceId) {
      throw new Error("Tinder discovery job targets a different local device");
    }
    return dispatcher.signal({ event_type: TINDER_POSSIBLE_CHANGE_EVENT_TYPE });
  }

  return Object.freeze({
    initialize: () => dispatcher.inspect(),
    signal,
    // Test-only bounded visibility: count only ephemeral direct bindings, not
    // a persisted Tinder identity or database state.
    localBindingCount: () => directBindings.size
  });
}
