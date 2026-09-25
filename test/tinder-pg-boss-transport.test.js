import assert from "node:assert/strict";
import test from "node:test";
import {
  TINDER_DISCOVERY_JOB_OPTIONS,
  TINDER_DISCOVERY_QUEUE,
  createTinderDiscoveryEnqueuer,
  createTinderDiscoveryPgBoss
} from "../tinder-mirror/pg-boss-discovery.js";
import { createLocalTinderDiscoveryExecutor } from "../tinder-mirror/local-discovery-executor.js";
import { startTinderDiscoveryWorker } from "../tinder-mirror/pg-boss-worker.js";
import { processTinderPossibleChangeTransaction } from "../device-bridge/tinder-change-hint.js";

const DEVICE_ID = "11111111-1111-4111-8111-111111111111";
const AUTH = Object.freeze({
  deviceId: DEVICE_ID,
  keyId: "22222222-2222-4222-8222-222222222222",
  requestId: "33333333-3333-4333-8333-333333333333",
  contentSha256: "a".repeat(64)
});

function source({ rows = ["Known A"], tiles = ["Match A"] } = {}) {
  const screenBottom = Math.max(1280, 720 + rows.length * 112);
  const rowXml = rows.map((text, index) => {
    const top = 520 + index * 112;
    const bottom = top + 108;
    return `<android.widget.FrameLayout bounds="[0,${top}][576,${bottom}]">
      <android.view.View clickable="true" bounds="[0,${top}][576,${bottom}]" />
      <android.widget.TextView text="${text}" bounds="[80,${top + 20}][500,${bottom - 20}]" />
    </android.widget.FrameLayout>`;
  }).join("");
  const tileXml = tiles.map((text, index) => {
    const left = 118 + index * 108;
    const right = left + 102;
    return `<android.widget.FrameLayout bounds="[${left},300][${right},488]">
      <android.widget.ImageView clickable="true" bounds="[${left + 4},304][${right - 4},402]" />
      <android.widget.TextView text="${text}" bounds="[${left + 4},416][${right - 4},472]" />
    </android.widget.FrameLayout>`;
  }).join("");
  return `<hierarchy rotation="0"><android.widget.FrameLayout bounds="[0,0][576,${screenBottom}]">
    <androidx.recyclerview.widget.RecyclerView bounds="[0,225][576,${screenBottom - 64}]">
      <android.widget.FrameLayout bounds="[0,289][576,509]">
        <androidx.recyclerview.widget.RecyclerView bounds="[0,289][576,509]">${tileXml}</androidx.recyclerview.widget.RecyclerView>
      </android.widget.FrameLayout>${rowXml}
    </androidx.recyclerview.widget.RecyclerView>
  </android.widget.FrameLayout></hierarchy>`;
}

function acceptedHintClient({ failEnqueue = false } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT d\.device_id/.test(sql)) {
        return { rows: [{ device_id: DEVICE_ID, enrollment_state: "ACTIVE", revoked_at: null, key_id: AUTH.keyId, key_revoked_at: null }] };
      }
      if (failEnqueue && sql === "SELECT queue insert") throw new Error("queue unavailable");
      return { rows: [] };
    },
    release() { this.released = true; }
  };
  return { calls, client, pool: { async connect() { return client; } } };
}

test("TEST A: accepted signed hint atomically enqueues exactly one content-free TINDER_DISCOVERY job", async () => {
  const database = acceptedHintClient();
  const sent = [];
  const enqueuer = createTinderDiscoveryEnqueuer({
    boss: {
      async sendDebounced(name, data, options, seconds, key) {
        sent.push({ name, data, options, seconds, key });
        // Demonstrate that pg-boss would write through the locked hint client.
        await options.db.executeSql("SELECT queue insert");
        return "job-1";
      }
    }
  });
  await processTinderPossibleChangeTransaction(
    database.pool,
    AUTH,
    { sent_at: "2026-09-25T10:00:00.000Z", event_type: "TINDER_POSSIBLE_CHANGE" },
    new Date("2026-09-25T10:00:00.000Z"),
    { enqueueInTransaction: (hint, options) => enqueuer.enqueue(hint, options) }
  );
  assert.deepEqual(sent.map(({ name, data, seconds, key }) => ({ name, data, seconds, key })), [{
    name: TINDER_DISCOVERY_QUEUE,
    data: { device_id: DEVICE_ID },
    seconds: 15,
    key: DEVICE_ID
  }]);
  assert.equal(sent[0].options.retryLimit, 0);
  assert.equal(sent[0].options.heartbeatSeconds, null);
  assert.deepEqual(Object.keys(sent[0].data), ["device_id"]);
  const commit = database.calls.findIndex(({ sql }) => sql === "COMMIT");
  const queueWrite = database.calls.findIndex(({ sql }) => sql === "SELECT queue insert");
  assert.ok(queueWrite >= 0 && queueWrite < commit);
  assert.equal(database.client.released, true);
});

