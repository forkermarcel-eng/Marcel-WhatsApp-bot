/*
 * Block 2's read-only New-Matches initial inventory.
 *
 * Phase 1 observes the compact horizontal carousel locally and keeps its
 * ordered, adjacent-overlap inventory only in RAM.  Phase 2 sends each
 * inventory item exactly once as an unassigned Match through the existing
 * dashboard bearer endpoint.  A Match tile is never tapped, opened, linked
 * to a Conversation, or used to read a profile/history in this runner.
 */

import { pathToFileURL } from "node:url";
import { observeMatchCarouselFromXml } from "../tinder-mirror/appium-conversation-reader.js";

const DEFAULT_APPIUM_BASE_URL = "http://127.0.0.1:4723/wd/hub";
const DEFAULT_BACKEND_BASE_URL = "https://cooperative-kindness-production.up.railway.app";

function valueString(value) {
  return String(value || "").trim();
}

function boundedInteger(value, { name, fallback, minimum, maximum }) {
  const parsed = Number.parseInt(valueString(value || fallback), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function sameBounds(left, right) {
  return Boolean(left && right
    && left.left === right.left && left.top === right.top
    && left.right === right.right && left.bottom === right.bottom);
}

/*
 * This is solely a same-run, adjacent-carousel comparison.  It intentionally
 * excludes UiAutomator bounds and never becomes a stored Match or person
 * identifier.  Its only purpose is to retain the visible overlap after one
 * physical horizontal gesture so an item is not submitted twice in Phase 2.
 */
export function transientTileStateKey(entry) {
  if (!entry?.tile || typeof entry.tile !== "object") return null;
  return JSON.stringify(entry.tile);
}

export function sameCarouselProjection(left, right) {
  const leftTiles = left?.tiles || [];
  const rightTiles = right?.tiles || [];
  return sameBounds(left?.scroll_bounds, right?.scroll_bounds)
    && leftTiles.length === rightTiles.length
    && leftTiles.every((tile, index) => {
      const before = transientTileStateKey(tile);
      const after = transientTileStateKey(rightTiles[index]);
      return before !== null && before === after;
    });
}

/*
 * Finds one exact suffix/prefix overlap between two immediately adjacent
 * carousel projections.  This is not a cross-run dedupe and does not combine
 * different tiles that merely share a name or image.  A no-overlap transition
 * is rejected rather than guessing which tile continued across the gesture.
 */
export function directCarouselOverlap(previousTiles, freshTiles) {
  const before = Array.isArray(previousTiles) ? previousTiles : [];
  const after = Array.isArray(freshTiles) ? freshTiles : [];
  const matches = [];
  const maximum = Math.min(before.length, after.length);
  for (let size = 1; size <= maximum; size += 1) {
    const consistent = Array.from({ length: size }, (_, index) => {
      const left = transientTileStateKey(before[before.length - size + index]);
      const right = transientTileStateKey(after[index]);
      return left !== null && left === right;
    }).every(Boolean);
    if (consistent) matches.push(size);
  }
  if (!matches.length) return null;
  const largest = Math.max(...matches);
  // A smaller overlap is necessarily contained in the largest exact sequence;
  // only the largest one describes the adjacent viewport continuation.
  return largest;
}

export function appendCarouselInventory(inventory, projection, overlap = 0) {
  const current = Array.isArray(inventory) ? inventory : [];
  const visible = projection?.tiles || [];
  if (!Number.isInteger(overlap) || overlap < 0 || overlap > visible.length) {
    throw new Error("Match carousel overlap is invalid");
  }
  const additions = visible.slice(overlap).map((observed, offset) => Object.freeze({
    tile: observed.tile,
    carousel_position: current.length + offset,
    // Retained only to support same-run assertions below; Phase 2 sends no
    // local key and no inferred Conversation relation.
    ram_tile_state: transientTileStateKey(observed)
  }));
  return Object.freeze([...current, ...additions]);
}

export function matchWirePayload(entry) {
  if (!entry?.tile || !Number.isInteger(entry.carousel_position) || entry.carousel_position < 0) {
    throw new Error("A valid RAM-only Match inventory entry is required");
  }
  return Object.freeze({
    tile: entry.tile,
    carousel_position: entry.carousel_position,
    conversation_id: null
  });
}

function runtimeConfiguration(environment = process.env) {
  const sessionId = valueString(environment.APPIUM_SESSION);
  const bearerToken = valueString(environment.DASHBOARD_API_SECRET);
  const installedBridgeVersionCode = Number.parseInt(valueString(environment.TINDER_DEVICE_VERSION_CODE), 10);
  if (!sessionId) throw new Error("APPIUM_SESSION is required");
  if (!bearerToken) throw new Error("DASHBOARD_API_SECRET is required");
  if (!Number.isInteger(installedBridgeVersionCode) || installedBridgeVersionCode < 0) {
    throw new Error("TINDER_DEVICE_VERSION_CODE must be the installed Bridge version code");
  }
  return Object.freeze({
    appiumBaseUrl: valueString(environment.APPIUM_BASE_URL || DEFAULT_APPIUM_BASE_URL).replace(/\/+$/, ""),
    backendBaseUrl: valueString(environment.TINDER_MIRROR_BASE_URL || DEFAULT_BACKEND_BASE_URL).replace(/\/+$/, ""),
    sessionId,
    bearerToken,
    installedBridgeVersionCode,
    maxGestures: boundedInteger(environment.TINDER_BLOCK2_MAX_MATCH_GESTURES, {
      name: "TINDER_BLOCK2_MAX_MATCH_GESTURES",
      fallback: "80",
      minimum: 1,
      maximum: 200
    })
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createRuntime(config) {
  async function appium(path, { method = "GET", body } = {}) {
    const response = await fetch(`${config.appiumBaseUrl}/session/${encodeURIComponent(config.sessionId)}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.value?.error) throw new Error("Appium Match control operation failed");
    return result?.value;
  }

  async function sourceXml() {
    const source = await appium("/source");
    if (typeof source !== "string" || source.length < 100) {
      throw new Error("Appium Match source projection is unavailable");
    }
    return source;
  }

  async function dashboard(path, { method = "GET", body } = {}) {
    const response = await fetch(`${config.backendBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.bearerToken}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store"
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error("Tinder Match dashboard request failed");
    return payload;
  }

  async function scrollCarousel(bounds, direction) {
    const inset = Math.max(16, Math.round(bounds.height * 0.08));
    const result = await appium("/execute/sync", {
      method: "POST",
      body: {
        script: "mobile: scrollGesture",
        args: [{
          left: bounds.left + Math.max(8, Math.round(bounds.width * 0.03)),
          top: bounds.top + inset,
          width: bounds.width - Math.max(16, Math.round(bounds.width * 0.06)),
          height: bounds.height - inset * 2,
          direction,
          // A short, verified physical movement keeps a direct visual overlap
          // between adjacent carousel projections.
          percent: 0.25
        }]
      }
    });
    if (typeof result !== "boolean") {
      throw new Error("Appium Match carousel scroll did not report a boundary result");
    }
    return result;
  }

  return Object.freeze({ sourceXml, dashboard, scrollCarousel });
}

async function freshCarousel(runtime) {
  const carousel = observeMatchCarouselFromXml(await runtime.sourceXml());
  if (!carousel) throw new Error("Tinder is not at a verified Inbox with a readable New-Matches carousel");
  return carousel;
}

async function stableCarousel(runtime, initial) {
  let current = initial;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await sleep(350);
    const fresh = await freshCarousel(runtime);
    if (sameCarouselProjection(current, fresh)) return fresh;
    current = fresh;
  }
  throw new Error("Tinder New-Matches carousel did not reach a stable projection");
}

/*
 * Return to the leading carousel edge before collecting anything.  This
 * performs only horizontal physical scrolling inside the freshly verified
 * carousel; it never opens or selects a Match tile.
 */
async function carouselAtLeadingEdge(runtime, { maxGestures }) {
  let carousel = await stableCarousel(runtime, await freshCarousel(runtime));
  let noProgress = 0;
  for (let gesture = 0; gesture < maxGestures; gesture += 1) {
    const before = carousel;
    // The live Tinder carousel's visual leading edge is reached by moving
    // its RecyclerView left.  From that edge, a rightward move preserves a
    // suffix/prefix overlap in normal visual order.
    const canScrollMore = await runtime.scrollCarousel(before.scroll_bounds, "left");
    await sleep(700);
    const fresh = await freshCarousel(runtime);
    if (!sameCarouselProjection(before, fresh)) {
      noProgress = 0;
      carousel = await stableCarousel(runtime, fresh);
      continue;
    }
    if (canScrollMore) {
      noProgress += 1;
      if (noProgress < 3) continue;
      throw new Error("Tinder New-Matches carousel reported leading movement without a changed projection");
    }
    const confirmed = await runtime.scrollCarousel(fresh.scroll_bounds, "left");
    await sleep(700);
    const projection = await freshCarousel(runtime);
    if (!sameCarouselProjection(fresh, projection)) {
      noProgress = 0;
      carousel = await stableCarousel(runtime, projection);
      continue;
    }
    if (confirmed) {
      throw new Error("Tinder New-Matches leading edge could not be confirmed");
    }
    return carousel;
  }
  throw new Error("Tinder New-Matches leading edge was not reached within the approved bound");
}

/*
 * PHASE 1.  All inventory state is transient.  The exact direct overlap is
 * necessary only to avoid re-submitting a tile that is visible in two
 * immediately adjacent carousel viewports of this one run.
 */
export async function discoverMatchInventory(runtime, { maxGestures }) {
  let carousel = await carouselAtLeadingEdge(runtime, { maxGestures });
  const initialVisibleTiles = carousel.tiles.length;
  let inventory = appendCarouselInventory([], carousel);
  let horizontalMovements = 0;
  let noProgress = 0;

  for (let gesture = 0; gesture < maxGestures; gesture += 1) {
    const before = carousel;
    const canScrollMore = await runtime.scrollCarousel(before.scroll_bounds, "right");
    await sleep(700);
    const fresh = await freshCarousel(runtime);
    if (!sameCarouselProjection(before, fresh)) {
      const overlap = directCarouselOverlap(before.tiles, fresh.tiles);
      if (overlap === null) {
        throw new Error("Tinder New-Matches carousel lost direct local continuity during inventory");
      }
      inventory = appendCarouselInventory(inventory, fresh, overlap);
      horizontalMovements += 1;
      noProgress = 0;
      carousel = await stableCarousel(runtime, fresh);
      continue;
    }
    if (canScrollMore) {
      noProgress += 1;
      if (noProgress < 3) continue;
      throw new Error("Tinder New-Matches carousel reported movement without a changed projection");
    }
    const confirmed = await runtime.scrollCarousel(fresh.scroll_bounds, "right");
    await sleep(700);
    const projection = await freshCarousel(runtime);
    if (!sameCarouselProjection(fresh, projection)) {
      const overlap = directCarouselOverlap(fresh.tiles, projection.tiles);
      if (overlap === null) {
        throw new Error("Tinder New-Matches carousel lost direct local continuity at its end");
      }
      inventory = appendCarouselInventory(inventory, projection, overlap);
      horizontalMovements += 1;
      noProgress = 0;
      carousel = await stableCarousel(runtime, projection);
      continue;
    }
    if (confirmed) {
      throw new Error("Tinder New-Matches carousel end could not be confirmed");
    }
    return Object.freeze({
      inventory: Object.freeze(inventory),
      initial_visible_tiles: initialVisibleTiles,
      horizontal_movements: horizontalMovements,
      end_actually_reached: true
    });
  }
  throw new Error("The reachable Tinder New-Matches end was not verified within the approved bound");
}

/*
 * PHASE 2.  This has no UI action.  A RAM-only ordinal set makes it
 * impossible for this process to submit one inventory item twice.  Every
 * Match remains unassigned because this block never opens a tile or a chat.
 */
export async function persistMatchInventory(runtime, { deviceId, inventory }) {
  const processedOrdinals = new Set();
  let created = 0;
  for (const entry of inventory || []) {
    if (processedOrdinals.has(entry.carousel_position)) {
      throw new Error("A RAM-only Match inventory item would be submitted twice");
    }
    const response = await runtime.dashboard("/dashboard-api/tinder/matches", {
      method: "POST",
      body: {
        device_id: deviceId,
        match: matchWirePayload(entry)
      }
    });
    processedOrdinals.add(entry.carousel_position);
    if (response.created === true) created += 1;
  }
  if (processedOrdinals.size !== (inventory || []).length) {
    throw new Error("The Match inventory was not fully processed");
  }
  return Object.freeze({
    processed: processedOrdinals.size,
    created,
    same_sweep_reprocesses: 0
  });
}

async function resolveDeviceId(runtime, installedBridgeVersionCode) {
  const result = await runtime.dashboard("/dashboard-api/device-bridge/devices");
  const matching = (result.devices || []).filter((device) => Number(device.app_version_code) === installedBridgeVersionCode);
  if (matching.length !== 1 || typeof matching[0].device_id !== "string") {
    throw new Error("A unique device matching the installed Bridge version is required");
  }
  return matching[0].device_id;
}

/*
 * The local discovery worker reuses the existing read-only carousel inventory
 * and ordinary Match ingress. It never taps or opens a Match tile.
 */
export async function createTinderLocalMatchDiscoveryRuntime(environment = process.env) {
  const config = runtimeConfiguration(environment);
  const runtime = createRuntime(config);
  const deviceId = await resolveDeviceId(runtime, config.installedBridgeVersionCode);
  return Object.freeze({
    deviceId,
    async readMatchDiscovery() {
      const discovery = await discoverMatchInventory(runtime, { maxGestures: config.maxGestures });
      await persistMatchInventory(runtime, { deviceId, inventory: discovery.inventory });
      return Object.freeze({ outcome: "MATCH_UPDATED" });
    }
  });
}

export async function main(environment = process.env) {
  const config = runtimeConfiguration(environment);
  const runtime = createRuntime(config);
  const deviceId = await resolveDeviceId(runtime, config.installedBridgeVersionCode);
  const discovery = await discoverMatchInventory(runtime, { maxGestures: config.maxGestures });
  const persistence = await persistMatchInventory(runtime, { deviceId, inventory: discovery.inventory });

  // Never emit names, profile text, raw UI structure, IDs, or other visible
  // Tinder content in this operational result.
  console.log(JSON.stringify({
    match_inventory_phase_separated_from_persistence: true,
    initial_visible_match_tiles: discovery.initial_visible_tiles,
    horizontal_scroll_performed: discovery.horizontal_movements > 0,
    horizontal_scroll_movements: discovery.horizontal_movements,
    match_carousel_end_actually_reached: discovery.end_actually_reached,
    ram_unique_match_tiles: discovery.inventory.length,
    processed_match_tiles: persistence.processed,
    matches_created: persistence.created,
    same_sweep_match_reprocesses: persistence.same_sweep_reprocesses,
    match_tile_opens: 0,
    conversation_opens: 0,
    profile_reads: 0,
    history_reads: 0,
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
