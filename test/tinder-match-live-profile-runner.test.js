import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  discoverFreshMatchCarousel,
  directLiveCarouselOverlap,
  readCompleteLiveMatchProfile,
  runMatchToLiveProfile,
  sameLiveCarouselProjection,
  sameVisibleMatchTile
} from "../tinder-mirror/appium-match-live-profile-runner.js";

function requestedTile(displayName) {
  return Object.freeze({ display_name: displayName, attributes: Object.freeze({}), media_refs: Object.freeze([]) });
}

function matchTileXml(name, left) {
  const right = left + 106;
  return `
    <android.widget.FrameLayout bounds="[${left},300][${right},488]">
      <android.widget.ImageView clickable="true" bounds="[${left + 4},304][${right - 4},402]" />
      <android.widget.TextView text="${name}" bounds="[${left + 4},416][${right - 4},472]" />
    </android.widget.FrameLayout>`;
}

function carouselXml(names) {
  return `
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.recyclerview.widget.RecyclerView bounds="[0,225][576,1122]">
          <android.widget.FrameLayout bounds="[0,289][576,509]">
            <androidx.recyclerview.widget.RecyclerView bounds="[0,289][576,509]">
              ${names.map((name, index) => matchTileXml(name, 118 * index)).join("\n")}
            </androidx.recyclerview.widget.RecyclerView>
          </android.widget.FrameLayout>
          <android.widget.FrameLayout bounds="[0,618][576,726]">
            <android.view.View clickable="true" bounds="[0,618][576,726]" />
            <android.widget.TextView text="Ordinary Inbox preview" bounds="[80,640][500,700]" />
          </android.widget.FrameLayout>
        </androidx.recyclerview.widget.RecyclerView>
      </android.widget.FrameLayout>
    </hierarchy>`;
}

function profileXml(name) {
  return `
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,780]">
            <androidx.viewpager.widget.ViewPager bounds="[0,160][576,600]" />
            <android.widget.TextView text="${name}, 29" bounds="[36,510][360,556]" />
            <android.widget.TextView heading="true" text="Visible context" bounds="[36,620][360,660]" />
            <android.widget.TextView text="Visible value" bounds="[36,670][500,716]" />
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`;
}

function profileViewportXml(name, text, { opening = false } = {}) {
  return `
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,780]">
            ${opening ? `<androidx.viewpager.widget.ViewPager bounds="[0,160][576,600]" />
            <android.widget.TextView text="${name}, 29" bounds="[36,510][360,556]" />` : ""}
            <android.widget.TextView text="${text}" bounds="[36,620][500,666]" />
          </android.widget.FrameLayout>
        </androidx.core.widget.NestedScrollView>
      </android.widget.FrameLayout>
    </hierarchy>`;
}

function matchConversationXml(name) {
  return `
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <android.widget.ImageView clickable="true" content-desc="back" bounds="[20,58][70,108]" />
        <android.widget.ImageView clickable="true" content-desc="profile" bounds="[112,52][172,112]" />
        <android.widget.TextView text="${name}" bounds="[200,68][390,116]" />
        <androidx.recyclerview.widget.RecyclerView bounds="[0,160][576,1080]">
          <android.widget.FrameLayout bounds="[0,500][576,610]">
            <android.widget.TextView text="Visible ordinary message" bounds="[96,528][410,572]" />
          </android.widget.FrameLayout>
        </androidx.recyclerview.widget.RecyclerView>
        <android.widget.EditText bounds="[70,1120][500,1200]" />
      </android.widget.FrameLayout>
    </hierarchy>`;
}

function createFakeRuntime({
  carouselPages,
  initialCarouselIndex = 0,
  changeBeforePreTap = false,
  matchOpensConversation = false
}) {
  let screen = "carousel";
  let carouselIndex = initialCarouselIndex;
  let carouselRightMoves = 0;
  let targetNavigationSourceReads = 0;
  let profileName = null;
  const calls = { tap: [], back: 0, carouselScrolls: [], profileScrolls: 0 };

  function currentCarouselNames() {
    const original = carouselPages[carouselIndex];
    if (!changeBeforePreTap || carouselRightMoves < 2 || carouselIndex !== carouselPages.length - 1) return original;
    targetNavigationSourceReads += 1;
    // The locating fresh read and its stability confirmation see the original
    // target viewport. The immediate pre-tap projection is changed, forcing a
    // full new inventory rather than a stale click.
    if (targetNavigationSourceReads <= 2) return original;
    return original.map((name) => name === "C" ? "Changed" : name);
  }

  return {
    calls,
    async sourceXml() {
      if (screen === "profile") return profileXml(profileName);
      if (screen === "match-conversation") return matchConversationXml(profileName);
      return carouselXml(currentCarouselNames());
    },
    async scrollCarousel(_bounds, direction) {
      calls.carouselScrolls.push(direction);
      if (direction === "left") {
        if (carouselIndex === 0) return false;
        carouselIndex -= 1;
        return true;
      }
      if (carouselIndex >= carouselPages.length - 1) return false;
      carouselIndex += 1;
      carouselRightMoves += 1;
      return true;
    },
    async tap(bounds) {
      calls.tap.push(bounds);
      if (screen === "match-conversation") {
        screen = "profile";
        return;
      }
      const tileIndex = Math.round((bounds.left - 4) / 118);
      profileName = carouselPages[carouselIndex][tileIndex] || "Unknown";
      screen = matchOpensConversation ? "match-conversation" : "profile";
    },
    async scrollProfile() {
      calls.profileScrolls += 1;
      return false;
    },
    async back() {
      calls.back += 1;
      screen = screen === "profile" && matchOpensConversation ? "match-conversation" : "carousel";
    }
  };
}

