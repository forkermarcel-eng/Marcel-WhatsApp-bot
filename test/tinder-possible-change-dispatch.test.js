import assert from "node:assert/strict";
import test from "node:test";
import {
  createTinderPossibleChangeDispatcher,
  sameProjection,
  sourceDiscoveryFromXml
} from "../tinder-mirror/possible-change-dispatch.js";

function source({ rowTexts = ["Ordinary visible row"], tileTexts = ["Visible Match"] } = {}) {
  const screenBottom = Math.max(1280, 720 + rowTexts.length * 112);
  const rowNodes = rowTexts.map((rowText, index) => {
    const top = 520 + index * 112;
    const bottom = top + 108;
    return `
      <android.widget.FrameLayout bounds="[0,${top}][576,${bottom}]">
        <android.view.View clickable="true" bounds="[0,${top}][576,${bottom}]" />
        <android.widget.TextView text="${rowText}" bounds="[80,${top + 20}][500,${bottom - 20}]" />
      </android.widget.FrameLayout>`;
  }).join("");
  const tileNodes = tileTexts.map((tileText, index) => {
    const left = 118 + index * 108;
    const right = left + 102;
    return `
      <android.widget.FrameLayout bounds="[${left},300][${right},488]">
        <android.widget.ImageView clickable="true" bounds="[${left + 4},304][${right - 4},402]" />
        <android.widget.TextView text="${tileText}" bounds="[${left + 4},416][${right - 4},472]" />
      </android.widget.FrameLayout>`;
  }).join("");
  return `
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,${screenBottom}]">
        <androidx.recyclerview.widget.RecyclerView bounds="[0,225][576,${screenBottom - 64}]">
          <android.widget.FrameLayout bounds="[0,289][576,509]">
            <androidx.recyclerview.widget.RecyclerView bounds="[0,289][576,509]">
              ${tileNodes}
            </androidx.recyclerview.widget.RecyclerView>
          </android.widget.FrameLayout>
          ${rowNodes}
        </androidx.recyclerview.widget.RecyclerView>
      </android.widget.FrameLayout>
    </hierarchy>`;
}

function absentSource() {
  return `
    <hierarchy rotation="0">
      <android.widget.FrameLayout bounds="[0,0][576,1280]">
        <android.widget.TextView text="A valid non-inbox Tinder surface" bounds="[80,320][500,400]" />
      </android.widget.FrameLayout>
    </hierarchy>`;
}

function noActionResult(status, { inboxChanged = false, matchesChanged = false } = {}) {
  return {
    status,
    inbox_changed: inboxChanged,
    matches_changed: matchesChanged,
    thread_opens: 0,
    profile_reads: 0,
    history_reads: 0,
    match_tile_opens: 0,
    match_updates: 0
  };
}

test("source-only Tinder discovery keeps only transient local projections", () => {
  const observed = sourceDiscoveryFromXml(source());
  assert.ok(observed);
  assert.deepEqual(Object.keys(observed).sort(), ["inboxRows", "matchTiles"]);
  assert.equal(observed.inboxRows.length, 1);
  assert.equal(observed.matchTiles.length, 1);
  assert.equal(Object.isFrozen(observed), true);
});

test("stable absent projections are unchanged", () => {
  assert.equal(sameProjection(null, null), true);
  assert.equal(sameProjection(null, []), false);
  assert.equal(sameProjection([], null), false);
});

test("CASE D: a valid stable absent source projection is baselined and never loops into a change", async () => {
  const dispatcher = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => absentSource()
  });

  assert.deepEqual(await dispatcher.inspect(), noActionResult("BASELINE_RECORDED"));
  assert.deepEqual(await dispatcher.inspect(), noActionResult("DISCOVERED"));
});

test("a possible-change signal records a baseline, then reports only source delta when no action runner is injected", async () => {
  const sources = [
    source(),
    source(),
    source({ rowTexts: ["Ordinary visible row", "Second ordinary visible row"], tileTexts: ["Different visible Match"] })
  ];
  const observed = [];
  const dispatcher = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => sources.shift(),
    onDiscovery: async (result) => observed.push(result),
    debounceMilliseconds: 0
  });

  const baseline = await dispatcher.signal();
  assert.deepEqual(baseline, noActionResult("BASELINE_RECORDED"));

  const unchanged = await dispatcher.signal();
  assert.deepEqual(unchanged, noActionResult("DISCOVERED"));

  const changed = await dispatcher.signal();
  assert.deepEqual(changed, noActionResult("DISCOVERED", { inboxChanged: true, matchesChanged: true }));
  assert.deepEqual(observed, [unchanged, changed]);
});

