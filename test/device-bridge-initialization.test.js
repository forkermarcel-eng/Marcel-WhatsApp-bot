import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { initializeDeviceBridgeDatabase } from "../device-bridge/initialization.js";

function loggerRecorder() {
  const entries = [];
  return {
    entries,
    logger: {
      log(message) { entries.push({ level: "log", message }); },
      error(message) { entries.push({ level: "error", message }); }
    }
  };
}

test("successful Device Bridge DDL marks readiness only after completion", async () => {
  const events = [];
  const logs = loggerRecorder();
  const ready = await initializeDeviceBridgeDatabase({}, {
    ensureTables: async () => { events.push("ddl-complete"); },
    markReady: () => { events.push("ready"); },
    logger: logs.logger
  });

  assert.equal(ready, true);
  assert.deepEqual(events, ["ddl-complete", "ready"]);
  assert.deepEqual(logs.entries, [{
    level: "log",
    message: "Device Bridge T0 Protocol V1 database foundation ready."
  }]);
});

test("Device Bridge DDL failure remains not ready and logs no error details", async () => {
  let readinessCalls = 0;
  const logs = loggerRecorder();
  const ready = await initializeDeviceBridgeDatabase({}, {
    ensureTables: async () => { throw new Error("secret database detail"); },
    markReady: () => { readinessCalls += 1; },
    logger: logs.logger
  });

  assert.equal(ready, false);
  assert.equal(readinessCalls, 0);
  assert.deepEqual(logs.entries, [{
    level: "error",
    message: "Device Bridge T0 Protocol V1 database initialization failed."
  }]);
  assert.equal(JSON.stringify(logs.entries).includes("secret database detail"), false);
});

test("Device Bridge failure does not prevent following platform initialization", async () => {
  const events = [];
  await initializeDeviceBridgeDatabase({}, {
    ensureTables: async () => { events.push("device-ddl"); throw new Error("failed"); },
    markReady: () => { events.push("ready"); },
    logger: loggerRecorder().logger
  });
  events.push("platform-ddl");

  assert.deepEqual(events, ["device-ddl", "platform-ddl"]);
});

test("platform initialization failure remains visible outside Device Bridge isolation", async () => {
  await initializeDeviceBridgeDatabase({}, {
    ensureTables: async () => { throw new Error("device failure"); },
    markReady: () => assert.fail("must not become ready"),
    logger: loggerRecorder().logger
  });

  await assert.rejects(
    async () => { throw new Error("platform failure"); },
    /platform failure/
  );
});

test("index keeps platform initialization and startWhatsApp semantics outside isolation", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const deviceInit = source.indexOf("await initializeDeviceBridgeDatabase(pool)");
  const platformInit = source.indexOf("CREATE TABLE IF NOT EXISTS contacts", deviceInit);
  const listenerInit = source.indexOf("await initDatabase()", platformInit);
  const listenerCatch = source.indexOf("PostgreSQL Initialisierung fehlgeschlagen:", listenerInit);
  const whatsappStart = source.indexOf("startWhatsApp()", listenerCatch);

  assert.ok(deviceInit > -1);
  assert.ok(platformInit > deviceInit);
  assert.ok(listenerInit > platformInit);
  assert.ok(listenerCatch > listenerInit);
  assert.ok(whatsappStart > listenerCatch);
});

test("failed Device Bridge initialization leaves signed routes not ready", async () => {
  const readiness = await import(`../device-bridge/readiness.js?isolation=${Date.now()}`);
  await initializeDeviceBridgeDatabase({}, {
    ensureTables: async () => { throw new Error("failed"); },
    markReady: readiness.markDeviceBridgeReady,
    logger: loggerRecorder().logger
  });

  const response = {
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
  const allowed = readiness.requireDeviceBridgeReady(response);

  assert.equal(allowed, false);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error.code, "BACKEND_NOT_READY");
});