test("visible Match equality stays source-state-only and carousel overlap is local adjacency", () => {
  const a = requestedTile("A");
  const aDifferentOrder = { display_name: "A", attributes: {}, media_refs: [] };
  const b = requestedTile("B");
  assert.equal(sameVisibleMatchTile(a, aDifferentOrder), true);
  assert.equal(sameVisibleMatchTile(a, b), false);
  const first = {
    tiles: [{ tile: a }, { tile: b }],
    scroll_bounds: { left: 0, top: 289, right: 576, bottom: 509 }
  };
  const second = {
    tiles: [{ tile: b }, { tile: requestedTile("C") }],
    scroll_bounds: { left: 0, top: 289, right: 576, bottom: 509 }
  };
  assert.equal(directLiveCarouselOverlap(first.tiles, second.tiles), 1);
  assert.equal(sameLiveCarouselProjection(first, second), false);
});

test("fresh carousel inventory is read-only and needs no tap, profile, or Back capability", async () => {
  const directions = [];
  const inventory = await discoverFreshMatchCarousel({
    async sourceXml() { return carouselXml(["A", "B"]); },
    async scrollCarousel(_bounds, direction) {
      directions.push(direction);
      return false;
    }
  }, { maxCarouselGestures: 4, settleMilliseconds: 0 });
  assert.deepEqual(inventory.inventory.map((entry) => entry.tile.display_name), ["A", "B"]);
  assert.deepEqual(directions, ["left", "left", "right", "right"]);
});

test("fresh carousel inventory tolerates a transient empty UiAutomator projection before any action", async () => {
  let sourceReads = 0;
  const directions = [];
  const inventory = await discoverFreshMatchCarousel({
    async sourceXml() {
      sourceReads += 1;
      return sourceReads === 1 ? "<hierarchy rotation=\"0\" />" : carouselXml(["A", "B"]);
    },
    async scrollCarousel(_bounds, direction) {
      directions.push(direction);
      return false;
    },
    async sleep() {}
  }, { maxCarouselGestures: 4, settleMilliseconds: 0 });
  assert.deepEqual(inventory.inventory.map((entry) => entry.tile.display_name), ["A", "B"]);
  assert.ok(sourceReads >= 2);
  assert.deepEqual(directions, ["left", "left", "right", "right"]);
});

test("a requested Match uses freshly inventoried position, revalidates its current tile, reads the profile, and returns with Back", async () => {
  const runtime = createFakeRuntime({
    carouselPages: [["A", "B"], ["B", "C"]],
    initialCarouselIndex: 1
  });
  const result = await runMatchToLiveProfile(runtime, {
    tile: requestedTile("C"),
    // Deliberately wrong and ignored: this runner never clicks a saved ordinal.
    carousel_position: 0
  }, {
    maxCarouselGestures: 8,
    maxProfileGestures: 4,
    settleMilliseconds: 0,
    boundarySettleMilliseconds: 0
  });
  assert.equal(result.status, "PROFILE_READ");
  assert.equal(result.current_carousel_position, 2);
  assert.equal(result.tap_performed, true);
  assert.equal(result.profile_read, true);
  assert.equal(result.returned_with_back, true);
  assert.equal(result.profile.display_name, "C");
  assert.equal(result.profile.attributes.header_profile_age, "29");
  assert.equal(runtime.calls.tap.length, 1);
  assert.equal(runtime.calls.back, 1);
  assert.ok(runtime.calls.carouselScrolls.includes("left"));
  assert.ok(runtime.calls.carouselScrolls.includes("right"));
  assert.equal(runtime.calls.profileScrolls, 2);
});

test("a current Tinder Match chat shell is revalidated before its header profile action and needs two verified Backs", async () => {
  const runtime = createFakeRuntime({
    carouselPages: [["A", "B"]],
    matchOpensConversation: true
  });
  const result = await runMatchToLiveProfile(runtime, { tile: requestedTile("A") }, {
    maxCarouselGestures: 4,
    maxProfileGestures: 4,
    settleMilliseconds: 0,
    boundarySettleMilliseconds: 0
  });
  assert.equal(result.status, "PROFILE_READ");
  assert.equal(result.tap_performed, true);
  assert.equal(result.profile_read, true);
  assert.equal(result.returned_with_back, true);
  assert.equal(runtime.calls.tap.length, 2);
  assert.equal(runtime.calls.back, 2);
});

