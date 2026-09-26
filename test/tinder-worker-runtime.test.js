import test from "node:test";
import assert from "node:assert/strict";
import { prepareLocalAppiumRuntime } from "../tinder-mirror/local-appium-discovery-runtime.js";
import { workerConnectionString } from "../scripts/tinder-discovery-worker.mjs";

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
