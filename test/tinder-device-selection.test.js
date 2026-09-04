import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../Tinder/index.html", import.meta.url), "utf8");

test("Tinder page provides a safe multi-device selection with no key material", () => {
  assert.match(page, /id="deviceSelection"/);
  assert.match(page, /id="deviceSelectionList"/);
  assert.match(page, /shortDeviceId/);
  assert.match(page, /Neueste Registrierung/);
  assert.match(page, /enrolled_at/);
  assert.match(page, /last_heartbeat_accepted_at/);
  assert.doesNotMatch(page, /device\.key_id/);
  assert.doesNotMatch(page, /device\.public_key/);
});

test("Tinder page polls command status for a full heartbeat interval plus ACK buffer", () => {
  assert.match(page, /for \(let attempt = 0; attempt < 31; attempt \+= 1\)/);
  assert.match(page, /if \(terminal\) return;/);
});

test("Android Tinder manual gate controls require a selected compatible device and stay separate from the legacy worker", () => {
  assert.match(page, /id="connectAndroidTinder"/);
  assert.match(page, /id="disconnectAndroidTinder"/);
  assert.match(page, /TINDER_MANUAL_GATE_COMMANDS/);
  assert.match(page, /tinder_manual_gate_capable === true/);
  assert.match(page, /String\(selectedDevice\.bridge_service_state\)\.toUpperCase\(\) === "RUNNING"/);
  assert.match(page, /createDeviceCommand\("CONNECT_TINDER"\)/);
  assert.match(page, /createDeviceCommand\("DISCONNECT_TINDER"\)/);
  assert.doesNotMatch(page, /connectAndroidTinder\.addEventListener\([\s\S]{0,200}runControl\(/);
  assert.doesNotMatch(page, /disconnectAndroidTinder\.addEventListener\([\s\S]{0,200}runControl\(/);
});
