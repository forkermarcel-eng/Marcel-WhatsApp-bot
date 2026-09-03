import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import "../presentation.js";
import { normalizeContactMediaItem, normalizePublicMediaRef } from "../services/contact-media.js";

const brain = readFileSync(new URL("../Brain/index.html", import.meta.url), "utf8");
const contacts = readFileSync(new URL("../Kontakte/index.html", import.meta.url), "utf8");
const tinder = readFileSync(new URL("../Tinder/index.html", import.meta.url), "utf8");
const backend = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const contactMedia = readFileSync(new URL("../services/contact-media.js", import.meta.url), "utf8");
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

test("presentation condenses preferences, boolean groups, seed labels and ISO dates", () => {
  assert.equal(P.label("seed_relationship"), "Beziehung");
  assert.doesNotMatch(P.label("seed_preferences"), /Seed/i);
  assert.match(P.summary({ likes_1: "gutes Essen", likes_2: "Reisen", likes_3: "Filme" }), /Mag gutes Essen, Reisen und Filme\./);
  assert.match(P.summary({ warm: true, loving: true, avoid_ai_phrasing: true }), /trifft zu/);
  assert.doesNotMatch(P.summary({ warm: true, loving: true }), /Ja|Nein/);
  assert.doesNotMatch(P.scalar("2026-08-25"), /2026-08-25/);
});

test("contact detail has cards, human authority, timeline and edit action in header", () => {
  assert.match(contacts, /class="timeline"/);
  assert.match(contacts, /translationDe\|\|m\.translation_de/);
  assert.match(contacts, /Menschlich bestätigt|P\.status\(x\.reviewStatus\)/);
  assert.match(contacts, /detail-head[\s\S]*Dashboard\/\?view=edit-contact/);
  assert.match(contacts, /@media\(min-width:760px\) and \(max-width:1180px\)/);
});

