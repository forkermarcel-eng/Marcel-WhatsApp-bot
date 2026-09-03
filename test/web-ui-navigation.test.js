import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const routes = ["Hub", "Dashboard", "Tinder", "Instagram", "X", "Brain", "Trading", "Kontakte", "Analyse", "Einstellungen"];
const pages = Object.fromEntries(routes.map(route => [route, readFileSync(new URL(`../${route}/index.html`, import.meta.url), "utf8")]));

test("every Marcel AI page exposes the complete navigation in the required order", () => {
  const hrefs = routes.map(route => `href="/${route}/"`);
  for (const [page, html] of Object.entries(pages)) {
    let previous = -1;
    for (const href of hrefs) {
      const position = html.indexOf(href);
      assert.ok(position > previous, `${page}: ${href} missing or out of order`);
      previous = position;
    }
  }
});

test("all inline page scripts parse as JavaScript", () => {
  for (const [page, html] of Object.entries(pages)) {
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
      assert.doesNotThrow(() => new Function(match[1]), `${page}: invalid inline script`);
    }
  }
});

test("central contacts uses real API data, channel filters and existing edit flows", () => {
  const html = pages.Kontakte;
  assert.match(html, /api\/dashboard\/contacts/);
  for (const filter of ["all", "whatsapp", "tinder", "instagram", "x"]) assert.match(html, new RegExp(`data-filter="${filter}"`));
  assert.match(html, /c\.jid\|\|c\.whatsappJid/);
  assert.match(html, /sourcePlatform,c\.currentPlatform/);
  assert.match(html, /\/Dashboard\/\?view=add-contact/);
  assert.match(html, /\/Dashboard\/\?view=edit-contact&contact=/);
});

test("Dashboard keeps its contact and WhatsApp behavior while linking central contacts", () => {
  const html = pages.Dashboard;
  assert.match(html, /view==="add-contact"/);
  assert.match(html, /view==="edit-contact"/);
  assert.match(html, /contactAddSmall\{[^}]*background:#1e7d3a/);
  assert.match(html, /href="\/Kontakte\/"/);
  assert.doesNotMatch(html, /view=contacts/);
});

test("new social dashboards are honest empty states without automation", () => {
  assert.match(pages.Instagram, /nicht verbunden/i);
  assert.match(pages.X, /nicht verbunden/i);
  assert.match(pages.Instagram, />0</);
  assert.match(pages.X, />0</);
  assert.doesNotMatch(pages.Instagram + pages.X, /fetch\s*\(/);
});

test("middleware protects every newly introduced route", () => {
  const middleware = readFileSync(new URL("../middleware.js", import.meta.url), "utf8");
  for (const route of ["Instagram", "X", "Kontakte"]) assert.match(middleware, new RegExp(`/${route}/:path\\*`));
});
