import { createTinderLocalDiscoveryRuntime } from "../scripts/tinder-block2-initial-sync.mjs";
import { createTinderLocalMatchDiscoveryRuntime } from "../scripts/tinder-block2-match-initial-sync.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

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
    return Object.freeze({
      close: local.close,
      deviceId: inbox.deviceId,
      readSourceXml: inbox.readSourceXml,
      readKnownChanged: inbox.readKnownChanged,
      readUnboundChanged: inbox.readUnboundChanged,
      readNewThread: inbox.readNewThread,
      readMatchDiscovery: matches.readMatchDiscovery
    });
  } catch (error) {
    await local.close();
    throw error;
  }
}
