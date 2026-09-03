import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import "../presentation.js";

const brain = readFileSync(new URL("../Brain/index.html", import.meta.url), "utf8");
const contacts = readFileSync(new URL("../Kontakte/index.html", import.meta.url), "utf8");
const tinder = readFileSync(new URL("../Tinder/index.html", import.meta.url), "utf8");
const backend = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const proxy = readFileSync(new URL("../api/dashboard/marcel-brain.js", import.meta.url), "utf8");
const P = globalThis.MarcelPresentation;

test("shared presentation maps known keys and humanizes unknown snake case", () => {
  assert.equal(P.label("primary_language"), "Sprache");
  assert.equal(P.label("seeking_new_job"), "Arbeit");
  assert.equal(P.label("some_new_memory_key"), "Some New Memory Key");
  assert.equal(P.status("confirmed"), "Menschlich bestätigt");
});

test("structured values become display rows instead of raw JSON", () => {
  assert.deepEqual(P.displayRows({ current_context: { seeking_new_job: true } }), [
    { label: "Aktueller Kontext · Arbeit", value: "Ja" }
  ]);
  assert.doesNotMatch(contacts, /JSON\.stringify\(x\.value/);
  assert.match(contacts, /P\.displayRows/);
  assert.match(brain, /P\.displayRows/);
});

test("contact detail has cards, human authority, timeline and edit action in header", () => {
  assert.match(contacts, /class="timeline"/);
  assert.match(contacts, /translationDe\|\|m\.translation_de/);
  assert.match(contacts, /Menschlich bestätigt|P\.status\(x\.reviewStatus\)/);
  assert.match(contacts, /detail-head[\s\S]*Dashboard\/\?view=edit-contact/);
  assert.match(contacts, /@media\(min-width:760px\) and \(max-width:1180px\)/);
});

test("Brain natural input is preview-only and supports per-candidate decisions", () => {
  assert.match(brain, /Was soll Marcel AI über dich wissen\?/);
  assert.match(brain, /marcel-brain\/classify/);
  assert.match(brain, /Marcel AI hat folgende Informationen erkannt/);
  assert.match(brain, /data-select=/);
  assert.match(brain, /data-label=/);
  assert.match(brain, /data-value=/);
  assert.match(brain, /candidate\.selected/);
  assert.match(brain, /Erweiterte Eingabe/);
  assert.match(backend, /previewOnly:\s*true/);
  assert.match(backend, /rawCandidates\.map\(validateBrainCandidate\)/);
  assert.match(backend, /kind === "live_state"/);
  assert.match(backend, /MARCEL_LIVE_STATE_FIELDS/);
  assert.match(backend, /MARCEL_MANUAL_FACT_CATEGORIES/);
  assert.match(proxy, /resource === "classify"/);
});

test("Tinder status is compact while diagnostics remain collapsed and runtime calls stay unchanged", () => {
  assert.match(tinder, /\.status-card\{position:relative;min-height:0/);
  assert.match(tinder, /<details class="technical">/);
  assert.match(tinder, /<summary>Technik &amp; Diagnose<\/summary>/);
  assert.match(tinder, /\.matches\{order:2/);
  assert.match(tinder, /\.technical\{order:4/);
  assert.match(tinder, /MarcelPresentation\.status\(deviceStatus\)/);
});
