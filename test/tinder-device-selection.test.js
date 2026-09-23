import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../Tinder/index.html", import.meta.url), "utf8");

test("Tinder dashboard keeps an explicit safe device-status selection", () => {
  assert.match(page, /id="deviceSelectionList"/);
  assert.match(page, /function renderDeviceSelection\(\)/);
  assert.match(page, /selectedDevice = device;/);
  assert.match(page, /function shortDeviceId\(value\)/);
  assert.doesNotMatch(page, /device\.key_id|device\.public_key/);
});

test("selected device has no Tinder command or data operation", () => {
  assert.match(page, /renderDeviceStatus\(\);/);
  assert.doesNotMatch(page, /loadConversations|selectConversation|createDeviceCommand|pollCommandStatus/);
  assert.doesNotMatch(page, /CONNECT_TINDER|DISCONNECT_TINDER/);
});
