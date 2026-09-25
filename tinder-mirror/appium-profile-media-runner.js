import { observeProfileFromXml } from "./appium-conversation-reader.js";

/*
 * This is deliberately an explicit local media-read operation.  It has no
 * device transport, persistence repository, identity lookup, or background
 * scheduling.  A caller that has already navigated to a Tinder profile gives
 * us its current Appium source, screen bytes, and the one bounded horizontal
 * pager gesture.  The only durable work is delegated to the supplied shared
 * media ingestor.
 */

const DEFAULT_MAX_PAGER_GESTURES = 32;
const DEFAULT_SETTLE_MILLISECONDS = 350;
const DEFAULT_BOUNDARY_SETTLE_MILLISECONDS = 700;

function boundedInteger(value, fallback, { minimum, maximum, name }) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return candidate;
}

function profileReference(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("profileReference is required");
  }
  return value.trim();
}

function verifyRuntime(runtime) {
  for (const method of ["sourceXml", "captureScreen", "swipePager"]) {
    if (typeof runtime?.[method] !== "function") {
      throw new TypeError(`runtime.${method} is required`);
    }
  }
}

function verifyIngestor(ingestor) {
  for (const method of ["ingestVerifiedScreenRegion", "recordUnavailable"]) {
    if (typeof ingestor?.[method] !== "function") {
      throw new TypeError(`mediaIngestor.${method} is required`);
    }
  }
}

function usableScreenBytes(value) {
  if (Buffer.isBuffer(value) && value.length > 0) return value;
  if (value instanceof Uint8Array && value.byteLength > 0) return value;
  return null;
}

async function wait(runtime, milliseconds) {
  if (typeof runtime.sleep === "function") await runtime.sleep(milliseconds);
}

async function freshProfileObservation(runtime, expectedDisplayName) {
  const source = await runtime.sourceXml();
  const observation = observeProfileFromXml(source, { expectedDisplayName });
  return observation?.media_bounds ? observation : null;
}

async function captureScreenBytes(runtime) {
  try {
    return usableScreenBytes(await runtime.captureScreen());
  } catch {
    return null;
  }
}

function compactResult({
  status,
  capturedPages = 0,
  unavailablePages = 0,
  pagerGestures = 0,
  endActuallyReached = false
}) {
  return Object.freeze({
    status,
    captured_pages: capturedPages,
    unavailable_pages: unavailablePages,
    pager_gestures: pagerGestures,
    end_actually_reached: endActuallyReached
  });
}

async function recordUnavailable(ingestor, reference, position, reason) {
  await ingestor.recordUnavailable({
    profileReference: reference,
    position,
    reason,
    // Kept intentionally content-free.  This is not an observation export.
    metadata: { source: "tinder_profile_media" }
  });
}

async function ingestVerifiedPage(ingestor, reference, screenBytes, observation, position) {
  await ingestor.ingestVerifiedScreenRegion({
    profileReference: reference,
    screenBytes,
    verifiedMediaBounds: observation.media_bounds,
    // This is a per-call local proof that bounds and screen were observed in
    // the same cycle. It is neither a thread/profile identifier nor stored by
    // the Tinder media adapter.
    observationReference: `fresh-profile-media-page-${position}`,
    position,
    metadata: { source: "tinder_profile_media" }
  });
}

/*
 * Reads only the current profile's verified media pager.  It captures the
 * visible initial page and then follows physical pager movement.  A false
 * movement result is confirmed once on the same fresh pager before declaring
 * the reachable end.  No screen/text/image data is returned to callers.
 */
