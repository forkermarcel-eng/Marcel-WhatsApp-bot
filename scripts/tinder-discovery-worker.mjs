import { PgBoss } from "pg-boss";
import { pathToFileURL } from "node:url";
import { createExistingLocalTinderDiscoveryRuntime } from "../tinder-mirror/local-appium-discovery-runtime.js";
import { createLocalTinderDiscoveryExecutor } from "../tinder-mirror/local-discovery-executor.js";
import { createTinderDiscoveryPgBoss } from "../tinder-mirror/pg-boss-discovery.js";
import { startTinderDiscoveryWorker } from "../tinder-mirror/pg-boss-worker.js";

function requiredEnvironment(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  return value;
}

function reconciliationInterval(environment) {
  const milliseconds = Number(environment.TINDER_RECONCILIATION_INTERVAL_MS || 20000);
  if (!Number.isInteger(milliseconds) || milliseconds < 15000 || milliseconds > 30000) {
    throw new Error("TINDER_RECONCILIATION_INTERVAL_MS must be 15000..30000");
  }
  return milliseconds;
}

export function startReconciliationTimer({ dispatcher, deviceId, environment = {}, onResult = () => {},
  onError = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  const milliseconds = reconciliationInterval(environment);
  let active = null;
  const timer = setIntervalFn(() => {
    // Slow inventories do not accumulate timer work. A real hint still uses
    // the dispatcher's existing pending-change coalescing during this call.
    if (active) return;
    active = Promise.resolve().then(() => dispatcher.signal({ device_id: deviceId }))
      .then(onResult).catch(onError).finally(() => { active = null; });
  }, milliseconds);
  return { milliseconds, async stop() { clearIntervalFn(timer); await active; } };
}

/*
 * Run only on the Windows host with the existing Appium server. Its
 * DATABASE_URL must point at the existing Railway SSH tunnel; this script
 * does not create a public database proxy or a tunnel. The existing local
 * runtime reuses or creates a standard session on that same Appium server.
 */
export async function startLocalTinderDiscoveryWorker(environment = process.env) {
  reconciliationInterval(environment);
  const connectionString = workerConnectionString(environment);
  const boss = createTinderDiscoveryPgBoss(PgBoss, { connectionString });
  boss.on("error", () => console.error("Tinder discovery transport error (details suppressed)."));
  let runtime;
  try {
    await boss.start();
    runtime = await createExistingLocalTinderDiscoveryRuntime(environment);
    const dispatcher = createLocalTinderDiscoveryExecutor({ runtime });
    const initial = await dispatcher.initialize();
    console.log(JSON.stringify({ worker_initial_discovery: initial }));
    if (initial.status === "SOURCE_UNAVAILABLE") throw new Error("Initial Tinder Inbox unavailable");
    const worker = await startTinderDiscoveryWorker({ boss, dispatcher,
      onResult: result => console.log(JSON.stringify({ discovery_job_result: result }))
    });
    const reconciliation = startReconciliationTimer({ dispatcher, deviceId: runtime.deviceId, environment,
      onResult: result => console.log(JSON.stringify({ reconciliation_result: result })),
      onError: () => console.error("Tinder reconciliation failed (details suppressed).") });
    return Object.freeze({
      async stop() {
        await reconciliation.stop();
        await worker.stop();
        await boss.stop();
        await runtime.close();
      }
    });
  } catch (error) {
    await boss.stop().catch(() => {});
    await runtime?.close().catch(() => {});
    throw error;
  }
}

// Change only host/port in RAM; retain credentials and all existing TLS options.
export function workerConnectionString(environment) {
  const original = requiredEnvironment(environment.DATABASE_URL, "DATABASE_URL");
  if (!environment.TINDER_DATABASE_TUNNEL_PORT) return original;
  const port = Number(environment.TINDER_DATABASE_TUNNEL_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid local database tunnel port");
  const url = new URL(original);
  url.hostname = "127.0.0.1";
  url.port = String(port);
  return url.href;
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedAsScript) {
  let running;
  try {
    running = await startLocalTinderDiscoveryWorker();
  } catch {
    console.error("Tinder discovery worker startup failed (details suppressed).");
    process.exitCode = 1;
  }
  if (running) {
    console.log("Tinder discovery worker started (polling the existing Railway SSH tunnel).");
    const stop = async () => {
      await running.stop();
      process.exitCode = 0;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  }
}
