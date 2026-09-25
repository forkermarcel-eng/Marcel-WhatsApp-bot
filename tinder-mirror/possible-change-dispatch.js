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
  // An absent projection is a stable observation when it remains absent.
  // In particular, a transient lack of an Inbox surface must not turn every
  // following content-free hint into a synthetic source change.
  if (left === null && right === null) return true;
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((entry, index) => entry === right[index]);
}

function sourceDiscoveryFromXml(xml) {
  // UiAutomator2's regular source export has a hierarchy root. A syntactically
  // usable screen with no verified Inbox/Carousel is still a valid *absent*
  // projection and must be compared as such; malformed/non-UiAutomator input
  // remains unavailable.
  if (typeof xml !== "string" || !/<hierarchy\b/u.test(xml)) return null;
  const inbox = observeInboxFromXml(xml);
  const carousel = observeMatchCarouselFromXml(xml);
  const inboxRows = inboxProjection(inbox);
  const matchTiles = carouselProjection(carousel);
  return Object.freeze({ inboxRows, matchTiles });
}

function emptyActionMetrics() {
  return {
    threadOpens: 0,
    profileReads: 0,
    historyReads: 0,
    matchTileOpens: 0,
    matchUpdates: 0
  };
}

function result({
  status,
  inboxChanged = false,
  matchesChanged = false,
  actionMetrics = emptyActionMetrics()
}) {
  return Object.freeze({
    status,
    inbox_changed: inboxChanged,
    matches_changed: matchesChanged,
    // These counters reflect only a local, injected product action that
    // explicitly returned true. They are never durable state and never make
    // source discovery a control gate.
    thread_opens: actionMetrics.threadOpens,
    profile_reads: actionMetrics.profileReads,
    history_reads: actionMetrics.historyReads,
    match_tile_opens: actionMetrics.matchTileOpens,
    match_updates: actionMetrics.matchUpdates
  });
}

/*
 * Compare only two adjacent RAM snapshots of the same, stationary source
 * surface. The result is intentionally an action *candidate*, not a Tinder
 * identity: no value below is persisted, sent to the backend, or reused
 * after this dispatcher instance ends.
 *
 * We allow exactly one replacement or one ordered insertion. Those shapes
 * are only RAM-only source candidates: source discovery does not claim that
 * a row is known or new, and it does not identify a Tinder thread. A local
 * processor must revalidate the visible target and decide its own product
 * outcome. Reordering, removal, a missing surface, and multiple changes are
 * deliberately ambiguous and therefore produce no action.
 */
function singleSequenceDelta(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current) || sameProjection(previous, current)) return null;

  if (previous.length === current.length) {
    const differences = [];
    for (let index = 0; index < previous.length; index += 1) {
      if (previous[index] !== current[index]) differences.push(index);
      if (differences.length > 1) return null;
    }
    if (differences.length !== 1) return null;
    return Object.freeze({
      kind: "SOURCE_ROW_REVALIDATION_REQUIRED",
      source_change: "SINGLE_REPLACEMENT",
      previous_index: differences[0],
      current_index: differences[0]
    });
  }

  if (current.length !== previous.length + 1) return null;
  const insertionIndexes = [];
  for (let candidate = 0; candidate < current.length; candidate += 1) {
    let matches = true;
    for (let index = 0; index < previous.length; index += 1) {
      const currentIndex = index < candidate ? index : index + 1;
      if (previous[index] !== current[currentIndex]) {
        matches = false;
        break;
      }
    }
    if (matches) insertionIndexes.push(candidate);
    if (insertionIndexes.length > 1) return null;
  }
  if (insertionIndexes.length !== 1) return null;
  return Object.freeze({
    kind: "SOURCE_ROW_REVALIDATION_REQUIRED",
    source_change: "SINGLE_INSERTION",
    previous_index: null,
    current_index: insertionIndexes[0]
  });
}

function actionCandidate(source, previous, current) {
  const delta = singleSequenceDelta(previous, current);
  if (!delta) return null;
  if (source === "MATCHES") {
    return Object.freeze({
      source,
      kind: "SOURCE_TILE_REVALIDATION_REQUIRED",
      source_change: delta.source_change,
      previous_index: delta.previous_index,
      current_index: delta.current_index
    });
  }
  return Object.freeze({ source, ...delta });
}

function validateOptionalCallback(value, name) {
  if (value !== null && typeof value !== "function") throw new TypeError(`${name} must be a function or null`);
}

/*
 * Callers are deliberately injected by the local Appium host. A source
 * candidate never selects a Tinder target; its processor must revalidate
 * that target and return one of the outcomes below. `false`, an invalid
 * outcome, or an exception leaves the prior source baseline intact so a
 * later independent hint can retry it. There is deliberately no retry queue
 * or automatic retry. Explicit AMBIGUOUS/UNCHANGED outcomes are safe
 * no-actions and advance the baseline.
 */