test("an enqueue error rolls back the accepted hint transaction before it can commit", async () => {
  const database = acceptedHintClient({ failEnqueue: true });
  const enqueuer = createTinderDiscoveryEnqueuer({
    boss: {
      async sendDebounced(_name, _data, options) {
        await options.db.executeSql("SELECT queue insert");
      }
    }
  });
  await assert.rejects(
    processTinderPossibleChangeTransaction(
      database.pool,
      AUTH,
      { sent_at: "2026-09-25T10:00:00.000Z", event_type: "TINDER_POSSIBLE_CHANGE" },
      new Date("2026-09-25T10:00:00.000Z"),
      { enqueueInTransaction: (hint, options) => enqueuer.enqueue(hint, options) }
    ),
    /queue unavailable/
  );
  assert.equal(database.calls.some(({ sql }) => sql === "COMMIT"), false);
  assert.equal(database.calls.some(({ sql }) => sql === "ROLLBACK"), true);
});

test("TEST B: burst hints use pg-boss debouncing with one stable device key and no in-process queue", async () => {
  const sent = [];
  const enqueuer = createTinderDiscoveryEnqueuer({
    boss: {
      async sendDebounced(name, data, options, seconds, key) {
        sent.push({ name, data, options, seconds, key });
        // pg-boss's documented debounced singleton permits the immediate slot,
        // one next slot, then coalesces the rest for this key.
        return sent.length <= 2 ? `job-${sent.length}` : null;
      }
    }
  });
  const results = await Promise.all(Array.from({ length: 8 }, () => enqueuer.enqueue({
    device_id: DEVICE_ID,
    event_type: "TINDER_POSSIBLE_CHANGE"
  })));
  assert.deepEqual(results, ["job-1", "job-2", null, null, null, null, null, null]);
  assert.ok(sent.every((entry) => entry.name === TINDER_DISCOVERY_QUEUE && entry.key === DEVICE_ID));
  assert.ok(sent.every((entry) => entry.options.retryLimit === 0 && entry.options.heartbeatSeconds === null));
  assert.ok(sent.every((entry) => Object.keys(entry.data).length === 1 && entry.data.device_id === DEVICE_ID));
});

test("TEST C/H: the serial Windows worker dispatches a retained pre-start job exactly once after start", async () => {
  const queue = [{ id: "job-1", data: { device_id: DEVICE_ID } }];
  let callback;
  const offWorkCalls = [];
  const boss = {
    async work(name, options, handler) {
      assert.equal(name, TINDER_DISCOVERY_QUEUE);
      assert.deepEqual(options, { batchSize: 1, localConcurrency: 1, pollingIntervalSeconds: 2 });
      callback = handler;
      return "worker-1";
    },
    async offWork(...args) { offWorkCalls.push(args); }
  };
  const signals = [];
  const worker = await startTinderDiscoveryWorker({
    boss,
    dispatcher: { async signal(job) { signals.push(job); } }
  });
  assert.deepEqual(signals, []);
  // The job existed before work() was registered, so this models a worker
  // offline period. It is claimed only by the restarted local worker.
  await callback([queue.shift()]);
  assert.deepEqual(signals, [{ device_id: DEVICE_ID }]);
  await worker.stop();
  assert.deepEqual(offWorkCalls, [[TINDER_DISCOVERY_QUEUE, { id: "worker-1", wait: true }]]);
});

test("pg-boss runtime construction has no implicit schema migration or LISTEN/NOTIFY and only enables job lifecycle supervision", () => {
  let options;
  class FakeBoss {
    constructor(value) { options = value; }
  }
  createTinderDiscoveryPgBoss(FakeBoss, { connectionString: "postgres://tunnel/local" });
  assert.deepEqual(options, {
    schema: "pgboss",
    migrate: false,
    createSchema: false,
    supervise: true,
    schedule: false,
    reindex: false,
    persistWarnings: false,
    persistQueueStats: false,
    useListenNotify: false,
    connectionString: "postgres://tunnel/local"
  });
  assert.equal(TINDER_DISCOVERY_JOB_OPTIONS.retryLimit, 0);
  assert.equal(TINDER_DISCOVERY_JOB_OPTIONS.heartbeatSeconds, null);
});

