import { createTinderLocalDiscoveryRuntime } from "../scripts/tinder-block2-initial-sync.mjs";
import { createTinderLocalMatchDiscoveryRuntime } from "../scripts/tinder-block2-match-initial-sync.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { planInboxReconciliation } from "./local-discovery-executor.js";
import { createExistingProcessMatch } from "./local-process-match.js";

// Observed UI state only, never a person/Conversation identifier. Geometry
// and Inbox position deliberately do not make an unchanged row new work.
const unresolvedRowState = entry => JSON.stringify({
  texts: JSON.parse(entry.observed_row.ram_key).texts,
  time: entry.last_message_visible_time ?? null
});

export async function reconcileExistingTinderMirror(inbox, matches, directBindings = new Map(), checkedUnknown = new Set()) {
  const metrics = { status: "RECONCILED", thread_opens: 0, profile_reads: 0, history_reads: 0,
    match_tile_opens: 0, match_updates: 0, candidates: 0, ambiguous: 0, inbox_rows: 0,
    known: 0, unknown: 0, observed_unchanged: 0, observed_changed: 0, content_unknown: 0,
    unknown_unchanged_skipped: 0 };
  await inbox.readSourceXml();
  // Both inventories happen before any detail work or product writes.
  const carousel = await matches.observeMatchInventory();
  const discovery = await inbox.readInboxInventory();
  const stored = await inbox.readStoredConversations();
  // Exact current RAM keys only. Never carry a binding through a changed key,
  // infer it from an Inbox position, or reconstruct it across worker restart.
  for (const [key, id] of directBindings) {
    if (discovery.inventory.filter(entry => entry.observed_row.ram_key === key).length !== 1
      || !stored.some(item => item.conversation.id === id)) directBindings.delete(key);
  }
  const plan = planInboxReconciliation(discovery.inventory, stored, directBindings);
  const states = plan.map(item => unresolvedRowState(item.entry));
  for (const state of checkedUnknown) {
    if (states.filter(value => value === state).length !== 1) checkedUnknown.delete(state);
  }
  metrics.inbox_rows = plan.length;
  const matchResult = await matches.reconcileMatchInventory(carousel);
  metrics.match_updates = matchResult.updates;
  if(matchResult.lifecycle)metrics.match_lifecycle=matchResult.lifecycle;
  metrics.ambiguous += matchResult.unresolved;
  const represented = new Set();
  async function missingAvatar(entry,id) {
    const detail=stored.find(item=>item.conversation.id===id);
    if(detail?.media?.avatar_url || !inbox.captureConversationAvatar)return;
    const result=await inbox.captureConversationAvatar(entry,id);
    if(result)metrics.avatar_updates=(metrics.avatar_updates||0)+(result.status==="AVATAR_INGESTED"?1:0);
  }
  // Reserve every confirmed ID before processing any UNKNOWN, regardless of
  // Inbox order. Candidates remain ordinary objects in this run's RAM only.
  const reserved = new Set(plan.filter(item => item.identity === "KNOWN").map(item => item.conversation.id));
  for (const item of plan) {
    const state = unresolvedRowState(item.entry);
    if (item.identity === "KNOWN") checkedUnknown.delete(state);
    if (item.action === "AMBIGUOUS") {
      directBindings.delete(item.entry.observed_row.ram_key);
      metrics.ambiguous += 1; metrics.unknown += 1; continue;
    }
    if (item.action === "UNCHANGED") {
      metrics.known += 1;
      metrics.observed_unchanged += 1;
      represented.add(item.conversation.id);
      await inbox.updateInboxPosition(item.conversation, item.entry);
      await missingAvatar(item.entry,item.conversation.id);
      continue;
    }
    if (item.identity === "UNKNOWN" && checkedUnknown.has(state)) {
      metrics.unknown += 1;
      metrics.ambiguous += 1;
      metrics.unknown_unchanged_skipped += 1;
      continue;
    }
    metrics.candidates += 1;
    const row = await inbox.locateInventoryRow(item.entry);
    const result = item.identity === "KNOWN"
      ? await inbox.readKnownChanged({ row, conversationId: item.conversation.id })
      : await inbox.readUnboundChanged({ row,
        candidates: stored.filter(candidate => !reserved.has(candidate.conversation.id)
          && !represented.has(candidate.conversation.id)) });
    metrics.thread_opens += 1;
    metrics.profile_reads += result.profile_reads || 0;
    if (result.conversation_id) {
      checkedUnknown.delete(state);
      metrics.known += 1;
      if (item.content === "CONTENT_UNKNOWN") metrics.content_unknown += 1;
      else if (result.outcome === "UNCHANGED") metrics.observed_unchanged += 1;
      else metrics.observed_changed += 1;
      directBindings.set(item.entry.observed_row.ram_key, result.conversation_id);
      represented.add(result.conversation_id);
      await inbox.updateInboxPosition({ id: result.conversation_id }, item.entry);
      await missingAvatar(item.entry,result.conversation_id);
    } else {
      if (result.outcome === "AMBIGUOUS" && states.filter(value => value === state).length === 1) {
        checkedUnknown.add(state);
      }
      directBindings.delete(item.entry.observed_row.ram_key);
      metrics.ambiguous += 1; metrics.unknown += 1;
    }
  }
  metrics.unrepresented_stored = stored.filter(item => !represented.has(item.conversation.id)).length;
  if (metrics.ambiguous || metrics.unrepresented_stored) metrics.status = "RECONCILIATION_PARTIAL";
  return Object.freeze(metrics);
}

