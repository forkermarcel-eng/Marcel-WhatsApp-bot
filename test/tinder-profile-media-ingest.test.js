import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTinderProfileMediaIngestor } from "../tinder-mirror/profile-media-ingest.js";

test("Tinder media ingestor accepts supplied element bytes without device control", async () => {
  const calls = [];
  const ingestor = createTinderProfileMediaIngestor({
    assetService: {
      async ingestImage(value) { calls.push(["image", value]); return { stored: true }; },
      createUnavailableAsset(value) { calls.push(["unavailable", value]); return { stored: false }; }
    }
  });
  const result = await ingestor.ingestElementScreenshot({
    profileReference: "profile:opaque",
    imageBytes: Buffer.from([1, 2, 3]),
    position: 1,
    metadata: { refresh: "manual" }
  });
  assert.deepEqual(result, { stored: true });
  assert.equal(calls[0][0], "image");
  assert.equal(calls[0][1].sourceChannel, "tinder");
  assert.equal(calls[0][1].sourceReference, "profile:opaque");
  assert.equal(calls[0][1].crop, null);
  assert.deepEqual(calls[0][1].owners, [{
    ownerType: "tinder_profile",
    ownerReference: "profile:opaque",
    relationshipType: "profile_media",
    ordinal: 1
  }]);
  assert.equal(calls[0][1].metadata.ingestMode, "element_screenshot");
});

test("screen-region ingest requires an immediately verified observation reference and bounds", async () => {
  const calls = [];
  const ingestor = createTinderProfileMediaIngestor({
    assetService: {
      async ingestImage(value) { calls.push(value); return value; },
      createUnavailableAsset(value) { return value; }
    }
  });
  await assert.rejects(
    ingestor.ingestVerifiedScreenRegion({
      profileReference: "profile:opaque",
      screenBytes: Buffer.alloc(1),
      verifiedMediaBounds: { left: 0, top: 0, width: 1, height: 1 }
    }),
    /observationReference is required/
  );
  const result = await ingestor.ingestVerifiedScreenRegion({
    profileReference: "profile:opaque",
    screenBytes: Buffer.alloc(1),
    verifiedMediaBounds: { left: 5, top: 6, width: 10, height: 11 },
    observationReference: "same-ui-cycle",
    position: 2
  });
  assert.deepEqual(result.crop, { left: 5, top: 6, width: 10, height: 11 });
  assert.equal(result.metadata.ingestMode, "verified_screen_region");
  assert.equal(calls.length, 1);
});

test("unavailable Tinder profile media does not request a screenshot bypass", () => {
  const calls = [];
  const ingestor = createTinderProfileMediaIngestor({
    assetService: {
      async ingestImage() { throw new Error("not expected"); },
      createUnavailableAsset(value) { calls.push(value); return value; }
    }
  });
  const record = ingestor.recordUnavailable({
    profileReference: "profile:opaque",
    reason: "FLAG_SECURE",
    position: 0
  });
  assert.equal(record.unavailableReason, "FLAG_SECURE");
  assert.equal(record.owners[0].relationshipType, "profile_media");
  const source = readFileSync(new URL("../tinder-mirror/profile-media-ingest.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /driver\.|appium|\badb\b|takeScreenshot|executeScript|shell\s*\(/i);
});