test("contacts start full width, sort A-Z and open a channel-neutral profile overlay", () => {
  assert.match(contacts, /\.workspace\{display:block!important\}/);
  assert.match(contacts, /localeCompare\(bn,"de",\{sensitivity:"base"\}\)/);
  assert.match(contacts, /classList\.add\("open"\)/);
  assert.match(contacts, /function closeProfile\(/);
  assert.doesNotMatch(contacts, /if\(contacts\[0\]\)select/);
  assert.match(contacts, /\/Dashboard\/\?contact=/);
  assert.match(contacts, /WhatsApp.*öffnen|P\.channel\(channel\).*öffnen/s);
  assert.match(contacts, /Dashboard\/\?view=edit-contact&contact=/);
  assert.match(contacts, /reference-layout/);
  assert.match(contacts, /Über sie/);
  assert.match(contacts, /Kanäle &amp; Profile/);
  assert.match(contacts, /gallery:"Galerie"/);
  assert.doesNotMatch(contacts, /short=\{whatsapp:"WA"/);
  for (const channel of ["whatsapp", "tinder", "instagram", "x"]) assert.match(contacts, new RegExp(`${channel}:'<path`));
  assert.match(contacts, /data-identity-edit/);
  assert.match(contacts, /resource=identities/);
});

test("woman profile reference view hides technical profile and audit data", () => {
  const summary = P.humanProfileSummary([
    { value: { age: 32, year_inferred: true, birthday: { day: 13, month: 3, year: 1994 } } },
    { value: { character: "Warm und humorvoll" } }
  ]);
  assert.equal(summary, "Warm und humorvoll.");
  assert.doesNotMatch(summary, /Age|Year|Inferred|trifft zu|1994/);
  assert.match(contacts, /Über sie/);
  assert.match(contacts, /Zwischen euch/);
  assert.match(contacts, /Flirt &amp; sexuelle Spannung/);
  assert.doesNotMatch(contacts, /<h3>Notizen<\/h3>/);
  assert.doesNotMatch(contacts, /x\.humanNote|notes\.map/);
});

test("flirt tension is conservative and based on reciprocal conversation signals", () => {
  assert.equal(P.tensionPresentation([], []).level, "Keine");
  assert.equal(P.tensionPresentation([{ direction: "incoming", text: "ein Kuss" }], []).level, "Leicht");
  assert.equal(P.tensionPresentation([
    { direction: "incoming", text: "ein Kuss" },
    { direction: "outgoing", text: "flirtige Antwort" }
  ], []).level, "Spürbar");
  assert.equal(P.tensionPresentation([
    { direction: "incoming", text: "Kuss" },
    { direction: "outgoing", text: "Flirt" },
    { direction: "incoming", text: "Nähe" },
    { direction: "outgoing", text: "Anziehung" }
  ], []).level, "Stark");
});

test("woman profile uses three responsive areas and a separate selected topic detail", () => {
  const css = readFileSync(new URL("../Kontakte/contact-profile.css", import.meta.url), "utf8");
  assert.match(contacts, /brainTopicList\(groups\)/);
  assert.match(contacts, /brainTopicDetail\(groups\)/);
  assert.match(contacts, /data-topic=/);
  assert.match(contacts, /class="topic-detail"/);
  assert.match(contacts, /Zusammenfassung/);
  assert.match(contacts, /Details anzeigen/);
  assert.match(css, /grid-template-columns:\s*minmax\(250px,[\s\S]*minmax\(300px,[\s\S]*minmax\(320px/);
  assert.match(css, /@media \(max-width: 980px\)/);
  assert.match(css, /@media \(max-width: 820px\)/);
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

test("Brain facts use compact topic accordions without losing granular details", () => {
  assert.equal(P.topic("sexuality", "intimacy_style"), "Intimität");
  assert.equal(P.topic("relationship_values", "physical_affection"), "Intimität");
  assert.equal(P.topic("relationship_history", "former_partner"), "Beziehungen & Liebe");
  assert.match(brain, /class="brain-stats"/);
  assert.match(brain, /class="topic"/);
  assert.match(brain, /aktive API-Fakten/);
  assert.match(brain, /Details anzeigen/);
  assert.match(contacts, /class="brain-topic-row/);
  assert.match(contacts, /P\.topic\(item\.category,item\.key\)/);
  assert.match(contacts, /topicIcon\(topic\)/);
  assert.match(contacts, /topic-copy[\s\S]*humanProfileSummary\(group/);
});

test("contact preview and media foundation preserve source data", () => {
  assert.match(contacts, /class="small message-preview"/);
  assert.match(readFileSync(new URL("../platform.css", import.meta.url), "utf8"), /-webkit-line-clamp:2/);
  assert.match(contacts, /gallery:"Galerie"/);
  assert.match(contacts, /Noch keine Medien für diesen Kontakt/);
  assert.match(contacts, /\["photo","video","sticker"\]/);
  assert.match(contacts, /data-media-filter/);
  assert.match(contacts, /data-activity-media/);
  assert.match(contactMedia, /FROM media[\s\S]*WHERE contact_id = \$1/);
  assert.match(contactMedia, /function normalizeContactMediaItem/);
  assert.match(contactMedia, /function normalizePublicMediaRef/);
  assert.match(contactMedia, /fingerprint: null/);
  assert.match(backend, /listContactMedia\(contact\.id\)/);
  assert.match(backend, /mediaItems:\s*mediaRows/);
  assert.doesNotMatch(backend, /rawType|stickerCatalog|publicMediaRef/);
  assert.doesNotMatch(contacts, /last\(c\)\.slice/);
  assert.equal(normalizePublicMediaRef("C:\\private\\photo.jpg"), null);
  assert.equal(normalizePublicMediaRef("/media/photo.jpg"), "/media/photo.jpg");
  const sticker = normalizeContactMediaItem({ id: 7, contact_id: 4, media_type: "sticker", storage_path: "/media/s.webp" });
  assert.equal(sticker.type, "sticker");
  assert.equal(sticker.contactId, 4);
  assert.equal(sticker.fileRef, "/media/s.webp");
  assert.equal(sticker.metadata.stickerCatalog.favorite, null);
});

test("Tinder status is compact while diagnostics remain collapsed and runtime calls stay unchanged", () => {
  assert.match(tinder, /\.status-grid\{order:1;display:flex;flex-wrap:nowrap/);
  assert.match(tinder, /\.status-card\{position:relative;min-height:0/);
  assert.match(tinder, /<details class="technical">/);
  assert.match(tinder, /<summary>Technik &amp; Diagnose<\/summary>/);
  assert.match(tinder, /\.matches\{order:2/);
  assert.match(tinder, /\.technical\{order:4/);
  assert.match(tinder, /MarcelPresentation\.status\(deviceStatus\)/);
  assert.doesNotMatch(tinder, /<div class="logo">MARCEL/);
});
