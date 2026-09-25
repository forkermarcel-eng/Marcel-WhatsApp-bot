import {
  headerProfileTargetFromXml,
  mergeProfileSnapshots,
  observeConversationViewportFromXml,
  observeMatchCarouselFromXml,
  observeProfileFromXml
} from "./appium-conversation-reader.js";

/*
 * This runner is intentionally separate from the full Inbox sync. It accepts
 * one already-requested visible Match snapshot, finds that exact current tile
 * through a new read-only carousel inventory, reads a live profile, then
 * returns with Back. Its state exists only for the running operation.
 */

const DEFAULT_MAX_CAROUSEL_GESTURES = 80;
const DEFAULT_MAX_PROFILE_GESTURES = 80;
const DEFAULT_REINVENTORY_ATTEMPTS = 2;
const DEFAULT_SETTLE_MILLISECONDS = 350;
const DEFAULT_BOUNDARY_SETTLE_MILLISECONDS = 700;
const MAX_TRANSIENT_CAROUSEL_READS = 8;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sameBounds(left, right) {
  return Boolean(left && right
    && left.left === right.left && left.top === right.top
    && left.right === right.right && left.bottom === right.bottom);
}

function boundedInteger(value, fallback, { minimum, maximum, name }) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return candidate;
}

function tileProjection(value) {
  if (!plainObject(value)
    || typeof value.display_name !== "string"
    || !plainObject(value.attributes)
    || !Array.isArray(value.media_refs)) return null;
  const displayName = value.display_name.normalize("NFC").trim();
  if (!displayName) return null;
  const attributes = Object.entries(value.attributes)
    .filter(([key, attribute]) => typeof key === "string" && typeof attribute === "string")
    .sort(([left], [right]) => left.localeCompare(right));
  if (attributes.length !== Object.keys(value.attributes).length) return null;
  const mediaRefs = value.media_refs.map((reference) => typeof reference === "string" ? reference : null);
  if (mediaRefs.some((reference) => reference === null)) return null;
  return Object.freeze({
    display_name: displayName,
    attributes: Object.freeze(attributes.map(([key, attribute]) => Object.freeze([key, attribute.normalize("NFC").trim()]))),
    media_refs: Object.freeze(mediaRefs.map((reference) => reference.normalize("NFC").trim()))
  });
}

/*
 * This is an exact comparison of ordinary visible tile product fields for the
 * current UI operation. It does not create a durable key: equal tiles are
 * deliberately treated as ambiguous below.
 */
export function sameVisibleMatchTile(left, right) {
  const leftProjection = tileProjection(left);
  const rightProjection = tileProjection(right);
  if (!leftProjection || !rightProjection) return false;
  return leftProjection.display_name === rightProjection.display_name
    && leftProjection.attributes.length === rightProjection.attributes.length
    && leftProjection.attributes.every(([key, value], index) => key === rightProjection.attributes[index][0]
      && value === rightProjection.attributes[index][1])
    && leftProjection.media_refs.length === rightProjection.media_refs.length
    && leftProjection.media_refs.every((value, index) => value === rightProjection.media_refs[index]);
}

export function sameLiveCarouselProjection(left, right) {
  const leftTiles = left?.tiles || [];
  const rightTiles = right?.tiles || [];
  return sameBounds(left?.scroll_bounds, right?.scroll_bounds)
    && leftTiles.length === rightTiles.length
    && leftTiles.every((entry, index) => sameVisibleMatchTile(entry?.tile, rightTiles[index]?.tile));
}

/*
 * Direct suffix/prefix continuity is sufficient only for adjacent physical
 * carousel movements in this one live run. It is never retained after the
 * runner returns.
 */
