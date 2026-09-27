import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { prepareLocalAppiumRuntime, reconcileExistingTinderMirror } from "../tinder-mirror/local-appium-discovery-runtime.js";
import { workerConnectionString, startReconciliationTimer, startWorkerTunnel } from "../scripts/tinder-discovery-worker.mjs";
import { planInboxReconciliation, createLocalTinderDiscoveryExecutor } from "../tinder-mirror/local-discovery-executor.js";
import { createTinderPossibleChangeDispatcher } from "../tinder-mirror/possible-change-dispatch.js";
import { scrollInbox, sameInboxScrollSurface } from "../scripts/tinder-block2-initial-sync.mjs";

test("same Inbox Recycler survives the observed collapsing top area without accepting another surface", () => {
  const before = { scroll_resource_id: "com.tinder:id/matchListRecycler",
    scroll_bounds: { left: 0, top: 225, right: 576, bottom: 1122 } };
  const after = { ...before, scroll_bounds: { ...before.scroll_bounds, top: 135 } };
  assert.equal(sameInboxScrollSurface(before, after), true);
  assert.equal(sameInboxScrollSurface(after, before), true);
  assert.equal(sameInboxScrollSurface(before, { ...after, scroll_resource_id: "other" }), false);
  assert.equal(sameInboxScrollSurface(before, { ...after, scroll_resource_id: null }), false);
  assert.equal(sameInboxScrollSurface(before, { ...after, scroll_bounds: { ...after.scroll_bounds, right: 500 } }), false);
});

test("Inbox scroll freshly targets its RecyclerView with the physically verified distance", async () => {
  for (const direction of ["up", "down"]) {
    const calls = [];
    const result = await scrollInbox(direction, async (path, options) => {
      calls.push({ path, body: options.body });
      return path === "/elements" ? [{ "element-6066-11e4-a52e-4f735466cecf": "fresh-inbox" }] : false;
    });
    assert.equal(result, false);
    assert.deepEqual(calls, [
      { path: "/elements", body: { using: "id", value: "com.tinder:id/matchListRecycler" } },
      { path: "/execute/sync", body: { script: "mobile: scrollGesture",
        args: [{ elementId: "fresh-inbox", direction, percent: 0.45 }] } }
    ]);
  }
});

test("Inbox scroll cannot treat a missing target or invalid scroll result as the end", async () => {
  for (const elements of [[], [{}, {}], [{}]]) {
    await assert.rejects(scrollInbox("down", async path => {
      assert.equal(path, "/elements");
      return elements;
    }), /not uniquely available/);
  }
  await assert.rejects(scrollInbox("down", async path => path === "/elements"
    ? [{ "element-6066-11e4-a52e-4f735466cecf": "fresh-inbox" }] : null), /physical boundary/);
});

const inventoryRow = (name, preview, position) => ({ inbox_position: position,
  observed_row: { ram_key: JSON.stringify({ texts: [name, preview] }) } });
const storedConversation = (name, preview, id) => ({ conversation: { id, profile: { display_name: name } },
  messages: [{ direction: "inbound", text: preview }] });

test("UNKNOWN unchanged state is checked once per runtime; changed preview/time and restart recheck", async () => {
  let row = inventoryRow("S", "unresolved", 0), opens = 0;
  const checked = new Set(), bindings = new Map();
  const inbox = { readSourceXml: async () => {}, readInboxInventory: async () => ({ inventory: [row] }),
    readStoredConversations: async () => [storedConversation("S", "other", "s")],
    locateInventoryRow: async () => row, readUnboundChanged: async () => { opens++; return { outcome: "AMBIGUOUS" }; },
    updateInboxPosition: async () => assert.fail("No identity assigned") };
  const matches = { observeMatchInventory: async () => ({}), reconcileMatchInventory: async () => ({ updates: 0, unresolved: 0 }) };
  const run = state => reconcileExistingTinderMirror(inbox, matches, bindings, state);
  assert.equal((await run(checked)).thread_opens, 1);
  row.inbox_position = 8;
  const skipped = await run(checked);
  assert.equal(skipped.thread_opens, 0);
  assert.equal(skipped.unknown, 1);
  assert.equal(skipped.known, 0);
  assert.equal(skipped.unknown_unchanged_skipped, 1);
  row = inventoryRow("S", "changed", 0);
  assert.equal((await run(checked)).thread_opens, 1);
  row.last_message_visible_time = "new time";
  assert.equal((await run(checked)).thread_opens, 1);
  assert.equal((await run(checked)).thread_opens, 0);
  assert.equal((await run(new Set())).thread_opens, 1);
  assert.equal(opens, 4);
  assert.equal(bindings.size, 0);
});

