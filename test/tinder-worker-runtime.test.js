import test from "node:test";
import assert from "node:assert/strict";
import { prepareLocalAppiumRuntime, reconcileExistingTinderMirror } from "../tinder-mirror/local-appium-discovery-runtime.js";
import { workerConnectionString, startReconciliationTimer } from "../scripts/tinder-discovery-worker.mjs";
import { planInboxReconciliation } from "../tinder-mirror/local-discovery-executor.js";
import { createTinderPossibleChangeDispatcher } from "../tinder-mirror/possible-change-dispatch.js";

const inventoryRow = (name, preview, position) => ({ inbox_position: position,
  observed_row: { ram_key: JSON.stringify({ texts: [name, preview] }) } });
const storedConversation = (name, preview, id) => ({ conversation: { id, profile: { display_name: name } },
  messages: [{ direction: "inbound", text: preview }] });

test("mirror comparison after restart skips unchanged reordered rows, not name-only changed candidates", () => {
  const stored = [storedConversation("A", "last A", "a"), storedConversation("B", "last B", "b")];
  const plan = planInboxReconciliation([inventoryRow("B", "last B", 0), inventoryRow("A", "new A", 1), inventoryRow("C", "new C", 2)], stored);
  assert.deepEqual(plan.map(item => item.action), ["UNCHANGED", "REVALIDATE", "INITIAL_READ"]);
  assert.equal(plan[0].conversation.id, "b");
  assert.equal(plan[1].conversation, undefined);
  assert.equal(planInboxReconciliation([inventoryRow("A", "last A", 0)], [...stored, stored[0]])[0].action, "AMBIGUOUS");
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

test("reconciliation calls only one existing delta routine and one existing new-thread routine", async () => {
  const calls = [];
  const inbox = { readSourceXml: async () => {},
    readInboxInventory: async () => ({ inventory: [inventoryRow("A", "new tail", 0), inventoryRow("B", "new thread", 1)] }),
    readStoredConversations: async () => [storedConversation("A", "old tail", "a")],
    updateInboxPosition: async () => {}, locateInventoryRow: async entry => entry,
    readUnboundChanged: async () => { calls.push("delta"); return { outcome: "KNOWN_CHANGED", conversation_id: "a" }; },
    readNewThread: async () => { calls.push("initial"); return { outcome: "NEW_THREAD", conversation_id: "b" }; } };
  const result = await reconcileExistingTinderMirror(inbox, { observeMatchInventory: async () => ({}),
    reconcileMatchInventory: async () => ({ updates: 1, unresolved: 0 }) });
  assert.deepEqual(calls, ["delta", "initial"]);
  assert.equal(result.thread_opens, 2);
  assert.equal(result.profile_reads, 1);
  assert.equal(result.history_reads, 1);
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