export function directLiveCarouselOverlap(previousTiles, freshTiles) {
  const before = Array.isArray(previousTiles) ? previousTiles : [];
  const after = Array.isArray(freshTiles) ? freshTiles : [];
  const matches = [];
  const maximum = Math.min(before.length, after.length);
  for (let size = 1; size <= maximum; size += 1) {
    const consistent = Array.from({ length: size }, (_, index) => sameVisibleMatchTile(
      before[before.length - size + index]?.tile,
      after[index]?.tile
    )).every(Boolean);
    if (consistent) matches.push(size);
  }
  return matches.length ? Math.max(...matches) : null;
}

function appendFreshInventory(inventory, carousel, overlap = 0) {
  const current = Array.isArray(inventory) ? inventory : [];
  const tiles = carousel?.tiles || [];
  if (!Number.isInteger(overlap) || overlap < 0 || overlap > tiles.length) {
    throw new Error("Live Tinder Match carousel overlap is invalid");
  }
  return Object.freeze([
    ...current,
    ...tiles.slice(overlap).map((observed, offset) => Object.freeze({
      tile: observed.tile,
      carousel_position: current.length + offset
    }))
  ]);
}

function matchingTiles(carousel, requestedTile) {
  return (carousel?.tiles || [])
    .map((observed, index) => Object.freeze({ observed, index }))
    .filter(({ observed }) => sameVisibleMatchTile(observed?.tile, requestedTile));
}

function requestedTileFrom(value) {
  const tile = value?.tile;
  if (!tileProjection(tile)) {
    throw new TypeError("requestedMatch.tile must be a visible Tinder Match tile projection");
  }
  return tile;
}

function verifyRuntime(runtime, methods) {
  for (const method of methods) {
    if (typeof runtime?.[method] !== "function") {
      throw new TypeError(`runtime.${method} is required`);
    }
  }
}

function verifyCarouselRuntime(runtime) {
  verifyRuntime(runtime, ["sourceXml", "scrollCarousel"]);
}

function verifyProfileRuntime(runtime) {
  verifyRuntime(runtime, ["sourceXml", "scrollProfile"]);
}

function verifyLiveProfileRuntime(runtime) {
  verifyRuntime(runtime, ["sourceXml", "scrollCarousel", "tap", "scrollProfile", "back"]);
}

async function wait(runtime, milliseconds) {
  if (typeof runtime.sleep === "function") await runtime.sleep(milliseconds);
}

async function freshCarousel(runtime) {
  // UiAutomator2 can briefly project the outer Inbox while Tinder recycles the
  // compact horizontal child after a gesture.  A short source-only reread is
  // not a fallback target or a stale tap: it merely waits for the same
  // verified carousel to be observable again before any decision is made.
  for (let attempt = 0; attempt < MAX_TRANSIENT_CAROUSEL_READS; attempt += 1) {
    const carousel = observeMatchCarouselFromXml(await runtime.sourceXml());
    if (carousel) return carousel;
    if (attempt + 1 < MAX_TRANSIENT_CAROUSEL_READS) await wait(runtime, 150);
  }
  throw new Error("Tinder is not at a verified Inbox with a readable New-Matches carousel");
}

async function stableCarousel(runtime, initial, { settleMilliseconds }) {
  let current = initial;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await wait(runtime, settleMilliseconds);
    const fresh = await freshCarousel(runtime);
    if (sameLiveCarouselProjection(current, fresh)) return fresh;
    current = fresh;
  }
  throw new Error("Tinder New-Matches carousel did not reach a stable projection");
}

