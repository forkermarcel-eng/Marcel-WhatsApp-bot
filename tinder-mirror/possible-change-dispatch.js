import {
  observeInboxFromXml,
  observeMatchCarouselFromXml
} from "./appium-conversation-reader.js";

/* ==================================================
TINDER POSSIBLE CHANGE — LOCAL SOURCE DISCOVERY

This module deliberately has no transport, database, control, or product
write dependency.  A content-free device hint only coalesces one local XML
observation.  The official Tinder screen remains the source of truth.

The comparison keys below are transient UI projections held in RAM for one
dispatcher instance.  They are not Tinder identifiers, fingerprints, capture
records, or persisted skip state.
================================================== */

function transientTextSequence(ramKey) {
  try {
    const value = JSON.parse(ramKey);
    if (!Array.isArray(value?.texts)) return null;
    return JSON.stringify(value.texts);
  } catch {
    return null;
  }
}

function inboxProjection(inbox) {
  if (!inbox) return null;
  const rows = inbox.rows.map((row) => transientTextSequence(row.ram_key));
  if (rows.some((row) => row === null)) return null;
  return Object.freeze(rows);
}

function carouselProjection(carousel) {
  if (!carousel) return null;
  const tiles = carousel.tiles.map((tile) => transientTextSequence(tile.ram_key));
  if (tiles.some((tile) => tile === null)) return null;
  return Object.freeze(tiles);
}

function sameProjection(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function sourceDiscoveryFromXml(xml) {
  if (typeof xml !== "string" || xml.length < 1) return null;
  const inbox = observeInboxFromXml(xml);
  const carousel = observeMatchCarouselFromXml(xml);
  const inboxRows = inboxProjection(inbox);
  const matchTiles = carouselProjection(carousel);
  if (!inboxRows && !matchTiles) return null;
  return Object.freeze({ inboxRows, matchTiles });
}

function result({ status, inboxChanged = false, matchesChanged = false }) {
  return Object.freeze({
    status,
    inbox_changed: inboxChanged,
    matches_changed: matchesChanged,
    // Discovery cannot open a thread, profile, or history.  A later explicit
    // product runner decides what a verified source delta means.
    thread_opens: 0,
    profile_reads: 0,
    history_reads: 0
  });
}

/**
 * Build the local, best-effort half of the change path. `readSourceXml` is
 * supplied by the Appium host; it is intentionally not invoked on an Android
 * notification thread or by the backend request handler.
 */
function createTinderPossibleChangeDispatcher({
  readSourceXml,
  onDiscovery = null,
  debounceMilliseconds = 1500,
  setTimeoutFn = setTimeout
} = {}) {
  if (typeof readSourceXml !== "function") throw new TypeError("readSourceXml is required");
  if (onDiscovery !== null && typeof onDiscovery !== "function") throw new TypeError("onDiscovery must be a function or null");
  if (!Number.isInteger(debounceMilliseconds) || debounceMilliseconds < 0 || debounceMilliseconds > 30_000) {
    throw new TypeError("debounceMilliseconds must be between 0 and 30000");
  }

  let baseline = null;
  let timer = null;
  let pending = null;

  async function inspect() {
    let current;
    try {
      current = sourceDiscoveryFromXml(await readSourceXml());
    } catch {
      return result({ status: "SOURCE_UNAVAILABLE" });
    }
    if (!current) return result({ status: "SOURCE_UNAVAILABLE" });
    if (!baseline) {
      baseline = current;
      return result({ status: "BASELINE_RECORDED" });
    }
    const observed = result({
      status: "DISCOVERED",
      inboxChanged: !sameProjection(baseline.inboxRows, current.inboxRows),
      matchesChanged: !sameProjection(baseline.matchTiles, current.matchTiles)
    });
    baseline = current;
    if (onDiscovery) await onDiscovery(observed);
    return observed;
  }

  function signal() {
    if (pending) return pending;
    pending = new Promise((resolve) => {
      timer = setTimeoutFn(async () => {
        timer = null;
        try {
          resolve(await inspect());
        } finally {
          pending = null;
        }
      }, debounceMilliseconds);
    });
    return pending;
  }

  return Object.freeze({ inspect, signal });
}

export {
  createTinderPossibleChangeDispatcher,
  sourceDiscoveryFromXml
};