test("failed bounded read is not remembered as a completed UNKNOWN check", async () => {
  const checked = new Set();
  const inbox = { readSourceXml: async () => {}, readInboxInventory: async () => ({ inventory: [inventoryRow("S", "new", 0)] }),
    readStoredConversations: async () => [], locateInventoryRow: async () => ({}),
    readUnboundChanged: async () => { throw new Error("navigation failed"); } };
  const matches = { observeMatchInventory: async () => ({}), reconcileMatchInventory: async () => ({ updates: 0, unresolved: 0 }) };
  await assert.rejects(reconcileExistingTinderMirror(inbox, matches, new Map(), checked), /navigation failed/);
  assert.equal(checked.size, 0);
});

test("existing SSH process is restarted after loss, receives no Railway secrets, and stops with worker", () => {
  const children = [], calls = [], reports = []; let retry, cancelled = false;
  const tunnel = startWorkerTunnel({ TINDER_SSH_TARGET: "existing@ssh.railway.com",
    TINDER_SSH_IDENTITY_FILE: "existing-key", TINDER_DATABASE_TUNNEL_PORT: "15433",
    DATABASE_URL: "secret", DASHBOARD_API_SECRET: "secret", SystemRoot: "C:\\Windows" }, {
    spawnFn: (file, args, options) => { calls.push({ file, args, options });
      const child = new EventEmitter(); child.kill = () => child.emit("exit", 0); children.push(child); return child; },
    setTimeoutFn: (callback, ms) => { assert.equal(ms, 5000); retry = callback; return 1; },
    clearTimeoutFn: () => { cancelled = true; }, report: value => reports.push(value)
  });
  assert.deepEqual(calls[0].options.env, { SystemRoot: "C:\\Windows" });
  assert.equal(calls[0].options.windowsHide, true);
  assert.ok(calls[0].args.includes("127.0.0.1:15433:127.0.0.1:5432"));
  assert.ok(calls[0].args.includes("StrictHostKeyChecking=yes"));
  children[0].emit("exit", 255);
  assert.equal(reports.length, 1);
  retry();
  assert.equal(children.length, 2);
  children[1].emit("error", new Error("unavailable"));
  children[1].emit("exit", 255);
  assert.equal(reports.length, 2);
  tunnel.stop();
  assert.equal(cancelled, true);
  retry();
  assert.equal(children.length, 2);
  assert.equal(startWorkerTunnel({}), null);
});

test("identity survives changed visible time; content changes independently of Inbox count/order", () => {
  const known = storedConversation("A", "tail", "a");
  known.conversation.last_message_visible_time = "gestern";
  const row = { ...inventoryRow("A", "tail", 0), last_message_visible_time: "heute" };
  const [item] = planInboxReconciliation([row], [known]);
  assert.equal(item.identity, "KNOWN");
  assert.equal(item.conversation.id, "a");
  assert.equal(item.content, "OBSERVED_CHANGED");
  assert.equal(item.action, "KNOWN_DELTA");
  const [reordered] = planInboxReconciliation([{ ...row, inbox_position: 8 }], [known]);
  assert.equal(reordered.conversation.id, "a");
  assert.equal(reordered.content, "OBSERVED_CHANGED");
});