async function carouselAtLeadingEdge(runtime, { maxCarouselGestures, settleMilliseconds }) {
  let carousel = await stableCarousel(runtime, await freshCarousel(runtime), { settleMilliseconds });
  let noProgress = 0;
  for (let gesture = 0; gesture < maxCarouselGestures; gesture += 1) {
    const before = carousel;
    const canScrollMore = await runtime.scrollCarousel(before.scroll_bounds, "left");
    if (typeof canScrollMore !== "boolean") {
      throw new Error("Tinder Match carousel scroll did not report a physical boundary result");
    }
    await wait(runtime, settleMilliseconds);
    const fresh = await freshCarousel(runtime);
    if (!sameLiveCarouselProjection(before, fresh)) {
      carousel = await stableCarousel(runtime, fresh, { settleMilliseconds });
      noProgress = 0;
      continue;
    }
    if (canScrollMore) {
      noProgress += 1;
      if (noProgress < 3) continue;
      throw new Error("Tinder New-Matches carousel reported leading movement without a changed projection");
    }
    const confirmedAtEdge = await runtime.scrollCarousel(fresh.scroll_bounds, "left");
    if (typeof confirmedAtEdge !== "boolean") {
      throw new Error("Tinder Match carousel scroll did not report a physical boundary result");
    }
    await wait(runtime, settleMilliseconds);
    const confirmed = await freshCarousel(runtime);
    if (!sameLiveCarouselProjection(fresh, confirmed)) {
      carousel = await stableCarousel(runtime, confirmed, { settleMilliseconds });
      noProgress = 0;
      continue;
    }
    if (confirmedAtEdge) {
      throw new Error("Tinder New-Matches leading edge could not be confirmed");
    }
    return confirmed;
  }
  throw new Error("Tinder New-Matches leading edge was not reached within the approved bound");
}

/*
 * A complete current carousel inventory is read-only: the only input it
 * permits is horizontal scrolling inside the freshly projected carousel.
 */
export async function discoverFreshMatchCarousel(runtime, options = {}) {
  verifyCarouselRuntime(runtime);
  const maxCarouselGestures = boundedInteger(
    options.maxCarouselGestures,
    DEFAULT_MAX_CAROUSEL_GESTURES,
    { minimum: 1, maximum: 200, name: "maxCarouselGestures" }
  );
  const settleMilliseconds = boundedInteger(
    options.settleMilliseconds,
    DEFAULT_SETTLE_MILLISECONDS,
    { minimum: 0, maximum: 10_000, name: "settleMilliseconds" }
  );
  let carousel = await carouselAtLeadingEdge(runtime, { maxCarouselGestures, settleMilliseconds });
  const leadingProjection = carousel;
  let inventory = appendFreshInventory([], carousel);
  let noProgress = 0;

  for (let gesture = 0; gesture < maxCarouselGestures; gesture += 1) {
    const before = carousel;
    const canScrollMore = await runtime.scrollCarousel(before.scroll_bounds, "right");
    if (typeof canScrollMore !== "boolean") {
      throw new Error("Tinder Match carousel scroll did not report a physical boundary result");
    }
    await wait(runtime, settleMilliseconds);
    const fresh = await freshCarousel(runtime);
    if (!sameLiveCarouselProjection(before, fresh)) {
      const overlap = directLiveCarouselOverlap(before.tiles, fresh.tiles);
      if (overlap === null) {
        throw new Error("Tinder New-Matches carousel lost direct local continuity during fresh inventory");
      }
      inventory = appendFreshInventory(inventory, fresh, overlap);
      carousel = await stableCarousel(runtime, fresh, { settleMilliseconds });
      noProgress = 0;
      continue;
    }
    if (canScrollMore) {
      noProgress += 1;
      if (noProgress < 3) continue;
      throw new Error("Tinder New-Matches carousel reported movement without a changed projection");
    }
    const confirmedAtBoundary = await runtime.scrollCarousel(fresh.scroll_bounds, "right");
    if (typeof confirmedAtBoundary !== "boolean") {
      throw new Error("Tinder Match carousel scroll did not report a physical boundary result");
    }
    await wait(runtime, settleMilliseconds);
    const confirmed = await freshCarousel(runtime);
    if (!sameLiveCarouselProjection(fresh, confirmed)) {
      const overlap = directLiveCarouselOverlap(fresh.tiles, confirmed.tiles);
      if (overlap === null) {
        throw new Error("Tinder New-Matches carousel lost direct local continuity at its fresh-inventory boundary");
      }
      inventory = appendFreshInventory(inventory, confirmed, overlap);
      carousel = await stableCarousel(runtime, confirmed, { settleMilliseconds });
      noProgress = 0;
      continue;
    }
    if (confirmedAtBoundary) {
      throw new Error("Tinder New-Matches carousel end could not be confirmed");
    }
    return Object.freeze({
      inventory,
      leading_projection: leadingProjection,
      end_actually_reached: true
    });
  }
  throw new Error("The reachable Tinder New-Matches end was not verified within the approved bound");
}

