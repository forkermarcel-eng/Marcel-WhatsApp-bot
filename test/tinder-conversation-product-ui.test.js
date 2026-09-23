import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../Tinder/index.html", import.meta.url), "utf8");

test("Tinder shell keeps the normal Status, Matches, Conversations, Chat, and Profile layout", () => {
  for (const label of ["Gerät", "Bridge", "Read-Kanal", "Matches", "Conversations", "Chat", "Profil"]) {
    assert.match(page, new RegExp(label));
  }
  assert.match(page, /href="\/Dashboard\/">WhatsApp<\/a>/);
  assert.match(page, /href="\/Brain\/">Brain<\/a>/);
  assert.match(page, /Noch keine Conversations verfügbar\./);
  assert.match(page, /Noch keine Match-Daten im neuen Produktmodell\./);
});

test("reset dashboard has no active Tinder data, control, mapping, or prototype UI call", () => {
  assert.doesNotMatch(page, /\/api\/tinder\/captures/);
  assert.doesNotMatch(page, /read-conversations|read-conversation|captureMapping|humanArmed|draft|attestation|sweep|receipt|permit/i);
  assert.doesNotMatch(page, /CONNECT_TINDER|DISCONNECT_TINDER|REQUEST_STATUS|\bPING\b/);
  assert.doesNotMatch(page, /resume-official|visible-chat-sync|pending-read/i);
  assert.doesNotMatch(page, /tinder_state/i);
});

test("generic enrollment and read-only device status remain available", () => {
  assert.match(page, /\/api\/tinder\/enrollment-code/);
  assert.match(page, /\/api\/tinder\/device-status/);
  assert.match(page, /function renderDeviceSelection\(\)/);
  assert.match(page, /function renderDeviceStatus\(\)/);
  assert.match(page, /function shortDeviceId\(value\)/);
});