test("confirmed RAM continuity separates identity from changed content and is absent after restart", () => {
  const known = storedConversation("A", "stored tail", "a");
  const row = inventoryRow("A", "current changed preview", 0);
  const bindings = new Map([[row.observed_row.ram_key, "a"]]);
  assert.equal(planInboxReconciliation([row], [known], bindings)[0].content, "OBSERVED_CHANGED");
  assert.equal(planInboxReconciliation([row], [known])[0].identity, "UNKNOWN");
  const changed = inventoryRow("A", "another preview", 0);
  assert.equal(planInboxReconciliation([changed], [known], bindings)[0].identity, "UNKNOWN");
});

test("identity collisions are UNKNOWN even with RAM continuity", () => {
  const stored = [storedConversation("A", "tail", "a"), storedConversation("A", "other", "b")];
  const row = inventoryRow("A", "tail", 0);
  const bindings = new Map([[row.observed_row.ram_key, "b"]]);
  assert.equal(planInboxReconciliation([row], stored, bindings)[0].identity, "UNKNOWN");
  assert.ok(planInboxReconciliation([row, row], stored).every(item => item.identity === "UNKNOWN"));
  const rows = [row, inventoryRow("A", "tail...", 1)];
  const duplicateBindings = new Map(rows.map(entry => [entry.observed_row.ram_key, "a"]));
  assert.ok(planInboxReconciliation(rows, stored, duplicateBindings).every(item => item.identity === "UNKNOWN"));
});

test("known row without observable content uses bounded delta, not an unchanged claim", () => {
  const row = inventoryRow("A", "", 0);
  row.observed_row.ram_key = JSON.stringify({ texts: ["A"] });
  const [item] = planInboxReconciliation([row], [storedConversation("A", "tail", "a")],
    new Map([[row.observed_row.ram_key, "a"]]));
  assert.equal(item.identity, "KNOWN");
  assert.equal(item.content, "CONTENT_UNKNOWN");
  assert.equal(item.action, "KNOWN_DELTA");
});

test("UNKNOWN singleton does not prevent known delta, unchanged skip or Match reconciliation", async () => {
  const stored = [storedConversation("S", "emoji", "s"), storedConversation("A", "tail", "a"),
    storedConversation("B", "stable", "b")];
  const rows = [inventoryRow("S", "different", 0),
    { ...inventoryRow("A", "tail", 1), last_message_visible_time: "new label" }, inventoryRow("B", "stable", 2)];
  const calls = [];
  const bindings = new Map([["obsolete", "a"]]);
  const inbox = { readSourceXml: async () => {}, readInboxInventory: async () => ({ inventory: rows }),
    readStoredConversations: async () => stored, updateInboxPosition: async () => {},
    locateInventoryRow: async entry => entry.observed_row,
    readUnboundChanged: async () => { calls.push("unknown"); return { outcome: "AMBIGUOUS" }; },
    readKnownChanged: async ({ conversationId }) => {
      calls.push(conversationId); return { outcome: "KNOWN_CHANGED", conversation_id: conversationId };
    } };
  const matches = { observeMatchInventory: async () => ({}),
    reconcileMatchInventory: async () => { calls.push("matches"); return { updates: 1, unresolved: 0 }; } };
  const result = await reconcileExistingTinderMirror(inbox, matches, bindings);
  assert.deepEqual(calls, ["matches", "unknown", "a"]);
  assert.equal(result.status, "RECONCILIATION_PARTIAL");
  assert.equal(result.known, 2);
  assert.equal(result.unknown, 1);
  assert.equal(result.thread_opens, 2);
  assert.equal(result.profile_reads, 0);
  assert.equal(result.history_reads, 0);
  assert.equal(result.match_tile_opens, 0);
  assert.equal(bindings.has("obsolete"), false);
  assert.equal(bindings.get(rows[1].observed_row.ram_key), "a");
  assert.equal(bindings.has(rows[0].observed_row.ram_key), false);
});