async function locateCurrentTile(runtime, requestedTile, expectedLeadingProjection, {
  maxCarouselGestures,
  settleMilliseconds
}) {
  let carousel = await carouselAtLeadingEdge(runtime, { maxCarouselGestures, settleMilliseconds });
  // Returning physically to the leading edge must reconstruct the exact
  // fresh-inventory opening projection. Otherwise the carousel changed while
  // this runner was navigating and the caller must inventory again.
  if (!sameLiveCarouselProjection(expectedLeadingProjection, carousel)) {
    return Object.freeze({ status: "CAROUSEL_CHANGED" });
  }
  let noProgress = 0;
  for (let gesture = 0; gesture < maxCarouselGestures; gesture += 1) {
    const candidates = matchingTiles(carousel, requestedTile);
    if (candidates.length === 1) return Object.freeze({ status: "FOUND", carousel, candidate: candidates[0] });
    if (candidates.length > 1) return Object.freeze({ status: "CAROUSEL_CHANGED" });

    const before = carousel;
    const canScrollMore = await runtime.scrollCarousel(before.scroll_bounds, "right");
    if (typeof canScrollMore !== "boolean") {
      throw new Error("Tinder Match carousel scroll did not report a physical boundary result");
    }
    await wait(runtime, settleMilliseconds);
    const fresh = await freshCarousel(runtime);
    if (!sameLiveCarouselProjection(before, fresh)) {
      if (directLiveCarouselOverlap(before.tiles, fresh.tiles) === null) {
        return Object.freeze({ status: "CAROUSEL_CHANGED" });
      }
      carousel = await stableCarousel(runtime, fresh, { settleMilliseconds });
      noProgress = 0;
      continue;
    }
    if (canScrollMore) {
      noProgress += 1;
      if (noProgress < 3) continue;
      throw new Error("Tinder New-Matches carousel reported movement without a changed projection");
    }
    const confirmedAtBoundary = await runtime.scrollCarousel(fresh.scroll_bounds, "right");
    if (typeof confirmedAtBoundary !== "boolean") {
      throw new Error("Tinder Match carousel scroll did not report a physical boundary result");
    }
    await wait(runtime, settleMilliseconds);
    const confirmed = await freshCarousel(runtime);
    if (!sameLiveCarouselProjection(fresh, confirmed)) {
      if (directLiveCarouselOverlap(fresh.tiles, confirmed.tiles) === null) {
        return Object.freeze({ status: "CAROUSEL_CHANGED" });
      }
      carousel = await stableCarousel(runtime, confirmed, { settleMilliseconds });
      noProgress = 0;
      continue;
    }
    if (confirmedAtBoundary) {
      throw new Error("Tinder New-Matches carousel end could not be confirmed");
    }
    return Object.freeze({ status: "CAROUSEL_CHANGED" });
  }
  throw new Error("The requested Tinder Match tile was not reached within the approved bound");
}

function sameProfileProjection(left, right) {
  const leftProfile = left?.profile;
  const rightProfile = right?.profile;
  if (!sameBounds(left?.scroll_bounds, right?.scroll_bounds)
    || leftProfile?.display_name !== rightProfile?.display_name) return false;
  const leftAttributes = Object.entries(leftProfile?.attributes || {}).sort(([a], [b]) => a.localeCompare(b));
  const rightAttributes = Object.entries(rightProfile?.attributes || {}).sort(([a], [b]) => a.localeCompare(b));
  return leftAttributes.length === rightAttributes.length
    && leftAttributes.every(([key, value], index) => key === rightAttributes[index][0]
      && value === rightAttributes[index][1]);
}

