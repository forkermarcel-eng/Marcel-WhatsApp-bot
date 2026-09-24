import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { TinderMirrorError } from "../tinder-mirror/conversation.js";
import { createTinderMatchMirror, normalizeTinderMatchPayload } from "../tinder-mirror/matches.js";
import { observeMatchCarouselFromXml } from "../tinder-mirror/appium-conversation-reader.js";

const deviceA = "00000000-0000-4000-8000-000000000001";
const deviceB = "00000000-0000-4000-8000-000000000002";
const conversationA = "00000000-0000-4000-8000-000000000010";
const conversationB = "00000000-0000-4000-8000-000000000011";

function tile(name = "Visible tile", attributes = {}) {
  return {
    display_name: name,
    attributes,
    media_refs: []
  };
}

function payload(position, { conversationId = null, name = "Visible tile", attributes = {} } = {}) {
  return {
    tile: tile(name, attributes),
    carousel_position: position,
    ...(conversationId ? { conversation_id: conversationId } : {})
  };
}

function createMatchPool() {
  const state = {
    devices: new Set([deviceA, deviceB]),
    conversations: new Map([
      [conversationA, { conversation_id: conversationA, device_id: deviceA }],
      [conversationB, { conversation_id: conversationB, device_id: deviceB }]
    ]),
    matches: new Map(),
    conversationWrites: 0,
    messageWrites: 0
  };
  const query = async (sql, params = []) => {
    const normalized = String(sql).replace(/\s+/g, " ").trim();
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(normalized)) return { rows: [] };
    if (normalized.startsWith("SELECT device_id FROM device_bridge_devices")) {
      return { rows: state.devices.has(params[0]) ? [{ device_id: params[0] }] : [] };
    }
    if (normalized.startsWith("SELECT conversation_id FROM tinder_conversations")) {
      const conversation = state.conversations.get(params[0]);
      return { rows: conversation?.device_id === params[1] ? [{ ...conversation }] : [] };
    }
    if (normalized.startsWith("SELECT match_id, device_id, conversation_id, tile, carousel_position, created_at, updated_at FROM tinder_matches WHERE")) {
      const match = [...state.matches.values()].find((item) => item.device_id === params[0] && item.conversation_id === params[1]);
      return { rows: match ? [{ ...match }] : [] };
    }
    if (normalized.startsWith("INSERT INTO tinder_matches")) {
      const [matchId, deviceId, conversationId, rawTile, carouselPosition, timestamp] = params;
      const row = {
        match_id: matchId,
        device_id: deviceId,
        conversation_id: conversationId,
        tile: JSON.parse(rawTile),
        carousel_position: carouselPosition,
        created_at: timestamp,
        updated_at: timestamp
      };
      state.matches.set(matchId, row);
      return { rows: [{ ...row }] };
    }
    if (normalized.startsWith("UPDATE tinder_matches SET tile=")) {
      const [matchId, rawTile, carouselPosition, timestamp] = params;
      const row = state.matches.get(matchId);
      Object.assign(row, { tile: JSON.parse(rawTile), carousel_position: carouselPosition, updated_at: timestamp });
      return { rows: [] };
    }
    if (normalized.startsWith("SELECT match_id, device_id, conversation_id, tile, carousel_position, created_at, updated_at FROM tinder_matches ORDER BY")) {
      return { rows: [...state.matches.values()].sort((left, right) => left.carousel_position - right.carousel_position || left.match_id.localeCompare(right.match_id)).map((row) => ({ ...row })) };
    }
    if (/^(INSERT|UPDATE|DELETE) INTO tinder_conversations|^(INSERT|UPDATE|DELETE) INTO tinder_conversation_messages/.test(normalized)) {
      state.conversationWrites += /tinder_conversations/.test(normalized) ? 1 : 0;
      state.messageWrites += /tinder_conversation_messages/.test(normalized) ? 1 : 0;
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  };
  const client = { query, release() {} };
  return {
    state,
    async connect() { return client; },
    query
  };
}

test("Match payload is bounded visible tile state, not a Match identity", () => {
  assert.deepEqual(normalizeTinderMatchPayload(payload(0, { attributes: { visible_tile_01: "Visible state" } })), {
    tile: tile("Visible tile", { visible_tile_01: "Visible state" }),
    carousel_position: 0,
    conversation_id: null
  });
  assert.throws(
    () => normalizeTinderMatchPayload({ ...payload(0), raw_tree: "forbidden" }),
    (error) => error instanceof TinderMirrorError && error.code === "INVALID_TINDER_MATCH_PAYLOAD"
  );
  assert.throws(
    () => normalizeTinderMatchPayload(payload(-1)),
    (error) => error instanceof TinderMirrorError && error.code === "INVALID_TINDER_MATCH_PAYLOAD"
  );
});

