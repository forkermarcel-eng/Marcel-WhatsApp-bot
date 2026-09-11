import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../Tinder/index.html", import.meta.url), "utf8");

function sourceBetween(start, end) {
  const startIndex = page.indexOf(start);
  const endIndex = page.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return page.slice(startIndex, endIndex);
}

test("Tinder confirmed conversation UI is a separate bounded selected-detail surface", () => {
  const conversationCode = sourceBetween("function hasExactConversationFields", "function formatTimestamp");

  assert.match(page, /id="confirmedConversationList"/);
  assert.match(page, /id="confirmedConversationDetail"/);
  assert.match(page, /Bestätigte Conversations/);
  assert.match(page, /Nachrichtenansicht/);
  assert.match(conversationCode, /function loadLatestConfirmedConversationList\(\)/);
  assert.match(conversationCode, /requestJson\("\/api\/tinder\/captures\?view=confirmed-conversations"\)/);
  assert.match(conversationCode, /requestJson\(`\/api\/tinder\/captures\?captureId=\$\{encodeURIComponent\(captureId\)\}&view=confirmed-conversation`\)/);
  assert.match(page, /void loadLatestConfirmedConversationList\(\)/);
  assert.match(conversationCode, /conversations\.length > 25/);
  assert.match(conversationCode, /conversation\.messages\.length > 100/);
  assert.match(conversationCode, /message\.text\.trim\(\)/);
  assert.match(conversationCode, /conversationDirectionLabel/);
});