async function profileProjection(runtime, expectedDisplayName, options) {
  const observation = observeProfileFromXml(await runtime.sourceXml(), { expectedDisplayName, ...options });
  return observation || null;
}

async function waitForInitialProfile(runtime, expectedDisplayName, { settleMilliseconds }) {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    await wait(runtime, settleMilliseconds);
    const observation = await profileProjection(runtime, expectedDisplayName, {});
    if (observation) return observation;
  }
  throw new Error("Tinder did not settle to a verified Match profile");
}

/*
 * Current Tinder versions can legitimately route a fresh Match tile to its
 * lightweight chat shell before showing the profile.  The shell is not a
 * substitute profile: only the one freshly observed compact header avatar is
 * allowed to continue the already continuous local navigation.  No stored
 * carousel ordinal, identifier, or previous target is reused here.
 */
async function enterLiveMatchProfile(runtime, expectedDisplayName, { settleMilliseconds }) {
  let openedConversationShell = false;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    await wait(runtime, settleMilliseconds);
    const source = await runtime.sourceXml();
    if (observeProfileFromXml(source, { expectedDisplayName })) {
      return Object.freeze({ opened_conversation_shell: openedConversationShell });
    }

    const headerTarget = observeConversationViewportFromXml(source)
      ? headerProfileTargetFromXml(source)
      : null;
    if (!headerTarget || openedConversationShell) continue;

    // A second source read immediately before the only header tap rejects a
    // changing shell instead of applying a coordinate from an old projection.
    const freshSource = await runtime.sourceXml();
    const freshTarget = observeConversationViewportFromXml(freshSource)
      ? headerProfileTargetFromXml(freshSource)
      : null;
    if (!sameBounds(headerTarget, freshTarget)) continue;
    await runtime.tap(freshTarget);
    openedConversationShell = true;
  }
  throw new Error("Tinder did not settle to a verified Match profile");
}

/*
 * Full profile reading uses the same verified vertical profile surface as the
 * existing initial sync. Every continued viewport must retain that one scroll
 * surface and is merged through the generic profile projector.
 */
