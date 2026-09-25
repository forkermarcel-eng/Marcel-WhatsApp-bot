import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readVerifiedTinderProfileMedia } from "../tinder-mirror/appium-profile-media-runner.js";

function profileXml() {
  return `
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,780]">
            <androidx.viewpager.widget.ViewPager bounds="[0,160][576,600]" />
            <android.widget.TextView text="Visible profile, 29" bounds="[36,510][420,556]" />
            <android.widget.TextView heading="true" text="Visible section" bounds="[36,620][360,660]" />
            <android.widget.TextView text="Visible value" bounds="[36,670][500,716]" />
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`;
}

function nonProfileXml() {
  return `<hierarchy rotation="0"><android.widget.FrameLayout bounds="[0,0][576,1280]" /></hierarchy>`;
}

function recordingIngestor() {
  const calls = { image: [], unavailable: [] };
  return {
    calls,
    async ingestVerifiedScreenRegion(value) { calls.image.push(value); },
    async recordUnavailable(value) { calls.unavailable.push(value); }
  };
}

test("verified profile media runner captures the initial page and each physically advanced pager page", async () => {
  const ingestor = recordingIngestor();
  let page = 0;
  const pagerCalls = [];
  const result = await readVerifiedTinderProfileMedia({
    async sourceXml() { return profileXml(); },
    async captureScreen() { return Buffer.from([page + 1]); },
    async swipePager(bounds, direction) {
      pagerCalls.push({ bounds, direction });
      if (page >= 2) return false;
      page += 1;
      return true;
    }
  }, {
    profileReference: "profile:opaque",
    expectedDisplayName: "Visible profile",
    mediaIngestor: ingestor,
    maxPagerGestures: 8,
    settleMilliseconds: 0,
    boundarySettleMilliseconds: 0
  });

  assert.deepEqual(result, {
    status: "MEDIA_READ",
    captured_pages: 3,
    unavailable_pages: 0,
    pager_gestures: 4,
    end_actually_reached: true
  });
  assert.deepEqual(ingestor.calls.image.map((entry) => entry.position), [0, 1, 2]);
  assert.equal(ingestor.calls.unavailable.length, 0);
  assert.equal(pagerCalls.length, 4);
  assert.ok(pagerCalls.every((entry) => entry.direction === "left"));
  assert.ok(pagerCalls.every((entry) => entry.bounds.width === 576 && entry.bounds.height === 440));
});

test("unavailable screen bytes create one explicit unavailable shared-media asset without pager input", async () => {
  const ingestor = recordingIngestor();
  let pagerCalls = 0;
  const result = await readVerifiedTinderProfileMedia({
    async sourceXml() { return profileXml(); },
    async captureScreen() { return null; },
    async swipePager() { pagerCalls += 1; return false; }
  }, {
    profileReference: "profile:opaque",
    expectedDisplayName: "Visible profile",
    mediaIngestor: ingestor,
    settleMilliseconds: 0,
    boundarySettleMilliseconds: 0
  });

  assert.deepEqual(result, {
    status: "MEDIA_UNAVAILABLE",
    captured_pages: 0,
    unavailable_pages: 1,
    pager_gestures: 0,
    end_actually_reached: false
  });
  assert.equal(ingestor.calls.image.length, 0);
  assert.equal(ingestor.calls.unavailable.length, 1);
  assert.equal(ingestor.calls.unavailable[0].reason, "SCREENSHOT_UNAVAILABLE");
  assert.equal(pagerCalls, 0);
});

test("an unverified surface makes no capture, ingest, or pager action", async () => {
  const ingestor = recordingIngestor();
  let captures = 0;
  let pagerCalls = 0;
  const result = await readVerifiedTinderProfileMedia({
    async sourceXml() { return nonProfileXml(); },
    async captureScreen() { captures += 1; return Buffer.from([1]); },
    async swipePager() { pagerCalls += 1; return false; }
  }, {
    profileReference: "profile:opaque",
    expectedDisplayName: "Visible profile",
    mediaIngestor: ingestor,
    settleMilliseconds: 0,
    boundarySettleMilliseconds: 0
  });

  assert.deepEqual(result, {
    status: "PROFILE_NOT_VERIFIED",
    captured_pages: 0,
    unavailable_pages: 0,
    pager_gestures: 0,
    end_actually_reached: false
  });
  assert.equal(captures, 0);
  assert.equal(pagerCalls, 0);
  assert.equal(ingestor.calls.image.length, 0);
  assert.equal(ingestor.calls.unavailable.length, 0);
});

test("a pager physical boundary is confirmed before the run reports the reachable end", async () => {
  const ingestor = recordingIngestor();
  let pagerCalls = 0;
  const result = await readVerifiedTinderProfileMedia({
    async sourceXml() { return profileXml(); },
    async captureScreen() { return Buffer.from([1]); },
    async swipePager() { pagerCalls += 1; return false; }
  }, {
    profileReference: "profile:opaque",
    expectedDisplayName: "Visible profile",
    mediaIngestor: ingestor,
    settleMilliseconds: 0,
    boundarySettleMilliseconds: 0
  });

  assert.equal(result.status, "MEDIA_READ");
  assert.equal(result.captured_pages, 1);
  assert.equal(result.pager_gestures, 2);
  assert.equal(result.end_actually_reached, true);
  assert.equal(pagerCalls, 2);
});

test("the local media pager runner has no device bridge, persistence, identity, or control side channel", () => {
  const source = readFileSync(new URL("../tinder-mirror/appium-profile-media-runner.js", import.meta.url), "utf8");
  assert.match(source, /observeProfileFromXml/);
  assert.match(source, /ingestVerifiedScreenRegion/);
  assert.match(source, /recordUnavailable/);
  assert.doesNotMatch(source, /(?:createTinderAppiumAdapter|fetch|executeScript|takeScreenshot|driver)\s*\(/i);
  assert.doesNotMatch(source, /^\s*import\s+.*(?:repository|device-bridge|heartbeat|permit|receipt|attestation|fingerprint)/im);
});
