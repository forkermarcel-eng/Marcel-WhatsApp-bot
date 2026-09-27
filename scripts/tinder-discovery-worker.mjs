import { PgBoss } from "pg-boss";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { createExistingLocalTinderDiscoveryRuntime } from "../tinder-mirror/local-appium-discovery-runtime.js";
import { createLocalTinderDiscoveryExecutor } from "../tinder-mirror/local-discovery-executor.js";
import { createTinderDiscoveryPgBoss } from "../tinder-mirror/pg-boss-discovery.js";
import { startTinderDiscoveryWorker } from "../tinder-mirror/pg-boss-worker.js";

function requiredEnvironment(value, name) {
  if (typeof value !== "string" || !value) throw new Error(`${name} is required`);
  return value;
}

export function startWorkerTunnel(environment, { spawnFn = spawn, setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout, report = console.log } = {}) {
  if (!environment.TINDER_SSH_TARGET) return null;
  const port = Number(environment.TINDER_DATABASE_TUNNEL_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535
    || !/^[a-zA-Z0-9-]+@ssh\.railway\.com$/u.test(environment.TINDER_SSH_TARGET)) {
    throw new Error("Invalid existing Railway SSH tunnel configuration");
  }
  const identity = requiredEnvironment(environment.TINDER_SSH_IDENTITY_FILE, "TINDER_SSH_IDENTITY_FILE");
  const env = Object.fromEntries(["SystemRoot", "WINDIR", "PATH", "PATHEXT", "USERPROFILE",
    "HOME", "TEMP", "TMP"].filter(key => environment[key] !== undefined).map(key => [key, environment[key]]));
  let child, retry, stopped = false;
  function launch() {
    if (stopped) return;
    const current = spawnFn("ssh.exe", ["-N", "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=3",
      "-i", identity, "-L", `127.0.0.1:${port}:127.0.0.1:5432`, environment.TINDER_SSH_TARGET],
    { windowsHide: true, env, stdio: "ignore" });
    child = current;
    let ended = false;
    function lost(code) {
      if (ended) return;
      ended = true;
      if (child === current) child = null;
      if (stopped) return;
      report(JSON.stringify({ ssh_tunnel: "DISCONNECTED", exit_code: Number.isInteger(code) ? code : null }));
      retry = setTimeoutFn(() => { retry = null; launch(); }, 5000);
    }
    current.once("error", () => lost(null));
    current.once("exit", lost);
  }
  launch();
  return { stop() { stopped = true; if (retry) clearTimeoutFn(retry); child?.kill(); } };
}

async function waitForTunnel(port) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const available = await new Promise(resolve => {
      const socket = connect({ host: "127.0.0.1", port: Number(port) });
      const finish = value => { socket.destroy(); resolve(value); };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(500, () => finish(false));
    });
    if (available) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Existing Railway SSH tunnel unavailable");
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
 * never creates a public database proxy. The optional existing SSH process
 * is owned and restarted with this worker. The existing local
 * runtime reuses or creates a standard session on that same Appium server.
 */
export async function startLocalTinderDiscoveryWorker(environment = process.env) {
  reconciliationInterval(environment);
  const connectionString = workerConnectionString(environment);
  const boss = createTinderDiscoveryPgBoss(PgBoss, { connectionString });
  boss.on("error", () => console.error("Tinder discovery transport error (details suppressed)."));
  let runtime;
  const tunnel = startWorkerTunnel(environment);
  try {
    if (tunnel) await waitForTunnel(environment.TINDER_DATABASE_TUNNEL_PORT);
    await boss.start();
    runtime = await createExistingLocalTinderDiscoveryRuntime(environment);
    const dispatcher = createLocalTinderDiscoveryExecutor({ runtime });
    const initial = await dispatcher.initialize();
    console.log(JSON.stringify({ worker_initial_discovery: initial }));
    if (initial.status === "SOURCE_UNAVAILABLE") throw new Error("Initial Tinder Inbox unavailable");
    const worker = await startTinderDiscoveryWorker({ boss, dispatcher,
      onResult: result => console.log(JSON.stringify({ discovery_job_result: result }))
    });
    console.log(JSON.stringify({ pgboss_consumer_registered: true }));
    const reconciliation = startReconciliationTimer({ dispatcher, deviceId: runtime.deviceId, environment,
      onResult: result => console.log(JSON.stringify({ reconciliation_result: result })),
      onError: () => console.error("Tinder reconciliation failed (details suppressed).") });
    return Object.freeze({
      async stop() {
        await reconciliation.stop();
        await worker.stop();
        await boss.stop();
        await runtime.close();
        tunnel?.stop();
      }
    });
  } catch (error) {
    await boss.stop().catch(() => {});
    await runtime?.close().catch(() => {});
    tunnel?.stop();
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
