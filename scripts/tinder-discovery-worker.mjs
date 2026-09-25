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

/*
 * Run only on the Windows host which already owns the Appium session. Its
 * DATABASE_URL must point at the existing Railway SSH tunnel; this script
 * does not create a public database proxy, a tunnel, or an Android session.
 */
export async function startLocalTinderDiscoveryWorker(environment = process.env) {
  const connectionString = requiredEnvironment(environment.DATABASE_URL, "DATABASE_URL");
  const boss = createTinderDiscoveryPgBoss(PgBoss, { connectionString });
  await boss.start();
  try {
    const runtime = await createExistingLocalTinderDiscoveryRuntime(environment);
    const dispatcher = createLocalTinderDiscoveryExecutor({ runtime });
    const worker = await startTinderDiscoveryWorker({ boss, dispatcher });
    return Object.freeze({
      async stop() {
        await worker.stop();
        await boss.stop();
      }
    });
  } catch (error) {
    await boss.stop().catch(() => {});
    throw error;
  }
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedAsScript) {
  const running = await startLocalTinderDiscoveryWorker();
  console.log("Tinder discovery worker started (polling the existing Railway SSH tunnel).");
  const stop = async () => {
    await running.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
