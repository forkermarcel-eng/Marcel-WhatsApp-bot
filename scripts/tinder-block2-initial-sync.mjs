/*
 * Block 2's normal initial product mirror.
 *
 * Appium/UiAutomator2 controls only the official Tinder UI locally.  This
 * runner keeps transient page/row continuity in RAM and sends only the
 * ordinary completed profile and message product snapshot through the
 * existing dashboard bearer transport.  It creates no capture, identity,
 * permit, receipt, safety, heartbeat, or approval state.
 */

import { pathToFileURL } from "node:url";
import {
  createTinderAppiumAdapter,
  createTinderAppiumDeltaAdapter,
  createExistingDashboardBearerTransport
} from "../tinder-mirror/appium-adapter.js";
import {
  headerBackTargetFromXml,
  headerProfileTargetFromXml,
  observeConversationViewportFromXml,
  observeInboxFromXml,
  observeProfileFromXml,
  mergeProfileSnapshots,
  sameObservedViewport
} from "../tinder-mirror/appium-conversation-reader.js";

const DEFAULT_APPIUM_BASE_URL = "http://127.0.0.1:4723/wd/hub";
const DEFAULT_BACKEND_BASE_URL = "https://cooperative-kindness-production.up.railway.app";
let APPIUM_BASE_URL;
let BACKEND_BASE_URL;
let sessionId;
let bearerToken;
let installedBridgeVersionCode;
let maxInboxGestures;
let maxHistoryGestures;
let maxProfileGestures;
const chatScrollPercent = 0.45;
// Keep a visible row overlap while traversing the ordinary Inbox so the
// process can prove that it did not jump past a normal row between pages.
// The Inbox RecyclerView has a much shorter effective row stride than the
// chat RecyclerView.  On the real ZTE, 0.05 produces a physical Inbox move
// while retaining the complete immediately-adjacent visible row sequence;
// 0.10 and above jump past it.  Keep chat history at its separately verified
// 0.45 value.
const inboxScrollPercent = 0.05;
const profileScrollPercent = 0.62;
const settleMilliseconds = 3000;
const boundarySettleMilliseconds = 4500;

function runtimeText(value) {
  return String(value || "").trim();
}

function boundedRuntimeInteger(value, { name, fallback, minimum, maximum }) {
  const parsed = Number.parseInt(runtimeText(value) || fallback, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function configureRuntime(environment = process.env) {
  const configuredSessionId = runtimeText(environment.APPIUM_SESSION);
  const configuredBearerToken = runtimeText(environment.DASHBOARD_API_SECRET);
  const configuredBridgeVersionCode = Number.parseInt(runtimeText(environment.TINDER_DEVICE_VERSION_CODE), 10);
  if (!configuredSessionId) throw new Error("APPIUM_SESSION is required");
  if (!configuredBearerToken) throw new Error("DASHBOARD_API_SECRET is required");
  if (!Number.isInteger(configuredBridgeVersionCode) || configuredBridgeVersionCode < 0) {
    throw new Error("TINDER_DEVICE_VERSION_CODE must be the installed Bridge version code");
  }

  APPIUM_BASE_URL = runtimeText(environment.APPIUM_BASE_URL || DEFAULT_APPIUM_BASE_URL).replace(/\/+$/, "");
  BACKEND_BASE_URL = runtimeText(environment.TINDER_MIRROR_BASE_URL || DEFAULT_BACKEND_BASE_URL).replace(/\/+$/, "");
  sessionId = configuredSessionId;
  bearerToken = configuredBearerToken;
  installedBridgeVersionCode = configuredBridgeVersionCode;
  maxInboxGestures = boundedRuntimeInteger(environment.TINDER_BLOCK2_MAX_INBOX_GESTURES, {
    name: "TINDER_BLOCK2_MAX_INBOX_GESTURES",
    fallback: "160",
    minimum: 1,
    maximum: 500
  });
  maxHistoryGestures = boundedRuntimeInteger(environment.TINDER_BLOCK2_MAX_UPWARD_GESTURES, {
    name: "TINDER_BLOCK2_MAX_UPWARD_GESTURES",
    fallback: "120",
    minimum: 3,
    maximum: 160
  });
  maxProfileGestures = boundedRuntimeInteger(environment.TINDER_BLOCK2_MAX_PROFILE_GESTURES, {
    name: "TINDER_BLOCK2_MAX_PROFILE_GESTURES",
    fallback: "80",
    minimum: 1,
    maximum: 120
  });
  return Object.freeze({
    appiumBaseUrl: APPIUM_BASE_URL,
    backendBaseUrl: BACKEND_BASE_URL,
    sessionId,
    bearerToken,
    installedBridgeVersionCode,
    maxInboxGestures,
    maxHistoryGestures,
    maxProfileGestures
  });
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

async function scroll(bounds, direction, percent) {
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
        direction,
        percent
      }]
    }
  });
  if (typeof result !== "boolean") throw new Error("Appium scroll did not report a physical boundary result");
  return result;
}

// UiAutomator2's scrollGesture direction names describe the visual viewport
// direction: `up` reaches the visible top, `down` advances toward lower
// Inbox/profile content. The verified chat reader intentionally moves toward
// the visual top to load older history.
const scrollTowardTop = (bounds, percent) => scroll(bounds, "up", percent);
const scrollTowardBottom = (bounds, percent) => scroll(bounds, "down", percent);

function sameInbox(left, right) {
  return Boolean(left && right
    && left.rows.length === right.rows.length
    && left.rows.every((row, index) => row.ram_key === right.rows[index]?.ram_key));
}

