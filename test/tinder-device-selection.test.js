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

test("Tinder technical diagnostics render only a bounded selected-device inbox navigation heartbeat projection", () => {
  assert.match(page, /<summary>Technik &amp; Diagnose<\/summary>[\s\S]*id="inboxNavigationStatus"/);
  assert.match(page, /function inboxNavigationIsSafe\(value\)/);
  assert.match(page, /INBOX_NAVIGATION_STAGES\.has\(value\.stage\)/);
  assert.match(page, /INBOX_NAVIGATION_REASONS\.has\(value\.reason\)/);
  assert.match(page, /String\(device\?\.device_status \|\| ""\)\.toUpperCase\(\) === "ONLINE"/);
  assert.match(page, /renderInboxNavigationStatus\(device\);/);
  assert.match(page, /renderInboxNavigationStatus\(null\);/);
  assert.doesNotMatch(page, /inbox_navigation\.raw/i);
  assert.doesNotMatch(page, /inbox_navigation\.last_observation/i);
});

test("Tinder technical diagnostics render only the bounded read-only official resume handoff", () => {
  assert.match(page, /<summary>Technik &amp; Diagnose<\/summary>[\s\S]*id="officialResumeHandoffStatus"/);
  assert.match(page, /function officialResumeHandoffIsSafe\(value\)/);
  assert.match(page, /OFFICIAL_RESUME_HANDOFF_STAGES\.has\(value\.stage\)/);
  assert.match(page, /OFFICIAL_RESUME_HANDOFF_REASONS\.has\(value\.reason\)/);
  assert.match(page, /String\(device\?\.device_status \|\| ""\)\.toUpperCase\(\) === "ONLINE"/);
  assert.match(page, /renderOfficialResumeHandoffStatus\(device\);/);
  assert.match(page, /renderOfficialResumeHandoffStatus\(null\);/);
  assert.match(page, /textContent =\s*`RESUME_HANDOFF_STAGE:/);
  for (const forbidden of [
    "official_resume_handoff.raw", "official_resume_handoff.command", "official_resume_handoff.permit",
    "official_resume_handoff.capture", "official_resume_handoff.binding", "official_resume_handoff.text",
    "official_resume_handoff.tree", "official_resume_handoff.payload"
  ]) assert.doesNotMatch(page, new RegExp(forbidden.replaceAll(".", "\\."), "i"));
});

test("Tinder technical diagnostics render only the content-free V10 return readiness", () => {
  assert.match(page, /<summary>Technik &amp; Diagnose<\/summary>[\s\S]*id="resumedForegroundChatReturnStatus"/);
  assert.match(page, /function resumedForegroundChatReturnIsSafe\(value\)/);
  assert.match(page, /Object\.keys\(value\)\.sort\(\)\.join\("\|"\) === "ready"/);
  assert.match(page, /renderResumedForegroundChatReturnStatus\(device\);/);
  assert.match(page, /renderResumedForegroundChatReturnStatus\(null\);/);
  assert.match(page, /textContent =\s*`V10_CHAT_RETURN_READY:/);
  for (const forbidden of [
    "tinder_resumed_foreground_chat_return.permit", "tinder_resumed_foreground_chat_return.command",
    "tinder_resumed_foreground_chat_return.identity", "tinder_resumed_foreground_chat_return.source",
    "tinder_resumed_foreground_chat_return.binding", "tinder_resumed_foreground_chat_return.capture",
    "tinder_resumed_foreground_chat_return.header", "tinder_resumed_foreground_chat_return.text"
  ]) assert.doesNotMatch(page, new RegExp(forbidden.replaceAll(".", "\\."), "i"));
});
