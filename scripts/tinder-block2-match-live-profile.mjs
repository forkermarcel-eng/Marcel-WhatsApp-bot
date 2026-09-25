/*
 * Explicit local Match -> live profile command.
 *
 * The requested visible Match tile is supplied by the caller as JSON. The
 * runner owns only fresh UI read/revalidation, one tap, profile reading, and
 * Back.
 */

import { pathToFileURL } from "node:url";
import { runMatchToLiveProfile } from "../tinder-mirror/appium-match-live-profile-runner.js";

const DEFAULT_APPIUM_BASE_URL = "http://127.0.0.1:4723/wd/hub";

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

function runtimeConfiguration(environment = process.env) {
  const sessionId = valueString(environment.APPIUM_SESSION);
  const requestedMatchJson = valueString(environment.TINDER_MATCH_REQUEST_JSON);
  if (!sessionId) throw new Error("APPIUM_SESSION is required");
  if (!requestedMatchJson) throw new Error("TINDER_MATCH_REQUEST_JSON is required");
  let requestedMatch;
  try {
    requestedMatch = JSON.parse(requestedMatchJson);
  } catch {
    throw new Error("TINDER_MATCH_REQUEST_JSON must be JSON");
  }
  return Object.freeze({
    appiumBaseUrl: valueString(environment.APPIUM_BASE_URL || DEFAULT_APPIUM_BASE_URL).replace(/\/+$/, ""),
    sessionId,
    requestedMatch,
    maxCarouselGestures: boundedInteger(environment.TINDER_MATCH_LIVE_MAX_CAROUSEL_GESTURES, {
      name: "TINDER_MATCH_LIVE_MAX_CAROUSEL_GESTURES",
      fallback: "80",
      minimum: 1,
      maximum: 200
    }),
    maxProfileGestures: boundedInteger(environment.TINDER_MATCH_LIVE_MAX_PROFILE_GESTURES, {
      name: "TINDER_MATCH_LIVE_MAX_PROFILE_GESTURES",
      fallback: "80",
      minimum: 1,
      maximum: 120
    })
  });
}

function createRuntime(config, fetchImpl = fetch) {
  async function appium(path, { method = "GET", body } = {}) {
    const response = await fetchImpl(`${config.appiumBaseUrl}/session/${encodeURIComponent(config.sessionId)}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || result?.value?.error) throw new Error("Appium Match live-profile operation failed");
    return result?.value;
  }

  async function sourceXml() {
    const source = await appium("/source");
    if (typeof source !== "string" || source.length < 100) {
      throw new Error("Appium Match live-profile source projection is unavailable");
    }
    return source;
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
          percent: 0.25
        }]
      }
    });
    if (typeof result !== "boolean") throw new Error("Appium Match carousel scroll did not report a boundary result");
    return result;
  }

  async function scrollProfile(bounds) {
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
          direction: "down",
          percent: 0.62
        }]
      }
    });
    if (typeof result !== "boolean") throw new Error("Appium Match profile scroll did not report a boundary result");
    return result;
  }

  return Object.freeze({
    sourceXml,
    tap,
    scrollCarousel,
    scrollProfile,
    back: () => appium("/back", { method: "POST" }),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  });
}

export async function main(environment = process.env, { fetchImpl = fetch, write = console.log } = {}) {
  const config = runtimeConfiguration(environment);
  const result = await runMatchToLiveProfile(createRuntime(config, fetchImpl), config.requestedMatch, {
    maxCarouselGestures: config.maxCarouselGestures,
    maxProfileGestures: config.maxProfileGestures
  });
  write(JSON.stringify(result));
  return result;
}

const invokedAsScript = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedAsScript) await main();
