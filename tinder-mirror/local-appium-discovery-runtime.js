import { createTinderLocalDiscoveryRuntime } from "../scripts/tinder-block2-initial-sync.mjs";
import { createTinderLocalMatchDiscoveryRuntime } from "../scripts/tinder-block2-match-initial-sync.mjs";

/*
 * Compose only the existing Block-2 Appium runner capabilities. There is no
 * second Android controller: Inbox/chat operations remain in the existing
 * initial-sync runner and Match observation remains in its existing runner.
 */
export async function createExistingLocalTinderDiscoveryRuntime(environment = process.env) {
  const [inbox, matches] = await Promise.all([
    createTinderLocalDiscoveryRuntime(environment),
    createTinderLocalMatchDiscoveryRuntime(environment)
  ]);
  if (inbox.deviceId !== matches.deviceId) {
    throw new Error("Existing local Tinder runners resolved different devices");
  }
  return Object.freeze({
    deviceId: inbox.deviceId,
    readSourceXml: inbox.readSourceXml,
    readKnownChanged: inbox.readKnownChanged,
    readNewThread: inbox.readNewThread,
    readMatchDiscovery: matches.readMatchDiscovery
  });
}