// The existing Appium server owns Android control. This only supplies the
// standard WebDriver session and installed Bridge metadata to both runners.
export async function prepareLocalAppiumRuntime(environment, {
  run = promisify(execFile), fetchImpl = fetch
} = {}) {
  // ADB needs local OS/SDK configuration, never Railway/database/API secrets.
  const childEnvironment = Object.fromEntries([
    "SystemRoot", "WINDIR", "PATH", "PATHEXT", "TEMP", "TMP",
    "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOMEDRIVE", "HOMEPATH",
    "ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_USER_HOME", "ADB_SERVER_SOCKET"
  ].filter(key => environment[key] !== undefined).map(key => [key, environment[key]]));
  const runOptions = { windowsHide: true, env: childEnvironment };
  const adb = environment.ADB_PATH || (environment.ANDROID_HOME
    ? join(environment.ANDROID_HOME, "platform-tools", "adb.exe")
    : join(environment.LOCALAPPDATA || "", "Android", "Sdk", "platform-tools", "adb.exe"));
  const { stdout } = await run(adb, ["devices"], runOptions);
  const devices = stdout.split(/\r?\n/u).map(line => line.trim().split(/\s+/u))
    .filter(parts => parts[1] === "device").map(parts => parts[0]);
  const serial = environment.ANDROID_SERIAL || (devices.length === 1 ? devices[0] : null);
  if (!serial || !devices.includes(serial)) throw new Error("A unique authorized local Android device is required");
  const installed = await run(adb, ["-s", serial, "shell", "dumpsys", "package", "com.marcel.androidbridge"], runOptions);
  const version = installed.stdout.match(/\bversionCode=(\d+)\b/u)?.[1];
  if (!version) throw new Error("Installed Bridge version unavailable");
  const base = (environment.APPIUM_BASE_URL || "http://127.0.0.1:4723/wd/hub").replace(/\/+$/u, "");
  async function request(path, options = {}) {
    const response = await fetchImpl(`${base}${path}`, options);
    const body = await response.json();
    return { ok: response.ok && !body?.value?.error, body };
  }
  let session = environment.APPIUM_SESSION;
  let owned = false;
  if (session) {
    const current = await request(`/session/${encodeURIComponent(session)}`);
    if (current.ok) {
      const caps = current.body.value;
      if ((caps["appium:udid"] || caps.udid) !== serial) {
        throw new Error("Existing Appium session does not target the connected device");
      }
    } else if (current.body?.value?.error === "invalid session id") {
      session = null;
    } else {
      throw new Error("Existing Appium session could not be verified");
    }
  }
  if (!session) {
    const created = await request("/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capabilities: { alwaysMatch: {
        platformName: "Android", "appium:automationName": "UiAutomator2",
        "appium:udid": serial, "appium:noReset": true,
        "appium:fullReset": false, "appium:autoLaunch": false,
        "appium:newCommandTimeout": 0
      }, firstMatch: [{}] } })
    });
    session = created.body?.value?.sessionId;
    if (!created.ok || !session) throw new Error("Existing Appium server could not create a local session");
    owned = true;
  }
  return {
    environment: { ...environment, APPIUM_SESSION: session, TINDER_DEVICE_VERSION_CODE: version },
    async close() {
      if (owned) {
        const deleted = await request(`/session/${encodeURIComponent(session)}`, { method: "DELETE" });
        if (!deleted.ok) throw new Error("Owned Appium session cleanup failed");
        owned = false;
      }
    }
  };
}

/*
 * Compose only the existing Block-2 Appium runner capabilities. There is no
 * second Android controller: Inbox/chat operations remain in the existing
 * initial-sync runner and Match observation remains in its existing runner.
 */
export async function createExistingLocalTinderDiscoveryRuntime(environment = process.env) {
  const local = await prepareLocalAppiumRuntime(environment);
  try {
    const [inbox, matches] = await Promise.all([
      createTinderLocalDiscoveryRuntime(local.environment),
      createTinderLocalMatchDiscoveryRuntime(local.environment)
    ]);
    if (inbox.deviceId !== matches.deviceId) {
      throw new Error("Existing local Tinder runners resolved different devices");
    }
    const checkedUnknown = new Set();
    return Object.freeze({
      close: local.close,
      reconcile: directBindings => reconcileExistingTinderMirror(inbox, matches, directBindings, checkedUnknown),
      deviceId: inbox.deviceId,
      processMatch:createExistingProcessMatch({environment:local.environment,deviceId:inbox.deviceId}),
      readSourceXml: inbox.readSourceXml,
      readKnownChanged: inbox.readKnownChanged,
      readUnboundChanged: inbox.readUnboundChanged,
      readNewThread: inbox.readNewThread,
      readMatchDiscovery: () => matches.readMatchDiscovery()
    });
  } catch (error) {
    await local.close();
    throw error;
  }
}
