import assert from "node:assert/strict";
import test from "node:test";
import {
  createTinderPossibleChangeDispatcher,
  sourceDiscoveryFromXml
} from "../tinder-mirror/possible-change-dispatch.js";

function source({ rowText = "Ordinary visible row", includeSecondRow = false, tileText = "Visible Match" } = {}) {
  return `
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <androidx.recyclerview.widget.RecyclerView bounds="[0,225][576,1122]">
          <android.widget.FrameLayout bounds="[0,289][576,509]">
            <androidx.recyclerview.widget.RecyclerView bounds="[0,289][576,509]">
              <android.widget.FrameLayout bounds="[118,300][224,488]">
                <android.widget.ImageView clickable="true" bounds="[122,304][220,402]" />
                <android.widget.TextView text="${tileText}" bounds="[122,416][220,472]" />
              </android.widget.FrameLayout>
            </androidx.recyclerview.widget.RecyclerView>
          </android.widget.FrameLayout>
          <android.widget.FrameLayout bounds="[0,618][576,726]">
            <android.view.View clickable="true" bounds="[0,618][576,726]" />
            <android.widget.TextView text="${rowText}" bounds="[80,640][500,700]" />
          </android.widget.FrameLayout>
          ${includeSecondRow ? `
            <android.widget.FrameLayout bounds="[0,726][576,834]">
              <android.view.View clickable="true" bounds="[0,726][576,834]" />
              <android.widget.TextView text="Second ordinary visible row" bounds="[80,748][500,808]" />
            </android.widget.FrameLayout>` : ""}
        </androidx.recyclerview.widget.RecyclerView>
      </android.widget.FrameLayout>
    </hierarchy>`;
}

test("source-only Tinder discovery keeps only transient local projections", () => {
  const observed = sourceDiscoveryFromXml(source());
  assert.ok(observed);
  assert.deepEqual(Object.keys(observed).sort(), ["inboxRows", "matchTiles"]);
  assert.equal(observed.inboxRows.length, 1);
  assert.equal(observed.matchTiles.length, 1);
  assert.equal(Object.isFrozen(observed), true);
});

test("a possible-change signal records a baseline, then reports only source delta and opens nothing", async () => {
  const sources = [source(), source(), source({ includeSecondRow: true, tileText: "Different visible Match" })];
  const observed = [];
  const dispatcher = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => sources.shift(),
    onDiscovery: async (result) => observed.push(result),
    debounceMilliseconds: 0
  });

  const baseline = await dispatcher.signal();
  assert.deepEqual(baseline, {
    status: "BASELINE_RECORDED",
    inbox_changed: false,
    matches_changed: false,
    thread_opens: 0,
    profile_reads: 0,
    history_reads: 0
  });

  const unchanged = await dispatcher.signal();
  assert.deepEqual(unchanged, {
    status: "DISCOVERED",
    inbox_changed: false,
    matches_changed: false,
    thread_opens: 0,
    profile_reads: 0,
    history_reads: 0
  });

  const changed = await dispatcher.signal();
  assert.deepEqual(changed, {
    status: "DISCOVERED",
    inbox_changed: true,
    matches_changed: true,
    thread_opens: 0,
    profile_reads: 0,
    history_reads: 0
  });
  assert.deepEqual(observed, [unchanged, changed]);
});

test("unavailable source remains a harmless no-action result and does not erase the prior baseline", async () => {
  const sources = [source(), null, source()];
  const dispatcher = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => sources.shift(),
    debounceMilliseconds: 0
  });

  await dispatcher.signal();
  assert.deepEqual(await dispatcher.signal(), {
    status: "SOURCE_UNAVAILABLE",
    inbox_changed: false,
    matches_changed: false,
    thread_opens: 0,
    profile_reads: 0,
    history_reads: 0
  });
  assert.deepEqual(await dispatcher.signal(), {
    status: "DISCOVERED",
    inbox_changed: false,
    matches_changed: false,
    thread_opens: 0,
    profile_reads: 0,
    history_reads: 0
  });
});

test("concurrent possible-change hints coalesce to one inspection without a retry queue", async () => {
  let reads = 0;
  const dispatcher = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => { reads += 1; return source(); },
    debounceMilliseconds: 0
  });
  const first = dispatcher.signal();
  const second = dispatcher.signal();
  assert.equal(first, second);
  await first;
  assert.equal(reads, 1);
});