test("bounded changed/reordered revalidation keeps ID and next unchanged cycle has zero detail work", async () => {
  const stored = [storedConversation("A", "old", "a"), storedConversation("B", "stable", "b")];
  const rows = [inventoryRow("A", "new", 0), inventoryRow("B", "stable", 1)];
  let opens = 0;
  const inbox = { readSourceXml: async () => {}, readInboxInventory: async () => ({ inventory: rows }),
    readStoredConversations: async () => stored, updateInboxPosition: async () => {},
    locateInventoryRow: async entry => entry.observed_row,
    readUnboundChanged: async () => { opens++; stored[0].messages.push({ direction: "INBOUND", text: "new" });
      return { outcome: "KNOWN_CHANGED", conversation_id: "a" }; } };
  const matches = { observeMatchInventory: async () => ({}), reconcileMatchInventory: async () => ({ updates: 0, unresolved: 0 }) };
  const bindings = new Map();
  const first = await reconcileExistingTinderMirror(inbox, matches, bindings);
  const second = await reconcileExistingTinderMirror(inbox, matches, bindings);
  assert.equal(first.thread_opens, 1);
  assert.equal(second.thread_opens, 0);
  assert.equal(second.observed_unchanged, 2);
  assert.equal(second.status, "RECONCILED");
  assert.equal(opens, 1);
  assert.deepEqual(stored.map(item => item.conversation.id), ["a", "b"]);
});

test("executor passes the same existing RAM binding map into reconciliation, never into a new runtime", async () => {
  const maps = [];
  const runtime = { deviceId: "device", readSourceXml: async () => "", readKnownChanged() {}, readNewThread() {},
    readMatchDiscovery() {}, reconcile: async bindings => { maps.push(bindings); return { status: "RECONCILED" }; } };
  const executor = createLocalTinderDiscoveryExecutor({ runtime });
  await executor.initialize();
  maps[0].set("current", "a");
  await executor.initialize();
  assert.equal(maps[0], maps[1]);
  assert.equal(executor.localBindingCount(), 1);
  await createLocalTinderDiscoveryExecutor({ runtime }).initialize();
  assert.notEqual(maps[2], maps[0]);
  assert.equal(maps[2].size, 0);
});

test("mirror comparison after restart skips unchanged reordered rows, not name-only changed candidates", () => {
  const stored = [storedConversation("A", "last A", "a"), storedConversation("B", "last B", "b")];
  const plan = planInboxReconciliation([inventoryRow("B", "last B", 0), inventoryRow("A", "new A", 1), inventoryRow("C", "new C", 2)], stored);
  assert.deepEqual(plan.map(item => item.action), ["UNCHANGED", "REVALIDATE", "REVALIDATE"]);
  assert.equal(plan[0].conversation.id, "b");
  assert.equal(plan[1].conversation, undefined);
  assert.equal(planInboxReconciliation([inventoryRow("A", "last A", 0)], [...stored, stored[0]])[0].action, "AMBIGUOUS");
});

test("unchanged outgoing preview accepts the production API direction vocabulary", () => {
  const stored = storedConversation("A", "existing outgoing message", "a");
  const row = inventoryRow("A", "↩existing outgoing message", 0);
  for (const direction of ["OUTBOUND", "outbound"]) {
    stored.messages[0].direction = direction;
    assert.equal(planInboxReconciliation([row], [stored])[0].action, "UNCHANGED");
  }
  stored.messages[0].direction = "INBOUND";
  assert.equal(planInboxReconciliation([row], [stored])[0].action, "REVALIDATE");
});

