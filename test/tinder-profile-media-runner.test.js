import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import sharp from "sharp";
import { readVerifiedTinderProfileMedia } from "../tinder-mirror/appium-profile-media-runner.js";
import { createProfileMediaBuffer } from "../tinder-mirror/profile-media-buffer.js";
import { createRuntime } from "../scripts/tinder-block2-match-live-profile.mjs";

function profileXml(position = 1, total = 1) {
  return `
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.core.widget.NestedScrollView scrollable="true" bounds="[0,160][576,1120]">
          <android.widget.FrameLayout bounds="[0,160][576,780]">
            <androidx.viewpager.widget.ViewPager content-desc="Profile Media, Photo, ${position} of ${total}" bounds="[0,160][576,600]" />
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

const screen = page => sharp({ create: { width: 576, height: 1280, channels: 3,
  background: ["red","blue","green"][page] } }).png().toBuffer();

test("animated last media page completes by repeated official last position, not frozen pixels", async()=>{
  let position=1,frame=0,gestures=0;
  const ingestor=recordingIngestor();
  const result=await readVerifiedTinderProfileMedia({sourceXml:async()=>profileXml(position,8),
    captureScreen:()=>sharp({create:{width:576,height:1280,channels:3,background:{r:++frame*5,g:20,b:30}}}).png().toBuffer(),
    swipePager:async()=>{gestures++;position=Math.min(position+1,8);}}, {
    profileReference:"fixture",expectedDisplayName:"Visible profile",mediaIngestor:ingestor,
    settleMilliseconds:0,boundarySettleMilliseconds:0});
  assert.equal(result.end_actually_reached,true);
  assert.equal(result.captured_pages,8);
  assert.equal(gestures,9);
  assert.equal(ingestor.calls.image.length,8);
});

test("animated nonterminal position cannot pretend to be the end and stays bounded",async()=>{
  let frame=0;
  const result=await readVerifiedTinderProfileMedia({sourceXml:async()=>profileXml(1,8),
    captureScreen:()=>screen(++frame%3),swipePager:async()=>{}},{profileReference:"fixture",
    expectedDisplayName:"Visible profile",mediaIngestor:recordingIngestor(),maxPagerGestures:4,
    settleMilliseconds:0,boundarySettleMilliseconds:0});
  assert.equal(result.end_actually_reached,false);
  assert.equal(result.captured_pages,1);
  assert.ok(result.pager_gestures<=4);
});

test("initial profile crops stay in RAM until accepted conversation ID, then clear without a second profile open", async () => {
  const buffer=createProfileMediaBuffer(),uploads=[];
  const outcome=await buffer.read({sourceXml:async()=>profileXml(),captureScreen:()=>screen(0),swipePager:async()=>false,sleep:async()=>{}},"Visible profile");
  assert.equal(outcome.end_actually_reached,true);
  const result=await buffer.flush({deviceId:"d",conversationId:"accepted-id",transport:{async ingestMedia(value){uploads.push(value);}}});
  assert.equal(result.persisted,1);
  assert.equal(uploads[0].ownerId,"accepted-id");
  assert.equal(uploads[0].kind,"profile");
  assert.equal((await sharp(uploads[0].sourceBytes).metadata()).height,440);
  assert.equal((await buffer.flush({transport:{ingestMedia(){throw Error("must be cleared");}}})).persisted,0);
});

test("profile media failures remain explicit and never become a gate for the text mirror", async () => {
  const buffer=createProfileMediaBuffer({maxBytes:1});
  const runtime={sourceXml:async()=>profileXml(),captureScreen:()=>screen(0),swipePager:async()=>false,sleep:async()=>{}};
  assert.equal((await buffer.read(runtime,"Visible profile")).status,"PROFILE_MEDIA_READ_FAILED");
  const regular=createProfileMediaBuffer();await regular.read(runtime,"Visible profile");
  const result=await regular.flush({conversationId:"accepted",transport:{ingestMedia(){throw Error("offline");}}});
  assert.equal(result.status,"PROFILE_MEDIA_UPLOAD_FAILED");
  assert.equal(result.persisted,0);
});

test("verified profile media runner captures the initial page and each physically advanced pager page", async () => {
  const ingestor = recordingIngestor();
  let page = 0;
  const pagerCalls = [];
  const result = await readVerifiedTinderProfileMedia({
    async sourceXml() { return profileXml(page + 1, 3); },
    async captureScreen() { return screen(page); },
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
    async captureScreen() { return screen(0); },
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

test("successful gestures with unchanged nonterminal media never create duplicate pages or claim completion", async () => {
  const ingestor = recordingIngestor();
  const result = await readVerifiedTinderProfileMedia({ sourceXml: async () => profileXml(1, 9),
    captureScreen: async () => screen(0), swipePager: async () => true }, {
    profileReference: "profile:opaque", expectedDisplayName: "Visible profile", mediaIngestor: ingestor,
    maxPagerGestures: 3, settleMilliseconds: 0, boundarySettleMilliseconds: 0 });
  assert.equal(result.captured_pages,1);
  assert.equal(result.end_actually_reached,false);
  assert.equal(result.status,"PAGER_NO_PROGRESS");
  assert.equal(ingestor.calls.image.length,1);
});

test("false scroll result at real Photo 1 of 9 is not a profile-media end", async () => {
  const ingestor = recordingIngestor();
  const result = await readVerifiedTinderProfileMedia({sourceXml:async()=>profileXml(1,9),
    captureScreen:()=>screen(0),swipePager:async()=>false}, {
    profileReference:"profile:opaque",expectedDisplayName:"Visible profile",mediaIngestor:ingestor,
    settleMilliseconds:0,boundarySettleMilliseconds:0});
  assert.equal(result.status,"PAGER_NO_PROGRESS");
  assert.equal(result.end_actually_reached,false);
  assert.equal(result.captured_pages,1);
});

test("missing pager position or a mid-profile start never claims a full collection", async () => {
  for(const xml of [profileXml().replace(/content-desc="[^"]*"/,""),profileXml(2,9)]) {
    const ingestor=recordingIngestor();
    const result=await readVerifiedTinderProfileMedia({sourceXml:async()=>xml,
      captureScreen(){throw Error("no capture");},swipePager(){throw Error("no gesture");}}, {
      profileReference:"profile:opaque",expectedDisplayName:"Visible profile",mediaIngestor:ingestor});
    assert.equal(result.end_actually_reached,false);
    assert.equal(ingestor.calls.image.length,0);
  }
});

test("profile pager uses real left swipe inside verified bounds, not scrollGesture return semantics", async () => {
  const calls=[];
  const runtime=createRuntime({appiumBaseUrl:"http://appium",sessionId:"existing"},async(url,options)=>{
    calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({value:null})};
  });
  await runtime.swipePager({left:0,top:140,width:576,height:720},"left");
  assert.equal(calls[0].script,"mobile: swipeGesture");
  assert.deepEqual(calls[0].args,[{left:20,top:180,width:536,height:640,direction:"left",percent:0.85}]);
  assert.throws(()=>runtime.swipePager({left:0,top:140,width:576,height:720},"down"),/Invalid profile pager direction/);
});
