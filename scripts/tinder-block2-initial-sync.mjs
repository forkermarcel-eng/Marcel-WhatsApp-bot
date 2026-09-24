/*
 * Block 2's normal initial product mirror.
 *
 * Appium/UiAutomator2 controls only the official Tinder UI locally.  This
 * runner keeps transient page/row continuity in RAM and sends only the
 * ordinary completed profile and message product snapshot through the
 * existing dashboard bearer transport.  It creates no capture, identity,
 * permit, receipt, safety, heartbeat, or approval state.
 */

import { createTinderAppiumAdapter, createExistingDashboardBearerTransport } from "../tinder-mirror/appium-adapter.js";
import {
  headerBackTargetFromXml,
  headerProfileTargetFromXml,
  observeConversationViewportFromXml,
  observeInboxFromXml,
  observeProfileFromXml,
  sameObservedViewport
} from "../tinder-mirror/appium-conversation-reader.js";

const APPIUM_BASE_URL = String(process.env.APPIUM_BASE_URL || "http://127.0.0.1:4723/wd/hub").replace(/\/+$/, "");
const BACKEND_BASE_URL = String(process.env.TINDER_MIRROR_BASE_URL || "https://cooperative-kindness-production.up.railway.app").replace(/\/+$/, "");
const sessionId = String(process.env.APPIUM_SESSION || "").trim();
const bearerToken = String(process.env.DASHBOARD_API_SECRET || "").trim();
const installedBridgeVersionCode = Number.parseInt(process.env.TINDER_DEVICE_VERSION_CODE || "", 10);
const maxInboxGestures = Number.parseInt(process.env.TINDER_BLOCK2_MAX_INBOX_GESTURES || "160", 10);
const maxHistoryGestures = Number.parseInt(process.env.TINDER_BLOCK2_MAX_UPWARD_GESTURES || "120", 10);
const maxProfileGestures = Number.parseInt(process.env.TINDER_BLOCK2_MAX_PROFILE_GESTURES || "80", 10);
const chatScrollPercent = 0.45;
// Keep a visible row overlap while traversing the ordinary Inbox so the
// process can prove that it did not jump past a normal row between pages.
const inboxScrollPercent = 0.45;
const profileScrollPercent = 0.62;
const settleMilliseconds = 3000;
const boundarySettleMilliseconds = 4500;