test("unchanged legacy entities compare with live Unicode without rewriting stored Messages", () => {
  const stored = storedConversation("A", "Hello &#x1F60A; &amp; goodbye", "a");
  const original = JSON.stringify(stored);
  assert.equal(planInboxReconciliation([inventoryRow("A", "Hello 😊 & goodbye", 0)], [stored])[0].action, "UNCHANGED");
  assert.equal(planInboxReconciliation([inventoryRow("A", "Hello 😊 & changed", 0)], [stored])[0].action, "REVALIDATE");
  assert.equal(planInboxReconciliation([inventoryRow("A", "Hello &#x1F60A; &amp; goodbye", 0)], [stored])[0].action, "REVALIDATE");
  assert.equal(JSON.stringify(stored), original);
  stored.messages[0].text = "Native 🫣 emoji";
  assert.equal(planInboxReconciliation([inventoryRow("A", "Native 🫣 emoji", 0)], [stored])[0].action, "UNCHANGED");
});

test("unchanged reconciliation inventories both surfaces with zero detail reads", async () => {
  const calls = [];
  const inbox = {
    readSourceXml: async () => calls.push("source"),
    readInboxInventory: async () => ({ inventory: [inventoryRow("A", "tail", 0)] }),
    readStoredConversations: async () => [storedConversation("A", "tail", "a")],
    updateInboxPosition: async () => false,
    locateInventoryRow: async () => assert.fail("No candidate should open")
  };
  const matches = { observeMatchInventory: async () => { calls.push("carousel"); return {}; },
    reconcileMatchInventory: async () => ({ updates: 0, unresolved: 0 }) };
  const result = await reconcileExistingTinderMirror(inbox, matches);
  assert.deepEqual(calls, ["source", "carousel"]);
  assert.equal(result.status, "RECONCILED");
  for (const field of ["thread_opens", "profile_reads", "history_reads", "match_tile_opens"]) assert.equal(result[field], 0);
});

test("UNKNOWN without a name candidate is bounded revalidation, not an invented new Conversation", async () => {
  const calls = [];
  const inbox = { readSourceXml: async () => {},
    readInboxInventory: async () => ({ inventory: [inventoryRow("A", "new tail", 0), inventoryRow("B", "new thread", 1)] }),
    readStoredConversations: async () => [storedConversation("A", "old tail", "a")],
    updateInboxPosition: async () => {}, locateInventoryRow: async entry => entry,
    readUnboundChanged: async ({ row }) => { calls.push("bounded"); return row.inbox_position === 0
      ? { outcome: "KNOWN_CHANGED", conversation_id: "a" } : { outcome: "AMBIGUOUS" }; },
    readNewThread: async () => assert.fail("UNKNOWN cannot create a Conversation") };
  const result = await reconcileExistingTinderMirror(inbox, { observeMatchInventory: async () => ({}),
    reconcileMatchInventory: async () => ({ updates: 1, unresolved: 0 }) });
  assert.deepEqual(calls, ["bounded", "bounded"]);
  assert.equal(result.thread_opens, 2);
  assert.equal(result.profile_reads, 0);
  assert.equal(result.history_reads, 0);
  assert.equal(result.unknown, 1);
  assert.equal(result.match_tile_opens, 0);
});

test("timer is configurable, bounded, coalesced with hints, and cannot pile up slow inventory ticks", async () => {
  let tick, interval, released;
  let inspections = 0, active = 0, maxActive = 0;
  const blocked = new Promise(resolve => { released = resolve; });
  const dispatcher = createTinderPossibleChangeDispatcher({ readSourceXml: async () => "", debounceMilliseconds: 0,
    reconcile: async () => { inspections += 1; active += 1; maxActive = Math.max(maxActive, active);
      if (inspections === 1) await blocked;
      active -= 1; return { status: "RECONCILED" }; } });
  const timer = startReconciliationTimer({ dispatcher, deviceId: "test", environment: { TINDER_RECONCILIATION_INTERVAL_MS: "15000" },
    setIntervalFn: (callback, ms) => { tick = callback; interval = ms; return 1; }, clearIntervalFn: () => {} });
  tick();
  await new Promise(resolve => setTimeout(resolve, 10));
  tick(); tick();
  const hint = dispatcher.signal();
  dispatcher.signal();
  released();
  await hint; await timer.stop();
  assert.equal(interval, 15000);
  assert.equal(inspections, 2);
  assert.equal(maxActive, 1);
  assert.throws(() => startReconciliationTimer({ environment: { TINDER_RECONCILIATION_INTERVAL_MS: "1" } }), /15000/);
});