test("the separate compact Match carousel exposes individual visible tiles and excludes the Likes aggregate", () => {
  const carousel = observeMatchCarouselFromXml(`
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.recyclerview.widget.RecyclerView bounds="[0,225][576,1122]">
          <android.widget.FrameLayout bounds="[0,289][576,509]">
            <androidx.recyclerview.widget.RecyclerView bounds="[0,289][576,509]">
              <android.widget.FrameLayout bounds="[0,300][106,488]">
                <android.widget.ImageView clickable="true" bounds="[4,304][102,402]" />
              </android.widget.FrameLayout>
              <android.widget.FrameLayout bounds="[118,300][224,488]">
                <android.widget.ImageView clickable="true" bounds="[122,304][220,402]" />
                <android.widget.TextView text="Visible Match A" bounds="[122,416][220,472]" />
              </android.widget.FrameLayout>
              <android.widget.FrameLayout bounds="[236,300][342,488]">
                <android.widget.ImageView clickable="true" bounds="[240,304][338,402]" />
                <android.widget.TextView text="Visible Match B" bounds="[240,416][338,472]" />
              </android.widget.FrameLayout>
            </androidx.recyclerview.widget.RecyclerView>
          </android.widget.FrameLayout>
          <android.widget.FrameLayout bounds="[0,618][576,726]">
            <android.view.View clickable="true" bounds="[0,618][576,726]" />
            <android.widget.TextView text="Ordinary existing preview" bounds="[80,640][500,700]" />
          </android.widget.FrameLayout>
        </androidx.recyclerview.widget.RecyclerView>
      </android.widget.FrameLayout>
    </hierarchy>`);
  assert.ok(carousel);
  assert.deepEqual(carousel.scroll_bounds, { left: 0, top: 289, right: 576, bottom: 509, width: 576, height: 220 });
  assert.deepEqual(carousel.tiles.map((item) => item.tile.display_name), ["Visible Match A", "Visible Match B"]);
});

test("an unassigned Match persists without manufacturing a Conversation or message", async () => {
  const pool = createMatchPool();
  let sequence = 0;
  const mirror = createTinderMatchMirror({
    pool,
    now: () => new Date("2026-09-24T10:00:00.000Z"),
    idFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
  });
  const result = await mirror.sync({ deviceId: deviceA, payload: payload(2) });
  assert.equal(result.created, true);
  assert.equal(result.match.conversation_id, null);
  assert.equal(result.match.carousel_position, 2);
  assert.equal(pool.state.matches.size, 1);
  assert.equal(pool.state.conversationWrites, 0);
  assert.equal(pool.state.messageWrites, 0);
});

test("a supplied Match link is accepted only for the same existing device-bound Conversation", async () => {
  const pool = createMatchPool();
  let sequence = 0;
  const mirror = createTinderMatchMirror({
    pool,
    now: () => new Date("2026-09-24T10:00:00.000Z"),
    idFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
  });
  const linked = await mirror.sync({ deviceId: deviceA, payload: payload(0, { conversationId: conversationA }) });
  assert.equal(linked.created, true);
  assert.equal(linked.match.conversation_id, conversationA);
  await assert.rejects(
    () => mirror.sync({ deviceId: deviceA, payload: payload(1, { conversationId: conversationB }) }),
    (error) => error instanceof TinderMirrorError && error.code === "TINDER_MATCH_CONVERSATION_UNVERIFIED"
  );
  assert.equal(pool.state.matches.size, 1);
});

test("the same definitively linked Conversation updates its Match instead of adding a second one", async () => {
  const pool = createMatchPool();
  let sequence = 0;
  const mirror = createTinderMatchMirror({
    pool,
    now: () => new Date("2026-09-24T10:00:00.000Z"),
    idFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
  });
  const first = await mirror.sync({ deviceId: deviceA, payload: payload(3, { conversationId: conversationA }) });
  const second = await mirror.sync({ deviceId: deviceA, payload: payload(1, { conversationId: conversationA, attributes: { visible_tile_01: "Updated" } }) });
  assert.equal(second.created, false);
  assert.equal(second.match.id, first.match.id);
  assert.equal(pool.state.matches.size, 1);
  assert.equal(second.match.carousel_position, 1);
});

test("Match list follows the source carousel position", async () => {
  const pool = createMatchPool();
  let sequence = 0;
  const mirror = createTinderMatchMirror({
    pool,
    now: () => new Date("2026-09-24T10:00:00.000Z"),
    idFactory: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
  });
  await mirror.sync({ deviceId: deviceA, payload: payload(4) });
  await mirror.sync({ deviceId: deviceA, payload: payload(0) });
  assert.deepEqual((await mirror.list()).map((match) => match.carousel_position), [0, 4]);
});

test("Match routes and dashboard use the existing authenticated transport without a new control system", () => {
  const routes = readFileSync(new URL("../tinder-mirror/routes.js", import.meta.url), "utf8");
  const proxy = readFileSync(new URL("../api/dashboard/tinder.js", import.meta.url), "utf8");
  const dashboard = readFileSync(new URL("../Tinder/index.html", import.meta.url), "utf8");
  assert.match(routes, /app\.post\("\/dashboard-api\/tinder\/matches"/);
  assert.match(routes, /app\.get\("\/dashboard-api\/tinder\/matches"/);
  assert.match(proxy, /resource === "matches"/);
  assert.match(dashboard, /data-tinder-matches/);
  assert.match(dashboard, /resource=matches/);
  assert.match(dashboard, /loadConversation\(match\.conversation_id\)/);
  const matchRouteSection = routes.slice(routes.indexOf('app.post("/dashboard-api/tinder/matches"'));
  for (const source of [matchRouteSection, proxy, dashboard]) {
    assert.doesNotMatch(source, /permit|receipt|attestation|heartbeat/i);
  }
});