function inboxViewportKey(inbox) {
  return JSON.stringify((inbox?.rows || []).map((row) => row.ram_key));
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

// The container slot is intentionally even narrower than the transient text
// sequence above.  It is used only when Tinder returns from a just-read chat
// to the *same rendered Inbox page*: a status/preview redraw can change the
// tappable child bounds, while the row container remains in the same physical
// slot.  This value never leaves this process and is not a thread identity.
function localRowContainerSlot(row) {
  try {
    const value = JSON.parse(row.ram_key);
    if (!Number.isInteger(value?.top) || !Number.isInteger(value?.bottom)) return null;
    return `${value.top}:${value.bottom}`;
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

function sameInboxScrollSurface(left, right) {
  const a = left?.scroll_bounds;
  const b = right?.scroll_bounds;
  return Boolean(a && b
    && a.left === b.left && a.top === b.top
    && a.right === b.right && a.bottom === b.bottom);
}

function sameInboxRowSlots(left, right) {
  const leftRows = left?.rows || [];
  const rightRows = right?.rows || [];
  return sameInboxScrollSurface(left, right)
    && leftRows.length === rightRows.length
    && leftRows.every((row, index) => {
      const before = localRowContainerSlot(row);
      const after = localRowContainerSlot(rightRows[index]);
      return before !== null && before === after;
    });
}

function nextInboxOverlap(previous, fresh, { continuousMotionVerified }) {
  if (!sameInboxScrollSurface(previous, fresh)) {
    throw new Error("Tinder Inbox scroll surface changed during its verified traversal");
  }
  const overlap = adjacentInboxOverlap(previous, fresh);
  // Tinder virtualizes a later Inbox page without retaining a text-bearing
  // row in the XML, even after several small, proven movements on this same
  // RecyclerView. That is a projection boundary, not an unverified target.
  // A first zero-overlap move remains fail-closed; after direct local
  // continuity has already been observed, process the newly visible page.
  if (overlap.size === 0 && !continuousMotionVerified) {
    throw new Error("Tinder Inbox scroll did not establish direct local continuity");
  }
  return overlap;
}

/*
 * This carries only the indices already handled in the immediately preceding
 * visible Inbox page into the immediately following projection.  It is kept
 * in RAM for this one traversal, is discarded at exit, and is deliberately
 * not a Tinder-thread key: a zero-overlap virtualized page starts clean.
 */
function carryProcessedInboxRows(previous, fresh, processedPreviousRows) {
  const left = previous?.rows || [];
  const right = fresh?.rows || [];
  const processed = processedPreviousRows instanceof Set ? processedPreviousRows : new Set();
  const maximum = Math.min(left.length, right.length);
  for (let size = maximum; size > 0; size -= 1) {
    const matched = Array.from({ length: size }, (_, index) => {
      const before = localRowTextSequence(left[left.length - size + index]);
      const after = localRowTextSequence(right[index]);
      return before && before === after;
    }).every(Boolean);
    if (!matched) continue;
    const carried = new Set();
    for (let index = 0; index < size; index += 1) {
      if (processed.has(left.length - size + index)) carried.add(index);
    }
    return carried;
  }
  return new Set();
}

/*
 * Reconcile completion marks only across the immediately adjacent Inbox
 * projections of this one process.  A redraw of the same physical page keeps
 * its completed slots even if Tinder changed a preview/status child.  A
 * later virtualized page starts with no carried marks.  For a redraw directly
 * after completing a chat, losing all direct continuity would otherwise
 * permit a same-sweep reopen, so stop rather than tapping an uncertain row.
 */
function reconcileProcessedInboxRows(previous, fresh, processedPreviousRows, {
  requireDirectContinuity = false
} = {}) {
  const processed = processedPreviousRows instanceof Set ? processedPreviousRows : new Set();
  if (sameInboxRowSlots(previous, fresh)) return new Set(processed);
  const carried = carryProcessedInboxRows(previous, fresh, processed);
  if (requireDirectContinuity && processed.size > 0 && carried.size === 0) {
    throw new Error("Tinder Inbox lost direct RAM-only continuity after a completed thread");
  }
  return carried;
}

/*
 * An Inbox inventory entry is deliberately not a Tinder identity.  It is the
 * exact, transient visible row sequence from this one uninterrupted initial
 * import.  It is kept only in RAM long enough to make Phase 2 consume the
 * rows discovered by Phase 1 in the same observed order.  Nothing from this
 * structure crosses the dashboard transport or survives the process.
 */
function sameTransientInboxRow(left, right) {
  const leftSequence = localRowTextSequence(left);
  const rightSequence = localRowTextSequence(right);
  return Boolean(leftSequence && rightSequence && leftSequence === rightSequence);
}

function inventoryEntryFromRow(row, inboxPosition) {
  return Object.freeze({
    inbox_position: inboxPosition,
    last_message_visible_time: row.last_message_visible_time ?? undefined,
    observed_row: Object.freeze({
      bounds: Object.freeze({ ...row.bounds }),
      ram_key: row.ram_key,
      last_message_visible_time: row.last_message_visible_time ?? undefined
    })
  });
}

/*
 * A no-open decision is intentionally available only from a capability that
 * was minted in this Node process after a verified read.  It cannot be
 * reconstructed from product data, a profile name, a visible time label, or a
 * serialized value after restart.  The binding contains the transient row
 * projection only so the immediately continuous sweep can avoid opening the
 * same already-completed row again; it is not a Tinder identity.
 */
const ramOnlyInitialSweepBindingRegistry = new WeakSet();

export function createRamOnlyInitialSweepBinding({ observedRow, conversationId } = {}) {
  const rowRamKey = typeof observedRow?.ram_key === "string" && observedRow.ram_key
    ? observedRow.ram_key
    : null;
  const id = typeof conversationId === "string" && conversationId ? conversationId : null;
  if (!rowRamKey || !id) {
    throw new Error("A verified in-process row projection and conversation ID are required for a RAM-only binding");
  }
  const binding = Object.freeze({
    observed_row_ram_key: rowRamKey,
    conversation_id: id
  });
  ramOnlyInitialSweepBindingRegistry.add(binding);
  return binding;
}

function ramOnlyInitialSweepBindingMap(ramBindings) {
  const supplied = ramBindings instanceof Map
    ? [...ramBindings.values()]
    : Array.isArray(ramBindings) ? ramBindings : [];
  const byRowRamKey = new Map();
  for (const binding of supplied) {
    if (!ramOnlyInitialSweepBindingRegistry.has(binding)) {
      throw new Error("A known unchanged Inbox row requires an in-process RAM-only binding");
    }
    const existing = byRowRamKey.get(binding.observed_row_ram_key);
    if (existing && existing.conversation_id !== binding.conversation_id) {
      throw new Error("A RAM-only Inbox row projection cannot bind to multiple conversations");
    }
    byRowRamKey.set(binding.observed_row_ram_key, binding);
  }
  return byRowRamKey;
}

/*
 * This is a deliberately narrow local plan produced after the whole Inbox is
 * observed and before Phase 2 can tap a row.  Persisted Tinder data never
 * decides that a row is unchanged: names and visible time labels can recur.
 * Only an explicit binding made by an earlier verified path in this same
 * process may take the order-only path.  Every unbound or repeated row stays
 * INITIAL_READ_REQUIRED rather than being guessed.
 */
export function planInitialInboxProcessing({ inventory, ramBindings } = {}) {
  const entries = Array.isArray(inventory) ? inventory : [];
  const bindingsByRowRamKey = ramOnlyInitialSweepBindingMap(ramBindings);
  const seenOrdinals = new Set();
  const tentative = entries.map((entry) => {
    const inboxPosition = entry?.inbox_position;
    if (!Number.isInteger(inboxPosition) || inboxPosition < 0 || seenOrdinals.has(inboxPosition)) {
      throw new Error("A valid unique RAM-only Inbox inventory ordinal is required");
    }
    seenOrdinals.add(inboxPosition);
    const binding = bindingsByRowRamKey.get(entry?.observed_row?.ram_key) || null;
    return { inbox_position: inboxPosition, binding };
  });

  // A binding may never explain two distinct current rows.  An exact row
  // projection repeated in the inventory is ambiguous at planning time and
  // must not become a persisted-name/time shortcut.
  const bindingRowCounts = new Map();
  for (const entry of tentative) {
    if (entry.binding) {
      bindingRowCounts.set(
        entry.binding.conversation_id,
        (bindingRowCounts.get(entry.binding.conversation_id) || 0) + 1
      );
    }
  }
  return Object.freeze(tentative.map((entry) => Object.freeze(
    entry.binding && bindingRowCounts.get(entry.binding.conversation_id) === 1
      ? {
          inbox_position: entry.inbox_position,
          action: "KNOWN_UNCHANGED",
          conversation_id: entry.binding.conversation_id,
          observed_row_ram_key: entry.binding.observed_row_ram_key
        }
      : {
          inbox_position: entry.inbox_position,
          action: "INITIAL_READ_REQUIRED",
          conversation_id: null,
          observed_row_ram_key: null
        }
  )));
}

function planByInboxPosition(inventory, initialProcessingPlan) {
  const entries = Array.isArray(inventory) ? inventory : [];
  const plan = Array.isArray(initialProcessingPlan) ? initialProcessingPlan : [];
  if (plan.length !== entries.length) {
    throw new Error("The RAM-only Inbox processing plan does not cover the completed inventory");
  }
  const byPosition = new Map();
  for (const planned of plan) {
    if (!Number.isInteger(planned?.inbox_position) || byPosition.has(planned.inbox_position)) {
      throw new Error("The RAM-only Inbox processing plan has an invalid ordinal");
    }
    if (planned.action !== "KNOWN_UNCHANGED" && planned.action !== "INITIAL_READ_REQUIRED") {
      throw new Error("The RAM-only Inbox processing plan has an invalid action");
    }
    if (planned.action === "KNOWN_UNCHANGED"
      && (typeof planned.conversation_id !== "string" || typeof planned.observed_row_ram_key !== "string")) {
      throw new Error("A known unchanged Inbox plan entry requires its in-process row binding");
    }
    byPosition.set(planned.inbox_position, planned);
  }
  for (const entry of entries) {
    if (!byPosition.has(entry?.inbox_position)) {
      throw new Error("The RAM-only Inbox processing plan omitted an inventory entry");
    }
  }
  return byPosition;
}

/*
 * Keep the no-open decision separately testable. The live processing loop
 * supplies the fresh row and either uses the ordinary completed-history path
 * or performs the existing order-only update for a uniquely known row.
 */
export async function executeInitialInboxPlanEntry({
  plan,
  deviceId,
  row,
  inboxPosition,
  processedConversationIds,
  ramBindings = [],
  openAndMirror = openReadAndMirror,
  mirrorKnownUnchanged = mirrorKnownUnchangedInboxRow
} = {}) {
  if (!plan || plan.inbox_position !== inboxPosition) {
    throw new Error("The current Inbox row has no matching RAM-only processing plan");
  }
  if (!(processedConversationIds instanceof Set)) {
    throw new Error("A RAM-only processed conversation set is required");
  }
  const bindingsByRowRamKey = ramOnlyInitialSweepBindingMap(ramBindings);
  const directBinding = bindingsByRowRamKey.get(row?.ram_key) || null;
  if (directBinding && processedConversationIds.has(directBinding.conversation_id)) {
    // This is an exact local continuity seen after a thread completed in this
    // process.  Never reopen it merely because the same transient row has
    // appeared again; it also does not claim anything about an unbound row.
    return Object.freeze({
      action: "SAME_SWEEP_CONTINUITY_SKIPPED",
      conversation_id: directBinding.conversation_id,
      inbox_position: null,
      inbox_position_persisted: false,
      first_observed_in_sweep: false,
      last_message_visible_time_captured: false,
      thread_opened: false,
      initial_profile_reads: 0,
      full_profile_read: false,
      full_history_read: false,
      profile_linked: true,
      same_sweep_reopen: false
    });
  }
  if (plan.action === "KNOWN_UNCHANGED") {
    if (!directBinding
      || directBinding.conversation_id !== plan.conversation_id
      || directBinding.observed_row_ram_key !== plan.observed_row_ram_key) {
      throw new Error("A known unchanged Inbox plan lost its in-process RAM-only binding");
    }
    return mirrorKnownUnchanged({
      deviceId,
      row,
      inboxPosition,
      conversationId: plan.conversation_id,
      processedConversationIds
    });
  }
  if (plan.action === "INITIAL_READ_REQUIRED") {
    return openAndMirror({ deviceId, row, inboxPosition, processedConversationIds });
  }
  throw new Error("The current Inbox row has an invalid RAM-only processing action");
}

/*
 * A zero is meaningful only if every completed entry could establish whether
 * it reopened a thread already completed in this process.  In particular, an
 * intentionally untouched ambiguous singleton has no conversation ID and is
 * reported as unverified instead of being silently counted as zero.
 */
export function summarizeSameSweepReopens(results) {
  const entries = Array.isArray(results) ? results : [];
  let reopens = 0;
  for (const result of entries) {
    if (result?.same_sweep_reopen === true) {
      reopens += 1;
      continue;
    }
    if (result?.same_sweep_reopen === false) continue;
    return Object.freeze({ same_sweep_reopens: null, same_sweep_reopens_verified: false });
  }
  return Object.freeze({ same_sweep_reopens: reopens, same_sweep_reopens_verified: true });
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

async function stableInboxProjection(initialInbox) {
  let current = initialInbox;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(350);
    const fresh = observeInboxFromXml(await sourceXml());
    if (!fresh) throw new Error("Tinder Inbox changed while its row target was settling");
    if (sameInbox(current, fresh)) return fresh;
    current = fresh;
  }
  throw new Error("Tinder Inbox did not reach a stable projection before a row tap");
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

async function profileProjection(expectedDisplayName, options) {
  const source = await sourceXml();
  const observation = observeProfileFromXml(source, { expectedDisplayName, ...options });
  return observation ? Object.freeze({ observation, source }) : null;
}

async function readProfileToPhysicalBoundary(expectedDisplayName, initial) {
  let profile = initial.profile;
  let current = await profileProjection(expectedDisplayName, {
    continuedProfileScroll: true,
    expectedScrollBounds: initial.scroll_bounds
  });
  if (!current) throw new Error("Tinder profile changed before its scrollable surface was verified");
  let state = current.observation;
  profile = mergeProfileSnapshots(profile, state.profile);
  let consecutiveNoProgress = 0;
  for (let gesture = 0; gesture < maxProfileGestures; gesture += 1) {
    const beforeSource = current.source;
    const canScrollMore = await scrollTowardBottom(state.scroll_bounds, profileScrollPercent);
    await sleep(settleMilliseconds);
    const freshProjection = await profileProjection(expectedDisplayName, {
      expectedDisplayName,
      continuedProfileScroll: true,
      expectedScrollBounds: state.scroll_bounds
    });
    if (!freshProjection) throw new Error("Tinder profile changed while being read");
    const fresh = freshProjection.observation;
    profile = mergeProfileSnapshots(profile, fresh.profile);
    state = fresh;
    current = freshProjection;
    if (beforeSource !== freshProjection.source) {
      consecutiveNoProgress = 0;
      continue;
    }
    if (canScrollMore) {
      consecutiveNoProgress += 1;
      if (consecutiveNoProgress < 3) continue;
      throw new Error("The verified Tinder profile surface made no real upward progress");
    }

    await sleep(boundarySettleMilliseconds);
    const settledProjection = await profileProjection(expectedDisplayName, {
      expectedDisplayName,
      continuedProfileScroll: true,
      expectedScrollBounds: state.scroll_bounds
    });
    if (!settledProjection) throw new Error("Tinder profile changed while its boundary was being verified");
    const settled = settledProjection.observation;
    profile = mergeProfileSnapshots(profile, settled.profile);
    state = settled;
    current = settledProjection;
    if (freshProjection.source !== settledProjection.source) {
      consecutiveNoProgress = 0;
      continue;
    }

    const confirmedAtBoundary = await scrollTowardBottom(state.scroll_bounds, profileScrollPercent);
    await sleep(settleMilliseconds);
    const confirmedProjection = await profileProjection(expectedDisplayName, {
      expectedDisplayName,
      continuedProfileScroll: true,
      expectedScrollBounds: state.scroll_bounds
    });
    if (!confirmedProjection) throw new Error("Tinder profile changed while its boundary was being confirmed");
    const confirmed = confirmedProjection.observation;
    profile = mergeProfileSnapshots(profile, confirmed.profile);
    state = confirmed;
    current = confirmedProjection;
    if (settledProjection.source !== confirmedProjection.source) {
      consecutiveNoProgress = 0;
      continue;
    }
    if (confirmedAtBoundary) {
      consecutiveNoProgress += 1;
      if (consecutiveNoProgress < 3) continue;
      throw new Error("The verified Tinder profile surface reported movement without a changed viewport");
    }
    return profile;
  }
  throw new Error("The reachable Tinder profile boundary was not reached within the approved bound");
}

async function readChatToVerifiedOldestBoundary({ adapter, expectedDisplayName, initialViewport }) {
  let viewport = initialViewport;
  let gestures = 0;
  let consecutiveNoProgress = 0;
  for (; gestures < maxHistoryGestures; gestures += 1) {
    // 0.45 is the empirically verified ZTE chat RecyclerView value. It
    // preserves an overlap instead of skipping past adjacent viewports.
    const before = viewport;
    const canScrollMore = await scrollTowardTop(before.scroll_bounds, chatScrollPercent);
    await sleep(settleMilliseconds);
    const fresh = observeConversationViewportFromXml(await sourceXml());
    if (!fresh || fresh.profile_display_name !== expectedDisplayName) {
      throw new Error("Tinder conversation changed while its history was being read");
    }
    adapter.appendViewport(fresh.messages);
    viewport = fresh;
    const moved = !sameObservedViewport(before, fresh);
    if (moved) {
      consecutiveNoProgress = 0;
      continue;
    }
    if (canScrollMore) {
      consecutiveNoProgress += 1;
      if (consecutiveNoProgress < 3) continue;
      throw new Error("The verified Tinder chat RecyclerView made no real upward progress");
    }

    await sleep(boundarySettleMilliseconds);
    const settled = observeConversationViewportFromXml(await sourceXml());
    if (!settled || settled.profile_display_name !== expectedDisplayName) {
      throw new Error("Tinder conversation changed while its history boundary was being verified");
    }
    adapter.appendViewport(settled.messages);
    viewport = settled;
    if (!sameObservedViewport(fresh, settled)) {
      consecutiveNoProgress = 0;
      continue;
    }

    const confirmedAtBoundary = await scrollTowardTop(viewport.scroll_bounds, chatScrollPercent);
    await sleep(settleMilliseconds);
    const confirmed = observeConversationViewportFromXml(await sourceXml());
    if (!confirmed || confirmed.profile_display_name !== expectedDisplayName) {
      throw new Error("Tinder conversation changed while its history boundary was being confirmed");
    }
    adapter.appendViewport(confirmed.messages);
    viewport = confirmed;
    if (!sameObservedViewport(settled, confirmed)) {
      consecutiveNoProgress = 0;
      continue;
    }
    if (confirmedAtBoundary) {
      consecutiveNoProgress += 1;
      if (consecutiveNoProgress < 3) continue;
      throw new Error("The verified Tinder chat RecyclerView reported movement without a changed viewport");
    }
    return Object.freeze({ gestures: gestures + 2, oldest_boundary_reached: true });
  }
  throw new Error("The reachable Tinder history boundary was not reached within the approved bound");
}

async function mirrorKnownUnchangedInboxRow({
  deviceId,
  row,
  inboxPosition,
  conversationId,
  processedConversationIds
}) {
  if (processedConversationIds.has(conversationId)) {
    throw new Error("One known Tinder conversation was planned for more than one Inbox row");
  }
  const lastMessageVisibleTime = row.last_message_visible_time ?? undefined;
  const transport = createExistingDashboardBearerTransport({ baseUrl: BACKEND_BASE_URL, bearerToken });
  // This is intentionally the existing narrow product update. It refreshes
  // source order only; no profile, message, history, or UI target is read.
  await transport.updateInboxOrder({
    deviceId,
    conversationId,
    inboxPosition,
    lastMessageVisibleTime
  });
  processedConversationIds.add(conversationId);
  return Object.freeze({
    action: "KNOWN_UNCHANGED",
    conversation_id: conversationId,
    inbox_position: inboxPosition,
    inbox_position_persisted: true,
    first_observed_in_sweep: true,
    last_message_visible_time_captured: lastMessageVisibleTime !== undefined,
    thread_opened: false,
    initial_profile_reads: 0,
    full_profile_read: false,
    full_history_read: false,
    profile_linked: true,
    same_sweep_reopen: false
  });
}

async function openReadAndMirror({
  deviceId,
  row,
  inboxPosition,
  processedConversationIds,
  persistInboxOrder = true
}) {
  if (persistInboxOrder && (!Number.isInteger(inboxPosition) || inboxPosition < 0)) {
    throw new Error("A non-negative Inbox position is required when Inbox order is persisted");
  }
  if (typeof persistInboxOrder !== "boolean") {
    throw new Error("persistInboxOrder must be a boolean");
  }
  const opened = await openFreshRow(row);
  const expectedDisplayName = opened.viewport.profile_display_name;
  if (!expectedDisplayName) throw new Error("Opened Tinder conversation has no verified visible header");
  const lastMessageVisibleTime = row.last_message_visible_time ?? undefined;
  const transport = createExistingDashboardBearerTransport({ baseUrl: BACKEND_BASE_URL, bearerToken });

  // This one initial profile open is also the start of the only full-profile
  // traversal. Do not open a compact profile merely to resolve a row and then
  // open it again before the required Full History path.
  const initialProfileState = await openInitialProfile(expectedDisplayName);
  const fullProfile = await readProfileToPhysicalBoundary(expectedDisplayName, initialProfileState);
  const chat = await returnToConversation(expectedDisplayName);
  const adapter = createTinderAppiumAdapter({ deviceId, transport });
  adapter.start({
    profile: fullProfile,
    messages: chat.viewport.messages,
    lastMessageVisibleTime
  });
  const resolution = await adapter.resolve();
  if (resolution?.action === "SKIP_HISTORY" && resolution?.conversation?.id) {
    const firstObservedInSweep = !processedConversationIds.has(resolution.conversation.id);
    if (firstObservedInSweep && persistInboxOrder) {
      processedConversationIds.add(resolution.conversation.id);
      await transport.updateInboxOrder({
        deviceId,
        conversationId: resolution.conversation.id,
        inboxPosition,
        lastMessageVisibleTime
      });
    }
    const result = Object.freeze({
      action: "KNOWN_REVALIDATED",
      conversation_id: resolution.conversation.id,
      inbox_position: firstObservedInSweep && persistInboxOrder ? inboxPosition : null,
      inbox_position_persisted: firstObservedInSweep && persistInboxOrder,
      first_observed_in_sweep: firstObservedInSweep,
      last_message_visible_time_captured: firstObservedInSweep && lastMessageVisibleTime !== undefined,
      thread_opened: true,
      initial_profile_reads: 1,
      full_profile_read: true,
      full_history_read: false,
      profile_linked: true,
      // The ID was resolved only after this legitimate revalidation.  If it
      // was already completed earlier in this process, report the observed
      // reopen rather than fabricating a zero metric.
      same_sweep_reopen: !firstObservedInSweep
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
  if (synced?.skipped_existing_ambiguous_singleton === true) {
    const result = Object.freeze({
      action: "EXISTING_SINGLETON_DUPLICATE_UNCHANGED",
      conversation_id: null,
      inbox_position: null,
      inbox_position_persisted: false,
      first_observed_in_sweep: false,
      last_message_visible_time_captured: lastMessageVisibleTime !== undefined,
      thread_opened: true,
      initial_profile_reads: 1,
      full_profile_read: true,
      full_history_read: true,
      profile_linked: true,
      history_gestures: read.gestures,
      // No conversation ID was returned for this deliberately untouched
      // ambiguous singleton.  A same-sweep duplicate cannot be determined,
      // so callers must not report a verified zero.
      same_sweep_reopen: null
    });
    adapter.clear();
    await returnToInbox();
    return result;
  }
  if (!synced?.conversation?.id || synced.conversation.history_complete !== true) {
    throw new Error("Completed Tinder history was not accepted by the existing product mirror");
  }
  const firstObservedInSweep = !processedConversationIds.has(synced.conversation.id);
  if (firstObservedInSweep && persistInboxOrder) {
    processedConversationIds.add(synced.conversation.id);
    await transport.updateInboxOrder({
      deviceId,
      conversationId: synced.conversation.id,
      inboxPosition,
      lastMessageVisibleTime
    });
  }
  const result = Object.freeze({
    action: synced.created ? "NEW_MIRRORED" : "KNOWN_COMPLETED",
    conversation_id: synced.conversation.id,
    inbox_position: firstObservedInSweep && persistInboxOrder ? inboxPosition : null,
    inbox_position_persisted: firstObservedInSweep && persistInboxOrder,
    first_observed_in_sweep: firstObservedInSweep,
    last_message_visible_time_captured: firstObservedInSweep && lastMessageVisibleTime !== undefined,
    thread_opened: true,
    initial_profile_reads: 1,
    full_profile_read: true,
    full_history_read: true,
    profile_linked: true,
    messages: Number(synced.conversation.message_count),
    history_gestures: read.gestures,
    same_sweep_reopen: !firstObservedInSweep
  });
  adapter.clear();
  await returnToInbox();
  return result;
}

async function verifiedInboxTop(initialInbox, viewportKeys) {
  let inbox = initialInbox;
  let consecutiveNoProgress = 0;
  for (let gesture = 0; gesture < maxInboxGestures; gesture += 1) {
    viewportKeys.add(inboxViewportKey(inbox));
    const before = inbox;
    const canScrollMore = await scrollTowardTop(before.scroll_bounds, inboxScrollPercent);
    await sleep(settleMilliseconds);
    const fresh = observeInboxFromXml(await sourceXml());
    if (!fresh) throw new Error("Tinder Inbox changed while its top was being verified");
    viewportKeys.add(inboxViewportKey(fresh));
    if (!sameInbox(before, fresh)) {
      consecutiveNoProgress = 0;
      inbox = fresh;
      continue;
    }
    if (canScrollMore) {
      consecutiveNoProgress += 1;
      if (consecutiveNoProgress < 3) continue;
      throw new Error("The verified Tinder Inbox RecyclerView made no real downward progress");
    }

    await sleep(boundarySettleMilliseconds);
    const settled = observeInboxFromXml(await sourceXml());
    if (!settled) throw new Error("Tinder Inbox changed while its top boundary was being verified");
    viewportKeys.add(inboxViewportKey(settled));
    if (!sameInbox(fresh, settled)) {
      consecutiveNoProgress = 0;
      inbox = settled;
      continue;
    }

    const confirmedAtTop = await scrollTowardTop(settled.scroll_bounds, inboxScrollPercent);
    await sleep(settleMilliseconds);
    const confirmed = observeInboxFromXml(await sourceXml());
    if (!confirmed) throw new Error("Tinder Inbox changed while its top boundary was being confirmed");
    viewportKeys.add(inboxViewportKey(confirmed));
    if (!sameInbox(settled, confirmed)) {
      consecutiveNoProgress = 0;
      inbox = confirmed;
      continue;
    }
    if (confirmedAtTop) {
      consecutiveNoProgress += 1;
      if (consecutiveNoProgress < 3) continue;
      throw new Error("The verified Tinder Inbox RecyclerView reported downward movement without a changed viewport");
    }
    return confirmed;
  }
  throw new Error("The Tinder Inbox top was not verified within the approved bound");
}

async function initialVerifiedInbox(viewportKeys) {
  let inbox = observeInboxFromXml(await sourceXml());
  if (!inbox) {
    const source = await sourceXml();
    if (observeConversationViewportFromXml(source)) inbox = await returnToInbox();
    else throw new Error("Tinder is not at a verified Inbox or conversation before the initial mirror");
  }
  return verifiedInboxTop(inbox, viewportKeys);
}

/*
 * PHASE 1: discover every currently reachable, CTA-free normal Inbox row.
 * This function deliberately contains no tap, profile, chat-reader, or
 * dashboard-transport call.  The small row inventory exists only in this
 * process and only while Phase 2 is about to consume it.
 */
async function discoverInboxInventory() {
  const viewportKeys = new Set();
  const inventory = [];
  let observedCurrentInboxRows = new Set();
  let verticalMovements = 0;
  let consecutiveNoProgress = 0;
  let continuousInboxMotionVerified = false;
  let inbox = await initialVerifiedInbox(viewportKeys);
  const initialVisibleRows = inbox.rows.length;
  viewportKeys.add(inboxViewportKey(inbox));

  for (let gesture = 0; gesture < maxInboxGestures; gesture += 1) {
    for (;;) {
      inbox = await stableInboxProjection(inbox);
      const rowIndex = inbox.rows.findIndex((candidate, index) => !observedCurrentInboxRows.has(index));
      if (rowIndex < 0) break;
      const row = inbox.rows[rowIndex];
      observedCurrentInboxRows.add(rowIndex);
      inventory.push(inventoryEntryFromRow(row, inventory.length));
    }

    const before = inbox;
    const canScrollMore = await scrollTowardBottom(before.scroll_bounds, inboxScrollPercent);
    await sleep(settleMilliseconds);
    const fresh = observeInboxFromXml(await sourceXml());
    if (!fresh) throw new Error("Tinder Inbox changed while being vertically traversed");
    viewportKeys.add(inboxViewportKey(fresh));
    const moved = !sameInbox(before, fresh);
    const overlap = moved
      ? nextInboxOverlap(before, fresh, { continuousMotionVerified: continuousInboxMotionVerified })
      : new Set();
    if (moved) {
      observedCurrentInboxRows = reconcileProcessedInboxRows(before, fresh, observedCurrentInboxRows);
      continuousInboxMotionVerified ||= overlap.size > 0;
      verticalMovements += 1;
      consecutiveNoProgress = 0;
      inbox = fresh;
      // A physical gesture may legitimately return false while it reveals the
      // final viewport. Always loop once more to process that viewport before
      // considering the physical end.
      continue;
    }
    if (canScrollMore) {
      consecutiveNoProgress += 1;
      if (consecutiveNoProgress < 3) continue;
      throw new Error("The verified Tinder Inbox RecyclerView made no real upward progress");
    }

    await sleep(boundarySettleMilliseconds);
    const settled = observeInboxFromXml(await sourceXml());
    if (!settled) throw new Error("Tinder Inbox changed while its end was being verified");
    viewportKeys.add(inboxViewportKey(settled));
    if (!sameInbox(fresh, settled)) {
      const delayedOverlap = nextInboxOverlap(fresh, settled, {
        continuousMotionVerified: continuousInboxMotionVerified
      });
      observedCurrentInboxRows = reconcileProcessedInboxRows(fresh, settled, observedCurrentInboxRows);
      continuousInboxMotionVerified ||= delayedOverlap.size > 0;
      verticalMovements += 1;
      consecutiveNoProgress = 0;
      inbox = settled;
      continue;
    }

    const confirmedAtBoundary = await scrollTowardBottom(settled.scroll_bounds, inboxScrollPercent);
    await sleep(settleMilliseconds);
    const confirmed = observeInboxFromXml(await sourceXml());
    if (!confirmed) throw new Error("Tinder Inbox changed while its end was being confirmed");
    viewportKeys.add(inboxViewportKey(confirmed));
    if (!sameInbox(settled, confirmed)) {
      const confirmedOverlap = nextInboxOverlap(settled, confirmed, {
        continuousMotionVerified: continuousInboxMotionVerified
      });
      observedCurrentInboxRows = reconcileProcessedInboxRows(settled, confirmed, observedCurrentInboxRows);
      continuousInboxMotionVerified ||= confirmedOverlap.size > 0;
      verticalMovements += 1;
      consecutiveNoProgress = 0;
      inbox = confirmed;
      continue;
    }
    if (confirmedAtBoundary) {
      consecutiveNoProgress += 1;
      if (consecutiveNoProgress < 3) continue;
      throw new Error("The verified Tinder Inbox RecyclerView reported upward movement without a changed viewport");
    }
    return Object.freeze({
      inventory: Object.freeze(inventory),
      initial_visible_rows: initialVisibleRows,
      vertical_movements: verticalMovements,
      distinct_viewports: viewportKeys.size,
      end_actually_reached: true
    });
  }
  throw new Error("The reachable Tinder Inbox end was not verified within the approved bound");
}

/*
 * PHASE 2: replay exactly the just-discovered order.  Every entry is matched
 * against a newly observed row immediately before its tap.  The processed
 * ordinal set is RAM-only and makes a second Full Read of one inventory entry
 * impossible during this uninterrupted initial import.
 */
async function processDiscoveredInboxInventory({
  deviceId,
  inventory,
  initialProcessingPlan,
  ramBindings = []
}) {
  const results = [];
  const processingPlanByInboxPosition = planByInboxPosition(inventory, initialProcessingPlan);
  // Retain only direct same-process row continuity.  New bindings are minted
  // after a verified read below and vanish when this process exits.
  const sweepRamBindingsByRowRamKey = ramOnlyInitialSweepBindingMap(ramBindings);
  const viewportKeys = new Set();
  const processedInventoryOrdinals = new Set();
  let processedCurrentInboxRows = new Set();
  const processedConversationIds = new Set();
  let nextInventoryOrdinal = 0;
  let threadOpens = 0;
  let profileReads = 0;
  let historyReads = 0;
  let verticalMovements = 0;
  let consecutiveNoProgress = 0;
  let continuousInboxMotionVerified = false;
  let inbox = await initialVerifiedInbox(viewportKeys);

  for (let gesture = 0; gesture < maxInboxGestures; gesture += 1) {
    for (;;) {
      inbox = await stableInboxProjection(inbox);
      const rowIndex = inbox.rows.findIndex((candidate, index) => !processedCurrentInboxRows.has(index));
      if (rowIndex < 0) break;
      const planned = inventory[nextInventoryOrdinal];
      if (!planned) throw new Error("Tinder Inbox exposed a row not present in the completed RAM-only inventory");
      const row = inbox.rows[rowIndex];
      if (!sameTransientInboxRow(row, planned.observed_row)) {
        throw new Error("Tinder Inbox changed between discovery and the fresh processing revalidation");
      }
      if (processedInventoryOrdinals.has(planned.inbox_position)) {
        throw new Error("A completed RAM-only Inbox inventory entry would be reopened");
      }
      const processingPlan = processingPlanByInboxPosition.get(planned.inbox_position);
      if (!processingPlan) {
        throw new Error("A completed RAM-only Inbox inventory entry has no processing plan");
      }

      processedCurrentInboxRows.add(rowIndex);
      processedInventoryOrdinals.add(planned.inbox_position);
      const result = await executeInitialInboxPlanEntry({
        plan: processingPlan,
        deviceId,
        row,
        inboxPosition: planned.inbox_position,
        processedConversationIds,
        ramBindings: sweepRamBindingsByRowRamKey
      });
      if (typeof result?.thread_opened !== "boolean"
        || !Number.isInteger(result?.initial_profile_reads)
        || result.initial_profile_reads < 0
        || typeof result?.full_history_read !== "boolean"
        || ![true, false, null].includes(result?.same_sweep_reopen)) {
        throw new Error("The initial Inbox processing result has invalid performance counters");
      }
      threadOpens += Number(result.thread_opened);
      profileReads += result.initial_profile_reads;
      historyReads += Number(result.full_history_read);
      results.push(result);
      if (result.first_observed_in_sweep === true
        && typeof result.conversation_id === "string"
        && result.action !== "KNOWN_UNCHANGED") {
        const binding = createRamOnlyInitialSweepBinding({
          observedRow: row,
          conversationId: result.conversation_id
        });
        const existing = sweepRamBindingsByRowRamKey.get(binding.observed_row_ram_key);
        if (existing && existing.conversation_id !== binding.conversation_id) {
          throw new Error("A verified same-sweep row cannot bind to multiple conversations");
        }
        sweepRamBindingsByRowRamKey.set(binding.observed_row_ram_key, binding);
      }
      nextInventoryOrdinal += 1;

      const restored = observeInboxFromXml(await sourceXml());
      if (!restored) throw new Error("Tinder did not remain at a verified Inbox after a completed thread");
      const stableRestored = await stableInboxProjection(restored);
      processedCurrentInboxRows = reconcileProcessedInboxRows(inbox, stableRestored, processedCurrentInboxRows, {
        requireDirectContinuity: true
      });
      inbox = stableRestored;
      viewportKeys.add(inboxViewportKey(inbox));
    }

    const before = inbox;
    const canScrollMore = await scrollTowardBottom(before.scroll_bounds, inboxScrollPercent);
    await sleep(settleMilliseconds);
    const fresh = observeInboxFromXml(await sourceXml());
    if (!fresh) throw new Error("Tinder Inbox changed while Phase 2 was being vertically traversed");
    viewportKeys.add(inboxViewportKey(fresh));
    const moved = !sameInbox(before, fresh);
    const overlap = moved
      ? nextInboxOverlap(before, fresh, { continuousMotionVerified: continuousInboxMotionVerified })
      : new Set();
    if (moved) {
      processedCurrentInboxRows = reconcileProcessedInboxRows(before, fresh, processedCurrentInboxRows);
      continuousInboxMotionVerified ||= overlap.size > 0;
      verticalMovements += 1;
      consecutiveNoProgress = 0;
      inbox = fresh;
      continue;
    }
    if (canScrollMore) {
      consecutiveNoProgress += 1;
      if (consecutiveNoProgress < 3) continue;
      throw new Error("The verified Tinder Inbox RecyclerView made no real Phase 2 downward progress");
    }

    await sleep(boundarySettleMilliseconds);
    const settled = observeInboxFromXml(await sourceXml());
    if (!settled) throw new Error("Tinder Inbox changed while its Phase 2 end was being verified");
    viewportKeys.add(inboxViewportKey(settled));
    if (!sameInbox(fresh, settled)) {
      const delayedOverlap = nextInboxOverlap(fresh, settled, {
        continuousMotionVerified: continuousInboxMotionVerified
      });
      processedCurrentInboxRows = reconcileProcessedInboxRows(fresh, settled, processedCurrentInboxRows);
      continuousInboxMotionVerified ||= delayedOverlap.size > 0;
      verticalMovements += 1;
      consecutiveNoProgress = 0;
      inbox = settled;
      continue;
    }

    const confirmedAtBoundary = await scrollTowardBottom(settled.scroll_bounds, inboxScrollPercent);
    await sleep(settleMilliseconds);
    const confirmed = observeInboxFromXml(await sourceXml());
    if (!confirmed) throw new Error("Tinder Inbox changed while its Phase 2 end was being confirmed");
    viewportKeys.add(inboxViewportKey(confirmed));
    if (!sameInbox(settled, confirmed)) {
      const confirmedOverlap = nextInboxOverlap(settled, confirmed, {
        continuousMotionVerified: continuousInboxMotionVerified
      });
      processedCurrentInboxRows = reconcileProcessedInboxRows(settled, confirmed, processedCurrentInboxRows);
      continuousInboxMotionVerified ||= confirmedOverlap.size > 0;
      verticalMovements += 1;
      consecutiveNoProgress = 0;
      inbox = confirmed;
      continue;
    }
    if (confirmedAtBoundary) {
      consecutiveNoProgress += 1;
      if (consecutiveNoProgress < 3) continue;
      throw new Error("The verified Tinder Inbox RecyclerView reported Phase 2 movement without a changed viewport");
    }
    if (nextInventoryOrdinal !== inventory.length || processedInventoryOrdinals.size !== inventory.length) {
      throw new Error("The completed RAM-only Inbox inventory was not fully consumed before the verified end");
    }
    const sameSweep = summarizeSameSweepReopens(results);
    return Object.freeze({
      results: Object.freeze(results),
      unique_threads_processed: processedInventoryOrdinals.size,
      thread_opens: threadOpens,
      profile_reads: profileReads,
      history_reads: historyReads,
      same_sweep_reopens: sameSweep.same_sweep_reopens,
      same_sweep_reopens_verified: sameSweep.same_sweep_reopens_verified,
      vertical_movements: verticalMovements,
      distinct_viewports: viewportKeys.size,
      end_actually_reached: true
    });
  }
  throw new Error("The reachable Tinder Inbox Phase 2 end was not verified within the approved bound");
}

/*
 * Reuses the proven Block-2 Appium controls for the local pg-boss worker.
 * Unlike `main()`, this factory never starts an Inbox sweep: each operation
 * receives one already revalidated current row from the RAM-only dispatcher.
 */
export async function createTinderLocalDiscoveryRuntime(environment = process.env) {
  configureRuntime(environment);
  const deviceId = await resolveDeviceId();
  const transport = createExistingDashboardBearerTransport({ baseUrl: BACKEND_BASE_URL, bearerToken });

  return Object.freeze({
    deviceId,
    readSourceXml: sourceXml,

    async readKnownChanged({ row, conversationId }) {
      const opened = await openFreshRow(row);
      if (!opened?.viewport?.profile_display_name) {
        throw new Error("A known Tinder delta requires a freshly verified conversation header");
      }
      const adapter = createTinderAppiumDeltaAdapter({ deviceId, conversationId, transport });
      const lastMessageVisibleTime = row.last_message_visible_time ?? undefined;
      await adapter.persistViewport({
        messages: opened.viewport.messages,
        ...(lastMessageVisibleTime === undefined ? {} : { lastMessageVisibleTime })
      });
      await returnToInbox();
      return Object.freeze({ outcome: "KNOWN_CHANGED" });
    },

    async readNewThread({ row }) {
      const result = await openReadAndMirror({
        deviceId,
        row,
        // A source-change job sees one fresh row, not a completed global
        // Inbox inventory. It must not invent or overwrite a global order.
        inboxPosition: null,
        processedConversationIds: new Set(),
        persistInboxOrder: false
      });
      if (result.action !== "NEW_MIRRORED" || typeof result.conversation_id !== "string") {
        return Object.freeze({ outcome: "AMBIGUOUS" });
      }
      return Object.freeze({
        outcome: "NEW_THREAD",
        conversation_id: result.conversation_id
      });
    }
  });
}

export async function main(environment = process.env) {
  configureRuntime(environment);
  const deviceId = await resolveDeviceId();
  const before = await dashboard("/dashboard-api/tinder/conversations");
  const beforeIds = new Set((before.conversations || []).map((conversation) => conversation.id));
  const discovery = await discoverInboxInventory();
  const initialProcessingPlan = planInitialInboxProcessing({
    inventory: discovery.inventory
  });
  const processing = await processDiscoveredInboxInventory({
    deviceId,
    inventory: discovery.inventory,
    initialProcessingPlan,
    ramBindings: []
  });
  const results = processing.results;
  const after = await dashboard("/dashboard-api/tinder/conversations");
  const afterIds = new Set((after.conversations || []).map((conversation) => conversation.id));
  const knownIds = new Set(results
    .filter((result) => result.action !== "NEW_MIRRORED" && typeof result.conversation_id === "string")
    .map((result) => result.conversation_id));
  const newIds = new Set(results.filter((result) => result.action === "NEW_MIRRORED").map((result) => result.conversation_id));
  const firstThreadResults = results.filter((result) => result.first_observed_in_sweep === true);
  const knownUnchangedResults = results.filter((result) => result.action === "KNOWN_UNCHANGED");

  console.log(JSON.stringify({
    initial_normal_message_rows: discovery.initial_visible_rows,
    discovery_separated_from_processing: true,
    discovery_thread_opens: 0,
    discovery_history_reads: 0,
    discovery_profile_reads: 0,
    unique_inbox_inventory_threads: discovery.inventory.length,
    discovery_real_inbox_vertical_movement_verified: discovery.vertical_movements > 0,
    discovery_inbox_vertical_movements: discovery.vertical_movements,
    discovery_distinct_inbox_viewports: discovery.distinct_viewports,
    discovery_inbox_end_actually_reached: discovery.end_actually_reached,
    processing_real_inbox_vertical_movement_verified: processing.vertical_movements > 0,
    processing_inbox_vertical_movements: processing.vertical_movements,
    processing_distinct_inbox_viewports: processing.distinct_viewports,
    processing_inbox_end_actually_reached: processing.end_actually_reached,
    normal_row_visits: results.length,
    first_thread_observations: firstThreadResults.length,
    distinct_threads_processed: processing.unique_threads_processed,
    total_thread_opens: processing.thread_opens,
    initial_profile_reads: processing.profile_reads,
    history_reads: processing.history_reads,
    same_sweep_reopens: processing.same_sweep_reopens,
    same_sweep_reopens_verified: processing.same_sweep_reopens_verified,
    known_threads_reused: knownIds.size,
    known_unchanged_threads: knownUnchangedResults.length,
    known_unchanged_thread_opens: knownUnchangedResults.reduce((total, result) => total + Number(result.thread_opened), 0),
    known_unchanged_profile_reads: knownUnchangedResults.reduce((total, result) => total + result.initial_profile_reads, 0),
    known_unchanged_history_reads: knownUnchangedResults.reduce((total, result) => total + Number(result.full_history_read), 0),
    new_threads_mirrored: newIds.size,
    full_histories_read: results.filter((result) => result.full_history_read).length,
    full_profiles_read: results.filter((result) => result.full_profile_read).length,
    profiles_linked: firstThreadResults.filter((result) => result.profile_linked).length,
    inbox_positions_observed: results.filter((result) => result.inbox_position_persisted).length,
    last_message_visible_time_values: firstThreadResults.filter((result) => result.last_message_visible_time_captured).length,
    existing_singleton_duplicate_rows_unchanged: results.filter((result) => result.action === "EXISTING_SINGLETON_DUPLICATE_UNCHANGED").length,
    reachable_history_complete: firstThreadResults.length > 0 && firstThreadResults.every((result) => result.action === "KNOWN_UNCHANGED"
      || result.action === "KNOWN_REVALIDATED" || result.action === "NEW_MIRRORED"
      || result.action === "KNOWN_COMPLETED" || result.action === "EXISTING_SINGLETON_DUPLICATE_UNCHANGED"),
    conversations_before: beforeIds.size,
    conversations_after: afterIds.size,
    conversations_created: afterIds.size - beforeIds.size,
    duplicate_conversations_created: Math.max(0, afterIds.size - beforeIds.size - newIds.size),
    capture_system_created: false,
    identity_system_created: false,
    safety_system_created: false,
    heartbeat_used_as_gate: false
  }));
}

const invokedAsScript = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedAsScript) {
  await main();
}