export async function readCompleteLiveMatchProfile(runtime, expectedDisplayName, options = {}) {
  verifyProfileRuntime(runtime);
  const maxProfileGestures = boundedInteger(
    options.maxProfileGestures,
    DEFAULT_MAX_PROFILE_GESTURES,
    { minimum: 1, maximum: 120, name: "maxProfileGestures" }
  );
  const settleMilliseconds = boundedInteger(
    options.settleMilliseconds,
    DEFAULT_SETTLE_MILLISECONDS,
    { minimum: 0, maximum: 10_000, name: "settleMilliseconds" }
  );
  const boundarySettleMilliseconds = boundedInteger(
    options.boundarySettleMilliseconds,
    DEFAULT_BOUNDARY_SETTLE_MILLISECONDS,
    { minimum: 0, maximum: 10_000, name: "boundarySettleMilliseconds" }
  );
  const initial = await waitForInitialProfile(runtime, expectedDisplayName, { settleMilliseconds });
  let profile = initial.profile;
  let current = await profileProjection(runtime, expectedDisplayName, {
    continuedProfileScroll: true,
    expectedScrollBounds: initial.scroll_bounds
  });
  if (!current) throw new Error("Tinder Match profile changed before its scrollable surface was verified");
  profile = mergeProfileSnapshots(profile, current.profile);
  let noProgress = 0;

  for (let gesture = 0; gesture < maxProfileGestures; gesture += 1) {
    const before = current;
    const canScrollMore = await runtime.scrollProfile(before.scroll_bounds);
    if (typeof canScrollMore !== "boolean") {
      throw new Error("Tinder Match profile scroll did not report a physical boundary result");
    }
    await wait(runtime, settleMilliseconds);
    const fresh = await profileProjection(runtime, expectedDisplayName, {
      continuedProfileScroll: true,
      expectedScrollBounds: before.scroll_bounds
    });
    if (!fresh) throw new Error("Tinder Match profile changed while being read");
    profile = mergeProfileSnapshots(profile, fresh.profile);
    current = fresh;
    if (!sameProfileProjection(before, fresh)) {
      noProgress = 0;
      continue;
    }
    if (canScrollMore) {
      noProgress += 1;
      if (noProgress < 3) continue;
      throw new Error("The verified Tinder Match profile surface reported movement without a changed viewport");
    }

    await wait(runtime, boundarySettleMilliseconds);
    const settled = await profileProjection(runtime, expectedDisplayName, {
      continuedProfileScroll: true,
      expectedScrollBounds: current.scroll_bounds
    });
    if (!settled) throw new Error("Tinder Match profile changed while its boundary was being verified");
    profile = mergeProfileSnapshots(profile, settled.profile);
    current = settled;
    if (!sameProfileProjection(fresh, settled)) {
      noProgress = 0;
      continue;
    }

    const confirmedAtBoundary = await runtime.scrollProfile(current.scroll_bounds);
    if (typeof confirmedAtBoundary !== "boolean") {
      throw new Error("Tinder Match profile scroll did not report a physical boundary result");
    }
    await wait(runtime, settleMilliseconds);
    const confirmed = await profileProjection(runtime, expectedDisplayName, {
      continuedProfileScroll: true,
      expectedScrollBounds: current.scroll_bounds
    });
    if (!confirmed) throw new Error("Tinder Match profile changed while its boundary was being confirmed");
    profile = mergeProfileSnapshots(profile, confirmed.profile);
    current = confirmed;
    if (!sameProfileProjection(settled, confirmed)) {
      noProgress = 0;
      continue;
    }
    if (confirmedAtBoundary) {
      noProgress += 1;
      if (noProgress < 3) continue;
      throw new Error("The verified Tinder Match profile boundary reported movement without a changed viewport");
    }
    return profile;
  }
  throw new Error("The reachable Tinder Match profile boundary was not reached within the approved bound");
}

async function waitForCarouselAfterBack(runtime, { settleMilliseconds }) {
  for (let attempt = 0; attempt < 14; attempt += 1) {
    await wait(runtime, settleMilliseconds);
    const carousel = observeMatchCarouselFromXml(await runtime.sourceXml());
    if (carousel) return carousel;
  }
  throw new Error("Tinder did not return to a verified New-Matches carousel after Profile Back");
}

/*
 * Back is never repeated blindly.  A second Back is permitted only after the
 * first one has freshly settled to the verified Match conversation shell;
 * that is the expected local return path for current Tinder Match tiles.
 */
async function returnToCarouselAfterLiveProfile(runtime, { settleMilliseconds }) {
  await runtime.back();
  for (let attempt = 0; attempt < 14; attempt += 1) {
    await wait(runtime, settleMilliseconds);
    const source = await runtime.sourceXml();
    if (observeMatchCarouselFromXml(source)) return;
    if (!observeConversationViewportFromXml(source)) continue;
    await runtime.back();
    await waitForCarouselAfterBack(runtime, { settleMilliseconds });
    return;
  }
  throw new Error("Tinder did not return to a verified New-Matches carousel after Profile Back");
}

function noTapResult(status, {
  freshInventories,
  currentCarouselPosition = null
} = {}) {
  return Object.freeze({
    status,
    fresh_carousel_inventories: freshInventories,
    current_carousel_position: currentCarouselPosition,
    tap_performed: false,
    profile_read: false,
    returned_with_back: false
  });
}

/*
 * Main local Match -> live profile operation. `requestedMatch.carousel_position`
 * is deliberately not read: the freshly inventoried current position is only
 * returned as context, while every actual tap is selected from the immediate
 * pre-tap carousel projection.
 */