export async function readVerifiedTinderProfileMedia(runtime, {
  profileReference: suppliedProfileReference,
  expectedDisplayName,
  mediaIngestor,
  maxPagerGestures = DEFAULT_MAX_PAGER_GESTURES,
  settleMilliseconds = DEFAULT_SETTLE_MILLISECONDS,
  boundarySettleMilliseconds = DEFAULT_BOUNDARY_SETTLE_MILLISECONDS
} = {}) {
  verifyRuntime(runtime);
  verifyIngestor(mediaIngestor);
  const reference = profileReference(suppliedProfileReference);
  const maximumGestures = boundedInteger(maxPagerGestures, DEFAULT_MAX_PAGER_GESTURES, {
    minimum: 1,
    maximum: 120,
    name: "maxPagerGestures"
  });
  const settle = boundedInteger(settleMilliseconds, DEFAULT_SETTLE_MILLISECONDS, {
    minimum: 0,
    maximum: 10_000,
    name: "settleMilliseconds"
  });
  const boundarySettle = boundedInteger(boundarySettleMilliseconds, DEFAULT_BOUNDARY_SETTLE_MILLISECONDS, {
    minimum: 0,
    maximum: 10_000,
    name: "boundarySettleMilliseconds"
  });

  let observation = await freshProfileObservation(runtime, expectedDisplayName);
  if (!observation) return compactResult({ status: "PROFILE_NOT_VERIFIED" });

  let position = 0;
  let gestures = 0;
  let screenBytes = await captureScreenBytes(runtime);
  if (!screenBytes) {
    await recordUnavailable(mediaIngestor, reference, position, "SCREENSHOT_UNAVAILABLE");
    return compactResult({ status: "MEDIA_UNAVAILABLE", unavailablePages: 1 });
  }
  await ingestVerifiedPage(mediaIngestor, reference, screenBytes, observation, position);
  let capturedPages = 1;

  for (let gesture = 0; gesture < maximumGestures; gesture += 1) {
    const canAdvance = await runtime.swipePager(observation.media_bounds, "left");
    gestures += 1;
    if (typeof canAdvance !== "boolean") {
      throw new Error("Tinder profile media pager did not report a physical boundary result");
    }

    if (!canAdvance) {
      // A single false result is not enough to distinguish a momentarily
      // unavailable pager from its physical end. Re-observe first, then make
      // exactly one boundary confirmation in the same verified surface.
      await wait(runtime, boundarySettle);
      observation = await freshProfileObservation(runtime, expectedDisplayName);
      if (!observation) return compactResult({
        status: "PROFILE_CHANGED",
        capturedPages,
        pagerGestures: gestures
      });
      const confirmedAtBoundary = await runtime.swipePager(observation.media_bounds, "left");
      gestures += 1;
      if (typeof confirmedAtBoundary !== "boolean") {
        throw new Error("Tinder profile media pager did not report a physical boundary result");
      }
      if (!confirmedAtBoundary) {
        return compactResult({
          status: "MEDIA_READ",
          capturedPages,
          pagerGestures: gestures,
          endActuallyReached: true
        });
      }
      await wait(runtime, settle);
      observation = await freshProfileObservation(runtime, expectedDisplayName);
      if (!observation) return compactResult({
        status: "PROFILE_CHANGED",
        capturedPages,
        pagerGestures: gestures
      });
      screenBytes = await captureScreenBytes(runtime);
      if (!screenBytes) {
        await recordUnavailable(mediaIngestor, reference, position + 1, "SCREENSHOT_UNAVAILABLE");
        return compactResult({
          status: "MEDIA_UNAVAILABLE",
          capturedPages,
          unavailablePages: 1,
          pagerGestures: gestures
        });
      }
      position += 1;
      await ingestVerifiedPage(mediaIngestor, reference, screenBytes, observation, position);
      capturedPages += 1;
      continue;
    }

    await wait(runtime, settle);
    observation = await freshProfileObservation(runtime, expectedDisplayName);
    if (!observation) return compactResult({
      status: "PROFILE_CHANGED",
      capturedPages,
      pagerGestures: gestures
    });
    screenBytes = await captureScreenBytes(runtime);
    if (!screenBytes) {
      await recordUnavailable(mediaIngestor, reference, position + 1, "SCREENSHOT_UNAVAILABLE");
      return compactResult({
        status: "MEDIA_UNAVAILABLE",
        capturedPages,
        unavailablePages: 1,
        pagerGestures: gestures
      });
    }
    position += 1;
    await ingestVerifiedPage(mediaIngestor, reference, screenBytes, observation, position);
    capturedPages += 1;
  }

  return compactResult({
    status: "PAGER_BOUND_NOT_REACHED",
    capturedPages,
    pagerGestures: gestures
  });
}