function fixture({ devices = "local\tdevice", existing = null } = {}) {
  const calls = [];
  return {
    calls,
    run: async (_file, args) => ({ stdout: args[0] === "devices" ? devices : "versionCode=140 minSdk=24" }),
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === "POST") return { ok: true, json: async () => ({ value: { sessionId: "created" } }) };
      if (options.method === "DELETE") return { ok: true, json: async () => ({ value: null }) };
      return { ok: Boolean(existing), json: async () => ({ value: existing || { error: "invalid session id" } }) };
    }
  };
}

test("RAM-only tunnel rewrite retains credentials, database and TLS options", () => {
  const env = { DATABASE_URL: "postgres://user:dummy@postgres.railway.internal/db?sslmode=verify-full", TINDER_DATABASE_TUNNEL_PORT: "15433" };
  const url = new URL(workerConnectionString(env));
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.port, "15433");
  assert.equal(url.password, "dummy");
  assert.equal(url.pathname, "/db");
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
  assert.match(env.DATABASE_URL, /postgres\.railway\.internal/u);
  assert.throws(() => workerConnectionString({ ...env, TINDER_DATABASE_TUNNEL_PORT: "0" }));
});

test("missing session uses standard existing server and installed Bridge version, without launching/resetting app", async () => {
  const f = fixture();
  const runtime = await prepareLocalAppiumRuntime({}, f);
  assert.equal(runtime.environment.TINDER_DEVICE_VERSION_CODE, "140");
  assert.equal(runtime.environment.APPIUM_SESSION, "created");
  const caps = JSON.parse(f.calls[0].options.body).capabilities.alwaysMatch;
  assert.equal(caps["appium:autoLaunch"], false);
  assert.equal(caps["appium:fullReset"], false);
  assert.equal(caps["appium:noReset"], true);
  assert.equal(caps["appium:udid"], "local");
  await runtime.close();
  await runtime.close();
  assert.equal(f.calls.filter(c => c.options.method === "DELETE").length, 1);
});

test("valid supplied session reused and not deleted; version comes from device", async () => {
  const f = fixture({ existing: { "appium:udid": "local" } });
  const runtime = await prepareLocalAppiumRuntime({ APPIUM_SESSION: "existing", TINDER_DEVICE_VERSION_CODE: "old" }, f);
  assert.equal(runtime.environment.APPIUM_SESSION, "existing");
  assert.equal(runtime.environment.TINDER_DEVICE_VERSION_CODE, "140");
  await runtime.close();
  assert.equal(f.calls.length, 1);
});

test("expired session replaced using regular lifecycle", async () => {
  const f = fixture();
  const runtime = await prepareLocalAppiumRuntime({ APPIUM_SESSION: "expired" }, f);
  assert.equal(runtime.environment.APPIUM_SESSION, "created");
  await runtime.close();
});

test("multiple devices and mismatched existing session do not select a device by guess", async () => {
  const multiple = fixture({ devices: "a\tdevice\nb\tdevice" });
  await assert.rejects(prepareLocalAppiumRuntime({}, multiple), /unique/u);
  assert.equal(multiple.calls.length, 0);
  await assert.rejects(prepareLocalAppiumRuntime({ APPIUM_SESSION: "existing" }, fixture({ existing: { udid: "other" } })), /does not target/u);
});

test("Railway secrets are not inherited by ADB subprocesses", async () => {
  const f = fixture();
  const runtime = await prepareLocalAppiumRuntime({
    DATABASE_URL: "private", DASHBOARD_API_SECRET: "private", RAILWAY_TOKEN: "private", SystemRoot: "C:\\Windows"
  }, { ...f, run: async (file, args, options) => {
    assert.deepEqual(options.env, { SystemRoot: "C:\\Windows" });
    return f.run(file, args);
  } });
  await runtime.close();
});