test("a source candidate without an injected processor advances its transient baseline as a safe no-action", async () => {
  const changed = source({ rowTexts: ["Ordinary visible row", "Second ordinary visible row"] });
  const sources = [source(), changed, changed];
  const dispatcher = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => sources.shift()
  });

  await dispatcher.inspect();
  assert.deepEqual(await dispatcher.inspect(), noActionResult("DISCOVERED", { inboxChanged: true }));
  assert.deepEqual(await dispatcher.inspect(), noActionResult("DISCOVERED"));
});

test("CASE A: one hundred known unchanged source rows cause zero opens, profile reads, and history reads", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => `Known row ${index + 1}`);
  const actions = [];
  const dispatcher = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => source({ rowTexts: rows }),
    onInboxSourceCandidate: async (candidate) => { actions.push(candidate); return "AMBIGUOUS"; },
    onMatchSourceCandidate: async (candidate) => { actions.push(candidate); return "AMBIGUOUS"; }
  });

  await dispatcher.inspect();
  assert.deepEqual(await dispatcher.inspect(), noActionResult("DISCOVERED"));
  assert.deepEqual(actions, []);
});

test("CASE B: a revalidating processor classifies one source candidate as known-changed and opens only that target", async () => {
  const initialRows = Array.from({ length: 100 }, (_, index) => `Known row ${index + 1}`);
  const changedRows = initialRows.slice();
  changedRows[54] = "Known row 55 with a changed visible message";
  const knownActions = [];
  const newActions = [];
  const sources = [source({ rowTexts: initialRows }), source({ rowTexts: changedRows })];
  const dispatcher = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => sources.shift(),
    onInboxSourceCandidate: async (candidate) => {
      knownActions.push(candidate);
      return "KNOWN_CHANGED";
    }
  });

  await dispatcher.inspect();
  const observed = await dispatcher.inspect();
  assert.deepEqual(observed, {
    ...noActionResult("DISCOVERED", { inboxChanged: true }),
    thread_opens: 1
  });
  assert.deepEqual(knownActions, [{
    source: "INBOX",
    kind: "SOURCE_ROW_REVALIDATION_REQUIRED",
    source_change: "SINGLE_REPLACEMENT",
    previous_index: 54,
    current_index: 54
  }]);
  assert.deepEqual(newActions, []);
});

test("a failed revalidation preserves the prior source baseline for a later independent hint", async () => {
  const sources = [
    source({ rowTexts: ["Known A"] }),
    source({ rowTexts: ["Known A with changed visible message"] }),
    source({ rowTexts: ["Known A with changed visible message"] })
  ];
  let calls = 0;
  const dispatcher = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => sources.shift(),
    onInboxSourceCandidate: async () => {
      calls += 1;
      return calls === 1 ? false : "KNOWN_CHANGED";
    }
  });

  await dispatcher.inspect();
  assert.deepEqual(
    await dispatcher.inspect(),
    noActionResult("ACTION_RETRY_REQUIRED", { inboxChanged: true })
  );
  assert.deepEqual(await dispatcher.inspect(), {
    ...noActionResult("DISCOVERED", { inboxChanged: true }),
    thread_opens: 1
  });
  assert.equal(calls, 2);
});

test("a throwing revalidation preserves the prior baseline without scheduling an automatic retry", async () => {
  const sources = [
    source({ rowTexts: ["Known A"] }),
    source({ rowTexts: ["Known A with changed visible message"] }),
    source({ rowTexts: ["Known A with changed visible message"] })
  ];
  let calls = 0;
  const dispatcher = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => sources.shift(),
    onInboxSourceCandidate: async () => {
      calls += 1;
      if (calls === 1) throw new Error("local revalidation unavailable");
      return "AMBIGUOUS";
    }
  });

  await dispatcher.inspect();
  assert.deepEqual(
    await dispatcher.inspect(),
    noActionResult("ACTION_RETRY_REQUIRED", { inboxChanged: true })
  );
  // The second explicit inspection is the later independent hint; the
  // dispatcher itself does not queue or schedule this call.
  assert.deepEqual(await dispatcher.inspect(), noActionResult("DISCOVERED", { inboxChanged: true }));
  assert.equal(calls, 2);
});