test("the live-profile reader traverses continued vertical viewports to its verified physical boundary", async () => {
  let viewport = 0;
  let scrolls = 0;
  const profile = await readCompleteLiveMatchProfile({
    async sourceXml() {
      return viewport === 0
        ? profileViewportXml("C", "Opening visible value", { opening: true })
        : profileViewportXml("C", "Later visible value");
    },
    async scrollProfile() {
      scrolls += 1;
      if (scrolls === 1) {
        viewport = 1;
        return true;
      }
      return false;
    }
  }, "C", {
    maxProfileGestures: 4,
    settleMilliseconds: 0,
    boundarySettleMilliseconds: 0
  });
  assert.deepEqual(profile.attributes, {
    visible_profile_01: "C, 29",
    visible_profile_02: "Opening visible value",
    visible_profile_03: "Later visible value",
    header_profile_name: "C",
    header_profile_age: "29"
  });
  assert.equal(scrolls, 3);
});

test("zero fresh carousel candidates performs no tap, profile read, or Back", async () => {
  const runtime = createFakeRuntime({ carouselPages: [["A", "B"]] });
  const result = await runMatchToLiveProfile(runtime, { tile: requestedTile("Absent"), carousel_position: 0 }, {
    maxCarouselGestures: 4,
    settleMilliseconds: 0
  });
  assert.deepEqual(result, {
    status: "TARGET_NOT_PRESENT",
    fresh_carousel_inventories: 1,
    current_carousel_position: null,
    tap_performed: false,
    profile_read: false,
    returned_with_back: false
  });
  assert.equal(runtime.calls.tap.length, 0);
  assert.equal(runtime.calls.profileScrolls, 0);
  assert.equal(runtime.calls.back, 0);
});

test("more than one fresh carousel candidate performs no tap", async () => {
  const runtime = createFakeRuntime({ carouselPages: [["A", "A"]] });
  const result = await runMatchToLiveProfile(runtime, { tile: requestedTile("A"), carousel_position: 9 }, {
    maxCarouselGestures: 4,
    settleMilliseconds: 0
  });
  assert.equal(result.status, "TARGET_AMBIGUOUS");
  assert.equal(result.tap_performed, false);
  assert.equal(runtime.calls.tap.length, 0);
  assert.equal(runtime.calls.back, 0);
});

test("a changed immediate pre-tap carousel projection is freshly inventoried and never clicked stale", async () => {
  const runtime = createFakeRuntime({
    carouselPages: [["A", "B"], ["B", "C"]],
    initialCarouselIndex: 1,
    changeBeforePreTap: true
  });
  const result = await runMatchToLiveProfile(runtime, { tile: requestedTile("C"), carousel_position: 2 }, {
    maxCarouselGestures: 8,
    maxReinventoryAttempts: 2,
    settleMilliseconds: 0
  });
  assert.equal(result.status, "TARGET_NOT_PRESENT");
  assert.equal(result.fresh_carousel_inventories, 2);
  assert.equal(result.tap_performed, false);
  assert.equal(runtime.calls.tap.length, 0);
  assert.equal(runtime.calls.back, 0);
});

test("the Match-to-live-profile runner stays isolated from sync, persistence, sends, and Brain", () => {
  const source = readFileSync(new URL("../tinder-mirror/appium-match-live-profile-runner.js", import.meta.url), "utf8");
  assert.match(source, /export async function discoverFreshMatchCarousel/);
  assert.match(source, /export async function readCompleteLiveMatchProfile/);
  assert.match(source, /export async function runMatchToLiveProfile/);
  assert.match(source, /headerProfileTargetFromXml/);
  assert.match(source, /await runtime\.back\(\)/);
  assert.doesNotMatch(source, /dashboard-api|createTinderAppiumAdapter|persistMatchInventory|\.sync\(|\.resolve\(|\bsend\(/);
});

test("the explicit local command takes a requested visible tile and uses only Appium UI controls", () => {
  const source = readFileSync(new URL("../scripts/tinder-block2-match-live-profile.mjs", import.meta.url), "utf8");
  assert.match(source, /TINDER_MATCH_REQUEST_JSON/);
  assert.match(source, /runMatchToLiveProfile/);
  assert.match(source, /mobile: clickGesture/);
  assert.match(source, /mobile: scrollGesture/);
  assert.match(source, /back: \(\) => appium\("\/back"/);
  assert.doesNotMatch(source, /dashboard-api|TINDER_MIRROR_BASE_URL|DASHBOARD_API_SECRET|INSERT|UPDATE|DELETE/);
});
