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

test("switching the explicitly selected device clears command feedback from the prior device", () => {
  assert.match(page, /button\.addEventListener\("click", \(\) => \{[\s\S]{0,700}if \(deviceId !== String\(selectedDevice\?\.device_id \|\| ""\)\) \{[\s\S]{0,180}commandFeedback = "";[\s\S]{0,120}commandFeedbackIsError = false;[\s\S]{0,300}selectedDevice = device;/);
});

test("Tinder page polls command status for a full heartbeat interval plus ACK buffer", () => {
  assert.match(page, /for \(let attempt = 0; attempt < 31; attempt \+= 1\)/);
  assert.match(page, /if \(terminal\) return;/);
});

test("terminal resume wording does not imply that a separately audited V2 permit is historical", () => {
  assert.match(page, /case "DISPATCHED":\s*return "Die zuletzt gelesene separate offizielle Startanfrage ist terminal/);
  assert.doesNotMatch(page, /case "DISPATCHED":\s*return "Die frühere offizielle Startanfrage/);
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

test("Tinder Inbox diagnostics surface the terminal discovery V16 enum only with its exact blocked pair", () => {
  assert.match(page, /const DISCOVERY_V16_STATES = new Set\(/);
  assert.match(page, /"BASE_STRUCTURE_REJECTED"/);
  assert.match(page, /"STRICT_CHAT_LABEL_INBOX_CANDIDATE"/);
  assert.match(page, /value\.stage === "BLOCKED"/);
  assert.match(page, /value\.reason === "DISCOVERY_STRUCTURE_REJECTED"/);
  assert.match(page, /DISCOVERY_V16_STATES\.has\(value\.discovery_v16_state\)/);
  assert.match(page, /DISCOVERY_V16_STATE:/);
  for (const forbidden of [
    "inbox_navigation.raw_accessibility_tree", "inbox_navigation.message_text",
    "inbox_navigation.visible_name", "inbox_navigation.node_id",
    "inbox_navigation.fingerprint", "inbox_navigation.exception_message"
  ]) assert.doesNotMatch(page, new RegExp(forbidden.replaceAll(".", "\\."), "i"));
});

test("Tinder Inbox diagnostics surface V16 selector counts only as a capped terminal pair", () => {
  assert.match(page, /discoveryV16SelectorCountFields/);
  assert.match(page, /discovery_v16_raw_selector_match_count/);
  assert.match(page, /discovery_v16_qualified_selector_match_count/);
  assert.match(page, /discoveryV16SelectorCounts/);
  assert.match(page, /value\.discovery_v16_raw_selector_match_count <= 2/);
  assert.match(page, /value\.discovery_v16_qualified_selector_match_count <= 2/);
  assert.match(page, /DISCOVERY_V16_RAW_SELECTOR_MATCH_COUNT:/);
  assert.match(page, /DISCOVERY_V16_QUALIFIED_SELECTOR_MATCH_COUNT:/);
  for (const forbidden of [
    "inbox_navigation.raw_accessibility_tree", "inbox_navigation.message_text",
    "inbox_navigation.visible_name", "inbox_navigation.node_id",
    "inbox_navigation.fingerprint", "inbox_navigation.exception_message",
    "inbox_navigation.selector_text", "inbox_navigation.selector_id"
  ]) assert.doesNotMatch(page, new RegExp(forbidden.replaceAll(".", "\\."), "i"));
});

test("Tinder Inbox diagnostics surface direct-static V2 only as the exact V16 terminal extension", () => {
  assert.match(page, /const DIRECT_STATIC_V2_STATES = new Set\(/);
  assert.match(page, /"DIRECT_ID_INCOMPLETE_OR_AMBIGUOUS"/);
  assert.match(page, /"STRICT_V2_CANDIDATE"/);
  assert.match(page, /discoveryV16DirectStaticV2Fields/);
  assert.match(page, /direct_static_v2_state/);
  assert.match(page, /discoveryV16DirectStaticV2/);
  assert.match(page, /DIRECT_STATIC_V2_STATES\.has\(value\.direct_static_v2_state\)/);
  assert.match(page, /DIRECT_STATIC_V2_STATE:/);
  for (const forbidden of [
    "inbox_navigation.raw_accessibility_tree", "inbox_navigation.message_text",
    "inbox_navigation.visible_name", "inbox_navigation.node_id",
    "inbox_navigation.fingerprint", "inbox_navigation.exception_message",
    "inbox_navigation.selector_text", "inbox_navigation.selector_id"
  ]) assert.doesNotMatch(page, new RegExp(forbidden.replaceAll(".", "\\."), "i"));
});

test("Tinder Inbox diagnostics surface V17 only as the exact V16 zero-count terminal extension", () => {
  assert.match(page, /const DISCOVERY_V17_CARRIER_RELATION_STATES = new Set\(/);
  assert.match(page, /"EXACT_CARRIER_FOUR_DIRECT_CHILDREN"/);
  assert.match(page, /"DIRECT_CHILD_CARDINALITY_OVER_FOUR"/);
  assert.match(page, /discoveryV17Fields/);
  assert.match(page, /discovery_v17_carrier_relation_state/);
  assert.match(page, /discoveryV17/);
  assert.match(page, /value\.discovery_v16_state === "LABEL_MATCH_COUNT_REJECTED"/);
  assert.match(page, /value\.discovery_v16_raw_selector_match_count === 0/);
  assert.match(page, /value\.discovery_v16_qualified_selector_match_count === 0/);
  assert.match(page, /DISCOVERY_V17_CARRIER_RELATION_STATES\.has\(/);
  assert.match(page, /DISCOVERY_V17_CARRIER_RELATION_STATE:/);
  for (const forbidden of [
    "inbox_navigation.raw_accessibility_tree", "inbox_navigation.message_text",
    "inbox_navigation.visible_name", "inbox_navigation.node_id",
    "inbox_navigation.fingerprint", "inbox_navigation.exception_message",
    "inbox_navigation.selector_text", "inbox_navigation.selector_id"
  ]) assert.doesNotMatch(page, new RegExp(forbidden.replaceAll(".", "\\."), "i"));
});

test("Tinder technical diagnostics render only the bounded read-only official resume handoff", () => {
  assert.match(page, /<summary>Technik &amp; Diagnose<\/summary>[\s\S]*id="officialResumeHandoffStatus"/);
  assert.match(page, /function officialResumeHandoffIsSafe\(value\)/);
  assert.match(page, /OFFICIAL_RESUME_HANDOFF_STAGES\.has\(value\.stage\)/);
  assert.match(page, /OFFICIAL_RESUME_HANDOFF_REASONS\.has\(value\.reason\)/);
  assert.match(page, /OFFICIAL_FOREGROUND_NOT_OBSERVED/);
  assert.match(page, /UNREVIEWED_OFFICIAL_SURFACE/);
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

test("Tinder technical diagnostics render only the aggregate official-resume schema evidence", () => {
  assert.match(page, /<summary>Technik &amp; Diagnose<\/summary>[\s\S]*id="officialResumeSchemaEvidenceStatus"/);
  assert.match(page, /function officialResumeSchemaEvidenceIsSafe\(value\)/);
  assert.match(page, /OFFICIAL_RESUME_SCHEMA_EVIDENCE_CLASS_FAMILIES/);
  assert.match(page, /OFFICIAL_RESUME_SCHEMA_EVIDENCE_ROLE_COUNTS/);
  assert.match(page, /handoff\.reason !== "UNREVIEWED_OFFICIAL_SURFACE"/);
  assert.match(page, /renderOfficialResumeSchemaEvidenceStatus\(device\);/);
  assert.match(page, /renderOfficialResumeSchemaEvidenceStatus\(null\);/);
  assert.match(page, /textContent =\s*`RESUME_SCHEMA_EVIDENCE:/);
  for (const forbidden of [
    "tinder_official_resume_schema_evidence.raw_accessibility_tree",
    "tinder_official_resume_schema_evidence.node_shapes",
    "tinder_official_resume_schema_evidence.class_name",
    "tinder_official_resume_schema_evidence.view_id_token",
    "tinder_official_resume_schema_evidence.fingerprint",
    "tinder_official_resume_schema_evidence.package_name"
  ]) assert.doesNotMatch(page, new RegExp(forbidden.replaceAll(".", "\\."), "i"));
});

test("Tinder technical diagnostics label accepted resume schema evidence as historical", () => {
  assert.match(page, /<summary>Technik &amp; Diagnose<\/summary>[\s\S]*id="lastAcceptedOfficialResumeSchemaDiagnosticStatus"/);
  assert.match(page, /function lastAcceptedOfficialResumeSchemaDiagnosticIsSafe\(value\)/);
  assert.match(page, /function renderLastAcceptedOfficialResumeSchemaDiagnosticStatus\(device\)/);
  assert.match(page, /renderLastAcceptedOfficialResumeSchemaDiagnosticStatus\(device\);/);
  assert.match(page, /renderLastAcceptedOfficialResumeSchemaDiagnosticStatus\(null\);/);
  assert.match(page, /LAST_ACCEPTED_RESUME_SCHEMA_DIAGNOSTIC:/);
  assert.match(page, /historical accepted evidence/i);
  for (const forbidden of [
    "last_accepted_official_resume_schema_diagnostic.raw_accessibility_tree",
    "last_accepted_official_resume_schema_diagnostic.node_shapes",
    "last_accepted_official_resume_schema_diagnostic.class_name",
    "last_accepted_official_resume_schema_diagnostic.view_id_token",
    "last_accepted_official_resume_schema_diagnostic.fingerprint",
    "last_accepted_official_resume_schema_diagnostic.package_name",
    "last_accepted_official_resume_schema_diagnostic.command_id",
    "last_accepted_official_resume_schema_diagnostic.permit_id",
    "last_accepted_official_resume_schema_diagnostic.source_capture_id",
    "last_accepted_official_resume_schema_diagnostic.binding_id",
    "last_accepted_official_resume_schema_diagnostic.capture_id",
    "last_accepted_official_resume_schema_diagnostic.visible_name",
    "last_accepted_official_resume_schema_diagnostic.message_text"
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

test("Tinder technical diagnostics render only the bounded V10 lifecycle sibling", () => {
  assert.match(page, /<summary>Technik &amp; Diagnose<\/summary>[\s\S]*id="resumedForegroundChatReturnDiagnostic"/);
  assert.match(page, /function resumedForegroundChatReturnDiagnosticIsSafe\(value\)/);
  assert.match(page, /RESUMED_FOREGROUND_CHAT_RETURN_DIAGNOSTIC_STAGES\.has\(value\.stage\)/);
  assert.match(page, /RESUMED_FOREGROUND_CHAT_RETURN_DIAGNOSTIC_REASONS\.has\(value\.reason\)/);
  assert.match(page, /"INITIAL_SHELL_REJECTED"/);
  assert.match(page, /renderResumedForegroundChatReturnDiagnostic\(device\);/);
  assert.match(page, /renderResumedForegroundChatReturnDiagnostic\(null\);/);
  assert.match(page, /textContent =\s*`V10_STAGE:/);
  for (const forbidden of [
    "tinder_resumed_foreground_chat_return_diagnostic.permit",
    "tinder_resumed_foreground_chat_return_diagnostic.command",
    "tinder_resumed_foreground_chat_return_diagnostic.identity",
    "tinder_resumed_foreground_chat_return_diagnostic.source",
    "tinder_resumed_foreground_chat_return_diagnostic.binding",
    "tinder_resumed_foreground_chat_return_diagnostic.capture",
    "tinder_resumed_foreground_chat_return_diagnostic.header",
    "tinder_resumed_foreground_chat_return_diagnostic.text"
  ]) assert.doesNotMatch(page, new RegExp(forbidden.replaceAll(".", "\\."), "i"));
});