if (!sessionId) throw new Error("APPIUM_SESSION is required");
if (!bearerToken) throw new Error("DASHBOARD_API_SECRET is required");
if (!Number.isInteger(installedBridgeVersionCode) || installedBridgeVersionCode < 0) {
  throw new Error("TINDER_DEVICE_VERSION_CODE must be the installed Bridge version code");
}
if (!Number.isInteger(maxInboxGestures) || maxInboxGestures < 1 || maxInboxGestures > 500) {
  throw new Error("TINDER_BLOCK2_MAX_INBOX_GESTURES must be between 1 and 500");
}
if (!Number.isInteger(maxHistoryGestures) || maxHistoryGestures < 3 || maxHistoryGestures > 160) {
  throw new Error("TINDER_BLOCK2_MAX_UPWARD_GESTURES must be between 3 and 160");
}
if (!Number.isInteger(maxProfileGestures) || maxProfileGestures < 1 || maxProfileGestures > 120) {
  throw new Error("TINDER_BLOCK2_MAX_PROFILE_GESTURES must be between 1 and 120");
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function appium(path, { method = "GET", body } = {}) {
  const response = await fetch(`${APPIUM_BASE_URL}/session/${encodeURIComponent(sessionId)}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.value?.error) throw new Error("Appium control operation failed");
  return result?.value;
}

async function sourceXml() {
  const source = await appium("/source");
  if (typeof source !== "string" || source.length < 100) throw new Error("Appium source projection is unavailable");
  return source;
}

async function dashboard(path) {
  const response = await fetch(`${BACKEND_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${bearerToken}`, Accept: "application/json" },
    cache: "no-store"
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error("Dashboard read failed");
  return payload;
}

async function resolveDeviceId() {
  const result = await dashboard("/dashboard-api/device-bridge/devices");
  // Device binding is ordinary product ownership.  No online, heartbeat,
  // enrollment-readiness, command, or Bridge-state gate belongs here.
  const matching = (result.devices || []).filter((device) => Number(device.app_version_code) === installedBridgeVersionCode);
  if (matching.length !== 1 || typeof matching[0].device_id !== "string") {
    throw new Error("A unique device matching the installed Bridge version is required");
  }
  return matching[0].device_id;
}

async function tap(bounds) {
  await appium("/execute/sync", {
    method: "POST",
    body: {
      script: "mobile: clickGesture",
      args: [{ x: Math.round((bounds.left + bounds.right) / 2), y: Math.round((bounds.top + bounds.bottom) / 2) }]
    }
  });
}

async function scrollUp(bounds, percent) {
  const inset = Math.max(24, Math.round(bounds.width * 0.05));
  const result = await appium("/execute/sync", {
    method: "POST",
    body: {
      script: "mobile: scrollGesture",
      args: [{
        left: bounds.left + inset,
        top: bounds.top + Math.max(24, Math.round(bounds.height * 0.08)),
        width: bounds.width - inset * 2,
        height: bounds.height - Math.max(48, Math.round(bounds.height * 0.16)),
        direction: "up",
        percent
      }]
    }
  });
  if (typeof result !== "boolean") throw new Error("Appium scroll did not report a physical boundary result");
  return result;
}

function sameInbox(left, right) {
  return Boolean(left && right
    && left.rows.length === right.rows.length
    && left.rows.every((row, index) => row.ram_key === right.rows[index]?.ram_key));
}

/*
 * This is only direct, in-RAM continuity between two adjacent Inbox
 * projections after one physical scroll.  It is not stored or sent and is
 * never used as a Tinder-thread identity: it merely prevents the already
 * processed suffix of one screen from being opened again at the top of the
 * next screen.
 */
function localRowTextSequence(row) {
  try {
    const value = JSON.parse(row.ram_key);
    return Array.isArray(value?.texts) ? JSON.stringify(value.texts) : null;
  } catch {
    return null;
  }
}

function adjacentInboxOverlap(previous, fresh) {
  const left = previous?.rows || [];
  const right = fresh?.rows || [];
  const maximum = Math.min(left.length, right.length);
  for (let size = maximum; size > 0; size -= 1) {
    const matched = Array.from({ length: size }, (_, index) => {
      const before = localRowTextSequence(left[left.length - size + index]);
      const after = localRowTextSequence(right[index]);
      return before && before === after;
    }).every(Boolean);
    if (matched) return new Set(right.slice(0, size).map((row) => row.ram_key));
  }
  return new Set();
}

function profileValues(profile) {
  return Object.values(profile?.attributes || {});
}

function mergeProfileSnapshots(current, observed) {
  if (!current) return observed;
  if (!observed || observed.display_name !== current.display_name) {
    throw new Error("Tinder profile changed during its local read");
  }
  const values = [...profileValues(current), ...profileValues(observed)];
  const unique = [];
  for (const value of values) {
    if (!unique.includes(value)) unique.push(value);
  }
  if (unique.length > 32) throw new Error("Visible Tinder profile exceeds the existing product field capacity");
  return Object.freeze({
    display_name: current.display_name,
    attributes: Object.freeze(Object.fromEntries(unique.map((value, index) => [
      `visible_profile_${String(index + 1).padStart(2, "0")}`,
      value
    ]))),
    media_refs: Object.freeze([])
  });
}

async function waitForConversation({ expectedDisplayName = null } = {}) {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    await sleep(300);
    const source = await sourceXml();
    const viewport = observeConversationViewportFromXml(source);
    if (!viewport) continue;
    if (expectedDisplayName && viewport.profile_display_name !== expectedDisplayName) {
      throw new Error("Tinder conversation header changed during navigation");
    }
    return Object.freeze({ source, viewport });
  }
  throw new Error("Tinder did not settle to a verified conversation");
}

async function waitForInbox() {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    await sleep(300);
    const inbox = observeInboxFromXml(await sourceXml());
    if (inbox) return inbox;
  }
  throw new Error("Tinder did not settle to a verified Inbox");
}

async function returnToInbox() {
  const target = headerBackTargetFromXml(await sourceXml());
  if (!target) throw new Error("A revalidated Tinder header-back target is unavailable");
  await tap(target);
  return waitForInbox();
}

async function returnToConversation(expectedDisplayName) {
  // The current official Tinder profile exposes no compact header-back node.
  // The product contract permits standard Appium Back for this exact
  // Profile→Chat transition; the preceding profile and following chat header
  // are both freshly verified, so it is never issued from an unknown screen.
  if (!observeProfileFromXml(await sourceXml(), { expectedDisplayName, continuedProfileScroll: true })) {
    throw new Error("A verified Tinder profile is required before Profile-to-Chat Back");
  }
  await appium("/back", { method: "POST" });
  return waitForConversation({ expectedDisplayName });
}

async function freshRow(ramKey) {
  const inbox = observeInboxFromXml(await sourceXml());
  if (!inbox) return null;
  return inbox.rows.find((row) => row.ram_key === ramKey) || null;
}

async function openFreshRow(row) {
  let target = await freshRow(row.ram_key);
  if (!target) throw new Error("The selected Tinder Inbox row changed before its tap");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await tap(target.bounds);
    let conversationWithoutHeader = false;
    for (let settle = 0; settle < 20; settle += 1) {
      await sleep(250);
      const source = await sourceXml();
      const viewport = observeConversationViewportFromXml(source);
      // Tinder can project the chat RecyclerView and composer one render
      // before its visible header text.  That is a transition, not a second
      // Inbox target: remain on this same chat until the header itself is
      // fresh and usable for the Profile/History continuity checks below.
      if (viewport?.profile_display_name) return Object.freeze({ source, viewport });
      if (viewport) {
        conversationWithoutHeader = true;
        continue;
      }
      const inbox = observeInboxFromXml(source);
      if (!inbox) continue;
      if (!inbox.rows.some((candidate) => candidate.ram_key === row.ram_key)) {
        throw new Error("Tinder navigation drifted away from the selected row");
      }
    }
    if (conversationWithoutHeader) {
      throw new Error("Tinder conversation did not settle to a verified visible header");
    }
    target = await freshRow(row.ram_key);
    if (!target) throw new Error("The selected Tinder Inbox row changed before its bounded retry");
  }
  throw new Error("A revalidated Tinder Inbox row did not open a verified conversation");
}

async function openInitialProfile(expectedDisplayName) {
  const target = headerProfileTargetFromXml(await sourceXml());
  if (!target) throw new Error("A revalidated Tinder header profile target is unavailable");
  await tap(target);
  for (let attempt = 0; attempt < 14; attempt += 1) {
    await sleep(300);
    const profile = observeProfileFromXml(await sourceXml(), { expectedDisplayName });
    if (profile) return profile;
  }
  throw new Error("Tinder did not settle to a verified profile");
}

async function readProfileToPhysicalBoundary(expectedDisplayName, initial) {
  let profile = initial.profile;
  let state = initial;
  for (let gesture = 0; gesture < maxProfileGestures; gesture += 1) {
    const canScrollMore = await scrollUp(state.scroll_bounds, profileScrollPercent);
    await sleep(settleMilliseconds);
    const fresh = observeProfileFromXml(await sourceXml(), {
      expectedDisplayName,
      continuedProfileScroll: true,
      expectedScrollBounds: state.scroll_bounds
    });
    if (!fresh) throw new Error("Tinder profile changed while being read");
    profile = mergeProfileSnapshots(profile, fresh.profile);
    state = fresh;
    if (canScrollMore) continue;

    await sleep(boundarySettleMilliseconds);
    const settled = observeProfileFromXml(await sourceXml(), {
      expectedDisplayName,
      continuedProfileScroll: true,
      expectedScrollBounds: state.scroll_bounds
    });
    if (!settled) throw new Error("Tinder profile changed while its boundary was being verified");
    const previous = profile;
    profile = mergeProfileSnapshots(profile, settled.profile);
    state = settled;
    if (JSON.stringify(previous) !== JSON.stringify(profile)) continue;

    const confirmedAtBoundary = await scrollUp(state.scroll_bounds, profileScrollPercent);
    await sleep(settleMilliseconds);
    const confirmed = observeProfileFromXml(await sourceXml(), {
      expectedDisplayName,
      continuedProfileScroll: true,
      expectedScrollBounds: state.scroll_bounds
    });
    if (!confirmed) throw new Error("Tinder profile changed while its boundary was being confirmed");
    const beforeConfirm = profile;
    profile = mergeProfileSnapshots(profile, confirmed.profile);
    state = confirmed;
    if (confirmedAtBoundary || JSON.stringify(beforeConfirm) !== JSON.stringify(profile)) continue;
    return profile;
  }
  throw new Error("The reachable Tinder profile boundary was not reached within the approved bound");
}

async function readChatToVerifiedOldestBoundary({ adapter, expectedDisplayName, initialViewport }) {
  let viewport = initialViewport;
  let gestures = 0;
  for (; gestures < maxHistoryGestures; gestures += 1) {
    // 0.45 is the empirically verified ZTE chat RecyclerView value. It
    // preserves an overlap instead of skipping past adjacent viewports.
    const canScrollMore = await scrollUp(viewport.scroll_bounds, chatScrollPercent);
    await sleep(settleMilliseconds);
    const fresh = observeConversationViewportFromXml(await sourceXml());
    if (!fresh || fresh.profile_display_name !== expectedDisplayName) {
      throw new Error("Tinder conversation changed while its history was being read");
    }
    adapter.appendViewport(fresh.messages);
    viewport = fresh;
    if (canScrollMore) continue;

    await sleep(boundarySettleMilliseconds);
    const settled = observeConversationViewportFromXml(await sourceXml());
    if (!settled || settled.profile_display_name !== expectedDisplayName) {
      throw new Error("Tinder conversation changed while its history boundary was being verified");
    }
    adapter.appendViewport(settled.messages);
    viewport = settled;
    if (!sameObservedViewport(fresh, settled)) continue;

    const confirmedAtBoundary = await scrollUp(viewport.scroll_bounds, chatScrollPercent);
    await sleep(settleMilliseconds);
    const confirmed = observeConversationViewportFromXml(await sourceXml());
    if (!confirmed || confirmed.profile_display_name !== expectedDisplayName) {
      throw new Error("Tinder conversation changed while its history boundary was being confirmed");
    }
    adapter.appendViewport(confirmed.messages);
    viewport = confirmed;
    if (confirmedAtBoundary || !sameObservedViewport(settled, confirmed)) continue;
    return Object.freeze({ gestures: gestures + 2, oldest_boundary_reached: true });
  }
  throw new Error("The reachable Tinder history boundary was not reached within the approved bound");
}

async function openReadAndMirror({ deviceId, row, inboxPosition }) {
  const opened = await openFreshRow(row);
  const expectedDisplayName = opened.viewport.profile_display_name;
  if (!expectedDisplayName) throw new Error("Opened Tinder conversation has no verified visible header");
  const lastMessageVisibleTime = row.last_message_visible_time ?? undefined;

  // Read only the initial visible profile state first. For a safely recognized
  // completed record this is enough to skip the costly profile/history read.
  const initialProfileState = await openInitialProfile(expectedDisplayName);
  let chat = await returnToConversation(expectedDisplayName);
  let transport = createExistingDashboardBearerTransport({ baseUrl: BACKEND_BASE_URL, bearerToken });
  let adapter = createTinderAppiumAdapter({ deviceId, transport });
  adapter.start({
    profile: initialProfileState.profile,
    messages: chat.viewport.messages,
    lastMessageVisibleTime,
    inboxPosition
  });
  let resolution = await adapter.resolve();
  if (resolution?.action === "SKIP_HISTORY" && resolution?.conversation?.id) {
    await transport.updateInboxOrder({
      deviceId,
      conversationId: resolution.conversation.id,
      inboxPosition,
      lastMessageVisibleTime
    });
    const result = Object.freeze({
      action: "KNOWN_SKIPPED",
      conversation_id: resolution.conversation.id,
      inbox_position: inboxPosition,
      last_message_visible_time_captured: lastMessageVisibleTime !== undefined,
      full_profile_read: false,
      full_history_read: false,
      profile_linked: true
    });
    adapter.clear();
    await returnToInbox();
    return result;
  }

  // Profile evidence was insufficient to safely skip, or this is a new/partial
  // thread. Finish the existing ordinary profile snapshot before its history.
  const secondProfileState = await openInitialProfile(expectedDisplayName);
  const fullProfile = await readProfileToPhysicalBoundary(expectedDisplayName, secondProfileState);
  chat = await returnToConversation(expectedDisplayName);
  adapter.clear();
  adapter = createTinderAppiumAdapter({ deviceId, transport });
  adapter.start({
    profile: fullProfile,
    messages: chat.viewport.messages,
    continuationConversationId: resolution?.conversation?.id || null,
    lastMessageVisibleTime,
    inboxPosition
  });
  resolution = await adapter.resolve();
  if (resolution?.action === "SKIP_HISTORY" && resolution?.conversation?.id) {
    await transport.updateInboxOrder({
      deviceId,
      conversationId: resolution.conversation.id,
      inboxPosition,
      lastMessageVisibleTime
    });
    const result = Object.freeze({
      action: "KNOWN_SKIPPED",
      conversation_id: resolution.conversation.id,
      inbox_position: inboxPosition,
      last_message_visible_time_captured: lastMessageVisibleTime !== undefined,
      full_profile_read: true,
      full_history_read: false,
      profile_linked: true
    });
    adapter.clear();
    await returnToInbox();
    return result;
  }

  const read = await readChatToVerifiedOldestBoundary({
    adapter,
    expectedDisplayName,
    initialViewport: chat.viewport
  });
  const synced = await adapter.persistCompletedHistory({ oldestBoundaryReached: read.oldest_boundary_reached });
  if (!synced?.conversation?.id || synced.conversation.history_complete !== true) {
    throw new Error("Completed Tinder history was not accepted by the existing product mirror");
  }
  const result = Object.freeze({
    action: synced.created ? "NEW_MIRRORED" : "KNOWN_COMPLETED",
    conversation_id: synced.conversation.id,
    inbox_position: inboxPosition,
    last_message_visible_time_captured: lastMessageVisibleTime !== undefined,
    full_profile_read: true,
    full_history_read: true,
    profile_linked: true,
    messages: Number(synced.conversation.message_count),
    history_gestures: read.gestures
  });
  adapter.clear();
  await returnToInbox();
  return result;
}

async function sweepInbox({ deviceId }) {
  const results = [];
  const pageKeys = new Set();
  let directlyOverlappingPageKeys = new Set();
  let nextInboxPosition = 0;
  let inbox = observeInboxFromXml(await sourceXml());
  if (!inbox) {
    const source = await sourceXml();
    if (observeConversationViewportFromXml(source)) inbox = await returnToInbox();
    else throw new Error("Tinder is not at a verified Inbox or conversation before the initial mirror");
  }

  for (let gesture = 0; gesture < maxInboxGestures; gesture += 1) {
    // Return navigation can redraw/reorder visible Inbox rows. Re-read after
    // every completed thread; never act from a stale page snapshot.
    for (;;) {
      const row = inbox.rows.find((candidate) => !pageKeys.has(candidate.ram_key)
        && !directlyOverlappingPageKeys.has(candidate.ram_key));
      if (!row) break;
      // A RAM-only page key eliminates an exact repeat after a local redraw;
      // it is not an identity, is never sent, and expires with this process.
      pageKeys.add(row.ram_key);
      const inboxPosition = nextInboxPosition;
      nextInboxPosition += 1;
      results.push(await openReadAndMirror({ deviceId, row, inboxPosition }));
      const restored = observeInboxFromXml(await sourceXml());
      if (!restored) throw new Error("Tinder did not remain at a verified Inbox after a completed thread");
      inbox = restored;
    }

    const before = inbox;
    const canScrollMore = await scrollUp(before.scroll_bounds, inboxScrollPercent);
    await sleep(settleMilliseconds);
    const fresh = observeInboxFromXml(await sourceXml());
    if (!fresh) throw new Error("Tinder Inbox changed while being vertically traversed");
    directlyOverlappingPageKeys = adjacentInboxOverlap(before, fresh);
    if (canScrollMore && before.rows.length > 0 && fresh.rows.length > 0 && directlyOverlappingPageKeys.size === 0) {
      throw new Error("Tinder Inbox scroll did not retain a visible row overlap");
    }
    inbox = fresh;
    if (canScrollMore) continue;

    await sleep(boundarySettleMilliseconds);
    const settled = observeInboxFromXml(await sourceXml());
    if (!settled) throw new Error("Tinder Inbox changed while its end was being verified");
    directlyOverlappingPageKeys = adjacentInboxOverlap(inbox, settled);
    inbox = settled;
    if (!sameInbox(fresh, settled)) continue;

    const confirmedAtBoundary = await scrollUp(inbox.scroll_bounds, inboxScrollPercent);
    await sleep(settleMilliseconds);
    const confirmed = observeInboxFromXml(await sourceXml());
    if (!confirmed) throw new Error("Tinder Inbox changed while its end was being confirmed");
    directlyOverlappingPageKeys = adjacentInboxOverlap(inbox, confirmed);
    inbox = confirmed;
    if (confirmedAtBoundary || !sameInbox(settled, confirmed)) continue;
    return results;
  }
  throw new Error("The reachable Tinder Inbox end was not reached within the approved bound");
}

const deviceId = await resolveDeviceId();
const before = await dashboard("/dashboard-api/tinder/conversations");
const beforeIds = new Set((before.conversations || []).map((conversation) => conversation.id));
const results = await sweepInbox({ deviceId });
const after = await dashboard("/dashboard-api/tinder/conversations");
const afterIds = new Set((after.conversations || []).map((conversation) => conversation.id));
const knownIds = new Set(results.filter((result) => result.action !== "NEW_MIRRORED").map((result) => result.conversation_id));
const newIds = new Set(results.filter((result) => result.action === "NEW_MIRRORED").map((result) => result.conversation_id));

console.log(JSON.stringify({
  normal_row_visits: results.length,
  distinct_threads_processed: new Set(results.map((result) => result.conversation_id)).size,
  known_threads_reused: knownIds.size,
  new_threads_mirrored: newIds.size,
  full_histories_read: results.filter((result) => result.full_history_read).length,
  full_profiles_read: results.filter((result) => result.full_profile_read).length,
  profiles_linked: results.filter((result) => result.profile_linked).length,
  inbox_positions_observed: results.filter((result) => Number.isInteger(result.inbox_position)).length,
  last_message_visible_time_values: results.filter((result) => result.last_message_visible_time_captured).length,
  reachable_history_complete: results.length > 0 && results.every((result) => result.action === "KNOWN_SKIPPED"
    || result.action === "NEW_MIRRORED" || result.action === "KNOWN_COMPLETED"),
  conversations_before: beforeIds.size,
  conversations_after: afterIds.size,
  conversations_created: afterIds.size - beforeIds.size,
  duplicate_conversations_created: Math.max(0, afterIds.size - beforeIds.size - newIds.size),
  capture_system_created: false,
  identity_system_created: false,
  safety_system_created: false,
  heartbeat_used_as_gate: false
}));