test("discovery jobs reject unrelated pg-boss options", () => {
  assert.throws(
    () => createTinderDiscoveryEnqueuer({
      boss: { async sendDebounced() {} },
      jobOptions: { ...TINDER_DISCOVERY_JOB_OPTIONS, priority: 1 }
    }),
    /Only bounded Tinder discovery job lifecycle options/
  );
});

function localRuntime(sources, actions) {
  return {
    deviceId: DEVICE_ID,
    async readSourceXml() {
      const next = sources.shift();
      if (!next) throw new Error("No source fixture remains");
      return next;
    },
    async readKnownChanged(input) {
      actions.known.push(input);
      return { outcome: "KNOWN_CHANGED" };
    },
    async readNewThread(input) {
      actions.newThreads.push(input);
      return { outcome: "NEW_THREAD", conversation_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    },
    async readMatchDiscovery(input) {
      actions.matches.push(input);
      return { outcome: "MATCH_UPDATED" };
    }
  };
}

test("TEST D/I: one hundred unchanged rows and stable null/null source produce zero control actions", async () => {
  const actions = { known: [], newThreads: [], matches: [] };
  const rows = Array.from({ length: 100 }, (_, index) => `Known ${index}`);
  const executor = createLocalTinderDiscoveryExecutor({
    runtime: localRuntime([source({ rows }), source({ rows })], actions),
    debounceMilliseconds: 0
  });
  await executor.signal({ device_id: DEVICE_ID });
  const unchanged = await executor.signal({ device_id: DEVICE_ID });
  assert.equal(unchanged.thread_opens, 0);
  assert.equal(unchanged.profile_reads, 0);
  assert.equal(unchanged.history_reads, 0);
  assert.deepEqual(actions, { known: [], newThreads: [], matches: [] });
});

test("TEST E: a direct RAM-bound known change opens once and uses only the delta action", async () => {
  const actions = { known: [], newThreads: [], matches: [] };
  const executor = createLocalTinderDiscoveryExecutor({
    runtime: localRuntime([
      source({ rows: ["Known A"] }),
      source({ rows: ["Known A", "New B"] }),
      source({ rows: ["Known A", "New B changed"] })
    ], actions),
    debounceMilliseconds: 0
  });
  await executor.signal({ device_id: DEVICE_ID });
  await executor.signal({ device_id: DEVICE_ID });
  const result = await executor.signal({ device_id: DEVICE_ID });
  assert.equal(result.thread_opens, 1);
  assert.equal(result.profile_reads, 0);
  assert.equal(result.history_reads, 0);
  assert.equal(actions.newThreads.length, 1);
  assert.equal(actions.known.length, 1);
  assert.equal(actions.known[0].conversationId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});

test("TEST F: a new source row uses exactly one existing initial profile and full-history operation", async () => {
  const actions = { known: [], newThreads: [], matches: [] };
  const executor = createLocalTinderDiscoveryExecutor({
    runtime: localRuntime([
      source({ rows: ["Known A"] }),
      source({ rows: ["Known A", "New B"] })
    ], actions),
    debounceMilliseconds: 0
  });
  await executor.signal({ device_id: DEVICE_ID });
  const result = await executor.signal({ device_id: DEVICE_ID });
  assert.equal(result.thread_opens, 1);
  assert.equal(result.profile_reads, 1);
  assert.equal(result.history_reads, 1);
  assert.equal(actions.newThreads.length, 1);
  assert.equal(actions.known.length, 0);
});

test("TEST G: a Match source change uses existing Match discovery and opens no tile", async () => {
  const actions = { known: [], newThreads: [], matches: [] };
  const executor = createLocalTinderDiscoveryExecutor({
    runtime: localRuntime([
      source({ tiles: ["Match A", "Match B"] }),
      source({ tiles: ["Match A", "Match B", "Match C"] })
    ], actions),
    debounceMilliseconds: 0
  });
  await executor.signal({ device_id: DEVICE_ID });
  const result = await executor.signal({ device_id: DEVICE_ID });
  assert.equal(result.match_updates, 1);
  assert.equal(result.match_tile_opens, 0);
  assert.equal(actions.matches.length, 1);
});