export async function runMatchToLiveProfile(runtime, requestedMatch, options = {}) {
  verifyLiveProfileRuntime(runtime);
  const requestedTile = requestedTileFrom(requestedMatch);
  const maxCarouselGestures = boundedInteger(
    options.maxCarouselGestures,
    DEFAULT_MAX_CAROUSEL_GESTURES,
    { minimum: 1, maximum: 200, name: "maxCarouselGestures" }
  );
  const maxProfileGestures = boundedInteger(
    options.maxProfileGestures,
    DEFAULT_MAX_PROFILE_GESTURES,
    { minimum: 1, maximum: 120, name: "maxProfileGestures" }
  );
  const maxReinventoryAttempts = boundedInteger(
    options.maxReinventoryAttempts,
    DEFAULT_REINVENTORY_ATTEMPTS,
    { minimum: 1, maximum: 4, name: "maxReinventoryAttempts" }
  );
  const settleMilliseconds = boundedInteger(
    options.settleMilliseconds,
    DEFAULT_SETTLE_MILLISECONDS,
    { minimum: 0, maximum: 10_000, name: "settleMilliseconds" }
  );
  const boundarySettleMilliseconds = boundedInteger(
    options.boundarySettleMilliseconds,
    DEFAULT_BOUNDARY_SETTLE_MILLISECONDS,
    { minimum: 0, maximum: 10_000, name: "boundarySettleMilliseconds" }
  );

  for (let attempt = 1; attempt <= maxReinventoryAttempts; attempt += 1) {
    const discovery = await discoverFreshMatchCarousel(runtime, { maxCarouselGestures, settleMilliseconds });
    const inventoryCandidates = discovery.inventory.filter((entry) => sameVisibleMatchTile(entry.tile, requestedTile));
    if (inventoryCandidates.length === 0) {
      return noTapResult("TARGET_NOT_PRESENT", { freshInventories: attempt });
    }
    if (inventoryCandidates.length > 1) {
      return noTapResult("TARGET_AMBIGUOUS", { freshInventories: attempt });
    }
    const currentCarouselPosition = inventoryCandidates[0].carousel_position;
    const located = await locateCurrentTile(runtime, requestedTile, discovery.leading_projection, {
      maxCarouselGestures,
      settleMilliseconds
    });
    if (located.status !== "FOUND") continue;

    // Read a new UI projection immediately before clicking. Any source change
    // (including a changed tile position) restarts at fresh inventory rather
    // than reusing a stale coordinate or an old carousel ordinal.
    const preTapCarousel = await freshCarousel(runtime);
    if (!sameLiveCarouselProjection(located.carousel, preTapCarousel)) continue;
    const preTapCandidates = matchingTiles(preTapCarousel, requestedTile);
    if (preTapCandidates.length !== 1) continue;
    const preTapTarget = preTapCandidates[0].observed;
    if (!preTapTarget?.tap_bounds) {
      return noTapResult("TARGET_NOT_ACTIONABLE", {
        freshInventories: attempt,
        currentCarouselPosition
      });
    }

    await runtime.tap(preTapTarget.tap_bounds);
    let profile;
    try {
      await enterLiveMatchProfile(runtime, requestedTile.display_name, { settleMilliseconds });
      profile = await readCompleteLiveMatchProfile(runtime, requestedTile.display_name, {
        maxProfileGestures,
        settleMilliseconds,
        boundarySettleMilliseconds
      });
    } finally {
      await returnToCarouselAfterLiveProfile(runtime, { settleMilliseconds });
    }
    return Object.freeze({
      status: "PROFILE_READ",
      fresh_carousel_inventories: attempt,
      current_carousel_position: currentCarouselPosition,
      tap_performed: true,
      profile_read: true,
      returned_with_back: true,
      profile
    });
  }
  return noTapResult("CAROUSEL_CHANGED", { freshInventories: maxReinventoryAttempts });
}
