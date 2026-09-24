/*
 * One controlled corrective re-read of already mirrored Block-2 chats.
 *
 * Appium/UiAutomator2 observes and navigates the official Tinder UI locally.
 * Only ordinary profile/message product data crosses the existing dashboard
 * bearer transport.  No screenshots, trees, node IDs, coordinates or local
 * run keys are persisted or sent.  This script deliberately does not create
 * a new thread: it requires a pre-existing, uniquely resolved conversation
 * before it can sync a completed history.
 */

import { createTinderAppiumAdapter, createExistingDashboardBearerTransport } from "../tinder-mirror/appium-adapter.js";
import {
  headerBackTargetFromXml,
  observeConversationViewportFromXml,
  observeInboxConversationRowsFromXml,
  sameObservedViewport
} from "../tinder-mirror/appium-conversation-reader.js";

const APPIUM_BASE_URL = String(process.env.APPIUM_BASE_URL || "http://127.0.0.1:4723/wd/hub").replace(/\/+$/, "");
const BACKEND_BASE_URL = String(process.env.TINDER_MIRROR_BASE_URL || "https://cooperative-kindness-production.up.railway.app").replace(/\/+$/, "");
const sessionId = String(process.env.APPIUM_SESSION || "").trim();
const bearerToken = String(process.env.DASHBOARD_API_SECRET || "").trim();
const limit = Number.parseInt(process.env.TINDER_BLOCK2_CORRECTION_LIMIT || "3", 10);
const maxUpwardGestures = Number.parseInt(process.env.TINDER_BLOCK2_MAX_UPWARD_GESTURES || "80", 10);
const installedBridgeVersionCode = Number.parseInt(process.env.TINDER_DEVICE_VERSION_CODE || "", 10);

if (!sessionId) throw new Error("APPIUM_SESSION is required");
if (!bearerToken) throw new Error("DASHBOARD_API_SECRET is required");
if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new Error("TINDER_BLOCK2_CORRECTION_LIMIT must be between 1 and 3");
if (!Number.isInteger(maxUpwardGestures) || maxUpwardGestures < 3 || maxUpwardGestures > 120) {
  throw new Error("TINDER_BLOCK2_MAX_UPWARD_GESTURES must be between 3 and 120");
}
if (!Number.isInteger(installedBridgeVersionCode) || installedBridgeVersionCode < 0) {
  throw new Error("TINDER_DEVICE_VERSION_CODE must be the installed Bridge version code");
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
  // This is ordinary device binding only.  In particular, read work does not
  // depend on enrollment, heartbeat, device online state, or Bridge service state.
  const bound = (result.devices || []).filter((device) => Number(device.app_version_code) === installedBridgeVersionCode);
  if (bound.length !== 1 || typeof bound[0].device_id !== "string") {
    throw new Error("A unique device matching the installed Bridge version is required");
  }
  return bound[0].device_id;
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

async function scrollUp(bounds) {
  const inset = Math.max(24, Math.round(bounds.width * 0.05));
  await appium("/execute/sync", {
    method: "POST",
    body: {
      script: "mobile: swipeGesture",
      args: [{
        left: bounds.left + inset,
        top: bounds.top + Math.max(24, Math.round(bounds.height * 0.08)),
        width: bounds.width - inset * 2,
        height: bounds.height - Math.max(48, Math.round(bounds.height * 0.16)),
        direction: "up",
        percent: 0.42
      }]
    }
  });
}

function onlyExistingConversation(list, displayName) {
  const matches = list.filter((conversation) => conversation?.profile?.display_name === displayName);
  return matches.length === 1 ? matches[0] : null;
}

async function readToVerifiedOldestBoundary({ deviceId, existing, source }) {
  let viewport = observeConversationViewportFromXml(source);
  if (!viewport?.profile_display_name || viewport.messages.length < 1 || !viewport.scroll_bounds) {
    throw new Error("Current Tinder conversation projection is not sufficient for a corrective read");
  }
  if (viewport.profile_display_name !== existing.profile.display_name) {
    throw new Error("Current Tinder header does not match the selected existing conversation");
  }

  const transport = createExistingDashboardBearerTransport({
    baseUrl: BACKEND_BASE_URL,
    bearerToken
  });
  const adapter = createTinderAppiumAdapter({ deviceId, transport });
  adapter.start({ profile: existing.profile, messages: viewport.messages });
  const resolved = await adapter.resolve();
  if (resolved?.conversation?.id !== existing.id) {
    throw new Error("Existing Tinder conversation could not be revalidated before correction");
  }

  let assembled = viewport.messages;
  let unchangedViewportStreak = 0;
  let gestures = 0;
  for (; gestures < maxUpwardGestures; gestures += 1) {
    await scrollUp(viewport.scroll_bounds);
    await sleep(700);
    const fresh = observeConversationViewportFromXml(await sourceXml());
    if (!fresh?.profile_display_name || fresh.profile_display_name !== viewport.profile_display_name
      || fresh.messages.length < 1 || !fresh.scroll_bounds) {
      throw new Error("Conversation changed while its history was being read");
    }

    unchangedViewportStreak = sameObservedViewport(viewport, fresh)
      ? unchangedViewportStreak + 1
      : 0;
    assembled = adapter.appendViewport(fresh.messages);
    viewport = fresh;

    // One duplicate/no-new viewport is not terminal.  Three independently
    // fresh post-gesture observations establish the physical upper boundary.
    if (unchangedViewportStreak >= 3) {
      const synced = await adapter.persistCompletedHistory({ oldestBoundaryReached: true });
      if (synced?.created || synced?.conversation?.id !== existing.id
        || synced?.conversation?.history_complete !== true
        || Number(synced?.conversation?.message_count) !== assembled.length) {
        throw new Error("Corrective Tinder history persistence was not identity-preserving");
      }
      return Object.freeze({
        conversation_id: existing.id,
        messages: assembled.length,
        inbound_samples: assembled.filter((message) => message.direction === "INBOUND").length,
        outbound_samples: assembled.filter((message) => message.direction === "OUTBOUND").length,
        gestures: gestures + 1,
        oldest_boundary_reached: true
      });
    }
  }
  throw new Error("The real oldest Tinder history boundary was not reached within the approved bound");
}

async function returnToInbox() {
  const target = headerBackTargetFromXml(await sourceXml());
  if (!target) throw new Error("A revalidated Tinder header-back target is unavailable");
  await tap(target);
  await sleep(700);
  const rows = observeInboxConversationRowsFromXml(await sourceXml());
  if (!rows.length) throw new Error("Header-back did not return to a verified Tinder Inbox");
  return rows;
}

async function freshInboxRow(ramKey) {
  const rows = observeInboxConversationRowsFromXml(await sourceXml());
  return rows.find((row) => row.ram_key === ramKey) || null;
}

async function waitForOpenedConversation(ramKey) {
  let verifiedSameInbox = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(250);
    const source = await sourceXml();
    if (observeConversationViewportFromXml(source)) return source;

    const row = observeInboxConversationRowsFromXml(source).find((candidate) => candidate.ram_key === ramKey);
    if (row) {
      verifiedSameInbox = true;
      continue;
    }

    // A loading transition has neither a complete Inbox nor a complete chat
    // projection.  It receives the remaining bounded settling interval, but
    // never authorizes another target or an unverified retry.
  }
  return verifiedSameInbox ? null : undefined;
}

