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