test("an explicit ambiguous revalidation safely advances the transient baseline with no action", async () => {
  const sources = [
    source({ rowTexts: ["Known A"] }),
    source({ rowTexts: ["Known A with changed visible message"] }),
    source({ rowTexts: ["Known A with changed visible message"] })
  ];
  let calls = 0;
  const dispatcher = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => sources.shift(),
    onInboxSourceCandidate: async () => {
      calls += 1;
      return "AMBIGUOUS";
    }
  });

  await dispatcher.inspect();
  assert.deepEqual(await dispatcher.inspect(), noActionResult("DISCOVERED", { inboxChanged: true }));
  assert.deepEqual(await dispatcher.inspect(), noActionResult("DISCOVERED"));
  assert.equal(calls, 1);
});

test("CASE C: a revalidating processor classifies one source candidate as new and performs one initial profile plus full-history path", async () => {
  const initialRows = ["Known A", "Known B", "Known C"];
  const currentRows = ["Known A", "New D", "Known B", "Known C"];
  const initialActions = [];
  const sources = [source({ rowTexts: initialRows }), source({ rowTexts: currentRows })];
  const dispatcher = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => sources.shift(),
    onInboxSourceCandidate: async (candidate) => {
      initialActions.push(candidate);
      return "NEW_THREAD";
    }
  });

  await dispatcher.inspect();
  const observed = await dispatcher.inspect();
  assert.deepEqual(observed, {
    ...noActionResult("DISCOVERED", { inboxChanged: true }),
    thread_opens: 1,
    profile_reads: 1,
    history_reads: 1
  });
  assert.deepEqual(initialActions, [{
    source: "INBOX",
    kind: "SOURCE_ROW_REVALIDATION_REQUIRED",
    source_change: "SINGLE_INSERTION",
    previous_index: null,
    current_index: 1
  }]);
});

test("CASE E: one exact Match delta updates only Match data and never opens a tile", async () => {
  const matchActions = [];
  const sources = [
    source({ tileTexts: ["Match A", "Match B"] }),
    source({ tileTexts: ["Match A", "Match B", "Match C"] })
  ];
  const dispatcher = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => sources.shift(),
    onMatchSourceCandidate: async (candidate) => {
      matchActions.push(candidate);
      return "MATCH_UPDATED";
    }
  });

  await dispatcher.inspect();
  const observed = await dispatcher.inspect();
  assert.deepEqual(observed, {
    ...noActionResult("DISCOVERED", { matchesChanged: true }),
    match_updates: 1
  });
  assert.deepEqual(matchActions, [{
    source: "MATCHES",
    kind: "SOURCE_TILE_REVALIDATION_REQUIRED",
    source_change: "SINGLE_INSERTION",
    previous_index: null,
    current_index: 2
  }]);
});

test("reordered and multiply changed source rows are ambiguous and take no action", async () => {
  const actions = [];
  const reorderedSources = [
    source({ rowTexts: ["Known A", "Known B", "Known C"] }),
    source({ rowTexts: ["Known B", "Known A", "Known C"] })
  ];
  const reordered = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => reorderedSources.shift(),
    onInboxSourceCandidate: async (candidate) => { actions.push(candidate); return "KNOWN_CHANGED"; }
  });

  await reordered.inspect();
  assert.deepEqual(await reordered.inspect(), noActionResult("DISCOVERED", { inboxChanged: true }));

  const multipleSources = [
    source({ rowTexts: ["Known A", "Known B", "Known C"] }),
    source({ rowTexts: ["Changed A", "Changed B", "Known C"] })
  ];
  const multiple = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => multipleSources.shift(),
    onInboxSourceCandidate: async (candidate) => { actions.push(candidate); return "KNOWN_CHANGED"; }
  });

  await multiple.inspect();
  assert.deepEqual(await multiple.inspect(), noActionResult("DISCOVERED", { inboxChanged: true }));
  assert.deepEqual(actions, []);
});

test("unavailable source remains a harmless no-action result and does not erase the prior baseline", async () => {
  const sources = [source(), null, source()];
  const dispatcher = createTinderPossibleChangeDispatcher({
    readSourceXml: async () => sources.shift(),
    debounceMilliseconds: 0
  });

  await dispatcher.signal();
  assert.deepEqual(await dispatcher.signal(), noActionResult("SOURCE_UNAVAILABLE"));
  assert.deepEqual(await dispatcher.signal(), noActionResult("DISCOVERED"));
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
