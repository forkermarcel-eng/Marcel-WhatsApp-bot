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

test("conversation binding mode is enabled only by the bounded eligible server status", () => {
  const mappingCode = sourceBetween("function captureIdFromLocation()", "async function createEnrollmentCode()");
  assert.match(mappingCode, /function conversationBindingEligible\(capture\)\s*\{\s*return conversationBindingStatus\(capture\) === "ELIGIBLE_FOR_HUMAN_BINDING";/s);
  assert.match(mappingCode, /status !== "" && status !== "LEGACY_CAPTURE" && !conversationBindingEligible\(capture\)/);
  assert.match(mappingCode, /elements\.captureTinderIdentifierField\.hidden = conversationBindingMode/);
  assert.match(mappingCode, /elements\.captureVisibleNameContext\.hidden = conversationBindingMode/);
  assert.match(mappingCode, /if \(conversationBindingBlocksMapping\(capture\)\) \{\s*elements\.captureMappingForm\.hidden = true;/s);
  assert.match(mappingCode, /captureMappingStatus\(data\.capture\) === "NEEDS_HUMAN_MAPPING" && !conversationBindingBlocksMapping\(data\.capture\)/);
});

test("conversation binding and the human-armed fallback send only deliberate bounded binding bodies", () => {
  const mappingCode = sourceBetween("function captureIdFromLocation()", "async function createEnrollmentCode()");
  const branchStart = mappingCode.indexOf("if (isConversationBinding || isHumanArmedBinding) {");
  const branchEnd = mappingCode.indexOf("     } else {", branchStart);
  assert.notEqual(branchStart, -1);
  assert.notEqual(branchEnd, -1);
  const bindingBranch = mappingCode.slice(branchStart, branchEnd);
  assert.match(bindingBranch, /body = \{ action: "BIND_EXISTING", contact_id: contactId, confirmed: true \}/);
  assert.match(bindingBranch, /body = \{ action: "BIND_CREATE", new_contact_name: newContactName, confirmed: true \}/);
  assert.match(bindingBranch, /!confirmed/);
  assert.doesNotMatch(bindingBranch, /tinder_identifier|visible_name|threadFingerprint|thread_fingerprint|captureFingerprint|capture_fingerprint|threadBindingEvidence|uniqueId/i);
  assert.match(mappingCode, /const isHumanArmedBinding = humanArmedBindingMode && humanArmedBindingAvailable\(mappingCapture\)/);
  assert.match(mappingCode, /operation=human-arm/);
  assert.match(mappingCode, /\["ARMED"\]/);
  assert.doesNotMatch(mappingCode, /human-arm[^\n]*(?:tinder_identifier|visible_name|threadFingerprint|thread_fingerprint|captureFingerprint|capture_fingerprint|uniqueId)/i);
});

test("legacy profile mapping remains separate from the fail-closed conversation binding path", () => {
  const mappingCode = sourceBetween("function captureIdFromLocation()", "async function createEnrollmentCode()");
  assert.match(mappingCode, /status !== "LEGACY_CAPTURE"/);
  assert.match(mappingCode, /body = \{ action, tinder_identifier: identifier, confirmed: true \}/);
  assert.doesNotMatch(page, /conversation_binding_status[^\n]*visible_name/);
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
  assert.match(discoveryCode, /Sicheres Capture · wartet auf eine bewusste menschliche Entscheidung/);
  assert.doesNotMatch(discoveryCode, /Capture \$\{capture\.capture_id\}|Gerät \$\{capture\.device_id\}|Kontakt #/);
  assert.doesNotMatch(discoveryCode, /visible_messages|thread_fingerprint|capture_fingerprint|provenance/);
  assert.doesNotMatch(discoveryCode, /newContactName\.value\s*=/);
});

test("open T4 draft discovery reuses the existing capture-detail review screen without exposing draft text", () => {
  const discoveryCode = sourceBetween("function openDraftReviewIsSafeForSelection", "function humanArmedBindingIsSafeForSelection");
  assert.match(page, /id="openDraftReviewPanel"/);
  assert.match(page, /id="openDraftReviewList"/);
  assert.match(discoveryCode, /function loadOpenDraftReviewDiscovery\(\)/);
  assert.match(discoveryCode, /requestJson\("\/api\/tinder\/captures\?view=open-draft-reviews"\)/);
  assert.match(discoveryCode, /\["DRAFT", "APPROVED", "STALE"\]\.includes\(review\.status\)/);
  assert.match(discoveryCode, /open\.href = pendingCaptureMappingUrl\(review\.capture_id\)/);
  assert.match(discoveryCode, /open\.textContent = "Entwurf pr/);
  assert.match(page, /void loadOpenDraftReviewDiscovery\(\)/);
  assert.doesNotMatch(discoveryCode, /original_draft|control_draft_de|threadFingerprint|thread_fingerprint|captureFingerprint|capture_fingerprint|contact_id|device_id|operation=draft|draft-approve|draft-reject|draft-cancel|SEND_TINDER_DRAFT|dispatch/i);
  assert.doesNotMatch(discoveryCode, /textContent\s*=\s*review\.capture_id/);
});

test("draft-ready capture discovery reuses the existing detail/review panel without creating a draft", () => {
  const discoveryCode = sourceBetween("function draftEligibleCaptureIsSafeForSelection", "function humanArmedBindingIsSafeForSelection");
  assert.match(page, /id="draftEligibleCapturePanel" hidden/);
  assert.match(page, /id="draftEligibleCaptureList"/);
  assert.match(discoveryCode, /function loadDraftEligibleCaptureDiscovery\(\)/);
  assert.match(discoveryCode, /requestJson\("\/api\/tinder\/captures\?view=draft-eligible"\)/);
  assert.match(discoveryCode, /open\.href = pendingCaptureMappingUrl\(capture\.capture_id\)/);
  assert.match(discoveryCode, /open\.textContent = "Entwurf öffnen"/);
  assert.match(discoveryCode, /Sicheres bestätigtes Capture · bereit für einen einzelnen Entwurf/);
  assert.match(page, /void loadDraftEligibleCaptureDiscovery\(\)/);
  assert.doesNotMatch(discoveryCode, /operation=draft|draft-approve|draft-reject|draft-cancel|original_draft|visible_messages|thread_fingerprint|capture_fingerprint|contact_id|device_id|dispatch|SEND_TINDER_DRAFT/i);
  assert.doesNotMatch(discoveryCode, /textContent\s*=\s*capture\.capture_id/);
});

test("a successful non-armed mapping refreshes the selected safe capture through the existing review component", () => {
  const mappingCode = sourceBetween("function captureIdFromLocation()", "async function createEnrollmentCode()");
  assert.match(mappingCode, /async function loadCaptureDetail\(captureId\)/);
  assert.match(mappingCode, /renderCaptureDraft\(data\.capture\);/);
  assert.match(mappingCode, /await loadCaptureDraftReview\(data\.capture\);/);
  assert.match(mappingCode, /await loadCaptureDetail\(captureId\);/);
  assert.match(mappingCode, /void loadOpenDraftReviewDiscovery\(\);/);
  assert.doesNotMatch(mappingCode, /await createCaptureDraft\(/);
});

test("human-armed fallback remains opt-in, never renders technical identifiers, and requires a separate rearm confirmation", () => {
  const mappingCode = sourceBetween("function captureIdFromLocation()", "async function createEnrollmentCode()");
  const humanListCode = sourceBetween("function humanArmedBindingIsSafeForSelection", "function captureMappingStatus");
  assert.match(page, /id="captureHumanArmedOption" hidden/);
  assert.match(page, /id="useHumanArmedBinding"/);
  assert.match(mappingCode, /function humanArmedBindingAvailable\(capture\).*LEGACY_CAPTURE/s);
  assert.match(mappingCode, /function enableHumanArmedBindingMode\(\)/);
  assert.match(mappingCode, /captureMappingConfirmed\.checked = false/);
  assert.match(mappingCode, /elements\.captureTinderIdentifierField\.hidden = true/);
  assert.match(mappingCode, /elements\.captureVisibleNameContext\.hidden = true/);
  assert.match(humanListCode, /checkbox\.checked !== true/);
  assert.match(humanListCode, /body: JSON\.stringify\(\{ confirmed: true \}\)/);
  assert.match(humanListCode, /operation=human-rearm/);
  assert.doesNotMatch(humanListCode, /textContent\s*=\s*binding\.binding_id|dataset\.[A-Za-z_]*binding|binding\.binding_id.*textContent/);
  assert.doesNotMatch(page, /id="captureMappingId"|id="captureDeviceId"|id="captureRevision"/);
  assert.doesNotMatch(mappingCode, /capture\.visible_name.*newContactName\.value|newContactName\.value.*capture\.visible_name/);
  assert.doesNotMatch(mappingCode, /threadFingerprint|thread_fingerprint|captureFingerprint|capture_fingerprint|uniqueId/);
});

test("T4 draft UI is opt-in for a resolved confirmed capture and never sends browser-owned context", () => {
  const draftCode = sourceBetween("function captureReviewStatus", "function mappingContactLabel");
  assert.match(page, /id="captureDraftPanel" hidden/);
  assert.match(page, /id="createCaptureDraft"/);
  assert.match(draftCode, /function captureIsDraftEligible\(capture\)\s*\{\s*return captureMappingStatus\(capture\) === "RESOLVED" && captureReviewStatus\(capture\) === "CONFIRMED";/s);
  assert.match(draftCode, /function createCaptureDraft\(\)/);
  assert.match(draftCode, /operation=draft/);
  assert.match(draftCode, /body: JSON\.stringify\(\{\}\)/);
  assert.match(page, /elements\.createCaptureDraft\.addEventListener\("click"/);
  assert.match(page, /renderCaptureDraft\(data\.capture\)/);
  assert.doesNotMatch(draftCode, /visible_name|threadFingerprint|thread_fingerprint|captureFingerprint|capture_fingerprint|humanBindingPermit|uniqueId/);
  assert.doesNotMatch(draftCode, /window\.location(?:\.href)?\s*=/);
});

test("T4 review shows one human-decision draft and hides the redundant German control copy", () => {
  const reviewCode = sourceBetween("function renderCaptureDraftReview(review)", "function renderCaptureDraft(capture)");
  assert.match(reviewCode, /const originalDraft = review\.original_draft\.trim\(\)/);
  assert.match(reviewCode, /const controlDraft = typeof review\.control_draft_de === "string"/);
  assert.match(reviewCode, /if \(controlDraft && controlDraft !== originalDraft\)/);
  assert.match(reviewCode, /elements\.captureDraftControl\.hidden = true/);
  assert.doesNotMatch(reviewCode, /Kontrollfassung DE: \$\{review\.control_draft_de\.trim\(\)\}/);
});

test("T5 draft review is durable, explicitly human-controlled, and has no browser dispatch or send path", () => {
  const draftCode = sourceBetween("function captureReviewStatus", "function mappingContactLabel");
  assert.match(page, /id="captureDraftReviewActions" hidden/);
  assert.match(page, /id="approveCaptureDraft"/);
  assert.match(page, /id="rejectCaptureDraft"/);
  assert.match(page, /id="cancelCaptureDraftApproval"/);
  assert.match(draftCode, /function loadCaptureDraftReview\(capture\)/);
  assert.match(draftCode, /view=draft-review/);
  assert.match(page, /await loadCaptureDraftReview\(data\.capture\)/);
  assert.match(draftCode, /function decideCaptureDraft\(operation\)/);
  assert.match(draftCode, /operation !== "draft-approve" && operation !== "draft-reject" && operation !== "draft-cancel"/);
  assert.match(draftCode, /body: JSON\.stringify\(\{\}\)/);
  assert.match(draftCode, /review\.status === "DRAFT" && review\.approval_state === null/);
  assert.match(draftCode, /review\.status === "APPROVED" && review\.approval_state === "ACTIVE"/);
  assert.match(draftCode, /\["APPROVED", "STALE"\]\.includes\(review\?\.status\)/);
  assert.match(draftCode, /durch eine neuere Identitätsbindung veraltet/);
  assert.match(page, /elements\.approveCaptureDraft\.addEventListener\("click"/);
  assert.match(page, /elements\.rejectCaptureDraft\.addEventListener\("click"/);
  assert.match(page, /elements\.cancelCaptureDraftApproval\.addEventListener\("click"/);
  assert.doesNotMatch(draftCode, /operation=dispatch|SEND_TINDER_DRAFT|device-bridge\/v1|playwright|chromium|accessibility/i);
  assert.doesNotMatch(draftCode, /textContent\s*=\s*review\.(?:draft_id|capture_id)|review\.(?:contact_id|device_id|thread_fingerprint|capture_fingerprint|approval_id|intent_id)/);
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
