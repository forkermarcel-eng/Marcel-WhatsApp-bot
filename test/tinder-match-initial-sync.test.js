import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  appendCarouselInventory,
  directCarouselOverlap,
  matchWirePayload,
  persistMatchInventory,
  sameCarouselProjection
} from "../scripts/tinder-block2-match-initial-sync.mjs";

function tile(name) {
  return Object.freeze({
    tile: Object.freeze({ display_name: name, attributes: Object.freeze({}), media_refs: Object.freeze([]) }),
    ram_key: `opaque-${name}`
  });
}

function carousel(...names) {
  return Object.freeze({
    tiles: Object.freeze(names.map(tile)),
    scroll_bounds: Object.freeze({ left: 0, top: 100, right: 500, bottom: 260, width: 500, height: 160 })
  });
}

test("adjacent Match carousel overlap is transient direct continuity, not a durable Match identity", () => {
  const first = carousel("A", "B", "C");
  const second = carousel("B", "C", "D");
  assert.equal(directCarouselOverlap(first.tiles, second.tiles), 2);
  const inventory = appendCarouselInventory([], first);
  const extended = appendCarouselInventory(inventory, second, 2);
  assert.deepEqual(extended.map((entry) => entry.carousel_position), [0, 1, 2, 3]);
  assert.deepEqual(extended.map((entry) => entry.tile.display_name), ["A", "B", "C", "D"]);
  assert.ok(extended.every((entry) => typeof entry.ram_tile_state === "string"));
});

test("a changed carousel without direct overlap fails closed instead of inventing a Match correspondence", () => {
  assert.equal(directCarouselOverlap(carousel("A", "B").tiles, carousel("C", "D").tiles), null);
  assert.equal(sameCarouselProjection(carousel("A", "B"), carousel("A", "B")), true);
  assert.equal(sameCarouselProjection(carousel("A", "B"), carousel("B", "C")), false);
});

test("Phase 2 submits each RAM-only inventory ordinal exactly once and leaves every Match unassigned", async () => {
  const inventory = appendCarouselInventory([], carousel("A", "B"));
  const calls = [];
  const runtime = {
    async dashboard(path, request) {
      calls.push({ path, request });
      return { ok: true, created: true };
    }
  };
  const result = await persistMatchInventory(runtime, {
    deviceId: "00000000-0000-4000-8000-000000000001",
    inventory
  });
  assert.deepEqual(result, { processed: 2, created: 2, same_sweep_reprocesses: 0 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.path === "/dashboard-api/tinder/matches" && call.request.method === "POST"));
  assert.deepEqual(calls.map((call) => call.request.body.match.conversation_id), [null, null]);
  assert.deepEqual(calls.map((call) => call.request.body.match.carousel_position), [0, 1]);
});

test("the Match wire payload contains only visible tile state, position, and an explicit unassigned relation", () => {
  const payload = matchWirePayload({
    tile: { display_name: "Visible", attributes: {}, media_refs: [] },
    carousel_position: 3
  });
  assert.deepEqual(payload, {
    tile: { display_name: "Visible", attributes: {}, media_refs: [] },
    carousel_position: 3,
    conversation_id: null
  });
});

test("the runner has a strict Phase 1 observation boundary and no tile/chat/profile/history action", () => {
  const source = readFileSync(new URL("../scripts/tinder-block2-match-initial-sync.mjs", import.meta.url), "utf8");
  assert.match(source, /export async function discoverMatchInventory/);
  assert.match(source, /export async function persistMatchInventory/);
  assert.match(source, /mobile: scrollGesture/);
  assert.match(source, /\/dashboard-api\/tinder\/matches/);
  assert.doesNotMatch(source, /clickGesture/);
  assert.doesNotMatch(source, /headerProfileTarget|observeProfileFromXml|observeConversationViewportFromXml/);
  assert.doesNotMatch(source, /\/dashboard-api\/tinder\/conversations/);
  assert.doesNotMatch(source, /permit|receipt|attestation/i);
  assert.match(source, /heartbeat_used_as_gate:\s*false/);
});
