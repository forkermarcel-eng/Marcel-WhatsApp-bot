import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync(new URL("../Tinder/index.html", import.meta.url), "utf8");
const backend = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const contactsPage = readFileSync(new URL("../Kontakte/index.html", import.meta.url), "utf8");

function sourceBetween(start, end) {
  const startIndex = page.indexOf(start);
  const endIndex = page.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing ${start}`);
  assert.notEqual(endIndex, -1, `missing ${end}`);
  return page.slice(startIndex, endIndex);
}

test("Tinder inline behavior remains syntactically valid", () => {
  const scripts = [...page.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length > 0);
  assert.doesNotThrow(() => new Function(scripts.at(-1)[1]));
});

test("Tinder base page discovers pending captures, but maps only after an explicit capture selection", () => {
  assert.match(page, /id="pendingCapturePanel"/);
  assert.match(page, /function loadPendingCaptureDiscovery\(\)/);
  assert.match(page, /requestJson\("\/api\/tinder\/captures\?view=pending"\)/);
  assert.match(page, /function pendingCaptureMappingUrl\(captureId\)/);
  assert.match(page, /open\.href = pendingCaptureMappingUrl\(capture\.capture_id\)/);
  assert.doesNotMatch(page, /window\.location(?:\.href)?\s*=/);
  assert.match(page, /id="captureMappingPanel" hidden/);
  assert.match(page, /function captureIdFromLocation\(\)/);
  assert.match(page, /new URLSearchParams\(window\.location\.search\)\.get\("captureId"\)/);
  assert.match(page, /\["NEEDS_HUMAN_MAPPING", "CONFLICT"\]\.includes\(status\)/);
  assert.match(page, /const hasCapture = captureMappingStatus\(mappingCapture\) === "NEEDS_HUMAN_MAPPING"/);
  assert.match(page, /Konflikt blockiert/);
  assert.match(page, /void loadPendingCaptureDiscovery\(\)/);
  assert.match(page, /void loadCaptureMappingFromLocation\(\)/);
  assert.match(page, /\/api\/tinder\/captures\?captureId=\$\{encodeURIComponent\(captureId\)\}/);
});

test("mapping UI requires a deliberate confirmation and never infers a contact from name, fingerprint, or newest device", () => {
  const mappingCode = sourceBetween("function captureIdFromLocation()", "async function createEnrollmentCode()");
  assert.match(mappingCode, /captureMappingConfirmed\.checked === true/);
  assert.match(mappingCode, /if \(action === "MAP_EXISTING"\)/);
  assert.match(page, /submitCaptureMapping\("MAP_EXISTING"\)/);
  assert.match(page, /submitCaptureMapping\("CREATE_NEW"\)/);
  assert.match(mappingCode, /tinder_identifier/);
  assert.match(mappingCode, /new_contact_name/);
  assert.doesNotMatch(mappingCode, /newestEnrollmentId/);
  assert.doesNotMatch(mappingCode, /threadFingerprint|thread_fingerprint/);
  assert.doesNotMatch(mappingCode, /runControl\(/);
  assert.doesNotMatch(mappingCode, /capture\.visible_name.*newContactName\.value|newContactName\.value.*capture\.visible_name/);
});

test("mapping UI reuses the authenticated contacts API and surfaces conflicts without an overwrite", () => {
  const mappingCode = sourceBetween("function captureIdFromLocation()", "async function createEnrollmentCode()");
  assert.match(mappingCode, /requestJson\("\/api\/dashboard\/contacts"\)/);
  assert.match(mappingCode, /error\?\.data\?\.result\?\.status === "CONFLICT"/);
  assert.match(mappingCode, /keine automatische Zusammenführung/);
  assert.doesNotMatch(mappingCode, /\/api\/dashboard\/contacts\?id=.*resource=identities/);
});

test("capture mapping refreshes only Android Device Bridge status, never the frozen legacy worker", () => {
  assert.match(page, /async function refreshAllStatuses\(\)\s*\{\s*elements\.refreshStatus\.disabled = true;\s*await loadDeviceStatus\(\);/s);
  assert.doesNotMatch(page, /loadStatus\(/);
  assert.doesNotMatch(page, /\/api\/tinder\/status/);
});

test("pending capture discovery displays only bounded mapping context and keeps empty state deliberate", () => {
  const discoveryCode = sourceBetween("function pendingCaptureIsSafeForSelection", "function captureMappingStatus");
  assert.match(discoveryCode, /mapping_status === "NEEDS_HUMAN_MAPPING"/);
  assert.match(discoveryCode, /human_review_status === "PENDING"/);
  assert.match(discoveryCode, /Keine sicheren Captures warten derzeit auf eine menschliche Zuordnung/);
  assert.match(discoveryCode, /Capture \$\{capture\.capture_id\}/);
  assert.doesNotMatch(discoveryCode, /visible_messages|thread_fingerprint|capture_fingerprint|provenance/);
  assert.doesNotMatch(discoveryCode, /newContactName\.value\s*=/);
});

test("channel-native T3 contacts remain visible in the existing contacts list while persona tests stay hidden", () => {
  assert.match(backend, /WHERE \(\s*c\.whatsapp_jid IS NULL\s*OR c\.whatsapp_jid NOT LIKE '%@persona\.test'\s*\)/);
  assert.match(backend, /FROM messages m\s+\s*WHERE m\.whatsapp_jid =\s+c\.whatsapp_jid/s);
});

test("existing contacts UI keeps Tinder identity display read-only outside the audited mapping flow", () => {
  assert.match(contactsPage, /editable=\["instagram","x"\]/);
  assert.match(contactsPage, /\["whatsapp","tinder",\.\.\.editable\]/);
  assert.doesNotMatch(contactsPage, /editable=\["tinder","instagram","x"\]/);
});

test("index.js keeps T3 as modular route orchestration", () => {
  assert.match(backend, /import \{ registerTinderCaptureRoutes \} from "\.\/device-bridge\/tinder-capture-routes\.js"/);
  assert.match(backend, /registerTinderCaptureRoutes\(\{\s*app,\s*pool,/s);
  assert.doesNotMatch(backend, /INSERT\s+INTO\s+tinder_visible_chat_captures/i);
  assert.doesNotMatch(backend, /INSERT\s+INTO\s+tinder_identity_mapping_audit/i);
});