async function openNextConversation(processedRows) {
  const rows = observeInboxConversationRowsFromXml(await sourceXml());
  const next = rows.find((row) => !processedRows.has(row.ram_key));
  if (!next) return null;

  // Revalidate the exact candidate immediately before action.  The second
  // bounded attempt is permitted only when that same fresh Inbox row remains.
  let target = await freshInboxRow(next.ram_key);
  if (!target) throw new Error("The selected Tinder Inbox row changed before its tap");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await tap(target.bounds);
    const source = await waitForOpenedConversation(next.ram_key);
    if (source) {
      processedRows.add(next.ram_key);
      return source;
    }
    if (source === undefined) {
      throw new Error("Tinder navigation did not settle to a verified Inbox or conversation");
    }
    target = await freshInboxRow(next.ram_key);
    if (!target) throw new Error("The selected Tinder Inbox row changed before its bounded retry");
  }
  throw new Error("A revalidated Tinder Inbox row did not open a verified Tinder conversation");
}

const deviceId = await resolveDeviceId();
const before = await dashboard("/dashboard-api/tinder/conversations");
const beforeConversations = before.conversations || [];
const beforeIds = new Set(beforeConversations.map((conversation) => conversation.id));
const beforeProfiles = new Map(beforeConversations.map((conversation) => [conversation.id, JSON.stringify(conversation.profile)]));
const processedRows = new Set();
const results = [];
let source = await sourceXml();

while (results.length < limit) {
  let viewport = observeConversationViewportFromXml(source);
  if (!viewport) {
    source = await openNextConversation(processedRows);
    if (!source) break;
    viewport = observeConversationViewportFromXml(source);
  }
  const existing = onlyExistingConversation(beforeConversations, viewport.profile_display_name);
  if (!existing) {
    throw new Error("No unique already mirrored conversation is available for this corrective re-read");
  }
  const corrected = await readToVerifiedOldestBoundary({ deviceId, existing, source });
  results.push(corrected);
  source = await sourceXml();
  await returnToInbox();
  source = await sourceXml();
}

const after = await dashboard("/dashboard-api/tinder/conversations");
const afterConversations = after.conversations || [];
const afterIds = new Set(afterConversations.map((conversation) => conversation.id));
const sameIds = beforeIds.size === afterIds.size && [...beforeIds].every((id) => afterIds.has(id));
const profilesPreserved = sameIds && afterConversations.every((conversation) => beforeProfiles.get(conversation.id) === JSON.stringify(conversation.profile));

console.log(JSON.stringify({
  threads_corrected: results.length,
  conversations_created: afterConversations.length - beforeConversations.length,
  messages_mirrored: results.reduce((total, result) => total + result.messages, 0),
  inbound_samples: results.reduce((total, result) => total + result.inbound_samples, 0),
  outbound_samples: results.reduce((total, result) => total + result.outbound_samples, 0),
  multi_viewport_history: results.every((result) => result.gestures > 3),
  reachable_history_complete: results.every((result) => result.oldest_boundary_reached),
  existing_conversation_ids_preserved: sameIds,
  profiles_preserved: profilesPreserved,
  duplicate_conversations_created: afterConversations.length - beforeConversations.length
}));