test("conversation messages render only visible name/time and direction/text, never technical fields, drafts, or sends", () => {
  const conversationCode = sourceBetween("function hasExactConversationFields", "function formatTimestamp");

  assert.match(conversationCode, /name\.textContent = conversation\.visible_name\.trim\(\)/);
  assert.match(conversationCode, /capturedAt\.textContent = `Erfasst am \$\{formatConversationCapturedAt\(conversation\.captured_at\)\}`/);
  assert.match(conversationCode, /text\.textContent = message\.text\.trim\(\)/);
  assert.doesNotMatch(conversationCode, /textContent\s*=\s*conversation\.capture_id/);
  assert.doesNotMatch(conversationCode, /dataset\./);
  assert.doesNotMatch(conversationCode, /device_id|thread_fingerprint|capture_fingerprint|resolved_contact_id|visible_order|provenance/i);
  assert.doesNotMatch(conversationCode, /draft|SEND_TINDER_DRAFT|fetch\("\/api\/tinder\/(?:read|status|control)/i);
  // The bounded launcher observation may name the terminal enum DISPATCHED;
  // it must not introduce a separate dispatch path into this read surface.
  assert.deepEqual(conversationCode.match(/\bdispatch\w*/gi), ["DISPATCHED"]);
  assert.doesNotMatch(conversationCode, /window\.location(?:\.href)?\s*=/);
});

test("selected detail has bounded one-shot official-app resume and visible-chat sync actions, without a navigation surface", () => {
  const conversationCode = sourceBetween("function hasExactConversationFields", "function formatTimestamp");

  assert.match(conversationCode, /operation=resume-official-app/);
  assert.match(conversationCode, /RESUME_OFFICIAL_TINDER_APP/);
  assert.match(conversationCode, /Offizielle Tinder-App einmal öffnen/);
  assert.match(conversationCode, /Standard-Launcher-Activity/);
  assert.match(conversationCode, /operation=visible-chat-sync/);
  assert.match(conversationCode, /body: JSON\.stringify\(\{\}\)/);
  assert.match(conversationCode, /Sichtbaren geöffneten Chat synchronisieren/);
  assert.match(conversationCode, /Der Vorgang öffnet keinen Chat, ordnet keine Person zu und versendet nichts/);
  assert.match(conversationCode, /visible_chat_sync/);
  assert.match(conversationCode, /official_app_resume/);
  assert.match(conversationCode, /OFFICIAL_APP_RESUME_OBSERVATION_STATUSES/);
  assert.match(page, /OFFICIAL_APP_RESUME_REQUESTABLE_STATUSES/);
  assert.match(
    conversationCode,
    /officialAppResumeIsSafe\(conversation\.official_app_resume\)\s*&& OFFICIAL_APP_RESUME_REQUESTABLE_STATUSES\.has\(conversation\.official_app_resume\.status\)/
  );
  assert.match(conversationCode, /OFFICIAL_APP_RESUME_REQUESTABLE_STATUSES\.has\(resume\.status\)/);
  assert.match(page, /OFFICIAL_APP_RESUME_REQUESTABLE_STATUSES\s*=\s*new Set\(\[\s*"NOT_REQUESTED", "DISPATCHED", "CANCELLED", "EXPIRED"\s*\]\)/);
  assert.match(conversationCode, /officialAppResumeAttemptedCaptureId === captureId/);
  assert.match(conversationCode, /officialAppResumeAttemptedCaptureId === conversation\.capture_id/);
  assert.match(conversationCode, /Synchronisierter sichtbarer Verlauf/);
  assert.doesNotMatch(conversationCode, /thread_fingerprint|capture_fingerprint|source_capture_id|command_id|permit/i);
  assert.doesNotMatch(conversationCode, /startActivity|ComponentName|setPackage|setData|ACTION_VIEW|performAction|GLOBAL_ACTION|ACTION_CLICK|setText|openChat/i);
});

test("queued visible-chat sync refreshes only the selected product detail and never queues a retry", () => {
  const conversationCode = sourceBetween("function hasExactConversationFields", "function formatTimestamp");

  assert.match(conversationCode, /function scheduleVisibleChatSyncDetailRefresh\(captureId\)/);
  assert.match(conversationCode, /await selectConfirmedConversation\(captureId\)/);
  assert.match(conversationCode, /if \(conversation\.visible_chat_sync\)/);
  assert.match(conversationCode, /refreshVisibleChatSyncDetail\(captureId, generation, attempt \+ 1\)/);
  assert.equal((conversationCode.match(/operation=visible-chat-sync/g) || []).length, 1);
  assert.equal((conversationCode.match(/operation=resume-official-app/g) || []).length, 1);
});

test("selected Conversation detail cannot bypass the confirmed-binding local-attestation flow", () => {
  const detailCode = sourceBetween("function renderConfirmedConversationDetail", "async function selectConfirmedConversation");

  assert.match(detailCode, /syncButton\.hidden = true/);
  assert.match(detailCode, /syncButton\.disabled = true/);
  assert.match(detailCode, /bestehenden Binding-Karte/);
  assert.doesNotMatch(detailCode, /requestVisibleChatSync\(/);
  assert.doesNotMatch(detailCode, /operation=visible-chat-sync/);
});

test("a terminal official-app resume status clears only the local latch for a later separate permit", () => {
  const conversationCode = sourceBetween("function hasExactConversationFields", "function formatTimestamp");

  assert.match(conversationCode, /function scheduleOfficialAppResumeDetailRefresh\(captureId\)/);
  assert.match(conversationCode, /await selectConfirmedConversation\(captureId\)/);
  assert.match(conversationCode, /status === "PENDING"/);
  assert.match(conversationCode, /OFFICIAL_APP_RESUME_TERMINAL_STATUSES\.has\(status\)/);
  assert.match(conversationCode, /officialAppResumeQueuedCaptureId = null/);
  assert.match(conversationCode, /officialAppResumeAttemptedCaptureId = null/);
  assert.match(conversationCode, /scheduleOfficialAppResumeDetailRefresh\(captureId\)/);
  assert.equal((conversationCode.match(/operation=resume-official-app/g) || []).length, 1);
});

test("conversation selection remains local and does not enter the existing capture mapping URL flow", () => {
  const conversationCode = sourceBetween("function hasExactConversationFields", "function formatTimestamp");
  assert.match(page, /let selectedConversationCaptureId = null/);
  assert.match(conversationCode, /selectedConversationCaptureId = captureId/);
  assert.doesNotMatch(conversationCode, /pendingCaptureMappingUrl|captureIdFromLocation|new URLSearchParams\(window\.location/);
});