async function invokeCandidate(candidate, {
  onInboxSourceCandidate,
  onMatchSourceCandidate
}) {
  if (!candidate) {
    return {
      actionMetrics: emptyActionMetrics(),
      retryRequired: false,
      advanceBaseline: true
    };
  }

  const callback = candidate.source === "INBOX"
    ? onInboxSourceCandidate
    : onMatchSourceCandidate;
  // A source-only deployment and an ambiguous source candidate have no
  // action to retry. Keep progressing its transient baseline.
  if (!callback) {
    return {
      actionMetrics: emptyActionMetrics(),
      retryRequired: false,
      advanceBaseline: true
    };
  }

  try {
    const outcome = await callback(candidate);
    if (candidate.source === "INBOX") {
      if (outcome === "KNOWN_CHANGED") {
        return {
          actionMetrics: { ...emptyActionMetrics(), threadOpens: 1 },
          retryRequired: false,
          advanceBaseline: true
        };
      }
      if (outcome === "NEW_THREAD") {
        return {
          actionMetrics: {
            ...emptyActionMetrics(),
            threadOpens: 1,
            profileReads: 1,
            historyReads: 1
          },
          retryRequired: false,
          advanceBaseline: true
        };
      }
    } else if (outcome === "MATCH_UPDATED") {
      // Match discovery never opens a tile. It may update only existing
      // product Match data/position in the injected local runner.
      return {
        actionMetrics: { ...emptyActionMetrics(), matchUpdates: 1 },
        retryRequired: false,
        advanceBaseline: true
      };
    }

    if (outcome === "AMBIGUOUS" || outcome === "UNCHANGED") {
      return {
        actionMetrics: emptyActionMetrics(),
        retryRequired: false,
        advanceBaseline: true
      };
    }
    return {
      actionMetrics: emptyActionMetrics(),
      retryRequired: true,
      advanceBaseline: false
    };
  } catch {
    return {
      actionMetrics: emptyActionMetrics(),
      retryRequired: true,
      advanceBaseline: false
    };
  }
}

/**
 * Build the local, best-effort half of the change path. `readSourceXml` is
 * supplied by the Appium host; it is intentionally not invoked on an Android
 * notification thread or by the backend request handler.
 */
function createTinderPossibleChangeDispatcher({
  readSourceXml,
  onDiscovery = null,
  onInboxSourceCandidate = null,
  onMatchSourceCandidate = null,
  debounceMilliseconds = 1500,
  setTimeoutFn = setTimeout
} = {}) {
  if (typeof readSourceXml !== "function") throw new TypeError("readSourceXml is required");
  validateOptionalCallback(onDiscovery, "onDiscovery");
  validateOptionalCallback(onInboxSourceCandidate, "onInboxSourceCandidate");
  validateOptionalCallback(onMatchSourceCandidate, "onMatchSourceCandidate");
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
    const previous = baseline;
    const inboxChanged = !sameProjection(previous.inboxRows, current.inboxRows);
    const matchesChanged = !sameProjection(previous.matchTiles, current.matchTiles);
    const inboxCandidate = inboxChanged
      ? actionCandidate("INBOX", previous.inboxRows, current.inboxRows)
      : null;
    const matchCandidate = matchesChanged
      ? actionCandidate("MATCHES", previous.matchTiles, current.matchTiles)
      : null;
    const inboxAction = await invokeCandidate(inboxCandidate, {
      onInboxSourceCandidate,
      onMatchSourceCandidate
    });
    const matchAction = await invokeCandidate(matchCandidate, {
      onInboxSourceCandidate,
      onMatchSourceCandidate
    });
    // Preserve only the source baseline whose explicitly injected processor
    // could not complete. The next *separate* hint can therefore revalidate
    // the same transient candidate; this module never schedules that retry.
    baseline = Object.freeze({
      inboxRows: inboxAction.advanceBaseline ? current.inboxRows : previous.inboxRows,
      matchTiles: matchAction.advanceBaseline ? current.matchTiles : previous.matchTiles
    });
    const actionMetrics = {
      threadOpens: inboxAction.actionMetrics.threadOpens + matchAction.actionMetrics.threadOpens,
      profileReads: inboxAction.actionMetrics.profileReads + matchAction.actionMetrics.profileReads,
      historyReads: inboxAction.actionMetrics.historyReads + matchAction.actionMetrics.historyReads,
      matchTileOpens: inboxAction.actionMetrics.matchTileOpens + matchAction.actionMetrics.matchTileOpens,
      matchUpdates: inboxAction.actionMetrics.matchUpdates + matchAction.actionMetrics.matchUpdates
    };
    const observed = result({
      status: inboxAction.retryRequired || matchAction.retryRequired
        ? "ACTION_RETRY_REQUIRED"
        : "DISCOVERED",
      inboxChanged,
      matchesChanged,
      actionMetrics
    });
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
  sameProjection,
  sourceDiscoveryFromXml
};
